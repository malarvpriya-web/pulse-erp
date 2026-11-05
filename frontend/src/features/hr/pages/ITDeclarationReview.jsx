// frontend/src/features/hr/pages/ITDeclarationReview.jsx
//
// HR → IT Declaration Review (§203). The reviewer side of the declarations
// employees file in Self-Service → IT Declaration. It reads and moves the SAME
// it_declarations rows (GET /self-service/it-declarations/review, PUT
// /self-service/it-declarations/:id) — no copy, no second record.
//   it_declarations:view     open this page, see the company's declarations
//   it_declarations:approve  approve / reject (a reason is required) / reopen
// Nobody reviews their own declaration: the server refuses it and the row says so.
import { useState, useEffect, useCallback } from 'react';
import { FileCheck2 } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { PageHero, PageShell, EmptyState } from '@/components/pulse-ui';
import { fmtDate } from '@/utils/dateFormatter';

function currentFY() {
  const now = new Date();
  const y = now.getFullYear();
  return now.getMonth() + 1 >= 4 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}
const fyOptions = () => {
  const start = Number(currentFY().slice(0, 4));
  return [start + 1, start, start - 1, start - 2].map(y => `${y}-${y + 1}`);
};
const STATUSES = [['submitted', 'Waiting for review'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['all', 'All']];
const STATUS_COLOR = { submitted: '#6d28d9', approved: '#16a34a', rejected: '#dc2626' };
const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
// Proof links are stored as typed; only open web links.
const safeLink = (u) => (/^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : null);

const btn = (bg, fg = '#fff') => ({ padding: '6px 12px', background: bg, color: fg, border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 });

export default function ITDeclarationReview() {
  const { hasPermission } = useAuth();
  const mayApprove = hasPermission('it_declarations', 'approve');
  const [fy, setFy] = useState(currentFY());
  const [status, setStatus] = useState('submitted');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState(null);
  const [rejecting, setRejecting] = useState(null);   // { id, reason }
  const [history, setHistory] = useState({});         // id → events | 'loading' | 'error'
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/self-service/it-declarations/review', { params: { financial_year: fy, status } });
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      setRows([]);
      setError(err.response?.data?.message || 'Could not load declarations');
    } finally { setLoading(false); }
  }, [fy, status]);
  useEffect(() => { load(); }, [load]);

  const decide = async (row, next, remarks) => {
    setBusy(row.id); setMsg(null);
    try {
      await api.put(`/self-service/it-declarations/${row.id}`, { status: next, ...(remarks ? { remarks } : {}) });
      setMsg({ type: 'ok', text: `${row.employee_name} — ${row.declaration_type} ${inr(row.amount)}: ${next}` });
      setRejecting(null);
      setHistory(h => { const n = { ...h }; delete n[row.id]; return n; });
      load();
    } catch (err) {
      setMsg({ type: 'error', text: err.response?.data?.message || 'The decision was not saved' });
    } finally { setBusy(null); }
  };

  const toggleHistory = async (id) => {
    if (history[id]) { setHistory(h => { const n = { ...h }; delete n[id]; return n; }); return; }
    setHistory(h => ({ ...h, [id]: 'loading' }));
    try {
      const { data } = await api.get(`/self-service/it-declarations/${id}/history`);
      setHistory(h => ({ ...h, [id]: Array.isArray(data?.events) ? data.events : [] }));
    } catch { setHistory(h => ({ ...h, [id]: 'error' })); }
  };

  const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);

  return (
    <PageShell dock={
      <PageHero icon={FileCheck2} eyebrow="Human Resources" title="IT Declaration Review"
        subtitle="Review the tax-saving declarations employees file in Self-Service. Approved and submitted declarations feed TDS." />
    }>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end', marginBottom: 16 }}>
        <div>
          <label htmlFor="itdr-fy" style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#4c1d95', marginBottom: 4 }}>Financial year</label>
          <select id="itdr-fy" value={fy} onChange={e => setFy(e.target.value)} style={{ padding: '7px 10px', borderRadius: 7, border: '1px solid #e9e4ff' }}>
            {fyOptions().map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div role="tablist" aria-label="Status" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {STATUSES.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={status === k} onClick={() => setStatus(k)}
              style={{ ...btn(status === k ? '#6B3FDB' : '#ede9fe', status === k ? '#fff' : '#6B3FDB'), padding: '8px 14px' }}>{l}</button>
          ))}
        </div>
        {!mayApprove && <span style={{ fontSize: 12, color: '#6b7280' }}>View only — reviewing needs the IT declaration approval permission.</span>}
      </div>

      {msg && <div role="status" style={{ marginBottom: 12, padding: '10px 14px', borderRadius: 8, fontSize: 13, background: msg.type === 'error' ? '#fef2f2' : '#f0fdf4', color: msg.type === 'error' ? '#dc2626' : '#16a34a' }}>{msg.text}</div>}

      {loading ? <div style={{ color: '#6b7280', fontSize: 13 }}>Loading declarations…</div>
        : error ? <EmptyState title="Declarations could not be loaded" subtitle={error} action={<button onClick={load} style={btn('#6B3FDB')}>Retry</button>} />
        : rows.length === 0 ? <EmptyState icon={FileCheck2} title="Nothing here" subtitle={`No ${status === 'all' ? '' : `${STATUSES.find(s => s[0] === status)?.[1].toLowerCase()} `}declarations for ${fy}.`} />
        : (
          <>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>{rows.length} declaration{rows.length === 1 ? '' : 's'} · {inr(total)}</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr style={{ background: '#f5f3ff', textAlign: 'left' }}>
                  {['Employee', 'Section', 'Amount', 'Description', 'Proof', 'Status', ''].map(h => <th key={h} style={{ padding: '8px 10px', color: '#4c1d95' }}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {rows.map(r => {
                    const proof = safeLink(r.proof_url);
                    const hist = history[r.id];
                    return (
                      <FragmentRow key={r.id}>
                        <tr data-testid="itdr-row" style={{ borderTop: '1px solid #f0ebff', verticalAlign: 'top' }}>
                          <td style={{ padding: '8px 10px' }}>
                            <div style={{ fontWeight: 600 }}>{r.employee_name}</div>
                            <div style={{ fontSize: 11, color: '#6b7280' }}>{r.employee_code}{r.department ? ` · ${r.department}` : ''}</div>
                          </td>
                          <td style={{ padding: '8px 10px' }}>{r.declaration_type}</td>
                          <td style={{ padding: '8px 10px', fontWeight: 600 }}>{inr(r.amount)}</td>
                          <td style={{ padding: '8px 10px', maxWidth: 240 }}>{r.description || '—'}</td>
                          <td style={{ padding: '8px 10px' }}>{proof ? <a href={proof} target="_blank" rel="noreferrer noopener">View</a> : <span style={{ color: '#9ca3af' }}>{r.proof_url ? 'Not a link' : 'None'}</span>}</td>
                          <td style={{ padding: '8px 10px' }}>
                            <span style={{ fontWeight: 700, color: STATUS_COLOR[r.status] || '#6b7280' }}>{r.status}</span>
                            {r.reviewed_by_name && <div style={{ fontSize: 11, color: '#6b7280' }}>by {r.reviewed_by_name}{r.reviewed_at ? `, ${fmtDate(r.reviewed_at)}` : ''}</div>}
                            {r.status === 'rejected' && r.last_remarks && <div style={{ fontSize: 11, color: '#dc2626' }}>{r.last_remarks}</div>}
                          </td>
                          <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {mayApprove && r.can_review && r.status !== 'approved' && (
                                <button onClick={() => decide(r, 'approved')} disabled={busy === r.id} style={btn('#16a34a')}>Approve</button>
                              )}
                              {mayApprove && r.can_review && r.status !== 'rejected' && (
                                <button onClick={() => setRejecting({ id: r.id, reason: '' })} disabled={busy === r.id} style={btn('#dc2626')}>Reject</button>
                              )}
                              {mayApprove && r.can_review && r.status !== 'submitted' && (
                                <button onClick={() => decide(r, 'submitted')} disabled={busy === r.id} style={btn('#ede9fe', '#6B3FDB')}>Reopen</button>
                              )}
                              {!r.can_review && mayApprove && <span style={{ fontSize: 11, color: '#6b7280' }}>Your own — another reviewer decides</span>}
                              <button onClick={() => toggleHistory(r.id)} style={btn('#f3f4f6', '#374151')} aria-expanded={!!hist}>History</button>
                            </div>
                          </td>
                        </tr>
                        {rejecting?.id === r.id && (
                          <tr><td colSpan={7} style={{ padding: '8px 10px', background: '#fef2f2' }}>
                            <label htmlFor={`itdr-reason-${r.id}`} style={{ fontSize: 12, fontWeight: 600 }}>Reason for rejection *</label>
                            <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                              <input id={`itdr-reason-${r.id}`} value={rejecting.reason} onChange={e => setRejecting({ id: r.id, reason: e.target.value })}
                                style={{ flex: '1 1 240px', padding: '7px 10px', borderRadius: 7, border: '1px solid #fecaca' }} />
                              <button onClick={() => decide(r, 'rejected', rejecting.reason.trim())} disabled={!rejecting.reason.trim() || busy === r.id} style={btn('#dc2626')}>Confirm rejection</button>
                              <button onClick={() => setRejecting(null)} style={btn('#fff', '#374151')}>Cancel</button>
                            </div>
                          </td></tr>
                        )}
                        {hist && (
                          <tr><td colSpan={7} style={{ padding: '8px 10px', background: '#fafafa', fontSize: 12 }}>
                            {hist === 'loading' ? 'Loading history…'
                              : hist === 'error' ? 'History could not be loaded.'
                              : hist.length === 0 ? `Filed ${fmtDate(r.created_at)} — no review yet.`
                              : (
                                <ol style={{ margin: 0, paddingLeft: 18 }}>
                                  <li>Filed {fmtDate(r.created_at)}</li>
                                  {hist.map(ev => (
                                    <li key={ev.id}>{fmtDate(ev.at)} — {ev.by_name || 'Someone'}: {ev.from_status || '—'} → {ev.to_status || '—'}{ev.remarks ? ` (“${ev.remarks}”)` : ''}</li>
                                  ))}
                                </ol>
                              )}
                          </td></tr>
                        )}
                      </FragmentRow>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
    </PageShell>
  );
}

function FragmentRow({ children }) { return <>{children}</>; }
