import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { Plus, Target, X, TrendingUp, CheckCircle, AlertTriangle, Clock, Zap, Edit2, Trash2 } from 'lucide-react';
import './Goals.css';
import ConfirmDialog from '@/components/core/ConfirmDialog';

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

function pct(g) {
  const t = Number(g.target_value || 1);
  const a = Number(g.achieved_value || g.progress_pct || 0);
  if (g.progress_pct) return Math.min(100, Math.round(Number(g.progress_pct)));
  return Math.min(100, Math.round((a / t) * 100));
}

function ringColor(p) {
  return p >= 100 ? '#10b981' : p >= 70 ? '#4338ca' : p >= 30 ? '#f59e0b' : '#ef4444';
}

function GoalCard({ goal, onCheckin, onEdit, onDelete }) {
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
      <div className="gl-card-actions">
        <button className="gl-btn-checkin" onClick={() => onCheckin(goal)}>
          <Zap size={11} /> Check In
        </button>
        <button className="gl-btn-edit-v2" onClick={() => onEdit(goal)}>
          <Edit2 size={11} /> Edit
        </button>
        <button className="gl-btn-del" onClick={() => onDelete(goal.id)}>
          <Trash2 size={13} />
        </button>
      </div>
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

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const load = useCallback(() => {
    setLoading(true);
    api.get('/performance/goals')
      .then(r => setGoals(Array.isArray(r.data) ? r.data : []))
      .catch(() => setGoals([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setEditGoal(null); setForm(EMPTY_FORM); setShowForm(true); };
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
    } catch { showToast('Failed to save goal', 'error'); }
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

  const counts = {
    all:      goals.length,
    active:   goals.filter(g => g.status === 'active').length,
    achieved: goals.filter(g => g.status === 'achieved').length,
    at_risk:  goals.filter(g => g.status === 'at_risk').length,
    overdue:  goals.filter(g => g.status === 'overdue').length,
    draft:    goals.filter(g => g.status === 'draft').length,
  };
  const filtered = tab === 'all' ? goals : goals.filter(g => g.status === tab);

  return (
    <div className="gl-root">
      {toast && <div className={`gl-toast gl-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="gl-header">
        <div className="gl-header-left">
          <div className="gl-header-icon"><Target size={20} /></div>
          <div>
            <h1 className="gl-title">Goals & KPIs</h1>
            <p className="gl-sub">{goals.length} goals tracked this period</p>
          </div>
        </div>
        <button className="gl-add-btn" onClick={openCreate}>
          <Plus size={15} /> Add Goal
        </button>
      </div>

      <div className="gl-body">
        {/* KPIs */}
        <div className="gl-kpis">
          {[
            { icon: <Target size={16} />,        val: counts.all,      label: 'Total Goals',  bg: '#eef2ff', color: '#4338ca' },
            { icon: <TrendingUp size={16} />,     val: counts.active,   label: 'On Track',     bg: '#dbeafe', color: '#1d4ed8' },
            { icon: <AlertTriangle size={16} />,  val: counts.at_risk,  label: 'At Risk',      bg: '#fef3c7', color: '#d97706' },
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
            <p>{goals.length === 0 ? 'No goals set yet' : `No ${tab} goals`}</p>
            {goals.length === 0 && (
              <button className="gl-btn-primary" onClick={openCreate} style={{ marginTop: 8 }}>
                <Plus size={14} /> Set First Goal
              </button>
            )}
          </div>
        ) : (
          <div className="gl-grid">
            {filtered.map(g => (
              <GoalCard
                key={g.id}
                goal={g}
                onCheckin={g => { setCheckin(g); setCiVal(String(g.achieved_value || g.current_value || '')); setCiNote(''); }}
                onEdit={openEdit}
                onDelete={setPendingHandleDelete}
              />
            ))}
          </div>
        )}
      </div>

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
    </div>
  );
}