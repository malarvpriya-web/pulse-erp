// frontend/src/features/hr/succession/DevelopmentPlans.jsx
// Succession Center → Development Plans: plans, their actions, mentoring
// assignments and the sessions logged against them.
import React, { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { fmtDate, localDay } from '@/utils/dateFormatter';
import {
  INP, LBL, BTN, Chip, PhaseBadge, Spinner, Flash, LoadError, useFlash, errText,
  useCurrentEmployees, empLabel, MentorForm, mentorPayload,
} from '../utils/successionUi';

const STATUS_COLORS = { active: '#6B3FDB', completed: '#16a34a', paused: '#6d28d9', cancelled: '#ef4444' };
const ACTION_TYPES  = ['task', 'training', 'stretch_assignment', 'mentoring', 'project', 'certification', 'secondment'];
const ACTION_STATUS = ['pending', 'in_progress', 'completed', 'cancelled'];
const ACTION_COLORS = { pending: '#9ca3af', in_progress: '#6d28d9', completed: '#16a34a', cancelled: '#ef4444' };
const MENTOR_COLORS = { active: '#16a34a', completed: '#6b7280', cancelled: '#ef4444' };
const titleCase = (s = '') => s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

function ProgressBar({ value }) {
  const color = value >= 80 ? '#16a34a' : value >= 40 ? '#6d28d9' : '#6B3FDB';
  return (
    <div role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}
         style={{ height: 6, background: '#e9e4ff', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${value}%`, background: color, transition: 'width .4s', borderRadius: 3 }} />
    </div>
  );
}

const PLAN_DEFAULT   = { employee_id: '', critical_role_id: '', plan_title: '', start_date: '', target_date: '', notes: '' };
const ACTION_DEFAULT = { action_type: 'task', title: '', description: '', due_date: '', owner_employee_id: '', linked_skill: '', linked_training_id: '' };

/* Trainings a training / certification action can link to (Learning Center, 2026-11-18). */
function useTrainings() {
  const [list, setList] = useState([]);
  useEffect(() => { api.get('/training/programs?status=planned,ongoing,completed').then(r => setList(r.data || [])).catch(() => setList([])); }, []);
  return list;
}
const SESSION_DEFAULT = { session_date: '', duration_minutes: '', topic: '', notes: '', next_session_date: '' };

/* ── Plan form (create and edit) ── */
function PlanForm({ initial, editing, employees, critRoles, saving, onSubmit, onCancel }) {
  const [f, setF] = useState(initial);
  const set = (k) => (e) => setF(x => ({ ...x, [k]: e.target.value }));
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(f); }}
      style={{ background: '#fff', borderRadius: 10, padding: 20, marginBottom: 20, border: '1px solid #e9e4ff' }}>
      <h4 style={{ margin: '0 0 14px', color: '#4c1d95' }}>{editing ? 'Edit Plan' : 'New Development Plan'}</h4>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
        {!editing && (
          <div>
            <label style={LBL} htmlFor="pl-emp">Employee *</label>
            <select id="pl-emp" required value={f.employee_id} onChange={set('employee_id')} style={INP}>
              <option value="">— Select —</option>
              {employees.map(emp => <option key={emp.id} value={emp.id}>{empLabel(emp)}</option>)}
            </select>
          </div>
        )}
        <div>
          <label style={LBL} htmlFor="pl-title">Plan Title *</label>
          <input id="pl-title" required maxLength={200} value={f.plan_title} onChange={set('plan_title')}
                 placeholder="e.g. CFO Readiness Program 2026" style={INP} />
        </div>
        <div>
          <label style={LBL} htmlFor="pl-role">Target Critical Role</label>
          <select id="pl-role" value={f.critical_role_id} onChange={set('critical_role_id')} style={INP}>
            <option value="">— None / General —</option>
            {critRoles.map(r => <option key={r.id} value={r.id}>{r.role_title}</option>)}
          </select>
        </div>
        <div>
          <label style={LBL} htmlFor="pl-start">Start Date</label>
          <input id="pl-start" type="date" value={f.start_date} onChange={set('start_date')} style={INP} />
        </div>
        <div>
          <label style={LBL} htmlFor="pl-target">Target Date</label>
          <input id="pl-target" type="date" value={f.target_date} min={f.start_date || undefined} onChange={set('target_date')} style={INP} />
        </div>
        <div style={{ gridColumn: '1/-1' }}>
          <label style={LBL} htmlFor="pl-notes">Notes</label>
          <input id="pl-notes" maxLength={2000} value={f.notes} onChange={set('notes')}
                 placeholder="Context, goals, expectations..." style={INP} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button type="submit" disabled={saving} style={BTN('primary')}>{saving ? 'Saving...' : editing ? 'Update Plan' : 'Create Plan'}</button>
        <button type="button" onClick={onCancel} style={BTN('ghost')}>Cancel</button>
      </div>
    </form>
  );
}

/* ── Action form (add and edit) ── */
function ActionForm({ initial, editing, employees, saving, onSubmit, onCancel }) {
  const [f, setF] = useState(initial);
  const trainings = useTrainings();
  const canLink = ['training', 'certification'].includes(f.action_type);
  const set = (k) => (e) => setF(x => ({ ...x, [k]: e.target.value }));
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(f); }}
      style={{ background: '#f5f3ff', borderRadius: 10, padding: 16, marginBottom: 16, border: '1px solid #e9e4ff' }}>
      <div style={{ fontWeight: 600, color: '#4c1d95', fontSize: 13, marginBottom: 10 }}>{editing ? 'Edit Action' : 'New Action'}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 10 }}>
        <div style={{ gridColumn: '1/-1' }}>
          <label style={LBL} htmlFor="ac-title">Title *</label>
          <input id="ac-title" required maxLength={200} value={f.title} onChange={set('title')}
                 placeholder="e.g. Complete Finance Leadership Course" style={INP} />
        </div>
        <div>
          <label style={LBL} htmlFor="ac-type">Type</label>
          <select id="ac-type" value={f.action_type} onChange={set('action_type')} style={INP}>
            {ACTION_TYPES.map(t => <option key={t} value={t}>{titleCase(t)}</option>)}
          </select>
        </div>
        <div>
          <label style={LBL} htmlFor="ac-due">Due Date</label>
          <input id="ac-due" type="date" value={f.due_date} onChange={set('due_date')} style={INP} />
        </div>
        <div>
          <label style={LBL} htmlFor="ac-owner">Owner</label>
          <select id="ac-owner" value={f.owner_employee_id} onChange={set('owner_employee_id')} style={INP}>
            <option value="">— Plan employee —</option>
            {f.owner_employee_id && !employees.some(e => e.id === Number(f.owner_employee_id)) && (
              <option value={f.owner_employee_id}>{initial.owner_name || 'Current owner'} (left)</option>
            )}
            {employees.map(emp => <option key={emp.id} value={emp.id}>{emp.name}</option>)}
          </select>
        </div>
        <div>
          <label style={LBL} htmlFor="ac-skill">Linked Skill</label>
          <input id="ac-skill" maxLength={200} value={f.linked_skill} onChange={set('linked_skill')}
                 placeholder="e.g. Financial Analysis" style={INP} />
        </div>
        {canLink && (
          <div style={{ gridColumn: '1/-1' }}>
            <label style={LBL} htmlFor="ac-training">Linked training (Learning Center)</label>
            <select id="ac-training" value={f.linked_training_id || ''} style={INP}
              onChange={e => { const t = trainings.find(x => x.id === Number(e.target.value)); setF(x => ({ ...x, linked_training_id: e.target.value, title: x.title || (t ? t.title : '') })); }}>
              <option value="">— None —</option>
              {trainings.map(t => <option key={t.id} value={t.id}>{t.title} — {fmtDate(t.scheduled_date)} ({titleCase(t.status)})</option>)}
            </select>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>The plan's employee is enrolled; completing the training completes this action.</div>
          </div>
        )}
        <div style={{ gridColumn: '1/-1' }}>
          <label style={LBL} htmlFor="ac-desc">Description</label>
          <input id="ac-desc" maxLength={2000} value={f.description} onChange={set('description')}
                 placeholder="What needs to be done..." style={INP} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="submit" disabled={saving} style={BTN('primary', true)}>{saving ? 'Saving...' : editing ? 'Update Action' : 'Add Action'}</button>
        <button type="button" onClick={onCancel} style={BTN('ghost', true)}>Cancel</button>
      </div>
    </form>
  );
}

export default function DevelopmentPlans() {
  const [plans,       setPlans]       = useState([]);
  const [critRoles,   setCritRoles]   = useState([]);
  const [employees, empError]         = useCurrentEmployees();
  const [selPlan,     setSelPlan]     = useState(null);
  const [planDetail,  setPlanDetail]  = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [loadError,   setLoadError]   = useState('');
  const [detailLoad,  setDetailLoad]  = useState(false);
  const [detailError, setDetailError] = useState('');
  const [saving,      setSaving]      = useState(false);
  const [msg, flash]                  = useFlash();
  const [statusFilter, setStatusFilter] = useState('');

  const [tab, setTab] = useState('plans');

  const [planForm, setPlanForm]     = useState(null);   // null | { initial, id }
  const [actionForm, setActionForm] = useState(null);   // null | { initial, id }
  const [showMentorForm, setShowMentorForm] = useState(false);
  const [pendingDeleteAction, setPendingDeleteAction] = useState(null);
  const [pendingDeletePlan,   setPendingDeletePlan]   = useState(null);

  const loadPlans = useCallback(async () => {
    const [plRes, crRes] = await Promise.allSettled([
      api.get('/succession/development-plans'),
      api.get('/succession/critical-roles'),
    ]);
    if (plRes.status === 'fulfilled') setPlans(plRes.value.data || []);
    if (crRes.status === 'fulfilled') setCritRoles(crRes.value.data || []);
    const failed = [plRes, crRes].find(r => r.status === 'rejected');
    setLoadError(failed ? errText(failed.reason, 'The development plans could not be loaded') : '');
    setLoading(false);
  }, []);

  useEffect(() => { loadPlans(); }, [loadPlans]);

  const loadPlanDetail = async (id) => {
    setDetailLoad(true);
    try {
      const r = await api.get(`/succession/development-plans/${id}`);
      setPlanDetail(r.data);
      setDetailError('');
    } catch (err) {
      setPlanDetail(null);
      setDetailError(errText(err, 'Could not load the plan'));
    } finally { setDetailLoad(false); }
  };

  const selectPlan = (plan) => {
    setSelPlan(plan);
    loadPlanDetail(plan.id);
    setTab('detail');
    setActionForm(null);
    setShowMentorForm(false);
    setPlanForm(null);
  };
  const refresh = () => { loadPlans(); if (selPlan) loadPlanDetail(selPlan.id); };

  /* ── Plan CRUD ── */
  const submitPlan = async (f) => {
    setSaving(true);
    try {
      const common = {
        plan_title:       f.plan_title.trim(),
        critical_role_id: f.critical_role_id ? Number(f.critical_role_id) : null,
        start_date:       f.start_date || null,
        target_date:      f.target_date || null,
        notes:            f.notes || null,
      };
      if (planForm?.id) {
        if (!common.start_date) delete common.start_date;   // a plan always has a start date
        await api.patch(`/succession/development-plans/${planForm.id}`, common);
        flash('Plan updated');
      } else {
        const r = await api.post('/succession/development-plans', { ...common, employee_id: Number(f.employee_id) });
        flash('Development plan created');
        setPlanForm(null);
        await loadPlans();
        selectPlan({ ...r.data, plan_title: r.data.plan_title });
        return;
      }
      setPlanForm(null);
      refresh();
    } catch (err) {
      flash(errText(err, 'Failed to save the plan'), 'error');
    } finally { setSaving(false); }
  };

  const startEditPlan = (p) => setPlanForm({
    id: p.id,
    initial: {
      employee_id: p.employee_id, plan_title: p.plan_title || '',
      critical_role_id: p.critical_role_id ? String(p.critical_role_id) : '',
      start_date: p.start_date?.split('T')[0] || '', target_date: p.target_date?.split('T')[0] || '',
      notes: p.notes || '',
    },
  });

  const updatePlanStatus = async (id, status) => {
    try {
      await api.patch(`/succession/development-plans/${id}`, { status });
      refresh();
      flash(`Plan marked as ${status}`);
    } catch (err) { flash(errText(err, 'Failed'), 'error'); }
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
    } catch (err) { flash(errText(err, 'Failed'), 'error'); }
  };

  /* ── Action CRUD ── */
  const submitAction = async (f) => {
    if (!selPlan) return;
    setSaving(true);
    try {
      const payload = {
        action_type: f.action_type, title: f.title.trim(), description: f.description || null,
        due_date: f.due_date || null, linked_skill: f.linked_skill || null,
        owner_employee_id: f.owner_employee_id ? Number(f.owner_employee_id) : null,
        linked_training_id: ['training', 'certification'].includes(f.action_type) && f.linked_training_id ? Number(f.linked_training_id) : null,
      };
      if (actionForm?.id) {
        await api.patch(`/succession/development-plans/${selPlan.id}/actions/${actionForm.id}`, payload);
        flash('Action updated');
      } else {
        await api.post(`/succession/development-plans/${selPlan.id}/actions`, payload);
        flash('Action added');
      }
      setActionForm(null);
      refresh();
    } catch (err) {
      flash(errText(err, 'Failed to save the action'), 'error');
    } finally { setSaving(false); }
  };

  const updateActionStatus = async (planId, actionId, status) => {
    try {
      await api.patch(`/succession/development-plans/${planId}/actions/${actionId}`, { status });
      refresh();
    } catch (err) { flash(errText(err, 'Failed'), 'error'); }
  };

  const deleteAction = async () => {
    if (!pendingDeleteAction) return;
    const { planId, actionId } = pendingDeleteAction;
    setPendingDeleteAction(null);
    try {
      await api.delete(`/succession/development-plans/${planId}/actions/${actionId}`);
      refresh();
      flash('Action deleted');
    } catch (err) { flash(errText(err, 'Failed'), 'error'); }
  };

  /* ── Mentor within a plan ── */
  const submitMentor = async (form) => {
    setSaving(true);
    try {
      await api.post('/succession/mentoring', mentorPayload(form, { development_plan_id: selPlan?.id || null }));
      flash('Mentoring assignment created');
      setShowMentorForm(false);
      refresh();
    } catch (err) {
      flash(errText(err, 'Failed to assign the mentor'), 'error');
    } finally { setSaving(false); }
  };
  const setMentorStatus = async (id, status) => {
    try {
      await api.patch(`/succession/mentoring/${id}`, { status });
      refresh();
    } catch (err) { flash(errText(err, 'Failed'), 'error'); }
  };

  const tabStyle = (active) => ({
    padding: '7px 16px', border: 'none', cursor: 'pointer', borderRadius: 6,
    fontWeight: 600, fontSize: 13,
    background: active ? '#6B3FDB' : '#e9e4ff',
    color: active ? '#fff' : '#6B3FDB',
  });

  if (loading) return <Spinner />;

  const shownPlans = statusFilter ? plans.filter(p => p.status === statusFilter) : plans;

  return (
    <div>
      <ConfirmDialog
        open={!!pendingDeleteAction}
        title="Delete Action"
        message="Delete this action? The plan's progress is recalculated."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteAction}
        onCancel={() => setPendingDeleteAction(null)}
      />
      <ConfirmDialog
        open={!!pendingDeletePlan}
        title="Delete Plan"
        message="Delete this development plan and all its actions? Mentoring assignments stay, unlinked from the plan."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deletePlan}
        onCancel={() => setPendingDeletePlan(null)}
      />

      <Flash msg={msg} />
      <LoadError text={loadError} onRetry={loadPlans} />
      <LoadError text={empError} />

      {/* Top tabs */}
      <div role="tablist" aria-label="Development views" style={{ display: 'flex', gap: 6, marginBottom: 16, borderBottom: '2px solid #e9e4ff', paddingBottom: 6, flexWrap: 'wrap' }}>
        <button type="button" role="tab" aria-selected={tab === 'plans'} style={tabStyle(tab === 'plans')} onClick={() => setTab('plans')}>All Plans</button>
        {selPlan && (
          <button type="button" role="tab" aria-selected={tab === 'detail'} style={tabStyle(tab === 'detail')} onClick={() => setTab('detail')} title={selPlan.plan_title}>
            {selPlan.plan_title?.substring(0, 24)}{selPlan.plan_title?.length > 24 ? '...' : ''}
          </button>
        )}
        <button type="button" role="tab" aria-selected={tab === 'mentoring'} style={tabStyle(tab === 'mentoring')} onClick={() => setTab('mentoring')}>Mentoring</button>
      </div>

      {/* ── Plans List ── */}
      {tab === 'plans' && (
        <div>
          <div style={{ marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button type="button" style={BTN(planForm && !planForm.id ? 'secondary' : 'primary')}
              onClick={() => setPlanForm(planForm && !planForm.id ? null : { initial: PLAN_DEFAULT })}>
              {planForm && !planForm.id ? 'Cancel' : '+ New Plan'}
            </button>
            <select aria-label="Status" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
                    style={{ ...INP, width: 'auto', fontSize: 12 }}>
              <option value="">All statuses</option>
              {Object.keys(STATUS_COLORS).map(s => <option key={s} value={s}>{titleCase(s)}</option>)}
            </select>
          </div>

          {planForm && !planForm.id && (
            <PlanForm initial={planForm.initial} employees={employees} critRoles={critRoles}
                      saving={saving} onSubmit={submitPlan} onCancel={() => setPlanForm(null)} />
          )}

          {shownPlans.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: '#9ca3af' }}>
              <div style={{ fontWeight: 700, color: '#4c1d95', fontSize: 16 }}>
                {plans.length ? 'No plans with this status' : 'No development plans yet'}
              </div>
              {!plans.length && <div style={{ fontSize: 13, marginTop: 6 }}>Create a plan to track development activities for succession candidates.</div>}
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 16 }}>
              {shownPlans.map(plan => {
                const statusColor = STATUS_COLORS[plan.status] || '#6b7280';
                const pct = plan.overall_progress || 0;
                return (
                  <button type="button" key={plan.id}
                    style={{ background: '#fff', borderRadius: 12, border: '1px solid #e9e4ff', textAlign: 'left',
                             padding: 18, cursor: 'pointer', transition: 'box-shadow .15s', font: 'inherit',
                             boxShadow: selPlan?.id === plan.id ? '0 0 0 2px #6B3FDB' : 'none' }}
                    onClick={() => selectPlan(plan)}>

                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10, gap: 8 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: '#1f2937', flex: 1 }}>{plan.plan_title}</div>
                      <Chip color={statusColor}>{titleCase(plan.status)}</Chip>
                    </div>

                    <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <strong style={{ color: '#1f2937' }}>{plan.employee_name}</strong>
                        {plan.department ? ` · ${plan.department}` : ''}
                        <PhaseBadge phase={plan.employment_phase} />
                      </span>
                      {plan.target_role && <div style={{ color: '#6B3FDB', marginTop: 2 }}>Target: {plan.target_role}</div>}
                    </div>

                    <div style={{ marginBottom: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#6b7280', marginBottom: 4 }}>
                        <span>{plan.completed_count}/{plan.action_count} actions</span>
                        <span style={{ fontWeight: 700 }}>{pct}%</span>
                      </div>
                      <ProgressBar value={pct} />
                    </div>

                    <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', fontSize: 11, color: '#9ca3af' }}>
                      <span>{plan.target_date ? `Due: ${fmtDate(plan.target_date)}` : 'No deadline'}</span>
                      {plan.mentor_count > 0 && (
                        <span style={{ color: '#6B3FDB', fontWeight: 600 }}>
                          {plan.mentor_count} mentor{plan.mentor_count > 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Plan Detail ── */}
      {tab === 'detail' && selPlan && (
        <div>
          {detailLoad && !planDetail ? <Spinner /> : planDetail ? (
            <div>
              {planForm?.id === planDetail.id && (
                <PlanForm editing initial={planForm.initial} employees={employees} critRoles={critRoles}
                          saving={saving} onSubmit={submitPlan} onCancel={() => setPlanForm(null)} />
              )}

              {/* Plan header */}
              <div style={{ background: '#fff', borderRadius: 12, padding: 20, marginBottom: 20, border: '1px solid #e9e4ff' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                  <div>
                    <h3 style={{ margin: '0 0 4px', color: '#4c1d95', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      {planDetail.plan_title}
                      <Chip color={STATUS_COLORS[planDetail.status] || '#6b7280'}>{titleCase(planDetail.status)}</Chip>
                    </h3>
                    <div style={{ fontSize: 13, color: '#6b7280', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      {planDetail.employee_name}
                      {planDetail.designation ? ` — ${planDetail.designation}` : ''}
                      {planDetail.target_role ? ` · Target: ${planDetail.target_role}` : ''}
                      <PhaseBadge phase={planDetail.employment_phase} />
                    </div>
                    <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
                      {fmtDate(planDetail.start_date)} → {planDetail.target_date ? fmtDate(planDetail.target_date) : 'no target date'}
                      {planDetail.completion_date ? ` · completed ${fmtDate(planDetail.completion_date)}` : ''}
                      {planDetail.created_by_name ? ` · created by ${planDetail.created_by_name}` : ''}
                    </div>
                    {planDetail.notes && (
                      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4, fontStyle: 'italic' }}>{planDetail.notes}</div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <button type="button" onClick={() => startEditPlan(planDetail)} style={BTN('outline', true)}>Edit Plan</button>
                    {planDetail.status === 'active' && (
                      <>
                        <button type="button" onClick={() => updatePlanStatus(planDetail.id, 'completed')} style={BTN('success', true)}>Mark Complete</button>
                        <button type="button" onClick={() => updatePlanStatus(planDetail.id, 'paused')} style={BTN('secondary', true)}>Pause</button>
                      </>
                    )}
                    {planDetail.status === 'paused' && (
                      <button type="button" onClick={() => updatePlanStatus(planDetail.id, 'active')} style={BTN('primary', true)}>Resume</button>
                    )}
                    {['active', 'paused'].includes(planDetail.status) && (
                      <button type="button" onClick={() => updatePlanStatus(planDetail.id, 'cancelled')} style={BTN('danger-outline', true)}>Cancel Plan</button>
                    )}
                    {['completed', 'cancelled'].includes(planDetail.status) && (
                      <button type="button" onClick={() => updatePlanStatus(planDetail.id, 'active')} style={BTN('outline', true)}>Reopen</button>
                    )}
                    <button type="button" onClick={() => setPendingDeletePlan(planDetail.id)} style={{ ...BTN('ghost', true), color: '#ef4444' }}>
                      Delete Plan
                    </button>
                  </div>
                </div>

                <div style={{ marginTop: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#6b7280', marginBottom: 6 }}>
                    <span>{planDetail.completed_count || 0}/{planDetail.action_count || 0} actions complete</span>
                    <span style={{ fontWeight: 700 }}>{planDetail.overall_progress || 0}%</span>
                  </div>
                  <ProgressBar value={planDetail.overall_progress || 0} />
                </div>
              </div>

              {/* Actions */}
              <div style={{ marginBottom: 24 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <h4 style={{ margin: 0, color: '#4c1d95' }}>Development Actions ({(planDetail.actions || []).length})</h4>
                  <button type="button" onClick={() => setActionForm(actionForm && !actionForm.id ? null : { initial: ACTION_DEFAULT })}
                    style={BTN(actionForm && !actionForm.id ? 'secondary' : 'primary', true)}>
                    {actionForm && !actionForm.id ? 'Cancel' : '+ Add Action'}
                  </button>
                </div>

                {actionForm && !actionForm.id && (
                  <ActionForm initial={actionForm.initial} employees={employees} saving={saving}
                              onSubmit={submitAction} onCancel={() => setActionForm(null)} />
                )}

                {(planDetail.actions || []).length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '24px 0', color: '#9ca3af', fontSize: 13 }}>
                    No actions yet. Click &quot;+ Add Action&quot; to build the development plan. Progress is the share of completed actions.
                  </div>
                ) : (planDetail.actions || []).map(action => {
                  const ac = ACTION_COLORS[action.status] || '#9ca3af';
                  if (actionForm?.id === action.id) {
                    return (
                      <ActionForm key={action.id} editing initial={actionForm.initial} employees={employees} saving={saving}
                                  onSubmit={submitAction} onCancel={() => setActionForm(null)} />
                    );
                  }
                  return (
                    <div key={action.id}
                      style={{ background: action.status === 'completed' ? '#f0fdf4' : '#fff',
                               borderRadius: 10, padding: 14, marginBottom: 8,
                               border: `1px solid ${action.status === 'completed' ? '#bbf7d0' : '#e9e4ff'}`,
                               display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                      <div aria-hidden="true" style={{ width: 12, height: 12, borderRadius: '50%', background: ac, flexShrink: 0, marginTop: 4 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                          <div style={{ fontWeight: 600, fontSize: 13, color: '#1f2937',
                                        textDecoration: ['completed', 'cancelled'].includes(action.status) ? 'line-through' : 'none' }}>
                            {action.title}
                          </div>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <select aria-label={`Status of ${action.title}`} value={action.status}
                              onChange={e => updateActionStatus(planDetail.id, action.id, e.target.value)}
                              style={{ ...INP, width: 'auto', padding: '3px 6px', fontSize: 11, color: ac, fontWeight: 600 }}>
                              {ACTION_STATUS.map(s => <option key={s} value={s}>{titleCase(s)}</option>)}
                            </select>
                            <button type="button" onClick={() => setActionForm({ id: action.id, initial: {
                                action_type: action.action_type || 'task', title: action.title || '', description: action.description || '',
                                due_date: action.due_date?.split('T')[0] || '', owner_employee_id: action.owner_employee_id ? String(action.owner_employee_id) : '',
                                owner_name: action.owner_name, linked_skill: action.linked_skill || '', linked_training_id: action.linked_training_id ? String(action.linked_training_id) : '' } })}
                              style={{ ...BTN('outline', true), fontSize: 11, padding: '2px 8px' }}>
                              Edit
                            </button>
                            <button type="button" onClick={() => setPendingDeleteAction({ planId: planDetail.id, actionId: action.id })}
                              style={{ ...BTN('ghost', true), fontSize: 11, padding: '2px 8px', color: '#ef4444' }}>
                              Delete
                            </button>
                          </div>
                        </div>
                        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                          <Chip color="#6B3FDB">{titleCase(action.action_type)}</Chip>
                          {action.due_date && <span>Due: {fmtDate(action.due_date)}</span>}
                          {action.completion_date && <span>Done: {fmtDate(action.completion_date)}</span>}
                          {action.owner_name && <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>Owner: {action.owner_name} <PhaseBadge phase={action.owner_phase} /></span>}
                          {action.linked_skill && <span>Skill: {action.linked_skill}</span>}
                          {action.training_title && <span>Training: {action.training_title} · {fmtDate(action.training_date)} · {titleCase(action.training_enrolment_status || 'not enrolled')}</span>}
                        </div>
                        {action.description && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>{action.description}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Mentors */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <h4 style={{ margin: 0, color: '#4c1d95' }}>Mentoring ({(planDetail.mentors || []).length})</h4>
                  <button type="button" onClick={() => setShowMentorForm(v => !v)} style={BTN(showMentorForm ? 'secondary' : 'outline', true)}
                    disabled={planDetail.employment_phase === 'left'}>
                    {showMentorForm ? 'Cancel' : '+ Assign Mentor'}
                  </button>
                </div>

                {showMentorForm && (
                  <MentorForm employees={employees} fixedMentee={planDetail.employee_name}
                    initial={{ mentee_employee_id: planDetail.employee_id }} saving={saving}
                    title={`Assign a mentor to ${planDetail.employee_name}`}
                    onSubmit={submitMentor} onCancel={() => setShowMentorForm(false)} />
                )}

                {(planDetail.mentors || []).length === 0 && !showMentorForm && (
                  <div style={{ fontSize: 13, color: '#9ca3af' }}>No mentor assigned to this plan.</div>
                )}
                {(planDetail.mentors || []).map(m => (
                  <div key={m.id} style={{ background: '#f5f3ff', borderRadius: 10, padding: 12,
                                           marginBottom: 8, border: '1px solid #e9e4ff',
                                           display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13, color: '#1f2937', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        {m.mentor_name}
                        <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 400 }}>{m.mentor_designation}</span>
                        <PhaseBadge phase={m.mentor_phase} />
                      </div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                        {m.focus_area ? `${m.focus_area} · ` : ''}{m.session_count || 0} session{m.session_count === 1 ? '' : 's'}
                        {m.next_session_date ? ` · next ${fmtDate(m.next_session_date)}` : ''}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <Chip color={MENTOR_COLORS[m.status] || '#6b7280'}>{titleCase(m.status)}</Chip>
                      {m.status === 'active' && (
                        <>
                          <button type="button" onClick={() => setMentorStatus(m.id, 'completed')} style={{ ...BTN('ghost', true), color: '#16a34a' }}>Complete</button>
                          <button type="button" onClick={() => setMentorStatus(m.id, 'cancelled')} style={{ ...BTN('ghost', true), color: '#ef4444' }}>Cancel</button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
                <p style={{ fontSize: 11, color: '#9ca3af', margin: '6px 0 0' }}>Log sessions on the Mentoring tab.</p>
              </div>
            </div>
          ) : (
            <LoadError text={detailError || 'Could not load the plan.'} onRetry={() => loadPlanDetail(selPlan.id)} />
          )}
        </div>
      )}

      {/* ── Mentoring Tab ── */}
      {tab === 'mentoring' && <MentoringList employees={employees} flash={flash} />}
    </div>
  );
}

/* ── Sessions of one assignment ── */
function SessionLog({ assignment, flash, onChanged }) {
  const [sessions, setSessions] = useState(null);
  const [form, setForm] = useState({ ...SESSION_DEFAULT, session_date: localDay() });
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const active = assignment.status === 'active';

  const load = useCallback(async () => {
    try {
      const r = await api.get(`/succession/mentoring/${assignment.id}/sessions`);
      setSessions(r.data || []);
    } catch (err) { setSessions([]); flash(errText(err, 'Could not load the sessions'), 'error'); }
  }, [assignment.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post(`/succession/mentoring/${assignment.id}/sessions`, {
        session_date: form.session_date, topic: form.topic || null, notes: form.notes || null,
        duration_minutes: form.duration_minutes ? Number(form.duration_minutes) : null,
        next_session_date: form.next_session_date || null,
      });
      flash('Session logged');
      setForm({ ...SESSION_DEFAULT, session_date: localDay() });
      await load();
      onChanged();
    } catch (err) { flash(errText(err, 'Failed to log the session'), 'error'); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    const s = pendingDelete;
    setPendingDelete(null);
    try {
      await api.delete(`/succession/mentoring/${assignment.id}/sessions/${s.id}`);
      flash('Session deleted');
      await load();
      onChanged();
    } catch (err) { flash(errText(err, 'Failed'), 'error'); }
  };

  return (
    <div style={{ background: '#faf9ff', padding: 14, borderRadius: 8 }}>
      <ConfirmDialog open={!!pendingDelete} title="Delete Session"
        message={pendingDelete ? `Delete the session of ${fmtDate(pendingDelete.session_date)}?` : ''}
        confirmLabel="Delete" variant="danger" onConfirm={remove} onCancel={() => setPendingDelete(null)} />
      {active && (
        <form onSubmit={submit} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 8, alignItems: 'end', marginBottom: 12 }}>
          <div>
            <label style={LBL} htmlFor={`ss-date-${assignment.id}`}>Session date *</label>
            <input id={`ss-date-${assignment.id}`} type="date" required max={localDay()} value={form.session_date}
                   onChange={e => setForm(f => ({ ...f, session_date: e.target.value }))} style={INP} />
          </div>
          <div>
            <label style={LBL} htmlFor={`ss-min-${assignment.id}`}>Minutes</label>
            <input id={`ss-min-${assignment.id}`} type="number" min={1} max={1440} step={1} value={form.duration_minutes}
                   onChange={e => setForm(f => ({ ...f, duration_minutes: e.target.value }))} style={INP} />
          </div>
          <div>
            <label style={LBL} htmlFor={`ss-topic-${assignment.id}`}>Topic</label>
            <input id={`ss-topic-${assignment.id}`} maxLength={200} value={form.topic}
                   onChange={e => setForm(f => ({ ...f, topic: e.target.value }))} style={INP} />
          </div>
          <div>
            <label style={LBL} htmlFor={`ss-next-${assignment.id}`}>Next session</label>
            <input id={`ss-next-${assignment.id}`} type="date" min={form.session_date || undefined} value={form.next_session_date}
                   onChange={e => setForm(f => ({ ...f, next_session_date: e.target.value }))} style={INP} />
          </div>
          <div style={{ gridColumn: '1/-1' }}>
            <label style={LBL} htmlFor={`ss-notes-${assignment.id}`}>Notes</label>
            <input id={`ss-notes-${assignment.id}`} maxLength={4000} value={form.notes}
                   onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={INP} />
          </div>
          <div><button type="submit" disabled={saving} style={BTN('primary', true)}>{saving ? 'Saving...' : 'Log Session'}</button></div>
        </form>
      )}
      {!active && <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 8 }}>This assignment is {assignment.status}; no new sessions can be logged.</div>}
      {sessions === null ? <Spinner /> : sessions.length === 0 ? (
        <div style={{ fontSize: 12, color: '#9ca3af' }}>No sessions logged yet.</div>
      ) : sessions.map(s => (
        <div key={s.id} style={{ borderTop: '1px solid #ede9fe', padding: '8px 0', fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <div>
            <strong>{fmtDate(s.session_date)}</strong>
            {s.duration_minutes ? ` · ${s.duration_minutes} min` : ''}
            {s.topic ? ` · ${s.topic}` : ''}
            {s.next_session_date ? <span style={{ color: '#6B3FDB' }}> · next {fmtDate(s.next_session_date)}</span> : ''}
            {s.notes && <div style={{ color: '#6b7280', marginTop: 2 }}>{s.notes}</div>}
            {s.created_by_name && <div style={{ color: '#9ca3af', marginTop: 2 }}>Logged by {s.created_by_name}</div>}
          </div>
          <button type="button" onClick={() => setPendingDelete(s)} style={{ ...BTN('ghost', true), color: '#ef4444', alignSelf: 'flex-start' }}>Delete</button>
        </div>
      ))}
    </div>
  );
}

function MentoringList({ employees, flash }) {
  const [assignments, setAssignments] = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');
  const [showForm,    setShowForm]    = useState(false);
  const [saving,      setSaving]      = useState(false);
  const [openId,      setOpenId]      = useState(null);
  const [editing,     setEditing]     = useState(null);   // { id, focus_area, end_date, notes }
  const [pendingDelete, setPendingDelete] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get('/succession/mentoring');
      setAssignments(r.data || []);
      setError('');
    } catch (err) { setError(errText(err, 'The mentoring assignments could not be loaded')); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const submit = async (form) => {
    setSaving(true);
    try {
      await api.post('/succession/mentoring', mentorPayload(form));
      flash('Mentoring assignment created');
      setShowForm(false);
      load();
    } catch (err) {
      flash(errText(err, 'Failed to assign the mentor'), 'error');
    } finally { setSaving(false); }
  };

  const updateStatus = async (id, status) => {
    try {
      await api.patch(`/succession/mentoring/${id}`, { status });
      load();
    } catch (err) { flash(errText(err, 'Failed'), 'error'); }
  };
  const saveEdit = async (e) => {
    e.preventDefault();
    try {
      await api.patch(`/succession/mentoring/${editing.id}`, {
        focus_area: editing.focus_area || null, end_date: editing.end_date || null, notes: editing.notes || null,
      });
      flash('Assignment updated');
      setEditing(null);
      load();
    } catch (err) { flash(errText(err, 'Failed'), 'error'); }
  };
  const remove = async () => {
    const a = pendingDelete;
    setPendingDelete(null);
    try {
      await api.delete(`/succession/mentoring/${a.id}`);
      flash('Assignment deleted');
      load();
    } catch (err) { flash(errText(err, 'Failed'), 'error'); }
  };

  if (loading) return <Spinner />;

  return (
    <div>
      <ConfirmDialog open={!!pendingDelete} title="Delete Assignment"
        message={pendingDelete ? `Delete the mentoring of ${pendingDelete.mentee_name} by ${pendingDelete.mentor_name}, and its ${pendingDelete.session_count || 0} logged session(s)?` : ''}
        confirmLabel="Delete" variant="danger" onConfirm={remove} onCancel={() => setPendingDelete(null)} />
      <LoadError text={error} onRetry={load} />
      <div style={{ marginBottom: 16 }}>
        <button type="button" style={BTN(showForm ? 'secondary' : 'primary')} onClick={() => setShowForm(v => !v)}>
          {showForm ? 'Cancel' : '+ Assign Mentor'}
        </button>
      </div>

      {showForm && (
        <MentorForm employees={employees} saving={saving} onSubmit={submit} onCancel={() => setShowForm(false)} />
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
                {['Mentee', 'Mentor', 'Focus Area', 'Period', 'Sessions', 'Status', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '9px 12px', textAlign: 'left', borderBottom: '1px solid #e9e4ff', color: '#4c1d95', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {assignments.map(a => (
                <React.Fragment key={a.id}>
                  <tr style={{ borderBottom: openId === a.id || editing?.id === a.id ? 'none' : '1px solid #f0ebff' }}>
                    <td style={{ padding: '9px 12px', fontWeight: 600 }}>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>{a.mentee_name} <PhaseBadge phase={a.mentee_phase} /></span>
                      {a.plan_title && <div style={{ fontSize: 11, color: '#6B3FDB', fontWeight: 400 }}>{a.plan_title}</div>}
                    </td>
                    <td style={{ padding: '9px 12px' }}>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>{a.mentor_name} <PhaseBadge phase={a.mentor_phase} /></span>
                      {a.mentor_designation && <div style={{ fontSize: 11, color: '#6b7280' }}>{a.mentor_designation}</div>}
                    </td>
                    <td style={{ padding: '9px 12px', color: '#6b7280' }}>
                      {a.focus_area || '—'}
                      {a.notes && <div style={{ fontSize: 11, color: '#9ca3af' }}>{a.notes}</div>}
                    </td>
                    <td style={{ padding: '9px 12px', color: '#6b7280', whiteSpace: 'nowrap' }}>
                      {fmtDate(a.start_date)} → {a.end_date ? fmtDate(a.end_date) : 'open'}
                    </td>
                    <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>
                      <strong style={{ color: '#6B3FDB' }}>{a.session_count || 0}</strong>
                      {a.last_session_date && <div style={{ fontSize: 11, color: '#9ca3af' }}>last {fmtDate(a.last_session_date)}</div>}
                      {a.next_session_date && <div style={{ fontSize: 11, color: '#6B3FDB' }}>next {fmtDate(a.next_session_date)}</div>}
                    </td>
                    <td style={{ padding: '9px 12px' }}><Chip color={MENTOR_COLORS[a.status] || '#6b7280'}>{titleCase(a.status)}</Chip></td>
                    <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                        <button type="button" aria-expanded={openId === a.id} onClick={() => setOpenId(openId === a.id ? null : a.id)} style={BTN('outline', true)}>
                          Sessions
                        </button>
                        <button type="button" onClick={() => setEditing(editing?.id === a.id ? null : { id: a.id, focus_area: a.focus_area || '', end_date: a.end_date?.split('T')[0] || '', notes: a.notes || '', start_date: a.start_date })}
                          style={BTN('secondary', true)}>Edit</button>
                        {a.status === 'active' && (
                          <>
                            <button type="button" onClick={() => updateStatus(a.id, 'completed')} style={{ ...BTN('ghost', true), color: '#16a34a' }}>Complete</button>
                            <button type="button" onClick={() => updateStatus(a.id, 'cancelled')} style={{ ...BTN('ghost', true), color: '#ef4444' }}>Cancel</button>
                          </>
                        )}
                        {a.status !== 'active' && (
                          <button type="button" onClick={() => updateStatus(a.id, 'active')} style={BTN('ghost', true)}>Reopen</button>
                        )}
                        <button type="button" onClick={() => setPendingDelete(a)} style={{ ...BTN('ghost', true), color: '#ef4444' }}>Delete</button>
                      </span>
                    </td>
                  </tr>
                  {editing?.id === a.id && (
                    <tr style={{ borderBottom: openId === a.id ? 'none' : '1px solid #f0ebff' }}>
                      <td colSpan={7} style={{ padding: '0 12px 12px' }}>
                        <form onSubmit={saveEdit} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 8, alignItems: 'end', background: '#faf9ff', padding: 12, borderRadius: 8 }}>
                          <div>
                            <label style={LBL} htmlFor={`me-focus-${a.id}`}>Focus Area</label>
                            <input id={`me-focus-${a.id}`} maxLength={200} value={editing.focus_area} onChange={e => setEditing(x => ({ ...x, focus_area: e.target.value }))} style={INP} />
                          </div>
                          <div>
                            <label style={LBL} htmlFor={`me-end-${a.id}`}>End Date</label>
                            <input id={`me-end-${a.id}`} type="date" min={editing.start_date || undefined} value={editing.end_date} onChange={e => setEditing(x => ({ ...x, end_date: e.target.value }))} style={INP} />
                          </div>
                          <div style={{ gridColumn: 'span 2' }}>
                            <label style={LBL} htmlFor={`me-notes-${a.id}`}>Notes</label>
                            <input id={`me-notes-${a.id}`} maxLength={2000} value={editing.notes} onChange={e => setEditing(x => ({ ...x, notes: e.target.value }))} style={INP} />
                          </div>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button type="submit" style={BTN('primary', true)}>Save</button>
                            <button type="button" onClick={() => setEditing(null)} style={BTN('ghost', true)}>Cancel</button>
                          </div>
                        </form>
                      </td>
                    </tr>
                  )}
                  {openId === a.id && (
                    <tr style={{ borderBottom: '1px solid #f0ebff' }}>
                      <td colSpan={7} style={{ padding: '0 12px 12px' }}>
                        <SessionLog assignment={a} flash={flash} onChanged={load} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
