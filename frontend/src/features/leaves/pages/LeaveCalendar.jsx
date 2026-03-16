import { useState, useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight, Users } from 'lucide-react';
import api from '@/services/api/client';
import './LeaveCalendar.css';

const LEAVE_TYPES = {
  Casual:    { bg: '#dbeafe', color: '#1d4ed8' },
  Sick:      { bg: '#fee2e2', color: '#dc2626' },
  Earned:    { bg: '#dcfce7', color: '#15803d' },
  Maternity: { bg: '#fce7f3', color: '#9d174d' },
  Paternity: { bg: '#ede9fe', color: '#7c3aed' },
  Optional:  { bg: '#fef3c7', color: '#92400e' },
};

const SAMPLE_LEAVES = [
  { id: 1,  employee: 'Arjun Mehta',   type: 'Casual',   startDate: '2026-03-10', endDate: '2026-03-11', status: 'Approved' },
  { id: 2,  employee: 'Priya Sharma',  type: 'Sick',     startDate: '2026-03-15', endDate: '2026-03-15', status: 'Approved' },
  { id: 3,  employee: 'Rahul Verma',   type: 'Earned',   startDate: '2026-03-17', endDate: '2026-03-21', status: 'Approved' },
  { id: 4,  employee: 'Sneha Iyer',    type: 'Casual',   startDate: '2026-03-20', endDate: '2026-03-20', status: 'Pending'  },
  { id: 5,  employee: 'Kiran Das',     type: 'Sick',     startDate: '2026-03-24', endDate: '2026-03-25', status: 'Approved' },
  { id: 6,  employee: 'Vikram Singh',  type: 'Earned',   startDate: '2026-03-27', endDate: '2026-03-29', status: 'Approved' },
  { id: 7,  employee: 'Meera Joshi',   type: 'Optional', startDate: '2026-03-25', endDate: '2026-03-25', status: 'Approved' },
  { id: 8,  employee: 'Rohit Gupta',   type: 'Casual',   startDate: '2026-04-01', endDate: '2026-04-02', status: 'Pending'  },
  { id: 9,  employee: 'Anika Patel',   type: 'Earned',   startDate: '2026-03-03', endDate: '2026-03-07', status: 'Approved' },
  { id: 10, employee: 'Suresh Nair',   type: 'Sick',     startDate: '2026-03-18', endDate: '2026-03-18', status: 'Approved' },
];

