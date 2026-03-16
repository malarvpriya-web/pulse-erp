import { useState, useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight, Plane, MapPin } from 'lucide-react';
import api from '@/services/api/client';
import './TravelCalendar.css';

const SAMPLE_TRIPS = [
  { id: 1, employee: 'Arjun Mehta', destination: 'Mumbai', travelDate: '2026-03-20', returnDate: '2026-03-21', status: 'Approved', color: '#6366f1' },
  { id: 2, employee: 'Priya Sharma', destination: 'Bengaluru', travelDate: '2026-03-25', returnDate: '2026-03-27', status: 'Approved', color: '#8b5cf6' },
  { id: 3, employee: 'Rahul Verma', destination: 'Delhi', travelDate: '2026-03-25', returnDate: '2026-03-28', status: 'Pending', color: '#f59e0b' },
  { id: 4, employee: 'Sneha Iyer', destination: 'Chennai', travelDate: '2026-03-28', returnDate: '2026-03-29', status: 'Approved', color: '#10b981' },
  { id: 5, employee: 'Kiran Das', destination: 'Hyderabad', travelDate: '2026-04-01', returnDate: '2026-04-02', status: 'Pending', color: '#f59e0b' },
  { id: 6, employee: 'Vikram Singh', destination: 'Nagpur', travelDate: '2026-03-22', returnDate: '2026-03-23', status: 'Approved', color: '#6366f1' },
  { id: 7, employee: 'Meera Joshi', destination: 'Bengaluru', travelDate: '2026-03-28', returnDate: '2026-03-30', status: 'Pending', color: '#f59e0b' },
];

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
function firstDay(y, m)    { return new Date(y, m, 1).getDay(); }
function toKey(y, m, d)    { return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`; }

export default function TravelCalendar() {
  const now = new Date();
  const [year, setYear]         = useState(now.getFullYear());
  const [month, setMonth]       = useState(now.getMonth());
  const [trips, setTrips]       = useState(SAMPLE_TRIPS);
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/travel/calendar', { params: { year, month: month + 1 } });
      const raw = res.data?.data ?? res.data;
      if (Array.isArray(raw) && raw.length) setTrips(raw);
    } catch { /* use sample */ }
  }, [year, month]);

  useEffect(() => { load(); }, [load]);

  const prev = () => { if (month === 0) { setMonth(11); setYear(y => y - 1); } else setMonth(m => m - 1); };
  const next = () => { if (month === 11) { setMonth(0); setYear(y => y + 1); } else setMonth(m => m + 1); };

  // Build day-to-trips map
  const tripsByDay = {};
  trips.forEach(t => {
    const start = new Date(t.travelDate);
    const end   = t.returnDate ? new Date(t.returnDate) : start;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      if (d.getFullYear() === year && d.getMonth() === month) {
        const key = toKey(year, month, d.getDate());
        if (!tripsByDay[key]) tripsByDay[key] = [];
        if (!tripsByDay[key].find(x => x.id === t.id)) tripsByDay[key].push(t);
      }
    }
  });

  const totalDays = daysInMonth(year, month);
  const startPad  = firstDay(year, month);
  const cells     = Array.from({ length: startPad + totalDays }, (_, i) => i < startPad ? null : i - startPad + 1);

  const selectedKey   = selected ? toKey(year, month, selected) : null;
  const selectedTrips = selectedKey ? (tripsByDay[selectedKey] || []) : [];
  const today         = new Date();
  const isToday = d => d === today.getDate() && month === today.getMonth() && year === today.getFullYear();

  return (
    <div className="tvc-root">
      <div className="tvc-header">
        <div>
          <h1 className="tvc-title">Travel Calendar</h1>
          <p className="tvc-sub">Upcoming travel across the organisation</p>
        </div>
      </div>

      <div className="tvc-layout">
        <div className="tvc-cal-card">
          <div className="tvc-cal-nav">
            <button className="tvc-nav-btn" onClick={prev}><ChevronLeft size={16} /></button>
            <span className="tvc-month-label">{MONTHS[month]} {year}</span>
            <button className="tvc-nav-btn" onClick={next}><ChevronRight size={16} /></button>
          </div>

          <div className="tvc-day-headers">
            {DAYS.map(d => <div key={d} className="tvc-day-hd">{d}</div>)}
          </div>

          <div className="tvc-grid">
            {cells.map((day, i) => {
              if (!day) return <div key={i} className="tvc-cell tvc-cell-empty" />;
              const key    = toKey(year, month, day);
              const dayTrips = tripsByDay[key] || [];
              return (
                <div
                  key={i}
                  className={`tvc-cell ${isToday(day) ? 'tvc-cell-today' : ''} ${selected === day ? 'tvc-cell-selected' : ''} ${dayTrips.length ? 'tvc-cell-has-trips' : ''}`}
                  onClick={() => setSelected(selected === day ? null : day)}
                >
                  <span className="tvc-day-num">{day}</span>
                  {dayTrips.slice(0, 2).map((t, ti) => (
                    <div key={ti} className="tvc-trip-dot" style={{ background: t.color }} title={`${t.employee} → ${t.destination}`} />
                  ))}
                  {dayTrips.length > 2 && <div className="tvc-more-dot">+{dayTrips.length - 2}</div>}
                </div>
              );
            })}
          </div>

          <div className="tvc-legend">
            <div className="tvc-legend-item"><div className="tvc-legend-dot" style={{ background: '#6366f1' }} />Approved</div>
            <div className="tvc-legend-item"><div className="tvc-legend-dot" style={{ background: '#f59e0b' }} />Pending</div>
          </div>
        </div>

        <div className="tvc-side">
          {selected ? (
            <>
              <div className="tvc-side-hd">
                <MapPin size={14} />
                <span>{MONTHS[month].slice(0, 3)} {selected}, {year}</span>
              </div>
              {selectedTrips.length === 0 ? (
                <div className="tvc-no-trips"><Plane size={24} color="#d1d5db" /><p>No trips on this day</p></div>
              ) : (
                <div className="tvc-trip-list">
                  {selectedTrips.map(t => (
                    <div key={t.id} className="tvc-trip-item" style={{ borderLeftColor: t.color }}>
                      <div className="tvc-trip-emp">{t.employee}</div>
                      <div className="tvc-trip-dest"><Plane size={11} /> {t.destination}</div>
                      <div className="tvc-trip-dates">{new Date(t.travelDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} — {t.returnDate ? new Date(t.returnDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : 'Same day'}</div>
                      <span className="tvc-trip-status" style={{ background: t.status === 'Approved' ? '#dcfce7' : '#fef3c7', color: t.status === 'Approved' ? '#15803d' : '#92400e' }}>{t.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="tvc-no-select"><Plane size={28} color="#d1d5db" /><p>Click a date to see trips</p></div>
          )}

          <div className="tvc-upcoming-hd">Upcoming Trips</div>
          <div className="tvc-upcoming-list">
            {trips.filter(t => new Date(t.travelDate) >= today).slice(0, 5).map(t => (
              <div key={t.id} className="tvc-upcoming-item">
                <div className="tvc-upcoming-dot" style={{ background: t.color }} />
                <div>
                  <div className="tvc-upcoming-emp">{t.employee}</div>
                  <div className="tvc-upcoming-dest">{t.destination} · {new Date(t.travelDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
