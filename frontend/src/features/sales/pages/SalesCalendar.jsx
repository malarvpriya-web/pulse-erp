import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { ChevronLeft, ChevronRight, Plus, X, Calendar, Clock } from 'lucide-react';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

const EVENT_TYPES = ['follow_up','demo','meeting','call','proposal'];
const TYPE_LABEL  = { follow_up:'Follow-up', demo:'Demo', meeting:'Meeting', call:'Call', proposal:'Proposal' };
const TYPE_COLOR  = {
  follow_up: '#6366f1',
  demo:      '#10b981',
  meeting:   '#f59e0b',
  call:      '#3b82f6',
  proposal:  '#ef4444',
};

const VIEWS = ['Month','Week','Day'];

const EMPTY_FORM = { title:'', type:'meeting', start_date:'', start_time:'09:00', end_time:'10:00', all_day:false, notes:'' };

function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12:true });
}

export default function SalesCalendar() {
  const toast  = useToast();
  const now    = new Date();
  const [year,    setYear]    = useState(now.getFullYear());
  const [month,   setMonth]   = useState(now.getMonth());
  const [view,    setView]    = useState('Month');
  const [events,  setEvents]  = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);   // { day, events }
  const [detail,  setDetail]  = useState(null);     // single event for edit/delete
  const [showAdd, setShowAdd] = useState(false);
  const [form,    setForm]    = useState(EMPTY_FORM);
  const [saving,  setSaving]  = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pendingHandleDelete, setPendingHandleDelete] = useState(null);

  function load() {
    setLoading(true);
    api.get('/sales/calendar/events', { params: { month: month + 1, year } })
      .then(r => setEvents(Array.isArray(r.data) ? r.data : []))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, [year, month]); // eslint-disable-line react-hooks/exhaustive-deps

  const prev = () => { if (month === 0) { setMonth(11); setYear(y => y - 1); } else setMonth(m => m - 1); };
  const next = () => { if (month === 11) { setMonth(0); setYear(y => y + 1); } else setMonth(m => m + 1); };

  const eventsOnDay = day => {
    const d = `${year}-${String(month + 1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    return events.filter(e => (e.start_at || '').slice(0, 10) === d);
  };

  async function handleSave(e) {
    e.preventDefault();
    if (!form.title.trim() || !form.start_date) return;
    setSaving(true);
    try {
      const start_at = form.all_day
        ? `${form.start_date}T00:00:00`
        : `${form.start_date}T${form.start_time}:00`;
      const end_at = form.all_day
        ? null
        : `${form.start_date}T${form.end_time}:00`;
      await api.post('/sales/calendar/events', {
        title: form.title, type: form.type, start_at, end_at,
        all_day: form.all_day, notes: form.notes || null,
      });
      toast.success('Event added');
      setShowAdd(false);
      setForm(EMPTY_FORM);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save event');
    } finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!pendingHandleDelete) return;
    const id = pendingHandleDelete;
    setPendingHandleDelete(null);
    setDeleting(true);
    try {
      await api.delete(`/sales/calendar/events/${id}`);
      toast.success('Event deleted');
      setDetail(null);
      setSelected(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to delete event');
    } finally { setDeleting(false); }
  }

  const firstDay    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>

      <ConfirmDialog
        open={!!pendingHandleDelete}
        title="Delete Event"
        message="Delete this event?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingHandleDelete(null)}
      />

      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20, flexWrap:'wrap', gap:12 }}>
        <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Sales Calendar</h1>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          {/* View toggle */}
          <div style={{ display:'flex', border:'1px solid #e5e7eb', borderRadius:8, overflow:'hidden' }}>
            {VIEWS.map(v => (
              <button key={v} onClick={() => setView(v)}
                style={{ padding:'7px 14px', fontSize:12, fontWeight:600, border:'none', cursor:'pointer', background: view===v ? '#6B3FDB' : '#fff', color: view===v ? '#fff' : '#374151' }}>
                {v}
              </button>
            ))}
          </div>
          {/* Month nav */}
          <button onClick={prev} style={{ background:'#fff', border:'1px solid #e5e7eb', borderRadius:8, padding:'7px 10px', cursor:'pointer', display:'flex', alignItems:'center' }}><ChevronLeft size={16}/></button>
          <span style={{ fontSize:14, fontWeight:600, color:'#1f2937', minWidth:150, textAlign:'center' }}>{MONTHS[month]} {year}</span>
          <button onClick={next} style={{ background:'#fff', border:'1px solid #e5e7eb', borderRadius:8, padding:'7px 10px', cursor:'pointer', display:'flex', alignItems:'center' }}><ChevronRight size={16}/></button>
          {/* Add Event */}
          <button onClick={() => setShowAdd(true)}
            style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 16px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
            <Plus size={14}/> Add Event
          </button>
        </div>
      </div>

      {/* Legend */}
      <div style={{ display:'flex', gap:14, marginBottom:14, flexWrap:'wrap' }}>
        {EVENT_TYPES.map(t => (
          <div key={t} style={{ display:'flex', alignItems:'center', gap:5, fontSize:12, color:'#374151' }}>
            <div style={{ width:10, height:10, borderRadius:2, background:TYPE_COLOR[t] }}/>{TYPE_LABEL[t]}
          </div>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign:'center', padding:60, color:'#9ca3af' }}>Loading...</div>
      ) : view === 'Month' ? (
        <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden' }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)' }}>
            {DAYS.map(d => (
              <div key={d} style={{ padding:'10px 8px', textAlign:'center', fontWeight:600, color:'#9ca3af', fontSize:12, borderBottom:'1px solid #f0f0f4', background:'#f9fafb' }}>{d}</div>
            ))}
            {cells.map((day, i) => {
              const dayEvents = day ? eventsOnDay(day) : [];
              const isToday   = day && year === now.getFullYear() && month === now.getMonth() && day === now.getDate();
              return (
                <div key={i}
                  style={{ minHeight:90, padding:6, border:'1px solid #f0f0f4', background: isToday ? '#f5f3ff' : '#fff', cursor: day ? 'pointer' : 'default' }}
                  onClick={() => day && dayEvents.length > 0 && setSelected({ day, events: dayEvents })}>
                  {day && (
                    <>
                      <span style={{ fontSize:12, fontWeight: isToday ? 700 : 400, color: isToday ? '#6B3FDB' : '#374151', display:'block', marginBottom:3 }}>{day}</span>
                      {dayEvents.slice(0, 3).map((ev, ei) => {
                        const c = TYPE_COLOR[ev.type] || '#6366f1';
                        return (
                          <div key={ei}
                            style={{ background: c + '20', color: c, fontSize:10, fontWeight:600, padding:'2px 5px', borderRadius:3, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', marginBottom:2 }}
                            onClick={e => { e.stopPropagation(); setDetail(ev); }}>
                            {ev.title}
                          </div>
                        );
                      })}
                      {dayEvents.length > 3 && <div style={{ fontSize:9, color:'#9ca3af', marginTop:1 }}>+{dayEvents.length - 3} more</div>}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        /* Week / Day view — simplified event list */
        <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:24 }}>
          <p style={{ color:'#6b7280', fontSize:13, margin:'0 0 16px' }}>{view} view — {events.length} events this month</p>
          {events.length === 0 ? (
            <div style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>
              <Calendar size={36} color="#d1d5db" style={{ marginBottom:12 }}/>
              <p>No events for {MONTHS[month]} {year}. Click "+ Add Event" to create one.</p>
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {events.map(ev => {
                const c = TYPE_COLOR[ev.type] || '#6366f1';
                return (
                  <div key={ev.id}
                    style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 14px', borderRadius:8, border:`1px solid ${c}30`, background: c + '08', cursor:'pointer' }}
                    onClick={() => setDetail(ev)}>
                    <div style={{ width:4, height:36, borderRadius:2, background:c, flexShrink:0 }}/>
                    <div style={{ flex:1, minWidth:0 }}>
                      <p style={{ fontSize:13, fontWeight:600, color:'#1f2937', margin:0 }}>{ev.title}</p>
                      <p style={{ fontSize:11, color:'#6b7280', margin:'2px 0 0' }}>
                        <Clock size={10} style={{ marginRight:3 }}/>{fmtTime(ev.start_at)}
                        {ev.end_at && ` — ${fmtTime(ev.end_at)}`}
                      </p>
                    </div>
                    <span style={{ background: c + '20', color:c, padding:'2px 8px', borderRadius:20, fontSize:10, fontWeight:700 }}>{TYPE_LABEL[ev.type] || ev.type}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Day events popover */}
      {selected && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.4)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}
          onClick={() => setSelected(null)}>
          <div style={{ background:'#fff', borderRadius:12, padding:24, width:380, maxHeight:'80vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,.2)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
              <h3 style={{ fontSize:15, fontWeight:700, color:'#1f2937', margin:0 }}>{MONTHS[month]} {selected.day} — {selected.events.length} event{selected.events.length > 1 ? 's' : ''}</h3>
              <button onClick={() => setSelected(null)} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={18}/></button>
            </div>
            {selected.events.map((ev, i) => {
              const c = TYPE_COLOR[ev.type] || '#6366f1';
              return (
                <div key={i} style={{ padding:'10px 0', borderBottom:'1px solid #f0f0f4', cursor:'pointer' }}
                  onClick={() => { setDetail(ev); setSelected(null); }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                    <p style={{ fontSize:13, fontWeight:600, color:'#1f2937', margin:0 }}>{ev.title}</p>
                    <span style={{ background: c + '20', color:c, padding:'2px 7px', borderRadius:20, fontSize:10, fontWeight:700 }}>{TYPE_LABEL[ev.type] || ev.type}</span>
                  </div>
                  {ev.start_at && <p style={{ fontSize:11, color:'#9ca3af', margin:'3px 0 0' }}>{fmtTime(ev.start_at)}{ev.end_at ? ` — ${fmtTime(ev.end_at)}` : ''}</p>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Event detail / edit / delete */}
      {detail && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.4)', zIndex:1001, display:'flex', alignItems:'center', justifyContent:'center' }}
          onClick={() => setDetail(null)}>
          <div style={{ background:'#fff', borderRadius:12, padding:24, width:400, boxShadow:'0 20px 60px rgba(0,0,0,.2)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
              <h3 style={{ fontSize:15, fontWeight:700, color:'#1f2937', margin:0 }}>Event Detail</h3>
              <button onClick={() => setDetail(null)} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={18}/></button>
            </div>
            {(() => {
              const c = TYPE_COLOR[detail.type] || '#6366f1';
              return (
                <>
                  <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
                    <div style={{ width:8, height:8, borderRadius:50, background:c }}/>
                    <p style={{ fontSize:15, fontWeight:700, color:'#1f2937', margin:0 }}>{detail.title}</p>
                    <span style={{ background: c + '20', color:c, padding:'2px 8px', borderRadius:20, fontSize:11, fontWeight:700, marginLeft:'auto' }}>{TYPE_LABEL[detail.type] || detail.type}</span>
                  </div>
                  <p style={{ fontSize:12, color:'#6b7280', margin:'0 0 6px' }}>
                    <strong>Start:</strong> {new Date(detail.start_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </p>
                  {detail.end_at && <p style={{ fontSize:12, color:'#6b7280', margin:'0 0 6px' }}>
                    <strong>End:</strong> {new Date(detail.end_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </p>}
                  {detail.notes && <p style={{ fontSize:12, color:'#374151', margin:'10px 0 0', padding:'10px', background:'#f9fafb', borderRadius:8 }}>{detail.notes}</p>}
                  <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:20 }}>
                    <button onClick={() => setDetail(null)} style={{ padding:'8px 16px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Close</button>
                    <button onClick={() => setPendingHandleDelete(detail.id)} disabled={deleting}
                      style={{ padding:'8px 16px', background:'#ef4444', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600, opacity: deleting ? 0.6 : 1 }}>
                      {deleting ? 'Deleting...' : 'Delete'}
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* Add Event modal */}
      {showAdd && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:1002, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:'#fff', borderRadius:16, padding:28, width:440, boxShadow:'0 8px 32px rgba(0,0,0,.18)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <h3 style={{ margin:0, fontSize:16, fontWeight:700, color:'#1f2937' }}>New Event</h3>
              <button onClick={() => setShowAdd(false)} style={{ background:'none', border:'none', cursor:'pointer', color:'#6b7280' }}><X size={18}/></button>
            </div>
            <form onSubmit={handleSave} style={{ display:'flex', flexDirection:'column', gap:14 }}>
              <div>
                <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>Title *</label>
                <input required value={form.title} onChange={e => setForm(f => ({...f, title: e.target.value}))}
                  placeholder="e.g. Demo call with Acme Corp"
                  style={{ width:'100%', padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
              </div>
              <div>
                <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>Type</label>
                <select value={form.type} onChange={e => setForm(f => ({...f, type: e.target.value}))}
                  style={{ width:'100%', padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', background:'#fff', boxSizing:'border-box' }}>
                  {EVENT_TYPES.map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>Date *</label>
                <input required type="date" value={form.start_date} onChange={e => setForm(f => ({...f, start_date: e.target.value}))}
                  style={{ width:'100%', padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <input type="checkbox" id="allday" checked={form.all_day} onChange={e => setForm(f => ({...f, all_day: e.target.checked}))}/>
                <label htmlFor="allday" style={{ fontSize:13, color:'#374151', cursor:'pointer' }}>All day</label>
              </div>
              {!form.all_day && (
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                  <div>
                    <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>Start time</label>
                    <input type="time" value={form.start_time} onChange={e => setForm(f => ({...f, start_time: e.target.value}))}
                      style={{ width:'100%', padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
                  </div>
                  <div>
                    <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>End time</label>
                    <input type="time" value={form.end_time} onChange={e => setForm(f => ({...f, end_time: e.target.value}))}
                      style={{ width:'100%', padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
                  </div>
                </div>
              )}
              <div>
                <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>Notes</label>
                <textarea value={form.notes} onChange={e => setForm(f => ({...f, notes: e.target.value}))} rows={3}
                  placeholder="Optional notes..."
                  style={{ width:'100%', padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', resize:'vertical', boxSizing:'border-box' }}/>
              </div>
              <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:4 }}>
                <button type="button" onClick={() => setShowAdd(false)}
                  style={{ padding:'8px 18px', background:'#f5f5f5', border:'1px solid #e0e0e0', borderRadius:8, cursor:'pointer', fontSize:13 }}>Cancel</button>
                <button type="submit" disabled={saving}
                  style={{ padding:'8px 20px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor: saving ? 'not-allowed' : 'pointer', fontWeight:600, fontSize:13, opacity: saving ? 0.7 : 1 }}>
                  {saving ? 'Saving...' : 'Save Event'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
