import { useState, useEffect } from 'react';
import { Plus, CheckCircle, X, AlertCircle, RefreshCw, IndianRupee, TrendingUp, Upload } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const STATUS_COLOR = {
  draft:     { bg: '#6b728018', text: '#6b7280' },
  submitted: { bg: '#f59e0b18', text: '#f59e0b' },
  approved:  { bg: '#10b98118', text: '#10b981' },
  rejected:  { bg: '#ef444418', text: '#ef4444' },
  processed: { bg: '#3b82f618', text: '#3b82f6' },
};

const inp = { background: 'var(--color-background)', border: '1px solid var(--color-border-tertiary)', borderRadius: 8, padding: '8px 12px', fontSize: 13, width: '100%', color: 'var(--color-text-primary)' };

export default function IncrementPlanning() {
  // hasAnyRole, not user.role: `role` is only the PRIMARY role of a many-to-many
  // set, so gating on it alone hid the Budget Summary tab (and its fetch) from
  // anyone holding hr as a secondary role. See AuthContext.
  const { hasAnyRole } = useAuth();
  const isHR  = hasAnyRole('hr', 'super_admin', 'admin');
  const isMgr = hasAnyRole('manager', 'hr', 'super_admin', 'admin');

  const [tab, setTab]         = useState('recommendations');
  const [recs, setRecs]       = useState([]);
  const [bands, setBands]     = useState([]);
  const [budget, setBudget]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [processing, setProcessing] = useState(null);
  const [pendingPushPayroll, setPendingPushPayroll] = useState(null);
  const [rejectModal, setRejectModal] = useState({ open: false, id: null, reason: '' });

  async function load() {
    setLoading(true);
    try {
      const [recsRes, bandsRes] = await Promise.allSettled([
        api.get('/performance/increments/recommendations'),
        api.get('/performance/increments/bands'),
      ]);
      if (recsRes.status === 'fulfilled') setRecs(recsRes.value.data || []);
      if (bandsRes.status === 'fulfilled') setBands(bandsRes.value.data || []);
      if (isHR) {
        const budRes = await api.get('/performance/increments/budget-summary').catch(() => ({ data: [] }));
        setBudget(budRes.data || []);
      }
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  async function approve(id) {
    setProcessing(id);
    try { await api.patch(`/performance/increments/recommendations/${id}/approve`); load(); }
    catch (e) { setError(e.message); }
    finally { setProcessing(null); }
  }

  async function reject(id) {
    setRejectModal({ open: true, id, reason: '' });
  }

  async function confirmReject() {
    const { id, reason } = rejectModal;
    setRejectModal({ open: false, id: null, reason: '' });
    if (!id) return;
    setProcessing(id);
    try { await api.patch(`/performance/increments/recommendations/${id}/reject`, { rejection_reason: reason }); load(); }
    catch (e) { setError(e.message); }
    finally { setProcessing(null); }
  }

  async function pushPayroll() {
    if (!pendingPushPayroll) return;
    const id = pendingPushPayroll;
    setPendingPushPayroll(null);
    setProcessing(id);
    try { await api.post(`/performance/increments/recommendations/${id}/push-payroll`); load(); }
    catch (e) { setError(e.message); }
    finally { setProcessing(null); }
  }

  const tabs = [
    { key: 'recommendations', label: 'Recommendations' },
    { key: 'bands', label: 'Increment Bands' },
    ...(isHR ? [{ key: 'budget', label: 'Budget Summary' }] : []),
  ];

  return (
    <div style={{ padding: 24 }}>

      <ConfirmDialog
        open={!!pendingPushPayroll}
        title="Push to Payroll"
        message="Push this approved increment to payroll? This will update the employee salary structure."
        confirmLabel="Push"
        variant="warning"
        onConfirm={pushPayroll}
        onCancel={() => setPendingPushPayroll(null)}
      />

      {rejectModal.open && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--color-background)', borderRadius: 12, padding: 24, width: 400, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700 }}>Rejection Reason</h3>
            <textarea
              autoFocus
              rows={3}
              style={{ width: '100%', borderRadius: 8, border: '1px solid var(--color-border-tertiary)', padding: '8px 12px', fontSize: 13, resize: 'vertical' }}
              placeholder="Enter reason for rejection..."
              value={rejectModal.reason}
              onChange={e => setRejectModal(m => ({ ...m, reason: e.target.value }))}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={() => setRejectModal({ open: false, id: null, reason: '' })} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--color-border-tertiary)', background: 'transparent', cursor: 'pointer' }}>Cancel</button>
              <button onClick={confirmReject} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#ef4444', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>Reject</button>
            </div>
          </div>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <TrendingUp size={20} style={{ color: 'var(--color-primary)' }} /> Increment Planning
        </h1>
      </div>

      <div style={{ display: 'flex', gap: 0, marginBottom: 24, borderBottom: '1px solid var(--color-border-tertiary)' }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '8px 20px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 13,
            fontWeight: tab === t.key ? 600 : 400,
            color: tab === t.key ? 'var(--color-primary)' : 'var(--color-text-secondary)',
            borderBottom: tab === t.key ? '2px solid var(--color-primary)' : '2px solid transparent',
            marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>

      {error && (
        <div style={{ background: '#ef444418', color: '#ef4444', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertCircle size={15} /> {error}
          <button onClick={() => setError(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444' }}><X size={14} /></button>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 48 }}><RefreshCw size={18} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-primary)' }} /></div>
      ) : tab === 'recommendations' ? (
        recs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 48, background: 'var(--color-background-secondary)', borderRadius: 12, border: '0.5px solid var(--color-border-tertiary)', color: 'var(--color-text-secondary)' }}>
            <IndianRupee size={36} style={{ marginBottom: 12, opacity: 0.4 }} />
            <p style={{ margin: 0, fontWeight: 500 }}>No increment recommendations yet</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border-tertiary)' }}>
                  {['Employee', 'Department', 'Current CTC', 'Increment %', 'New CTC', 'Effective Date', 'Status', 'Actions'].map(h => (
                    <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--color-text-secondary)', fontSize: 12, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recs.map(r => {
                  const sc = STATUS_COLOR[r.status] || STATUS_COLOR.draft;
                  const incPct = r.final_increment_pct || r.recommended_increment_pct;
                  const newCTC = r.final_new_ctc || r.recommended_new_ctc;
                  return (
                    <tr key={r.id} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                      <td style={{ padding: '10px 12px', fontWeight: 500 }}>{r.employee_name}</td>
                      <td style={{ padding: '10px 12px', color: 'var(--color-text-secondary)' }}>{r.department}</td>
                      <td style={{ padding: '10px 12px' }}>{r.current_ctc ? `₹${Number(r.current_ctc).toLocaleString('en-IN')}` : '—'}</td>
                      <td style={{ padding: '10px 12px' }}>
                        <span style={{ background: '#10b98118', color: '#10b981', padding: '2px 8px', borderRadius: 12, fontWeight: 600, fontSize: 12 }}>
                          {incPct ? `${incPct}%` : '—'}
                        </span>
                      </td>
                      <td style={{ padding: '10px 12px', fontWeight: 500 }}>{newCTC ? `₹${Number(newCTC).toLocaleString('en-IN')}` : '—'}</td>
                      <td style={{ padding: '10px 12px', color: 'var(--color-text-secondary)' }}>{r.effective_date?.slice(0, 10) || '—'}</td>
                      <td style={{ padding: '10px 12px' }}>
                        <span style={{ background: sc.bg, color: sc.text, padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600 }}>{r.status}</span>
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          {isHR && r.status === 'submitted' && (
                            <>
                              <button onClick={() => approve(r.id)} disabled={processing === r.id} style={{ padding: '4px 10px', background: '#10b98118', color: '#10b981', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                                Approve
                              </button>
                              <button onClick={() => reject(r.id)} disabled={processing === r.id} style={{ padding: '4px 10px', background: '#ef444418', color: '#ef4444', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11 }}>
                                Reject
                              </button>
                            </>
                          )}
                          {isHR && r.status === 'approved' && !r.payroll_synced && (
                            <button onClick={() => setPendingPushPayroll(r.id)} disabled={processing === r.id} style={{ padding: '4px 10px', background: '#3b82f618', color: '#3b82f6', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                              <Upload size={11} /> Push to Payroll
                            </button>
                          )}
                          {r.status === 'processed' && (
                            <span style={{ fontSize: 11, color: '#10b981', display: 'flex', alignItems: 'center', gap: 4 }}>
                              <CheckCircle size={11} /> In Payroll
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : tab === 'bands' ? (
        bands.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 48, background: 'var(--color-background-secondary)', borderRadius: 12, border: '0.5px solid var(--color-border-tertiary)', color: 'var(--color-text-secondary)' }}>
            <p style={{ margin: 0 }}>No increment bands configured</p>
            {isHR && <p style={{ margin: '4px 0 0', fontSize: 13 }}>Use the API to create increment bands for each rating range</p>}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border-tertiary)' }}>
                  {['Band Name', 'Rating From', 'Rating To', 'Min Increment %', 'Max Increment %', 'Default %'].map(h => (
                    <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--color-text-secondary)', fontSize: 12 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {bands.map(b => (
                  <tr key={b.id} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                    <td style={{ padding: '10px 12px', fontWeight: 500 }}>{b.band_name}</td>
                    <td style={{ padding: '10px 12px' }}>{b.rating_from}</td>
                    <td style={{ padding: '10px 12px' }}>{b.rating_to}</td>
                    <td style={{ padding: '10px 12px' }}>{b.increment_pct_min}%</td>
                    <td style={{ padding: '10px 12px' }}>{b.increment_pct_max}%</td>
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{ background: '#3b82f618', color: '#3b82f6', padding: '2px 8px', borderRadius: 12, fontWeight: 600, fontSize: 12 }}>{b.increment_pct_default}%</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        /* Budget Summary */
        budget.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 48, background: 'var(--color-background-secondary)', borderRadius: 12, border: '0.5px solid var(--color-border-tertiary)', color: 'var(--color-text-secondary)' }}>
            <p style={{ margin: 0 }}>No budget data yet</p>
          </div>
        ) : (
          <>
            <div style={{ overflowX: 'auto', marginBottom: 16 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--color-border-tertiary)' }}>
                    {['Department', 'Headcount', 'Avg Increment %', 'Total Current CTC', 'Total New CTC', 'Increment Cost'].map(h => (
                      <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--color-text-secondary)', fontSize: 12 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {budget.map((b, i) => (
                    <tr key={i} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                      <td style={{ padding: '10px 12px', fontWeight: 500 }}>{b.department || '—'}</td>
                      <td style={{ padding: '10px 12px' }}>{b.headcount}</td>
                      <td style={{ padding: '10px 12px' }}>
                        <span style={{ background: '#10b98118', color: '#10b981', padding: '2px 8px', borderRadius: 12, fontWeight: 600, fontSize: 12 }}>{b.avg_increment_pct}%</span>
                      </td>
                      <td style={{ padding: '10px 12px' }}>{b.total_current_ctc ? `₹${Number(b.total_current_ctc).toLocaleString('en-IN')}` : '—'}</td>
                      <td style={{ padding: '10px 12px' }}>{b.total_new_ctc ? `₹${Number(b.total_new_ctc).toLocaleString('en-IN')}` : '—'}</td>
                      <td style={{ padding: '10px 12px', fontWeight: 600, color: '#ef4444' }}>
                        {b.total_increment_cost ? `₹${Number(b.total_increment_cost).toLocaleString('en-IN')}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: '12px 20px', display: 'flex', gap: 32 }}>
              <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
                Total Increment Cost: <strong style={{ color: '#ef4444', fontSize: 15 }}>
                  ₹{Number(budget.reduce((s, b) => s + parseFloat(b.total_increment_cost || 0), 0)).toLocaleString('en-IN')}
                </strong>
              </span>
              <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
                Total Employees: <strong style={{ color: 'var(--color-text-primary)', fontSize: 15 }}>
                  {budget.reduce((s, b) => s + (b.headcount || 0), 0)}
                </strong>
              </span>
            </div>
          </>
        )
      )}
    </div>
  );
}
