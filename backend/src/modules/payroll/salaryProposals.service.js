/**
 * salaryProposals.service.js — CTC-driven salary revisions as an HR-reviewed
 * workflow (PAYROLL_DATA_FLOW_AUDIT.md Part 4).
 *
 *   preview  → no write, available whatever the company's ctc_mode
 *   propose  → draft in salary_revision_proposals (ctc_mode must be ON)
 *   approve  → the ONLY path that writes employee_salary_assignments for a
 *              CTC revision; maker-checker per the recorded policy; recomputed
 *              at approval and refused if the figures moved, if the policy or a
 *              statutory rule it uses is not settled, or if payroll for the
 *              effective month is already approved
 *   reject   → closes the draft; history is kept
 *
 * Drafts never enter employee_salary_assignments, so payroll, increments, F&F,
 * leave encashment and analytics can never read an unapproved salary.
 */
import pool from '../shared/db.js';
import { loadRuleRows, resolveRules } from './statutoryRules.js';
import { contractBreakdown, solveFromAnnualCtc, resolvePolicy, finalisationBlockers } from './ctcService.js';
import { normalizePayrollSettings } from './payrollSettings.js';
import { logAudit } from '../../services/AuditService.js';

export class ProposalError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const iso = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

async function settingsOf(client, companyId) {
  const { rows } = await client.query(
    `SELECT settings FROM company_settings WHERE company_id = $1 AND module = 'payroll' LIMIT 1`, [companyId]);
  return normalizePayrollSettings(rows[0]?.settings || {}).settings;
}

async function requireCtcMode(client, companyId) {
  const s = await settingsOf(client, companyId);
  if (!s.ctc_mode) throw new ProposalError(409, 'CTC-driven salary entry is switched off for this company (Payroll Settings → CTC-driven salary entry)');
  return s;
}

/** Structure the caller's company may use: a shared template or its own. */
async function structureFor(client, companyId, structureId) {
  if (structureId != null) {
    const { rows } = await client.query(
      `SELECT id, name, components, company_id FROM salary_structures WHERE id = $1 AND (company_id IS NULL OR company_id = $2)`,
      [structureId, companyId]);
    if (!rows[0]) throw new ProposalError(404, 'Salary structure not found');
    return rows[0];
  }
  const { rows } = await client.query(
    `SELECT id, name, components, company_id FROM salary_structures
      WHERE is_default = true AND (company_id = $1 OR company_id IS NULL)
      ORDER BY company_id NULLS LAST, id LIMIT 1`, [companyId]);
  if (!rows[0]) throw new ProposalError(422, 'No salary structure given and no default structure exists');
  return rows[0];
}

async function employeeFor(client, companyId, employeeId) {
  const { rows } = await client.query(
    `SELECT e.id, e.office_id, e.dob, e.joining_date, e.status,
            (SELECT b.state FROM branches b WHERE b.id = e.branch_id) AS state,
            (SELECT c.state FROM companies c WHERE c.id = e.company_id) AS work_state
       FROM employees e WHERE e.id = $1 AND e.company_id = $2 AND e.deleted_at IS NULL`, [employeeId, companyId]);
  if (!rows[0]) throw new ProposalError(404, 'Employee not found');
  return rows[0];
}

/**
 * Compute a contract breakdown. Exactly one of annual_ctc / basic_monthly.
 * Returns figures plus whether they could be finalised today, and why not.
 */
