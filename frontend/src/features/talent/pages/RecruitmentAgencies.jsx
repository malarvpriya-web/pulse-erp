import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import {
  Plus, Building, X, Phone, Mail, Globe, Search,
  Users, TrendingUp, Calendar, ChevronRight, Pencil,
  ToggleLeft, ToggleRight, Trash2, Tag,
} from 'lucide-react';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const EMPTY_FORM = {
  name: '', contact_person: '', email: '', phone: '', website: '',
  specializations: [], fee_percentage: '', payment_terms: '',
  agreement_start: '', agreement_end: '', notes: '', city: '',
  is_active: true,
};

const DIFF_COLORS = {
  active:   { bg: '#dcfce7', color: '#15803d' },
  inactive: { bg: '#fee2e2', color: '#b91c1c' },
};

const fmtDate = (d) => {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }); }
  catch { return d; }
};

const isExpired = (end) => end && new Date(end) < new Date();

// ── Tag input ─────────────────────────────────────────────────────────────────
function TagInput({ value, onChange }) {
  const [input, setInput] = useState('');
  const tags = Array.isArray(value) ? value : [];

  const add = () => {
    const t = input.trim();
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setInput('');
  };
  const remove = (t) => onChange(tags.filter(x => x !== t));

  return (
    <div style={{ border:'1px solid #e5e7eb', borderRadius:8, padding:'6px 10px', minHeight:40 }}>
      <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginBottom: tags.length ? 6 : 0 }}>
        {tags.map(t => (
          <span key={t} style={{ display:'flex', alignItems:'center', gap:3, background:'#ede9fe', color:'#6B3FDB', borderRadius:20, padding:'2px 8px', fontSize:11, fontWeight:500 }}>
            {t}
            <button onClick={() => remove(t)} style={{ background:'none', border:'none', cursor:'pointer', color:'#6B3FDB', padding:0, lineHeight:1 }}>×</button>
          </span>
        ))}
      </div>
      <div style={{ display:'flex', gap:6 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }}
          placeholder="Add specialization, press Enter"
          style={{ flex:1, border:'none', outline:'none', fontSize:12, background:'transparent' }}
        />
        {input.trim() && (
          <button onClick={add} style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:6, padding:'2px 8px', fontSize:11, cursor:'pointer' }}>Add</button>
        )}
      </div>
    </div>
  );
}

