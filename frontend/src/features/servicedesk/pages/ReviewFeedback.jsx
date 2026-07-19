import { useState, useEffect, useCallback, useMemo } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import { Search, Star, MessageSquare, Package, Wrench, Clock, CheckCircle, ChevronUp, ChevronDown, Plus, X } from 'lucide-react';

const STAR_COLOR = { 5: '#22c55e', 4: '#84cc16', 3: '#f59e0b', 2: '#f97316', 1: '#ef4444' };

function StarRating({ rating }) {
  const r = Number(rating ?? 0);
  if (!r) return <span style={{ color: '#d1d5db' }}>—</span>;
  return (
    <div style={{ display: 'flex', gap: 2 }} title={`${r} / 5`}>
      {[1, 2, 3, 4, 5].map(n => (
        <Star key={n} size={14} fill={n <= r ? STAR_COLOR[r] : 'none'}
          color={n <= r ? STAR_COLOR[r] : '#d1d5db'}/>
      ))}
    </div>
  );
}

// Interactive 1-5 star picker for the capture form.
function StarPicker({ value, onChange }) {
  const [hover, setHover] = useState(0);
  const active = hover || value;
  return (
    <div style={{ display: 'flex', gap: 4 }} onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map(n => (
        <Star key={n} size={26} style={{ cursor: 'pointer' }}
          onMouseEnter={() => setHover(n)} onClick={() => onChange(n === value ? null : n)}
          fill={n <= active ? (STAR_COLOR[active] || '#f59e0b') : 'none'}
          color={n <= active ? (STAR_COLOR[active] || '#f59e0b') : '#d1d5db'}/>
      ))}
    </div>
  );
}

// Tri-state Yes/No selector (null = not set).
function YesNoPicker({ value, onChange }) {
  const opt = (val, label, onBg, onFg) => {
    const on = value === val;
    return (
      <button type="button" onClick={() => onChange(on ? null : val)}
        style={{ padding: '7px 18px', borderRadius: 8, border: '1px solid', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          borderColor: on ? onBg : '#e5e7eb', background: on ? onBg : '#fff', color: on ? onFg : '#374151' }}>
        {label}
      </button>
    );
  };
  return <div style={{ display: 'flex', gap: 8 }}>{opt(true, 'Yes', '#059669', '#fff')}{opt(false, 'No', '#dc2626', '#fff')}</div>;
}

function YesNo({ value }) {
  if (value === null || value === undefined) return <span style={{ color: '#9ca3af' }}>—</span>;
  const yes = Boolean(value);
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 9999, fontSize: 11, fontWeight: 700,
      background: yes ? '#d1fae5' : '#fee2e2', color: yes ? '#065f46' : '#991b1b',
    }}>{yes ? 'Yes' : 'No'}</span>
  );
}

// KPI tile — value is pre-computed live on the server.
function Kpi({ icon: Icon, label, value, suffix, tint }) {
  return (
    <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 30, height: 30, borderRadius: 8, background: tint.bg, color: tint.fg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon size={16}/>
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</span>
      </div>
      <div style={{ fontSize: 30, fontWeight: 800, color: '#1f2937', lineHeight: 1 }}>
        {value == null ? '—' : value}{value != null && suffix ? <span style={{ fontSize: 16, color: '#9ca3af', fontWeight: 600 }}>{suffix}</span> : null}
      </div>
    </div>
  );
}

const COLUMNS = [
  { key: 'complaint_number', label: 'Complaint No' },
  { key: 'customer_name',    label: 'Customer' },
  { key: 'product_rating',   label: 'Product' },
  { key: 'engineer_rating',  label: 'Engineer' },
  { key: 'visited_on_time',  label: 'On Time' },
  { key: 'resolved',         label: 'Resolved' },
  { key: 'feedback',         label: 'Comments' },
  { key: 'responded_at',     label: 'Date' },
];

