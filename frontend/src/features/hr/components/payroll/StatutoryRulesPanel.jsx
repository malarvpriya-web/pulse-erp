import { useCallback, useEffect, useState } from 'react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import FoldSection, { FoldAllButton, useFolds } from '@/components/shared/FoldSection';

const GROUPS = [
  { title: 'Provident Fund', rules: {
    'pf.employee_rate': { label: 'Employee contribution (%)', kind: 'number' },
    'pf.employer_rate': { label: 'Employer contribution (%)', kind: 'number' },
    'pf.eps_rate': { label: 'Pension share of employer contribution (%)', kind: 'number' },
    'pf.wage_ceiling': { label: 'Wage ceiling (₹ per month)', kind: 'number' },
    'pf.wage_floor_pct': { label: 'Minimum wages share (%)', kind: 'number', nullable: true },
    'pf.wage_floor_basis': { label: 'What the minimum wages share is measured on', kind: 'option' },
    'pf.eps_age_limit': { label: 'Pension contribution stops at age', kind: 'number' },
    'pf.edli_rate': { label: 'EDLI insurance, employer (% of wages up to the ceiling)', kind: 'number', setting: true },
    'pf.admin_rate': { label: 'EPF administration charge, employer (% of PF wages)', kind: 'number', setting: true },
    'pf.admin_min_monthly': { label: 'EPF administration minimum per month (₹)', kind: 'number', setting: true },
  } },
  { title: 'Minimum wage', rules: {
    'wages.minimum_monthly': { label: 'Lowest full-month pay for your scheduled employment (₹; blank = not checked)', kind: 'number', nullable: true, setting: true },
  } },
  { title: 'ESI', rules: {
    'esi.wage_threshold': { label: 'Coverage limit (₹ per month)', kind: 'number' },
    'esi.wage_basis': { label: 'Wage used for coverage and contribution', kind: 'option' },
    'esi.employee_rate': { label: 'Employee contribution (%)', kind: 'number' },
    'esi.employer_rate': { label: 'Employer contribution (%)', kind: 'number' },
  } },
  { title: 'Income tax', rules: {
    'tax.new': { label: 'New regime', kind: 'tax' },
    'tax.old': { label: 'Old regime', kind: 'tax' },
  } },
  { title: 'Perquisites', rules: {
    'perq.loan': { label: 'Loans below the SBI rate (taxable perquisite)', kind: 'perqLoan' },
  } },
  { title: 'Overtime', rules: {
    'ot.max_multiplier': { label: 'Highest overtime multiple of the ordinary rate', kind: 'number' },
  } },
  { title: 'Bonus', rules: {
    'bonus.plans': { label: 'Bonus plans', kind: 'plans', setting: true },
    'bonus.statutory': { label: 'Statutory bonus report', kind: 'bonusStatutory', setting: true },
  } },
  { title: 'Sales incentive', rules: {
    'incentive.sales': { label: 'Yearly sales incentive slabs', kind: 'incentive', setting: true },
  } },
  { title: 'State levies', rules: {
    'pt.slabs': { label: 'Professional tax', kind: 'pt' },
    'lwf.rates': { label: 'Labour welfare fund', kind: 'lwf' },
  } },
];
const OPTION_LABELS = {
  gross_excl_employer_contributions: 'Leave employer PF and statutory bonus out',
  include_employer_pf_and_statutory_bonus: 'Include employer PF and statutory bonus',
  gross: 'Gross pay',
  code_wages: 'Code wages',
};
const STATUS = {
  verified: { label: 'Verified', bg: 'var(--color-success-bg)', fg: 'var(--color-success)' },
  // A version someone recorded with a note that it is not confirmed (e.g. PT and
  // LWF on 5 Nov 2026) — it is in force, but it is not a confirmation.
  recorded_unconfirmed: { label: 'Recorded — NOT confirmed', bg: 'var(--color-danger-bg, #fee2e2)', fg: 'var(--color-danger, #b91c1c)' },
  recorded_no_source: { label: 'Recorded — no source given', bg: 'var(--color-warning-bg)', fg: 'var(--color-warning)' },
  unverified: { label: 'Not verified', bg: 'var(--color-warning-bg)', fg: 'var(--color-warning)' },
  decision_required: { label: 'Your decision', bg: 'var(--color-warning-bg)', fg: 'var(--color-warning)' },
};
const SETTING = { label: 'Company setting', bg: 'var(--color-info-bg)', fg: 'var(--color-info)' };
const PLAN_TYPES = { fixed: 'Fixed amount (₹)', pct_basic: '% of Basic', pct_gross: '% of gross' };
const SLAB_TYPES = { pct_salary: "% of the year's salary", pct_sales: '% of sales achieved', fixed: 'Fixed amount (₹)' };
const BLANK_SLAB = { from_pct: '', to_pct: '', type: 'pct_salary', amount: '' };
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const BLANK_PLAN ={ name: '', type: 'fixed', amount: '', months: '', active: true, prorate_on_exit: true, min_service_months: '0', counts_as_statutory: true };
/** A company setting starts at this month, not at the built-in's old date. */
const firstOfThisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; };
const inputStyle = { display: 'block', width: '100%', padding: 6, marginTop: 4, fontSize: 13 };
const foldBox = { marginBottom: 12, border: '1px solid var(--color-border, #e5e7eb)', borderRadius: 12, padding: '8px 16px', background: 'var(--color-bg-card, #fff)' };
const cellInput = { width: '100%', padding: 4, fontSize: 13 };

