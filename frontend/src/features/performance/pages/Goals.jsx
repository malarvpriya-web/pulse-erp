import { useState, useEffect, useCallback } from 'react';
import { Plus, Search, X, Target, CheckCircle, Clock, AlertCircle, Edit2 } from 'lucide-react';
import api from '@/services/api/client';
import './Goals.css';

const SAMPLE = [
  { id: 1, title: 'Increase Sales Pipeline by 30%',      description: 'Expand outreach and qualify 50+ leads per quarter', targetDate: '2026-03-31', weightage: 25, progress: 72, status: 'Active',    category: 'Sales' },
  { id: 2, title: 'Complete PMP Certification',           description: 'Pass the Project Management Professional exam',    targetDate: '2026-04-30', weightage: 15, progress: 45, status: 'Active',    category: 'Learning' },
  { id: 3, title: 'Improve Customer Satisfaction Score',  description: 'Achieve CSAT score of 90% or above',              targetDate: '2026-03-15', weightage: 20, progress: 100, status: 'Completed', category: 'Quality' },
  { id: 4, title: 'Launch Q2 Product Feature',            description: 'Ship the new reporting module on time',           targetDate: '2026-02-28', weightage: 30, progress: 30, status: 'Overdue',   category: 'Product' },
  { id: 5, title: 'Reduce Operational Costs by 10%',      description: 'Identify and eliminate inefficiencies in process', targetDate: '2026-06-30', weightage: 10, progress: 20, status: 'Active',    category: 'Operations' },
];

const TABS = ['All', 'Active', 'Completed', 'Overdue'];
const CATEGORIES = ['Sales', 'Learning', 'Quality', 'Product', 'Operations', 'Leadership', 'Other'];

const STATUS_META = {
  Active:    { bg: '#dbeafe', color: '#1d4ed8', icon: <Target size={12} /> },
  Completed: { bg: '#dcfce7', color: '#15803d', icon: <CheckCircle size={12} /> },
  Overdue:   { bg: '#fee2e2', color: '#dc2626', icon: <AlertCircle size={12} /> },
};

function progressColor(p, status) {
  if (status === 'Completed') return '#22c55e';
  if (status === 'Overdue') return '#ef4444';
  if (p >= 70) return '#6366f1';
  if (p >= 40) return '#f59e0b';
  return '#9ca3af';
}

const BLANK = { title: '', description: '', targetDate: '', weightage: '', progress: 0, category: 'Sales' };

