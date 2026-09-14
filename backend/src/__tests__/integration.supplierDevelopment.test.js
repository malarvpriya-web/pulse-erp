/**
 * integration.supplierDevelopment.test.js
 *
 * The last arrow in the supplier loop: Rating → Corrective Action → Supplier
 * Development → next Selection.
 *
 * Supplier development existed only as a LABEL in sourcingStrategyEngine's
 * strategy list — a string the advisory panel rendered, with no plan, no owner,
 * no target and no way to say afterwards whether the supplier got better. These
 * tests hold the three decisions that shaped the feature:
 *
 *   1. a plan has a named owner,
 *   2. nothing auto-creates one — the engine recommends and a person opens,
 *   3. an open plan does NOT suppress the rating it answers.
 *
 * ⚠ Real database, own tenant, swept in both hooks — see
 * integration.supplierLoopClosure.test.js for why both.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }   = await import('../config/db.js');
const { default: svc }    = await import('../modules/procurement/services/supplierDevelopment.service.js');
const { default: engine } = await import('../modules/procurement/engines/supplierDevelopmentEngine.js');
const { default: health } = await import('../modules/procurement/services/vendorHealth.service.js');
const { default: devRoutes }  = await import('../modules/procurement/routes/supplierDevelopment.routes.js');
const { verifyToken }         = await import('../middlewares/auth.middleware.js');
const express = (await import('express')).default;
const request = (await import('supertest')).default;
const jwt     = (await import('jsonwebtoken')).default;

const TAG = 'SDEVTEST';
// Own tenant. 999900-999908, 999911-999913 are taken — grep 9999\d\d before reusing.
const CO = 999914;

let vendorId, employeeId;

async function sweep() {
  const like = `${TAG}%`;
  await pool.query(
    `DELETE FROM supplier_development_actions WHERE plan_id IN
       (SELECT id FROM supplier_development_plans WHERE company_id = $1)`, [CO]);
  await pool.query(`DELETE FROM supplier_development_plans WHERE company_id = $1`, [CO]);
  await pool.query(`DELETE FROM vendor_health_scores   WHERE company_id = $1`, [CO]);
  await pool.query(`DELETE FROM vendor_health_timeline WHERE company_id = $1`, [CO]).catch(() => {});
  await pool.query(`DELETE FROM vendor_early_warnings  WHERE company_id = $1`, [CO]).catch(() => {});
  await pool.query(`DELETE FROM vendors WHERE vendor_name LIKE $1`, [like]);
  await pool.query(`DELETE FROM interview_questions WHERE company_id = $1`, [CO]).catch(() => {});
  await pool.query(`DELETE FROM companies WHERE id = $1`, [CO]).catch(() => {});
}

beforeAll(async () => {
  await sweep();
  await pool.query(
    `INSERT INTO companies (id, name, code) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [CO, `${TAG} development tenant`, TAG]);
  const { rows: [v] } = await pool.query(
    `INSERT INTO vendors (vendor_name, company_id, lead_time_days, status)
     VALUES ($1, $2, 14, 'active') RETURNING id`, [`${TAG} Supplier`, CO]);
  vendorId = v.id;
  const { rows: [e] } = await pool.query(
    `SELECT id FROM employees WHERE deleted_at IS NULL ORDER BY id LIMIT 1`);
  employeeId = e?.id ?? null;
  await health.computeAndSave(vendorId, CO);
});

afterAll(sweep);

/**
 * The router, driven over HTTP the way server.js mounts it.
 *
 * ⚠ A service that works and a router nobody can reach are the same thing to a
 * user. This codebase has shipped that exact shape before — a full page and four
 * live endpoints with no consumer at all (project_feature_exists_but_mounted_nowhere,
 * project_supplier_performance_index). These assertions drive the real
 * `verifyToken` and the real `requireProcurement` gate, so a 403 here is
 * evidence about the deployment rather than about the fixture.
 */
