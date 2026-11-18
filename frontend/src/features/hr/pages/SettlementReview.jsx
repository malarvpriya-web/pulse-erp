// Full & final settlement — review, approve, record payment (HR audit 2026-11-16).
//
// Opened from the Approval Center (type `fnf`) or Exit Management:
// /SettlementReview?exit=<exit request id>. It shows the LATEST SAVED version
// (GET /exit/fnf/review/:exit) and never recomputes it. Before this page every
// way of viewing a settlement recomputed it, which recorded the viewer as the
// person who computed it, so the approve step then refused them — and Finance
// could not open Exit Management at all. Reached with fnf:view.
//   Approve        payroll:approve, not the person who computed this version
//   Record payment payroll_payment:approve, not the approver; UTR, value date,
//                  company bank account; refused until exit clearance is done
// The server re-checks all of it on every call.
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Receipt } from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell, LoadingState, LoadError } from '@/components/pulse-ui';
import { fmt } from '@/utils/format';
import { fmtDate, localDay } from '@/utils/dateFormatter';
import { separationLabel } from '../separationTypes';

const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, marginBottom: 16 };
const th = { padding: '6px 8px', textAlign: 'left', fontSize: 12, color: '#6b7280' };
const td = { padding: '8px', fontSize: 13, borderTop: '1px solid #f3f4f6', verticalAlign: 'top' };

