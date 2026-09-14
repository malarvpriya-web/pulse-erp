/**
 * integration.savingsRegister.test.js — the refusals, against the REAL database.
 *
 * WHY THIS EXISTS
 * ---------------
 * A savings register is the most gameable object in procurement: every
 * incentive in the organisation points at making its number bigger, and every
 * classic way of inflating it looks entirely normal in the data afterwards.
 *
 * So almost every rule in savingsRegister.service.js is a REFUSAL, and a
 * refusal that is never exercised is indistinguishable from one that was never
 * implemented. This suite exists to exercise each one:
 *
 *   - book the same period twice                       → unique index
 *   - book an annual saving every month                → same thing, the common case
 *   - bank a saving that was never contracted          → stage gate
 *   - bank a saving after the initiative lapsed        → effective window
 *   - mark a saving realised with no finance sign-off  → approval gate
 *   - sign off your own initiative                     → self-certification gate
 *   - jump identified → realised                       → stage graph
 *   - raise the same TCO award as three initiatives    → source unique index
 *
 * Every one of those is a way a real savings programme has been inflated in
 * real companies. The number they produce is never obviously wrong.
 *
 * Self-cleaning on the `ZZSAV_` convention, matching integration.tcoAward.
 *
 * Runner: Vitest | npx vitest run src/__tests__/integration.savingsRegister.test.js
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  let envText;
  try {
    envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  } catch {
    throw new Error('Neither DATABASE_URL nor backend/.env is available — this suite needs a real database.');
  }
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool } = await import('../config/db.js');
const svc = await import('../modules/procurement/services/savingsRegister.service.js');

const TAG = 'ZZSAV_';
const CO = 1;

// ⚠ Real users, resolved in beforeAll. `owner_user_id`, `created_by` and
// `finance_approved_by` all carry a foreign key to `users`, so invented ids fail
// the insert rather than the assertion — which is the FK doing its job, and is
// why the self-certification test needs two genuinely different people.
let RAISER, APPROVER;

async function sweepDebris() {
  await pool.query(
    `DELETE FROM savings_events WHERE initiative_id IN
       (SELECT id FROM savings_initiatives WHERE title LIKE $1)`, [`${TAG}%`]);
  await pool.query(`DELETE FROM savings_initiatives WHERE title LIKE $1`, [`${TAG}%`]);
}

/** Raise one, optionally walking it forward to a stage. */
async function raise(name, extra = {}) {
  const out = await svc.createInitiative({
    companyId: CO, userId: RAISER,
    body: {
      title: `${TAG}${name}`,
      baseline_unit_price: 100, target_unit_price: 90, baseline_annual_qty: 1000,
      baseline_basis: 'observed',
      effective_from: '2026-01-01', effective_to: '2026-12-31',
      ...extra,
    },
  });
  return out;
}

async function walkTo(id, stages, { approver = APPROVER } = {}) {
  let last;
  for (const s of stages) {
    last = await svc.changeStage({
      companyId: CO,
      userId: s === 'realised' ? approver : RAISER,
      id, toStage: s,
      financeApproval: s === 'realised',
    });
    if (last.error) return last;
  }
  return last;
}

