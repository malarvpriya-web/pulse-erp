import { useState, useEffect, useRef } from 'react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { CheckCircle, XCircle, Clock, Search } from 'lucide-react';

export default function TimesheetApprovals() {
  const toast    = useToast();
  const { user } = useAuth();
  const [sheets,  setSheets]  = useState([]);
  const [loading, setLoading] = useState(false);
  const [search,  setSearch]  = useState('');
  const [acting,  setActing]  = useState(null);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const load = () => {
    setLoading(true);
    // Use dedicated approvals endpoint — lowercase 'submitted' matches DB constraint
    api.get('/timesheets/approvals')
      .then(r => {
        if (!isMounted.current) return;
        const data = Array.isArray(r.data) ? r.data
                   : Array.isArray(r.data?.data) ? r.data.data
                   : [];
        setSheets(data);
      })
      .catch(() => { if (isMounted.current) setSheets([]); })
      .finally(() => { if (isMounted.current) setLoading(false); });
  };
  useEffect(() => { load(); }, []);

  const act = async (id, action) => {
    setActing(id);
    try {
      const approvedBy = user?.employee_id ?? user?.id;
      if (action === 'approved') {
        await api.post('/timesheets/timesheets/approve', { ids: [id], approved_by: approvedBy });
      } else {
        await api.post('/timesheets/timesheets/reject', { ids: [id], approved_by: approvedBy, reason: '' });
      }
      if (!isMounted.current) return;
      load();
      toast.success(`Timesheet ${action === 'approved' ? 'approved' : 'rejected'} successfully`);
    } catch (err) {
      if (isMounted.current) toast.error(err.response?.data?.error || 'Action failed. Please try again.');
    } finally {
      if (isMounted.current) setActing(null);
    }
  };

  const filtered = sheets.filter(s =>
    !search || [s.employee_name, s.week_start, s.work_date, s.project_name]
      .some(v => (v ?? '').toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Timesheet Approvals</h1>
        <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>
          {filtered.length} timesheet{filtered.length !== 1 ? 's' : ''} pending review
        </p>
      </div>

      <div style={{ position: 'relative', marginBottom: 20, maxWidth: 340 }}>
        <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search employee, project…"
          style={{ width: '100%', paddingLeft: 32, paddingRight: 12, paddingTop: 8, paddingBottom: 8,
                   border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
      </div>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Employee', 'Date / Week', 'Project', 'Hours', 'Status', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600,
                                       color: '#374151', borderBottom: '1px solid #f0f0f4' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
                    <Clock size={32} color="#d1d5db" style={{ display: 'block', margin: '0 auto 8px' }} />
                    <p style={{ margin: 0 }}>No timesheets pending approval</p>
                  </td>
                </tr>
              ) : filtered.map((s, i) => (
                <tr key={s.id} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                  <td style={{ padding: '10px 16px', fontWeight: 500, color: '#1f2937' }}>
                    {s.employee_name ?? '—'}
                  </td>
                  <td style={{ padding: '10px 16px', color: '#374151' }}>
                    {s.week_start
                      ? `${s.week_start.slice(0, 10)} → ${(s.week_end ?? '').slice(0, 10)}`
                      : s.work_date?.slice(0, 10) ?? '—'}
                  </td>
                  <td style={{ padding: '10px 16px', color: '#6b7280' }}>
                    {s.project_name ?? '—'}
                  </td>
                  <td style={{ padding: '10px 16px', fontWeight: 600, color: '#1f2937' }}>
                    {parseFloat(s.hours_worked ?? s.total_hours ?? 0).toFixed(1)}h
                  </td>
                  <td style={{ padding: '10px 16px' }}>
                    <span style={{ background: '#fef3c7', color: '#92400e', padding: '3px 10px',
                                   borderRadius: 20, fontSize: 11, fontWeight: 600 }}>
                      {s.status ?? 'submitted'}
                    </span>
                  </td>
                  <td style={{ padding: '10px 16px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => act(s.id, 'approved')} disabled={acting === s.id}
                        title="Approve" aria-label="Approve timesheet"
                        style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 10px',
                                 background: '#d1fae5', color: '#065f46', border: 'none', borderRadius: 6,
                                 cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                        <CheckCircle size={13} /> Approve
                      </button>
                      <button onClick={() => act(s.id, 'rejected')} disabled={acting === s.id}
                        title="Reject" aria-label="Reject timesheet"
                        style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 10px',
                                 background: '#fee2e2', color: '#991b1b', border: 'none', borderRadius: 6,
                                 cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                        <XCircle size={13} /> Reject
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