const EMPTY_FORM = {
  customer_name: '', complaint_id: '', complaint_number: '', agent_name: '',
  product_rating: null, engineer_rating: null, visited_on_time: null, resolved: null, feedback: '',
};

export default function ReviewFeedback({ setPage }) {
  const toast = useToast();
  const [items,   setItems]   = useState([]);
  const [kpis,    setKpis]    = useState(null);
  const [engineers, setEngineers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search,  setSearch]  = useState('');
  const [from,    setFrom]    = useState('');
  const [to,      setTo]      = useState('');
  const [engineer, setEngineer] = useState('');
  const [pageSize, setPageSize] = useState(25);
  const [sort,    setSort]    = useState({ key: 'responded_at', dir: 'desc' });

  // Capture form
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [complaintQ, setComplaintQ] = useState('');
  const [complaintOpts, setComplaintOpts] = useState([]);
  const setF = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const load = useCallback(() => {
    setLoading(true);
    const params = { limit: pageSize };
    if (from) params.from = from;
    if (to) params.to = to;
    if (engineer) params.engineer = engineer;
    Promise.allSettled([
      api.get('/servicedesk/feedback', { params }),
      api.get('/servicedesk/feedback/kpis', { params: { from: from || undefined, to: to || undefined, engineer: engineer || undefined } }),
    ]).then(([list, k]) => {
      setItems(list.status === 'fulfilled' && Array.isArray(list.value.data) ? list.value.data : []);
      setKpis(k.status === 'fulfilled' ? k.value.data : null);
    }).finally(() => setLoading(false));
  }, [pageSize, from, to, engineer]);

  useEffect(() => { load(); }, [load]);

  // Engineer filter options load once.
  useEffect(() => {
    api.get('/servicedesk/feedback/engineers')
      .then(r => setEngineers(Array.isArray(r.data) ? r.data : []))
      .catch(() => setEngineers([]));
  }, []);

  // Complaint picker — debounced lookup while the form is open.
  useEffect(() => {
    if (!showForm) return;
    const t = setTimeout(() => {
      api.get('/servicedesk/feedback/complaints', { params: complaintQ ? { q: complaintQ } : {} })
        .then(r => setComplaintOpts(Array.isArray(r.data) ? r.data : []))
        .catch(() => setComplaintOpts([]));
    }, 250);
    return () => clearTimeout(t);
  }, [showForm, complaintQ]);

  const openForm = () => { setForm(EMPTY_FORM); setComplaintQ(''); setShowForm(true); };

  const pickComplaint = (id) => {
    const c = complaintOpts.find(o => String(o.id) === String(id));
    setForm(p => ({
      ...p,
      complaint_id: id || '',
      complaint_number: c?.complaint_number || '',
      customer_name: p.customer_name || c?.customer_name || '',
    }));
  };

  const submit = async () => {
    if (!form.product_rating && !form.engineer_rating) {
      return toast.error('Enter a product or engineer rating');
    }
    setSaving(true);
    try {
      await api.post('/servicedesk/feedback', {
        customer_name: form.customer_name || null,
        complaint_id: form.complaint_id || null,
        ticket_subject: form.complaint_number || null,
        agent_name: form.agent_name || null,
        product_rating: form.product_rating,
        engineer_rating: form.engineer_rating,
        visited_on_time: form.visited_on_time,
        resolved: form.resolved,
        feedback: form.feedback || null,
      });
      toast.success('Feedback recorded');
      setShowForm(false);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save feedback');
    } finally { setSaving(false); }
  };

  const toggleSort = (key) => setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = items.filter(f => !q || [f.complaint_number, f.customer_name, f.feedback, f.agent_name, f.ticket_subject]
      .some(v => (v || '').toLowerCase().includes(q)));
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      let av = a[sort.key], bv = b[sort.key];
      if (av === null || av === undefined) return 1;   // nulls last
      if (bv === null || bv === undefined) return -1;
      if (sort.key === 'responded_at') { av = new Date(av).getTime(); bv = new Date(bv).getTime(); }
      if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir;
      return (av > bv ? 1 : av < bv ? -1 : 0) * dir;
    });
  }, [items, search, sort]);

  const openComplaint = (id) => { if (id && setPage) setPage('ComplaintDetail', { id }); };

  const td = { padding: '10px 16px', borderBottom: '1px solid #f9fafb' };

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Customer Feedback</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>Product & engineer ratings captured after service closure — IPCS → IPS → Feedback</p>
        </div>
        <button onClick={openForm}
          style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          <Plus size={15}/> Log Feedback
        </button>
      </div>

      {/* KPI cards — computed live server-side, filter-aware */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 20 }}>
        <Kpi icon={Package} label="Avg Product Rating" value={kpis?.avg_product_rating ?? null} suffix=" / 5" tint={{ bg: '#ede9fe', fg: '#6B3FDB' }}/>
        <Kpi icon={Wrench} label="Avg Engineer Rating" value={kpis?.avg_engineer_rating ?? null} suffix=" / 5" tint={{ bg: '#dbeafe', fg: '#2563eb' }}/>
        <Kpi icon={Clock} label="On-Time Visits" value={kpis?.on_time_pct ?? null} suffix="%" tint={{ bg: '#fef3c7', fg: '#d97706' }}/>
        <Kpi icon={CheckCircle} label="Resolved Satisfaction" value={kpis?.resolved_pct ?? null} suffix="%" tint={{ bg: '#d1fae5', fg: '#059669' }}/>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }}/>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search complaint, customer, comments, engineer..."
            style={{ width: '100%', paddingLeft: 32, paddingRight: 12, paddingTop: 8, paddingBottom: 8, border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }}/>
        </div>
        <label style={{ fontSize: 12, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 6 }}>From
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '7px 10px', fontSize: 13 }}/>
        </label>
        <label style={{ fontSize: 12, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 6 }}>To
          <input type="date" value={to} onChange={e => setTo(e.target.value)} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '7px 10px', fontSize: 13 }}/>
        </label>
        <select value={engineer} onChange={e => setEngineer(e.target.value)} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '7px 10px', fontSize: 13, background: '#fff' }}>
          <option value="">All engineers</option>
          {engineers.map(en => <option key={en} value={en}>{en}</option>)}
        </select>
        <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '7px 10px', fontSize: 13, background: '#fff' }}>
          {[10, 25, 50, 100].map(n => <option key={n} value={n}>{n} / page</option>)}
        </select>
      </div>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>
            <MessageSquare size={36} color="#d1d5db" style={{ display: 'block', margin: '0 auto 12px' }}/>
            <p style={{ margin: 0, fontWeight: 500 }}>No feedback responses yet</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {COLUMNS.map(c => {
                    const on = sort.key === c.key;
                    return (
                      <th key={c.key} onClick={() => toggleSort(c.key)}
                        style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          {c.label}
                          {on && (sort.dir === 'asc' ? <ChevronUp size={13}/> : <ChevronDown size={13}/>)}
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {filtered.map((f, i) => (
                  <tr key={f.id} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={td}>
                      {f.complaint_number ? (
                        <button onClick={() => openComplaint(f.complaint_id)}
                          style={{ background: 'none', border: 'none', padding: 0, color: '#6B3FDB', fontWeight: 600, cursor: setPage ? 'pointer' : 'default', textDecoration: setPage ? 'underline' : 'none', fontSize: 13 }}>
                          {f.complaint_number}
                        </button>
                      ) : <span style={{ color: '#9ca3af' }}>—</span>}
                    </td>
                    <td style={{ ...td, color: '#1f2937' }}>{f.customer_name || '—'}</td>
                    <td style={td}><StarRating rating={f.product_rating}/></td>
                    <td style={td}><StarRating rating={f.engineer_rating}/></td>
                    <td style={td}><YesNo value={f.visited_on_time}/></td>
                    <td style={td}><YesNo value={f.resolved}/></td>
                    <td style={{ ...td, color: '#6b7280', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.feedback || ''}>{f.feedback || ''}</td>
                    <td style={{ ...td, color: '#9ca3af', whiteSpace: 'nowrap' }}>{fmtDate(f.responded_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Log Feedback modal */}
      {showForm && (
        <>
          <div onClick={() => setShowForm(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 900 }}/>
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: '#fff', borderRadius: 16, padding: 26, width: 560, maxHeight: '92vh', overflowY: 'auto', zIndex: 901 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
              <div>
                <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0, color: '#1f2937' }}>Log Customer Feedback</h2>
                <p style={{ fontSize: 12, color: '#9ca3af', margin: '2px 0 0' }}>Captured from the customer after service closure</p>
              </div>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><X size={18}/></button>
            </div>

            {/* Complaint link */}
            <label style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '.04em' }}>Link to Complaint (IPCS)</label>
            <input value={complaintQ} onChange={e => setComplaintQ(e.target.value)} placeholder="Search complaint no. or customer..."
              style={{ width: '100%', margin: '6px 0 8px', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }}/>
            <select value={form.complaint_id} onChange={e => pickComplaint(e.target.value)}
              style={{ width: '100%', marginBottom: 16, padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: '#fff' }}>
              <option value="">Not linked</option>
              {complaintOpts.map(c => (
                <option key={c.id} value={c.id}>{c.complaint_number} — {c.customer_name || 'Unknown'}{c.status ? ` (${c.status})` : ''}</option>
              ))}
            </select>

            {/* Customer + engineer */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '.04em' }}>Customer</label>
                <input value={form.customer_name} onChange={e => setF('customer_name', e.target.value)}
                  style={{ width: '100%', marginTop: 6, padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }}/>
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '.04em' }}>Engineer</label>
                <input value={form.agent_name} onChange={e => setF('agent_name', e.target.value)}
                  style={{ width: '100%', marginTop: 6, padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }}/>
              </div>
            </div>

            {/* Ratings */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '.04em', display: 'block', marginBottom: 8 }}>Product Rating</label>
                <StarPicker value={form.product_rating} onChange={v => setF('product_rating', v)}/>
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '.04em', display: 'block', marginBottom: 8 }}>Engineer Rating</label>
                <StarPicker value={form.engineer_rating} onChange={v => setF('engineer_rating', v)}/>
              </div>
            </div>

            {/* On-time + resolved */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '.04em', display: 'block', marginBottom: 8 }}>Visited On Time?</label>
                <YesNoPicker value={form.visited_on_time} onChange={v => setF('visited_on_time', v)}/>
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '.04em', display: 'block', marginBottom: 8 }}>Issue Resolved?</label>
                <YesNoPicker value={form.resolved} onChange={v => setF('resolved', v)}/>
              </div>
            </div>

            {/* Comments */}
            <label style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '.04em' }}>Comments</label>
            <textarea value={form.feedback} onChange={e => setF('feedback', e.target.value)} rows={3}
              style={{ width: '100%', marginTop: 6, padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box', resize: 'vertical' }}/>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
              <button onClick={() => setShowForm(false)} disabled={saving}
                style={{ padding: '9px 18px', border: '1px solid #e5e7eb', background: '#fff', borderRadius: 8, fontSize: 13, fontWeight: 600, color: '#374151', cursor: 'pointer' }}>Cancel</button>
              <button onClick={submit} disabled={saving}
                style={{ padding: '9px 18px', border: 'none', background: saving ? '#a78bda' : '#6B3FDB', color: '#fff', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: saving ? 'default' : 'pointer' }}>
                {saving ? 'Saving...' : 'Save Feedback'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
