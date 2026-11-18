import { useState, useEffect } from 'react';
import { AlertCircle, CheckCircle, Circle, ArrowRight } from 'lucide-react';
import api from '@/services/api/client';

/**
 * Payroll Center → Overview. One month's workflow at a glance, read from the
 * endpoints the sections use — /payroll/summary (counts, eligibility, pay
 * cycle), /payroll/release-readiness (everything that blocks approval, plus
 * warnings) and /payroll/statutory-dues (what is owed to PF / ESI / PT / LWF /
 * TDS and when). It computes nothing and changes nothing; every card opens the
 * section where the work is done. A failed read says so instead of showing zeros.
 */
const errMsg = (r) => r.reason?.response?.data?.message || r.reason?.message || 'request failed';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const fmt = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const KIND = { pf: 'Provident Fund', esi: 'ESI', pt: 'Professional tax', lwf: 'Labour welfare fund', tds: 'Income tax (TDS)' };

/** The last 13 months, newest first. Early in a month, last month is usually the one being paid. */
function monthOptions(today = new Date()) {
  const out = [];
  for (let i = 0; i < 13; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    out.push({ month: d.getMonth() + 1, year: d.getFullYear() });
  }
  return out;
}

export default function PayrollOverview({ go }) {
  const options = monthOptions();
  const [sel, setSel] = useState(() => (new Date().getDate() <= 10 ? options[1] : options[0]));
  const { month, year } = sel;
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let live = true;
    setState({ loading: true });
    Promise.allSettled([
      api.get('/payroll/summary', { params: { month, year } }),
      api.get('/payroll/release-readiness', { params: { month, year } }),
      api.get('/payroll/statutory-dues', { params: { month, year } }),
    ]).then(([s, r, d]) => {
      if (!live) return;
      setState({
        loading: false,
        summary:      s.status === 'fulfilled' ? s.value?.data?.data || null : null,
        summaryError: s.status === 'rejected' ? errMsg(s) : null,
        ready:        r.status === 'fulfilled' ? r.value?.data?.data || null : null,
        readyError:   r.status === 'rejected' ? errMsg(r) : null,
        dues:         d.status === 'fulfilled' ? d.value?.data?.data || null : null,
        duesError:    d.status === 'rejected' ? errMsg(d) : null,
      });
    });
    return () => { live = false; };
  }, [month, year]);

  const picker = (
    <label className="pc-ov-note" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      Payroll month
      <select value={`${year}-${month}`} onChange={(e) => { const [y, m] = e.target.value.split('-').map(Number); setSel({ month: m, year: y }); }}
        style={{ padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 8 }}>
        {options.map(o => <option key={`${o.year}-${o.month}`} value={`${o.year}-${o.month}`}>{MONTHS[o.month - 1]} {o.year}</option>)}
      </select>
    </label>
  );
  if (state.loading) return <div>{picker}<div className="pc-ov-note">Loading payroll status for {MONTHS[month - 1]} {year}…</div></div>;

  const { summary: s, summaryError, ready, readyError, dues, duesError } = state;
  const period = s?.payroll_period || ready?.period || `${MONTHS[month - 1]} ${year}`;
  const elig = s?.eligibility;
  const cycleErrors = s?.cycle?.errors || [];
  const conflicts = s?.settings_conflicts || [];
  const generated = (s?.total_employees || 0) > 0;
  const approvedOrPaid = (s?.approved_count || 0) + (s?.paid_count || 0);
  const issued = approvedOrPaid > 0 && (s?.pending_count || 0) === 0;
  const warnings = ready?.warnings || [];

  const steps = [
    {
      key: 'settings', title: '1 · Settings', tab: 'settings',
      ...(summaryError ? { tone: 'bad', lines: [`Could not load: ${summaryError}`] }
        : cycleErrors.length || conflicts.length
          ? { tone: 'bad', lines: [
            ...cycleErrors.map(e => `Pay cycle: ${e}`),
            ...(conflicts.length ? [`Two saved copies of the payroll settings disagree on ${conflicts.map(c => c.key).join(', ')} — save Payroll Settings once to align them`] : []),
          ] }
          : { tone: warnings.length ? 'warn' : 'ok', lines: [
            `Pay date ${s?.cycle?.pay_date || '—'}; attendance cutoff ${s?.cycle?.attendance_cutoff_date || '—'}`,
            ...warnings.map(w => w.message),
          ] }),
    },
    {
      key: 'structures', title: '2 · Salaries & tax setup', tab: 'structures',
      ...(summaryError ? { tone: 'bad', lines: [`Could not load: ${summaryError}`] }
        : !elig ? { tone: 'idle', lines: ['Eligibility not reported'] }
          : elig.eligible === 0
            ? { tone: 'bad', lines: [`No active employee is eligible for ${period}.`, 'Assign a salary structure and revision to each employee before generating payroll.'] }
            : { tone: elig.not_eligible > 0 ? 'warn' : 'ok', lines: [
              `${elig.eligible} of ${elig.active_headcount} active employees are eligible`,
              ...(elig.not_eligible > 0 ? [`${elig.not_eligible} not eligible — reasons are listed in Payroll Processing`] : []),
            ] }),
    },
    {
      key: 'processing', title: '3 · Attendance, generate & review', tab: 'processing',
      ...(summaryError ? { tone: 'bad', lines: [`Could not load: ${summaryError}`] }
        : !generated ? { tone: 'idle', lines: [`${period} payroll has not been generated`, 'Sync attendance for the month first (Attendance → Payroll Sync)'] }
          : { tone: s.blocked_count > 0 ? 'warn' : 'ok', lines: [
            `${s.total_employees} record(s): ${s.pending_count} draft · ${s.approved_count} approved · ${s.paid_count} paid`,
            ...(s.blocked_count > 0 ? [`${s.blocked_count} record(s) carry data errors`] : []),
          ] }),
    },
    {
      key: 'release', title: '4 · Approve', tab: 'processing',
      ...(readyError ? { tone: 'bad', lines: [`Could not load the approval checks: ${readyError}`] }
        : !ready ? { tone: 'idle', lines: ['Approval checks not reported'] }
          : issued ? { tone: 'ok', lines: [`${period} is approved`] }
            : ready.ready
              ? { tone: generated ? 'idle' : 'idle', lines: [generated ? 'Nothing blocks approval — a different authorised person approves in Payroll Processing' : 'Generate the payroll first'] }
              : { tone: 'bad', lines: [
                `Approval is blocked by ${ready.blockers.length} item(s):`,
                ...ready.blockers.slice(0, 4).map(b => b.message),
                ...(ready.blockers.length > 4 ? [`…and ${ready.blockers.length - 4} more (full list in Payroll Processing)`] : []),
              ] }),
    },
    {
      key: 'pay', title: '5 · Pay salaries', tab: 'processing',
      ...(summaryError ? { tone: 'bad', lines: [`Could not load: ${summaryError}`] }
        : !approvedOrPaid ? { tone: 'idle', lines: ['Salaries are paid after approval: Finance downloads the transfer file and records each bank reference'] }
          : s.paid_count === s.total_employees
            ? { tone: 'ok', lines: [`All ${s.paid_count} salaries recorded as paid`] }
            : { tone: s.cycle?.state === 'approved_unpaid_overdue' ? 'bad' : 'warn', lines: [
              `${s.paid_count} of ${approvedOrPaid} approved salaries recorded as paid`,
              ...(s.cycle?.state === 'approved_unpaid_overdue' ? [`The pay date (${s.cycle.pay_date}) has passed`] : []),
            ] }),
    },
    {
      key: 'payslips', title: '6 · Payslips', tab: 'payslips',
      ...(issued ? { tone: 'ok', lines: ['Approved payslips can be viewed, downloaded and emailed'] }
        : { tone: 'idle', lines: ['Payslips are released only after the month is approved; until then they are marked DRAFT'] }),
    },
    {
      key: 'statutory', title: '7 · Pay PF, ESI, PT, LWF and TDS', tab: 'statutory',
      ...(duesError ? { tone: 'bad', lines: [`Could not load: ${duesError}`] }
        : !dues || !dues.finalised_runs ? { tone: 'idle', lines: ['Amounts appear once the month is approved'] }
          : (() => {
            const open = dues.items.filter(i => i.status === 'due' || i.status === 'overdue');
            const overdue = open.some(i => i.status === 'overdue');
            return {
              tone: overdue ? 'bad' : open.length ? 'warn' : 'ok',
              lines: open.length
                ? open.map(i => `${KIND[i.kind]}: ${fmt(i.amount)} ${i.status === 'overdue' ? 'OVERDUE since' : 'due by'} ${i.due_date || '(check the state rule)'}`)
                : ['Everything due for the month is recorded as paid'],
            };
          })()),
    },
  ];

  const Icon = { ok: CheckCircle, warn: AlertCircle, bad: AlertCircle, idle: Circle };

  return (
    <div>
      {picker}
      <div className="pc-ov-note">
        Status for <strong>{period}</strong>, read live. This page changes nothing — open a step to act on it.
      </div>
      <div className="pc-ov-grid">
        {steps.map(st => {
          const I = Icon[st.tone];
          return (
            <section key={st.key} className={`pc-ov-card is-${st.tone}`} aria-label={st.title}>
              <header><I size={15} aria-hidden="true" /><h3>{st.title}</h3></header>
              <ul>{st.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
              <button type="button" className="pc-ov-open" onClick={() => go(st.tab, st.key === 'statutory' ? 'dues' : undefined)}>
                Open <ArrowRight size={13} aria-hidden="true" />
              </button>
            </section>
          );
        })}
      </div>
    </div>
  );
}
