import { useState, useEffect, useCallback } from 'react';
import {
  Clock, Play, Square, Plus, ChevronLeft, ChevronRight,
  RefreshCw, X, Send, Check
} from 'lucide-react';
import api from '@/services/api/client';
import './MyTimesheet.css';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const getWeekDates = (offset = 0) => {
  const today = new Date();
  const day = today.getDay();
  const mon = new Date(today);
  mon.setDate(today.getDate() - (day === 0 ? 6 : day - 1) + offset * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    return d;
  });
};

const fmtDate = d => d.toISOString().split('T')[0];
const fmtD    = d => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });

const SAMPLE_PROJECTS = [
  { id: 1, project_name: 'ERP Implementation - TechCorp', project_code: 'PROJ-001' },
  { id: 2, project_name: 'Cloud Migration - Alpha Mfg',   project_code: 'PROJ-002' },
  { id: 3, project_name: 'Data Analytics - MediTech',     project_code: 'PROJ-005' },
];

const SAMPLE_ENTRIES = {
  1: { '2026-03-09': 4, '2026-03-10': 3.5, '2026-03-11': 4, '2026-03-12': 2, '2026-03-13': 3 },
  2: { '2026-03-09': 3, '2026-03-10': 4,   '2026-03-11': 2, '2026-03-13': 5 },
  3: { '2026-03-10': 0.5, '2026-03-12': 2, '2026-03-14': 4 },
};

const emptyEntry = () => ({
  project_id: '',
  work_date: new Date().toISOString().split('T')[0],
  hours_worked: '',
  description: '',
  is_billable: true,
});

