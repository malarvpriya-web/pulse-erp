import { useState, useEffect, useCallback } from 'react';
import {
  Plus, Pencil, X, RefreshCw, ArrowLeft,
  CheckCircle2, Circle, AlertCircle, MinusCircle,
  User, Calendar, FileText, Target, Layers, Activity,
  Zap, Flag, Clock, ChevronDown, AlertTriangle,
  TrendingUp, BarChart2, FlaskConical
} from 'lucide-react';
import api from '@/services/api/client';
import './DesignPhases.css';
import { useToast } from '@/context/ToastContext';

const PHASE_STATUSES = ['pending', 'in_progress', 'completed', 'blocked', 'skipped'];

const STATUS_META = {
  pending:     { label: 'Pending',     color: '#9ca3af', bg: '#f9fafb', accent: '#e5e7eb', Icon: Circle },
  in_progress: { label: 'In Progress', color: '#3b82f6', bg: '#eff6ff', accent: '#93c5fd', Icon: Activity },
  completed:   { label: 'Completed',   color: '#10b981', bg: '#ecfdf5', accent: '#6ee7b7', Icon: CheckCircle2 },
  blocked:     { label: 'Blocked',     color: '#ef4444', bg: '#fef2f2', accent: '#fca5a5', Icon: AlertCircle },
  skipped:     { label: 'Skipped',     color: '#6b7280', bg: '#f3f4f6', accent: '#d1d5db', Icon: MinusCircle },
};

const PHASE_ORDER = ['Concept', 'Preliminary Design', 'Detailed Design', 'Design Review', 'Approved'];

const PHASE_ICON_MAP = {
  'Concept':            Zap,
  'Preliminary Design': Layers,
  'Detailed Design':    FileText,
  'Design Review':      Target,
  'Approved':           Flag,
};

