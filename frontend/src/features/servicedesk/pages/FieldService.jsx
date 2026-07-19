import { useState, useEffect, useRef } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { MapPin, Clock, Search, Calendar, CheckCircle, AlertCircle, TrendingUp, Plus, X } from 'lucide-react';

const STATUS_COLOR = {
  Open:          { bg: '#fef3c7', color: '#92400e' },
  'In Progress': { bg: '#dbeafe', color: '#1e40af' },
  Completed:     { bg: '#d1fae5', color: '#065f46' },
  Cancelled:     { bg: '#f3f4f6', color: '#6b7280' },
  Scheduled:     { bg: '#ede9fe', color: '#6B3FDB' },
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
  notes: '', visit_type: 'Service',
};

export default function FieldService() {
  const [visits,    setVisits]    = useState([]);
  const [engineers, setEngineers] = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [search,    setSearch]    = useState('');
  const [status,    setStatus]    = useState('All');
  const [showForm,  setShowForm]  = useState(false);
  const [form,      setForm]      = useState(EMPTY_FORM);
  const [saving,    setSaving]    = useState(false);
  const isMounted = useRef(true);
  const toast = useToast();

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const load = () => {
    setLoading(true);
    Promise.allSettled([
      api.get('/servicedesk/field-visits', { params: { limit: 200 } }),
      api.get('/servicedesk/engineers'),
    ]).then(([visitsRes, engRes]) => {
      if (!isMounted.current) return;
      setVisits(visitsRes.status === 'fulfilled' && Array.isArray(visitsRes.value?.data) ? visitsRes.value.data : []);
      setEngineers(engRes.status === 'fulfilled' ? (engRes.value?.data ?? []) : []);
    }).finally(() => { if (isMounted.current) setLoading(false); });
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    if (!form.customer_name || !form.visit_date) {
      toast.error('Customer name and visit date are required');
      return;
    }
    setSaving(true);
    try {
      await api.post('/servicedesk/field-visits', {
        ...form,
        ticket_id: form.ticket_id || null,
        status: 'Scheduled',
      });
      setShowForm(false);
      setForm(EMPTY_FORM);
      toast.success('Field visit scheduled');
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to save visit');
    } finally {
      if (isMounted.current) setSaving(false);
    }
  };

  const today = new Date().toISOString().slice(0, 10);
  const stats = {
    total:   visits.length,
    today:   visits.filter(v => (v?.visit_date || '').slice(0, 10) === today).length,
    pending: visits.filter(v => ['Open', 'Scheduled'].includes(v?.status)).length,
    done:    visits.filter(v => v?.status === 'Completed').length,
  };

  const filtered = visits?.filter(v => {
    const matchStatus = status === 'All' || v?.status === status;
    const matchSearch = !search || [v?.customer_name, v?.engineer_name, v?.address, v?.purpose].some(s => (s || '').toLowerCase().includes(search.toLowerCase()));
    return matchStatus && matchSearch;
  }) ?? [];

  const statCards = [
    { label: 'Total Visits',   value: stats.total,   icon: <TrendingUp size={16} color="#6B3FDB" />, bg: '#ede9fe', color: '#6B3FDB' },
    { label: "Today's Visits", value: stats.today,   icon: <Calendar size={16} color="#2563eb" />,   bg: '#dbeafe', color: '#2563eb' },
    { label: 'Pending',        value: stats.pending, icon: <AlertCircle size={16} color="#d97706" />, bg: '#fef3c7', color: '#d97706' },
    { label: 'Completed',      value: stats.done,    icon: <CheckCircle size={16} color="#059669" />, bg: '#d1fae5', color: '#059669' },
  ];

  const inputStyle = { width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
  const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 };

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Field Service</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>{filtered.length} field service visits</p>
        </div>
        <button onClick={() => setShowForm(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          <Plus size={15} /> Schedule Visit
        </button>
      </div>

      {/* Stats */}
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

      {/* Search + Status tabs */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search customer, engineer, purpose..."
            style={{ width: '100%', paddingLeft: 32, paddingRight: 12, paddingTop: 8, paddingBottom: 8, border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
        </div>
        {['All', 'Scheduled', 'In Progress', 'Completed', 'Cancelled'].map(s => (
          <button key={s} onClick={() => setStatus(s)}
            style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid', fontSize: 12, fontWeight: 500, cursor: 'pointer',
              borderColor: status === s ? '#6B3FDB' : '#e5e7eb',
              background:  status === s ? '#6B3FDB' : '#fff',
              color:       status === s ? '#fff'    : '#374151' }}>
            {s}
          </button>
        ))}
      </div>

      {/* Table */}
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>
            <MapPin size={36} color="#d1d5db" style={{ display: 'block', margin: '0 auto 12px' }} />
            <p style={{ margin: '0 0 16px' }}>No field service visits found.</p>
            <button onClick={() => setShowForm(true)}
              style={{ padding: '9px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              Schedule First Visit
            </button>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['#', 'Customer', 'Issue / Purpose', 'Assigned To', 'Scheduled Date', 'Priority', 'Status'].map(h => (
                  <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((v, i) => {
                const sc = STATUS_COLOR[v?.status] ?? STATUS_COLOR.Open;
                const pc = PRIORITY_COLOR[v?.priority] ?? PRIORITY_COLOR.Normal;
                const isAmc = ((v?.purpose ?? '') + (v?.notes ?? '')).toLowerCase().includes('amc')
                           || (v?.purpose ?? '').toLowerCase().includes('preventive');
                return (
                  <tr key={v?.id ?? i} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ padding: '10px 16px', fontWeight: 600, color: '#6B3FDB' }}>#{v?.id ?? i + 1}</td>
                    <td style={{ padding: '10px 16px' }}>
                      <div style={{ fontWeight: 500, color: '#1f2937' }}>{v?.customer_name ?? '—'}</div>
                      {v?.address && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                          <MapPin size={10} />{v.address}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '10px 16px', color: '#374151', maxWidth: 200 }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {v?.title ?? v?.subject ?? v?.purpose ?? '—'}
                      </div>
                      {isAmc && <span style={{ background: '#d1fae5', color: '#065f46', padding: '1px 6px', borderRadius: 10, fontSize: 10, fontWeight: 600 }}>AMC</span>}
                    </td>
                    <td style={{ padding: '10px 16px', color: '#6b7280' }}>{v?.engineer_name ?? v?.assigned_to_name ?? 'Unassigned'}</td>
                    <td style={{ padding: '10px 16px', color: '#374151', whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <Clock size={11} color="#9ca3af" />
                        {(v?.visit_date ?? v?.scheduled_date ?? v?.created_at ?? '').slice(0, 10) || '—'}
                        {v?.visit_time && <span style={{ color: '#9ca3af', fontSize: 11 }}>{v.visit_time}</span>}
                      </div>
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      <span style={{ background: pc.bg, color: pc.color, padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>
                        {v?.priority ?? 'Normal'}
                      </span>
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      <span style={{ background: sc.bg, color: sc.color, padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>
                        {v?.status ?? 'Open'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Schedule Visit Modal */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 560, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>Schedule Field Visit</h2>
              <button onClick={() => { setShowForm(false); setForm(EMPTY_FORM); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
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
                  {engineers.map(e => <option key={e.id} value={e.name}>{e.name}</option>)}
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
                <label style={labelStyle}>Ticket ID</label>
                <input value={form.ticket_id} onChange={e => setForm(p => ({ ...p, ticket_id: e.target.value }))}
                  placeholder="SD-001 (optional)" style={inputStyle} />
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={labelStyle}>Purpose</label>
                <input value={form.purpose} onChange={e => setForm(p => ({ ...p, purpose: e.target.value }))}
                  placeholder="Installation, repair, preventive maintenance..." style={inputStyle} />
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={labelStyle}>Notes</label>
                <textarea value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} rows={2}
                  placeholder="Special instructions..." style={{ ...inputStyle, resize: 'none' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => { setShowForm(false); setForm(EMPTY_FORM); }}
                style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>
                Cancel
              </button>
              <button onClick={handleSave} disabled={saving || !form.customer_name || !form.visit_date}
                style={{ padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                  opacity: (saving || !form.customer_name || !form.visit_date) ? 0.6 : 1 }}>
                {saving ? 'Scheduling...' : 'Schedule Visit'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