const app = (() => {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/supplier-development', verifyToken, devRoutes);
  return a;
})();

async function tokenFor(roleCode) {
  const { rows: [u] } = await pool.query(
    `SELECT u.id, u.email, u.employee_id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE r.code = $1 AND u.is_active = true LIMIT 1`, [roleCode]);
  if (!u) return null;
  return jwt.sign(
    { userId: u.id, email: u.email, employee_id: u.employee_id, company_id: CO, role: roleCode },
    process.env.JWT_SECRET, { expiresIn: '10m' });
}

describe('The router is actually reachable, and gated', () => {
  it('serves the method vocabulary to a buyer', async () => {
    const t = await tokenFor('procurement_manager');
    if (!t) return; // no such account in this database; the gate test below still runs
    const res = await request(app).get('/api/v1/supplier-development/methods')
      .set('Authorization', `Bearer ${t}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((m) => m.key)).toContain('quality_programme');
  });

  it('lists and summarises for a buyer', async () => {
    const t = await tokenFor('procurement_manager');
    if (!t) return;
    const [list, summary] = await Promise.all([
      request(app).get('/api/v1/supplier-development').set('Authorization', `Bearer ${t}`),
      request(app).get('/api/v1/supplier-development/summary').set('Authorization', `Bearer ${t}`),
    ]);
    expect(list.status).toBe(200);
    expect(summary.status).toBe(200);
    expect(summary.body.data).toHaveProperty('counts');
  });

  it('refuses reads and writes from an account with no procurement grant', async () => {
    const t = await tokenFor('sales_exec');
    if (!t) return;
    const calls = await Promise.all([
      request(app).get('/api/v1/supplier-development').set('Authorization', `Bearer ${t}`),
      request(app).post('/api/v1/supplier-development').set('Authorization', `Bearer ${t}`)
        .send({ vendor_id: vendorId, title: `${TAG} should not exist`, target_metric: 'health_score' }),
    ]);
    for (const res of calls) expect(res.status).toBe(403);

    // And nothing was written anyway — a refused write that still writes is the
    // failure mode an authz test exists to catch.
    const { rows } = await pool.query(
      `SELECT id FROM supplier_development_plans WHERE title LIKE $1`, [`${TAG} should not exist%`]);
    expect(rows).toHaveLength(0);
  });

  it('rejects an unauthenticated caller outright', async () => {
    const res = await request(app).get('/api/v1/supplier-development');
    expect([401, 403]).toContain(res.status);
  });
});

describe('The engine recommends; it never creates', () => {
  it('withholds a recommendation when the evidence is too thin', () => {
    const r = engine.recommendDevelopment({
      detail: { quality: {}, delivery: {}, cost: {} },
      summary: { health_status: 'Unrated', coverage_pct: 30 },
    });
    expect(r.recommend).toBe(false);
    expect(r.withheld).toBe('insufficient_evidence');
    // ⚠ A supplier nobody has ordered from needs orders, not a quality programme.
    expect(r.methods).toEqual([]);
  });

  it('does not prescribe against an unmeasured KPI', () => {
    // Every KPI absent => measured flags false. Nothing may be recommended off
    // a reading that does not exist.
    const r = engine.recommendDevelopment({
      detail: {
        quality:  { capaMeasured: false, passRateMeasured: false, repeatNCR: 0 },
        delivery: { otdMeasured: false, leadTimeMeasured: false, fillRateMeasured: false },
        cost:     { ppvMeasured: false },
      },
      summary: { health_status: 'Critical', coverage_pct: 80 },
    });
    expect(r.recommend).toBe(false);
    expect(r.withheld).toBe('no_finding');
  });

  it('recommends a quality programme for a recurring defect, not a one-off', () => {
    const base = { summary: { health_status: 'Watchlist', coverage_pct: 80 } };
    const oneOff = engine.recommendDevelopment({
      ...base,
      detail: { quality: { repeatNCR: 0, capaMeasured: false, passRateMeasured: false },
                delivery: {}, cost: {} },
    });
    const recurring = engine.recommendDevelopment({
      ...base,
      detail: { quality: { repeatNCR: 3, capaMeasured: false, passRateMeasured: false },
                delivery: {}, cost: {} },
    });
    expect(oneOff.recommend).toBe(false);
    expect(recurring.recommend).toBe(true);
    expect(recurring.methods).toContain('quality_programme');
  });

  it('will not prescribe a lead-time project off a due date we invented', () => {
    // OTD of 40% is dreadful — but measured against order_date + our own
    // lead_time_days, it says nothing about the supplier's promises.
    const implied = engine.recommendDevelopment({
      summary: { health_status: 'Critical', coverage_pct: 80 },
      detail: { quality: {}, cost: {},
                delivery: { otdMeasured: true, otdBasis: 'implied', otdPct: 40, promisedCoveragePct: 0 } },
    });
    expect(implied.recommend).toBe(false);

    const promised = engine.recommendDevelopment({
      summary: { health_status: 'Critical', coverage_pct: 80 },
      detail: { quality: {}, cost: {},
                delivery: { otdMeasured: true, otdBasis: 'promised', otdPct: 40, promisedCoveragePct: 100 } },
    });
    expect(promised.recommend).toBe(true);
    expect(promised.methods).toContain('lead_time_project');
  });

  it('asking for a recommendation creates nothing', async () => {
    const before = await pool.query(
      `SELECT COUNT(*)::int c FROM supplier_development_plans WHERE company_id = $1`, [CO]);
    await svc.recommendFor(vendorId, CO);
    const after = await pool.query(
      `SELECT COUNT(*)::int c FROM supplier_development_plans WHERE company_id = $1`, [CO]);
    expect(after.rows[0].c).toBe(before.rows[0].c);
  });
});

describe('A plan is owned, measured, and judged on evidence', () => {
  let planId;

  it('refuses a plan with no measure to judge it by', async () => {
    await expect(svc.create(
      { vendor_id: vendorId, title: `${TAG} no metric` }, { companyId: CO, userId: null }
    )).rejects.toThrow(/target_metric is required/);
  });

  it('freezes a baseline from the published scorecard when the plan opens', async () => {
    const plan = await svc.create({
      vendor_id: vendorId,
      method: 'quality_programme',
      title: `${TAG} quality improvement`,
      objective: 'Close out recurring dimensional defects',
      owner_employee_id: employeeId,
      trigger_reason: 'Repeat NCRs of the same defect type',
      target_metric: 'health_score',
      target_value: 80,
    }, { companyId: CO, userId: null });

    planId = plan.id;
    expect(plan.plan_number).toMatch(/^SDP-\d{4}-\d{4}$/);
    expect(plan.status).toBe('draft');
    expect(plan.owner_employee_id).toBe(employeeId);

    // The baseline is the scorecard's reading, not anything the caller passed.
    const { rows: [h] } = await pool.query(
      `SELECT health_score FROM vendor_health_scores WHERE vendor_id = $1 AND company_id = $2`,
      [vendorId, CO]);
    expect(Number(plan.baseline_value)).toBeCloseTo(Number(h.health_score), 2);
    expect(plan.baseline_captured_at).not.toBeNull();
  });

  it('will not let the target metric be moved after the baseline is frozen', async () => {
    const updated = await svc.update(planId, { target_metric: 'ppv_pct', title: `${TAG} renamed` },
      { companyId: CO });
    // The title changed; the metric did not. Re-pointing a plan at whichever KPI
    // happened to improve would make every plan a success.
    expect(updated.title).toBe(`${TAG} renamed`);
    expect(updated.target_metric).toBe('health_score');
  });

  it('carries actions with a responsible side', async () => {
    const ours   = await svc.addAction(planId, { description: `${TAG} share drawings`, responsible_party: 'buyer', owner_employee_id: employeeId }, { companyId: CO });
    const theirs = await svc.addAction(planId, { description: `${TAG} re-qualify the tool`, responsible_party: 'supplier' }, { companyId: CO });
    expect(ours.responsible_party).toBe('buyer');
    expect(theirs.responsible_party).toBe('supplier');

    const done = await svc.updateAction(ours.id, { status: 'done' }, { companyId: CO });
    expect(done.status).toBe('done');
    expect(done.completed_at).not.toBeNull();

    const full = await svc.getOne(planId, CO);
    expect(full.actions).toHaveLength(2);
  });

  it('derives effectiveness at close rather than accepting it', async () => {
    const closed = await svc.close(planId, { status: 'completed', companyId: CO });
    expect(closed.status).toBe('completed');
    expect(closed.closed_at).not.toBeNull();
    // Baseline and outcome both came from the scorecard; nothing moved in
    // between, so the honest verdict is no_change — not "completed, therefore
    // successful".
    expect(['improved', 'no_change', 'worsened', 'unmeasured']).toContain(closed.effectiveness);
    expect(closed.effectiveness).toBe('no_change');
  });
});

describe('Effectiveness reads the metric in the right direction', () => {
  it('treats a rise as better for a score and worse for a variance', () => {
    const score = engine.assessEffectiveness({ targetMetric: 'health_score', baselineValue: 40, outcomeValue: 60 });
    expect(score.effectiveness).toBe('improved');

    // ⚠ Lower is better for PPV and NCR counts. Getting this backwards would
    // report a supplier that halved its defects as having got worse.
    const ppv = engine.assessEffectiveness({ targetMetric: 'ppv_pct', baselineValue: 20, outcomeValue: 5 });
    expect(ppv.effectiveness).toBe('improved');

    const ncr = engine.assessEffectiveness({ targetMetric: 'open_ncr_count', baselineValue: 2, outcomeValue: 7 });
    expect(ncr.effectiveness).toBe('worsened');
  });

  it('calls an unmeasurable outcome unmeasured, never no_change', () => {
    const r = engine.assessEffectiveness({ targetMetric: 'fill_rate_pct', baselineValue: null, outcomeValue: 90 });
    expect(r.effectiveness).toBe('unmeasured');
    expect(r.improved).toBeNull();
  });
});

describe('An open plan does not suppress the rating it answers', () => {
  it('leaves health_score and health_status untouched', async () => {
    const before = await health.computeAndSave(vendorId, CO);

    const plan = await svc.create({
      vendor_id: vendorId,
      method: 'capability_build',
      title: `${TAG} does not mask the score`,
      owner_employee_id: employeeId,
      target_metric: 'health_score',
    }, { companyId: CO, userId: null });
    await svc.update(plan.id, { status: 'active' }, { companyId: CO });

    const after = await health.computeAndSave(vendorId, CO);

    // ⚠ THE DELIBERATE DECISION. A plan is a RESPONSE to a bad score, not a cure
    // for it. Folding an open plan into the composite would let good intentions
    // hide a supplier that is still failing — the same class of error as scoring
    // an unmeasured dimension at its default.
    expect(after.health_score).toBe(before.health_score);
    expect(after.health_status).toBe(before.health_status);
    expect(after.coverage_pct).toBe(before.coverage_pct);
  });

  it('reports an existing plan as covering a finding instead of hiding it', async () => {
    const rec = await svc.recommendFor(vendorId, CO);
    // Findings already answered by an open plan are separated, not filtered out:
    // a buyer must be able to see that the problem still exists and is being
    // worked, rather than watch it vanish from the list.
    expect(rec).toHaveProperty('reasons_open');
    expect(rec).toHaveProperty('reasons_unaddressed');
    expect(rec.open_plans.length).toBeGreaterThan(0);
  });
});
