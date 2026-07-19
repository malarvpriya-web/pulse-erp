// frontend/src/features/hr/pages/EmployeeSuccessionPools.jsx
import React, { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const INP = { width: '100%', boxSizing: 'border-box', padding: '7px 10px',
              border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 };
const LBL = { fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 };
const BTN = (v = 'primary', sm = false) => ({
  border: 'none', borderRadius: 7, cursor: 'pointer', fontWeight: 600,
  fontSize: sm ? 12 : 13, padding: sm ? '4px 10px' : '8px 18px',
  background: v === 'primary' ? '#6B3FDB' : v === 'danger' ? '#ef4444' : v === 'ghost' ? 'none' : '#e9e4ff',
  color: v === 'primary' ? '#fff' : v === 'danger' ? '#fff' : v === 'ghost' ? '#6b7280' : '#6B3FDB',
  ...(v === 'outline' ? { border: '1px solid #6B3FDB', background: 'none', color: '#6B3FDB' } : {}),
  ...(v === 'danger-outline' ? { border: '1px solid #ef4444', background: 'none', color: '#ef4444' } : {}),
});

const POOL_TYPES = ['leadership', 'technical', 'hipo', 'project_leaders', 'graduate', 'general'];
const TYPE_META  = {
  leadership:      { label: 'Leadership',      color: '#6B3FDB', bg: '#ede9fe' },
  technical:       { label: 'Technical',       color: '#0891b2', bg: '#ecfeff' },
  hipo:            { label: 'High Potential',  color: '#d97706', bg: '#fffbeb' },
  project_leaders: { label: 'Project Leaders', color: '#16a34a', bg: '#f0fdf4' },
  graduate:        { label: 'Graduate',        color: '#2563eb', bg: '#eff6ff' },
  general:         { label: 'General',         color: '#6b7280', bg: '#f9fafb' },
};

const RISK_COLORS = { high: '#dc2626', medium: '#d97706', low: '#16a34a' };
const READY_LABELS = { 'ready-now': 'Ready Now', '1-2-years': '1-2 Yrs', '3-5-years': '3-5 Yrs', 'not_ready': 'Not Ready' };

function Spinner() {
  return (
    <div style={{ textAlign: 'center', padding: 48 }}>
      <style>{`@keyframes _spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ display: 'inline-block', width: 36, height: 36, border: '3px solid #e9e4ff',
                    borderTopColor: '#6B3FDB', borderRadius: '50%', animation: '_spin .75s linear infinite' }} />
    </div>
  );
}

const POOL_DEFAULT = { pool_name: '', pool_type: 'general', description: '', department: '' };

export default function EmployeeSuccessionPools() {
  const [pools,     setPools]     = useState([]);
  const [members,   setMembers]   = useState([]);
  const [employees, setEmployees] = useState([]);
  const [deptList,  setDeptList]  = useState([]);
  const [selPool,   setSelPool]   = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [saving,    setSaving]    = useState(false);
  const [msg,       setMsg]       = useState({ text: '', type: '' });

  const [showPoolForm, setShowPoolForm] = useState(false);
  const [editPoolId,   setEditPoolId]   = useState(null);
  const [poolForm,     setPoolForm]     = useState(POOL_DEFAULT);
  const [showAddMember, setShowAddMember] = useState(false);
  const [addEmpId,      setAddEmpId]     = useState('');
  const [addNotes,      setAddNotes]     = useState('');
  const [pendingDeletePool,    setPendingDeletePool]    = useState(null);
  const [pendingRemoveMember,  setPendingRemoveMember]  = useState(null);

  const flash = (text, type = 'success') => {
    setMsg({ text, type });
    setTimeout(() => setMsg({ text: '', type: '' }), 3500);
  };

  const loadPools = useCallback(async () => {
    try {
      const r = await api.get('/succession/pools');
      setPools(r.data || []);
    } catch { setPools([]); }
    setLoading(false);
  }, []);

  useEffect(() => { loadPools(); }, [loadPools]);
  useEffect(() => {
    api.get('/employees?status=active').then(r => setEmployees(r.data || [])).catch(() => {});
    api.get('/admin/config/departments')
      .then(r => setDeptList(Array.isArray(r.data) ? r.data.map(d => d.name || d) : []))
      .catch(() => setDeptList([]));
  }, []);

  const loadMembers = async (poolId) => {
    try {
      const r = await api.get(`/succession/pools/${poolId}/members`);
      setMembers(r.data || []);
    } catch { setMembers([]); }
  };

  const selectPool = (pool) => {
    setSelPool(pool);
    loadMembers(pool.id);
    setShowAddMember(false);
    setAddEmpId('');
    setAddNotes('');
  };

  /* ── Pool CRUD ── */
  const submitPool = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editPoolId) {
        await api.patch(`/succession/pools/${editPoolId}`, poolForm);
        flash('Pool updated');
      } else {
        const r = await api.post('/succession/pools', poolForm);
        flash('Pool created');
        selectPool(r.data);
      }
      setShowPoolForm(false);
      setEditPoolId(null);
      setPoolForm(POOL_DEFAULT);
      loadPools();
    } catch (err) {
      flash(err.response?.data?.message || 'Failed', 'error');
    } finally { setSaving(false); }
  };

  const deletePool = async () => {
    if (!pendingDeletePool) return;
    const id = pendingDeletePool;
    setPendingDeletePool(null);
    try {
      await api.delete(`/succession/pools/${id}`);
      if (selPool?.id === id) { setSelPool(null); setMembers([]); }
      loadPools();
      flash('Pool deleted');
    } catch (err) { flash(err.response?.data?.message || 'Failed', 'error'); }
  };

  /* ── Member management ── */
  const addMember = async (e) => {
    e.preventDefault();
    if (!addEmpId) return;
    setSaving(true);
    try {
      await api.post(`/succession/pools/${selPool.id}/members`, {
        employee_id: parseInt(addEmpId), notes: addNotes || null,
      });
      flash('Member added');
      setAddEmpId('');
      setAddNotes('');
      setShowAddMember(false);
      loadMembers(selPool.id);
      loadPools();
    } catch (err) {
      flash(err.response?.data?.message || 'Already a member or failed', 'error');
    } finally { setSaving(false); }
  };

  const removeMember = async () => {
    if (!pendingRemoveMember) return;
    const { employeeId, name } = pendingRemoveMember;
    setPendingRemoveMember(null);
    try {
      await api.delete(`/succession/pools/${selPool.id}/members/${employeeId}`);
      flash('Removed');
      loadMembers(selPool.id);
      loadPools();
    } catch (err) { flash(err.response?.data?.message || 'Failed', 'error'); }
  };

  const memberIds  = new Set(members.map(m => m.employee_id));
  const available  = employees.filter(e => !memberIds.has(e.id));

  if (loading) return <div style={{ padding: 24 }}><Spinner /></div>;

  return (
    <div style={{ padding: 24, background: '#f5f3ff', minHeight: '100vh' }}>
      <ConfirmDialog
        open={!!pendingDeletePool}
        title="Delete Pool"
        message="Delete this pool and remove all its members?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deletePool}
        onCancel={() => setPendingDeletePool(null)}
      />
      <ConfirmDialog
        open={!!pendingRemoveMember}
        title="Remove Member"
        message={pendingRemoveMember ? `Remove ${pendingRemoveMember.name} from this pool?` : ''}
        confirmLabel="Remove"
        variant="warning"
        onConfirm={removeMember}
        onCancel={() => setPendingRemoveMember(null)}
      />
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, color: '#4c1d95', fontSize: 22 }}>Talent Pools</h2>
        <p style={{ margin: 0, color: '#6b7280', fontSize: 13, marginTop: 4 }}>
          Employee-based talent pools for succession planning (not recruitment pools)
        </p>
      </div>

      {msg.text && (
        <div style={{ marginBottom: 12, padding: '10px 16px', borderRadius: 8, fontWeight: 500, fontSize: 14,
                      background: msg.type === 'error' ? '#fef2f2' : '#f0fdf4',
                      color:      msg.type === 'error' ? '#dc2626' : '#16a34a',
                      border:     `1px solid ${msg.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>
          {msg.text}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: selPool ? '300px 1fr' : '1fr', gap: 20 }}>

        {/* ── Left: pool list ── */}
        <div>
          <div style={{ marginBottom: 12 }}>
            <button style={BTN(showPoolForm ? 'secondary' : 'primary', true)}
              onClick={() => { setShowPoolForm(!showPoolForm); setEditPoolId(null); setPoolForm(POOL_DEFAULT); }}>
              {showPoolForm ? 'X Cancel' : '+ New Pool'}
            </button>
          </div>

          {showPoolForm && (
            <form onSubmit={submitPool}
              style={{ background: '#fff', borderRadius: 10, padding: 16, marginBottom: 16,
                       border: '1px solid #e9e4ff' }}>
              <h4 style={{ margin: '0 0 12px', color: '#4c1d95', fontSize: 14 }}>
                {editPoolId ? 'Edit Pool' : 'New Talent Pool'}
              </h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <label style={LBL}>Pool Name *</label>
                  <input required value={poolForm.pool_name}
                    onChange={e => setPoolForm(f => ({ ...f, pool_name: e.target.value }))}
                    placeholder="e.g. Future Leaders 2027"
                    style={INP} />
                </div>
                <div>
                  <label style={LBL}>Type</label>
                  <select value={poolForm.pool_type}
                    onChange={e => setPoolForm(f => ({ ...f, pool_type: e.target.value }))}
                    style={INP}>
                    {POOL_TYPES.map(t => (
                      <option key={t} value={t}>{TYPE_META[t]?.label || t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={LBL}>Department (optional)</label>
                  <select value={poolForm.department}
                    onChange={e => setPoolForm(f => ({ ...f, department: e.target.value }))}
                    style={INP}>
                    <option value="">All Departments</option>
                    {deptList.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
                <div>
                  <label style={LBL}>Description</label>
                  <input value={poolForm.description}
                    onChange={e => setPoolForm(f => ({ ...f, description: e.target.value }))}
                    placeholder="Purpose of this pool..."
                    style={INP} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button type="submit" disabled={saving} style={BTN('primary', true)}>
                  {saving ? 'Saving...' : editPoolId ? 'Update' : 'Create'}
                </button>
                <button type="button"
                  onClick={() => { setShowPoolForm(false); setEditPoolId(null); }}
                  style={BTN('ghost', true)}>Cancel</button>
              </div>
            </form>
          )}

          {pools.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 16px', color: '#9ca3af', fontSize: 13 }}>
              No talent pools yet.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {pools.map(pool => {
                const meta  = TYPE_META[pool.pool_type] || TYPE_META.general;
                const isAct = selPool?.id === pool.id;
                return (
                  <div key={pool.id}
                    style={{ background: '#fff', borderRadius: 10, padding: 14, cursor: 'pointer',
                             border: `2px solid ${isAct ? meta.color : '#e9e4ff'}`,
                             transition: 'border-color .15s' }}
                    onClick={() => selectPool(pool)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 13, color: '#1f2937',
                                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {pool.pool_name}
                        </div>
                        <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 8,
                                         background: meta.bg, color: meta.color }}>
                            {meta.label}
                          </span>
                          {pool.department && (
                            <span style={{ fontSize: 10, color: '#6b7280' }}>{pool.department}</span>
                          )}
                        </div>
                      </div>
                      <span style={{ fontWeight: 900, fontSize: 18, color: pool.member_count > 0 ? meta.color : '#d1d5db',
                                     marginLeft: 8, flexShrink: 0 }}>
                        {pool.member_count}
                      </span>
                    </div>
                    {pool.description && (
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4,
                                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {pool.description}
                      </div>
                    )}
                    {isAct && (
                      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                        <button onClick={(e) => {
                          e.stopPropagation();
                          setPoolForm({ pool_name: pool.pool_name, pool_type: pool.pool_type,
                                        description: pool.description || '', department: pool.department || '' });
                          setEditPoolId(pool.id);
                          setShowPoolForm(true);
                        }} style={BTN('outline', true)}>Edit</button>
                        <button onClick={(e) => { e.stopPropagation(); setPendingDeletePool(pool.id); }}
                          style={BTN('danger-outline', true)}>Delete</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Right: pool members ── */}
        {selPool && (
          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e9e4ff', padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                          marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
              <div>
                {(() => {
                  const meta = TYPE_META[selPool.pool_type] || TYPE_META.general;
                  return (
                    <>
                      <h3 style={{ margin: 0, color: '#4c1d95' }}>{selPool.pool_name}</h3>
                      <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 9px', borderRadius: 10,
                                       background: meta.bg, color: meta.color }}>
                          {meta.label}
                        </span>
                        {selPool.department && (
                          <span style={{ fontSize: 12, color: '#6b7280' }}>{selPool.department}</span>
                        )}
                        <span style={{ fontSize: 12, color: '#6B3FDB', fontWeight: 600 }}>
                          {members.length} member{members.length !== 1 ? 's' : ''}
                        </span>
                      </div>
                      {selPool.description && (
                        <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 6 }}>{selPool.description}</div>
                      )}
                    </>
                  );
                })()}
              </div>
              <button onClick={() => setShowAddMember(!showAddMember)}
                style={BTN(showAddMember ? 'secondary' : 'primary', true)}>
                {showAddMember ? 'X Cancel' : '+ Add Member'}
              </button>
            </div>

            {/* Add member form */}
            {showAddMember && (
              <form onSubmit={addMember}
                style={{ background: '#f5f3ff', borderRadius: 10, padding: 14,
                         marginBottom: 16, border: '1px solid #e9e4ff' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 10, alignItems: 'end' }}>
                  <div>
                    <label style={LBL}>Employee *</label>
                    <select required value={addEmpId}
                      onChange={e => setAddEmpId(e.target.value)} style={INP}>
                      <option value="">— Select employee —</option>
                      {available.map(emp => (
                        <option key={emp.id} value={emp.id}>
                          {emp.name}{emp.designation ? ` — ${emp.designation}` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={LBL}>Notes</label>
                    <input value={addNotes}
                      onChange={e => setAddNotes(e.target.value)}
                      placeholder="Why added to pool..."
                      style={INP} />
                  </div>
                  <button type="submit" disabled={saving} style={{ ...BTN('primary', true), alignSelf: 'flex-end' }}>
                    {saving ? '...' : 'Add'}
                  </button>
                </div>
              </form>
            )}

            {/* Members grid */}
            {members.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: '#9ca3af', fontSize: 13 }}>
                No members yet. Click "+ Add Member" to add employees to this pool.
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))', gap: 12 }}>
                {members.map(m => {
                  const riskColor = RISK_COLORS[m.flight_risk] || '#6b7280';
                  return (
                    <div key={m.employee_id}
                      style={{ background: '#f5f3ff', borderRadius: 10, padding: 14, border: '1px solid #e9e4ff' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                                    marginBottom: 8 }}>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 13, color: '#1f2937' }}>
                            {m.name}
                          </div>
                          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                            {m.designation}
                            {m.department ? ` · ${m.department}` : ''}
                          </div>
                        </div>
                        <button onClick={() => setPendingRemoveMember({ employeeId: m.employee_id, name: m.name })}
                          title="Remove from pool"
                          style={{ background: 'none', border: 'none', cursor: 'pointer',
                                   color: '#9ca3af', fontSize: 16, padding: '0 2px', flexShrink: 0 }}>
                          x
                        </button>
                      </div>

                      {m.talent_classification && (
                        <span style={{ display: 'inline-block', marginBottom: 8, fontSize: 10,
                                       fontWeight: 600, padding: '1px 7px', borderRadius: 8,
                                       background: '#dbeafe', color: '#1d4ed8' }}>
                          {m.talent_classification}
                        </span>
                      )}

                      {(m.performance_score || m.potential_score) && (
                        <div style={{ display: 'flex', gap: 8, fontSize: 11, color: '#6b7280', marginBottom: 6 }}>
                          {m.performance_score && (
                            <span>Perf: <strong style={{ color: '#16a34a' }}>{m.performance_score}/5</strong></span>
                          )}
                          {m.potential_score && (
                            <span>Pot: <strong style={{ color: '#6B3FDB' }}>{m.potential_score}/5</strong></span>
                          )}
                          {m.leadership_score && (
                            <span>Lead: <strong style={{ color: '#0891b2' }}>{m.leadership_score}/5</strong></span>
                          )}
                        </div>
                      )}

                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {m.flight_risk && (
                          <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 8,
                                         background: riskColor + '20', color: riskColor }}>
                            {m.flight_risk} risk
                          </span>
                        )}
                        {m.readiness && (
                          <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 8,
                                         background: '#f5f3ff', color: '#6B3FDB' }}>
                            {READY_LABELS[m.readiness] || m.readiness}
                          </span>
                        )}
                      </div>

                      {m.notes && (
                        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6,
                                      fontStyle: 'italic', borderLeft: '2px solid #e9e4ff', paddingLeft: 6 }}>
                          {m.notes}
                        </div>
                      )}

                      <div style={{ fontSize: 10, color: '#d1d5db', marginTop: 8 }}>
                        Added: {new Date(m.added_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