export default function SettlementReview({ setPage }) {
  const [params] = useSearchParams();
  const exitId = params.get('exit');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [banks, setBanks] = useState(null);
  const [pay, setPay] = useState({ utr: '', value_date: localDay(), bank_account_id: '' });
  // Every version calculated for this exit (GET /exit/fnf/settlements/:employee), newest first.
  const [versions, setVersions] = useState([]);

  const load = useCallback(async () => {
    if (!/^\d+$/.test(exitId || '')) { setError('No exit selected. Open this page from the Approval Center or Exit Management.'); return; }
    setError(null);
    try {
      const { data: d } = await api.get(`/exit/fnf/review/${exitId}`);
      setData(d);
      if (d?.exit?.employee_id) {
        api.get(`/exit/fnf/settlements/${d.exit.employee_id}`)
          .then(r => setVersions((r.data?.data ?? []).filter(v => String(v.exit_request_id) === String(exitId))))
          .catch(() => setVersions([]));
      }
    } catch (e) {
      setError(e?.response?.status === 404 ? 'This exit was not found in your company.'
        : e?.response?.data?.error || 'The settlement could not be loaded.');
    }
  }, [exitId]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!data?.can_pay || banks) return;
    api.get('/finance/bank-accounts')
      .then(r => setBanks((r.data?.data ?? r.data ?? []).filter(b => b.is_active !== false)))
      .catch(() => setBanks([]));
  }, [data, banks]);

  const act = async (fn, ok) => {
    if (busy) return;
    setBusy(true); setNotice(null);
    try { await fn(); setNotice({ type: 'ok', msg: ok }); await load(); }
    catch (e) {
      const b = e?.response?.data?.blockers;
      setNotice({ type: 'err', msg: b?.length ? `Clearance incomplete: ${b.map(x => x.label).join(', ')}` : (e?.response?.data?.error || 'The request failed.') });
    } finally { setBusy(false); }
  };
  const approve = () => act(
    () => api.put(`/exit/fnf/${exitId}/approve`, { settlement_id: data.settlement.id }), 'Settlement approved.');
  const recordPayment = () => act(
    () => api.post(`/exit/fnf/${exitId}/pay`, {
      settlement_id: data.settlement.id, utr: pay.utr.trim(), value_date: pay.value_date,
      bank_account_id: Number(pay.bank_account_id) || undefined,
    }), 'Payment recorded. The employee is now marked as left.');

  // The leaver's statement (PDF) of the latest version; DRAFT on its face until approved.
  const downloadStatement = async () => {
    try {
      const res = await api.get(`/exit/fnf/review/${exitId}/statement`, { responseType: 'blob' });
      const name = /filename="([^"]+)"/.exec(res.headers?.['content-disposition'] || '')?.[1] || 'fnf_statement.pdf';
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      let msg = null;
      if (e?.response?.data instanceof Blob) { try { msg = JSON.parse(await e.response.data.text())?.error; } catch { /* not JSON */ } }
      setNotice({ type: 'err', msg: msg || 'The statement could not be created.' });
    }
  };

  const er = data?.exit;
  const s = data?.settlement;
  const name = er ? `${er.first_name || ''} ${er.last_name || ''}`.trim() : '';

  return (
    <PageShell dock={
      <PageHero icon={Receipt} eyebrow="Exit Management" title="Full & Final Settlement"
        subtitle={er ? `${name} (${er.office_id}) · ${separationLabel(er.separation_type)} · last working day ${fmtDate(er.last_working_date)}` : 'Review, approve and record payment'} />
    }>
      {error ? <LoadError message={error} onRetry={/^\d+$/.test(exitId || '') ? load : undefined} />
        : !data ? <LoadingState />
        : !s ? (
          <div style={card} role="status">No settlement has been computed for this exit yet. HR computes it in Exit Management → Exits &amp; Settlement.</div>
        ) : (
          <>
            {notice && (
              <div role={notice.type === 'err' ? 'alert' : 'status'} style={{ ...card, background: notice.type === 'err' ? '#fef2f2' : '#ecfdf5', color: notice.type === 'err' ? '#b91c1c' : '#047857' }}>
                {notice.msg}
              </div>
            )}

            <div style={{ ...card, display: 'flex', gap: 32, flexWrap: 'wrap' }}>
              <div><div style={th}>Net payable</div><div style={{ fontSize: 22, fontWeight: 700 }}>{fmt(s.net_payable)}</div></div>
              <div><div style={th}>Payable</div><div>{fmt(s.total_payable)}</div></div>
              <div><div style={th}>Recoverable</div><div>{fmt(s.total_recoverable)}</div></div>
              <div><div style={th}>Version</div><div>v{s.version} · computed {fmtDate(s.computed_at)}{s.computed_by_name ? ` by ${s.computed_by_name}` : ''}</div></div>
              <div><div style={th}>Status</div><div>
                {data.payment ? `Paid ${fmtDate(data.payment.value_date)} · UTR ${data.payment.utr}`
                  : data.approval ? `Approved ${fmtDate(data.approval.created_at)}${data.approval.actor_name ? ` by ${data.approval.actor_name}` : ''}`
                  : 'Awaiting approval'}
              </div></div>
            </div>

            <div style={card}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr><th style={th}>Component</th><th style={th}>How it was worked out</th><th style={th}>Tax</th><th style={{ ...th, textAlign: 'right' }}>Amount</th></tr></thead>
                <tbody>
                  {(s.lines || []).map((l, i) => (
                    <tr key={`${l.code}-${i}`}>
                      <td style={{ ...td, fontWeight: 600 }}>{l.label}</td>
                      <td style={{ ...td, fontSize: 12, color: '#4b5563' }}>{l.basis}</td>
                      <td style={{ ...td, fontSize: 11, color: '#6b7280' }}>{l.tax}</td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap', color: l.amount === 0 ? '#6b7280' : l.direction === 'payable' ? '#059669' : '#dc2626' }}>
                        {l.direction === 'recoverable' && l.amount > 0 ? '− ' : ''}{fmt(l.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {(s.warnings?.length > 0 || s.rules_unconfirmed?.length > 0) && (
              <div style={{ ...card, background: '#fffbeb' }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Check before deciding</div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                  {(s.warnings || []).map((w, i) => <li key={`w${i}`}>{w.message}</li>)}
                  {(s.rules_unconfirmed || []).map((r) => <li key={r.key}>Rule not confirmed: {r.key}</li>)}
                </ul>
              </div>
            )}

            {data.approval && !data.payment && data.clearance_blockers?.length > 0 && (
              <div style={{ ...card, background: '#fef2f2' }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Payment waits for exit clearance</div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                  {data.clearance_blockers.map(b => <li key={b.key}>{b.label}{b.detail?.length ? `: ${b.detail.join(', ')}` : ''}</li>)}
                </ul>
              </div>
            )}

            {!data.payment && (
              <div style={card}>
                {data.can_approve && (
                  <button type="button" className="pulse-btn-primary" disabled={busy} onClick={approve}>
                    {busy ? 'Approving…' : `Approve ${fmt(s.net_payable)}`}
                  </button>
                )}
                {data.can_pay && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, alignItems: 'end' }}>
                    <label style={{ fontSize: 12 }}>Bank transaction reference (UTR)
                      <input value={pay.utr} onChange={e => setPay(p => ({ ...p, utr: e.target.value }))} style={{ display: 'block', width: '100%', padding: 6, marginTop: 4 }} />
                    </label>
                    <label style={{ fontSize: 12 }}>Value date
                      <input type="date" value={pay.value_date} max={localDay()} onChange={e => setPay(p => ({ ...p, value_date: e.target.value }))} style={{ display: 'block', width: '100%', padding: 6, marginTop: 4 }} />
                    </label>
                    <label style={{ fontSize: 12 }}>Paid from
                      <select value={pay.bank_account_id} onChange={e => setPay(p => ({ ...p, bank_account_id: e.target.value }))} style={{ display: 'block', width: '100%', padding: 6, marginTop: 4 }}>
                        <option value="">{banks == null ? 'Loading…' : banks.length ? '-- Choose bank account --' : 'No active bank account'}</option>
                        {(banks || []).map(b => <option key={b.id} value={b.id}>{b.account_name || b.bank_name} · {String(b.account_number || '').slice(-4)}</option>)}
                      </select>
                    </label>
                    <button type="button" className="pulse-btn-primary" disabled={busy || !pay.utr.trim() || !pay.bank_account_id} onClick={recordPayment}>
                      {busy ? 'Recording…' : `Record payment of ${fmt(s.net_payable)}`}
                    </button>
                  </div>
                )}
                {!data.can_approve && !data.can_pay && (
                  <p style={{ margin: 0, fontSize: 13, color: '#4b5563' }}>
                    {data.why_not || (data.approval ? 'Recording the payment needs the payroll payment approval right.' : 'Approving needs the payroll approval right.')}
                  </p>
                )}
              </div>
            )}

            {versions.length > 1 && (
              <div style={card}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Earlier versions</div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr><th style={th}>Version</th><th style={th}>Calculated</th><th style={th}>By</th><th style={{ ...th, textAlign: 'right' }}>Payable</th><th style={{ ...th, textAlign: 'right' }}>Recoverable</th><th style={{ ...th, textAlign: 'right' }}>Net</th></tr></thead>
                  <tbody>
                    {versions.map(v => (
                      <tr key={v.id} style={String(v.id) === String(s.id) ? { background: '#f5f3ff' } : undefined}>
                        <td style={td}>v{v.version}{String(v.id) === String(s.id) ? ' (current)' : ''}</td>
                        <td style={td}>{fmtDate(v.computed_at)}</td>
                        <td style={td}>{v.computed_by_name || (v.computed_by ? `User #${v.computed_by}` : 'Automatic')}</td>
                        <td style={{ ...td, textAlign: 'right' }}>{fmt(v.total_payable)}</td>
                        <td style={{ ...td, textAlign: 'right' }}>{fmt(v.total_recoverable)}</td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{fmt(v.net_payable)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="pulse-btn-secondary" onClick={downloadStatement}
                title={data.approval ? 'F&F statement for the employee (PDF)' : 'Not approved yet: the PDF is marked DRAFT'}>
                Download statement{data.approval ? '' : ' (draft)'}
              </button>
              {setPage && (
                <button type="button" className="pulse-btn-secondary" onClick={() => setPage('ApprovalCenter')}>Back to Approval Center</button>
              )}
            </div>
          </>
        )}
    </PageShell>
  );
}