beforeAll(async () => {
  await sweepDebris();
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE company_id = $1 ORDER BY id LIMIT 2`, [CO]);
  RAISER = rows[0]?.id;
  APPROVER = rows[1]?.id;
  if (!RAISER || !APPROVER) {
    throw new Error('This suite needs two users in company 1 — the self-certification gate is meaningless with one.');
  }
});
afterAll(async () => { await sweepDebris(); await pool.end().catch(() => {}); });

describe('the run-rate figure', () => {
  it('is frozen from baseline, target and annual quantity', () => {
    expect(svc.computeAnnualSaving({
      baseline_unit_price: 100, target_unit_price: 90, baseline_annual_qty: 1000,
    })).toBeCloseTo(10000, 2);
  });

  it('reports a price INCREASE as zero, never as a negative saving', () => {
    // A negative "saving" would net off against real savings elsewhere and
    // quietly shrink the visible size of a problem.
    expect(svc.computeAnnualSaving({
      baseline_unit_price: 90, target_unit_price: 100, baseline_annual_qty: 1000,
    })).toBe(0);
  });

  it('is zero, not a guess, when an input is missing', () => {
    expect(svc.computeAnnualSaving({ baseline_unit_price: 100, target_unit_price: 90 })).toBe(0);
  });
});

describe('the stage graph', () => {
  it('refuses identified → realised: the intermediate states ARE the evidence', async () => {
    const { initiative } = await raise('JUMP');
    const out = await svc.changeStage({
      companyId: CO, userId: APPROVER, id: initiative.id,
      toStage: 'realised', financeApproval: true,
    });
    expect(out.error).toMatch(/Cannot move a 'identified' initiative to 'realised'/);
    expect(out.status).toBe(409);
  });

  it('allows the full walk identified → negotiated → contracted → realised', async () => {
    const { initiative } = await raise('WALK');
    const out = await walkTo(initiative.id, ['negotiated', 'contracted', 'realised']);
    expect(out.error).toBeUndefined();
    expect(out.initiative.stage).toBe('realised');
    expect(out.initiative.finance_approved_by).toBe(APPROVER);
    expect(out.initiative.finance_approved_at).toBeTruthy();
  });

  it('treats rejected as terminal — a dead initiative cannot be revived', async () => {
    // Reopening is how the same saving gets counted in two different years.
    const { initiative } = await raise('DEAD');
    await svc.changeStage({ companyId: CO, userId: RAISER, id: initiative.id, toStage: 'rejected' });
    const out = await svc.changeStage({
      companyId: CO, userId: RAISER, id: initiative.id, toStage: 'negotiated',
    });
    expect(out.error).toMatch(/terminal/);
  });
});

describe('finance sign-off', () => {
  it('refuses to mark a saving realised without it', async () => {
    const { initiative } = await raise('NOSIGN');
    await walkTo(initiative.id, ['negotiated', 'contracted']);
    const out = await svc.changeStage({
      companyId: CO, userId: RAISER, id: initiative.id,
      toStage: 'realised', financeApproval: false,
    });
    expect(out.error).toMatch(/without finance sign-off/);
    expect(out.status).toBe(403);
  });

  it('refuses self-certification — the raiser cannot sign off their own claim', async () => {
    // A register where the claimant approves their own claim is a press release.
    const { initiative } = await raise('SELFSIGN');
    await walkTo(initiative.id, ['negotiated', 'contracted']);
    const out = await svc.changeStage({
      companyId: CO, userId: RAISER, id: initiative.id,
      toStage: 'realised', financeApproval: true,
    });
    expect(out.error).toMatch(/cannot sign it off/);
    expect(out.status).toBe(403);
  });
});

describe('realisation — the anti-double-count rules', () => {
  it('refuses to bank a saving that was never contracted', async () => {
    const { initiative } = await raise('UNCONTRACTED');
    const out = await svc.postRealisation({
      companyId: CO, userId: RAISER, id: initiative.id,
      body: { amount: 500, period_start: '2026-03-01', period_end: '2026-03-31' },
    });
    expect(out.error).toMatch(/must be contracted before it can be banked/);
  });

  it('refuses a second posting for the SAME period', async () => {
    const { initiative } = await raise('DUPPERIOD');
    await walkTo(initiative.id, ['negotiated', 'contracted']);

    const first = await svc.postRealisation({
      companyId: CO, userId: RAISER, id: initiative.id,
      body: { amount: 800, period_start: '2026-03-01', period_end: '2026-03-31' },
    });
    expect(first.event).toBeTruthy();

    const second = await svc.postRealisation({
      companyId: CO, userId: RAISER, id: initiative.id,
      body: { amount: 800, period_start: '2026-03-01', period_end: '2026-03-31' },
    });
    expect(second.error).toMatch(/already been posted/);
    expect(second.status).toBe(409);
  });

  it('lets a full year be banked month by month WITHOUT letting any month repeat', async () => {
    // The headline case: an annual saving booked twelve times is fiction. Twelve
    // DISTINCT months is correct. The index tells them apart; a running total
    // typed by a user cannot.
    const { initiative } = await raise('TWELVE');
    await walkTo(initiative.id, ['negotiated', 'contracted']);

    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      const last = new Date(2026, m, 0).getDate();
      const out = await svc.postRealisation({
        companyId: CO, userId: RAISER, id: initiative.id,
        body: { amount: 1000, period_start: `2026-${mm}-01`, period_end: `2026-${mm}-${last}` },
      });
      expect(out.event, `month ${mm} should post`).toBeTruthy();
    }

    const repeat = await svc.postRealisation({
      companyId: CO, userId: RAISER, id: initiative.id,
      body: { amount: 1000, period_start: '2026-06-01', period_end: '2026-06-30' },
    });
    expect(repeat.error).toMatch(/already been posted/);

    const full = await svc.getInitiative({ companyId: CO, id: initiative.id });
    expect(full.realised_amount).toBeCloseTo(12000, 2);
  });

  it('refuses a period outside the effective window — a lapsed saving cannot bank', async () => {
    const { initiative } = await raise('WINDOW', {
      effective_from: '2026-01-01', effective_to: '2026-06-30',
    });
    await walkTo(initiative.id, ['negotiated', 'contracted']);
    const out = await svc.postRealisation({
      companyId: CO, userId: RAISER, id: initiative.id,
      body: { amount: 500, period_start: '2026-08-01', period_end: '2026-08-31' },
    });
    expect(out.error).toMatch(/after this initiative lapsed/);
  });

  it('requires a named period — a realisation is never a running total', async () => {
    const { initiative } = await raise('NOPERIOD');
    await walkTo(initiative.id, ['negotiated', 'contracted']);
    const out = await svc.postRealisation({
      companyId: CO, userId: RAISER, id: initiative.id, body: { amount: 500 },
    });
    expect(out.error).toMatch(/always for a named period/);
  });
});

describe('one initiative per source record', () => {
  it('refuses the same TCO award raised twice', async () => {
    const ref = 987654;
    const first = await raise('SRC1', { source_type: 'tco_award', source_ref_id: ref });
    expect(first.initiative).toBeTruthy();

    const second = await raise('SRC2', { source_type: 'tco_award', source_ref_id: ref });
    expect(second.error).toMatch(/already exists for that source record/);
    expect(second.status).toBe(409);
  });
});

describe('the realised total is summed from the ledger, never stored', () => {
  it('has no realised column on the initiative to drift', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'savings_initiatives'`);
    const cols = rows.map(r => r.column_name);
    // A stored running total and its own history drift the moment anything is
    // corrected, and both numbers look plausible afterwards.
    expect(cols).not.toContain('realised_amount');
    expect(cols).not.toContain('realised_value');
  });

  it('recomputes after a correction rather than going stale', async () => {
    const { initiative } = await raise('CORRECT');
    await walkTo(initiative.id, ['negotiated', 'contracted']);
    await svc.postRealisation({
      companyId: CO, userId: RAISER, id: initiative.id,
      body: { amount: 900, period_start: '2026-04-01', period_end: '2026-04-30' },
    });

    let full = await svc.getInitiative({ companyId: CO, id: initiative.id });
    expect(full.realised_amount).toBeCloseTo(900, 2);

    // Correct the posting downward.
    await pool.query(
      `UPDATE savings_events SET amount = 400
        WHERE initiative_id = $1 AND event_type = 'realisation'`, [initiative.id]);

    full = await svc.getInitiative({ companyId: CO, id: initiative.id });
    expect(full.realised_amount).toBeCloseTo(400, 2);
  });
});