const text = (v) => (v === null || v === undefined ? '' : String(v));
const toNumber = (s) => (String(s).trim() === '' ? NaN : Number(s));
const toMonths = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean).map(Number);
// 0.05 × 100 is 5.000000000000001 in floating point.
const pctOf = (fraction) => Number((fraction * 100).toFixed(4));

/** A rule's stored value → what the inputs hold. PT and LWF edit one state's entry only. */
function toDraft(kind, value, state) {
  if (kind === 'number' || kind === 'option') return { value: text(value) };
  if (kind === 'bonusStatutory') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, text(v)]));
  if (kind === 'plans') return { plans: value.plans.map((p) => ({ ...p, amount: text(p.amount), months: p.months.join(', '), prorate_on_exit: p.prorate_on_exit !== false, counts_as_statutory: p.counts_as_statutory !== false, min_service_months: text(p.min_service_months ?? 0) })) };
  if (kind === 'incentive') {
    return {
      salary_basis: value?.salary_basis ?? 'basic', pay_month: text(value?.pay_month ?? 4),
      slabs: (value?.slabs ?? []).map((sl) => ({ from_pct: text(sl.from_pct), to_pct: text(sl.to_pct), type: sl.type, amount: text(sl.amount) })),
    };
  }
  if (kind === 'perqLoan') return { exempt_limit: text(value?.exempt_limit), loan: text(value?.sbi_rates?.loan), advance: text(value?.sbi_rates?.advance) };
  if (kind === 'tax') {
    return {
      standard_deduction: text(value.standard_deduction), rebate_limit: text(value.rebate_limit), rebate_max: text(value.rebate_max),
      cess_pct: text(value.cess_pct), marginal_relief: Boolean(value.marginal_relief),
      slabs: value.slabs.map((s) => ({ upto: text(s.max), rate: text(pctOf(s.rate)) })),
    };
  }
  const entry = value?.[state];
  if (kind === 'lwf') return { employee: text(entry?.employee), employer: text(entry?.employer), months: (entry?.months ?? []).join(', ') };
  const slabs = Array.isArray(entry) ? entry : entry?.slabs ?? [];
  return {
    deduct_months: Array.isArray(entry) || !entry ? null : (entry.deduct_months ?? []).join(', '),
    // Keep what the inputs do not show, such as a different rate for one month.
    slabs: slabs.map(({ min: _min, max, pt, ...rest }) => ({ upto: text(max), pt: text(pt), rest })),
  };
}

/** What the inputs hold → the rule's stored value, with other states untouched. */
function toValue(kind, draft, value, state, nullable) {
  if (kind === 'option') return draft.value;
  if (kind === 'number') return nullable && draft.value.trim() === '' ? null : toNumber(draft.value);
  if (kind === 'bonusStatutory') return Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, toNumber(v)]));
  if (kind === 'plans') {
    return { plans: draft.plans.map((p) => ({ name: p.name.trim(), type: p.type, amount: toNumber(p.amount), months: toMonths(p.months), active: p.active, prorate_on_exit: p.prorate_on_exit !== false, counts_as_statutory: p.counts_as_statutory !== false, min_service_months: Math.max(0, parseInt(p.min_service_months, 10) || 0) })) };
  }
  if (kind === 'incentive') {
    return {
      salary_basis: draft.salary_basis, pay_month: parseInt(draft.pay_month, 10),
      slabs: draft.slabs.map((sl) => ({ from_pct: toNumber(sl.from_pct), to_pct: String(sl.to_pct).trim() === '' ? null : toNumber(sl.to_pct), type: sl.type, amount: toNumber(sl.amount) })),
    };
  }
  const open = (d, i, all) => (i === all.length - 1 ? null : toNumber(d.upto));
  if (kind === 'perqLoan') {
    const rate = (s) => (String(s).trim() === '' ? null : toNumber(s));
    return { exempt_limit: toNumber(draft.exempt_limit), sbi_rates: { loan: rate(draft.loan), advance: rate(draft.advance) } };
  }
  if (kind === 'tax') {
    // Keep what the inputs do not show (surcharge bands, the senior-citizen slabs):
    // saving the slabs must never drop them.
    return {
      ...value,
      slabs: draft.slabs.map((d, i, all) => ({ min: i === 0 ? 0 : toNumber(all[i - 1].upto), max: open(d, i, all), rate: toNumber(d.rate) / 100 })),
      standard_deduction: toNumber(draft.standard_deduction), rebate_limit: toNumber(draft.rebate_limit), rebate_max: toNumber(draft.rebate_max),
      marginal_relief: draft.marginal_relief, cess_pct: toNumber(draft.cess_pct),
    };
  }
  if (kind === 'lwf') {
    return { ...value, [state]: { employee: toNumber(draft.employee), employer: toNumber(draft.employer), months: toMonths(draft.months) } };
  }
  const slabs = draft.slabs.map((d, i, all) => ({ min: i === 0 ? 0 : toNumber(all[i - 1].upto) + 1, max: open(d, i, all), pt: toNumber(d.pt), ...d.rest }));
  const entry = value?.[state];
  return { ...value, [state]: draft.deduct_months === null ? slabs : { ...entry, deduct_months: toMonths(draft.deduct_months), slabs } };
}

