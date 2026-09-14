/**
 * supplierDevelopment.service.js — plans, their actions, and whether they worked.
 *
 * The engine beside this decides what to recommend; this owns the records and
 * the two moments that make a plan meaningful:
 *
 *   OPEN   freeze the supplier's current reading of the metric the plan names
 *          (`baseline_value`). Without a frozen baseline there is nothing to
 *          compare to later, and "it feels better" becomes the measure.
 *   CLOSE  read the same metric again and derive `effectiveness`. Never typed
 *          by the person closing their own plan.
 *
 * ⚠ Both readings come from `vendor_health_scores`, the table the scorecard
 * publishes — not from a number the caller passes in. A plan that could be
 * opened with a flattering baseline and closed with a flattering outcome would
 * measure nothing but its owner's optimism.
 */
import pool from '../../../config/db.js';
import engine from '../engines/supplierDevelopmentEngine.js';
import healthSvc from './vendorHealth.service.js';
import { nextSupplierDevPlanNumber } from '../../../shared/docNumber.js';

const q = (sql, params) => pool.query(sql, params);

/** Columns on vendor_health_scores a plan may target — mirrors the CHECK constraint. */
const TARGET_METRICS = new Set(['health_score', 'quality_score', 'delivery_score', 'cost_score',
  'support_score', 'otd_pct', 'pass_rate_pct', 'capa_closure_pct', 'fill_rate_pct',
  'lead_time_adherence_pct', 'ppv_pct', 'open_ncr_count']);

/**
 * The supplier's current reading of one metric, from the published scorecard.
 *
 * ⚠ Returns null, not 0, when the scorecard has not measured it. A baseline of
 * 0 on an unmeasured KPI would make any later reading look like an improvement.
 */
async function readMetric(vendorId, companyId, metric) {
  if (!TARGET_METRICS.has(metric)) {
    throw Object.assign(new Error(`Unknown target metric '${metric}'`), { status: 400 });
  }
  const { rows } = await q(
    `SELECT ${metric} AS v FROM vendor_health_scores
      WHERE vendor_id = $1 AND ($2::int IS NULL OR company_id = $2)
      ORDER BY calculated_at DESC NULLS LAST LIMIT 1`,
    [vendorId, companyId]
  );
  const v = rows[0]?.v;
  return v == null ? null : Number(v);
}

/**
 * What this supplier's evidence argues for. Recomputes the scorecard first so
 * the recommendation is made on today's transactions, not on whenever the cron
 * last ran.
 */
async function recommendFor(vendorId, companyId) {
  const health = await healthSvc.computeAndSave(vendorId, companyId);
  const { rows: [flags] } = await q(
    `SELECT is_single_source, is_critical_supplier FROM vendors WHERE id = $1`, [vendorId]
  ).catch(() => ({ rows: [{}] }));

  const rec = engine.recommendDevelopment({
    detail:  health.detail,
    summary: { health_score: health.health_score, health_status: health.health_status,
               coverage_pct: health.coverage_pct },
    flags: { isSingleSource: !!flags?.is_single_source,
             isCriticalSupplier: !!flags?.is_critical_supplier },
  });

  // An open plan already answering a finding is not a second finding.
  const { rows: open } = await q(
    `SELECT id, plan_number, method, status, target_metric
       FROM supplier_development_plans
      WHERE vendor_id = $1 AND ($2::int IS NULL OR company_id = $2)
        AND status IN ('draft', 'active', 'in_review')`,
    [vendorId, companyId]
  );
  const covered = new Set(open.map((p) => p.method));

  return {
    ...rec,
    health_score: health.health_score,
    health_status: health.health_status,
    open_plans: open,
    // Split rather than filtered: a buyer should see that a finding is already
    // being worked, not have it silently disappear from the list.
    reasons_open:      rec.reasons.filter((r) => covered.has(r.method)),
    reasons_unaddressed: rec.reasons.filter((r) => !covered.has(r.method)),
  };
}