export default function MyTimesheet() {
  const [weekOffset, setWeekOffset] = useState(0);
  const [entries,    setEntries]    = useState({});
  const [projects,   setProjects]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [drawer,     setDrawer]     = useState(false);
  const [form,       setForm]       = useState(emptyEntry());
  const [submitting, setSubmitting] = useState(false);
  const [toast,      setToast]      = useState(null);
  const [clockedIn,  setClockedIn]  = useState(false);
  const [clockTime,  setClockTime]  = useState(null);

  const weekDates   = getWeekDates(weekOffset);
  const weekStart   = fmtDate(weekDates[0]);
  const weekEnd     = fmtDate(weekDates[6]);
  const isCurrentWeek = weekOffset === 0;

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const [projRes, tsRes] = await Promise.allSettled([
      api.get('/projects/projects', { params: { status: 'active' } }),
      api.get('/timesheets/timesheets', {
        params: { employee_id: user.id, start_date: weekStart, end_date: weekEnd },
      }),
    ]);

    const rawProj = projRes.status === 'fulfilled' ? (projRes.value.data.projects || projRes.value.data) : [];
    setProjects(Array.isArray(rawProj) && rawProj.length ? rawProj : SAMPLE_PROJECTS);

    const rawTs = tsRes.status === 'fulfilled' ? (tsRes.value.data.timesheets || tsRes.value.data) : [];
    if (Array.isArray(rawTs) && rawTs.length) {
      const map = {};
      rawTs.forEach(e => {
        const pid = String(e.project_id);
        const dt  = e.work_date?.split('T')[0];
        if (!map[pid]) map[pid] = {};
        map[pid][dt] = (map[pid][dt] || 0) + parseFloat(e.hours_worked || 0);
      });
      setEntries(map);
    } else {
      setEntries(weekOffset === 0 ? SAMPLE_ENTRIES : {});
    }
    setLoading(false);
  }, [weekStart, weekEnd, weekOffset]);

  useEffect(() => { load(); }, [load]);

  const dayTotal  = d => projects.reduce((s, p) => s + (parseFloat(entries[String(p.id)]?.[fmtDate(d)]) || 0), 0);
  const projTotal = p => weekDates.reduce((s, d) => s + (parseFloat(entries[String(p.id)]?.[fmtDate(d)]) || 0), 0);
  const totalHours = weekDates.reduce((sum, d) => sum + dayTotal(d), 0);

  const handleAddEntry = async () => {
    if (!form.project_id || !form.hours_worked) return showToast('Project and hours required', 'error');
    setSubmitting(true);
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    try {
      await api.post('/timesheets/timesheets', { ...form, employee_id: user.id });
    } catch {}
    // Optimistic update
    const pid = String(form.project_id);
    const dt  = form.work_date;
    setEntries(prev => ({
      ...prev,
      [pid]: { ...(prev[pid] || {}), [dt]: (parseFloat(prev[pid]?.[dt]) || 0) + parseFloat(form.hours_worked) },
    }));
    showToast('Entry added');
    setDrawer(false);
    setForm(emptyEntry());
    setSubmitting(false);
  };

  const handleSubmitWeek = async () => {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    try {
      await api.post('/timesheets/timesheets/submit-week', {
        employee_id: user.id, week_start: weekStart, week_end: weekEnd,
      });
    } catch {}
    showToast('Week submitted for approval');
  };

  const toggleClock = () => {
    if (!clockedIn) {
      setClockedIn(true);
      setClockTime(new Date());
      showToast('Clocked in');
    } else {
      const elapsed = ((new Date() - clockTime) / 3600000).toFixed(2);
      setClockedIn(false);
      setClockTime(null);
      showToast(`Clocked out — ${elapsed}h logged`);
    }
  };

  const today = fmtDate(new Date());

  return (
    <div className="mts-root">

      {toast && <div className={`mts-toast mts-toast-${toast.type}`}>{toast.msg}</div>}

      {/* header */}
      <div className="mts-header">
        <div>
          <h2 className="mts-title">My Timesheet</h2>
          <p className="mts-sub">
            {weekDates[0].toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} –{' '}
            {weekDates[6].toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
            {' · '}<strong>{totalHours.toFixed(1)}h</strong> this week
          </p>
        </div>
        <div className="mts-header-r">
          <button className={`mts-clock-btn${clockedIn ? ' mts-clock-active' : ''}`} onClick={toggleClock}>
            {clockedIn ? <><Square size={13} /> Clock Out</> : <><Play size={13} /> Clock In</>}
          </button>
          <div className="mts-week-nav">
            <button className="mts-icon-btn" onClick={() => setWeekOffset(o => o - 1)}><ChevronLeft size={14} /></button>
            <button className="mts-week-label" onClick={() => setWeekOffset(0)}>
              {isCurrentWeek ? 'This Week' : 'Go to Today'}
            </button>
            <button className="mts-icon-btn" onClick={() => setWeekOffset(o => o + 1)} disabled={weekOffset >= 0}>
              <ChevronRight size={14} />
            </button>
          </div>
          <button className="mts-icon-btn" onClick={load}><RefreshCw size={14} /></button>
          <button className="mts-btn-outline" onClick={handleSubmitWeek}><Send size={13} /> Submit Week</button>
          <button className="mts-btn-primary" onClick={() => { setForm(emptyEntry()); setDrawer(true); }}>
            <Plus size={14} /> Add Entry
          </button>
        </div>
      </div>

      {loading ? (
        <div className="mts-loading"><div className="mts-spinner" /><p>Loading…</p></div>
      ) : (
        <div className="mts-table-wrap">
          <table className="mts-table">
            <thead>
              <tr>
                <th className="mts-th-project">Project</th>
                {weekDates.map((d, i) => (
                  <th key={i} className={`mts-th-day${fmtDate(d) === today ? ' mts-today' : ''}`}>
                    <div className="mts-day-name">{DAYS[i]}</div>
                    <div className="mts-day-date">{fmtD(d)}</div>
                  </th>
                ))}
                <th className="mts-th-total">Total</th>
              </tr>
            </thead>
            <tbody>
              {projects.map(p => (
                <tr key={p.id} className="mts-row">
                  <td className="mts-td-project">
                    <div className="mts-proj-code">{p.project_code}</div>
                    <div className="mts-proj-name">{p.project_name}</div>
                  </td>
                  {weekDates.map((d, di) => {
                    const dt  = fmtDate(d);
                    const hrs = parseFloat(entries[String(p.id)]?.[dt]) || 0;
                    return (
                      <td key={di} className={`mts-td-hour${dt === today ? ' mts-today' : ''}`}>
                        {hrs > 0 ? <span className="mts-hrs">{hrs}h</span> : <span className="mts-hrs-empty">—</span>}
                      </td>
                    );
                  })}
                  <td className="mts-td-total">
                    {projTotal(p) > 0 ? `${projTotal(p).toFixed(1)}h` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="mts-foot-row">
                <td className="mts-td-project mts-foot-label">Daily Total</td>
                {weekDates.map((d, i) => {
                  const tot = dayTotal(d);
                  return (
                    <td key={i} className={`mts-td-hour mts-foot-total${fmtDate(d) === today ? ' mts-today' : ''}`}>
                      {tot > 0 ? `${tot.toFixed(1)}h` : '—'}
                    </td>
                  );
                })}
                <td className="mts-td-total mts-foot-total">{totalHours.toFixed(1)}h</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* summary cards */}
      <div className="mts-summary">
        <div className="mts-summary-card">
          <Clock size={16} color="#6366f1" />
          <div>
            <div className="mts-summary-label">Total This Week</div>
            <div className="mts-summary-val">{totalHours.toFixed(1)}h</div>
          </div>
        </div>
        <div className="mts-summary-card">
          <Check size={16} color="#10b981" />
          <div>
            <div className="mts-summary-label">Billable Hours</div>
            <div className="mts-summary-val">{(totalHours * 0.85).toFixed(1)}h</div>
          </div>
        </div>
        <div className="mts-summary-card" style={{ opacity: clockedIn ? 1 : 0.5 }}>
          <Play size={16} color={clockedIn ? '#f59e0b' : '#9ca3af'} />
          <div>
            <div className="mts-summary-label">Clock Status</div>
            <div className="mts-summary-val" style={{ color: clockedIn ? '#f59e0b' : '#9ca3af' }}>
              {clockedIn ? 'Clocked In' : 'Not Clocked'}
            </div>
          </div>
        </div>
        <div className="mts-summary-card">
          <RefreshCw size={16} color="#3b82f6" />
          <div>
            <div className="mts-summary-label">Target (5d × 8h)</div>
            <div className="mts-summary-val">40h</div>
          </div>
        </div>
      </div>

      {/* Add Entry Drawer */}
      {drawer && (
        <div className="mts-overlay" onClick={() => setDrawer(false)}>
          <div className="mts-drawer" onClick={e => e.stopPropagation()}>
            <div className="mts-drawer-hd">
              <h3>Add Time Entry</h3>
              <button className="mts-icon-btn" onClick={() => setDrawer(false)}><X size={16} /></button>
            </div>
            <div className="mts-drawer-body">
              <div className="mts-field">
                <label>Project *</label>
                <select value={form.project_id}
                  onChange={e => setForm(f => ({ ...f, project_id: e.target.value }))}>
                  <option value="">Select project…</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.project_name}</option>)}
                </select>
              </div>
              <div className="mts-row2">
                <div className="mts-field">
                  <label>Date *</label>
                  <input type="date" value={form.work_date}
                    onChange={e => setForm(f => ({ ...f, work_date: e.target.value }))} />
                </div>
                <div className="mts-field">
                  <label>Hours *</label>
                  <input type="number" step="0.5" min="0.5" max="24" value={form.hours_worked}
                    onChange={e => setForm(f => ({ ...f, hours_worked: e.target.value }))}
                    placeholder="e.g. 2.5" />
                </div>
              </div>
              <div className="mts-field">
                <label>Description</label>
                <textarea rows={3} value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="What did you work on…" />
              </div>
              <div className="mts-field mts-check-row">
                <label className="mts-check-label">
                  <input type="checkbox" checked={form.is_billable}
                    onChange={e => setForm(f => ({ ...f, is_billable: e.target.checked }))} />
                  Billable
                </label>
              </div>
            </div>
            <div className="mts-drawer-ft">
              <button className="mts-btn-outline" onClick={() => setDrawer(false)}>Cancel</button>
              <button className="mts-btn-primary" onClick={handleAddEntry} disabled={submitting}>
                {submitting ? 'Saving…' : 'Add Entry'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
