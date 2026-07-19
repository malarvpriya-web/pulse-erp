import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { ChevronLeft, ChevronRight, Plane } from 'lucide-react';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

const STATUS_COLOR = {
  Approved: '#10b981',
  Pending:  '#f59e0b',
  Rejected: '#ef4444',
  Completed:'#6366f1',
};

export default function TravelCalendar() {
  const now   = new Date();
  const [year,  setYear]  = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    setLoading(true);
    const monthStr = `${year}-${String(month + 1).padStart(2,'0')}`;
    api.get('/travel/calendar', { params: { month: monthStr } })
      .then(r => setTrips(Array.isArray(r.data) ? r.data : []))
      .catch(() => setTrips([]))
      .finally(() => setLoading(false));
  }, [year, month]);

  const prev = () => { if (month === 0){ setMonth(11); setYear(y => y - 1); } else setMonth(m => m - 1); };
  const next = () => { if (month === 11){ setMonth(0);  setYear(y => y + 1); } else setMonth(m => m + 1); };

  const firstDay    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const tripsOnDay = day => {
    const d = `${year}-${String(month + 1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    return trips.filter(t => {
      const from = (t?.from_date ?? '').slice(0, 10);
      const to   = (t?.to_date ?? t?.from_date ?? '').slice(0, 10);
      return from <= d && d <= to;
    });
  };

  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Travel Calendar</h1>
          <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>Team travel schedule at a glance</p>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <button onClick={prev} style={{ background:'#fff', border:'1px solid #e5e7eb', borderRadius:8, padding:'7px 10px', cursor:'pointer' }}><ChevronLeft size={16}/></button>
          <span style={{ fontSize:15, fontWeight:600, color:'#1f2937', minWidth:160, textAlign:'center' }}>{MONTHS[month]} {year}</span>
          <button onClick={next} style={{ background:'#fff', border:'1px solid #e5e7eb', borderRadius:8, padding:'7px 10px', cursor:'pointer' }}><ChevronRight size={16}/></button>
        </div>
      </div>

      {loading ? <div style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>Loading trips...</div> : (
        <>
          <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden', marginBottom:16 }}>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)' }}>
              {DAYS.map(d => (
                <div key={d} style={{ padding:'12px 8px', textAlign:'center', fontWeight:600, color:'#9ca3af', fontSize:12, borderBottom:'1px solid #f0f0f4', background:'#f9fafb' }}>{d}</div>
              ))}
              {cells.map((day, i) => {
                const dayTrips = day ? tripsOnDay(day) : [];
                const isToday  = day && year === now.getFullYear() && month === now.getMonth() && day === now.getDate();
                return (
                  <div key={i} style={{ minHeight:80, padding:6, border:'1px solid #f0f0f4', background:isToday?'#f5f3ff':'#fff', cursor:dayTrips.length > 0 ? 'pointer' : 'default' }}
                    onClick={() => day && dayTrips.length > 0 && setSelected({ day, trips: dayTrips })}>
                    {day && (
                      <>
                        <span style={{ fontSize:12, fontWeight:isToday?700:400, color:isToday?'#6B3FDB':'#374151', display:'block', marginBottom:4 }}>{day}</span>
                        {dayTrips.slice(0, 2).map((t, ti) => (
                          <div key={ti} style={{
                            background:(STATUS_COLOR[t?.status] || '#6366f1') + '20',
                            color:      STATUS_COLOR[t?.status] || '#6366f1',
                            fontSize:10, fontWeight:600, padding:'1px 5px', borderRadius:3,
                            overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', marginBottom:2,
                          }} title={`${t?.employee_name ?? ''} → ${t?.destination ?? ''}`}>
                            <Plane size={8} style={{ marginRight:3, display:'inline' }}/>{t?.destination ?? 'Trip'}
                          </div>
                        ))}
                        {dayTrips.length > 2 && <div style={{ fontSize:9, color:'#9ca3af' }}>+{dayTrips.length - 2} more</div>}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {trips.length === 0 && (
            <div style={{ textAlign:'center', padding:'1rem', color:'var(--color-text-tertiary, #9ca3af)' }}>
              No travel scheduled this month
            </div>
          )}

          <div style={{ display:'flex', gap:16 }}>
            {Object.entries(STATUS_COLOR).map(([s, c]) => (
              <div key={s} style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color:'#374151' }}>
                <div style={{ width:10, height:10, borderRadius:2, background:c }}/>{s}
              </div>
            ))}
          </div>
        </>
      )}

      {selected && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.4)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}
          onClick={() => setSelected(null)}>
          <div style={{ background:'#fff', borderRadius:12, padding:24, width:400, boxShadow:'0 20px 60px rgba(0,0,0,.2)' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ fontSize:16, fontWeight:700, color:'#1f2937', margin:'0 0 16px' }}>
              Trips on {MONTHS[month]} {selected.day}
            </h3>
            {selected.trips.map((t, i) => (
              <div key={i} style={{ padding:'12px 0', borderBottom:'1px solid #f0f0f4' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                  <div>
                    <p style={{ fontSize:13, fontWeight:600, color:'#1f2937', margin:0 }}>{t?.employee_name ?? 'Employee'}</p>
                    <p style={{ fontSize:12, color:'#6b7280', margin:'3px 0 0' }}>→ {t?.destination ?? '—'} · {t?.purpose ?? ''}</p>
                    <p style={{ fontSize:11, color:'#9ca3af', margin:'2px 0 0' }}>{(t?.from_date ?? '').slice(0,10)} → {(t?.to_date ?? '').slice(0,10)}</p>
                  </div>
                  <span style={{ background:(STATUS_COLOR[t?.status] || '#6366f1') + '18', color:STATUS_COLOR[t?.status] || '#6366f1', padding:'2px 8px', borderRadius:20, fontSize:10, fontWeight:700 }}>{t?.status ?? 'pending'}</span>
                </div>
              </div>
            ))}
            <button onClick={() => setSelected(null)} style={{ marginTop:16, width:'100%', padding:'9px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
