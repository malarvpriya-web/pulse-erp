import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { Plus, Target, X, TrendingUp, CheckCircle, AlertTriangle, Clock, Zap, Edit2, Trash2 } from 'lucide-react';
import './Goals.css';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { useAuth } from '@/context/AuthContext';

const EMPTY_FORM = {
  goal_title: '', goal_description: '', target_value: '', achieved_value: '0',
  unit: '', due_date: '', priority: 'Medium', status: 'active',
  category: '', review_period: '', weightage: '100',
};

const TAB_FILTERS = [
  { key: 'all',      label: 'All' },
  { key: 'active',   label: 'Active' },
  { key: 'achieved', label: 'Achieved' },
  { key: 'at_risk',  label: 'At Risk' },
  { key: 'overdue',  label: 'Overdue' },
  { key: 'draft',    label: 'Draft' },
];

// A worked example, shown on request while the employee has no goals of their
// own (owner, 2026-11-11: "add sample KPIs to understand the page"). Rendered
// only in the browser — never saved, never read by reviews. Four KPIs whose
// weightages add up to 100, one in each status the page tracks. Status follows
// the server's check-in rule: 100 % → achieved, under 30 % → at risk.
const inDays = (n) => {
  const d = new Date(); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const EXAMPLE_GOALS = [
  { id: 'ex-1', goal_title: 'Deliver project milestones on time', category: 'Delivery', priority: 'High',
    goal_description: 'Milestones completed by their planned date this quarter.',
    target_value: 12, achieved_value: 9, unit: 'milestones', weightage: 40, status: 'active', due_date: inDays(60) },
  { id: 'ex-2', goal_title: 'Customer issues resolved within SLA', category: 'Quality', priority: 'High',
    goal_description: 'Share of service tickets closed inside the agreed response time.',
    target_value: 95, achieved_value: 88, unit: '%', weightage: 25, status: 'active', due_date: inDays(60) },
  { id: 'ex-3', goal_title: 'Enquiries converted to orders', category: 'Sales', priority: 'Medium',
    goal_description: 'New enquiries that became confirmed orders.',
    target_value: 10, achieved_value: 2, unit: 'orders', weightage: 20, status: 'at_risk', due_date: inDays(45) },
  { id: 'ex-4', goal_title: 'Complete product & safety training', category: 'Learning', priority: 'Low',
    goal_description: 'Mandatory courses finished and passed.',
    target_value: 4, achieved_value: 4, unit: 'courses', weightage: 15, status: 'achieved', due_date: inDays(30) },
];

function pct(g) {
  const t = Number(g.target_value || 1);
  const a = Number(g.achieved_value || g.progress_pct || 0);
  if (g.progress_pct) return Math.min(100, Math.round(Number(g.progress_pct)));
  return Math.min(100, Math.round((a / t) * 100));
}

function ringColor(p) {
  return p >= 100 ? '#10b981' : p >= 70 ? '#4338ca' : p >= 30 ? '#7c5cf0' : '#ef4444';
}

function GoalCard({ goal, onCheckin, onEdit, onDelete, example = false, onUseTemplate, canManage = false }) {
  const p = pct(goal);
  const color = ringColor(p);
  const r = 22, circ = 2 * Math.PI * r;
  const offset = circ - (p / 100) * circ;
  const statusClass = `gl-chip-${(goal.status || 'active').toLowerCase().replace(' ', '_')}`;
  const priorityClass = `gl-badge-${(goal.priority || 'medium').toLowerCase()}`;
  const isOverdue = goal.due_date && new Date(goal.due_date) < new Date() && goal.status !== 'achieved';

  return (
    <div className="gl-card-v2">
      <div className="gl-card-top">
        <div className="gl-card-title">{goal.goal_title || goal.title}</div>
        <div className="gl-card-badges">
          {example && <span className="gl-badge gl-badge-example">Example</span>}
          {goal.priority && <span className={`gl-badge ${priorityClass}`}>{goal.priority}</span>}
          {goal.category && <span className="gl-badge gl-badge-cat">{goal.category}</span>}
        </div>
      </div>
      {(goal.goal_description || goal.description) && (
        <p style={{ fontSize: 12, color: '#6b7280', margin: 0, lineHeight: 1.5 }}>
          {goal.goal_description || goal.description}
        </p>
      )}
      <div className="gl-progress-area">
        <div className="gl-ring-wrap">
          <svg width={52} height={52}>
            <circle className="gl-ring-track" cx={26} cy={26} r={r} />
            <circle className="gl-ring-fill" cx={26} cy={26} r={r}
              stroke={color} strokeDasharray={circ}
              strokeDashoffset={offset} />
          </svg>
          <div className="gl-ring-pct">{p}%</div>
        </div>
        <div className="gl-progress-info">
          <div className="gl-progress-nums">
            <strong>{goal.achieved_value ?? goal.current_value ?? 0}</strong> / {goal.target_value || 0} {goal.unit || ''}
            {goal.weightage != null && <span className="gl-weight"> · weight {Number(goal.weightage)}%</span>}
          </div>
          <div className="gl-prog-track">
            <div className="gl-prog-fill" style={{ width: `${p}%`, background: color }} />
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className={`gl-status-chip ${statusClass}`}>{(goal.status || 'active').replace('_', ' ')}</span>
        {goal.due_date && (
          <span className="gl-due" style={isOverdue ? { color: '#dc2626', fontWeight: 700 } : {}}>
            <Clock size={11} /> Due: {new Date(goal.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
          </span>
        )}
      </div>
      {example ? (
        <div className="gl-card-actions">
          <button className="gl-btn-edit-v2" onClick={() => onUseTemplate(goal)}>
            <Plus size={11} /> Use as template
          </button>
        </div>
      ) : (
      <div className="gl-card-actions">
        <button className="gl-btn-checkin" onClick={() => onCheckin(goal)}>
          <Zap size={11} /> Check In
        </button>
        {/* Goals are set by the manager: only they edit or delete (2026-11-11). */}
        {canManage && (<>
          <button className="gl-btn-edit-v2" onClick={() => onEdit(goal)}>
            <Edit2 size={11} /> Edit
          </button>
          <button className="gl-btn-del" onClick={() => onDelete(goal.id)} aria-label="Delete goal">
            <Trash2 size={13} />
          </button>
        </>)}
      </div>
      )}
    </div>
  );
}

export default function Goals() {
  const [goals,     setGoals]     = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [tab,       setTab]       = useState('all');
  const [showForm,  setShowForm]  = useState(false);
  const [editGoal,  setEditGoal]  = useState(null);
  const [form,      setForm]      = useState(EMPTY_FORM);
  const [saving,    setSaving]    = useState(false);
  const [checkin,   setCheckin]   = useState(null);
  const [ciVal,     setCiVal]     = useState('');
  const [ciNote,    setCiNote]    = useState('');
  const [ciSaving,  setCiSaving]  = useState(false);
  const [toast,     setToast]     = useState(null);
  const [pendingHandleDelete, setPendingHandleDelete] = useState(null);
  const [showExample, setShowExample] = useState(false);
  // The worked example is for the super admin setting the page up, not for
  // employees (owner, 2026-11-11). Employees see their own goals only.
  const { hasAnyRole } = useAuth();
  const canSeeExample = hasAnyRole('super_admin');
  // Goals are set by the manager (owner, 2026-11-11). `team` = the people the
  // caller sets goals for (direct reports; HR / admin: everyone). `viewing` =
  // whose goals are shown: null = my own.
  const [team, setTeam] = useState([]);
  const [viewing, setViewing] = useState(null);
  const isManager = team.length > 0;
  const viewingMember = viewing != null ? team.find(m => String(m.id) === String(viewing)) : null;
  useEffect(() => {
    api.get('/performance/my-team').then(r => setTeam(Array.isArray(r.data) ? r.data : [])).catch(() => setTeam([]));
  }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const load = useCallback(() => {
    setLoading(true);
    api.get('/performance/goals', { params: viewing != null ? { employee_id: viewing } : {} })
      .then(r => setGoals(Array.isArray(r.data) ? r.data : []))
      .catch(() => setGoals([]))
      .finally(() => setLoading(false));
  }, [viewing]);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setEditGoal(null); setForm({ ...EMPTY_FORM, employee_id: viewing != null ? String(viewing) : '' }); setShowForm(true); };
  const openEdit   = (g) => {
    setEditGoal(g);
    setForm({
      goal_title: g.goal_title || g.title || '',
      goal_description: g.goal_description || g.description || '',
      target_value: g.target_value || '',
      achieved_value: g.achieved_value || '0',
      unit: g.unit || '',
      due_date: g.due_date ? g.due_date.slice(0, 10) : '',
      priority: g.priority || 'Medium',
      status: g.status || 'active',
      category: g.category || '',
      review_period: g.review_period || '',
      weightage: g.weightage || '100',
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.goal_title) return;
    if (!editGoal && !form.employee_id) { showToast('Choose the team member this goal is for', 'error'); return; }
    setSaving(true);
    try {
      const payload = {
        ...form,
        target_value:   Number(form.target_value)   || 0,
        achieved_value: Number(form.achieved_value) || 0,
        weightage:      Number(form.weightage)      || 100,
      };
      if (editGoal) {
        await api.put(`/performance/goals/${editGoal.id}`, payload);
        showToast('Goal updated');
      } else {
        await api.post('/performance/goals', payload);
        showToast('Goal created');
      }
      setShowForm(false);
      load();
    } catch (e) { showToast(e?.response?.data?.error || 'Failed to save goal', 'error'); }
    finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!pendingHandleDelete) return;
    const id = pendingHandleDelete;
    setPendingHandleDelete(null);
    try {
      await api.delete(`/performance/goals/${id}`);
      setGoals(gs => gs.filter(g => g.id !== id));
      showToast('Goal deleted');
    } catch { showToast('Delete failed', 'error'); }
  };

  const handleCheckin = async () => {
    if (!ciVal) return;
    setCiSaving(true);
    try {
      const res = await api.post(`/performance/goals/${checkin.id}/checkin`, {
        achieved_value: Number(ciVal), note: ciNote,
      });
      setGoals(gs => gs.map(g => g.id === checkin.id ? { ...g, ...res.data } : g));
      setCheckin(null); setCiVal(''); setCiNote('');
      showToast('Progress updated');
    } catch { showToast('Check-in failed', 'error'); }
    finally { setCiSaving(false); }
  };

  // Super admin only; while it is open it replaces the list, so the example is
  // never mixed with real goals.
  const example = canSeeExample && showExample;
  const list = example ? EXAMPLE_GOALS : goals;
  const useTemplate = (g) => {
    setEditGoal(null);
    setForm({
      ...EMPTY_FORM,
      goal_title: g.goal_title, goal_description: g.goal_description, target_value: String(g.target_value),
      unit: g.unit, category: g.category, priority: g.priority, weightage: String(g.weightage), due_date: g.due_date,
      employee_id: viewing != null ? String(viewing) : '',
    });
    setShowForm(true);
  };

  const counts = {
    all:      list.length,
    active:   list.filter(g => g.status === 'active').length,
    achieved: list.filter(g => g.status === 'achieved').length,
    at_risk:  list.filter(g => g.status === 'at_risk').length,
    overdue:  list.filter(g => g.status === 'overdue').length,
    draft:    list.filter(g => g.status === 'draft').length,
  };
  const filtered = tab === 'all' ? list : list.filter(g => g.status === tab);

  return (
    <PageShell dock={
      <PageHero
        icon={Target}
        eyebrow="Performance"
        title="Goals & KPIs"
        actions={<>
          {canSeeExample && (
            <button className="plh-cta plh-cta--ghost" onClick={() => { setTab('all'); setShowExample(v => !v); }}>
              {showExample ? 'Hide example' : 'See an example'}
            </button>
          )}
          {isManager && (
            <button className="plh-cta" onClick={openCreate}>
              <Plus size={15} /> Add Goal
            </button>
          )}
        </>}
      />
    }>
      {toast && <div className={`gl-toast gl-toast-${toast.type}`}>{toast.msg}</div>}


      <div className="gl-body">
        {isManager ? (
          <div className="gl-viewing">
            <label htmlFor="gl-viewing">Viewing</label>
            <select id="gl-viewing" className="gl-select-v2" value={viewing ?? ''}
              onChange={e => { setShowExample(false); setTab('all'); setViewing(e.target.value === '' ? null : e.target.value); }}>
              <option value="">My goals</option>
              {team.map(m => <option key={m.id} value={m.id}>{m.name}{m.designation ? ` — ${m.designation}` : ''}</option>)}
            </select>
            <span className="gl-viewing-hint">
              {viewingMember ? `You set ${viewingMember.name}'s goals: add, edit or delete them here.` : 'Pick a team member to set their goals.'}
            </span>
          </div>
        ) : (
          <div className="gl-viewing gl-viewing-note">
            Your goals are set by your manager. Use <b>Check In</b> to record your progress.
          </div>
        )}
        {example && (
          <div className="gl-example-banner">
            <div>
              <strong>Example — not saved.</strong> This is how the page looks with four KPIs.
              It is shown only to super admins and is on nobody&apos;s record; use any card as a template.
            </div>
            <button className="gl-btn-cancel-v2" onClick={() => setShowExample(false)}>Hide example</button>
          </div>
        )}
        {example && (
          <div className="gl-example-help">
            <strong>How this page works</strong>
            <ul>
              <li><b>Target</b> and <b>Unit</b> say what “done” is — e.g. 12 milestones, 95 %.</li>
              <li><b>Check In</b> records where you are now; the ring shows progress against the target.</li>
              <li>Status follows progress: <b>Achieved</b> at 100 %, <b>At risk</b> below 30 %, otherwise <b>On track</b>.</li>
              <li><b>Weightage</b> is how much each KPI counts in your review; together they should add up to 100 %.</li>
              <li>Your manager sees these goals in your performance review.</li>
            </ul>
          </div>
        )}
        {/* KPIs */}
        <div className="gl-kpis">
          {[
            { icon: <Target size={16} />,        val: counts.all,      label: 'Total Goals',  bg: '#eef2ff', color: '#4338ca' },
            { icon: <TrendingUp size={16} />,     val: counts.active,   label: 'On Track',     bg: '#dbeafe', color: '#1d4ed8' },
            { icon: <AlertTriangle size={16} />,  val: counts.at_risk,  label: 'At Risk',      bg: '#ede9fe', color: '#6d28d9' },
            { icon: <CheckCircle size={16} />,    val: counts.achieved, label: 'Achieved',     bg: '#dcfce7', color: '#15803d' },
            { icon: <Clock size={16} />,          val: counts.overdue,  label: 'Overdue',      bg: '#fee2e2', color: '#dc2626' },
          ].map(k => (
            <div key={k.label} className="gl-kpi">
              <div className="gl-kpi-icon" style={{ background: k.bg, color: k.color }}>{k.icon}</div>
              <div className="gl-kpi-val">{k.val}</div>
              <div className="gl-kpi-lbl">{k.label}</div>
            </div>
          ))}
        </div>

        {/* Filter tabs */}
        <div className="gl-tabs">
          {TAB_FILTERS.map(t => (
            <button
              key={t.key}
              className={`gl-tab${tab === t.key ? ' gl-tab-active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              <span className="gl-tab-count">{counts[t.key] ?? 0}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        {loading ? (
          <div className="gl-loading"><div className="gl-spinner" /></div>
        ) : filtered.length === 0 ? (
          <div className="gl-empty">
            <Target size={40} color="#d1d5db" />
            <p>{list.length === 0 ? 'No goals set yet' : `No ${tab.replace('_', ' ')} goals`}</p>
            {list.length === 0 && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'center' }}>
                {isManager && viewing != null && (
                  <button className="gl-btn-primary" onClick={openCreate}>
                    <Plus size={14} /> Set First Goal
                  </button>
                )}
                {canSeeExample && (
                  <button className="gl-btn-cancel-v2" onClick={() => { setTab('all'); setShowExample(true); }}>
                    See an example
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="gl-grid">
            {filtered.map(g => (
              <GoalCard
                key={g.id}
                goal={g}
                example={example}
                onUseTemplate={useTemplate}
                canManage={viewing != null}
                onCheckin={g => { setCheckin(g); setCiVal(String(g.achieved_value || g.current_value || '')); setCiNote(''); }}
                onEdit={openEdit}
                onDelete={setPendingHandleDelete}
              />
            ))}
          </div>
        )}
      </div>

      {/* The delete button only set pendingHandleDelete — this dialog was never
          rendered, so a goal could not be deleted (2026-11-11). */}
      <ConfirmDialog
        open={pendingHandleDelete != null}
        title="Delete goal"
        message="Delete this goal? It will no longer appear in your goals or your review."
        confirmLabel="Delete"
        variant="warning"
        onConfirm={handleDelete}
        onCancel={() => setPendingHandleDelete(null)}
      />

      {/* Check-in modal */}
      {checkin && (
        <div className="gl-modal-overlay" onClick={() => setCheckin(null)}>
          <div className="gl-modal-box gl-modal-box-sm" onClick={e => e.stopPropagation()}>
            <div className="gl-modal-hd-v2">
              <h3>Check In Progress</h3>
              <button className="gl-modal-close" onClick={() => setCheckin(null)}>✕</button>
            </div>
            <div className="gl-modal-body-v2">
              <div className="gl-checkin-curr">
                <strong>{checkin.goal_title || checkin.title}</strong><br />
                Target: <strong>{checkin.target_value} {checkin.unit}</strong>
              </div>
              <div className="gl-field">
                <label className="gl-label-v2">Current Value *</label>
                <input type="number" className="gl-input-v2"
                  placeholder={`0 – ${checkin.target_value}`}
                  value={ciVal} onChange={e => setCiVal(e.target.value)} />
              </div>
              <div className="gl-field">
                <label className="gl-label-v2">Note (optional)</label>
                <textarea className="gl-textarea-v2" rows={3}
                  placeholder="Any context or blockers?"
                  value={ciNote} onChange={e => setCiNote(e.target.value)} />
              </div>
            </div>
            <div className="gl-modal-ft-v2">
              <button className="gl-btn-cancel-v2" onClick={() => setCheckin(null)}>Cancel</button>
              <button className="gl-btn-save-v2" onClick={handleCheckin} disabled={ciSaving || !ciVal}>
                {ciSaving ? 'Saving…' : 'Save Progress'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create / Edit modal */}
      {showForm && (
        <div className="gl-modal-overlay" onClick={() => setShowForm(false)}>
          <div className="gl-modal-box" onClick={e => e.stopPropagation()}>
            <div className="gl-modal-hd-v2">
              <h3>{editGoal ? 'Edit Goal' : 'New Goal'}</h3>
              <button className="gl-modal-close" onClick={() => setShowForm(false)}>✕</button>
            </div>
            <div className="gl-modal-body-v2">
              {!editGoal && (
                <div className="gl-field">
                  <label className="gl-label-v2" htmlFor="gl-for">For team member *</label>
                  <select id="gl-for" className="gl-select-v2" value={form.employee_id || ''}
                    onChange={e => setForm(f => ({ ...f, employee_id: e.target.value }))}>
                    <option value="">Choose…</option>
                    {team.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
              )}
              <div className="gl-field">
                <label className="gl-label-v2">Goal Title *</label>
                <input className="gl-input-v2" placeholder="e.g. Increase revenue by 20%"
                  value={form.goal_title}
                  onChange={e => setForm(f => ({ ...f, goal_title: e.target.value }))} />
              </div>
              <div className="gl-field">
                <label className="gl-label-v2">Description</label>
                <textarea className="gl-textarea-v2" rows={3} placeholder="Describe the goal..."
                  value={form.goal_description}
                  onChange={e => setForm(f => ({ ...f, goal_description: e.target.value }))} />
              </div>
              <div className="gl-form-row">
                <div className="gl-field">
                  <label className="gl-label-v2">Target Value</label>
                  <input type="number" className="gl-input-v2" placeholder="100"
                    value={form.target_value}
                    onChange={e => setForm(f => ({ ...f, target_value: e.target.value }))} />
                </div>
                <div className="gl-field">
                  <label className="gl-label-v2">Unit</label>
                  <input className="gl-input-v2" placeholder="%, ₹, count…"
                    value={form.unit}
                    onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} />
                </div>
              </div>
              <div className="gl-form-row">
                <div className="gl-field">
                  <label className="gl-label-v2">Category</label>
                  <input className="gl-input-v2" placeholder="Delivery, Quality, Learning…"
                    value={form.category}
                    onChange={e => setForm(f => ({ ...f, category: e.target.value }))} />
                </div>
                <div className="gl-field">
                  <label className="gl-label-v2">Review Period</label>
                  <input className="gl-input-v2" placeholder="Q1 2026"
                    value={form.review_period}
                    onChange={e => setForm(f => ({ ...f, review_period: e.target.value }))} />
                </div>
              </div>
              <div className="gl-form-row">
                <div className="gl-field">
                  <label className="gl-label-v2">Due Date</label>
                  <input type="date" className="gl-input-v2"
                    value={form.due_date}
                    onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))} />
                </div>
                <div className="gl-field">
                  <label className="gl-label-v2">Weightage (%)</label>
                  <input type="number" className="gl-input-v2" placeholder="100"
                    value={form.weightage}
                    onChange={e => setForm(f => ({ ...f, weightage: e.target.value }))} />
                </div>
              </div>
              <div className="gl-form-row">
                <div className="gl-field">
                  <label className="gl-label-v2">Priority</label>
                  <select className="gl-select-v2" value={form.priority}
                    onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}>
                    {['High', 'Medium', 'Low'].map(v => <option key={v}>{v}</option>)}
                  </select>
                </div>
                <div className="gl-field">
                  <label className="gl-label-v2">Status</label>
                  <select className="gl-select-v2" value={form.status}
                    onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                    {['active', 'draft', 'achieved', 'at_risk', 'overdue'].map(v => (
                      <option key={v} value={v}>{v.replace('_', ' ')}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
            <div className="gl-modal-ft-v2">
              <button className="gl-btn-cancel-v2" onClick={() => setShowForm(false)}>Cancel</button>
              <button type="submit" className="gl-btn-save-v2" onClick={handleSave}
                disabled={saving || !form.goal_title}>
                {saving ? 'Saving…' : editGoal ? 'Update Goal' : 'Create Goal'}
              </button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}