function fmtDate(d) {
  if (!d) return null;
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

function getHealthStatus(phase) {
  if (phase.status === 'completed' || phase.status === 'skipped') return null;
  if (!phase.end_date) return null;
  const now = new Date();
  const end = new Date(phase.end_date);
  const diff = (end - now) / (1000 * 60 * 60 * 24);
  if (diff < 0) return { label: 'Overdue', color: '#ef4444', bg: '#fef2f2' };
  if (diff <= 3) return { label: 'Due Soon', color: '#f59e0b', bg: '#fffbeb' };
  return null;
}

/* ─── KPI Card ─────────────────────────────────────────────────── */
function KpiCard({ icon: Icon, label, value, color, sub }) {
  return (
    <div className="dpp-kpi" style={{ '--kc': color }}>
      <div className="dpp-kpi-icon"><Icon size={18} /></div>
      <div className="dpp-kpi-text">
        <span className="dpp-kpi-val">{value}</span>
        <span className="dpp-kpi-label">{label}</span>
        {sub && <span className="dpp-kpi-sub">{sub}</span>}
      </div>
    </div>
  );
}

/* ─── Visual Stepper ────────────────────────────────────────────── */
function PhaseTimeline({ phases }) {
  const canonical = PHASE_ORDER.map(name => {
    const match = phases.find(p => p.phase_name === name);
    return match || { phase_name: name, status: 'pending' };
  });

  return (
    <div className="dpp-timeline">
      {canonical.map((ph, i) => {
        const meta = STATUS_META[ph.status] || STATUS_META.pending;
        const Icon = PHASE_ICON_MAP[ph.phase_name] || Circle;
        const isLast = i === canonical.length - 1;
        return (
          <div key={ph.phase_name} className="dpp-tl-step">
            <div className="dpp-tl-node-wrap">
              <div className="dpp-tl-node" style={{ background: meta.bg, borderColor: meta.accent, color: meta.color }}>
                <Icon size={14} />
              </div>
              {!isLast && (
                <div className="dpp-tl-connector">
                  <div
                    className="dpp-tl-connector-fill"
                    style={{ background: meta.color, width: ph.status === 'completed' ? '100%' : '0%' }}
                  />
                </div>
              )}
            </div>
            <div className="dpp-tl-label">
              <span className="dpp-tl-name">{ph.phase_name}</span>
              <span className="dpp-tl-status" style={{ color: meta.color }}>{meta.label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Phase Card ────────────────────────────────────────────────── */
function PhaseCard({ phase, index, onEdit, isExpanded, onToggle }) {
  const meta   = STATUS_META[phase.status] || STATUS_META.pending;
  const health = getHealthStatus(phase);
  const Icon   = PHASE_ICON_MAP[phase.phase_name] || Circle;
  const { Icon: StatusIcon } = meta;

  return (
    <div className={`dpp-card dpp-card-${phase.status}`}>
      {/* Card Header */}
      <div className="dpp-card-head" onClick={onToggle} role="button" tabIndex={0}
        onKeyDown={e => e.key === 'Enter' && onToggle()}>
        <div className="dpp-card-index" style={{ background: meta.bg, color: meta.color, borderColor: meta.accent }}>
          <Icon size={13} />
        </div>

        <div className="dpp-card-main">
          <div className="dpp-card-row1">
            <span className="dpp-card-name">{phase.phase_name}</span>
            {health && (
              <span className="dpp-card-health" style={{ background: health.bg, color: health.color }}>
                <AlertTriangle size={10} /> {health.label}
              </span>
            )}
          </div>
          <div className="dpp-card-row2">
            {phase.assigned_to && (
              <span className="dpp-card-meta"><User size={10} /> {phase.assigned_to}</span>
            )}
            {phase.end_date && (
              <span className="dpp-card-meta"><Calendar size={10} /> Due {fmtDate(phase.end_date)}</span>
            )}
          </div>
        </div>

        <div className="dpp-card-aside">
          <span className="dpp-status-pill" style={{ background: meta.bg, color: meta.color, borderColor: meta.accent }}>
            <StatusIcon size={10} /> {meta.label}
          </span>
          <button
            className="dpp-edit-btn"
            title="Edit phase"
            onClick={e => { e.stopPropagation(); onEdit(phase); }}
          >
            <Pencil size={12} />
          </button>
          <ChevronDown
            size={15}
            className={`dpp-chevron${isExpanded ? ' dpp-chevron-open' : ''}`}
          />
        </div>
      </div>

      {/* Expanded Detail */}
      {isExpanded && (
        <div className="dpp-card-body">
          <div className="dpp-card-grid">
            {phase.description && (
              <div className="dpp-detail-block">
                <span className="dpp-detail-label">Description</span>
                <span className="dpp-detail-val">{phase.description}</span>
              </div>
            )}
            {phase.deliverables && (
              <div className="dpp-detail-block">
                <span className="dpp-detail-label">Deliverables</span>
                <span className="dpp-detail-val">{phase.deliverables}</span>
              </div>
            )}
            {phase.notes && (
              <div className="dpp-detail-block dpp-detail-full">
                <span className="dpp-detail-label">Notes</span>
                <span className="dpp-detail-val">{phase.notes}</span>
              </div>
            )}
          </div>
          <div className="dpp-card-dates">
            {phase.start_date     && <span className="dpp-date-chip"><Clock size={10} /> Start: {fmtDate(phase.start_date)}</span>}
            {phase.end_date       && <span className="dpp-date-chip"><Calendar size={10} /> Target: {fmtDate(phase.end_date)}</span>}
            {phase.completed_date && <span className="dpp-date-chip dpp-date-done"><CheckCircle2 size={10} /> Done: {fmtDate(phase.completed_date)}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Edit Drawer ───────────────────────────────────────────────── */
function EditDrawer({ phase, onSave, onClose, saving }) {
  const [form, setForm] = useState({
    phase_name:     phase.phase_name || '',
    status:         phase.status || 'pending',
    description:    phase.description || '',
    deliverables:   phase.deliverables || '',
    assigned_to:    phase.assigned_to || '',
    start_date:     phase.start_date     ? phase.start_date.slice(0, 10)     : '',
    end_date:       phase.end_date       ? phase.end_date.slice(0, 10)       : '',
    completed_date: phase.completed_date ? phase.completed_date.slice(0, 10) : '',
    notes:          phase.notes || '',
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const meta = STATUS_META[form.status] || STATUS_META.pending;

  return (
    <div className="dpp-drawer-overlay" onClick={onClose}>
      <div className="dpp-drawer" onClick={e => e.stopPropagation()}>
        {/* Drawer Header */}
        <div className="dpp-drawer-head" style={{ borderBottomColor: meta.accent }}>
          <div className="dpp-drawer-title-row">
            <div className="dpp-drawer-icon" style={{ background: meta.bg, color: meta.color }}>
              <Pencil size={14} />
            </div>
            <div>
              <h3 className="dpp-drawer-title">Edit Phase</h3>
              <p className="dpp-drawer-sub">{phase.phase_name}</p>
            </div>
          </div>
          <button className="dpp-drawer-close" onClick={onClose}><X size={16} /></button>
        </div>

        {/* Drawer Form */}
        <form className="dpp-drawer-form" onSubmit={e => { e.preventDefault(); onSave(form); }}>
          <div className="dpp-form-section">
            <label className="dpp-label">Phase Name
              <input className="dpp-input" value={form.phase_name} onChange={e => set('phase_name', e.target.value)} />
            </label>
          </div>

          <div className="dpp-form-section">
            <label className="dpp-label">Status
              <div className="dpp-status-select-wrap">
                <select
                  className="dpp-select dpp-status-select"
                  style={{ borderColor: meta.accent, color: meta.color, background: meta.bg }}
                  value={form.status}
                  onChange={e => set('status', e.target.value)}
                >
                  {PHASE_STATUSES.map(s => (
                    <option key={s} value={s}>{STATUS_META[s]?.label || s}</option>
                  ))}
                </select>
              </div>
            </label>
          </div>

          <div className="dpp-form-section">
            <label className="dpp-label">Description
              <textarea className="dpp-textarea" rows={3} value={form.description}
                onChange={e => set('description', e.target.value)}
                placeholder="What this phase covers…" />
            </label>
          </div>

          <div className="dpp-form-section">
            <label className="dpp-label">Deliverables
              <textarea className="dpp-textarea" rows={2} value={form.deliverables}
                onChange={e => set('deliverables', e.target.value)}
                placeholder="Expected outputs / artifacts…" />
            </label>
          </div>

          <div className="dpp-form-section">
            <label className="dpp-label">Assigned To
              <div className="dpp-input-icon-wrap">
                <User size={13} className="dpp-input-icon" />
                <input className="dpp-input dpp-input-pl" value={form.assigned_to}
                  onChange={e => set('assigned_to', e.target.value)}
                  placeholder="Engineer or team lead" />
              </div>
            </label>
          </div>

          <div className="dpp-form-row">
            <label className="dpp-label">Start Date
              <input className="dpp-input" type="date" value={form.start_date} onChange={e => set('start_date', e.target.value)} />
            </label>
            <label className="dpp-label">Target Date
              <input className="dpp-input" type="date" value={form.end_date} onChange={e => set('end_date', e.target.value)} />
            </label>
          </div>

          {form.status === 'completed' && (
            <div className="dpp-form-section">
              <label className="dpp-label">Completed Date
                <input className="dpp-input" type="date" value={form.completed_date}
                  onChange={e => set('completed_date', e.target.value)} />
              </label>
            </div>
          )}

          <div className="dpp-form-section">
            <label className="dpp-label">Notes
              <textarea className="dpp-textarea" rows={3} value={form.notes}
                onChange={e => set('notes', e.target.value)}
                placeholder="Any additional context…" />
            </label>
          </div>

          <div className="dpp-drawer-actions">
            <button type="button" className="dpp-btn-cancel" onClick={onClose}>Cancel</button>
            <button type="submit" className="dpp-btn-save" disabled={saving}>
              {saving ? <><span className="dpp-btn-spinner" /> Saving…</> : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─── Add Phase Row ─────────────────────────────────────────────── */
function AddPhaseRow({ projectId, onAdded, onCancel }) {
  const toast = useToast();
  const [name, setName]   = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.post(`/engineering/rd-projects/${projectId}/phases`, { phase_name: name, phase_order: 99 });
      onAdded();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Failed to add phase');
    } finally { setSaving(false); }
  };

  return (
    <div className="dpp-add-row">
      <Plus size={14} className="dpp-add-icon" />
      <input
        autoFocus
        className="dpp-add-input"
        placeholder="New phase name…"
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onCancel(); }}
      />
      <button className="dpp-btn-save" disabled={saving || !name.trim()} onClick={save}>
        {saving ? '…' : 'Add'}
      </button>
      <button className="dpp-btn-cancel" onClick={onCancel}>Cancel</button>
    </div>
  );
}

/* ─── Main Page ─────────────────────────────────────────────────── */
export default function DesignPhases({ pageParams, setPage }) {
  const toast      = useToast();
  const projectId   = pageParams?.projectId;
  const projectName = pageParams?.projectName || 'Project';

  const [phases,      setPhases]      = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState(null);
  const [editPhase,   setEditPhase]   = useState(null);
  const [saving,      setSaving]      = useState(false);
  const [addingPhase, setAddingPhase] = useState(false);
  const [expanded,    setExpanded]    = useState({});

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.get(`/engineering/rd-projects/${projectId}/phases`);
      setPhases(Array.isArray(r.data.data) ? r.data.data : []);
    } catch (e) {
      setError(e.response?.data?.message || e.message);
    } finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (form) => {
    setSaving(true);
    try {
      await api.put(`/engineering/phases/${editPhase.id}`, form);
      toast.success('Phase updated');
      setEditPhase(null);
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Save failed');
    } finally { setSaving(false); }
  };

  const sorted = [...phases].sort((a, b) => {
    const ai = PHASE_ORDER.indexOf(a.phase_name);
    const bi = PHASE_ORDER.indexOf(b.phase_name);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return  1;
    return (a.phase_order - b.phase_order) || a.id - b.id;
  });

  const completedCount  = phases.filter(p => p.status === 'completed').length;
  const inProgressCount = phases.filter(p => p.status === 'in_progress').length;
  const blockedCount    = phases.filter(p => p.status === 'blocked').length;
  const progressPct     = phases.length > 0 ? Math.round((completedCount / phases.length) * 100) : 0;

  if (!projectId) {
    return (
      <div className="dpp-page">
        <div className="dpp-empty-state">
          <div className="dpp-empty-icon"><Layers size={32} /></div>
          <h3>No project selected</h3>
          <p>Select a project from R&amp;D Projects to view its design phases.</p>
          <button className="dpp-btn-primary" onClick={() => setPage?.('RDProjects')}>
            Go to R&amp;D Projects
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="dpp-page">
      {/* ── Header ── */}
      <div className="dpp-header">
        <div className="dpp-header-left">
          {setPage && (
            <button className="dpp-back-btn" onClick={() => setPage('RDProjects')}>
              <ArrowLeft size={14} /> R&amp;D Projects
            </button>
          )}
          <div className="dpp-title-block">
            <h1 className="dpp-title">Design Phases</h1>
            <span className="dpp-project-tag">{projectName}</span>
          </div>
        </div>
        <div className="dpp-header-right">
          <button className="dpp-icon-btn" title="Refresh" onClick={load}><RefreshCw size={14} /></button>
          <button className="dpp-btn-primary" onClick={() => setAddingPhase(true)}>
            <Plus size={14} /> Add Phase
          </button>
        </div>
      </div>

      {/* ── KPI Strip ── */}
      <div className="dpp-kpi-strip">
        <KpiCard icon={BarChart2}    label="Total Phases"  value={phases.length}   color="#6366f1" />
        <KpiCard icon={CheckCircle2} label="Completed"     value={completedCount}  color="#10b981" />
        <KpiCard icon={Activity}     label="In Progress"   value={inProgressCount} color="#3b82f6" />
        <KpiCard icon={AlertCircle}  label="Blocked"       value={blockedCount}    color="#ef4444" />
      </div>

      {/* ── Progress Bar ── */}
      <div className="dpp-progress-card">
        <div className="dpp-progress-header">
          <div className="dpp-progress-title">
            <TrendingUp size={15} />
            <span>Overall Completion</span>
          </div>
          <div className="dpp-progress-pct">
            <span className="dpp-pct-num">{progressPct}</span>
            <span className="dpp-pct-sym">%</span>
          </div>
        </div>
        <div className="dpp-progress-track">
          <div className="dpp-progress-fill" style={{ width: `${progressPct}%` }}>
            <div className="dpp-progress-glow" />
          </div>
        </div>
        <div className="dpp-progress-legend">
          {PHASE_STATUSES.filter(s => s !== 'skipped').map(s => {
            const count = phases.filter(p => p.status === s).length;
            const m = STATUS_META[s];
            return count > 0 ? (
              <span key={s} className="dpp-legend-item" style={{ color: m.color }}>
                <span className="dpp-legend-dot" style={{ background: m.color }} />
                {m.label}: {count}
              </span>
            ) : null;
          })}
        </div>
      </div>

      {/* ── Visual Timeline ── */}
      {phases.length > 0 && <PhaseTimeline phases={phases} />}

      {/* ── Body ── */}
      {loading && (
        <div className="dpp-loading">
          <div className="dpp-spinner" />
          <span>Loading phases…</span>
        </div>
      )}

      {!loading && error && (
        <div className="dpp-error">
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {!loading && !error && (
        <div className="dpp-phases-list">
          <div className="dpp-list-header">
            <span className="dpp-list-title">Phase Breakdown</span>
            <span className="dpp-list-count">{sorted.length} phases</span>
          </div>

          {sorted.map((ph, idx) => (
            <PhaseCard
              key={ph.id}
              phase={ph}
              index={idx}
              onEdit={p => setEditPhase(p)}
              isExpanded={!!expanded[ph.id]}
              onToggle={() => setExpanded(e => ({ ...e, [ph.id]: !e[ph.id] }))}
            />
          ))}

          {addingPhase && (
            <AddPhaseRow
              projectId={projectId}
              onAdded={() => { setAddingPhase(false); load(); }}
              onCancel={() => setAddingPhase(false)}
            />
          )}

          {phases.length === 0 && !addingPhase && (
            <div className="dpp-empty-state">
              <div className="dpp-empty-icon"><Layers size={28} /></div>
              <h3>No phases yet</h3>
              <p>New projects auto-seed 5 default phases. You can also add them manually.</p>
              <button className="dpp-btn-primary" onClick={() => setAddingPhase(true)}>
                <Plus size={14} /> Add Phase
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Navigation Footer ── */}
      {setPage && phases.length > 0 && (
        <div className="dpp-footer-nav">
          <button className="dpp-nav-card" onClick={() => setPage('PrototypeTracker', { projectId, projectName })}>
            <div className="dpp-nav-card-icon" style={{ background: '#fff7ed', color: '#f59e0b' }}>
              <FlaskConical size={16} />
            </div>
            <div>
              <span className="dpp-nav-card-label">Prototype Tracker</span>
              <span className="dpp-nav-card-sub">Track builds &amp; test results</span>
            </div>
          </button>
          <button className="dpp-nav-card" onClick={() => setPage('TestPlans', { projectId, projectName })}>
            <div className="dpp-nav-card-icon" style={{ background: '#f5f3ff', color: '#8b5cf6' }}>
              <BarChart2 size={16} />
            </div>
            <div>
              <span className="dpp-nav-card-label">Test Plans</span>
              <span className="dpp-nav-card-sub">Functional &amp; safety testing</span>
            </div>
          </button>
        </div>
      )}

      {/* ── Edit Drawer ── */}
      {editPhase && (
        <EditDrawer
          phase={editPhase}
          onSave={handleSave}
          onClose={() => setEditPhase(null)}
          saving={saving}
        />
      )}
    </div>
  );
}