async function list({ companyId, vendorId, status }) {
  const where = ['($1::int IS NULL OR p.company_id = $1)'];
  const params = [companyId ?? null];
  if (vendorId) { params.push(vendorId); where.push(`p.vendor_id = $${params.length}`); }
  if (status)   { params.push(status);   where.push(`p.status = $${params.length}`); }

  const { rows } = await q(
    `SELECT p.*,
            COALESCE(v.vendor_name, v.name) AS vendor_name, v.vendor_code,
            e.name  AS owner_name,
            vc.name AS vendor_contact_name,
            (SELECT COUNT(*)::int FROM supplier_development_actions a WHERE a.plan_id = p.id) AS action_count,
            (SELECT COUNT(*)::int FROM supplier_development_actions a
              WHERE a.plan_id = p.id AND a.status = 'done') AS actions_done,
            (SELECT COUNT(*)::int FROM supplier_development_actions a
              WHERE a.plan_id = p.id AND a.status <> 'done' AND a.due_date < CURRENT_DATE) AS actions_overdue,
            h.health_score, h.health_status
       FROM supplier_development_plans p
       JOIN vendors v ON v.id = p.vendor_id
       LEFT JOIN employees e ON e.id = p.owner_employee_id
       LEFT JOIN vendor_contacts vc ON vc.id = p.vendor_contact_id
       LEFT JOIN vendor_health_scores h ON h.vendor_id = p.vendor_id AND h.company_id = p.company_id
      WHERE ${where.join(' AND ')}
      ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'in_review' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END,
               p.review_date NULLS LAST, p.created_at DESC`,
    params
  );
  return rows;
}

async function getOne(id, companyId) {
  const { rows: [plan] } = await q(
    `SELECT p.*, COALESCE(v.vendor_name, v.name) AS vendor_name, v.vendor_code,
            e.name AS owner_name, vc.name AS vendor_contact_name
       FROM supplier_development_plans p
       JOIN vendors v ON v.id = p.vendor_id
       LEFT JOIN employees e ON e.id = p.owner_employee_id
       LEFT JOIN vendor_contacts vc ON vc.id = p.vendor_contact_id
      WHERE p.id = $1 AND ($2::int IS NULL OR p.company_id = $2)`,
    [id, companyId]
  );
  if (!plan) return null;
  const { rows: actions } = await q(
    `SELECT a.*, e.name AS owner_name
       FROM supplier_development_actions a
       LEFT JOIN employees e ON e.id = a.owner_employee_id
      WHERE a.plan_id = $1
      ORDER BY a.due_date NULLS LAST, a.id`, [id]
  );
  // Live reading of the target metric, so an open plan shows movement rather
  // than only reporting it at close.
  const current = await readMetric(plan.vendor_id, companyId, plan.target_metric).catch(() => null);
  const progress = engine.assessEffectiveness({
    targetMetric: plan.target_metric,
    baselineValue: plan.baseline_value,
    outcomeValue: current,
  });
  return { ...plan, actions, current_value: current, progress };
}

async function create(data, { companyId, userId }) {
  const {
    vendor_id, method, title, objective, owner_employee_id, vendor_contact_id,
    trigger_reason, target_metric, target_value, target_date, review_date,
  } = data;

  if (!vendor_id)     throw Object.assign(new Error('vendor_id is required'), { status: 400 });
  if (!title)         throw Object.assign(new Error('title is required'), { status: 400 });
  if (!target_metric) throw Object.assign(new Error('target_metric is required — a plan with no measure cannot be judged'), { status: 400 });

  // The vendor must be ours. Without this a caller could open a plan against
  // another tenant's supplier and read its scorecard through the baseline.
  const { rows: [vendor] } = await q(
    `SELECT id FROM vendors WHERE id = $1 AND deleted_at IS NULL
       AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)`,
    [vendor_id, companyId]);
  if (!vendor) throw Object.assign(new Error('Vendor not found'), { status: 404 });

  // Freeze the baseline from the published scorecard, at this moment.
  const baseline = await readMetric(vendor_id, companyId, target_metric);
  const planNumber = await nextSupplierDevPlanNumber();

  const { rows: [plan] } = await q(
    `INSERT INTO supplier_development_plans
       (plan_number, company_id, vendor_id, method, title, objective,
        owner_employee_id, vendor_contact_id, trigger_reason,
        target_metric, baseline_value, baseline_captured_at,
        target_value, target_date, review_date, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
             CASE WHEN $11::numeric IS NULL THEN NULL ELSE NOW() END,
             $12,$13,$14,'draft',$15)
     RETURNING *`,
    [planNumber, companyId, vendor_id, method || 'other', title, objective ?? null,
     owner_employee_id ?? null, vendor_contact_id ?? null, trigger_reason ?? null,
     target_metric, baseline, target_value ?? null, target_date ?? null,
     review_date ?? null, userId ?? null]
  );
  return plan;
}