function Bands({ draft, setDraft, amountKey, amountLabel, disabled }) {
  const setBand = (i, patch) => setDraft((d) => ({ ...d, slabs: d.slabs.map((s, n) => (n === i ? { ...s, ...patch } : s)) }));
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
      <thead>
        <tr style={{ textAlign: 'left' }}>
          <th style={{ padding: 4 }}>Up to (₹)</th><th style={{ padding: 4 }}>{amountLabel}</th><th />
        </tr>
      </thead>
      <tbody>
        {draft.slabs.map((s, i) => {
          const last = i === draft.slabs.length - 1;
          return (
            <tr key={i}>
              <td style={{ padding: 4 }}>
                {last ? 'Above' : <input aria-label={`Band ${i + 1} up to`} type="number" value={s.upto} disabled={disabled} onChange={(e) => setBand(i, { upto: e.target.value })} style={cellInput} />}
              </td>
              <td style={{ padding: 4 }}>
                <input aria-label={`Band ${i + 1} ${amountLabel}`} type="number" value={s[amountKey]} disabled={disabled} onChange={(e) => setBand(i, { [amountKey]: e.target.value })} style={cellInput} />
              </td>
              <td style={{ padding: 4, width: 90 }}>
                {!disabled && draft.slabs.length > 1 && (
                  <button type="button" className="pulse-btn-secondary" onClick={() => setDraft((d) => ({ ...d, slabs: d.slabs.filter((_, n) => n !== i) }))}>Remove</button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
      {!disabled && (
        <tfoot>
          <tr><td colSpan={3} style={{ padding: 4 }}>
            <button type="button" className="pulse-btn-secondary" onClick={() => setDraft((d) => {
              // The new band goes before the open-ended last one.
              const at = d.slabs.length - 1;
              return { ...d, slabs: [...d.slabs.slice(0, at), { upto: '', [amountKey]: '', rest: {} }, d.slabs[at]] };
            })}>Add band</button>
          </td></tr>
        </tfoot>
      )}
    </table>
  );
}

function BonusPlans({ draft, setDraft, disabled }) {
  const setPlan = (i, patch) => setDraft((d) => ({ plans: d.plans.map((p, n) => (n === i ? { ...p, ...patch } : p)) }));
  return (
    <>
      {draft.plans.length === 0 && <div style={{ fontSize: 13, marginBottom: 8 }}>No bonus plans yet. Add one to pay it through monthly payroll.</div>}
      {draft.plans.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left' }}>
              <th style={{ padding: 4 }}>Plan name</th><th style={{ padding: 4 }}>Type</th><th style={{ padding: 4 }}>Amount or %</th>
              <th style={{ padding: 4 }}>Pay months, 1 to 12</th><th style={{ padding: 4 }}>Active</th>
              <th style={{ padding: 4 }} title="Someone who leaves before the pay month gets a share in the final settlement">Share on leaving</th>
              <th style={{ padding: 4 }}>Min. service (months)</th>
              <th style={{ padding: 4 }} title="Counted towards the statutory bonus, so the two are not paid twice">Counts as statutory bonus</th><th />
            </tr>
          </thead>
          <tbody>
            {draft.plans.map((p, i) => (
              <tr key={i}>
                <td style={{ padding: 4 }}><input aria-label={`Plan ${i + 1} name`} type="text" value={p.name} disabled={disabled} onChange={(e) => setPlan(i, { name: e.target.value })} style={cellInput} /></td>
                <td style={{ padding: 4 }}>
                  <select aria-label={`Plan ${i + 1} type`} value={p.type} disabled={disabled} onChange={(e) => setPlan(i, { type: e.target.value })} style={cellInput}>
                    {Object.entries(PLAN_TYPES).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </select>
                </td>
                <td style={{ padding: 4 }}><input aria-label={`Plan ${i + 1} amount`} type="number" value={p.amount} disabled={disabled} onChange={(e) => setPlan(i, { amount: e.target.value })} style={cellInput} /></td>
                <td style={{ padding: 4 }}><input aria-label={`Plan ${i + 1} months`} type="text" value={p.months} disabled={disabled} onChange={(e) => setPlan(i, { months: e.target.value })} style={cellInput} /></td>
                <td style={{ padding: 4 }}>
                  <select aria-label={`Plan ${i + 1} active`} value={String(p.active)} disabled={disabled} onChange={(e) => setPlan(i, { active: e.target.value === 'true' })} style={cellInput}>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                </td>
                <td style={{ padding: 4 }}>
                  <select aria-label={`Plan ${i + 1} share on leaving`} value={String(p.prorate_on_exit !== false)} disabled={disabled} onChange={(e) => setPlan(i, { prorate_on_exit: e.target.value === 'true' })} style={cellInput}>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                </td>
                <td style={{ padding: 4 }}><input aria-label={`Plan ${i + 1} minimum service`} type="number" min="0" step="1" value={p.min_service_months ?? '0'} disabled={disabled} onChange={(e) => setPlan(i, { min_service_months: e.target.value })} style={cellInput} /></td>
                <td style={{ padding: 4 }}>
                  <select aria-label={`Plan ${i + 1} counts as statutory`} value={String(p.counts_as_statutory !== false)} disabled={disabled} onChange={(e) => setPlan(i, { counts_as_statutory: e.target.value === 'true' })} style={cellInput}>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                </td>
                <td style={{ padding: 4, width: 90 }}>
                  {!disabled && <button type="button" className="pulse-btn-secondary" onClick={() => setDraft((d) => ({ plans: d.plans.filter((_, n) => n !== i) }))}>Remove</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!disabled && <button type="button" className="pulse-btn-secondary" style={{ marginTop: 8 }} onClick={() => setDraft((d) => ({ plans: [...d.plans, { ...BLANK_PLAN }] }))}>Add plan</button>}
    </>
  );
}

/** Yearly sales incentive: achievement % slabs. One slab applies to the whole year. */
function IncentiveSlabs({ draft, setDraft, disabled }) {
  const setSlab = (i, patch) => setDraft((d) => ({ ...d, slabs: d.slabs.map((sl, n) => (n === i ? { ...sl, ...patch } : sl)) }));
  return (
    <>
      <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>
        Each salesperson&apos;s yearly target is set in Sales → Targets. After 31 March, the share of the target they achieved picks one slab.
        From % is included, To % is not (blank = no upper limit). Example: 0 to 80 pays 0; 80 to 100 pays 5% of salary; 100 and above pays 10%.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, fontSize: 13, marginBottom: 8 }}>
        <label>Salary used for &quot;% of salary&quot;
          <select aria-label="Salary basis" value={draft.salary_basis} disabled={disabled} onChange={(e) => setDraft((d) => ({ ...d, salary_basis: e.target.value }))} style={inputStyle}>
            <option value="basic">Basic × 12</option>
            <option value="gross">Monthly gross × 12</option>
          </select>
        </label>
        <label>Paid in the payroll of
          <select aria-label="Pay month" value={draft.pay_month} disabled={disabled} onChange={(e) => setDraft((d) => ({ ...d, pay_month: e.target.value }))} style={inputStyle}>
            {MONTH_NAMES.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
          </select>
        </label>
      </div>
      {draft.slabs.length === 0 && <div style={{ fontSize: 13, marginBottom: 8 }}>No slabs yet, so no incentive is paid. Add one.</div>}
      {draft.slabs.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left' }}>
              <th style={{ padding: 4 }}>From % of target</th><th style={{ padding: 4 }}>To %</th><th style={{ padding: 4 }}>Pays</th><th style={{ padding: 4 }}>Amount or %</th><th />
            </tr>
          </thead>
          <tbody>
            {draft.slabs.map((sl, i) => (
              <tr key={i}>
                <td style={{ padding: 4 }}><input aria-label={`Slab ${i + 1} from`} type="number" min="0" value={sl.from_pct} disabled={disabled} onChange={(e) => setSlab(i, { from_pct: e.target.value })} style={cellInput} /></td>
                <td style={{ padding: 4 }}><input aria-label={`Slab ${i + 1} to`} type="number" min="0" value={sl.to_pct} placeholder="no limit" disabled={disabled} onChange={(e) => setSlab(i, { to_pct: e.target.value })} style={cellInput} /></td>
                <td style={{ padding: 4 }}>
                  <select aria-label={`Slab ${i + 1} type`} value={sl.type} disabled={disabled} onChange={(e) => setSlab(i, { type: e.target.value })} style={cellInput}>
                    {Object.entries(SLAB_TYPES).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </select>
                </td>
                <td style={{ padding: 4 }}><input aria-label={`Slab ${i + 1} amount`} type="number" min="0" value={sl.amount} disabled={disabled} onChange={(e) => setSlab(i, { amount: e.target.value })} style={cellInput} /></td>
                <td style={{ padding: 4, width: 90 }}>
                  {!disabled && <button type="button" className="pulse-btn-secondary" onClick={() => setDraft((d) => ({ ...d, slabs: d.slabs.filter((_, n) => n !== i) }))}>Remove</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!disabled && <button type="button" className="pulse-btn-secondary" style={{ marginTop: 8 }} onClick={() => setDraft((d) => ({ ...d, slabs: [...d.slabs, { ...BLANK_SLAB }] }))}>Add slab</button>}
    </>
  );
}

function ValueInputs({ meta, options, draft, setDraft, disabled }) {
  const field = (key, label, extra = {}) => (
    <label>{label}
      <input type={extra.type ?? 'number'} value={draft[key]} disabled={disabled} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} style={inputStyle} />
    </label>
  );
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, fontSize: 13 };
  if (meta.kind === 'option') {
    return (
      <label style={{ fontSize: 13 }}>{meta.label}
        <select value={draft.value} disabled={disabled} onChange={(e) => setDraft({ value: e.target.value })} style={inputStyle}>
          {(options ?? []).map((o) => <option key={o} value={o}>{OPTION_LABELS[o] ?? o}</option>)}
        </select>
      </label>
    );
  }
  if (meta.kind === 'plans') return <BonusPlans draft={draft} setDraft={setDraft} disabled={disabled} />;
  if (meta.kind === 'incentive') return <IncentiveSlabs draft={draft} setDraft={setDraft} disabled={disabled} />;
  if (meta.kind === 'bonusStatutory') {
    return (
      <div style={grid}>
        {field('wage_eligibility', 'Eligible up to wage (₹ per month)')}
        {field('calc_ceiling', 'Wage used for calculation, at most (₹ per month)')}
        {field('min_pct', 'Minimum bonus (%)')}
        {field('max_pct', 'Maximum bonus (%)')}
      </div>
    );
  }
  if (meta.kind === 'number') return <div style={{ fontSize: 13 }}>{field('value', meta.nullable ? `${meta.label} (empty = none)` : meta.label)}</div>;
  if (meta.kind === 'perqLoan') {
    return (
      <div style={grid}>
        {field('exempt_limit', 'No perquisite when loans total at most (₹)')}
        {field('loan', 'SBI rate on 1 April — loans (%; empty = not entered)')}
        {field('advance', 'SBI rate on 1 April — salary advances (%; empty = not entered)')}
        <p style={{ gridColumn: '1 / -1', margin: 0, fontSize: 12, color: 'var(--color-text-secondary)' }}>
          The perquisite is interest at this rate, less what the employee pays, on the month's highest balance. It is taxed, never paid. Medical loans carry none (choose "Medical" on the loan).
        </p>
      </div>
    );
  }
  if (meta.kind === 'tax') {
    return (
      <>
        <div style={grid}>
          {field('standard_deduction', 'Standard deduction (₹)')}
          {field('rebate_limit', 'Rebate up to income (₹)')}
          {field('rebate_max', 'Largest rebate (₹)')}
          {field('cess_pct', 'Cess (%)')}
          <label>Marginal relief
            <select value={String(draft.marginal_relief)} disabled={disabled} onChange={(e) => setDraft((d) => ({ ...d, marginal_relief: e.target.value === 'true' }))} style={inputStyle}>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </label>
        </div>
        <Bands draft={draft} setDraft={setDraft} amountKey="rate" amountLabel="Rate (%)" disabled={disabled} />
      </>
    );
  }
  if (meta.kind === 'lwf') {
    return (
      <div style={grid}>
        {field('employee', 'Employee (₹)')}
        {field('employer', 'Employer (₹)')}
        {field('months', 'Wage months, 1 to 12, separated by commas (empty = every month)', { type: 'text' })}
      </div>
    );
  }
  return (
    <>
      {draft.deduct_months !== null && <div style={grid}>{field('deduct_months', 'Pay-bill months, 1 to 12, separated by commas', { type: 'text' })}</div>}
      <Bands draft={draft} setDraft={setDraft} amountKey="pt" amountLabel="Tax (₹)" disabled={disabled} />
    </>
  );
}

function History({ versions, state }) {
  const show = (v) => {
    const shown = state && v?.[state] !== undefined ? v[state] : v;
    return shown !== null && typeof shown === 'object' ? JSON.stringify(shown) : text(shown) || 'None';
  };
  return (
    <details style={{ marginTop: 12, fontSize: 12 }}>
      <summary style={{ cursor: 'pointer' }}>Version history ({versions.length})</summary>
      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
        {versions.map((v) => (
          <li key={`${v.origin}-${v.effective_from}`} style={{ marginBottom: 4 }}>
            <strong>{v.effective_from}</strong> · {v.origin === 'recorded' ? 'Recorded' : 'Built in'} · {v.source}
            <div style={{ color: 'var(--color-text-secondary)', overflowWrap: 'anywhere' }}>{show(v.value)}</div>
          </li>
        ))}
      </ul>
    </details>
  );
}

function RuleCard({ ruleKey, meta, data, canEdit, onSaved }) {
  const applied = data.applied[ruleKey];
  const value = data.resolved[ruleKey];
  const byState = meta.kind === 'pt' || meta.kind === 'lwf';
  const state = byState ? data.jurisdiction : null;
  const missingState = byState && !state;
  const hasEntry = !byState || value?.[state] !== undefined;
  const [draft, setDraft] = useState(() => (missingState ? null : toDraft(meta.kind, value, state)));
  const [from, setFrom] = useState(meta.setting && applied.origin === 'built-in' ? firstOfThisMonth() : applied.effective_from);
  const [source, setSource] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const options = data.built_in[ruleKey].find((v) => v.options)?.options;
  const unconfirmed = applied.origin !== 'built-in' && /not confirmed/i.test(applied.source || '');
  const noSource = applied.origin !== 'built-in' && /^no source given$/i.test(String(applied.source || '').trim());
  const status = meta.setting ? SETTING : unconfirmed ? STATUS.recorded_unconfirmed : noSource ? STATUS.recorded_no_source : STATUS[applied.status] ?? STATUS.unverified;
  const gap = byState ? data.state_gaps?.[ruleKey]?.[state] : null;

  const versions = [
    ...data.built_in[ruleKey].map((v) => ({ effective_from: v.effective_from, source: v.source, value: v.value, origin: 'built-in' })),
    ...data.custom_versions.filter((r) => r.rule_key === ruleKey)
      .map((r) => ({ effective_from: String(r.effective_from).slice(0, 10), source: r.source_reference, value: r.value, origin: 'recorded' })),
  ].sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1));

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      const res = await api.post('/payroll/statutory-rules', {
        rule_key: ruleKey, effective_from: from, value: toValue(meta.kind, draft, value, state, meta.nullable), source_reference: source.trim(),
      });
      setSource('');
      onSaved(res?.data?.pending ? `${meta.label}: saved as a proposal. It takes effect when a different authorised person confirms it below.` : null);
    } catch (err) {
      setError(err?.response?.data?.message || err?.response?.data?.error || 'The rule could not be saved.');
    } finally { setSaving(false); }
  };

  return (
    <div data-rule={ruleKey} style={{ background: 'var(--color-bg-card, #fff)', border: '1px solid var(--color-border, #e5e7eb)', borderRadius: 12, padding: 16, marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
        <h4 style={{ margin: 0, fontSize: 14 }}>{meta.label}{state ? ` (${state})` : ''}</h4>
        <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: status.bg, color: status.fg, whiteSpace: 'nowrap' }}>{status.label}</span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
        In force from {applied.effective_from}. {applied.source}
      </div>
      {gap && applied.status !== 'verified' && <div style={{ fontSize: 12, color: 'var(--color-warning)', marginBottom: 12 }}>{gap}</div>}
      {missingState && <div style={{ fontSize: 13 }}>Record the statutory jurisdiction in Payroll Settings to edit this rule.</div>}
      {!missingState && !hasEntry && <div style={{ fontSize: 12, marginBottom: 8 }}>Pulse holds no entry for {state} yet. Enter it below.</div>}
      {!missingState && (
        <>
          <ValueInputs meta={meta} options={options} draft={draft} setDraft={setDraft} disabled={!canEdit} />
          {canEdit && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 12, fontSize: 13 }}>
                <label>Applies from
                  <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={inputStyle} />
                </label>
                <label>{meta.setting ? 'Source, such as the management note (optional)' : 'Source, such as the notification number (optional)'}
                  <input type="text" value={source} onChange={(e) => setSource(e.target.value)} style={inputStyle} />
                </label>
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 6 }}>
                {meta.setting
                  ? 'Enter the date this applies from: earlier months keep what they had.'
                  : 'Keep this date to correct the version in force. When the law changes, enter the date it takes effect: earlier months keep the old value.'}
              </div>
              {from < applied.effective_from && (
                <div style={{ fontSize: 12, color: 'var(--color-warning)', marginTop: 6 }}>
                  The version from {applied.effective_from} is later, so it stays in force for this month.
                </div>
              )}
              {error && <div role="alert" style={{ marginTop: 8, fontSize: 12, color: 'var(--color-danger)' }}>{error}</div>}
              <button type="button" className="pulse-btn-primary" disabled={saving} onClick={save} style={{ marginTop: 12 }}>
                {saving ? 'Saving...' : 'Save and confirm'}
              </button>
            </>
          )}
        </>
      )}
      <History versions={versions} state={state} />
    </div>
  );
}

const INCLUDED = [['employer_pf', 'Employer PF'], ['employer_esi', 'Employer ESI'], ['employer_lwf', 'Employer LWF'], ['gratuity', 'Gratuity']];

/** What the company counts in CTC. A salary proposal cannot be approved until this is recorded. */
function CtcDefinitionCard({ policy, canEdit, onSaved }) {
  const recorded = policy.origin !== 'built-in';
  const status = recorded ? STATUS.verified : STATUS.decision_required;
  const [draft, setDraft] = useState(policy.value);
  const [from, setFrom] = useState(policy.effective_from);
  const [source, setSource] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const gratuity = (patch) => setDraft((d) => ({ ...d, gratuity: { ...d.gratuity, ...patch } }));

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      const res = await api.post('/payroll/statutory-rules', { rule_key: 'ctc.definition', effective_from: from, value: draft, source_reference: source.trim() });
      onSaved(res?.data?.pending ? 'The CTC definition is saved as a proposal. It takes effect when a different authorised person confirms it below.' : null);
    } catch (err) {
      setError(err?.response?.data?.message || err?.response?.data?.error || 'The CTC definition could not be saved.');
    } finally { setSaving(false); }
  };

  return (
    <div data-rule="ctc.definition" style={{ background: 'var(--color-bg-card, #fff)', border: '1px solid var(--color-border, #e5e7eb)', borderRadius: 12, padding: 16, marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
        <h4 style={{ margin: 0, fontSize: 14 }}>What CTC includes</h4>
        <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: status.bg, color: status.fg, whiteSpace: 'nowrap' }}>{recorded ? 'Recorded' : status.label}</span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
        {recorded ? `In force from ${policy.effective_from}.` : 'A salary proposal cannot be approved until the company records this.'} {policy.source}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, fontSize: 13 }}>
        {INCLUDED.map(([key, label]) => (
          <label key={key}>{label}
            <select value={String(Boolean(draft.include?.[key]))} disabled={!canEdit} onChange={(e) => setDraft((d) => ({ ...d, include: { ...d.include, [key]: e.target.value === 'true' } }))} style={inputStyle}>
              <option value="true">Included</option>
              <option value="false">Not included</option>
            </select>
          </label>
        ))}
        <label>Gratuity measured on
          <select value={draft.gratuity?.base ?? 'code_wages'} disabled={!canEdit} onChange={(e) => gratuity({ base: e.target.value })} style={inputStyle}>
            <option value="code_wages">Code wages</option>
            <option value="basic">Basic</option>
          </select>
        </label>
        <label>Gratuity days per year
          <input type="number" value={text(draft.gratuity?.days_per_year)} disabled={!canEdit} onChange={(e) => gratuity({ days_per_year: toNumber(e.target.value) })} style={inputStyle} />
        </label>
        <label>Gratuity divisor
          <input type="number" value={text(draft.gratuity?.divisor)} disabled={!canEdit} onChange={(e) => gratuity({ divisor: toNumber(e.target.value) })} style={inputStyle} />
        </label>
        <label>A different person must approve
          <select value={String(Boolean(draft.maker_checker))} disabled={!canEdit} onChange={(e) => setDraft((d) => ({ ...d, maker_checker: e.target.value === 'true' }))} style={inputStyle}>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </label>
        <label>Version name
          <input type="text" value={text(draft.version)} disabled={!canEdit} onChange={(e) => setDraft((d) => ({ ...d, version: e.target.value }))} style={inputStyle} />
        </label>
      </div>
      {canEdit && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 12, fontSize: 13 }}>
            <label>Applies from
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={inputStyle} />
            </label>
            <label>Source, such as the Finance approval (optional)
              <input type="text" value={source} onChange={(e) => setSource(e.target.value)} style={inputStyle} />
            </label>
          </div>
          {error && <div role="alert" style={{ marginTop: 8, fontSize: 12, color: 'var(--color-danger)' }}>{error}</div>}
          <button type="button" className="pulse-btn-primary" disabled={saving} onClick={save} style={{ marginTop: 12 }}>
            {saving ? 'Saving...' : 'Save and confirm'}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Every statutory rate, ceiling and table as an input. Saving records a dated version and counts
 * as confirming it, so a change in law is a new date and past months keep what they were paid on.
 */