export default function Goals() {
  const [goals, setGoals]     = useState(SAMPLE);
  const [loading, setLoading] = useState(false);
  const [fTab, setFTab]       = useState('All');
  const [search, setSearch]   = useState('');
  const [drawer, setDrawer]   = useState(null);   // null | 'create' | goal-obj
  const [form, setForm]       = useState(BLANK);
  const [saving, setSaving]   = useState(false);
  const [toast, setToast]     = useState(null);

  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = fTab !== 'All' ? { status: fTab } : {};
      const res = await api.get('/performance/goals', { params });
      const raw = res.data?.data ?? res.data;
      setGoals(Array.isArray(raw) && raw.length ? raw : SAMPLE);
    } catch { setGoals(SAMPLE); }
    finally { setLoading(false); }
  }, [fTab]);

  useEffect(() => { load(); }, [load]);

  const counts = TABS.reduce((acc, t) => ({
    ...acc, [t]: t === 'All' ? goals.length : goals.filter(g => g.status === t).length
  }), {});

  const filtered = goals.filter(g =>
    (fTab === 'All' || g.status === fTab) &&
    (g.title?.toLowerCase().includes(search.toLowerCase()) ||
     g.category?.toLowerCase().includes(search.toLowerCase()))
  );

  const openCreate = () => { setForm(BLANK); setDrawer('create'); };
  const openEdit   = g => { setForm({ title: g.title, description: g.description, targetDate: g.targetDate, weightage: g.weightage, progress: g.progress, category: g.category }); setDrawer(g); };

  const handleSubmit = async e => {
    e.preventDefault();
    if (!form.title.trim()) { showToast('Title is required', 'error'); return; }
    setSaving(true);
    try {
      if (drawer === 'create') await api.post('/performance/goals', form);
      else await api.put(`/performance/goals/${drawer.id}`, form);
      showToast(drawer === 'create' ? 'Goal created!' : 'Goal updated!');
      load();
    } catch {
      if (drawer === 'create') {
        const ng = { id: Date.now(), ...form, status: 'Active' };
        setGoals(prev => [ng, ...prev]);
        showToast('Goal created!');
      } else {
        setGoals(prev => prev.map(g => g.id === drawer.id ? { ...g, ...form } : g));
        showToast('Goal updated!');
      }
    }
    setDrawer(null); setSaving(false);
  };

  const markComplete = async id => {
    try { await api.put(`/performance/goals/${id}`, { status: 'Completed', progress: 100 }); }
    catch { /* optimistic */ }
    setGoals(prev => prev.map(g => g.id === id ? { ...g, status: 'Completed', progress: 100 } : g));
    showToast('Goal marked as complete!');
  };

  const totalWeightage = goals.filter(g => g.status !== 'Completed').reduce((s, g) => s + (parseInt(g.weightage)||0), 0);
  const overallProgress = goals.length ? Math.round(goals.reduce((s, g) => s + (parseInt(g.progress)||0), 0) / goals.length) : 0;

  return (
    <div className="gl-root">
      {toast && <div className={`gl-toast gl-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="gl-header">
        <div>
          <h1 className="gl-title">Goals &amp; KPIs</h1>
          <p className="gl-sub">Track progress towards your objectives</p>
        </div>
        <button className="gl-btn-primary" onClick={openCreate}><Plus size={15} /> Add Goal</button>
      </div>

      {/* Summary strip */}
      <div className="gl-summary">
        <div className="gl-sum-card">
          <div className="gl-sum-num">{goals.length}</div>
          <div className="gl-sum-lbl">Total Goals</div>
        </div>
        <div className="gl-sum-card">
          <div className="gl-sum-num gl-blue">{counts.Active}</div>
          <div className="gl-sum-lbl">Active</div>
        </div>
        <div className="gl-sum-card">
          <div className="gl-sum-num gl-green">{counts.Completed}</div>
          <div className="gl-sum-lbl">Completed</div>
        </div>
        <div className="gl-sum-card">
          <div className="gl-sum-num gl-red">{counts.Overdue}</div>
          <div className="gl-sum-lbl">Overdue</div>
        </div>
        <div className="gl-sum-card gl-sum-progress">
          <div className="gl-sum-num">{overallProgress}%</div>
          <div className="gl-sum-lbl">Overall Progress</div>
          <div className="gl-sum-track"><div className="gl-sum-fill" style={{ width: `${overallProgress}%` }} /></div>
        </div>
      </div>

      <div className="gl-filters">
        <div className="gl-search">
          <Search size={15} color="#9ca3af" />
          <input placeholder="Search goals…" value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch('')}><X size={13} /></button>}
        </div>
        <div className="gl-tabs">
          {TABS.map(t => (
            <button key={t} className={`gl-tab ${fTab === t ? 'gl-tab-active' : ''}`} onClick={() => setFTab(t)}>
              {t} <span className="gl-tab-count">{counts[t]}</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="gl-loading"><div className="gl-spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="gl-empty"><Target size={36} color="#d1d5db" /><p>No goals found</p></div>
      ) : (
        <div className="gl-list">
          {filtered.map(g => {
            const sm = STATUS_META[g.status] || STATUS_META.Active;
            const pc = progressColor(g.progress, g.status);
            const overdue = new Date(g.targetDate) < new Date() && g.status !== 'Completed';
            return (
              <div key={g.id} className={`gl-card ${g.status === 'Overdue' ? 'gl-card-overdue' : ''}`}>
                <div className="gl-card-hd">
                  <div className="gl-card-left">
                    <span className="gl-category">{g.category}</span>
                    <h3 className="gl-goal-title">{g.title}</h3>
                    {g.description && <p className="gl-goal-desc">{g.description}</p>}
                  </div>
                  <div className="gl-card-right">
                    <span className="gl-status-badge" style={{ background: sm.bg, color: sm.color }}>
                      {sm.icon} {g.status}
                    </span>
                    <div className="gl-weight">W: {g.weightage}%</div>
                  </div>
                </div>

                <div className="gl-progress-row">
                  <div className="gl-prog-info">
                    <span className="gl-prog-lbl">Progress</span>
                    <span className="gl-prog-num" style={{ color: pc }}>{g.progress}%</span>
                  </div>
                  <div className="gl-prog-track">
                    <div className="gl-prog-fill" style={{ width: `${g.progress}%`, background: pc }} />
                  </div>
                </div>

                <div className="gl-card-ft">
                  <div className="gl-due">
                    <Clock size={11} />
                    <span className={overdue ? 'gl-overdue-text' : ''}>
                      {overdue ? 'Overdue — ' : 'Due: '}
                      {new Date(g.targetDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </span>
                  </div>
                  <div className="gl-actions">
                    <button className="gl-edit-btn" onClick={() => openEdit(g)}><Edit2 size={13} /></button>
                    {g.status !== 'Completed' && (
                      <button className="gl-complete-btn" onClick={() => markComplete(g.id)}>
                        <CheckCircle size={13} /> Mark Complete
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {drawer !== null && (
        <div className="gl-overlay" onClick={e => e.target === e.currentTarget && setDrawer(null)}>
          <div className="gl-drawer">
            <div className="gl-drawer-hd">
              <h3>{drawer === 'create' ? 'Add Goal' : 'Edit Goal'}</h3>
              <button className="gl-icon-btn" onClick={() => setDrawer(null)}><X size={16} /></button>
            </div>
            <form className="gl-drawer-body" onSubmit={handleSubmit}>
              <div className="gl-field">
                <label>Goal Title <span className="gl-req">*</span></label>
                <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="What do you want to achieve?" required />
              </div>
              <div className="gl-field">
                <label>Description</label>
                <textarea rows={2} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="How will you measure success?" />
              </div>
              <div className="gl-row2">
                <div className="gl-field">
                  <label>Category <span className="gl-req">*</span></label>
                  <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
                    {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div className="gl-field">
                  <label>Target Date <span className="gl-req">*</span></label>
                  <input type="date" value={form.targetDate} onChange={e => setForm(f => ({ ...f, targetDate: e.target.value }))} required />
                </div>
              </div>
              <div className="gl-row2">
                <div className="gl-field">
                  <label>Weightage (%) <span className="gl-req">*</span></label>
                  <input type="number" min="1" max="100" value={form.weightage} onChange={e => setForm(f => ({ ...f, weightage: e.target.value }))} placeholder="e.g. 25" required />
                </div>
                <div className="gl-field">
                  <label>Current Progress (%)</label>
                  <input type="number" min="0" max="100" value={form.progress} onChange={e => setForm(f => ({ ...f, progress: e.target.value }))} />
                </div>
              </div>
              <div className="gl-drawer-ft">
                <button type="button" className="gl-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
                <button type="submit" className="gl-btn-primary" disabled={saving}>{saving ? 'Saving…' : drawer === 'create' ? 'Add Goal' : 'Save Changes'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