async function update(id, data, { companyId }) {
  const allowed = ['title', 'objective', 'owner_employee_id', 'vendor_contact_id',
    'method', 'target_value', 'target_date', 'review_date', 'status', 'trigger_reason'];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (data[k] !== undefined) { params.push(data[k]); sets.push(`${k} = $${params.length}`); }
  }
  if (!sets.length) throw Object.assign(new Error('Nothing to update'), { status: 400 });

  // ⚠ target_metric is deliberately NOT updatable. Changing it after the fact
  // would orphan the frozen baseline and let a plan be re-pointed at whichever
  // KPI happens to have improved.
  params.push(id, companyId ?? null);
  const { rows: [plan] } = await q(
    `UPDATE supplier_development_plans SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length - 1} AND ($${params.length}::int IS NULL OR company_id = $${params.length})
      RETURNING *`, params);
  if (!plan) throw Object.assign(new Error('Plan not found'), { status: 404 });
  return plan;
}

/**
 * Close a plan and judge it.
 *
 * `outcome` is read from the scorecard, not accepted from the caller, and
 * `effectiveness` is derived from baseline vs outcome. A plan closed as
 * 'abandoned' is still measured — knowing that an abandoned programme's supplier
 * improved anyway is worth as much as knowing a completed one's did not.
 */
async function close(id, { status = 'completed', companyId }) {
  if (!['completed', 'abandoned'].includes(status)) {
    throw Object.assign(new Error(`close() takes 'completed' or 'abandoned'`), { status: 400 });
  }
  const { rows: [plan] } = await q(
    `SELECT * FROM supplier_development_plans
      WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`, [id, companyId]);
  if (!plan) throw Object.assign(new Error('Plan not found'), { status: 404 });

  // Recompute before reading, so the outcome reflects transactions up to today.
  await healthSvc.computeAndSave(plan.vendor_id, plan.company_id).catch(() => {});
  const outcome = await readMetric(plan.vendor_id, plan.company_id, plan.target_metric);
  const { effectiveness } = engine.assessEffectiveness({
    targetMetric: plan.target_metric,
    baselineValue: plan.baseline_value,
    outcomeValue: outcome,
  });

  const { rows: [saved] } = await q(
    `UPDATE supplier_development_plans
        SET status = $1, outcome_value = $2,
            outcome_captured_at = CASE WHEN $2::numeric IS NULL THEN NULL ELSE NOW() END,
            effectiveness = $3, closed_at = NOW(), updated_at = NOW()
      WHERE id = $4 RETURNING *`,
    [status, outcome, effectiveness, id]);
  return saved;
}

