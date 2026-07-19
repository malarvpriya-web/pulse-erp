import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Plus, X, Map, Search, Pencil, Trash2 } from 'lucide-react';
import ConfirmDialog from '@/components/core/ConfirmDialog';

function fmtL(n) {
  const v = parseFloat(n) || 0;
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)} Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(2)} L`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
}

const EMPTY = { name:'', region:'', states:'', assigned_to:'', target_revenue:'' };

function statesArray(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') return val.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

export default function Territories() {
  const toast = useToast();
  const [territories, setTerritories] = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [showForm,    setShowForm]    = useState(false);
  const [editing,     setEditing]     = useState(null);
  const [form,        setForm]        = useState(EMPTY);
  const [saving,      setSaving]      = useState(false);
  const [search,      setSearch]      = useState('');
  const [pendingHandleDelete, setPendingHandleDelete] = useState(null);

  function load() {
    api.get('/sales/territories', { params:{ limit:200 } })
      .then(r => setTerritories(Array.isArray(r.data) ? r.data : []))
      .catch(() => setTerritories([]))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  function openAdd() { setEditing(null); setForm(EMPTY); setShowForm(true); }
  function openEdit(t) {
    setEditing(t.id);
    setForm({
      name:           t.name || '',
      region:         t.region || '',
      states:         statesArray(t.states).join(', '),
      assigned_to:    t.assigned_to || '',
      target_revenue: t.target_revenue || '',
    });
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const statesArr = statesArray(form.states);
      const payload = {
        name:           form.name,
        region:         form.region || null,
        states:         statesArr,
        assigned_to:    form.assigned_to || null,
        target_revenue: Number(form.target_revenue) || 0,
      };
      if (editing) {
        await api.put(`/sales/territories/${editing}`, payload);
        toast.success('Territory updated');
      } else {
        await api.post('/sales/territories', payload);
        toast.success('Territory created');
      }
      setShowForm(false);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save territory');
    } finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!pendingHandleDelete) return;
    const id = pendingHandleDelete;
    setPendingHandleDelete(null);
    try {
      await api.delete(`/sales/territories/${id}`);
      setTerritories(prev => prev.filter(t => t.id !== id));
      toast.success('Territory deleted');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to delete territory');
    }
  }

  const filtered = territories.filter(t =>
    !search || [t.name, t.region, t.assigned_to_name, t.assigned_to].some(v => (v||'').toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>

      <ConfirmDialog
        open={!!pendingHandleDelete}
        title="Delete Territory"
        message="Delete this territory?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingHandleDelete(null)}
      />
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Sales Territories</h1>
          <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>{territories.length} territories defined</p>
        </div>
        <button onClick={openAdd}
          style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
          <Plus size={15}/> Add Territory
        </button>
      </div>

      <div style={{ position:'relative', marginBottom:16, maxWidth:320 }}>
        <Search size={14} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }}/>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, region..."
          style={{ width:'100%', paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8, border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
      </div>

      {loading ? (
        <div style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>Loading...</div>
      ) : filtered.length === 0 ? (
        <div style={{ background:'#fff', borderRadius:12, padding:60, textAlign:'center', border:'1px solid #f0f0f4' }}>
          <Map size={40} color="#d1d5db" style={{ marginBottom:12 }}/>
          <p style={{ color:'#9ca3af', margin:'0 0 16px' }}>No territories defined</p>
          <button onClick={openAdd} style={{ padding:'9px 20px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>Create First Territory</button>
        </div>
      ) : (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))', gap:16 }}>
          {filtered.map(t => {
            const statesArr = statesArray(t.states);
            return (
              <div key={t.id} style={{ background:'#fff', borderRadius:12, padding:20, border:'1px solid #f0f0f4' }}>
                <div style={{ display:'flex', alignItems:'flex-start', gap:10, marginBottom:12 }}>
                  <div style={{ width:38, height:38, borderRadius:8, background:'#ede9fe', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    <Map size={18} color="#6B3FDB"/>
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <p style={{ fontSize:14, fontWeight:600, color:'#1f2937', margin:0 }}>{t.name}</p>
                    {t.region && <p style={{ fontSize:11, color:'#9ca3af', margin:'2px 0 0' }}>{t.region}</p>}
                  </div>
                </div>
                {(t.assigned_to_name || t.assigned_to) && (
                  <p style={{ fontSize:12, color:'#374151', margin:'0 0 8px' }}>Manager: <strong>{t.assigned_to_name || t.assigned_to}</strong></p>
                )}
                {statesArr.length > 0 && (
                  <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginBottom:8 }}>
                    {statesArr.slice(0, 6).map(s => (
                      <span key={s} style={{ background:'#ede9fe', color:'#6B3FDB', padding:'2px 7px', borderRadius:20, fontSize:10, fontWeight:600 }}>{s}</span>
                    ))}
                    {statesArr.length > 6 && <span style={{ fontSize:10, color:'#9ca3af' }}>+{statesArr.length - 6}</span>}
                  </div>
                )}
                {t.target_revenue > 0 && (
                  <p style={{ fontSize:13, fontWeight:700, color:'#10b981', margin:'0 0 12px' }}>Target: {fmtL(t.target_revenue)}</p>
                )}
                <div style={{ display:'flex', gap:8 }}>
                  <button onClick={() => openEdit(t)}
                    style={{ display:'flex', alignItems:'center', gap:4, padding:'5px 10px', background:'#ede9fe', color:'#6B3FDB', border:'none', borderRadius:6, cursor:'pointer', fontSize:12, fontWeight:600 }}>
                    <Pencil size={11}/> Edit
                  </button>
                  <button onClick={() => setPendingHandleDelete(t.id)}
                    style={{ display:'flex', alignItems:'center', gap:4, padding:'5px 10px', background:'#fee2e2', color:'#ef4444', border:'none', borderRadius:6, cursor:'pointer', fontSize:12, fontWeight:600 }}>
                    <Trash2 size={11}/> Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showForm && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:'#fff', borderRadius:16, padding:32, width:440, boxShadow:'0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <h2 style={{ fontSize:17, fontWeight:700, color:'#1f2937', margin:0 }}>{editing ? 'Edit' : 'Add'} Territory</h2>
              <button onClick={() => setShowForm(false)} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
            </div>
            <div style={{ display:'grid', gap:14 }}>
              {[
                { label:'Territory Name *', key:'name',           placeholder:'e.g. South India' },
                { label:'Region',           key:'region',         placeholder:'South, North, East, West' },
                { label:'States Covered',   key:'states',         placeholder:'TN, KA, KL, AP (comma separated)' },
                { label:'Assigned Manager', key:'assigned_to',    placeholder:'Employee ID or name' },
                { label:'Target Revenue (₹)', key:'target_revenue', type:'number', placeholder:'0' },
              ].map(f => (
                <div key={f.key}>
                  <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>{f.label}</label>
                  <input type={f.type || 'text'} value={form[f.key]} onChange={e => setForm(p => ({...p, [f.key]: e.target.value}))} placeholder={f.placeholder}
                    style={{ width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
                </div>
              ))}
            </div>
            <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:20 }}>
              <button onClick={() => setShowForm(false)} style={{ padding:'9px 18px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Cancel</button>
              <button onClick={handleSave} disabled={saving || !form.name}
                style={{ padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600, opacity: (saving || !form.name) ? 0.6 : 1 }}>
                {saving ? 'Saving...' : editing ? 'Update' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
