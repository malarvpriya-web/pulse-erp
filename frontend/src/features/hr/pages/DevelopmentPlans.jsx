// frontend/src/features/hr/pages/DevelopmentPlans.jsx
import React, { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

/* ─── style tokens ──────────────────────────────────────────── */
const INP = { width: '100%', boxSizing: 'border-box', padding: '7px 10px',
              border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 };
const LBL = { fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 };
const BTN = (v = 'primary', sm = false) => ({
  border: 'none', borderRadius: 7, cursor: 'pointer', fontWeight: 600,
  fontSize: sm ? 12 : 13, padding: sm ? '4px 10px' : '8px 18px',
  background: v === 'primary' ? '#6B3FDB' : v === 'danger' ? '#ef4444' : v === 'ghost' ? 'none' : '#e9e4ff',
  color: v === 'primary' ? '#fff' : v === 'danger' ? '#fff' : v === 'ghost' ? '#6b7280' : '#6B3FDB',
  ...(v === 'outline' ? { border: '1px solid #6B3FDB', background: 'none', color: '#6B3FDB' } : {}),
  ...(v === 'success' ? { background: '#16a34a', color: '#fff', border: 'none' } : {}),
});

const STATUS_COLORS = { active: '#6B3FDB', completed: '#16a34a', paused: '#d97706', cancelled: '#ef4444' };
const ACTION_TYPES  = ['task', 'training', 'stretch_assignment', 'mentoring', 'project', 'certification', 'secondment'];
const ACTION_STATUS = ['pending', 'in_progress', 'completed', 'cancelled'];

function Spinner() {
  return (
    <div style={{ textAlign: 'center', padding: 48 }}>
      <style>{`@keyframes _spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ display: 'inline-block', width: 36, height: 36, border: '3px solid #e9e4ff',
                    borderTopColor: '#6B3FDB', borderRadius: '50%', animation: '_spin .75s linear infinite' }} />
    </div>
  );
}

function ProgressBar({ value }) {
  const color = value >= 80 ? '#16a34a' : value >= 40 ? '#d97706' : '#6B3FDB';
  return (
    <div style={{ height: 6, background: '#e9e4ff', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${value}%`, background: color, transition: 'width .4s', borderRadius: 3 }} />
    </div>
  );
}

const PLAN_DEFAULT  = { employee_id: '', critical_role_id: '', plan_title: '', plan_type: 'succession',
                        start_date: '', target_date: '', notes: '' };
const ACTION_DEFAULT = { action_type: 'task', title: '', description: '', due_date: '',
                         owner_employee_id: '', linked_skill: '' };
const MENTOR_DEFAULT = { mentee_employee_id: '', mentor_employee_id: '', focus_area: '',
                          start_date: '', end_date: '', notes: '' };

