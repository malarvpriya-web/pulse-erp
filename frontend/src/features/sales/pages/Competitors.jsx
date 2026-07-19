import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Plus, X, Search, Shield, Pencil, Trash2, TrendingUp } from 'lucide-react';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const EMPTY = { name:'', website:'', strengths:'', weaknesses:'', win_rate:'', notes:'' };

export default function Competitors() {
  const toast = useToast();
  const [competitors, setCompetitors] = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [showForm,    setShowForm]    = useState(false);
  const [editing,     setEditing]     = useState(null);
  const [form,        setForm]        = useState(EMPTY);
  const [saving,      setSaving]      = useState(false);
  const [search,      setSearch]      = useState('');
  const [pendingHandleDelete, setPendingHandleDelete] = useState(null);

  function load() {
    api.get('/sales/competitors', { params:{ limit:100 } })
      .then(r => setCompetitors(Array.isArray(r.data) ? r.data : []))
      .catch(() => setCompetitors([]))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  function openAdd() { setEditing(null); setForm(EMPTY); setShowForm(true); }
  function openEdit(c) {
    setEditing(c.id);
    setForm({
      name:       c.name      || '',
      website:    c.website   || '',
      strengths:  c.strengths || '',
      weaknesses: c.weaknesses|| '',
      win_rate:   c.win_rate  != null ? String(c.win_rate) : '',
      notes:      c.notes     || '',
    });
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const payload = {
        ...form,
        win_rate: form.win_rate !== '' ? Number(form.win_rate) : null,
      };
      if (editing) {
        await api.put(`/sales/competitors/${editing}`, payload);
        toast.success('Competitor updated');
      } else {
        await api.post('/sales/competitors', payload);
        toast.success('Competitor added');
      }
      setShowForm(false);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save competitor');
    } finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!pendingHandleDelete) return;
    const id = pendingHandleDelete;
    setPendingHandleDelete(null);
    try {
      await api.delete(`/sales/competitors/${id}`);
      setCompetitors(prev => prev.filter(c => c.id !== id));
      toast.success('Competitor removed');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to remove competitor');
    }
  }

  const filtered = competitors.filter(c =>
    !search || [c.name, c.website].some(v => (v||'').toLowerCase().includes(search.toLowerCase()))
  );

  function winRateColor(rate) {
    const r = parseFloat(rate) || 0;
    if (r >= 60) return '#10b981';
    if (r >= 40) return '#f59e0b';
    return '#ef4444';
  }

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>

      <ConfirmDialog
        open={!!pendingHandleDelete}
        title="Remove Competitor"
        message="Remove this competitor?"
        confirmLabel="Remove"
        variant="warning"
        onConfirm={handleDelete}
        onCancel={() => setPendingHandleDelete(null)}
      />
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Competitors</h1>
          <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>{competitors.length} tracked competitors</p>
        </div>
        <button onClick={openAdd}
          style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
          <Plus size={15}/> Add Competitor
        </button>
      </div>

      <div style={{ position:'relative', marginBottom:16, maxWidth:320 }}>
        <Search size={14} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }}/>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search competitors..."
          style={{ width:'100%', paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8, border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
      </div>

      {loading ? (
        <div style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>Loading...</div>
      ) : filtered.length === 0 ? (
        <div style={{ background:'#fff', borderRadius:12, padding:60, textAlign:'center', border:'1px solid #f0f0f4' }}>
          <Shield size={40} color="#d1d5db" style={{ marginBottom:12 }}/>
          <p style={{ color:'#9ca3af', margin:'0 0 16px' }}>No competitors tracked yet</p>
          <button onClick={openAdd} style={{ padding:'9px 20px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>Add First Competitor</button>
        </div>
      ) : (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(320px,1fr))', gap:16 }}>
          {filtered.map(c => {
            const wr = parseFloat(c.win_rate) || 0;
            const wc = winRateColor(wr);
            return (
              <div key={c.id} style={{ background:'#fff', borderRadius:12, padding:20, border:'1px solid #f0f0f4' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:12 }}>
                  <div style={{ flex:1, minWidth:0, marginRight:8 }}>
                    <p style={{ fontSize:15, fontWeight:700, color:'#1f2937', margin:0 }}>{c.name}</p>
                    {c.website && (
                      <a href={c.website.startsWith('http') ? c.website : `https://${c.website}`} target="_blank" rel="noopener noreferrer"
                        style={{ fontSize:11, color:'#6B3FDB', textDecoration:'none' }}>{c.website}</a>
                    )}
                  </div>
                  {c.win_rate != null && (
                    <div style={{ textAlign:'center', flexShrink:0 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:4, background: wc + '18', padding:'4px 10px', borderRadius:8 }}>
                        <TrendingUp size={12} color={wc}/>
                        <span style={{ fontSize:13, fontWeight:700, color: wc }}>{wr}%</span>
                      </div>
                      <p style={{ fontSize:9, color:'#9ca3af', margin:'2px 0 0', textAlign:'center' }}>Win Rate</p>
                    </div>
                  )}
                </div>
                {c.strengths && (
                  <div style={{ marginBottom:8 }}>
                    <p style={{ fontSize:11, fontWeight:600, color:'#10b981', margin:'0 0 3px' }}>Strengths</p>
                    <p style={{ fontSize:12, color:'#374151', margin:0, lineHeight:1.4 }}>{c.strengths}</p>
                  </div>
                )}
                {c.weaknesses && (
                  <div style={{ marginBottom:8 }}>
                    <p style={{ fontSize:11, fontWeight:600, color:'#ef4444', margin:'0 0 3px' }}>Weaknesses</p>
                    <p style={{ fontSize:12, color:'#374151', margin:0, lineHeight:1.4 }}>{c.weaknesses}</p>
                  </div>
                )}
                {c.notes && (
                  <p style={{ fontSize:11, color:'#9ca3af', margin:'6px 0 0', fontStyle:'italic', lineHeight:1.4 }}>{c.notes}</p>
                )}
                <div style={{ display:'flex', gap:8, marginTop:12 }}>
                  <button onClick={() => openEdit(c)}
                    style={{ display:'flex', alignItems:'center', gap:4, padding:'5px 10px', background:'#ede9fe', color:'#6B3FDB', border:'none', borderRadius:6, cursor:'pointer', fontSize:12, fontWeight:600 }}>
                    <Pencil size={11}/> Edit
                  </button>
                  <button onClick={() => setPendingHandleDelete(c.id)}
                    style={{ display:'flex', alignItems:'center', gap:4, padding:'5px 10px', background:'#fee2e2', color:'#ef4444', border:'none', borderRadius:6, cursor:'pointer', fontSize:12, fontWeight:600 }}>
                    <Trash2 size={11}/> Remove
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showForm && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:'#fff', borderRadius:16, padding:32, width:500, maxHeight:'90vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <h2 style={{ fontSize:17, fontWeight:700, color:'#1f2937', margin:0 }}>{editing ? 'Edit' : 'Add'} Competitor</h2>
              <button onClick={() => setShowForm(false)} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
            </div>
            <div style={{ display:'grid', gap:14 }}>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
                <div>
                  <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>Company Name *</label>
                  <input value={form.name} onChange={e => setForm(p => ({...p, name: e.target.value}))} placeholder="Competitor Inc."
                    style={{ width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
                </div>
                <div>
                  <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>Win Rate (%)</label>
                  <input type="number" min="0" max="100" step="0.1" value={form.win_rate} onChange={e => setForm(p => ({...p, win_rate: e.target.value}))} placeholder="e.g. 55"
                    style={{ width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
                </div>
              </div>
              <div>
                <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>Website</label>
                <input value={form.website} onChange={e => setForm(p => ({...p, website: e.target.value}))} placeholder="https://competitor.com"
                  style={{ width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
              </div>
              {[
                { label:'Strengths',  key:'strengths',  placeholder:'What do they do well?' },
                { label:'Weaknesses', key:'weaknesses', placeholder:'Where do they fall short?' },
                { label:'Notes',      key:'notes',      placeholder:'Additional competitive intelligence...' },
              ].map(f => (
                <div key={f.key}>
                  <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>{f.label}</label>
                  <textarea value={form[f.key]} onChange={e => setForm(p => ({...p, [f.key]: e.target.value}))} placeholder={f.placeholder} rows={2}
                    style={{ width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', resize:'vertical', boxSizing:'border-box' }}/>
                </div>
              ))}
            </div>
            <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:20 }}>
              <button onClick={() => setShowForm(false)} style={{ padding:'9px 18px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Cancel</button>
              <button onClick={handleSave} disabled={saving || !form.name}
                style={{ padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600, opacity: (saving || !form.name) ? 0.6 : 1 }}>
                {saving ? 'Saving...' : editing ? 'Update' : 'Add Competitor'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