async function addAction(planId, data, { companyId }) {
  const { description, responsible_party, owner_employee_id, due_date } = data;
  if (!description) throw Object.assign(new Error('description is required'), { status: 400 });
  const { rows: [plan] } = await q(
    `SELECT id, company_id FROM supplier_development_plans
      WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`, [planId, companyId]);
  if (!plan) throw Object.assign(new Error('Plan not found'), { status: 404 });

  const { rows: [action] } = await q(
    `INSERT INTO supplier_development_actions
       (company_id, plan_id, description, responsible_party, owner_employee_id, due_date)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [plan.company_id, planId, description,
     responsible_party === 'supplier' ? 'supplier' : 'buyer',
     owner_employee_id ?? null, due_date ?? null]);
  return action;
}

async function updateAction(actionId, data, { companyId }) {
  const { status, description, due_date, owner_employee_id, responsible_party } = data;
  const sets = [];
  const params = [];
  const put = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (status !== undefined) {
    put('status', status);
    // ⚠ A SEPARATE BOOLEAN PARAMETER, not a re-use of $status.
    // Referencing the same placeholder as both a VARCHAR column value and
    // `$n::text` makes Postgres give up: "inconsistent types deduced for
    // parameter $1" (verified). Deciding in JS and binding a boolean is the same
    // shape vendor-approval.routes.js uses for its close flags.
    put('__done', status === 'done');
    sets[sets.length - 1] = `completed_at = CASE WHEN $${params.length}::boolean THEN COALESCE(completed_at, NOW()) ELSE NULL END`;
  }
  if (description !== undefined)       put('description', description);
  if (due_date !== undefined)          put('due_date', due_date);
  if (owner_employee_id !== undefined) put('owner_employee_id', owner_employee_id);
  if (responsible_party !== undefined) put('responsible_party', responsible_party);
  if (!sets.length) throw Object.assign(new Error('Nothing to update'), { status: 400 });

  params.push(actionId, companyId ?? null);
  const { rows: [action] } = await q(
    `UPDATE supplier_development_actions SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length - 1} AND ($${params.length}::int IS NULL OR company_id = $${params.length})
      RETURNING *`, params);
  if (!action) throw Object.assign(new Error('Action not found'), { status: 404 });
  return action;
}

/** Portfolio view: is supplier development actually producing anything? */
async function summary(companyId) {
  const [{ rows: [counts] }, { rows: byMethod }, { rows: outcomes }, { rows: due }] = await Promise.all([
    q(`SELECT COUNT(*)::int                                            AS total,
              COUNT(*) FILTER (WHERE status = 'active')::int           AS active,
              COUNT(*) FILTER (WHERE status = 'draft')::int            AS draft,
              COUNT(*) FILTER (WHERE status = 'in_review')::int        AS in_review,
              COUNT(*) FILTER (WHERE status = 'completed')::int        AS completed,
              COUNT(*) FILTER (WHERE status = 'abandoned')::int        AS abandoned,
              COUNT(DISTINCT vendor_id)::int                           AS suppliers
         FROM supplier_development_plans WHERE ($1::int IS NULL OR company_id = $1)`, [companyId]),
    q(`SELECT method, COUNT(*)::int AS c FROM supplier_development_plans
        WHERE ($1::int IS NULL OR company_id = $1) GROUP BY method ORDER BY c DESC`, [companyId]),
    // ⚠ 'unmeasured' is reported, not folded into 'no_change'. A programme whose
    // effect could not be measured is a gap in our evidence, and hiding it in
    // with the ones that demonstrably did nothing would overstate what we know.
    q(`SELECT effectiveness, COUNT(*)::int AS c FROM supplier_development_plans
        WHERE ($1::int IS NULL OR company_id = $1) AND effectiveness IS NOT NULL
        GROUP BY effectiveness`, [companyId]),
    q(`SELECT p.id, p.plan_number, p.title, p.review_date,
              COALESCE(v.vendor_name, v.name) AS vendor_name
         FROM supplier_development_plans p JOIN vendors v ON v.id = p.vendor_id
        WHERE ($1::int IS NULL OR p.company_id = $1)
          AND p.status IN ('active', 'in_review')
          AND p.review_date IS NOT NULL AND p.review_date <= CURRENT_DATE + 14
        ORDER BY p.review_date LIMIT 20`, [companyId]),
  ]);
  return { counts, by_method: byMethod, outcomes, reviews_due: due };
}

export default {
  recommendFor, list, getOne, create, update, close,
  addAction, updateAction, summary, readMetric,
};
