import { useState, useEffect } from 'react';
import { AlertCircle, CheckCircle, Circle, ArrowRight } from 'lucide-react';
import api from '@/services/api/client';

/**
 * Payroll Center → Overview. The month's workflow at a glance, read from the
 * endpoints Run Payroll already uses — /payroll/summary (counts, eligibility,
 * pay cycle) and /payroll/release-readiness (approval blockers). It computes
 * nothing of its own and changes nothing; every card opens the section where
 * the work is done. A failed read says so instead of showing zeros.
 */
const errMsg = (r) => r.reason?.response?.data?.message || r.reason?.message || 'request failed';

export default function PayrollOverview({ go }) {
  const today = new Date();
  const month = today.getMonth() + 1, year = today.getFullYear();
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let live = true;
    Promise.allSettled([
      api.get('/payroll/summary', { params: { month, year } }),
      api.get('/payroll/release-readiness', { params: { month, year } }),
    ]).then(([s, r]) => {
      if (!live) return;
      setState({
        loading: false,
        summary:      s.status === 'fulfilled' ? s.value?.data?.data || null : null,
        summaryError: s.status === 'rejected' ? errMsg(s) : null,
        ready:        r.status === 'fulfilled' ? r.value?.data?.data || null : null,
        readyError:   r.status === 'rejected' ? errMsg(r) : null,
      });
    });
    return () => { live = false; };
  }, [month, year]);

  if (state.loading) return <div className="pc-ov-note">Loading this month's payroll status…</div>;

  const { summary: s, summaryError, ready, readyError } = state;
  const period = s?.payroll_period || ready?.period || `${today.toLocaleString('en-GB', { month: 'long' })} ${year}`;
  const elig = s?.eligibility;
  const cycleErrors = s?.cycle?.errors || [];
  const conflicts = s?.settings_conflicts || [];
  const generated = (s?.total_employees || 0) > 0;
  const issued = s?.run_status === 'approved' || s?.run_status === 'paid';

  // tone: 'ok' | 'warn' | 'bad' | 'idle'
  const steps = [
    {
      key: 'settings', title: '1 · Settings', tab: 'settings',
      ...(summaryError ? { tone: 'bad', lines: [`Could not load: ${summaryError}`] }
        : cycleErrors.length || conflicts.length
          ? { tone: 'bad', lines: [
            ...cycleErrors.map(e => `Pay cycle: ${e}`),
            ...(conflicts.length ? [`Payroll Settings and the Setup Wizard disagree on ${conflicts.map(c => c.key).join(', ')} — save Payroll Settings once to align them`] : []),
          ] }
          : { tone: 'ok', lines: ['Pay cycle configured; no settings conflicts'] }),
    },
    {
      key: 'structures', title: '2 · Salary structures & assignments', tab: 'structures',
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
      key: 'processing', title: '3 · Generate & review the draft', tab: 'processing',
      ...(summaryError ? { tone: 'bad', lines: [`Could not load: ${summaryError}`] }
        : !generated ? { tone: 'idle', lines: [`${period} payroll has not been generated`] }
          : { tone: s.blocked_count > 0 ? 'warn' : 'ok', lines: [
            `${s.total_employees} record(s): ${s.pending_count} draft · ${s.approved_count} approved · ${s.paid_count} paid`,
            ...(s.blocked_count > 0 ? [`${s.blocked_count} record(s) carry validation errors`] : []),
          ] }),
    },
    {
      key: 'release', title: '4 · Approve & release', tab: 'processing',
      ...(readyError ? { tone: 'bad', lines: [`Could not load release prerequisites: ${readyError}`] }
        : !ready ? { tone: 'idle', lines: ['Release prerequisites not reported'] }
          : ready.ready
            ? { tone: issued ? 'ok' : 'idle', lines: [issued ? `${period} is approved` : 'No release blockers — approval is done by the approver in Payroll Processing'] }
            : { tone: 'bad', lines: [
              `Approval is blocked by ${ready.blockers.length} prerequisite(s):`,
              ...ready.blockers.slice(0, 4).map(b => `${b.code}${b.key ? ` · ${b.key}` : ''} — ${b.message}`),
              ...(ready.blockers.length > 4 ? [`…and ${ready.blockers.length - 4} more (full list in Payroll Processing)`] : []),
            ] }),
    },
    {
      key: 'payslips', title: '5 · Payslips', tab: 'payslips',
      ...(summaryError ? { tone: 'bad', lines: [`Could not load: ${summaryError}`] }
        : issued ? { tone: 'ok', lines: ['Approved payslips can be viewed, downloaded and emailed'] }
          : { tone: 'idle', lines: ['Payslips are issued only after the month is approved; until then the generator shows a preview'] }),
    },
    {
      key: 'statutory', title: '6 · Tax & statutory', tab: 'statutory',
      tone: 'idle',
      lines: [
        'Form 16 / Form No. 130 — annual salary TDS certificate, issued after the tax year ends',
        'Form 138 / Form 24Q — quarterly salary TDS statement; each screen lists its own validation failures',
      ],
    },
  ];

  const Icon = { ok: CheckCircle, warn: AlertCircle, bad: AlertCircle, idle: Circle };

  return (
    <div>
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
              <button type="button" className="pc-ov-open" onClick={() => go(st.tab)}>
                Open <ArrowRight size={13} aria-hidden="true" />
              </button>
            </section>
          );
        })}
      </div>
    </div>
  );
}
