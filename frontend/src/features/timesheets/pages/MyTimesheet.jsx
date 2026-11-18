/**
 * My Timesheet — pre-filled from attendance, submitted in one step (2026-11-11).
 *
 * Each day's hours come from attendance (punch, else a standard day; leave,
 * holidays and weekends are 0) and are split across the employee's projects
 * by allocation. The employee checks the figures, changes any they need to,
 * and submits the week. A week nobody submits is submitted automatically the
 * following Monday. See backend autoTimesheet.service.js.
 *
 * The old project × day grid with its own Clock In / Clock Out and "Add
 * Entry" drawer is gone: attendance is the clock.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, Send, Save, CalendarClock, Clock, Info } from 'lucide-react';
import api from '@/services/api/client';
import './MyTimesheet.css';
import { PageHero, PageShell } from '@/components/pulse-ui';

const SOURCE_LABEL = {
  punch: 'Punched',
  standard: 'Standard day',
  leave: 'On leave',
  half_leave: 'Half-day leave',
  holiday: 'Holiday',
  weekend: 'Weekend',
  absent: 'Absent',
  future: 'Not yet',
};

const STATUS_BANNER = {
  not_started: { tone: 'info',    text: 'Pre-filled from your attendance. Check the hours and submit the week.' },
  draft:       { tone: 'info',    text: 'Saved as a draft. Submit the week when it is right.' },
  submitted:   { tone: 'warn',    text: 'Submitted — waiting for your manager to approve.' },
  approved:    { tone: 'success', text: 'Approved.' },
  part_approved: { tone: 'success', text: 'Partly approved.' },
  rejected:    { tone: 'danger',  text: 'Sent back by your manager. Correct it and submit again.' },
};
const TONE = {
  info:    { bg: 'var(--color-info-bg, #eff6ff)',    fg: 'var(--color-info, #1d4ed8)' },
  warn:    { bg: 'var(--color-warning-bg, #fffbeb)', fg: 'var(--color-warning, #b45309)' },
  success: { bg: 'var(--color-success-bg, #ecfdf5)', fg: 'var(--color-success, #047857)' },
  danger:  { bg: 'var(--color-danger-bg, #fef2f2)',  fg: 'var(--color-danger, #b91c1c)' },
};

const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const fmtDay = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' });
};
const fmtHrs = (h) => (h > 0 ? `${Number.isInteger(h) ? h : h.toFixed(2).replace(/0$/, '')}h` : '—');
const EDITABLE = new Set(['not_started', 'draft', 'rejected']);

/** hours[date][projectId] from saved entries, else from the attendance split. */
function initialHours(week) {
  const out = {};
  for (const d of week.days) out[d.date] = {};
  // Hours saved on a day that has not happened yet are dropped: the box is
  // locked ("Not yet") and the server refuses future hours, so keeping them
  // would leave a week that can never be resubmitted.
  const future = new Set(week.days.filter(d => d.source === 'future').map(d => d.date));
  if (week.entries.length) {
    for (const e of week.entries) {
      if (!e.project_id || !out[e.work_date] || future.has(e.work_date)) continue;
      out[e.work_date][e.project_id] = (out[e.work_date][e.project_id] || 0) + Number(e.hours_worked || 0);
    }
  } else {
    for (const d of week.days) for (const [pid, h] of Object.entries(d.split || {})) out[d.date][pid] = h;
  }
  return out;
}