export async function computeCtc({ company_id, structure_id = null, employee_id = null, effective_from, annual_ctc = null, basic_monthly = null, client = pool }) {
  if (company_id == null) throw new ProposalError(400, 'Company context required');
  if (!DATE_RE.test(String(effective_from || ''))) throw new ProposalError(400, 'effective_from must be YYYY-MM-DD');
  const hasCtc = annual_ctc !== null && annual_ctc !== undefined && annual_ctc !== '';
  const hasBasic = basic_monthly !== null && basic_monthly !== undefined && basic_monthly !== '';
  if (hasCtc === hasBasic) throw new ProposalError(400, 'Give exactly one of annual_ctc (₹ per year) or basic_monthly (₹ per month)');
  if (hasCtc && Number(annual_ctc) < 60000) {
    throw new ProposalError(422, `₹${Number(annual_ctc).toLocaleString('en-IN')} is below ₹60,000 a year — it looks like a MONTHLY figure. Enter the annual CTC.`);
  }
  if (hasBasic && Number(basic_monthly) > 500000) {
    throw new ProposalError(422, `₹${Number(basic_monthly).toLocaleString('en-IN')} a month looks like an ANNUAL figure. Enter the monthly Basic.`);
  }
  const structure = await structureFor(client, company_id, structure_id);
  const emp = employee_id != null
    ? await employeeFor(client, company_id, employee_id)
    : (await client.query(`SELECT NULL AS id, state AS work_state FROM companies WHERE id = $1`, [company_id])).rows[0];
  const settings = await settingsOf(client, company_id);
  const ruleRows = await loadRuleRows(client, company_id);
  const { values: rules, applied } = resolveRules(effective_from, ruleRows);
  const policy = resolvePolicy(effective_from, ruleRows);
  const ctx = { structureComponents: structure.components, emp, settings, rules, policy: policy.value, asOf: effective_from };
  let basic, breakdown, residual = 0, requested = null;
  if (hasCtc) {
    const s = solveFromAnnualCtc(Number(annual_ctc), ctx);
    basic = s.basicMonthly; breakdown = s.breakdown; residual = s.rounding_residual; requested = Number(annual_ctc);
  } else {
    basic = Math.round(Number(basic_monthly));
    if (!(basic > 0)) throw new ProposalError(400, 'basic_monthly must be greater than zero');
    breakdown = contractBreakdown({ ...ctx, basicMonthly: basic });
  }
  const blockers = finalisationBlockers({ policy, rulesApplied: applied });
  return {
    entry_mode: hasCtc ? 'annual_ctc' : 'basic_monthly',
    structure: { id: structure.id, name: structure.name, shared: structure.company_id == null },
    effective_from, basic_monthly: basic, requested_annual_ctc: requested, rounding_residual: residual,
    breakdown, policy: { version: policy.value.version, origin: policy.origin, status: policy.status, maker_checker: !!policy.value.maker_checker },
    finalisable: blockers.length === 0, blockers,
  };
}

async function assertMonthOpen(client, employeeId, effectiveFrom) {
  const { rows } = await client.query(
    `SELECT month, year FROM payroll_runs
      WHERE employee_id = $1 AND status IN ('approved', 'paid') AND is_test = false
        AND make_date(year, month, 1) + INTERVAL '1 month' - INTERVAL '1 day' >= $2::date
      ORDER BY year DESC, month DESC LIMIT 1`, [employeeId, effectiveFrom]);
  if (rows[0]) {
    throw new ProposalError(422, `Payroll for ${rows[0].month}/${rows[0].year} is already approved — date the revision after it (differences for earlier months are arrears)`);
  }
}

export async function createProposal({ company_id, employee_id, structure_id = null, effective_from, annual_ctc = null, basic_monthly = null, source_type = 'manual', source_id = null, userId = null, req = null, client: given = null }) {
  const client = given || await pool.connect();
  try {
    if (!DATE_RE.test(String(effective_from || ''))) throw new ProposalError(400, 'effective_from must be YYYY-MM-DD');
    if (!given) await client.query('BEGIN');
    await requireCtcMode(client, company_id);
    const emp = await employeeFor(client, company_id, employee_id);
    if (emp.joining_date && effective_from < iso(emp.joining_date)) {
      throw new ProposalError(422, `Effective date ${effective_from} is before the joining date ${iso(emp.joining_date)}`);
    }
    await assertMonthOpen(client, employee_id, effective_from);
    const { rows: clash } = await client.query(
      `SELECT 1 FROM employee_salary_assignments WHERE employee_id = $1 AND effective_from = $2::date`, [employee_id, effective_from]);
    if (clash.length) throw new ProposalError(409, `A salary revision already exists on ${effective_from}; existing revisions are never overwritten — choose another date`);
    const c = await computeCtc({ company_id, structure_id, employee_id, effective_from, annual_ctc, basic_monthly, client });
    let row;
    try {
      ({ rows: [row] } = await client.query(
        `INSERT INTO salary_revision_proposals
           (company_id, employee_id, structure_id, effective_from, entry_mode, requested_annual_ctc, basic_monthly,
            annual_ctc, rounding_residual, breakdown, ctc_policy_version, rules_as_of, source_type, source_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$4,$12,$13,$14) RETURNING *`,
        [company_id, employee_id, c.structure.id, effective_from, c.entry_mode, c.requested_annual_ctc, c.basic_monthly,
         c.breakdown.annual.ctc, c.rounding_residual, JSON.stringify(c.breakdown), c.policy.version,
         source_type, source_id == null ? null : String(source_id), userId]));
    } catch (e) {
      if (e.code === '23505') throw new ProposalError(409, `This ${source_type} already has a salary proposal`);
      throw e;
    }
    if (!given) await client.query('COMMIT');
    logAudit({ userId, module: 'payroll', recordId: row.id, recordType: 'salary_revision_proposal', action: 'create', newData: { ...row, breakdown: undefined }, req });
    return { proposal: row, preview: c };
  } catch (e) {
    if (!given) await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (!given) client.release();
  }
}

