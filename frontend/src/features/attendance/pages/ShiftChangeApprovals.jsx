// Attendance → Approvals → Shift Change (§278).
//
// Employees ask for another shift from Shift Calendar, for one day or from a
// date onwards. The reporting manager or HR approves here (or in the Approval
// Center). Approving a one-day request writes a date override; "from this
// date" changes the employee's shift assignment. Who decided and when is kept.
import { useState, useEffect, useCallback } from 'react';
import { ArrowRightLeft, CheckCircle, Clock, X, RefreshCw } from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { fmtDate } from '@/utils/dateFormatter';

const P = '#6B3FDB';
const CARD = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 16 };
const STATUS = {
  pending:  { bg: '#ede9fe', color: '#5b21b6', label: 'Pending',  Icon: Clock },
  approved: { bg: '#dcfce7', color: '#166534', label: 'Approved', Icon: CheckCircle },
  rejected: { bg: '#fee2e2', color: '#991b1b', label: 'Rejected', Icon: X },
};
const t5 = (t) => (t ? String(t).slice(0, 5) : '');
const stamp = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const errText = (e) => e?.response?.data?.message || e?.response?.data?.error || 'Could not save — please try again';

export default function ShiftChangeApprovals({ embedded }) {
  const [status, setStatus] = useState('pending');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState(null);
  const [acting, setActing] = useState(null);   // { row, type }
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/attendance/shift-change-requests?status=${status}`);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setRows([]); setMsg({ type: 'error', text: errText(e) });
    } finally { setLoading(false); }
  }, [status]);
  useEffect(() => { load(); }, [load]);

  const decide = async () => {
    if (!acting) return;
    setBusy(true);
    try {
      await api.put(`/attendance/shift-change-requests/${acting.row.id}/${acting.type}`, { remarks });
      setMsg({ type: 'ok', text: acting.type === 'approve' ? 'Approved — the shift is updated' : 'Request rejected' });
      setActing(null); setRemarks('');
      load();
    } catch (e) {
      setMsg({ type: 'error', text: errText(e) });
    } finally { setBusy(false); }
  };

  const body = (
    <>
      {msg && (
        <div role={msg.type === 'error' ? 'alert' : 'status'} style={{ marginBottom: 12, padding: '10px 14px', borderRadius: 8, fontSize: 13, fontWeight: 500,
          background: msg.type === 'error' ? '#fef2f2' : '#f0fdf4', color: msg.type === 'error' ? '#dc2626' : '#16a34a',
          border: `1px solid ${msg.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>{msg.text}</div>
      )}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {Object.entries(STATUS).map(([k, v]) => (
          <button key={k} onClick={() => setStatus(k)} style={{ padding: '7px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer',
            border: `1px solid ${status === k ? P : '#e5e7eb'}`, background: status === k ? P : '#fff', color: status === k ? '#fff' : '#374151' }}>{v.label}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button className="pulse-btn-secondary" onClick={load}><RefreshCw size={13} /> Refresh</button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 48, color: '#9ca3af' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ ...CARD, textAlign: 'center', padding: 48, color: '#9ca3af', fontSize: 14 }}>
          <ArrowRightLeft size={32} color="#e5e7eb" style={{ marginBottom: 10 }} />
          <div>No {STATUS[status].label.toLowerCase()} shift-change requests</div>
        </div>
      ) : rows.map((r) => {
        const sm = STATUS[r.status] || STATUS.pending;
        return (
          <div key={r.id} style={{ ...CARD, marginBottom: 10, display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>
                {r.employee_name}{r.emp_code && <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 6, fontWeight: 400 }}>#{r.emp_code}</span>}
              </div>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>{[r.department, r.designation].filter(Boolean).join(' · ')}</div>
              <div style={{ fontSize: 13, color: '#374151' }}>
                <strong>{fmtDate(r.request_date)}</strong>{r.change_type === 'permanent' ? ' onwards' : ' (one day)'} ·{' '}
                {r.current_shift_name || 'No shift'} → <strong>{r.requested_shift_name}</strong>
                {r.requested_start && <span style={{ color: '#6b7280' }}> ({t5(r.requested_start)}–{t5(r.requested_end)})</span>}
              </div>
              {r.reason && <div style={{ fontSize: 13, color: '#374151', marginTop: 4 }}>Reason: {r.reason}</div>}
              {r.reviewed_at && (
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                  {sm.label} by {r.reviewed_by_name || '—'} · {stamp(r.reviewed_at)}{r.review_remarks ? ` — ${r.review_remarks}` : ''}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 600, background: sm.bg, color: sm.color }}>{sm.label}</span>
              {r.status === 'pending' && (
                <>
                  <button onClick={() => { setActing({ row: r, type: 'approve' }); setRemarks(''); }} style={{ padding: '5px 12px', borderRadius: 7, border: 'none', background: '#dcfce7', color: '#166534', fontWeight: 600, cursor: 'pointer', fontSize: 12 }}>Approve</button>
                  <button onClick={() => { setActing({ row: r, type: 'reject' }); setRemarks(''); }} style={{ padding: '5px 12px', borderRadius: 7, border: 'none', background: '#fee2e2', color: '#991b1b', fontWeight: 600, cursor: 'pointer', fontSize: 12 }}>Reject</button>
                </>
              )}
            </div>
          </div>
        );
      })}

      {acting && (
        <>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200 }} onClick={() => setActing(null)} />
          <div role="dialog" aria-modal="true" style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: '#fff', borderRadius: 16, padding: 24, zIndex: 201, width: 440, maxWidth: 'calc(100vw - 32px)' }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>{acting.type === 'approve' ? 'Approve shift change' : 'Reject shift change'}</div>
            <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
              {acting.row.employee_name} · {fmtDate(acting.row.request_date)}{acting.row.change_type === 'permanent' ? ' onwards' : ''} · {acting.row.requested_shift_name}
            </div>
            <textarea autoFocus rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)}
              placeholder={acting.type === 'reject' ? 'Reason for rejecting (required)…' : 'Remarks (optional)…'}
              style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13, boxSizing: 'border-box' }} />
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button className="pulse-btn-primary" style={{ flex: 1 }} disabled={busy || (acting.type === 'reject' && !remarks.trim())} onClick={decide}>
                {busy ? 'Saving…' : acting.type === 'approve' ? 'Approve' : 'Reject'}
              </button>
              <button className="pulse-btn-secondary" style={{ flex: 1 }} onClick={() => setActing(null)}>Cancel</button>
            </div>
          </div>
        </>
      )}
    </>
  );

  if (embedded) return body;
  return (
    <PageShell dock={<PageHero icon={ArrowRightLeft} eyebrow="Attendance" title="Shift Change Requests" subtitle="Approve or reject requests to work another shift" />}>
      {body}
    </PageShell>
  );
}
