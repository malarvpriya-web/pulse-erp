import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Plus, X, Search, MapPin, Calendar, Users, CheckSquare, Clock, Eye } from 'lucide-react';

const VISIT_TYPES = ['Customer Visit','Site Visit','Service Visit','Commissioning Visit','Review Meeting','FAT Witness','Warranty Inspection'];

const EMPTY = {
  visit_type: 'Customer Visit',
  customer_name: '', project_number: '', site_name: '',
  opportunity_ref: '', visited_by: '',
  visit_date: '', purpose: '', discussion_notes: '',
  location: '', photos_drive_link: '', visit_report: '',
  next_followup_date: '', next_followup_notes: '',
  action_items: [],
};

const STATUS_COLORS = {
  Submitted: { bg:'#eff6ff', color:'#1d4ed8' },
  Completed: { bg:'#f0fdf4', color:'#15803d' },
  Draft:     { bg:'#fafafa', color:'#6b7280' },
  Reviewed:  { bg:'#f5f3ff', color:'#6B3FDB' },
};

const fmtDate = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

export default function CustomerVisits() {
  const toast = useToast();
  const [visits, setVisits] = useState([]);
  const [stats, setStats] = useState({ total:0, this_month:0, open_actions:0, upcoming_followups:0 });
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('All');
  const [selected, setSelected] = useState(null);
  const [newAction, setNewAction] = useState('');

  const load = () => {
    setLoading(true);
    Promise.allSettled([
      api.get('/customer-visits'),
      api.get('/customer-visits/summary/stats'),
    ]).then(([visRes, statRes]) => {
      setVisits(visRes.status === 'fulfilled' ? (visRes.value?.data || []) : []);
      if (statRes.status === 'fulfilled') setStats(statRes.value?.data || {});
    }).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const fld = (key, val) => setForm(p => ({ ...p, [key]: val }));

  const addActionItem = () => {
    if (!newAction.trim()) return;
    setForm(p => ({ ...p, action_items: [...p.action_items, { action: newAction.trim(), owner: '', due_date: '' }] }));
    setNewAction('');
  };
  const removeAction = idx => setForm(p => ({ ...p, action_items: p.action_items.filter((_,i) => i !== idx) }));
  const updateAction = (idx, key, val) => setForm(p => ({
    ...p,
    action_items: p.action_items.map((ai, i) => i === idx ? { ...ai, [key]: val } : ai),
  }));

  const handleSave = async () => {
    if (!form.visit_date || !form.customer_name) {
      toast.error('Customer Name and Visit Date are required.'); return;
    }
    setSaving(true);
    try {
      await api.post('/customer-visits', form);
      setShowForm(false); setForm(EMPTY); load();
      toast.success('Visit recorded successfully');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  };

  const filtered = visits.filter(v => {
    const matchType = typeFilter === 'All' || v.visit_type === typeFilter;
    const matchSearch = !search || [v.customer_name, v.project_number, v.site_name, v.purpose, v.visited_by_name]
      .some(x => (x||'').toLowerCase().includes(search.toLowerCase()));
    return matchType && matchSearch;
  });

  const inputStyle = { width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' };
  const labelStyle = { display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:5 };

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Customer Visits</h1>
          <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>Track site visits, service visits, commissioning & review meetings</p>
        </div>
        <button onClick={() => setShowForm(true)}
          style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
          <Plus size={15}/> Log Visit
        </button>
      </div>

      {/* KPI Cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:14, marginBottom:20 }}>
        {[
          { label:'Total Visits', value: stats.total, icon: MapPin, color:'#6366f1' },
          { label:'This Month', value: stats.this_month, icon: Calendar, color:'#10b981' },
          { label:'Open Action Items', value: stats.open_actions, icon: CheckSquare, color:'#f59e0b' },
          { label:'Follow-ups Due (7d)', value: stats.upcoming_followups, icon: Clock, color:'#ef4444' },
        ].map(k => (
          <div key={k.label} style={{ background:'#fff', borderRadius:12, padding:20, border:'1px solid #f0f0f4' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
              <div>
                <p style={{ fontSize:12, color:'#9ca3af', margin:'0 0 8px', fontWeight:500, textTransform:'uppercase' }}>{k.label}</p>
                <p style={{ fontSize:28, fontWeight:700, color:'#1f2937', margin:0 }}>{k.value ?? 0}</p>
              </div>
              <div style={{ background:k.color+'18', borderRadius:10, padding:10 }}>
                <k.icon size={20} color={k.color}/>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display:'flex', gap:12, marginBottom:20, flexWrap:'wrap' }}>
        <div style={{ position:'relative', flex:1, minWidth:200 }}>
          <Search size={14} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }}/>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search customer, project, site..."
            style={{ width:'100%', paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8, border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
        </div>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
          style={{ padding:'7px 14px', borderRadius:8, border:'1px solid #e5e7eb', fontSize:12, outline:'none' }}>
          <option value="All">All Types</option>
          {VISIT_TYPES.map(t => <option key={t}>{t}</option>)}
        </select>
      </div>

      {/* Visit Cards */}
      {loading ? (
        <div style={{ textAlign:'center', padding:60, color:'#9ca3af' }}>Loading...</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign:'center', padding:60, color:'#9ca3af' }}>No visits found. Log your first visit!</div>
      ) : (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(340px,1fr))', gap:16 }}>
          {filtered.map(v => {
            const sc = STATUS_COLORS[v.status] || { bg:'#fafafa', color:'#6b7280' };
            return (
              <div key={v.id} style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:20, cursor:'pointer', transition:'box-shadow 0.15s' }}
                   onClick={() => setSelected(v)}
                   onMouseEnter={e => e.currentTarget.style.boxShadow='0 4px 12px rgba(0,0,0,.08)'}
                   onMouseLeave={e => e.currentTarget.style.boxShadow='none'}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:12 }}>
                  <div>
                    <span style={{ background:'#f5f3ff', color:'#6B3FDB', padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:600 }}>{v.visit_type}</span>
                  </div>
                  <span style={{ background:sc.bg, color:sc.color, padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:600 }}>{v.status}</span>
                </div>
                <h3 style={{ fontSize:15, fontWeight:700, color:'#1f2937', margin:'0 0 4px' }}>{v.customer_name || 'Unknown Customer'}</h3>
                {v.project_number && <div style={{ fontSize:12, color:'#6B3FDB', marginBottom:4 }}>{v.project_number}</div>}
                {v.site_name && (
                  <div style={{ display:'flex', alignItems:'center', gap:4, fontSize:12, color:'#6b7280', marginBottom:8 }}>
                    <MapPin size={11}/> {v.site_name}
                  </div>
                )}
                {v.purpose && <div style={{ fontSize:12, color:'#6b7280', marginBottom:12, lineHeight:1.4 }}>{v.purpose}</div>}
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', borderTop:'1px solid #f0f0f4', paddingTop:10 }}>
                  <div style={{ fontSize:12, color:'#374151', fontWeight:500 }}>
                    <Calendar size={11} style={{ verticalAlign:'middle', marginRight:4 }}/>{fmtDate(v.visit_date)}
                  </div>
                  {v.visited_by_name && (
                    <div style={{ fontSize:11, color:'#9ca3af' }}>
                      <Users size={11} style={{ verticalAlign:'middle', marginRight:3 }}/>{v.visited_by_name}
                    </div>
                  )}
                </div>
                {v.next_followup_date && (
                  <div style={{ marginTop:8, padding:'6px 10px', background:'#fffbeb', borderRadius:6, fontSize:11, color:'#92400e' }}>
                    Follow-up: {fmtDate(v.next_followup_date)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Detail Modal */}
      {selected && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}
             onClick={e => { if (e.target === e.currentTarget) setSelected(null); }}>
          <div style={{ background:'#fff', borderRadius:16, padding:32, width:660, maxHeight:'90vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <h2 style={{ fontSize:18, fontWeight:700, color:'#1f2937', margin:0 }}>{selected.visit_type}</h2>
              <button onClick={() => setSelected(null)} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, fontSize:13, marginBottom:16 }}>
              {[
                ['Customer', selected.customer_name],
                ['Visit Date', fmtDate(selected.visit_date)],
                ['Project #', selected.project_number],
                ['Site', selected.site_name],
                ['Visited By', selected.visited_by_name],
                ['Department', selected.department],
                ['Location', selected.location],
                ['Opportunity Ref', selected.opportunity_ref],
                ['Next Follow-up', fmtDate(selected.next_followup_date)],
              ].filter(([,v]) => v).map(([lbl, val]) => (
                <div key={lbl}>
                  <div style={{ fontSize:11, color:'#9ca3af', fontWeight:600, textTransform:'uppercase', marginBottom:2 }}>{lbl}</div>
                  <div style={{ fontWeight:500, color:'#1f2937' }}>{val}</div>
                </div>
              ))}
            </div>
            {selected.purpose && (
              <div style={{ marginBottom:12, padding:12, background:'#f9fafb', borderRadius:8 }}>
                <div style={{ fontSize:11, color:'#9ca3af', fontWeight:600, marginBottom:4 }}>PURPOSE</div>
                <div style={{ fontSize:13, color:'#374151' }}>{selected.purpose}</div>
              </div>
            )}
            {selected.discussion_notes && (
              <div style={{ marginBottom:12, padding:12, background:'#f5f3ff', borderRadius:8 }}>
                <div style={{ fontSize:11, color:'#6B3FDB', fontWeight:600, marginBottom:4 }}>DISCUSSION NOTES</div>
                <div style={{ fontSize:13, color:'#374151', whiteSpace:'pre-line' }}>{selected.discussion_notes}</div>
              </div>
            )}
            {selected.visit_report && (
              <div style={{ marginBottom:12, padding:12, background:'#f0fdf4', borderRadius:8 }}>
                <div style={{ fontSize:11, color:'#15803d', fontWeight:600, marginBottom:4 }}>VISIT REPORT</div>
                <div style={{ fontSize:13, color:'#374151', whiteSpace:'pre-line' }}>{selected.visit_report}</div>
              </div>
            )}
            {selected.photos_drive_link && (
              <a href={selected.photos_drive_link} target="_blank" rel="noopener noreferrer"
                style={{ display:'inline-block', marginBottom:12, fontSize:13, color:'#6366f1', textDecoration:'none' }}>
                View Photos on Drive →
              </a>
            )}
          </div>
        </div>
      )}

      {/* Log Visit Modal */}
      {showForm && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:'#fff', borderRadius:16, padding:32, width:720, maxHeight:'93vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
              <h2 style={{ fontSize:18, fontWeight:700, color:'#1f2937', margin:0 }}>Log Customer Visit</h2>
              <button onClick={() => { setShowForm(false); setForm(EMPTY); }} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
            </div>

            <div style={{ fontSize:12, fontWeight:700, color:'#6B3FDB', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:12 }}>Visit Info</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:20 }}>
              <div>
                <label style={labelStyle}>Visit Type</label>
                <select value={form.visit_type} onChange={e => fld('visit_type', e.target.value)} style={inputStyle}>
                  {VISIT_TYPES.map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Visit Date *</label>
                <input type="date" value={form.visit_date} onChange={e => fld('visit_date', e.target.value)} style={inputStyle}/>
              </div>
              <div>
                <label style={labelStyle}>Customer Name *</label>
                <input value={form.customer_name} onChange={e => fld('customer_name', e.target.value)} placeholder="Customer" style={inputStyle}/>
              </div>
              <div>
                <label style={labelStyle}>Project Number</label>
                <input value={form.project_number} onChange={e => fld('project_number', e.target.value)} placeholder="PRJ-2026-0001" style={inputStyle}/>
              </div>
              <div>
                <label style={labelStyle}>Site Name</label>
                <input value={form.site_name} onChange={e => fld('site_name', e.target.value)} placeholder="Site or location" style={inputStyle}/>
              </div>
              <div>
                <label style={labelStyle}>Opportunity Ref</label>
                <input value={form.opportunity_ref} onChange={e => fld('opportunity_ref', e.target.value)} placeholder="Opportunity reference" style={inputStyle}/>
              </div>
              <div style={{ gridColumn:'1/-1' }}>
                <label style={labelStyle}>Physical Location / Address</label>
                <input value={form.location} onChange={e => fld('location', e.target.value)} placeholder="Full address of visit" style={inputStyle}/>
              </div>
            </div>

            <div style={{ fontSize:12, fontWeight:700, color:'#6B3FDB', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:12 }}>Notes & Report</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr', gap:16, marginBottom:20 }}>
              <div>
                <label style={labelStyle}>Purpose</label>
                <input value={form.purpose} onChange={e => fld('purpose', e.target.value)} placeholder="Purpose of visit" style={inputStyle}/>
              </div>
              <div>
                <label style={labelStyle}>Discussion Notes</label>
                <textarea value={form.discussion_notes} onChange={e => fld('discussion_notes', e.target.value)} rows={4}
                  placeholder="Key discussion points, decisions, client feedback..."
                  style={{ ...inputStyle, resize:'vertical' }}/>
              </div>
              <div>
                <label style={labelStyle}>Visit Report</label>
                <textarea value={form.visit_report} onChange={e => fld('visit_report', e.target.value)} rows={3}
                  placeholder="Summary report to be shared with management..."
                  style={{ ...inputStyle, resize:'vertical' }}/>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
                <div>
                  <label style={labelStyle}>Photos (Google Drive Link)</label>
                  <input value={form.photos_drive_link} onChange={e => fld('photos_drive_link', e.target.value)}
                    placeholder="https://drive.google.com/..." style={inputStyle}/>
                </div>
                <div>
                  <label style={labelStyle}>Next Follow-up Date</label>
                  <input type="date" value={form.next_followup_date} onChange={e => fld('next_followup_date', e.target.value)} style={inputStyle}/>
                </div>
                <div style={{ gridColumn:'1/-1' }}>
                  <label style={labelStyle}>Follow-up Notes</label>
                  <input value={form.next_followup_notes} onChange={e => fld('next_followup_notes', e.target.value)}
                    placeholder="What needs to be followed up..." style={inputStyle}/>
                </div>
              </div>
            </div>

            {/* Action Items */}
            <div style={{ fontSize:12, fontWeight:700, color:'#6B3FDB', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:12 }}>Action Items</div>
            {form.action_items.map((ai, idx) => (
              <div key={idx} style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr auto', gap:8, marginBottom:8, alignItems:'center' }}>
                <input value={ai.action} onChange={e => updateAction(idx, 'action', e.target.value)} placeholder="Action" style={inputStyle}/>
                <input value={ai.owner} onChange={e => updateAction(idx, 'owner', e.target.value)} placeholder="Owner" style={inputStyle}/>
                <input type="date" value={ai.due_date} onChange={e => updateAction(idx, 'due_date', e.target.value)} style={inputStyle}/>
                <button onClick={() => removeAction(idx)} style={{ background:'none', border:'none', cursor:'pointer', color:'#ef4444', padding:4 }}><X size={16}/></button>
              </div>
            ))}
            <div style={{ display:'flex', gap:8, marginBottom:20 }}>
              <input value={newAction} onChange={e => setNewAction(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addActionItem(); }}}
                placeholder="+ New action item (press Enter)"
                style={{ ...inputStyle, flex:1 }}/>
              <button onClick={addActionItem}
                style={{ padding:'9px 16px', background:'#f5f3ff', color:'#6B3FDB', border:'1px solid #e9e4ff', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600, whiteSpace:'nowrap' }}>
                Add
              </button>
            </div>

            <div style={{ display:'flex', gap:12, justifyContent:'flex-end' }}>
              <button onClick={() => { setShowForm(false); setForm(EMPTY); }}
                style={{ padding:'9px 20px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13, color:'#374151' }}>Cancel</button>
              <button onClick={handleSave} disabled={saving}
                style={{ padding:'9px 20px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600, opacity:saving?0.6:1 }}>
                {saving ? 'Saving...' : 'Save Visit'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
