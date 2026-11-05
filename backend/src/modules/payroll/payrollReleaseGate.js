/**
 * payrollReleaseGate.js — what must be true before a payroll period can be
 * APPROVED (and therefore paid, emailed or reported).
 *
 * Generating or previewing a DRAFT is never gated: HR must be able to see the
 * figures in order to fix what blocks them. The gate sits on approval, and
 * approval is the precondition for payment, email, Form 138 and Form 130.
 *
 * Blockers (each with a code the UI can show):
 *   SETTINGS_CYCLE      pay cycle invalid (cutoff on/after pay day, …)
 *   SETTINGS_CONFLICT   Payroll Settings and Setup Wizard disagree
 *   RULE_UNVERIFIED     a statutory rule in force for the period has not been
 *                       checked against a primary source
 *   RULE_DECISION       a statutory rule leaves a choice the company has not made
 *   JURISDICTION_UNCONFIRMED / JURISDICTION_MISMATCH / PT_LOCAL_BODY — the
 *                       statutory state (and TN PT local body) is not recorded,
 *                       or an employee resolves to another state
 *   RULE_MID_PERIOD     a rule changed INSIDE the wage month (e.g. PF ceiling on
 *                       17-Sep-2026) and the company has not recorded how that
 *                       month is to be treated
 * A rule blocker is cleared by an authorised user recording a company version
 * of the rule (POST /payroll/statutory-rules) with its source — see
 * statutoryRules.js. Employee-level data blockers (bank, PAN) are checked by
 * approvePayroll() itself against the employee records at approval time.
 */
import pool from '../shared/db.js';
import { loadRuleRows, resolveRules, versionsOf, RULE_KEYS, panchayatPtProblems } from './statutoryRules.js';
import { stateFromGstin } from '../../shared/gstinStates.js';
import { normalizePayrollSettings, validatePayCycle } from './payrollSettings.js';
import { periodStartDate, periodEndDate, getMonthName, normalizeState } from './payrollEngine.js';

