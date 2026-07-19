import { useState, useEffect, useRef, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import {
  Plus, X, Search, MapPin, Clock, Calendar, AlertCircle, CheckCircle,
  Download, ChevronLeft, ChevronRight, List, LayoutGrid, TrendingUp,
} from 'lucide-react';

const STATUS_COLOR = {
  Scheduled:     { bg: '#ede9fe', color: '#6B3FDB' },
  'In Progress': { bg: '#fef3c7', color: '#92400e' },
  Completed:     { bg: '#d1fae5', color: '#065f46' },
  Cancelled:     { bg: '#fee2e2', color: '#991b1b' },
};
const PRIORITY_COLOR = {
  High:   { bg: '#fee2e2', color: '#991b1b' },
  Medium: { bg: '#fef3c7', color: '#92400e' },
  Low:    { bg: '#f3f4f6', color: '#374151' },
  Normal: { bg: '#f3f4f6', color: '#374151' },
};

const EMPTY_FORM = {
  customer_name: '', address: '', visit_date: '', visit_time: '09:00',
  engineer_name: '', purpose: '', ticket_id: '', priority: 'Normal',
  notes: '', serial_number: '', visit_type: 'Service', amc_contract_id: '',
};

const EMPTY_COMPLETE = {
  work_done: '', parts_used: [], labour_hours: '', travel_km: '',
  cost: '', start_time_actual: '', end_time_actual: '', customer_signature: '',
  resolution_notes: '',
};

const DAY_NAMES  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

export default function FieldVisitScheduler() {
  const [visits,       setVisits]       = useState([]);
  const [engineers,    setEngineers]    = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [showForm,     setShowForm]     = useState(false);
  const [form,         setForm]         = useState(EMPTY_FORM);
  const [saving,       setSaving]       = useState(false);
  const [search,       setSearch]       = useState('');
  const [dateFilter,   setDateFilter]   = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [completing,   setCompleting]   = useState(null);
  const [completeData, setCompleteData] = useState(EMPTY_COMPLETE);
  const [partLine,     setPartLine]     = useState({ name: '', qty: 1, unit_cost: 0 });
  const [view,         setView]         = useState('list');
  const [calMonth,     setCalMonth]     = useState(() => new Date().toISOString().slice(0, 7));
  const isMounted = useRef(true);
  const toast = useToast();

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    Promise.allSettled([
      api.get('/servicedesk/field-visits', { params: { limit: 200 } }),
      api.get('/servicedesk/engineers'),
    ]).then(([visitsRes, engRes]) => {
      if (!isMounted.current) return;
      setVisits(visitsRes.status === 'fulfilled' ? (Array.isArray(visitsRes.value?.data) ? visitsRes.value.data : []) : []);
      if (engRes.status === 'fulfilled') setEngineers(engRes.value?.data || []);
    }).finally(() => { if (isMounted.current) setLoading(false); });
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    if (!form.customer_name || !form.visit_date) {
      toast.error('Customer name and visit date are required');
      return;
    }
    setSaving(true);
    try {
      await api.post('/servicedesk/field-visits', {
        ...form,
        ticket_id:       form.ticket_id       || null,
        amc_contract_id: form.amc_contract_id || null,
      });
      setShowForm(false); setForm(EMPTY_FORM);
      toast.success('Field visit scheduled');
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to save visit');
    } finally { if (isMounted.current) setSaving(false); }
  };

  const updateStatus = async (id, status) => {
    try {
      await api.put(`/servicedesk/field-visits/${id}`, { status });
      toast.success(`Visit marked as ${status}`);
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to update status');
    }
  };

  const addPartLine = () => {
    if (!partLine.name) return;
    setCompleteData(d => ({ ...d, parts_used: [...(d.parts_used || []), { ...partLine }] }));
    setPartLine({ name: '', qty: 1, unit_cost: 0 });
  };

  const removePartLine = (idx) => {
    setCompleteData(d => ({ ...d, parts_used: d.parts_used.filter((_, i) => i !== idx) }));
  };

  const handleComplete = async () => {
    if (!completing) return;
    try {
      const totalCost = completeData.parts_used.reduce(
        (s, p) => s + (parseFloat(p.qty) * parseFloat(p.unit_cost || 0)), 0
      ) + parseFloat(completeData.cost || 0);
      await api.put(`/servicedesk/field-visits/${completing}`, {
        status: 'Completed',
        completed_at:       new Date().toISOString(),
        work_done:          completeData.work_done          || null,
        parts_used:         completeData.parts_used,
        labour_hours:       parseFloat(completeData.labour_hours) || 0,
        travel_km:          parseFloat(completeData.travel_km)    || 0,
        cost:               totalCost,
        start_time_actual:  completeData.start_time_actual  || null,
        end_time_actual:    completeData.end_time_actual    || null,
        customer_signature: completeData.customer_signature || null,
        notes:              completeData.resolution_notes   || null,
      });
      toast.success('Visit marked as completed');
      setCompleting(null); setCompleteData(EMPTY_COMPLETE);
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to complete visit');
    }
  };

  const handleExport = async () => {
    try {
      const res = await api.get('/servicedesk/export/field-visits', { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a'); a.href = url;
      a.download = `field_visits_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click(); URL.revokeObjectURL(url);
    } catch { toast.error('Export failed'); }
  };

  const today = new Date().toISOString().slice(0, 10);

  const filtered = visits.filter(v => {
    const matchSearch = !search || [v?.customer_name, v?.engineer_name, v?.address, v?.purpose, v?.notes, v?.serial_number]
      .some(s => (s || '').toLowerCase().includes(search.toLowerCase()));
    const matchDate   = !dateFilter || (v?.visit_date || '').slice(0, 10) === dateFilter;
    const matchStatus = !statusFilter || v?.status === statusFilter;
    return matchSearch && matchDate && matchStatus;
  });

  const todayVisits     = visits.filter(v => (v?.visit_date || '').slice(0, 10) === today).length;
  const overdueVisits   = visits.filter(v => v?.status === 'Scheduled' && (v?.visit_date || '').slice(0, 10) < today).length;
  const completedVisits = visits.filter(v => v?.status === 'Completed').length;
  const pendingVisits   = visits.filter(v => ['Scheduled', 'In Progress'].includes(v?.status)).length;

  // Build date → visits map for calendar
  const visitsByDate = {};
  visits.forEach(v => {
    const d = (v?.visit_date || '').slice(0, 10);
    if (d) { if (!visitsByDate[d]) visitsByDate[d] = []; visitsByDate[d].push(v); }
  });

  // Calendar navigation
  const [calYear, calMonthNum] = calMonth.split('-').map(Number);
  const firstWeekday = new Date(calYear, calMonthNum - 1, 1).getDay();
  const daysInMonth  = new Date(calYear, calMonthNum, 0).getDate();
  const prevMonth = () => {
    const d = new Date(calYear, calMonthNum - 2, 1);
    setCalMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };
  const nextMonth = () => {
    const d = new Date(calYear, calMonthNum, 1);
    setCalMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };

  const inputStyle     = { width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
  const labelStyle     = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 };
  const filterCtrlStyle = { padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', color: '#374151', fontFamily: 'inherit', background: '#fff' };

  const statCards = [
    { label: 'Total Visits',   value: visits.length,    icon: <TrendingUp  size={16} color="#6B3FDB" />, bg: '#ede9fe', color: '#6B3FDB' },
    { label: "Today's Visits", value: todayVisits,      icon: <Calendar    size={16} color="#2563eb" />, bg: '#dbeafe', color: '#2563eb' },
    { label: 'Pending',        value: pendingVisits,    icon: <AlertCircle size={16} color="#d97706" />, bg: '#fef3c7', color: '#d97706' },
    { label: 'Completed',      value: completedVisits,  icon: <CheckCircle size={16} color="#059669" />, bg: '#d1fae5', color: '#059669' },
  ];

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Field Service</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>
            {visits.length} visits · {todayVisits} today · {completedVisits} completed
            {overdueVisits > 0 && <span style={{ color: '#ef4444', fontWeight: 600, marginLeft: 8 }}>· {overdueVisits} overdue</span>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleExport}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', background: '#fff', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
            <Download size={14} /> Export
          </button>
          <button onClick={() => setShowForm(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            <Plus size={15} /> Schedule Visit
          </button>
        </div>
      </div>

      {/* ── KPI Cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 20 }}>
        {statCards.map(c => (
          <div key={c.label} style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 38, height: 38, borderRadius: 10, background: c.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {c.icon}
            </div>
            <div>
              <div style={{ fontSize: 22, fontWeight: 700, color: c.color }}>{c.value}</div>
              <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 500 }}>{c.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Filters + View Toggle ── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search customer, engineer, serial number..."
            style={{ width: '100%', paddingLeft: 32, paddingRight: 12, paddingTop: 8, paddingBottom: 8, border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
        </div>
        {view === 'list' && (
          <input type="date" value={dateFilter} onChange={e => setDateFilter(e.target.value)}
            style={filterCtrlStyle} />
        )}
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          style={filterCtrlStyle}>
          <option value="">All Status</option>
          {['Scheduled', 'In Progress', 'Completed', 'Cancelled'].map(s => <option key={s}>{s}</option>)}
        </select>
        {(dateFilter || statusFilter) && (
          <button onClick={() => { setDateFilter(''); setStatusFilter(''); }}
            style={{ padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 12, color: '#6b7280' }}>
            Clear
          </button>
        )}
        {/* List / Calendar toggle */}
        <div style={{ display: 'flex', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', marginLeft: 'auto' }}>
          <button onClick={() => setView('list')}
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 14px', background: view === 'list' ? '#6B3FDB' : '#fff', color: view === 'list' ? '#fff' : '#6b7280', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500 }}>
            <List size={13} /> List
          </button>
          <button onClick={() => setView('calendar')}
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 14px', background: view === 'calendar' ? '#6B3FDB' : '#fff', color: view === 'calendar' ? '#fff' : '#6b7280', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500, borderLeft: '1px solid #e5e7eb' }}>
            <LayoutGrid size={13} /> Calendar
          </button>
        </div>
      </div>

      {/* ── List View ── */}
      {view === 'list' && (
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>
              <Calendar size={40} color="#d1d5db" style={{ display: 'block', margin: '0 auto 12px' }} />
              <p style={{ margin: '0 0 16px' }}>No field visits scheduled</p>
              <button onClick={() => setShowForm(true)}
                style={{ padding: '9px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                Schedule First Visit
              </button>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['Customer / S/N', 'Address', 'Date & Time', 'Engineer', 'Type / Purpose', 'Priority', 'Status', 'Cost', 'Actions'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', fontSize: 12 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((v, i) => {
                  const sc = STATUS_COLOR[v?.status] || STATUS_COLOR.Scheduled;
                  const pc = PRIORITY_COLOR[v?.priority] || PRIORITY_COLOR.Normal;
                  const isOverdue = v?.status === 'Scheduled' && (v?.visit_date || '').slice(0, 10) < today;
                  return (
                    <tr key={v?.id ?? i} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                      <td style={{ padding: '10px 14px' }}>
                        <div style={{ fontWeight: 500, color: '#1f2937' }}>{v?.customer_name ?? '—'}</div>
                        {v?.serial_number && <div style={{ fontSize: 11, color: '#6366f1', fontFamily: 'monospace' }}>{v.serial_number}</div>}
                        {isOverdue && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: '#ef4444', fontWeight: 600, marginTop: 2 }}>
                            <AlertCircle size={10} /> Overdue
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '10px 14px', color: '#6b7280', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <MapPin size={11} color="#9ca3af" />{v?.address ?? '—'}
                        </div>
                      </td>
                      <td style={{ padding: '10px 14px', color: '#374151', whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Clock size={11} color="#9ca3af" />
                          {(v?.visit_date ?? '').slice(0, 10) || '—'}
                        </div>
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>{v?.visit_time ?? ''}</div>
                      </td>
                      <td style={{ padding: '10px 14px', color: '#374151' }}>{v?.engineer_name ?? 'Unassigned'}</td>
                      <td style={{ padding: '10px 14px', color: '#6b7280' }}>
                        {v?.visit_type && <div style={{ fontSize: 11, fontWeight: 600, color: '#6B3FDB', marginBottom: 2 }}>{v.visit_type}</div>}
                        <div style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v?.purpose ?? '—'}</div>
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <span style={{ background: pc.bg, color: pc.color, padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>
                          {v?.priority ?? 'Normal'}
                        </span>
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <span style={{ background: sc.bg, color: sc.color, padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>
                          {v?.status ?? 'Scheduled'}
                        </span>
                      </td>
                      <td style={{ padding: '10px 14px', color: '#374151', whiteSpace: 'nowrap' }}>
                        {(v?.cost ?? 0) > 0 ? `₹${parseFloat(v.cost).toLocaleString('en-IN')}` : '—'}
                        {(v?.labour_hours ?? 0) > 0 && <div style={{ fontSize: 11, color: '#9ca3af' }}>{v.labour_hours}h</div>}
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {v?.status === 'Scheduled' && (
                            <button onClick={() => updateStatus(v.id, 'In Progress')}
                              style={{ padding: '3px 8px', background: '#fef3c7', color: '#92400e', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>Start</button>
                          )}
                          {(v?.status === 'Scheduled' || v?.status === 'In Progress') && (
                            <button onClick={() => { setCompleting(v.id); setCompleteData(EMPTY_COMPLETE); }}
                              style={{ padding: '3px 8px', background: '#d1fae5', color: '#065f46', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>Complete</button>
                          )}
                          {v?.status === 'Scheduled' && (
                            <button onClick={() => updateStatus(v.id, 'Cancelled')}
                              style={{ padding: '3px 8px', background: '#fee2e2', color: '#991b1b', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>Cancel</button>
                          )}
                          {v?.status === 'Completed' && v?.work_done && (
                            <span title={v.work_done} style={{ cursor: 'help' }}>
                              <CheckCircle size={14} color="#10b981" />
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── Calendar View ── */}
      {view === 'calendar' && (
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 20 }}>
          {/* Month navigation */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <button onClick={prevMonth}
              style={{ padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
              <ChevronLeft size={16} color="#374151" />
            </button>
            <h2 style={{ fontSize: 15, fontWeight: 700, color: '#1f2937', margin: 0 }}>
              {MONTH_NAMES[calMonthNum - 1]} {calYear}
            </h2>
            <button onClick={nextMonth}
              style={{ padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
              <ChevronRight size={16} color="#374151" />
            </button>
          </div>

          {/* Day-of-week headers */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
            {DAY_NAMES.map(d => (
              <div key={d} style={{ textAlign: 'center', fontSize: 11, fontWeight: 600, color: '#9ca3af', padding: '4px 0' }}>{d}</div>
            ))}
          </div>

          {/* Calendar grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
            {/* Leading empty cells */}
            {Array.from({ length: firstWeekday }).map((_, i) => (
              <div key={`e-${i}`} style={{ minHeight: 80, background: '#fafafa', borderRadius: 6 }} />
            ))}
            {/* Day cells */}
            {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(day => {
              const dateStr  = `${calMonth}-${String(day).padStart(2, '0')}`;
              const dayVisits = visitsByDate[dateStr] || [];
              const isToday  = dateStr === today;
              return (
                <div key={day} style={{ minHeight: 80, padding: 4, borderRadius: 6, border: isToday ? '1.5px solid #6B3FDB' : '1px solid #f0f0f4', background: isToday ? '#faf5ff' : '#fff' }}>
                  <div style={{ fontSize: 12, fontWeight: isToday ? 700 : 400, color: isToday ? '#6B3FDB' : '#374151', marginBottom: 3 }}>{day}</div>
                  {dayVisits.slice(0, 3).map((v, idx) => {
                    const sc = STATUS_COLOR[v?.status] || STATUS_COLOR.Scheduled;
                    return (
                      <div key={idx}
                        title={`${v?.customer_name ?? '—'} — ${v?.purpose ?? '—'} (${v?.status ?? ''})\n${v?.engineer_name ? 'Eng: ' + v.engineer_name : ''}`}
                        style={{ background: sc.bg, color: sc.color, borderRadius: 4, padding: '1px 5px', fontSize: 10, fontWeight: 600, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'default' }}>
                        {v?.customer_name ?? '—'}
                      </div>
                    );
                  })}
                  {dayVisits.length > 3 && (
                    <div style={{ fontSize: 10, color: '#9ca3af', fontWeight: 500 }}>+{dayVisits.length - 3} more</div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Status legend */}
          <div style={{ display: 'flex', gap: 14, marginTop: 16, flexWrap: 'wrap' }}>
            {Object.entries(STATUS_COLOR).map(([s, c]) => (
              <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                <div style={{ width: 10, height: 10, borderRadius: 3, background: c.bg, border: `1px solid ${c.color}` }} />
                <span style={{ color: '#6b7280' }}>{s}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Schedule Visit Modal ── */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 560, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>Schedule Field Visit</h2>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={labelStyle}>Customer Name *</label>
                <input value={form.customer_name} onChange={e => setForm(p => ({ ...p, customer_name: e.target.value }))}
                  placeholder="Customer company name" style={inputStyle} />
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={labelStyle}>Site Address</label>
                <input value={form.address} onChange={e => setForm(p => ({ ...p, address: e.target.value }))}
                  placeholder="Full site address" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Visit Date *</label>
                <input type="date" value={form.visit_date} onChange={e => setForm(p => ({ ...p, visit_date: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Visit Time</label>
                <input type="time" value={form.visit_time} onChange={e => setForm(p => ({ ...p, visit_time: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Assigned Engineer</label>
                <select value={form.engineer_name} onChange={e => setForm(p => ({ ...p, engineer_name: e.target.value }))} style={inputStyle}>
                  <option value="">Unassigned</option>
                  {engineers.map(e => <option key={e.id} value={e.name}>{e.name}{e.specialization ? ` — ${e.specialization}` : ''}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Priority</label>
                <select value={form.priority} onChange={e => setForm(p => ({ ...p, priority: e.target.value }))} style={inputStyle}>
                  {['Normal', 'Low', 'Medium', 'High'].map(p => <option key={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Visit Type</label>
                <select value={form.visit_type} onChange={e => setForm(p => ({ ...p, visit_type: e.target.value }))} style={inputStyle}>
                  {['Service', 'AMC', 'Installation', 'Commissioning', 'Survey'].map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Serial Number</label>
                <input value={form.serial_number} onChange={e => setForm(p => ({ ...p, serial_number: e.target.value }))}
                  placeholder="e.g. MT-HVDC-001" style={inputStyle} />
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={labelStyle}>Purpose</label>
                <input value={form.purpose} onChange={e => setForm(p => ({ ...p, purpose: e.target.value }))}
                  placeholder="Installation, repair, preventive maintenance..." style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Ticket ID</label>
                <input value={form.ticket_id} onChange={e => setForm(p => ({ ...p, ticket_id: e.target.value }))}
                  placeholder="SD-001" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>AMC Contract ID</label>
                <input type="number" value={form.amc_contract_id} onChange={e => setForm(p => ({ ...p, amc_contract_id: e.target.value }))}
                  placeholder="Optional" style={inputStyle} />
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={labelStyle}>Notes</label>
                <textarea value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} rows={2}
                  placeholder="Special instructions..." style={{ ...inputStyle, resize: 'none' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => setShowForm(false)} style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleSave} disabled={saving || !form.customer_name || !form.visit_date}
                style={{ padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: (saving || !form.customer_name || !form.visit_date) ? 0.6 : 1 }}>
                {saving ? 'Scheduling...' : 'Schedule Visit'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Complete Visit Modal ── */}
      {completing && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 580, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>Complete Visit — Service Report</h2>
              <button onClick={() => setCompleting(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={labelStyle}>Work Done *</label>
                <textarea value={completeData.work_done} onChange={e => setCompleteData(d => ({ ...d, work_done: e.target.value }))}
                  rows={3} placeholder="Describe the work performed in detail..."
                  style={{ ...inputStyle, resize: 'vertical' }} />
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={labelStyle}>Resolution / Findings</label>
                <textarea value={completeData.resolution_notes} onChange={e => setCompleteData(d => ({ ...d, resolution_notes: e.target.value }))}
                  rows={2} placeholder="Root cause, findings, recommendations..."
                  style={{ ...inputStyle, resize: 'none' }} />
              </div>
              <div>
                <label style={labelStyle}>Actual Start Time</label>
                <input type="datetime-local" value={completeData.start_time_actual}
                  onChange={e => setCompleteData(d => ({ ...d, start_time_actual: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Actual End Time</label>
                <input type="datetime-local" value={completeData.end_time_actual}
                  onChange={e => setCompleteData(d => ({ ...d, end_time_actual: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Labour Hours</label>
                <input type="number" step="0.5" value={completeData.labour_hours}
                  onChange={e => setCompleteData(d => ({ ...d, labour_hours: e.target.value }))}
                  placeholder="0.0" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Travel (km)</label>
                <input type="number" value={completeData.travel_km}
                  onChange={e => setCompleteData(d => ({ ...d, travel_km: e.target.value }))}
                  placeholder="0" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Additional Cost (₹)</label>
                <input type="number" value={completeData.cost}
                  onChange={e => setCompleteData(d => ({ ...d, cost: e.target.value }))}
                  placeholder="0" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Customer Signature</label>
                <input value={completeData.customer_signature}
                  onChange={e => setCompleteData(d => ({ ...d, customer_signature: e.target.value }))}
                  placeholder="Signatory name" style={inputStyle} />
              </div>

              {/* Parts Used */}
              <div style={{ gridColumn: '1/-1' }}>
                <label style={labelStyle}>Parts / Spares Used</label>
                {completeData.parts_used.map((p, idx) => (
                  <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, padding: '6px 10px', background: '#f9fafb', borderRadius: 6 }}>
                    <span style={{ flex: 2, fontSize: 13 }}>{p.name}</span>
                    <span style={{ fontSize: 12, color: '#6b7280' }}>Qty: {p.qty}</span>
                    <span style={{ fontSize: 12, color: '#6b7280' }}>₹{p.unit_cost}/unit</span>
                    <button onClick={() => removePartLine(idx)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 0 }}>
                      <X size={14} />
                    </button>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <input value={partLine.name} onChange={e => setPartLine(p => ({ ...p, name: e.target.value }))}
                    placeholder="Part name" style={{ ...inputStyle, flex: 3 }} />
                  <input type="number" value={partLine.qty} onChange={e => setPartLine(p => ({ ...p, qty: e.target.value }))}
                    placeholder="Qty" min="1" style={{ ...inputStyle, flex: 1 }} />
                  <input type="number" value={partLine.unit_cost} onChange={e => setPartLine(p => ({ ...p, unit_cost: e.target.value }))}
                    placeholder="₹/unit" style={{ ...inputStyle, flex: 1 }} />
                  <button onClick={addPartLine}
                    style={{ padding: '9px 14px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }}>
                    + Add
                  </button>
                </div>
              </div>

              {completeData.parts_used.length > 0 && (
                <div style={{ gridColumn: '1/-1', background: '#f0fdf4', padding: '8px 12px', borderRadius: 8, fontSize: 13, color: '#065f46' }}>
                  Parts total: ₹{completeData.parts_used.reduce((s, p) => s + (parseFloat(p.qty) * parseFloat(p.unit_cost || 0)), 0).toLocaleString('en-IN')}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => setCompleting(null)} style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleComplete}
                style={{ padding: '9px 18px', background: '#10b981', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                Mark Complete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