export default function StatutoryRulesPanel() {
  const { hasPermission } = useAuth();
  const canEdit = typeof hasPermission === 'function' && hasPermission('payroll_statutory_config', 'edit');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(0);
  const [changes, setChanges] = useState([]);
  const [notice, setNotice] = useState(null);
  const folds = useFolds();

  const load = useCallback(async () => {
    setError(null);
    try {
      const [res, ch] = await Promise.all([
        api.get('/payroll/statutory-rules'),
        api.get('/payroll/statutory-rules/changes').catch(() => ({ data: { data: [] } })),
      ]);
      setData(res.data?.data ?? null);
      setChanges(Array.isArray(ch.data?.data) ? ch.data.data : []);
    } catch (err) {
      setError(err?.response?.data?.message || err?.response?.data?.error || 'The statutory rules could not be loaded.');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error) return <div role="alert" style={{ padding: 16, color: 'var(--color-danger)' }}>{error}</div>;
  if (!data) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)' }}>Loading statutory rules...</div>;
  // Rebuild the cards only once the new values are here: they take their inputs from
  // the data when they mount, and inputs showing the old value would save it back.
  const after = async (message = null) => { await load(); setSaved((n) => n + 1); setNotice(message); };
  const decide = async (c, decision) => {
    try {
      await api.post(`/payroll/statutory-rules/changes/${c.id}/${decision}`, {});
      await after(decision === 'confirm' ? `${c.rule_key} from ${String(c.effective_from).slice(0, 10)} is now in force.` : `${c.rule_key}: the proposal was rejected; nothing changed.`);
    } catch (err) { setNotice(err?.response?.data?.message || 'Could not record the decision.'); }
  };
  const pending = changes.filter((c) => c.status === 'pending');
  // A rule the server does not know (an older server) is skipped, not a crash.
  const shownGroups = GROUPS
    .map((g) => ({ title: g.title, keys: Object.entries(g.rules).filter(([key]) => data.built_in?.[key]) }))
    .filter((g) => g.keys.length > 0);
  const foldKeys = [...(data.ctc_policy ? ['Salary proposals'] : []), ...shownGroups.map((g) => g.title)];
  return (
    <div>
      <div style={{ padding: '10px 16px', marginBottom: 12, borderRadius: 8, fontSize: 13, background: 'var(--color-info-bg)', color: 'var(--color-info)' }}>
        {canEdit
          ? 'Saving records your name and the source. Recording the value already in force confirms it at once; a different value is a proposal until another authorised person confirms it (when Payroll Settings asks for a second person). If a change affects a saved draft, regenerate that payroll before approving it.'
          : 'You can view these rules. A payroll administrator records changes.'}
      </div>
      {notice && <div role="status" style={{ padding: '10px 16px', marginBottom: 12, borderRadius: 8, fontSize: 13, background: 'var(--color-success-bg)', color: 'var(--color-success)' }}>{notice}</div>}
      {pending.length > 0 && (
        <section aria-label="Rule changes awaiting a second person" style={{ marginBottom: 20, border: '1px solid var(--color-warning)', borderRadius: 12, padding: 16 }}>
          <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>Changes awaiting a second person ({pending.length})</h3>
          <p style={{ fontSize: 12, margin: '0 0 8px', color: 'var(--color-text-secondary)' }}>A change takes effect only when someone other than the person who proposed it confirms it; a super admin may confirm their own. Until then, payroll for the months it covers cannot be approved.</p>
          {pending.map((c) => (
            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', borderTop: '1px solid var(--color-border, #e5e7eb)', padding: '8px 0', fontSize: 13 }}>
              <div>
                <strong>{c.rule_key}</strong> from {String(c.effective_from).slice(0, 10)} — proposed by {c.proposed_by_name || `user ${c.proposed_by}`}
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>Source: {c.source_reference}</div>
                <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{JSON.stringify(c.value)}</code>
              </div>
              {canEdit && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="pulse-btn-primary" onClick={() => decide(c, 'confirm')}>Confirm</button>
                  <button className="pulse-btn-secondary" onClick={() => decide(c, 'reject')}>Reject</button>
                </div>
              )}
            </div>
          ))}
        </section>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <FoldAllButton folds={folds} keys={foldKeys} />
      </div>
      {data.ctc_policy && (
        <FoldSection title="Salary proposals" open={folds.isOpen('Salary proposals')} onToggle={() => folds.toggle('Salary proposals')} style={foldBox}>
          <CtcDefinitionCard key={saved} policy={data.ctc_policy} canEdit={canEdit} onSaved={after} />
        </FoldSection>
      )}
      {shownGroups.map((g) => (
        <FoldSection key={g.title} title={g.title} open={folds.isOpen(g.title)} onToggle={() => folds.toggle(g.title)} style={foldBox}
          right={<span style={{ fontSize: 12, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>{g.keys.length} {g.keys.length === 1 ? 'rule' : 'rules'}</span>}>
          {g.keys.map(([key, meta]) => (
            <RuleCard key={`${key}-${saved}`} ruleKey={key} meta={meta} data={data} canEdit={canEdit} onSaved={after} />
          ))}
        </FoldSection>
      ))}
    </div>
  );
}