export default function MyTimesheet() {
  const [anchor, setAnchor] = useState(null);           // a date inside the week shown; null = this week
  const [thisWeek, setThisWeek] = useState(null);
  const [week, setWeek] = useState(null);
  const [hours, setHours] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [error, setError] = useState(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => { if (alive.current) setToast(null); }, 3500);
  };

  const apply = useCallback((w) => {
    setWeek(w);
    setHours(initialHours(w));
    setThisWeek(cur => cur || w.week_start);
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await api.get('/timesheets/timesheets/my-week', { params: anchor ? { week_start: anchor } : {} });
      if (alive.current) apply(r.data);
    } catch (e) {
      if (alive.current) { setWeek(null); setError(e.response?.data?.error || 'Could not load your timesheet'); }
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [anchor, apply]);
  useEffect(() => { load(); }, [load]);

  const projects = useMemo(() => week?.projects || [], [week]);
  const editable = !!week && EDITABLE.has(week.status);
  const dayTotal = (date) => Object.values(hours[date] || {}).reduce((s, h) => s + (Number(h) || 0), 0);
  const projTotal = (pid) => Object.values(hours).reduce((s, d) => s + (Number(d[pid]) || 0), 0);
  const weekTotal = week ? week.days.reduce((s, d) => s + dayTotal(d.date), 0) : 0;
  const attendanceTotal = week ? week.days.reduce((s, d) => s + (d.hours || 0), 0) : 0;

  const setCell = (date, pid, value) => {
    const n = value === '' ? 0 : Math.max(0, Math.min(24, Number(value)));
    setHours(h => ({ ...h, [date]: { ...(h[date] || {}), [pid]: Number.isFinite(n) ? n : 0 } }));
  };

  const save = async (submit) => {
    if (!week) return;
    const rows = [];
    for (const d of week.days) for (const [pid, h] of Object.entries(hours[d.date] || {})) {
      if (Number(h) > 0) rows.push({ work_date: d.date, project_id: Number(pid), hours: Number(h) });
    }
    setSaving(true);
    try {
      const r = await api.put('/timesheets/timesheets/my-week', { week_start: week.week_start, rows, submit });
      apply(r.data);
      showToast(submit ? 'Week submitted for approval' : 'Draft saved');
    } catch (e) {
      showToast(e.response?.data?.error || 'Could not save the week', 'error');
    } finally {
      setSaving(false);
    }
  };

  const banner = week ? STATUS_BANNER[week.status] || STATUS_BANNER.draft : null;
  const tone = banner ? TONE[banner.tone] : null;

  return (
    <PageShell dock={
      <PageHero
        icon={CalendarClock}
        eyebrow="Timesheets"
        title="My Timesheet"
        subtitle={week ? `Week of ${fmtDay(week.week_start)} – ${fmtDay(week.week_end)}` : undefined}
        actions={<>
          <span className="plh-group">
            <button className="plh-cta plh-cta--icon" title="Previous week" disabled={!week}
              onClick={() => setAnchor(addDays(week.week_start, -7))}><ChevronLeft size={14} /></button>
            <button className="plh-cta" onClick={() => setAnchor(null)}>
              {week && week.week_start === thisWeek ? 'This Week' : 'Go to This Week'}
            </button>
            <button className="plh-cta plh-cta--icon" title="Next week"
              disabled={!week || !thisWeek || week.week_start >= thisWeek}
              onClick={() => setAnchor(addDays(week.week_start, 7))}><ChevronRight size={14} /></button>
          </span>
          <button className="plh-cta plh-cta--ghost plh-cta--icon" onClick={load} title="Refresh"><RefreshCw size={14} /></button>
          {editable && projects.length > 0 && <>
            <button className="plh-cta plh-cta--ghost" onClick={() => save(false)} disabled={saving}><Save size={13} /> Save draft</button>
            <button className="plh-cta" onClick={() => save(true)} disabled={saving || weekTotal <= 0}>
              <Send size={13} /> {saving ? 'Submitting…' : 'Submit week'}
            </button>
          </>}
        </>}
      />
    }>
      {toast && <div className={`mts-toast mts-toast-${toast.type}`}>{toast.msg}</div>}

      {loading ? (
        <div className="mts-loading"><div className="mts-spinner" /><p>Loading…</p></div>
      ) : error ? (
        <div className="mts-empty" role="alert">{error}</div>
      ) : projects.length === 0 ? (
        <div className="mts-empty">
          <Clock size={32} style={{ opacity: 0.4 }} />
          <p style={{ margin: '8px 0 0', fontWeight: 600 }}>You are not on a project this week.</p>
          <p style={{ margin: '4px 0 0' }}>Your timesheet starts filling itself once a project manager adds you to a project team.</p>
        </div>
      ) : (<>
        <div className="mts-banner" style={{ background: tone.bg, color: tone.fg }}>
          <Info size={14} />
          <span>
            {banner.text}
            {week.status === 'rejected' && week.rejection_reason ? ` Reason: ${week.rejection_reason}` : ''}
            {EDITABLE.has(week.status) && week.status !== 'rejected' ? ` If you don't, it is submitted automatically on ${fmtDay(week.auto_submit_on)}.` : ''}
          </span>
        </div>

        <div className="mts-table-wrap">
          <table className="mts-table">
            <thead>
              <tr>
                <th className="mts-th-project">Day</th>
                <th className="mts-th-day">Attendance</th>
                {projects.map(p => (
                  <th key={p.id} className="mts-th-day" title={p.project_name}>
                    <div className="mts-day-name">{p.project_code || 'Project'}</div>
                    <div className="mts-day-date">{p.project_name}</div>
                  </th>
                ))}
                <th className="mts-th-total">Total</th>
              </tr>
            </thead>
            <tbody>
              {week.days.map(d => {
                const off = ['weekend', 'holiday', 'leave', 'future'].includes(d.source);
                const total = dayTotal(d.date);
                const differs = Math.abs(total - (d.hours || 0)) >= 0.25;
                return (
                  <tr key={d.date} className={`mts-row${off ? ' mts-row-off' : ''}`}>
                    <td className="mts-td-project"><div className="mts-proj-name">{fmtDay(d.date)}</div></td>
                    <td className="mts-td-hour">
                      <div className="mts-hrs">{fmtHrs(d.hours)}</div>
                      <div className="mts-source">{d.source === 'holiday' && d.note ? d.note : SOURCE_LABEL[d.source] || d.source}</div>
                    </td>
                    {projects.map(p => {
                      const v = hours[d.date]?.[p.id] || 0;
                      return (
                        <td key={p.id} className="mts-td-hour">
                          {editable && d.source !== 'future' ? (
                            <input className="mts-cell" type="number" min="0" max="24" step="0.25"
                              aria-label={`${p.project_name} hours on ${d.date}`}
                              value={v === 0 ? '' : v} placeholder="0"
                              onChange={e => setCell(d.date, p.id, e.target.value)} />
                          ) : <span className={v > 0 ? 'mts-hrs' : 'mts-hrs-empty'}>{fmtHrs(v)}</span>}
                        </td>
                      );
                    })}
                    <td className="mts-td-total" title={differs ? 'Differs from attendance' : undefined}>
                      {fmtHrs(total)}{differs && total > 0 ? ' *' : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="mts-foot-row">
                <td className="mts-td-project mts-foot-label">Week</td>
                <td className="mts-td-hour mts-foot-total">{fmtHrs(attendanceTotal)}</td>
                {projects.map(p => <td key={p.id} className="mts-td-hour mts-foot-total">{fmtHrs(projTotal(p.id))}</td>)}
                <td className="mts-td-total mts-foot-total">{fmtHrs(weekTotal)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="mts-note">
          * the day&apos;s total differs from attendance. Standard day = a working day with no punch, counted
          as {week.full_day_hours}h. Hours are split across your projects by your allocation; change any figure before submitting.
        </p>
      </>)}
    </PageShell>
  );
}