const TN_ULB_TYPES = ['municipal_corporation', 'municipality', 'town_panchayat'];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function releaseReadiness({ company_id, month, year, client = pool }) {
  const m = parseInt(month), y = parseInt(year);
  const start = periodStartDate(m, y), end = periodEndDate(m, y);
  const blockers = [];

  const { rows: [st] } = await client.query(
    `SELECT settings FROM company_settings WHERE company_id = $1 AND module = 'payroll' LIMIT 1`, [company_id ?? 0]);
  const { settings, conflicts } = normalizePayrollSettings(st?.settings || {});
  for (const e of validatePayCycle(settings)) blockers.push({ code: 'SETTINGS_CYCLE', message: e });
  if (conflicts.length) {
    blockers.push({ code: 'SETTINGS_CONFLICT', keys: conflicts.map(c => c.key),
      message: `Payroll Settings and the Setup Wizard hold different values for: ${conflicts.map(c => c.key).join(', ')}. Save Payroll Settings once with the intended values.` });
  }

  // ── Statutory jurisdiction (Part 7). PT and LWF follow the state each employee
  // resolves to (branch, else company). Approval needs the company to have
  // recorded which state applies, every employee in the run to resolve to it,
  // and — in Tamil Nadu, where PT is levied by the local body — an urban local
  // body (the verified ULB Rules 2023 table) rather than a village panchayat.
  const juris = normalizeState(settings.statutory_state);
  // The Setup Wizard's legacy professional-tax state (company_settings.payroll
  // .pt.state). The engine never reads it; it is evidence an administrator
  // must reconcile — never copied into the jurisdiction automatically.
  const wizardPtState = st?.settings?.pt?.state || null;
  const { rows: [company] } = await client.query('SELECT state, gstin FROM companies WHERE id = $1', [company_id ?? 0]);
  // Rules in force at period end — also used for the TN local-body checks below.
  const rows = await loadRuleRows(client, company_id);
  const { values, applied } = resolveRules(end, rows);

  // The company's state must be the state its GSTIN is registered in (the rule
  // Company Profile enforces on save; data written another way is caught here).
  const gstState = stateFromGstin(company?.gstin);
  const sameState = (a, b) => (normalizeState(a) && normalizeState(b)
    ? normalizeState(a) === normalizeState(b)
    : String(a).trim().toLowerCase() === String(b).trim().toLowerCase());
  if (gstState && company?.state && !sameState(gstState, company.state)) {
    blockers.push({ code: 'COMPANY_GSTIN_STATE', company_state: company.state, gstin_state: gstState,
      message: `The company record says "${company.state}" but its GSTIN (code ${String(company.gstin).slice(0, 2)}) is registered in ${gstState}. Correct the GSTIN or the state in Settings → Company Profile.` });
  }
  const FIX = 'Fix in: Settings → Company Profile → State (with a GSTIN of that state), Settings → Branches → State, Payroll Settings → Statutory jurisdiction.';
  if (!juris) {
    blockers.push({ code: 'JURISDICTION_UNCONFIRMED', company_state: company?.state ?? null, wizard_pt_state: wizardPtState,
      message: `Payroll Settings → Statutory jurisdiction is not recorded. Record the state whose PT/LWF rules apply (and, in Tamil Nadu, the PT local body) before approving. ` +
        `Currently: company record "${company?.state || 'not set'}"${wizardPtState ? `, Setup Wizard PT state "${wizardPtState}"` : ''}. ${FIX}` });
  } else {
    if (wizardPtState && normalizeState(wizardPtState) && normalizeState(wizardPtState) !== juris) {
      blockers.push({ code: 'JURISDICTION_CONFLICT', value: settings.statutory_state, wizard_pt_state: wizardPtState,
        message: `Payroll Settings → Statutory jurisdiction says "${settings.statutory_state}" but the Setup Wizard's professional-tax state says "${wizardPtState}". Re-save one of them so both agree. ${FIX}` });
    }
    const { rows: emps } = await client.query(
      `SELECT DISTINCT e.office_id, COALESCE(b.state, c.state) AS state
         FROM payroll_runs pr
         JOIN employees e ON e.id = pr.employee_id
         JOIN companies c ON c.id = e.company_id
         LEFT JOIN branches b ON b.id = e.branch_id
        WHERE e.company_id = $1 AND pr.month = $2 AND pr.year = $3`, [company_id ?? 0, m, y]);
    const engineState = (e) => normalizeState(settings.state) || normalizeState(e.state);
    const off = emps.filter(e => engineState(e) !== juris);
    if (off.length) {
      blockers.push({ code: 'JURISDICTION_MISMATCH', count: off.length, employees: off.slice(0, 10).map(e => ({ office_id: e.office_id, state: e.state })),
        message: `${off.length} employee(s) in this payroll resolve to a state other than ${settings.statutory_state} (from their branch, else the company record) — ` +
          `e.g. ${off.slice(0, 3).map(e => `${e.office_id}: ${e.state || 'no state'}`).join(', ')}. Correct the company/branch state before approving. ${FIX}` });
    }
    if (juris === 'TN') {
      // Tamil Nadu PT is levied by the local body. Urban bodies use the ULB
      // Rules 2023 table; a village panchayat publishes its own rates, which
      // Pulse holds only when the company records them — never the urban table.
      const local = settings.pt_local_body;
      const tnEntry = values['pt.slabs']?.TN;
      const fromCompany = applied['pt.slabs']?.origin === 'company';
      if (local === 'village_panchayat') {
        const problems = !fromCompany
          ? ['no company pt.slabs version is recorded — the built-in table is the URBAN one and is never used for a panchayat']
          : panchayatPtProblems(tnEntry, settings.pt_local_body_name);
        if (!String(settings.pt_local_body_name || '').trim()) problems.unshift('Payroll Settings → PT local body name is empty');
        if (problems.length) {
          blockers.push({ code: 'PT_LOCAL_BODY', value: local, problems,
            message: `Village panchayat PT is not configured: ${problems.join('; ')}. Record the panchayat's published half-yearly table as a company pt.slabs version (TN = { basis: 'half_year', deduct_months: [...], slabs: [...], local_body: 'village_panchayat', local_body_name: '<as in Payroll Settings>' }) via POST /payroll/statutory-rules, with the panchayat's notice as the source reference.` });
        }
      } else if (!TN_ULB_TYPES.includes(local)) {
        blockers.push({ code: 'PT_LOCAL_BODY', value: local,
          message: 'Tamil Nadu PT is levied by the local body. Record the PT local body type (municipal corporation, municipality, town panchayat or village panchayat) and name in Payroll Settings, and confirm with it that the Rules 2023 table has not been revised.' });
      } else if (tnEntry?.local_body === 'village_panchayat') {
        blockers.push({ code: 'PT_LOCAL_BODY', value: local,
          message: `The recorded Tamil Nadu PT table is declared for a village panchayat ("${tnEntry.local_body_name || ''}") but Payroll Settings says "${local}". Record the correct table or local body.` });
      }
    }
  }

  for (const key of RULE_KEYS) {
    const a = applied[key];
    if (a.status === 'decision_required') {
      blockers.push({ code: 'RULE_DECISION', key, effective_from: a.effective_from, value: values[key], options: a.options,
        message: `${key}: a company decision is required (${(a.options || []).join(' / ')}; current default "${values[key]}"). ${a.evidence || ''}` });
    } else if (a.status !== 'verified') {
      blockers.push({ code: 'RULE_UNVERIFIED', key, effective_from: a.effective_from, value: values[key],
        message: `${key} (in force from ${a.effective_from}) is not verified against a primary source. ${a.evidence || ''}` });
    }
    // A version that took effect AFTER the first day of the wage month means
    // the month straddles two rules. The engine applies the version in force
    // on the last day to the whole month; the company must confirm that is
    // its treatment by recording a version dated the first day of the month.
    const mid = versionsOf(key, rows).find(v => v.effective_from > start && v.effective_from <= end && same(v.value, values[key]));
    if (mid && a.effective_from > start) {
      const ack = rows.some(r => r.rule_key === key && String(r.effective_from instanceof Date ? r.effective_from.toISOString() : r.effective_from).slice(0, 10) === start && same(r.value, values[key]));
      if (!ack) {
        blockers.push({ code: 'RULE_MID_PERIOD', key, changed_on: mid.effective_from, value: values[key],
          message: `${key} changed on ${mid.effective_from}, inside ${getMonthName(m)} ${y}. The payroll applies ${JSON.stringify(values[key])} to the whole month. ` +
            `No primary source sets a part-month rule; record the company's treatment (a version of ${key} effective ${start} with the decision reference) before approving. A part-month split is not implemented.` });
      }
    }
  }
  return { period: `${getMonthName(m)} ${y}`, month: m, year: y, ready: blockers.length === 0, blockers };
}
