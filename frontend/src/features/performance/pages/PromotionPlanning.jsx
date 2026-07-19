import { useState, useEffect } from 'react';
import { RefreshCw, AlertCircle, X, Award, CheckCircle, Users } from 'lucide-react';
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

export default function PromotionPlanning() {
  // hasAnyRole, not user.role: `role` is only the PRIMARY role of a many-to-many
  // set, so gating on it alone hid the Eligibility Check tab (and its fetch) from
  // anyone holding hr as a secondary role. See AuthContext.
  const { hasAnyRole } = useAuth();
  const isHR  = hasAnyRole('hr', 'super_admin', 'admin');
  const isMgr = hasAnyRole('manager', 'hr', 'super_admin', 'admin');

  const [tab, setTab]             = useState('pipeline');
  const [promos, setPromos]       = useState([]);
  const [eligible, setEligible]   = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [processing, setProcessing] = useState(null);
  const [pendingProcess, setPendingProcess] = useState(null);
  const [rejectModal, setRejectModal] = useState({ open: false, id: null, reason: '' });

  async function load() {
    setLoading(true);
    try {
      const promRes = await api.get('/performance/promotions');
      setPromos(promRes.data || []);
      if (isHR) {
        const eligRes = await api.get('/performance/promotions/eligibility/check?min_rating=4').catch(() => ({ data: [] }));
        setEligible(eligRes.data || []);
      }
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  async function approve(id) {
    setProcessing(id);
    try { await api.patch(`/performance/promotions/${id}/approve`); load(); }
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
    try { await api.patch(`/performance/promotions/${id}/reject`, { rejection_reason: reason }); load(); }
    catch (e) { setError(e.message); }
    finally { setProcessing(null); }
  }

  async function process() {
    if (!pendingProcess) return;
    const id = pendingProcess;
    setPendingProcess(null);
    setProcessing(id);
    try { await api.post(`/performance/promotions/${id}/process`); load(); }
    catch (e) { setError(e.message); }
    finally { setProcessing(null); }
  }

  const tabs = [
    { key: 'pipeline', label: 'Promotion Pipeline' },
    ...(isHR ? [{ key: 'eligibility', label: 'Eligibility Check' }] : []),
  ];

  return (
    <div style={{ padding: 24 }}>

      <ConfirmDialog
        open={!!pendingProcess}
        title="Apply Promotion"
        message="Apply this promotion to the employee record? This will update designation and grade."
        confirmLabel="Apply"
        variant="warning"
        onConfirm={process}
        onCancel={() => setPendingProcess(null)}
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
          <Award size={20} style={{ color: 'var(--color-primary)' }} /> Promotion Planning
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
      ) : tab === 'pipeline' ? (
        promos.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 48, background: 'var(--color-background-secondary)', borderRadius: 12, border: '0.5px solid var(--color-border-tertiary)', color: 'var(--color-text-secondary)' }}>
            <Award size={36} style={{ marginBottom: 12, opacity: 0.4 }} />
            <p style={{ margin: 0, fontWeight: 500 }}>No promotion recommendations yet</p>
            <p style={{ margin: '4px 0 0', fontSize: 13 }}>Managers can submit promotion recommendations from the appraisal review screen</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {promos.map(p => {
              const sc = STATUS_COLOR[p.status] || STATUS_COLOR.draft;
              return (
                <div key={p.id} style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 12, padding: '16px 20px' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text-primary)' }}>{p.employee_name}</span>
                        <span style={{ background: sc.bg, color: sc.text, padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600 }}>{p.status}</span>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8, fontSize: 13 }}>
                        <div>
                          <span style={{ color: 'var(--color-text-secondary)', fontSize: 11 }}>Department</span>
                          <p style={{ margin: 0, fontWeight: 500 }}>{p.department}</p>
                        </div>
                        <div>
                          <span style={{ color: 'var(--color-text-secondary)', fontSize: 11 }}>Current Designation</span>
                          <p style={{ margin: 0, fontWeight: 500 }}>{p.current_designation || '—'}</p>
                        </div>
                        <div>
                          <span style={{ color: 'var(--color-text-secondary)', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>Proposed Designation →</span>
                          <p style={{ margin: 0, fontWeight: 600, color: '#10b981' }}>{p.proposed_designation}</p>
                        </div>
                        {p.current_grade && (
                          <div>
                            <span style={{ color: 'var(--color-text-secondary)', fontSize: 11 }}>Grade Change</span>
                            <p style={{ margin: 0, fontWeight: 500 }}>{p.current_grade} → <strong style={{ color: '#10b981' }}>{p.proposed_grade || '—'}</strong></p>
                          </div>
                        )}
                        {p.performance_rating && (
                          <div>
                            <span style={{ color: 'var(--color-text-secondary)', fontSize: 11 }}>Performance Rating</span>
                            <p style={{ margin: 0, fontWeight: 600 }}>{p.performance_rating} / 5</p>
                          </div>
                        )}
                        {p.effective_date && (
                          <div>
                            <span style={{ color: 'var(--color-text-secondary)', fontSize: 11 }}>Effective Date</span>
                            <p style={{ margin: 0, fontWeight: 500 }}>{p.effective_date?.slice(0, 10)}</p>
                          </div>
                        )}
                      </div>
                      {p.justification && (
                        <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>{p.justification}</p>
                      )}
                      {p.rejection_reason && (
                        <p style={{ margin: '8px 0 0', fontSize: 13, color: '#ef4444' }}>Rejection: {p.rejection_reason}</p>
                      )}
                    </div>

                    {isHR && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {p.status === 'submitted' && (
                          <>
                            <button onClick={() => approve(p.id)} disabled={processing === p.id} style={{ padding: '6px 14px', background: '#10b98118', color: '#10b981', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Approve</button>
                            <button onClick={() => reject(p.id)} disabled={processing === p.id} style={{ padding: '6px 14px', background: '#ef444418', color: '#ef4444', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Reject</button>
                          </>
                        )}
                        {p.status === 'approved' && !p.grade_updated && (
                          <button onClick={() => setPendingProcess(p.id)} disabled={processing === p.id} style={{ padding: '6px 14px', background: '#3b82f618', color: '#3b82f6', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Apply Promotion</button>
                        )}
                        {p.status === 'processed' && (
                          <span style={{ fontSize: 11, color: '#10b981', display: 'flex', alignItems: 'center', gap: 4 }}><CheckCircle size={11} /> Applied</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : (
        /* Eligibility Check */
        eligible.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 48, background: 'var(--color-background-secondary)', borderRadius: 12, border: '0.5px solid var(--color-border-tertiary)', color: 'var(--color-text-secondary)' }}>
            <Users size={36} style={{ marginBottom: 12, opacity: 0.4 }} />
            <p style={{ margin: 0 }}>No employees meet the promotion eligibility criteria (Rating ≥ 4.0)</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 12 }}>Showing employees with average rating ≥ 4.0 across completed reviews</p>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border-tertiary)' }}>
                  {['Employee', 'Department', 'Designation', 'Grade', 'Avg Rating', 'Reviews', 'Years in Company', 'Recommended?'].map(h => (
                    <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--color-text-secondary)', fontSize: 12, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {eligible.map((e, i) => (
                  <tr key={i} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                    <td style={{ padding: '10px 12px', fontWeight: 500 }}>{e.name}</td>
                    <td style={{ padding: '10px 12px', color: 'var(--color-text-secondary)' }}>{e.department}</td>
                    <td style={{ padding: '10px 12px', color: 'var(--color-text-secondary)' }}>{e.designation}</td>
                    <td style={{ padding: '10px 12px', color: 'var(--color-text-secondary)' }}>{e.grade || '—'}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{ background: '#10b98118', color: '#10b981', padding: '2px 8px', borderRadius: 12, fontWeight: 600, fontSize: 12 }}>{e.avg_rating}</span>
                    </td>
                    <td style={{ padding: '10px 12px' }}>{e.review_count}</td>
                    <td style={{ padding: '10px 12px' }}>{e.years_with_company ? `${Number(e.years_with_company).toFixed(1)} yrs` : '—'}</td>
                    <td style={{ padding: '10px 12px' }}>
                      {e.already_recommended ? (
                        <span style={{ fontSize: 11, color: '#10b981', display: 'flex', alignItems: 'center', gap: 4 }}><CheckCircle size={11} /> Recommended</span>
                      ) : (
                        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>Not yet</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