const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function toKey(y, m, d) { return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`; }
function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
function firstDay(y, m)    { return new Date(y, m, 1).getDay(); }

export default function LeaveCalendar() {
  const now = new Date();
  const [year, setYear]     = useState(now.getFullYear());
  const [month, setMonth]   = useState(now.getMonth());
  const [leaves, setLeaves] = useState(SAMPLE_LEAVES);
  const [selected, setSelected] = useState(null);
  const [typeFilter, setTypeFilter] = useState('All');

  const load = useCallback(async () => {
    try {
      const res = await api.get('/leaves/calendar', { params: { year, month: month + 1 } });
      const raw = res.data?.data ?? res.data;
      if (Array.isArray(raw) && raw.length) setLeaves(raw);
    } catch { /* use sample */ }
  }, [year, month]);

  useEffect(() => { load(); }, [load]);

  const prev = () => { if (month === 0) { setMonth(11); setYear(y => y-1); } else setMonth(m => m-1); };
  const next = () => { if (month === 11) { setMonth(0); setYear(y => y+1); } else setMonth(m => m+1); };

  const filtered = leaves.filter(l => typeFilter === 'All' || l.type === typeFilter);

  /* build day → [leave] map */
  const byDay = {};
  filtered.forEach(l => {
    const s = new Date(l.startDate), e = l.endDate ? new Date(l.endDate) : s;
    for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
      if (d.getFullYear() === year && d.getMonth() === month) {
        const k = toKey(year, month, d.getDate());
        (byDay[k] = byDay[k] || []).push(l);
      }
    }
  });

  /* today on leave */
  const todayKey = toKey(now.getFullYear(), now.getMonth(), now.getDate());
  const onLeaveToday = leaves.filter(l => {
    const s = new Date(l.startDate), e = l.endDate ? new Date(l.endDate) : s;
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return t >= s && t <= e && l.status === 'Approved';
  });

  const totalDays   = daysInMonth(year, month);
  const startPad    = firstDay(year, month);
  const cells       = Array.from({ length: startPad + totalDays }, (_, i) => i < startPad ? null : i - startPad + 1);
  const isToday = d => d === now.getDate() && month === now.getMonth() && year === now.getFullYear();

  const selKey     = selected ? toKey(year, month, selected) : null;
  const selLeaves  = selKey ? (byDay[selKey] || []) : [];

  return (
    <div className="lc-root">
      <div className="lc-header">
        <div>
          <h1 className="lc-title">Leave Calendar</h1>
          <p className="lc-sub">Team leave overview — {MONTHS[month]} {year}</p>
        </div>
        <div className="lc-type-pills">
          <button className={`lc-pill ${typeFilter==='All'?'lc-pill-active':''}`} onClick={()=>setTypeFilter('All')}>All</button>
          {Object.keys(LEAVE_TYPES).map(t => (
            <button key={t} className={`lc-pill ${typeFilter===t?'lc-pill-active':''}`}
              style={typeFilter===t ? { background: LEAVE_TYPES[t].bg, color: LEAVE_TYPES[t].color, borderColor: LEAVE_TYPES[t].color } : {}}
              onClick={() => setTypeFilter(t)}>{t}</button>
          ))}
        </div>
      </div>

      <div className="lc-layout">
        {/* Calendar */}
        <div className="lc-cal-card">
          <div className="lc-nav">
            <button className="lc-nav-btn" onClick={prev}><ChevronLeft size={16}/></button>
            <span className="lc-month-lbl">{MONTHS[month]} {year}</span>
            <button className="lc-nav-btn" onClick={next}><ChevronRight size={16}/></button>
          </div>

          <div className="lc-day-hdrs">
            {DAYS.map(d => <div key={d} className="lc-day-hdr">{d}</div>)}
          </div>

          <div className="lc-grid">
            {cells.map((day, i) => {
              if (!day) return <div key={i} className="lc-cell lc-cell-empty" />;
              const k = toKey(year, month, day);
              const dl = byDay[k] || [];
              return (
                <div key={i}
                  className={`lc-cell ${isToday(day)?'lc-cell-today':''} ${selected===day?'lc-cell-sel':''} ${dl.length?'lc-cell-has':''}` }
                  onClick={() => setSelected(selected===day ? null : day)}>
                  <span className="lc-day-num">{day}</span>
                  <div className="lc-dots">
                    {dl.slice(0,3).map((l,ti) => {
                      const meta = LEAVE_TYPES[l.type] || LEAVE_TYPES.Casual;
                      return <div key={ti} className="lc-dot" style={{ background: meta.color, opacity: l.status==='Pending'?0.5:1 }} title={`${l.employee} — ${l.type}`} />;
                    })}
                    {dl.length > 3 && <div className="lc-dot-more">+{dl.length-3}</div>}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Legend */}
          <div className="lc-legend">
            {Object.entries(LEAVE_TYPES).map(([t, m]) => (
              <div key={t} className="lc-legend-item">
                <div className="lc-legend-dot" style={{ background: m.color }} />{t}
              </div>
            ))}
            <div className="lc-legend-item"><div className="lc-legend-dot lc-dot-pending" />Pending</div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="lc-side">
          {/* Today panel */}
          <div className="lc-side-section">
            <div className="lc-side-hd"><Users size={13}/> On Leave Today ({onLeaveToday.length})</div>
            {onLeaveToday.length === 0 ? (
              <div className="lc-side-empty">Everyone is in today</div>
            ) : (
              onLeaveToday.map(l => {
                const meta = LEAVE_TYPES[l.type] || LEAVE_TYPES.Casual;
                return (
                  <div key={l.id} className="lc-side-item">
                    <div className="lc-side-avatar">{l.employee.split(' ').map(w=>w[0]).join('').slice(0,2)}</div>
                    <div>
                      <div className="lc-side-name">{l.employee}</div>
                      <span className="lc-side-badge" style={{ background: meta.bg, color: meta.color }}>{l.type}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Selected day panel */}
          {selected && (
            <div className="lc-side-section">
              <div className="lc-side-hd">{MONTHS[month].slice(0,3)} {selected} leaves ({selLeaves.length})</div>
              {selLeaves.length === 0 ? (
                <div className="lc-side-empty">No leaves on this day</div>
              ) : (
                selLeaves.map(l => {
                  const meta = LEAVE_TYPES[l.type] || LEAVE_TYPES.Casual;
                  return (
                    <div key={l.id} className="lc-side-item">
                      <div className="lc-side-avatar">{l.employee.split(' ').map(w=>w[0]).join('').slice(0,2)}</div>
                      <div>
                        <div className="lc-side-name">{l.employee}</div>
                        <div className="lc-side-meta">
                          <span className="lc-side-badge" style={{ background: meta.bg, color: meta.color }}>{l.type}</span>
                          <span className={`lc-side-status ${l.status==='Pending'?'lc-status-pending':'lc-status-approved'}`}>{l.status}</span>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {/* Monthly summary */}
          <div className="lc-side-section">
            <div className="lc-side-hd">This Month Summary</div>
            {Object.entries(LEAVE_TYPES).map(([t, m]) => {
              const cnt = filtered.filter(l => l.type === t && (
                new Date(l.startDate).getMonth() === month && new Date(l.startDate).getFullYear() === year
              )).length;
              if (!cnt) return null;
              return (
                <div key={t} className="lc-summary-row">
                  <div className="lc-legend-dot" style={{ background: m.color }} />
                  <span className="lc-summary-type">{t}</span>
                  <span className="lc-summary-cnt">{cnt}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