// ── Agency modal ──────────────────────────────────────────────────────────────
function AgencyModal({ agency, onClose, onSaved }) {
  const toast = useToast();
  const isEdit = !!agency?.id;
  const [form, setForm] = useState(
    isEdit
      ? {
          name:            agency.name || '',
          contact_person:  agency.contact_person || '',
          email:           agency.email || '',
          phone:           agency.phone || '',
          website:         agency.website || '',
          specializations: agency.specializations || [],
          fee_percentage:  agency.fee_percentage ?? '',
          payment_terms:   agency.payment_terms || '',
          agreement_start: agency.agreement_start ? agency.agreement_start.slice(0, 10) : '',
          agreement_end:   agency.agreement_end   ? agency.agreement_end.slice(0, 10)   : '',
          notes:           agency.notes || '',
          city:            agency.city || '',
          is_active:       agency.is_active !== false,
        }
      : { ...EMPTY_FORM }
  );
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const handleSave = async () => {
    if (!form.name.trim()) return toast.error('Agency name is required');
    setSaving(true);
    try {
      const payload = {
        ...form,
        fee_percentage: form.fee_percentage !== '' ? parseFloat(form.fee_percentage) : null,
      };
      if (isEdit) {
        await api.put(`/talent/agencies/${agency.id}`, payload);
        toast.success('Agency updated');
      } else {
        await api.post('/talent/agencies', payload);
        toast.success('Agency added');
      }
      onSaved();
    } catch (err) {
      const msg =
        err?.originalError?.response?.data?.error ||
        err?.response?.data?.error ||
        err?.message ||
        'Failed to save agency';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const fields = [
    { label:'Agency Name *', key:'name',           placeholder:'e.g. TalentBridge India', full:true },
    { label:'Contact Person', key:'contact_person', placeholder:'Name' },
    { label:'Email',          key:'email',          placeholder:'info@agency.com', type:'email' },
    { label:'Phone',          key:'phone',          placeholder:'+91 98765 43210' },
    { label:'Website',        key:'website',        placeholder:'https://agency.com' },
    { label:'City',           key:'city',           placeholder:'Mumbai' },
    { label:'Fee %',          key:'fee_percentage', placeholder:'8', type:'number' },
    { label:'Payment Terms',  key:'payment_terms',  placeholder:'30 days after joining' },
    { label:'Agreement Start',key:'agreement_start',type:'date' },
    { label:'Agreement End',  key:'agreement_end',  type:'date' },
    { label:'Notes',          key:'notes',          placeholder:'Additional notes...', full:true },
  ];

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div style={{ background:'#fff', borderRadius:16, padding:32, width:560, maxHeight:'90vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,.2)' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
          <h2 style={{ fontSize:17, fontWeight:700, color:'#1f2937', margin:0 }}>
            {isEdit ? 'Edit Agency' : 'Add Recruitment Agency'}
          </h2>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
          {fields.map(f => (
            <div key={f.key} style={{ gridColumn: f.full ? '1/-1' : 'auto' }}>
              <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>{f.label}</label>
              <input
                type={f.type || 'text'}
                value={form[f.key]}
                onChange={e => set(f.key, e.target.value)}
                placeholder={f.placeholder}
                style={{ width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}
              />
            </div>
          ))}
          <div style={{ gridColumn:'1/-1' }}>
            <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>Specializations</label>
            <TagInput value={form.specializations} onChange={v => set('specializations', v)}/>
          </div>
          <div style={{ gridColumn:'1/-1', display:'flex', alignItems:'center', gap:10 }}>
            <label style={{ fontSize:12, fontWeight:600, color:'#374151' }}>Active</label>
            <button
              onClick={() => set('is_active', !form.is_active)}
              style={{ background:'none', border:'none', cursor:'pointer', color: form.is_active ? '#6B3FDB' : '#9ca3af' }}
            >
              {form.is_active ? <ToggleRight size={28}/> : <ToggleLeft size={28}/>}
            </button>
          </div>
        </div>

        <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:20 }}>
          <button onClick={onClose} style={{ padding:'9px 18px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving || !form.name.trim()}
            style={{ padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor: (saving || !form.name.trim()) ? 'not-allowed' : 'pointer', fontSize:13, fontWeight:600, opacity: (saving || !form.name.trim()) ? 0.6 : 1 }}
          >
            {saving ? 'Saving…' : (isEdit ? 'Update Agency' : 'Add Agency')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Candidates side panel ─────────────────────────────────────────────────────
function CandidatesPanel({ agency, onClose }) {
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/talent/agencies/${agency.id}/candidates`)
      .then(r => setCandidates(r.data?.data ?? []))
      .catch(() => setCandidates([]))
      .finally(() => setLoading(false));
  }, [agency.id]);

  const STAGE_COLORS = {
    applied:     { bg:'#dbeafe', color:'#1d4ed8' },
    screening:   { bg:'#ede9fe', color:'#6d28d9' },
    interview:   { bg:'#fef3c7', color:'#92400e' },
    offer:       { bg:'#d1fae5', color:'#065f46' },
    hired:       { bg:'#dcfce7', color:'#15803d' },
    rejected:    { bg:'#fee2e2', color:'#b91c1c' },
  };

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.4)', zIndex:1000, display:'flex', justifyContent:'flex-end' }}>
      <div style={{ background:'#fff', width:440, height:'100%', overflowY:'auto', boxShadow:'-4px 0 20px rgba(0,0,0,.15)', display:'flex', flexDirection:'column' }}>
        <div style={{ padding:'20px 24px', borderBottom:'1px solid #f0f0f4', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div>
            <h2 style={{ fontSize:15, fontWeight:700, color:'#1f2937', margin:0 }}>Candidates from {agency.name}</h2>
            <p style={{ fontSize:12, color:'#6b7280', margin:'2px 0 0' }}>Sourced through this agency</p>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
        </div>
        <div style={{ flex:1, padding:16 }}>
          {loading ? (
            <p style={{ textAlign:'center', color:'#9ca3af', paddingTop:40 }}>Loading…</p>
          ) : candidates.length === 0 ? (
            <div style={{ textAlign:'center', paddingTop:60 }}>
              <Users size={36} color="#d1d5db" style={{ marginBottom:8 }}/>
              <p style={{ color:'#9ca3af', fontSize:13 }}>No candidates sourced yet</p>
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {candidates.map(c => {
                const sc = STAGE_COLORS[c.stage] || { bg:'#f3f4f6', color:'#374151' };
                return (
                  <div key={c.id} style={{ background:'#f9fafb', borderRadius:10, padding:'12px 14px', border:'1px solid #f0f0f4' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:4 }}>
                      <p style={{ fontSize:13, fontWeight:600, color:'#1f2937', margin:0 }}>
                        {c.first_name} {c.last_name}
                      </p>
                      <span style={{ background:sc.bg, color:sc.color, borderRadius:20, padding:'2px 8px', fontSize:10, fontWeight:600, textTransform:'capitalize' }}>
                        {c.stage}
                      </span>
                    </div>
                    {c.candidate_role && <p style={{ fontSize:11, color:'#6b7280', margin:'2px 0' }}>{c.candidate_role}</p>}
                    {c.applied_position && <p style={{ fontSize:11, color:'#9ca3af', margin:0 }}>Applied for: {c.applied_position}</p>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function RecruitmentAgencies() {
  const toast = useToast();
  const [agencies,        setAgencies]        = useState([]);
  const [loading,         setLoading]         = useState(false);
  const [search,          setSearch]          = useState('');
  const [showModal,       setShowModal]       = useState(false);
  const [editingAgency,   setEditingAgency]   = useState(null);
  const [viewCandidates,  setViewCandidates]  = useState(null);
  const [pendingDeleteAgency, setPendingDeleteAgency] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/talent/agencies', { params: { search } })
      .then(r => setAgencies(r.data?.data ?? []))
      .catch(() => setAgencies([]))
      .finally(() => setLoading(false));
  }, [search]);

  useEffect(() => { load(); }, [load]);

  const handleDeactivate = async (agency) => {
    try {
      await api.put(`/talent/agencies/${agency.id}`, { is_active: !agency.is_active });
      toast.success(agency.is_active ? 'Agency deactivated' : 'Agency activated');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update agency');
    }
  };

  const handleDelete = async () => {
    if (!pendingDeleteAgency) return;
    const agency = pendingDeleteAgency;
    setPendingDeleteAgency(null);
    try {
      await api.delete(`/talent/agencies/${agency.id}`);
      toast.success('Agency deleted');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Cannot delete agency');
    }
  };

  const openAdd = () => { setEditingAgency(null); setShowModal(true); };
  const openEdit = (a) => { setEditingAgency(a); setShowModal(true); };
  const closeModal = () => { setShowModal(false); setEditingAgency(null); };
  const onSaved = () => { closeModal(); load(); };

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>
      <ConfirmDialog
        open={!!pendingDeleteAgency}
        title="Delete Agency"
        message={pendingDeleteAgency ? `Delete "${pendingDeleteAgency.name}"?` : ''}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingDeleteAgency(null)}
      />
      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Recruitment Agencies</h1>
          <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>
            {agencies.length} agency partner{agencies.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={openAdd}
          style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}
        >
          <Plus size={15}/> Add Agency
        </button>
      </div>

      {/* Search */}
      <div style={{ position:'relative', marginBottom:20, maxWidth:340 }}>
        <Search size={14} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }}/>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name or contact…"
          style={{ width:'100%', paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8, border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}
        />
      </div>

      {/* Content */}
      {loading ? (
        <div style={{ textAlign:'center', padding:60, color:'#9ca3af' }}>Loading…</div>
      ) : agencies.length === 0 ? (
        <div style={{ background:'#fff', borderRadius:12, padding:60, textAlign:'center', border:'1px solid #f0f0f4' }}>
          <Building size={44} color="#d1d5db" style={{ marginBottom:12 }}/>
          <p style={{ color:'#6b7280', fontWeight:500, margin:'0 0 4px' }}>No agencies added yet</p>
          <p style={{ color:'#9ca3af', fontSize:13, margin:'0 0 20px' }}>Add your first recruitment agency partner</p>
          <button
            onClick={openAdd}
            style={{ padding:'9px 22px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}
          >
            Add First Agency
          </button>
        </div>
      ) : (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(320px,1fr))', gap:16 }}>
          {agencies.map(a => {
            const expired = isExpired(a.agreement_end);
            const specs = Array.isArray(a.specializations) ? a.specializations
              : (a.specialization_text ? a.specialization_text.split(',').map(s => s.trim()) : []);

            return (
              <div key={a.id} style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', boxShadow:'0 1px 3px rgba(0,0,0,.05)', overflow:'hidden' }}>
                {/* Card header */}
                <div style={{ padding:'16px 18px 12px', borderBottom:'1px solid #f9fafb' }}>
                  <div style={{ display:'flex', alignItems:'flex-start', gap:12 }}>
                    <div style={{ width:42, height:42, borderRadius:10, background:'#ede9fe', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      <Building size={20} color="#6B3FDB"/>
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                        <p style={{ fontSize:14, fontWeight:700, color:'#1f2937', margin:0 }}>{a.name}</p>
                        <span style={{
                          background: a.is_active ? '#dcfce7' : '#fee2e2',
                          color:      a.is_active ? '#15803d' : '#b91c1c',
                          borderRadius:20, padding:'2px 8px', fontSize:10, fontWeight:600,
                        }}>
                          {a.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </div>
                      {a.city && <p style={{ fontSize:11, color:'#9ca3af', margin:'2px 0 0' }}>{a.city}</p>}
                    </div>
                    {a.fee_percentage != null && (
                      <span style={{ background:'#fef3c7', color:'#92400e', borderRadius:20, padding:'3px 8px', fontSize:11, fontWeight:600, flexShrink:0 }}>
                        {a.fee_percentage}% fee
                      </span>
                    )}
                  </div>
                </div>

                {/* Contact */}
                <div style={{ padding:'10px 18px', borderBottom:'1px solid #f9fafb' }}>
                  {a.contact_person && (
                    <p style={{ fontSize:12, color:'#374151', margin:'0 0 4px' }}>
                      <span style={{ color:'#9ca3af' }}>Contact: </span>{a.contact_person}
                    </p>
                  )}
                  <div style={{ display:'flex', flexWrap:'wrap', gap:10 }}>
                    {a.email && (
                      <a href={`mailto:${a.email}`} style={{ display:'flex', alignItems:'center', gap:4, fontSize:11, color:'#6B3FDB', textDecoration:'none' }}>
                        <Mail size={11}/>{a.email}
                      </a>
                    )}
                    {a.phone && (
                      <a href={`tel:${a.phone}`} style={{ display:'flex', alignItems:'center', gap:4, fontSize:11, color:'#374151', textDecoration:'none' }}>
                        <Phone size={11}/>{a.phone}
                      </a>
                    )}
                    {a.website && (
                      <a href={a.website} target="_blank" rel="noreferrer" style={{ display:'flex', alignItems:'center', gap:4, fontSize:11, color:'#0369a1', textDecoration:'none' }}>
                        <Globe size={11}/>Website
                      </a>
                    )}
                  </div>
                </div>

                {/* Specializations */}
                {specs.length > 0 && (
                  <div style={{ padding:'8px 18px', borderBottom:'1px solid #f9fafb', display:'flex', flexWrap:'wrap', gap:4 }}>
                    {specs.map((s, i) => (
                      <span key={i} style={{ background:'#f5f3ff', color:'#6B3FDB', borderRadius:20, padding:'2px 8px', fontSize:10, fontWeight:500 }}>
                        {s}
                      </span>
                    ))}
                  </div>
                )}

                {/* Agreement dates */}
                {(a.agreement_start || a.agreement_end) && (
                  <div style={{ padding:'8px 18px', borderBottom:'1px solid #f9fafb' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:5, fontSize:11, color: expired ? '#b91c1c' : '#374151' }}>
                      <Calendar size={11}/>
                      Agreement: {fmtDate(a.agreement_start)} – <span style={{ color: expired ? '#b91c1c' : 'inherit', fontWeight: expired ? 600 : 400 }}>{fmtDate(a.agreement_end)}</span>
                      {expired && <span style={{ background:'#fee2e2', color:'#b91c1c', borderRadius:20, padding:'1px 6px', fontSize:9, fontWeight:700 }}>EXPIRED</span>}
                    </div>
                  </div>
                )}

                {/* Stats */}
                <div style={{ padding:'10px 18px', borderBottom:'1px solid #f9fafb', display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:0 }}>
                  {[
                    { label:'Sourced',  value: a.total_candidates ?? 0, icon: Users,      color:'#6366f1' },
                    { label:'Hired',    value: a.hired_count ?? 0,       icon: TrendingUp, color:'#10b981' },
                    { label:'Success',  value: a.success_rate != null ? `${a.success_rate}%` : '—', icon: null, color:'#f59e0b' },
                  ].map((s, i) => (
                    <div key={s.label} style={{ textAlign:'center', padding:'4px 0', borderRight: i < 2 ? '1px solid #f0f0f4' : 'none' }}>
                      <p style={{ fontSize:16, fontWeight:700, color:s.color, margin:0 }}>{s.value}</p>
                      <p style={{ fontSize:10, color:'#9ca3af', margin:0, textTransform:'uppercase', letterSpacing:.4 }}>{s.label}</p>
                    </div>
                  ))}
                </div>

                {/* Actions */}
                <div style={{ padding:'10px 14px', display:'flex', gap:6, flexWrap:'wrap' }}>
                  <button
                    onClick={() => setViewCandidates(a)}
                    style={{ display:'flex', alignItems:'center', gap:4, padding:'6px 12px', background:'#ede9fe', color:'#6B3FDB', border:'none', borderRadius:7, cursor:'pointer', fontSize:11, fontWeight:600 }}
                  >
                    <Users size={12}/> Candidates <ChevronRight size={11}/>
                  </button>
                  <button
                    onClick={() => openEdit(a)}
                    style={{ display:'flex', alignItems:'center', gap:4, padding:'6px 10px', background:'#f3f4f6', color:'#374151', border:'none', borderRadius:7, cursor:'pointer', fontSize:11 }}
                  >
                    <Pencil size={12}/> Edit
                  </button>
                  <button
                    onClick={() => handleDeactivate(a)}
                    style={{ display:'flex', alignItems:'center', gap:4, padding:'6px 10px', background: a.is_active ? '#fef3c7' : '#dcfce7', color: a.is_active ? '#92400e' : '#15803d', border:'none', borderRadius:7, cursor:'pointer', fontSize:11 }}
                  >
                    {a.is_active ? <ToggleLeft size={12}/> : <ToggleRight size={12}/>}
                    {a.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                  {(a.total_candidates ?? 0) === 0 && (
                    <button
                      onClick={() => setPendingDeleteAgency(a)}
                      style={{ display:'flex', alignItems:'center', gap:4, padding:'6px 10px', background:'#fee2e2', color:'#b91c1c', border:'none', borderRadius:7, cursor:'pointer', fontSize:11 }}
                    >
                      <Trash2 size={12}/> Delete
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modals */}
      {showModal && (
        <AgencyModal agency={editingAgency} onClose={closeModal} onSaved={onSaved}/>
      )}
      {viewCandidates && (
        <CandidatesPanel agency={viewCandidates} onClose={() => setViewCandidates(null)}/>
      )}
    </div>
  );
}
