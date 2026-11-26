import { useState, useEffect, useCallback } from 'react';
import { Search, Plane, CheckCircle, XCircle, UserPlus } from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import { fmt } from './travelUtils';
import { StatusBadge, ReasonDialog, DelegateDialog, Dialog, Facts, ErrorBox, inputStyle, th, td, btn, apiError } from '../components/travelUi';

/**
 * Travel Approvals — the trips a manager decides (26 Nov 26 rebuild).
 *
 * Lists the trips the caller can see except their own: their reports' and the
 * ones delegated to them (the HR / admin / Finance desks see the company).
 * Approve / Reject / Delegate show only where the SERVER says this person may
 * decide (`can_decide`: reporting manager or delegate; HR/admin only when the
 * traveller has no active manager) — before, managers were shown every trip
 * in the company and got "not authorised" on most. A reject needs a reason.
 * Expense Review (which approved the same trips again) was merged into here.
 */
const FILTERS = ['Pending', 'Approved', 'Rejected', 'Cancelled', 'All'];

export default function TravelApprovals() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('Pending');
  const [search, setSearch] = useState('');
  const [acting, setActing] = useState(null);
  const [rejectFor, setRejectFor] = useState(null);
  const [delegateFor, setDelegateFor] = useState(null);
  const [view, setView] = useState(null);

  const load = useCallback(() => {
    setLoading(true); setErr('');
    api.get('/travel/approvals', { params: { status: filter === 'All' ? undefined : filter } })
      .then(r => setRows(Array.isArray(r.data) ? r.data : []))
      .catch(e => { setRows([]); setErr(apiError(e, 'Could not load trips')); })
      .finally(() => setLoading(false));
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  const decide = async (row, status, comments = '') => {
    setActing(row.id);
    try {
      await api.put(`/travel/requests/${row.id}/status`, { status, comments });
      toast.success(`${row.request_number} ${status.toLowerCase()}`);
      setView(null); load();
    } catch (e) { toast.error(apiError(e, 'Action failed')); throw e; }
    finally { setActing(null); }
  };

  const q = search.trim().toLowerCase();
  const filtered = rows.filter(r => !q || [r.request_number, r.employee_name, r.destination, r.purpose, r.customer_name, r.travel_type]
    .some(v => String(v || '').toLowerCase().includes(q)));
  const waiting = rows.filter(r => r.can_decide).length;

  return (
    <PageShell dock={<PageHero icon={Plane} eyebrow="Travel" title="Travel Approvals"
      subtitle={filter === 'Pending' ? `${waiting} trip${waiting === 1 ? '' : 's'} waiting for your decision` : 'Trips of your team and those delegated to you'} />}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search employee, destination, purpose…" aria-label="Search" style={{ ...inputStyle, paddingLeft: 32 }} />
        </div>
        {FILTERS.map(s => (
          <button key={s} onClick={() => setFilter(s)}
            style={{ ...btn(), padding: '7px 14px', fontSize: 12, ...(filter === s ? { background: '#6B3FDB', color: '#fff', borderColor: '#6B3FDB' } : {}) }}>{s}</button>
        ))}
      </div>
      <ErrorBox>{err}</ErrorBox>
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflowX: 'auto' }}>
        {loading ? <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
          : filtered.length === 0 ? <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>{filter === 'Pending' ? 'Nothing is waiting for you.' : 'No trips found.'}</div>
          : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ background: '#f9fafb' }}>
                {['Trip #', 'Employee', 'Type / Purpose', 'Destination', 'Dates', 'Estimate', 'Advance', 'Status', ''].map(h => <th key={h} style={th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {filtered.map(r => (
                  <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ ...td, fontWeight: 600, color: '#6B3FDB', whiteSpace: 'nowrap', cursor: 'pointer' }} onClick={() => setView(r)}>{r.request_number}</td>
                    <td style={td}><div style={{ fontWeight: 500 }}>{r.employee_name}</div><div style={{ fontSize: 11, color: '#9ca3af' }}>{r.department}</div></td>
                    <td style={td}><div>{r.travel_type || '—'}</div><div style={{ fontSize: 11, color: '#6b7280', maxWidth: 220 }}>{r.purpose}</div></td>
                    <td style={td}>{r.destination}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(r.from_date)} → {fmtDate(r.to_date)}</td>
                    <td style={td}>{fmt(r.budget)}</td>
                    <td style={td}>{r.advance_required ? 'Needed' : '—'}</td>
                    <td style={td}><StatusBadge status={r.status} />{r.delegate_name && r.status === 'Pending' && <div style={{ fontSize: 10, color: '#6b7280', marginTop: 3 }}>Delegated to {r.delegate_name}</div>}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      {r.can_decide ? (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button aria-label={`Approve ${r.request_number}`} disabled={acting === r.id} onClick={() => decide(r, 'Approved').catch(() => {})} style={{ ...btn('success'), padding: '5px 10px', fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}><CheckCircle size={13} /> Approve</button>
                          <button aria-label={`Reject ${r.request_number}`} disabled={acting === r.id} onClick={() => setRejectFor(r)} style={{ ...btn('danger'), padding: '5px 10px', fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}><XCircle size={13} /> Reject</button>
                          <button aria-label={`Delegate ${r.request_number}`} title="Delegate" onClick={() => setDelegateFor(r)} style={{ ...btn(), padding: '5px 8px' }}><UserPlus size={13} /></button>
                        </div>
                      ) : r.status === 'Pending' ? <span style={{ fontSize: 11, color: '#9ca3af' }}>With {r.delegate_name || 'their manager'}</span>
                        : <span style={{ fontSize: 11, color: '#9ca3af' }}>{r.decided_by_name ? `by ${r.decided_by_name}` : ''}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      {view && (
        <Dialog title={`${view.request_number} — ${view.employee_name}`} onClose={() => setView(null)} footer={<>
          {view.can_decide && <button style={btn('danger')} onClick={() => setRejectFor(view)}>Reject</button>}
          {view.can_decide && <button style={btn('success')} onClick={() => decide(view, 'Approved').catch(() => {})}>Approve</button>}
          <button style={btn()} onClick={() => setView(null)}>Close</button>
        </>}>
          <Facts items={[
            ['Travel type', view.travel_type], ['Destination', view.destination], ['Dates', `${fmtDate(view.from_date)} → ${fmtDate(view.to_date)}`],
            ['Mode', view.mode], ['Estimated cost', fmt(view.budget)], ['Purpose', view.purpose],
            ['Customer', view.customer_name], ['Project', view.project_number], ['Site', view.site_name],
            ['Hotel needed', view.hotel_required ? 'Yes' : 'No'], ['Advance needed', view.advance_required ? 'Yes' : 'No'],
            ['Decision', view.decided_by_name ? `${view.status} by ${view.decided_by_name}${view.decision_comments ? ' — ' + view.decision_comments : ''}` : null],
            ['Cancelled because', view.cancel_reason],
          ]} />
          {view.notes && <div style={{ marginTop: 14, padding: 12, background: '#f9fafb', borderRadius: 8, fontSize: 13 }}>{view.notes}</div>}
        </Dialog>
      )}
      {rejectFor && <ReasonDialog title={`Reject ${rejectFor.request_number}?`} label="Reason (the employee sees this)" confirmLabel="Reject"
        onCancel={() => setRejectFor(null)} onConfirm={async (reason) => { await decide(rejectFor, 'Rejected', reason); setRejectFor(null); }} />}
      {delegateFor && <DelegateDialog title={`Delegate ${delegateFor.request_number}`} onCancel={() => setDelegateFor(null)}
        onPick={async (id, name) => {
          await api.post(`/travel/requests/${delegateFor.id}/delegate`, { delegate_employee_id: id });
          toast.success(`Delegated to ${name}`); setDelegateFor(null); load();
        }} />}
    </PageShell>
  );
}