describe('the pipeline board', () => {
  it('never adds a run rate to banked money', async () => {
    const p = await svc.loadPipeline({ companyId: CO });
    // Two different kinds of number, in two different blocks, with their bases
    // stated. A single "savings" headline mixing them is why nobody believes
    // savings reporting.
    expect(p.pipeline.basis).toMatch(/run rate/i);
    expect(p.realised.basis).toMatch(/realisation postings/i);
    expect(p.pipeline).toHaveProperty('open_value');
    expect(p.realised).toHaveProperty('value');
    expect(p.pipeline.note).toMatch(/never added/i);
  });

  it('counts only live stages in open pipeline — rejected and lapsed do not inflate it', async () => {
    const before = await svc.loadPipeline({ companyId: CO });

    const { initiative } = await raise('REJECTED_NOT_COUNTED');
    const afterRaise = await svc.loadPipeline({ companyId: CO });
    expect(afterRaise.pipeline.open_value).toBeGreaterThan(before.pipeline.open_value);

    await svc.changeStage({ companyId: CO, userId: RAISER, id: initiative.id, toStage: 'rejected' });
    const afterReject = await svc.loadPipeline({ companyId: CO });
    expect(afterReject.pipeline.open_value).toBeCloseTo(before.pipeline.open_value, 2);
  });

  it('separates evidenced realisations from bare claims', async () => {
    const p = await svc.loadPipeline({ companyId: CO });
    // A realisation pointing at a PO or invoice is a fact; 'manual' is a claim.
    // Reporting them as one number hides how much of a programme is assertion.
    expect(p.realised).toHaveProperty('evidenced_value');
    expect(p.realised).toHaveProperty('evidenced_pct');
  });

  it('reports how much of the pipeline rests on an assumed baseline', async () => {
    const p = await svc.loadPipeline({ companyId: CO });
    expect(Array.isArray(p.by_baseline_basis)).toBe(true);
    for (const row of p.by_baseline_basis) {
      expect(svc.BASES).toContain(row.baseline_basis);
    }
  });
});