export default function DevelopmentPlans() {
  const [plans,       setPlans]       = useState([]);
  const [critRoles,   setCritRoles]   = useState([]);
  const [employees,   setEmployees]   = useState([]);
  const [selPlan,     setSelPlan]     = useState(null);
  const [planDetail,  setPlanDetail]  = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [detailLoad,  setDetailLoad]  = useState(false);
  const [saving,      setSaving]      = useState(false);
  const [msg,         setMsg]         = useState({ text: '', type: '' });

  const [tab, setTab] = useState('plans');

  // Plan form
  const [showPlanForm,  setShowPlanForm]  = useState(false);
  const [editPlanId,    setEditPlanId]    = useState(null);
  const [planForm,      setPlanForm]      = useState(PLAN_DEFAULT);

  // Action form
  const [showActionForm, setShowActionForm] = useState(false);
  const [actionForm,     setActionForm]     = useState(ACTION_DEFAULT);
  const [editActionId,   setEditActionId]   = useState(null);

  // Mentor form
  const [showMentorForm, setShowMentorForm] = useState(false);
  const [mentorForm,     setMentorForm]     = useState(MENTOR_DEFAULT);
  const [pendingDeleteAction, setPendingDeleteAction] = useState(null);
  const [pendingDeletePlan,   setPendingDeletePlan]   = useState(null);

  const flash = (text, type = 'success') => {
    setMsg({ text, type });
    setTimeout(() => setMsg({ text: '', type: '' }), 3500);
  };

  const loadPlans = useCallback(async () => {
    const [plRes, crRes] = await Promise.allSettled([
      api.get('/succession/development-plans'),
      api.get('/succession/critical-roles'),
    ]);
    if (plRes.status === 'fulfilled') setPlans(plRes.value.data || []);
    if (crRes.status === 'fulfilled') setCritRoles(crRes.value.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { loadPlans(); }, [loadPlans]);
  useEffect(() => {
    api.get('/employees?status=active').then(r => setEmployees(r.data || [])).catch(() => {});
  }, []);

  const loadPlanDetail = async (id) => {
    setDetailLoad(true);
    try {
      const r = await api.get(`/succession/development-plans/${id}`);
      setPlanDetail(r.data);
    } catch { setPlanDetail(null); }
    finally { setDetailLoad(false); }
  };

  const selectPlan = (plan) => {
    setSelPlan(plan);
    loadPlanDetail(plan.id);
    setTab('detail');
    setShowActionForm(false);
    setShowMentorForm(false);
    setActionForm(ACTION_DEFAULT);
    setMentorForm(MENTOR_DEFAULT);
  };

  /* ── Plan CRUD ── */
  const submitPlan = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        ...planForm,
        employee_id:      parseInt(planForm.employee_id),
        critical_role_id: planForm.critical_role_id ? parseInt(planForm.critical_role_id) : null,
        start_date:       planForm.start_date || null,
        target_date:      planForm.target_date || null,
      };
      if (editPlanId) {
        await api.patch(`/succession/development-plans/${editPlanId}`, { plan_title: planForm.plan_title, notes: planForm.notes, target_date: planForm.target_date || null });
        flash('Plan updated');
      } else {
        await api.post('/succession/development-plans', payload);
        flash('Development plan created');
      }
      setShowPlanForm(false);
      setEditPlanId(null);
      setPlanForm(PLAN_DEFAULT);
      loadPlans();
    } catch (err) {
      flash(err.response?.data?.message || 'Failed', 'error');
    } finally { setSaving(false); }
  };

  /* ── Action CRUD ── */
  const submitAction = async (e) => {
    e.preventDefault();
    if (!selPlan) return;
    setSaving(true);
    try {
      const payload = {
        ...actionForm,
        owner_employee_id: actionForm.owner_employee_id ? parseInt(actionForm.owner_employee_id) : null,
        due_date: actionForm.due_date || null,
      };
      if (editActionId) {
        await api.patch(`/succession/development-plans/${selPlan.id}/actions/${editActionId}`, payload);
        flash('Action updated');
      } else {
        await api.post(`/succession/development-plans/${selPlan.id}/actions`, payload);
        flash('Action added');
      }
      setShowActionForm(false);
      setEditActionId(null);
      setActionForm(ACTION_DEFAULT);
      loadPlanDetail(selPlan.id);
      loadPlans();
    } catch (err) {
      flash(err.response?.data?.message || 'Failed', 'error');
    } finally { setSaving(false); }
  };

  const updateActionStatus = async (planId, actionId, status) => {
    try {
      const completion_date = status === 'completed' ? new Date().toISOString().split('T')[0] : null;
      await api.patch(`/succession/development-plans/${planId}/actions/${actionId}`, { status, completion_date });
      loadPlanDetail(planId);
      loadPlans();
    } catch (err) { flash(err.response?.data?.message || 'Failed', 'error'); }
  };

  const deleteAction = async () => {
    if (!pendingDeleteAction) return;
    const { planId, actionId } = pendingDeleteAction;
    setPendingDeleteAction(null);
    try {
      await api.delete(`/succession/development-plans/${planId}/actions/${actionId}`);
      loadPlanDetail(planId);
      loadPlans();
      flash('Action deleted');
    } catch (err) { flash(err.response?.data?.message || 'Failed', 'error'); }
  };

  /* ── Mentor CRUD ── */
  const submitMentor = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/succession/mentoring', {
        ...mentorForm,
        mentee_employee_id: parseInt(mentorForm.mentee_employee_id),
        mentor_employee_id: parseInt(mentorForm.mentor_employee_id),
        development_plan_id: selPlan?.id || null,
        start_date: mentorForm.start_date || null,
        end_date: mentorForm.end_date || null,
      });
      flash('Mentoring assignment created');
      setShowMentorForm(false);
      setMentorForm(MENTOR_DEFAULT);
      if (selPlan) loadPlanDetail(selPlan.id);
    } catch (err) {
      flash(err.response?.data?.message || 'Failed', 'error');
    } finally { setSaving(false); }
  };

  const updatePlanStatus = async (id, status) => {
    try {
      await api.patch(`/succession/development-plans/${id}`, {
        status,
        completion_date: status === 'completed' ? new Date().toISOString().split('T')[0] : null,
      });
      loadPlans();
      if (selPlan?.id === id) loadPlanDetail(id);
      flash(`Plan marked as ${status}`);
    } catch (err) { flash(err.response?.data?.message || 'Failed', 'error'); }
  };

  const deletePlan = async () => {
    if (!pendingDeletePlan) return;
    const id = pendingDeletePlan;
    setPendingDeletePlan(null);
    try {
      await api.delete(`/succession/development-plans/${id}`);
      if (selPlan?.id === id) { setSelPlan(null); setPlanDetail(null); setTab('plans'); }
      loadPlans();
      flash('Plan deleted');
    } catch (err) { flash(err.response?.data?.message || 'Failed', 'error'); }
  };

  const tabStyle = (active) => ({
    padding: '7px 16px', border: 'none', cursor: 'pointer', borderRadius: 6,
    fontWeight: 600, fontSize: 13,
    background: active ? '#6B3FDB' : '#e9e4ff',
    color: active ? '#fff' : '#6B3FDB',
  });

  if (loading) return <div style={{ padding: 24 }}><Spinner /></div>;

  return (
    <div style={{ padding: 24, background: '#f5f3ff', minHeight: '100vh' }}>
      <ConfirmDialog
        open={!!pendingDeleteAction}
        title="Delete Action"
        message="Delete this action?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteAction}
        onCancel={() => setPendingDeleteAction(null)}
      />
      <ConfirmDialog
        open={!!pendingDeletePlan}
        title="Delete Plan"
        message="Delete this development plan and all its actions?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deletePlan}
        onCancel={() => setPendingDeletePlan(null)}
      />
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, color: '#4c1d95', fontSize: 22 }}>Development Plans</h2>
        <p style={{ margin: 0, color: '#6b7280', fontSize: 13, marginTop: 4 }}>
          Structured development plans, actions, and mentoring for succession candidates
        </p>
      </div>

      {/* Flash */}
      {msg.text && (
        <div style={{ marginBottom: 12, padding: '10px 16px', borderRadius: 8, fontWeight: 500, fontSize: 14,
                      background: msg.type === 'error' ? '#fef2f2' : '#f0fdf4',
                      color:      msg.type === 'error' ? '#dc2626' : '#16a34a',
                      border:     `1px solid ${msg.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>
          {msg.text}
        </div>
      )}

      {/* Top tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, borderBottom: '2px solid #e9e4ff', paddingBottom: 0 }}>
        <button style={tabStyle(tab === 'plans')} onClick={() => setTab('plans')}>All Plans</button>
        {selPlan && (
          <button style={tabStyle(tab === 'detail')} onClick={() => setTab('detail')}>
            {selPlan.plan_title?.substring(0, 20)}{selPlan.plan_title?.length > 20 ? '...' : ''}
          </button>
        )}
        <button style={tabStyle(tab === 'mentoring')} onClick={() => setTab('mentoring')}>Mentoring</button>
      </div>

      {/* ── Plans List ── */}
      {tab === 'plans' && (
        <div>
          <div style={{ marginBottom: 16 }}>
            <button style={BTN(showPlanForm ? 'secondary' : 'primary')}
              onClick={() => { setShowPlanForm(!showPlanForm); setEditPlanId(null); setPlanForm(PLAN_DEFAULT); }}>
              {showPlanForm ? 'X Cancel' : '+ New Plan'}
            </button>
          </div>

          {showPlanForm && (
            <form onSubmit={submitPlan}
              style={{ background: '#fff', borderRadius: 10, padding: 20, marginBottom: 20,
                       border: '1px solid #e9e4ff' }}>
              <h4 style={{ margin: '0 0 14px', color: '#4c1d95' }}>
                {editPlanId ? 'Edit Plan' : 'New Development Plan'}
              </h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
                {!editPlanId && (
                  <div>
                    <label style={LBL}>Employee *</label>
                    <select required value={planForm.employee_id}
                      onChange={e => setPlanForm(f => ({ ...f, employee_id: e.target.value }))}
                      style={INP}>
                      <option value="">— Select —</option>
                      {employees.map(emp => (
                        <option key={emp.id} value={emp.id}>
                          {emp.name}{emp.designation ? ` — ${emp.designation}` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div style={{ gridColumn: editPlanId ? '1/-1' : '' }}>
                  <label style={LBL}>Plan Title *</label>
                  <input required value={planForm.plan_title}
                    onChange={e => setPlanForm(f => ({ ...f, plan_title: e.target.value }))}
                    placeholder="e.g. CFO Readiness Program 2026"
                    style={INP} />
                </div>
                {!editPlanId && (
                  <div>
                    <label style={LBL}>Target Critical Role</label>
                    <select value={planForm.critical_role_id}
                      onChange={e => setPlanForm(f => ({ ...f, critical_role_id: e.target.value }))}
                      style={INP}>
                      <option value="">— None / General —</option>
                      {critRoles.map(r => <option key={r.id} value={r.id}>{r.role_title}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label style={LBL}>Start Date</label>
                  <input type="date" value={planForm.start_date}
                    onChange={e => setPlanForm(f => ({ ...f, start_date: e.target.value }))}
                    style={INP} />
                </div>
                <div>
                  <label style={LBL}>Target Date</label>
                  <input type="date" value={planForm.target_date}
                    onChange={e => setPlanForm(f => ({ ...f, target_date: e.target.value }))}
                    style={INP} />
                </div>
                <div style={{ gridColumn: '1/-1' }}>
                  <label style={LBL}>Notes</label>
                  <input value={planForm.notes}
                    onChange={e => setPlanForm(f => ({ ...f, notes: e.target.value }))}
                    placeholder="Context, goals, expectations..."
                    style={INP} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <button type="submit" disabled={saving} style={BTN('primary')}>
                  {saving ? 'Saving...' : editPlanId ? 'Update' : 'Create Plan'}
                </button>
                <button type="button" onClick={() => { setShowPlanForm(false); setEditPlanId(null); }}
                  style={BTN('ghost')}>Cancel</button>
              </div>
            </form>
          )}

          {plans.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: '#9ca3af' }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>-</div>
              <div style={{ fontWeight: 700, color: '#4c1d95', fontSize: 16 }}>No development plans yet</div>
              <div style={{ fontSize: 13, marginTop: 6 }}>Create a plan to track development activities for succession candidates.</div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 16 }}>
              {plans.map(plan => {
                const statusColor = STATUS_COLORS[plan.status] || '#6b7280';
                const pct = plan.overall_progress || 0;
                return (
                  <div key={plan.id}
                    style={{ background: '#fff', borderRadius: 12, border: '1px solid #e9e4ff',
                             padding: 18, cursor: 'pointer', transition: 'box-shadow .15s',
                             boxShadow: selPlan?.id === plan.id ? '0 0 0 2px #6B3FDB' : 'none' }}
                    onClick={() => selectPlan(plan)}>

                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: '#1f2937',
                                    flex: 1, marginRight: 8 }}>
                        {plan.plan_title}
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10,
                                     background: statusColor + '20', color: statusColor, whiteSpace: 'nowrap' }}>
                        {plan.status}
                      </span>
                    </div>

                    <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
                      <strong style={{ color: '#1f2937' }}>{plan.employee_name}</strong>
                      {plan.department ? ` · ${plan.department}` : ''}
                      {plan.target_role && (
                        <div style={{ color: '#6B3FDB', marginTop: 2 }}>Target: {plan.target_role}</div>
                      )}
                    </div>

                    {/* Progress */}
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11,
                                    color: '#6b7280', marginBottom: 4 }}>
                        <span>{plan.completed_count}/{plan.action_count} actions</span>
                        <span style={{ fontWeight: 700 }}>{pct}%</span>
                      </div>
                      <ProgressBar value={pct} />
                    </div>

                    <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between',
                                  fontSize: 11, color: '#9ca3af' }}>
                      <span>
                        {plan.target_date
                          ? `Due: ${new Date(plan.target_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}`
                          : 'No deadline'}
                      </span>
                      {plan.mentor_count > 0 && (
                        <span style={{ color: '#6B3FDB', fontWeight: 600 }}>
                          {plan.mentor_count} mentor{plan.mentor_count > 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Plan Detail ── */}
      {tab === 'detail' && selPlan && (
        <div>
          {detailLoad ? <Spinner /> : planDetail ? (
            <div>
              {/* Plan header */}
              <div style={{ background: '#fff', borderRadius: 12, padding: 20, marginBottom: 20,
                            border: '1px solid #e9e4ff' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                  <div>
                    <h3 style={{ margin: '0 0 4px', color: '#4c1d95' }}>{planDetail.plan_title}</h3>
                    <div style={{ fontSize: 13, color: '#6b7280' }}>
                      {planDetail.employee_name}
                      {planDetail.designation ? ` — ${planDetail.designation}` : ''}
                      {planDetail.target_role ? ` · Target: ${planDetail.target_role}` : ''}
                    </div>
                    {planDetail.notes && (
                      <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4, fontStyle: 'italic' }}>
                        {planDetail.notes}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    {planDetail.status === 'active' && (
                      <button onClick={() => updatePlanStatus(planDetail.id, 'completed')} style={BTN('success', true)}>
                        Mark Complete
                      </button>
                    )}
                    {planDetail.status === 'active' && (
                      <button onClick={() => updatePlanStatus(planDetail.id, 'paused')} style={BTN('secondary', true)}>
                        Pause
                      </button>
                    )}
                    {planDetail.status === 'paused' && (
                      <button onClick={() => updatePlanStatus(planDetail.id, 'active')} style={BTN('primary', true)}>
                        Resume
                      </button>
                    )}
                    <button onClick={() => setPendingDeletePlan(planDetail.id)}
                      style={{ ...BTN('ghost', true), color: '#ef4444' }}>
                      Delete Plan
                    </button>
                  </div>
                </div>

                <div style={{ marginTop: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12,
                                color: '#6b7280', marginBottom: 6 }}>
                    <span>{planDetail.completed_count || 0}/{planDetail.action_count || 0} actions complete</span>
                    <span style={{ fontWeight: 700 }}>{planDetail.overall_progress || 0}%</span>
                  </div>
                  <ProgressBar value={planDetail.overall_progress || 0} />
                </div>
              </div>

              {/* Actions */}
              <div style={{ marginBottom: 24 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <h4 style={{ margin: 0, color: '#4c1d95' }}>
                    Development Actions ({(planDetail.actions || []).length})
                  </h4>
                  <button onClick={() => { setShowActionForm(!showActionForm); setEditActionId(null); setActionForm(ACTION_DEFAULT); }}
                    style={BTN(showActionForm ? 'secondary' : 'primary', true)}>
                    {showActionForm ? 'Cancel' : '+ Add Action'}
                  </button>
                </div>

                {showActionForm && (
                  <form onSubmit={submitAction}
                    style={{ background: '#f5f3ff', borderRadius: 10, padding: 16, marginBottom: 16,
                             border: '1px solid #e9e4ff' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 10 }}>
                      <div style={{ gridColumn: '1/-1' }}>
                        <label style={LBL}>Title *</label>
                        <input required value={actionForm.title}
                          onChange={e => setActionForm(f => ({ ...f, title: e.target.value }))}
                          placeholder="e.g. Complete Finance Leadership Course"
                          style={INP} />
                      </div>
                      <div>
                        <label style={LBL}>Type</label>
                        <select value={actionForm.action_type}
                          onChange={e => setActionForm(f => ({ ...f, action_type: e.target.value }))}
                          style={INP}>
                          {ACTION_TYPES.map(t => (
                            <option key={t} value={t}>{t.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label style={LBL}>Due Date</label>
                        <input type="date" value={actionForm.due_date}
                          onChange={e => setActionForm(f => ({ ...f, due_date: e.target.value }))}
                          style={INP} />
                      </div>
                      <div>
                        <label style={LBL}>Owner</label>
                        <select value={actionForm.owner_employee_id}
                          onChange={e => setActionForm(f => ({ ...f, owner_employee_id: e.target.value }))}
                          style={INP}>
                          <option value="">— Employee / Self —</option>
                          {employees.map(emp => (
                            <option key={emp.id} value={emp.id}>{emp.name}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label style={LBL}>Linked Skill</label>
                        <input value={actionForm.linked_skill}
                          onChange={e => setActionForm(f => ({ ...f, linked_skill: e.target.value }))}
                          placeholder="e.g. Financial Analysis"
                          style={INP} />
                      </div>
                      <div style={{ gridColumn: '1/-1' }}>
                        <label style={LBL}>Description</label>
                        <input value={actionForm.description}
                          onChange={e => setActionForm(f => ({ ...f, description: e.target.value }))}
                          placeholder="What needs to be done..."
                          style={INP} />
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                      <button type="submit" disabled={saving} style={BTN('primary', true)}>
                        {saving ? 'Saving...' : editActionId ? 'Update' : 'Add Action'}
                      </button>
                      <button type="button"
                        onClick={() => { setShowActionForm(false); setEditActionId(null); setActionForm(ACTION_DEFAULT); }}
                        style={BTN('ghost', true)}>Cancel</button>
                    </div>
                  </form>
                )}

                {(planDetail.actions || []).length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '24px 0', color: '#9ca3af', fontSize: 13 }}>
                    No actions yet. Click "+ Add Action" to build the development plan.
                  </div>
                ) : (planDetail.actions || []).map(action => {
                  const statusColors = { pending: '#9ca3af', in_progress: '#d97706', completed: '#16a34a', cancelled: '#ef4444' };
                  const ac = statusColors[action.status] || '#9ca3af';
                  return (
                    <div key={action.id}
                      style={{ background: action.status === 'completed' ? '#f0fdf4' : '#fff',
                               borderRadius: 10, padding: 14, marginBottom: 8,
                               border: `1px solid ${action.status === 'completed' ? '#bbf7d0' : '#e9e4ff'}`,
                               display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                      {/* Status dot */}
                      <div style={{ width: 12, height: 12, borderRadius: '50%', background: ac,
                                    flexShrink: 0, marginTop: 4 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                          <div style={{ fontWeight: 600, fontSize: 13, color: '#1f2937',
                                        textDecoration: action.status === 'completed' ? 'line-through' : 'none' }}>
                            {action.title}
                          </div>
                          <div style={{ display: 'flex', gap: 4 }}>
                            {ACTION_STATUS.filter(s => s !== action.status).slice(0,2).map(s => (
                              <button key={s} onClick={() => updateActionStatus(planDetail.id, action.id, s)}
                                style={{ fontSize: 10, padding: '2px 7px', border: `1px solid ${statusColors[s]}40`,
                                         borderRadius: 5, cursor: 'pointer', background: 'none',
                                         color: statusColors[s], fontWeight: 600 }}>
                                {s.replace('_',' ')}
                              </button>
                            ))}
                            <button onClick={() => setPendingDeleteAction({ planId: planDetail.id, actionId: action.id })}
                              style={{ fontSize: 10, padding: '2px 7px', border: 'none',
                                       borderRadius: 5, cursor: 'pointer', background: 'none',
                                       color: '#9ca3af', fontWeight: 600 }}>
                              Del
                            </button>
                          </div>
                        </div>
                        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                          <span style={{ background: '#e9e4ff', color: '#6B3FDB', padding: '1px 6px', borderRadius: 8 }}>
                            {action.action_type.replace(/_/g,' ')}
                          </span>
                          {action.due_date && <span>Due: {new Date(action.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</span>}
                          {action.owner_name && <span>Owner: {action.owner_name}</span>}
                          {action.linked_skill && <span>Skill: {action.linked_skill}</span>}
                        </div>
                        {action.description && (
                          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>{action.description}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Mentors */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <h4 style={{ margin: 0, color: '#4c1d95' }}>
                    Mentoring ({(planDetail.mentors || []).length})
                  </h4>
                  <button onClick={() => {
                    setMentorForm({ ...MENTOR_DEFAULT, mentee_employee_id: planDetail.employee_id });
                    setShowMentorForm(!showMentorForm);
                  }} style={BTN(showMentorForm ? 'secondary' : 'outline', true)}>
                    {showMentorForm ? 'Cancel' : '+ Assign Mentor'}
                  </button>
                </div>

                {showMentorForm && (
                  <form onSubmit={submitMentor}
                    style={{ background: '#f5f3ff', borderRadius: 10, padding: 14, marginBottom: 12,
                             border: '1px solid #e9e4ff' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 10 }}>
                      <div>
                        <label style={LBL}>Mentee *</label>
                        <select required value={mentorForm.mentee_employee_id}
                          onChange={e => setMentorForm(f => ({ ...f, mentee_employee_id: e.target.value }))}
                          style={INP}>
                          <option value="">— Select —</option>
                          {employees.map(emp => <option key={emp.id} value={emp.id}>{emp.name}</option>)}
                        </select>
                      </div>
                      <div>
                        <label style={LBL}>Mentor *</label>
                        <select required value={mentorForm.mentor_employee_id}
                          onChange={e => setMentorForm(f => ({ ...f, mentor_employee_id: e.target.value }))}
                          style={INP}>
                          <option value="">— Select —</option>
                          {employees.filter(e => e.id !== parseInt(mentorForm.mentee_employee_id)).map(emp => (
                            <option key={emp.id} value={emp.id}>{emp.name} {emp.designation ? `— ${emp.designation}` : ''}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label style={LBL}>Focus Area</label>
                        <input value={mentorForm.focus_area}
                          onChange={e => setMentorForm(f => ({ ...f, focus_area: e.target.value }))}
                          placeholder="e.g. Strategic Finance"
                          style={INP} />
                      </div>
                      <div>
                        <label style={LBL}>Start Date</label>
                        <input type="date" value={mentorForm.start_date}
                          onChange={e => setMentorForm(f => ({ ...f, start_date: e.target.value }))}
                          style={INP} />
                      </div>
                      <div>
                        <label style={LBL}>End Date</label>
                        <input type="date" value={mentorForm.end_date}
                          onChange={e => setMentorForm(f => ({ ...f, end_date: e.target.value }))}
                          style={INP} />
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button type="submit" disabled={saving} style={BTN('primary', true)}>
                        {saving ? 'Assigning...' : 'Assign Mentor'}
                      </button>
                      <button type="button" onClick={() => setShowMentorForm(false)} style={BTN('ghost', true)}>
                        Cancel
                      </button>
                    </div>
                  </form>
                )}

                {(planDetail.mentors || []).map(m => (
                  <div key={m.id} style={{ background: '#f5f3ff', borderRadius: 10, padding: 12,
                                           marginBottom: 8, border: '1px solid #e9e4ff',
                                           display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13, color: '#1f2937' }}>
                        {m.mentor_name}
                        <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 400, marginLeft: 6 }}>
                          {m.mentor_designation}
                        </span>
                      </div>
                      {m.focus_area && (
                        <div style={{ fontSize: 11, color: '#6B3FDB', marginTop: 2 }}>{m.focus_area}</div>
                      )}
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 8,
                                   background: m.status === 'active' ? '#d1fae5' : '#f9fafb',
                                   color: m.status === 'active' ? '#16a34a' : '#6b7280' }}>
                      {m.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>
              Could not load plan details.
            </div>
          )}
        </div>
      )}

      {/* ── Mentoring Tab ── */}
      {tab === 'mentoring' && <MentoringList employees={employees} flash={flash} />}
    </div>
  );
}

function MentoringList({ employees, flash }) {
  const [assignments, setAssignments] = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [showForm,    setShowForm]    = useState(false);
  const [form,        setForm]        = useState(MENTOR_DEFAULT);
  const [saving,      setSaving]      = useState(false);

  const load = async () => {
    try {
      const r = await api.get('/succession/mentoring');
      setAssignments(r.data || []);
    } catch { setAssignments([]); }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/succession/mentoring', {
        ...form,
        mentee_employee_id: parseInt(form.mentee_employee_id),
        mentor_employee_id: parseInt(form.mentor_employee_id),
        start_date: form.start_date || null,
        end_date:   form.end_date   || null,
      });
      flash('Mentoring assignment created');
      setShowForm(false);
      setForm(MENTOR_DEFAULT);
      load();
    } catch (err) {
      flash(err.response?.data?.message || 'Failed', 'error');
    } finally { setSaving(false); }
  };

  const updateStatus = async (id, status) => {
    try {
      await api.patch(`/succession/mentoring/${id}`, { status });
      load();
    } catch (err) { flash(err.response?.data?.message || 'Failed', 'error'); }
  };

  if (loading) return <Spinner />;

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <button style={BTN(showForm ? 'secondary' : 'primary')}
          onClick={() => { setShowForm(!showForm); setForm(MENTOR_DEFAULT); }}>
          {showForm ? 'X Cancel' : '+ Assign Mentor'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={submit}
          style={{ background: '#fff', borderRadius: 10, padding: 20, marginBottom: 20,
                   border: '1px solid #e9e4ff' }}>
          <h4 style={{ margin: '0 0 14px', color: '#4c1d95' }}>New Mentoring Assignment</h4>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
            <div>
              <label style={LBL}>Mentee *</label>
              <select required value={form.mentee_employee_id}
                onChange={e => setForm(f => ({ ...f, mentee_employee_id: e.target.value }))}
                style={INP}>
                <option value="">— Select mentee —</option>
                {employees.map(emp => <option key={emp.id} value={emp.id}>{emp.name}</option>)}
              </select>
            </div>
            <div>
              <label style={LBL}>Mentor *</label>
              <select required value={form.mentor_employee_id}
                onChange={e => setForm(f => ({ ...f, mentor_employee_id: e.target.value }))}
                style={INP}>
                <option value="">— Select mentor —</option>
                {employees.filter(e => e.id !== parseInt(form.mentee_employee_id)).map(emp => (
                  <option key={emp.id} value={emp.id}>{emp.name}{emp.designation ? ` — ${emp.designation}` : ''}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={LBL}>Focus Area</label>
              <input value={form.focus_area}
                onChange={e => setForm(f => ({ ...f, focus_area: e.target.value }))}
                placeholder="e.g. Strategic Leadership"
                style={INP} />
            </div>
            <div>
              <label style={LBL}>Start Date</label>
              <input type="date" value={form.start_date}
                onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} style={INP} />
            </div>
            <div>
              <label style={LBL}>End Date</label>
              <input type="date" value={form.end_date}
                onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} style={INP} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button type="submit" disabled={saving} style={BTN('primary')}>
              {saving ? 'Saving...' : 'Assign Mentor'}
            </button>
            <button type="button" onClick={() => setShowForm(false)} style={BTN('ghost')}>Cancel</button>
          </div>
        </form>
      )}

      {assignments.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: '#9ca3af' }}>
          <div style={{ fontWeight: 700, color: '#4c1d95', fontSize: 16 }}>No mentoring assignments yet</div>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f5f3ff' }}>
                {['Mentee', 'Mentor', 'Focus Area', 'Start Date', 'End Date', 'Sessions', 'Status', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '9px 12px', textAlign: 'left', borderBottom: '1px solid #e9e4ff',
                                       color: '#4c1d95', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {assignments.map(a => (
                <tr key={a.id} style={{ borderBottom: '1px solid #f0ebff' }}>
                  <td style={{ padding: '9px 12px', fontWeight: 600 }}>{a.mentee_name}</td>
                  <td style={{ padding: '9px 12px' }}>
                    {a.mentor_name}
                    {a.mentor_designation && (
                      <div style={{ fontSize: 11, color: '#6b7280' }}>{a.mentor_designation}</div>
                    )}
                  </td>
                  <td style={{ padding: '9px 12px', color: '#6b7280' }}>{a.focus_area || '—'}</td>
                  <td style={{ padding: '9px 12px', color: '#6b7280' }}>
                    {a.start_date ? new Date(a.start_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                  </td>
                  <td style={{ padding: '9px 12px', color: '#6b7280' }}>
                    {a.end_date ? new Date(a.end_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                  </td>
                  <td style={{ padding: '9px 12px', textAlign: 'center', fontWeight: 700, color: '#6B3FDB' }}>
                    {a.session_count || 0}
                  </td>
                  <td style={{ padding: '9px 12px' }}>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 8,
                                   background: a.status === 'active' ? '#d1fae5' : '#f9fafb',
                                   color: a.status === 'active' ? '#16a34a' : '#6b7280' }}>
                      {a.status}
                    </span>
                  </td>
                  <td style={{ padding: '9px 12px' }}>
                    {a.status === 'active' ? (
                      <button onClick={() => updateStatus(a.id, 'completed')}
                        style={{ ...BTN('ghost', true), color: '#16a34a', fontSize: 11 }}>
                        Complete
                      </button>
                    ) : (
                      <span style={{ color: '#9ca3af', fontSize: 12 }}>Done</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