export async function approveProposal({ company_id, id, userId, note = null, req = null }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireCtcMode(client, company_id);
    const { rows: [p] } = await client.query(
      `SELECT * FROM salary_revision_proposals WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, company_id]);
    if (!p) throw new ProposalError(404, 'Proposal not found');
    if (p.status !== 'draft') throw new ProposalError(409, `Proposal is already ${p.status}`);
    const eff = iso(p.effective_from);
    // Recompute with today's policy and rules for that date; refuse if anything moved.
    const c = await computeCtc({ company_id, structure_id: p.structure_id, employee_id: p.employee_id, effective_from: eff,
      ...(p.entry_mode === 'annual_ctc' ? { annual_ctc: Number(p.requested_annual_ctc) } : { basic_monthly: Number(p.basic_monthly) }), client });
    if (c.policy.maker_checker && userId != null && Number(userId) === Number(p.created_by)) {
      throw new ProposalError(403, 'Maker-checker: the person who prepared this proposal cannot approve it');
    }
    if (!c.finalisable) throw new ProposalError(422, 'This CTC cannot be finalised yet', { blockers: c.blockers });
    // Components too: a structure edit can move money between HRA and Special
    // with the totals unchanged — the employee would be paid a split nobody approved.
    const split = (b) => JSON.stringify((b?.monthly?.components || []).map(x => [x.name, Number(x.amount)]));
    if (c.basic_monthly !== Number(p.basic_monthly) || c.breakdown.annual.ctc !== Number(p.annual_ctc)
        || split(c.breakdown) !== split(p.breakdown)) {
      throw new ProposalError(409, 'The figures changed since this proposal was prepared (policy, rules or structure). Reject it and prepare a new one.',
        { was: { basic_monthly: Number(p.basic_monthly), annual_ctc: Number(p.annual_ctc) }, now: { basic_monthly: c.basic_monthly, annual_ctc: c.breakdown.annual.ctc } });
    }
    await assertMonthOpen(client, p.employee_id, eff);
    let a;
    try {
      ({ rows: [a] } = await client.query(
        `INSERT INTO employee_salary_assignments
           (employee_id, structure_id, effective_from, basic_salary, special_allowance, other_components,
            company_id, entry_mode, annual_ctc, ctc_policy_version, breakdown, proposal_id)
         VALUES ($1,$2,$3,$4,0,'{}'::jsonb,$5,$6,$7,$8,$9::jsonb,$10) RETURNING id`,
        // The revision records what was APPROVED: priced under the policy and
        // rules recorded at approval, not the draft's (possibly built-in) ones.
        [p.employee_id, p.structure_id, eff, p.basic_monthly, company_id, p.entry_mode, p.annual_ctc,
         c.policy.version, JSON.stringify(c.breakdown), p.id]));
    } catch (e) {
      if (e.code === '23505') throw new ProposalError(409, `A salary revision already exists on ${eff}; it is not overwritten`);
      throw e;
    }
    await client.query(
      `UPDATE salary_revision_proposals SET status = 'approved', decided_by = $2, decided_at = NOW(), decision_note = $3, assignment_id = $4 WHERE id = $1`,
      [p.id, userId, note, a.id]);
    // The master mirrors the revision in force TODAY; a future revision waits.
    await client.query(
      `UPDATE employees e SET basic_salary = x.basic_salary
         FROM (SELECT basic_salary FROM employee_salary_assignments
                WHERE employee_id = $1 AND effective_from <= CURRENT_DATE
                ORDER BY effective_from DESC, created_at DESC LIMIT 1) x
        WHERE e.id = $1 AND e.company_id = $2`, [p.employee_id, company_id]);
    if (p.source_type === 'increment') {
      await client.query(
        `UPDATE increment_recommendations SET payroll_synced = TRUE, payroll_synced_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND company_id = $2`, [Number(p.source_id), company_id]);
    }
    // "Today" is the database's date — the same CURRENT_DATE the master update
    // above used (the UTC date is still yesterday from 00:00 to 05:30 IST).
    const { rows: [t] } = await client.query('SELECT $1::date <= CURRENT_DATE AS in_force', [eff]);
    await client.query('COMMIT');
    logAudit({ userId, module: 'payroll', recordId: p.id, recordType: 'salary_revision_proposal', action: 'approve',
      newData: { assignment_id: a.id, employee_id: p.employee_id, effective_from: eff, annual_ctc: Number(p.annual_ctc), basic_monthly: Number(p.basic_monthly) }, req });
    return { assignment_id: a.id, effective_from: eff, in_force_today: t.in_force };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function rejectProposal({ company_id, id, userId, note = null, req = null }) {
  const { rows } = await pool.query(
    `UPDATE salary_revision_proposals SET status = 'rejected', decided_by = $3, decided_at = NOW(), decision_note = $4
      WHERE id = $1 AND company_id = $2 AND status = 'draft' RETURNING id`, [id, company_id, userId, note]);
  if (!rows.length) throw new ProposalError(404, 'Draft proposal not found');
  logAudit({ userId, module: 'payroll', recordId: id, recordType: 'salary_revision_proposal', action: 'reject', newData: { note }, req });
  return { id: rows[0].id, status: 'rejected' };
}

export async function listProposals({ company_id, status = null }) {
  const params = [company_id];
  let q = `SELECT p.*, e.office_id AS employee_code,
                  TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name,
                  s.name AS structure_name
             FROM salary_revision_proposals p
             JOIN employees e ON e.id = p.employee_id
             LEFT JOIN salary_structures s ON s.id = p.structure_id
            WHERE p.company_id = $1`;
  if (status) { params.push(status); q += ` AND p.status = $2`; }
  q += ' ORDER BY p.created_at DESC LIMIT 200';
  return (await pool.query(q, params)).rows;
}

/** Annual CTC of the revision in force on a date (stored, or computed for a legacy Basic revision). */
export async function currentAnnualCtc({ company_id, employee_id, on_date, client = pool }) {
  const { rows: [r] } = await client.query(
    `SELECT a.basic_salary, a.annual_ctc, a.structure_id, a.effective_from
       FROM employee_salary_assignments a JOIN employees e ON e.id = a.employee_id
      WHERE a.employee_id = $1 AND e.company_id = $2 AND a.effective_from <= $3::date
      ORDER BY a.effective_from DESC, a.created_at DESC LIMIT 1`, [employee_id, company_id, on_date]);
  if (!r) return null;
  if (r.annual_ctc != null) return { annual_ctc: Number(r.annual_ctc), basis: 'stored', effective_from: iso(r.effective_from) };
  try {
    const c = await computeCtc({ company_id, structure_id: r.structure_id, employee_id, effective_from: iso(r.effective_from), basic_monthly: Number(r.basic_salary), client });
    return { annual_ctc: c.breakdown.annual.ctc, basis: 'computed_from_basic', effective_from: iso(r.effective_from) };
  } catch (e) {
    if (!(e instanceof ProposalError)) throw e;
    // e.g. a legacy Basic that looks annual (EMP038) — say so, never guess
    return { annual_ctc: null, basis: 'unavailable', reason: e.message, effective_from: iso(r.effective_from) };
  }
}
