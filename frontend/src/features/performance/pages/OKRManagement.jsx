import { useState, useEffect } from 'react';
import { Plus, Target, RefreshCw, AlertCircle, X, ChevronDown, ChevronUp, Edit2, Trash2, TrendingUp } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const LEVEL_COLOR = { company: '#8b5cf6', department: '#3b82f6', team: '#f59e0b', individual: '#10b981' };
const STATUS_COLOR = { draft: '#6b7280', active: '#10b981', completed: '#3b82f6', cancelled: '#ef4444', at_risk: '#f59e0b' };
const inp = { background: 'var(--color-background)', border: '1px solid var(--color-border-tertiary)', borderRadius: 8, padding: '8px 12px', fontSize: 13, width: '100%', color: 'var(--color-text-primary)' };

const BLANK_OBJ = { title: '', description: '', level: 'individual', department: '', start_date: '', end_date: '' };
const BLANK_KR  = { title: '', description: '', unit: '', start_value: 0, target_value: '', kr_type: 'metric', due_date: '' };

function ProgressBar({ pct }) {
  const p = Math.min(100, Math.max(0, parseFloat(pct) || 0));
  const color = p >= 70 ? '#10b981' : p >= 40 ? '#f59e0b' : '#ef4444';
  return (
    <div style={{ background: 'var(--color-border-tertiary)', borderRadius: 4, height: 6, overflow: 'hidden', width: '100%' }}>

      <ConfirmDialog
        open={!!pendingCancelObjective}
        title="Cancel Objective"
        message="Cancel this objective?"
        confirmLabel="Cancel"
        variant="warning"
        onConfirm={cancelObjective}
        onCancel={() => setPendingCancelObjective(null)}
      />
      <div style={{ width: `${p}%`, height: '100%', background: color, borderRadius: 4, transition: 'width 0.3s' }} />
    </div>
  );
}

export default function OKRManagement() {
  // hasAnyRole, not user.role: `role` is only the PRIMARY role of a many-to-many
  // set, so gating on it alone hid the Analytics tab (and its fetch) from anyone
  // holding manager/hr as a secondary role. See AuthContext.
  const { hasAnyRole } = useAuth();
  const isMgr = hasAnyRole('manager', 'hr', 'super_admin', 'admin');

  const [objectives, setObjectives] = useState([]);
  const [analytics, setAnalytics]   = useState(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [tab, setTab]               = useState('objectives');
  const [expanded, setExpanded]     = useState({});
  const [krData, setKRData]         = useState({});
  const [showObjForm, setShowObjForm] = useState(false);
  const [showKRForm, setShowKRForm]   = useState(null);
  const [objForm, setObjForm]         = useState(BLANK_OBJ);
  const [krForm, setKRForm]           = useState(BLANK_KR);
  const [editKR, setEditKR]           = useState(null);
  const [saving, setSaving]           = useState(false);
  const [levelFilter, setLevelFilter] = useState('');
  const [pendingCancelObjective, setPendingCancelObjective] = useState(null);
  const [progressModal, setProgressModal] = useState({ open: false, krId: null, objectiveId: null, value: '' });
  const [deptList, setDeptList] = useState([]);

  async function load() {
    setLoading(true);
    try {
      const params = levelFilter ? `?level=${levelFilter}` : '';
      const res = await api.get(`/performance/okr/objectives${params}`);
      setObjectives(res.data || []);
      if (isMgr) {
        const anaRes = await api.get('/performance/okr/analytics').catch(() => ({ data: null }));
        setAnalytics(anaRes.data);
      }
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [levelFilter]);
  useEffect(() => {
    api.get('/admin/config/departments')
      .then(r => setDeptList(Array.isArray(r.data) ? r.data.map(d => d.name || d) : []))
      .catch(() => setDeptList([]));
  }, []);

  async function loadKRs(objectiveId) {
    try {
      const res = await api.get(`/performance/okr/objectives/${objectiveId}`);
      setKRData(prev => ({ ...prev, [objectiveId]: res.data?.key_results || [] }));
    } catch { /* non-fatal */ }
  }

  function toggleExpand(id) {
    setExpanded(e => {
      const next = { ...e, [id]: !e[id] };
      if (next[id] && !krData[id]) loadKRs(id);
      return next;
    });
  }

  async function createObjective() {
    if (!objForm.title) return;
    setSaving(true);
    try {
      await api.post('/performance/okr/objectives', objForm);
      setShowObjForm(false); setObjForm(BLANK_OBJ); load();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function addKR(objectiveId) {
    if (!krForm.title || !krForm.target_value) return;
    setSaving(true);
    try {
      await api.post(`/performance/okr/objectives/${objectiveId}/key-results`, krForm);
      setShowKRForm(null); setKRForm(BLANK_KR); loadKRs(objectiveId); load();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function updateKRProgress(krId, objectiveId) {
    setProgressModal({ open: true, krId, objectiveId, value: '' });
  }

  async function confirmUpdateKRProgress() {
    const { krId, objectiveId, value } = progressModal;
    setProgressModal({ open: false, krId: null, objectiveId: null, value: '' });
    if (!krId || value === '') return;
    try {
      await api.patch(`/performance/okr/key-results/${krId}`, { current_value: parseFloat(value) });
      loadKRs(objectiveId); load();
    } catch (e) { setError(e.message); }
  }

  async function cancelObjective() {
    if (!pendingCancelObjective) return;
    const id = pendingCancelObjective;
    setPendingCancelObjective(null);
    try { await api.delete(`/performance/okr/objectives/${id}`); load(); }
    catch (e) { setError(e.message); }
  }

  return (
    <div style={{ padding: 24, margin: '0 auto' }}>

      {progressModal.open && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--color-background)', borderRadius: 12, padding: 24, width: 360, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700 }}>Update Progress</h3>
            <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--color-text-secondary)' }}>Enter current value for this key result:</p>
            <input
              autoFocus
              type="number"
              style={{ width: '100%', borderRadius: 8, border: '1px solid var(--color-border-tertiary)', padding: '8px 12px', fontSize: 13 }}
              placeholder="Current value"
              value={progressModal.value}
              onChange={e => setProgressModal(m => ({ ...m, value: e.target.value }))}
              onKeyDown={e => e.key === 'Enter' && confirmUpdateKRProgress()}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={() => setProgressModal({ open: false, krId: null, objectiveId: null, value: '' })} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--color-border-tertiary)', background: 'transparent', cursor: 'pointer' }}>Cancel</button>
              <button onClick={confirmUpdateKRProgress} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: 'var(--color-primary)', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>Update</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Target size={20} style={{ color: 'var(--color-primary)' }} /> OKR Management
        </h1>
        <button onClick={() => setShowObjForm(true)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          <Plus size={15} /> New Objective
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '1px solid var(--color-border-tertiary)' }}>
        {[{ key: 'objectives', label: 'Objectives' }, ...(isMgr ? [{ key: 'analytics', label: 'Analytics' }] : [])].map(t => (
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

      {tab === 'analytics' && analytics ? (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
            {[
              { label: 'Total Objectives', value: analytics.summary?.total_objectives },
              { label: 'Active', value: analytics.summary?.active },
              { label: 'Completed', value: analytics.summary?.completed },
              { label: 'Avg Progress', value: `${analytics.summary?.avg_progress || 0}%` },
            ].map(k => (
              <div key={k.label} style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: '16px 20px' }}>
                <p style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{k.value ?? '—'}</p>
                <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: 0 }}>{k.label}</p>
              </div>
            ))}
          </div>
          {analytics.by_department?.length > 0 && (
            <div style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 12, padding: 20 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 12px' }}>Progress by Department</h3>
              {analytics.by_department.map((d, i) => (
                <div key={i} style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 13 }}>
                    <span style={{ fontWeight: 500 }}>{d.department}</span>
                    <span style={{ color: 'var(--color-text-secondary)' }}>{d.objective_count} objectives · {d.avg_progress}%</span>
                  </div>
                  <ProgressBar pct={d.avg_progress} />
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Level filter + new objective form */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>Level:</span>
            {['', 'company', 'department', 'team', 'individual'].map(l => (
              <button key={l} onClick={() => setLevelFilter(l)} style={{
                padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: levelFilter === l ? 600 : 400, cursor: 'pointer',
                background: levelFilter === l ? 'var(--color-primary)' : 'var(--color-background-secondary)',
                color: levelFilter === l ? '#fff' : 'var(--color-text-secondary)',
                border: '0.5px solid var(--color-border-tertiary)',
              }}>{l || 'All'}</button>
            ))}
          </div>

          {showObjForm && (
            <div style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 12, padding: 20, marginBottom: 20 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 16px' }}>New Objective</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div style={{ gridColumn: '1 / -1' }}><label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Title *</label><input style={inp} value={objForm.title} onChange={e => setObjForm(f => ({ ...f, title: e.target.value }))} placeholder="e.g. Achieve 20% revenue growth" /></div>
                <div><label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Level</label>
                  <select style={inp} value={objForm.level} onChange={e => setObjForm(f => ({ ...f, level: e.target.value }))}>
                    {['individual', 'team', 'department', 'company'].map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                </div>
                <div><label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Department</label>
                  <select style={inp} value={objForm.department} onChange={e => setObjForm(f => ({ ...f, department: e.target.value }))}>
                    <option value="">All / Individual</option>
                    {deptList.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
                <div><label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Start Date</label><input type="date" style={inp} value={objForm.start_date} onChange={e => setObjForm(f => ({ ...f, start_date: e.target.value }))} /></div>
                <div><label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>End Date</label><input type="date" style={inp} value={objForm.end_date} onChange={e => setObjForm(f => ({ ...f, end_date: e.target.value }))} /></div>
                <div style={{ gridColumn: '1 / -1' }}><label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Description</label><textarea style={{ ...inp, resize: 'vertical', minHeight: 56 }} value={objForm.description} onChange={e => setObjForm(f => ({ ...f, description: e.target.value }))} /></div>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
                <button onClick={createObjective} disabled={saving} style={{ padding: '8px 20px', background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>{saving ? 'Creating...' : 'Create'}</button>
                <button onClick={() => setShowObjForm(false)} style={{ padding: '8px 20px', background: 'var(--color-background)', border: '1px solid var(--color-border-tertiary)', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              </div>
            </div>
          )}

          {loading ? (
            <div style={{ textAlign: 'center', padding: 48 }}><RefreshCw size={18} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-primary)' }} /></div>
          ) : objectives.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 48, background: 'var(--color-background-secondary)', borderRadius: 12, border: '0.5px solid var(--color-border-tertiary)', color: 'var(--color-text-secondary)' }}>
              <Target size={36} style={{ marginBottom: 12, opacity: 0.4 }} />
              <p style={{ margin: 0, fontWeight: 500 }}>No objectives yet</p>
              <p style={{ margin: '4px 0 0', fontSize: 13 }}>Create your first objective and add key results to track progress</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {objectives.map(o => {
                const lc = LEVEL_COLOR[o.level] || '#6b7280';
                const sc = STATUS_COLOR[o.status] || '#6b7280';
                const krs = krData[o.id] || [];
                const isExp = expanded[o.id];
                return (
                  <div key={o.id} style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 12, overflow: 'hidden' }}>
                    <div style={{ padding: '14px 18px', cursor: 'pointer' }} onClick={() => toggleExpand(o.id)}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                            <span style={{ background: `${lc}18`, color: lc, padding: '2px 8px', borderRadius: 12, fontSize: 10, fontWeight: 700, textTransform: 'uppercase' }}>{o.level}</span>
                            <span style={{ color: sc, fontSize: 11 }}>● {o.status}</span>
                            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{o.kr_count} KRs</span>
                          </div>
                          <p style={{ margin: '0 0 6px', fontWeight: 600, fontSize: 14 }}>{o.title}</p>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <ProgressBar pct={o.progress_pct || 0} />
                            <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>{o.progress_pct || 0}%</span>
                          </div>
                          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                            {o.owner_name} · {o.end_date?.slice(0, 10) || 'No deadline'}
                          </p>
                        </div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <button onClick={e => { e.stopPropagation(); setPendingCancelObjective(o.id); }} style={{ padding: 5, background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444' }}><Trash2 size={13} /></button>
                          {isExp ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </div>
                      </div>
                    </div>

                    {isExp && (
                      <div style={{ borderTop: '0.5px solid var(--color-border-tertiary)', padding: '12px 18px' }}>
                        {o.description && <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--color-text-secondary)' }}>{o.description}</p>}

                        <div style={{ marginBottom: 10 }}>
                          <p style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)' }}>KEY RESULTS</p>
                          {krs.map(kr => (
                            <div key={kr.id} style={{ background: 'var(--color-background)', borderRadius: 8, padding: '10px 14px', marginBottom: 8 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                                <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{kr.title}</span>
                                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                                  {kr.current_value}/{kr.target_value} {kr.unit}
                                </span>
                                <span style={{ fontSize: 12, fontWeight: 600, color: parseFloat(kr.progress_pct) >= 70 ? '#10b981' : '#f59e0b' }}>
                                  {kr.progress_pct || 0}%
                                </span>
                                <button onClick={() => updateKRProgress(kr.id, o.id)} style={{ padding: '3px 8px', background: '#3b82f618', color: '#3b82f6', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>
                                  Update
                                </button>
                              </div>
                              <ProgressBar pct={kr.progress_pct || 0} />
                            </div>
                          ))}
                        </div>

                        {showKRForm === o.id ? (
                          <div style={{ background: 'var(--color-background)', borderRadius: 8, padding: 14, marginTop: 8 }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                              <div><label style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 3 }}>Key Result *</label><input style={inp} value={krForm.title} onChange={e => setKRForm(f => ({ ...f, title: e.target.value }))} placeholder="e.g. Increase MRR to ₹50L" /></div>
                              <div><label style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 3 }}>Type</label>
                                <select style={inp} value={krForm.kr_type} onChange={e => setKRForm(f => ({ ...f, kr_type: e.target.value }))}>
                                  {['metric', 'milestone', 'boolean'].map(t => <option key={t} value={t}>{t}</option>)}
                                </select>
                              </div>
                              <div><label style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 3 }}>Target Value *</label><input type="number" style={inp} value={krForm.target_value} onChange={e => setKRForm(f => ({ ...f, target_value: e.target.value }))} /></div>
                              <div><label style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 3 }}>Unit</label><input style={inp} value={krForm.unit} onChange={e => setKRForm(f => ({ ...f, unit: e.target.value }))} placeholder="%, ₹L, units..." /></div>
                              <div><label style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 3 }}>Due Date</label><input type="date" style={inp} value={krForm.due_date} onChange={e => setKRForm(f => ({ ...f, due_date: e.target.value }))} /></div>
                            </div>
                            <div style={{ display: 'flex', gap: 8 }}>
                              <button onClick={() => addKR(o.id)} disabled={saving} style={{ padding: '6px 16px', background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>{saving ? '...' : 'Add KR'}</button>
                              <button onClick={() => setShowKRForm(null)} style={{ padding: '6px 12px', background: 'none', border: '1px solid var(--color-border-tertiary)', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <button onClick={() => setShowKRForm(o.id)} style={{ padding: '6px 14px', background: 'var(--color-background)', border: '1px solid var(--color-border-tertiary)', borderRadius: 8, cursor: 'pointer', fontSize: 12, color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
                            <Plus size={12} /> Add Key Result
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
