import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Plus, X, ToggleLeft, ToggleRight, Settings, Search } from 'lucide-react';

const TRIGGER_MODULES = ['Leave','Expense','Purchase Order','Invoice','Recruitment','Travel','Timesheet'];
const TRIGGER_MODULE_MAP = { 'Leave':'leave', 'Expense':'expense', 'Purchase Order':'purchase_order', 'Invoice':'invoice', 'Recruitment':'recruitment', 'Travel':'travel', 'Timesheet':'timesheet' };
const EMPTY = { name:'', description:'', trigger_module:'Leave', trigger_event:'on_submit', is_active:true };

export default function WorkflowConfiguration({ setPage }) {
  const toast = useToast();
  const [workflows, setWorkflows] = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [showForm,  setShowForm]  = useState(false);
  const [form,      setForm]      = useState(EMPTY);
  const [saving,    setSaving]    = useState(false);
  const [search,    setSearch]    = useState('');

  const load = () => {
    setLoading(true);
    api.get('/operations/workflows')
      .then(r => setWorkflows(Array.isArray(r.data) ? r.data : []))
      .catch(() => setWorkflows([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const toggle = async (id, current) => {
    try {
      await api.put(`/operations/workflows/${id}/toggle`, { is_active: !current });
      load();
      toast.success(`Workflow ${!current ? 'activated' : 'deactivated'}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to toggle workflow.');
    }
  };

  const handleSave = async () => {
    if (!form.name) return;
    setSaving(true);
    try {
      await api.post('/operations/workflows', {
        ...form,
        trigger_module: TRIGGER_MODULE_MAP[form.trigger_module] || form.trigger_module.toLowerCase(),
      });
      setShowForm(false); setForm(EMPTY); load();
      toast.success('Workflow created successfully');
    } catch (err) {
      toast.error(err.response?.data?.error || err.message || 'Failed to create workflow. Please try again.');
    } finally { setSaving(false); }
  };

  const filtered = workflows.filter(w =>
    !search || [w.name, w.trigger_module, w.description].some(v => (v||'').toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Workflow Configuration</h1>
          <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>{workflows.filter(w=>w.is_active).length} active workflows</p>
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          {setPage && (
            <>
              <button onClick={() => setPage('ApproverSetup')} style={{ display:'flex', alignItems:'center', gap:5, padding:'8px 13px', background:'#f5f3ff', color:'#6B3FDB', border:'1px solid #ddd6fe', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
                Approver Setup →
              </button>
              <button onClick={() => setPage('WorkflowBuilder')} style={{ display:'flex', alignItems:'center', gap:5, padding:'8px 13px', background:'#f5f3ff', color:'#6B3FDB', border:'1px solid #ddd6fe', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
                Workflow Builder →
              </button>
            </>
          )}
          <button onClick={() => setShowForm(true)}
            style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
            <Plus size={15}/> New Workflow
          </button>
        </div>
      </div>

      <div style={{ position:'relative', marginBottom:16, maxWidth:320 }}>
        <Search size={14} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }}/>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search workflows..."
          style={{ width:'100%', paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8, border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
      </div>

      {loading ? <div style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>Loading...</div> :
       filtered.length === 0 ? (
        <div style={{ background:'#fff', borderRadius:12, padding:60, textAlign:'center', border:'1px solid #f0f0f4' }}>
          <Settings size={40} color="#d1d5db" style={{ marginBottom:12 }}/>
          <p style={{ color:'#9ca3af', margin:'0 0 16px' }}>No workflows configured yet</p>
          <button onClick={() => setShowForm(true)} style={{ padding:'9px 20px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>Create First Workflow</button>
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          {filtered.map(w => (
            <div key={w.id} style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:'16px 20px', display:'flex', alignItems:'center', gap:16 }}>
              <div style={{ flex:1 }}>
                <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
                  <p style={{ fontSize:14, fontWeight:600, color:'#1f2937', margin:0 }}>{w.name}</p>
                  <span style={{ background:'#ede9fe', color:'#6B3FDB', padding:'2px 8px', borderRadius:20, fontSize:10, fontWeight:600 }}>{w.trigger_module || w.module}</span>
                  <span style={{ background:'#f3f4f6', color:'#374151', padding:'2px 8px', borderRadius:20, fontSize:10, fontWeight:500 }}>on {w.trigger_event || 'on_submit'}</span>
                </div>
                {w.description && <p style={{ fontSize:12, color:'#6b7280', margin:0 }}>{w.description}</p>}
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:12, flexShrink:0 }}>
                <span style={{ fontSize:12, color: w.is_active?'#10b981':'#9ca3af', fontWeight:500 }}>{w.is_active?'Active':'Inactive'}</span>
                <button onClick={() => toggle(w.id, w.is_active)} style={{ background:'none', border:'none', cursor:'pointer', color: w.is_active?'#6B3FDB':'#9ca3af', padding:0 }}>
                  {w.is_active ? <ToggleRight size={28}/> : <ToggleLeft size={28}/>}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:'#fff', borderRadius:16, padding:32, width:460, boxShadow:'0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <h2 style={{ fontSize:17, fontWeight:700, color:'#1f2937', margin:0 }}>New Workflow</h2>
              <button onClick={() => setShowForm(false)} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
            </div>
            <div style={{ display:'grid', gap:14 }}>
              <div>
                <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>Workflow Name *</label>
                <input value={form.name} onChange={e => setForm(p=>({...p,name:e.target.value}))} placeholder="e.g. Leave Auto-Approval"
                  style={{ width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
              </div>
              <div>
                <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>Description</label>
                <input value={form.description} onChange={e => setForm(p=>({...p,description:e.target.value}))} placeholder="What does this workflow do?"
                  style={{ width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                <div>
                  <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>Trigger Module</label>
                  <select value={form.trigger_module} onChange={e => setForm(p=>({...p,trigger_module:e.target.value}))}
                    style={{ width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none' }}>
                    {TRIGGER_MODULES.map(m => <option key={m}>{m}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>Trigger Event</label>
                  <select value={form.trigger_event} onChange={e => setForm(p=>({...p,trigger_event:e.target.value}))}
                    style={{ width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none' }}>
                    {['Created','Updated','Status Changed','Approved','Rejected'].map(e => <option key={e}>{e}</option>)}
                  </select>
                </div>
              </div>
            </div>
            <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:20 }}>
              <button onClick={() => setShowForm(false)} style={{ padding:'9px 18px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Cancel</button>
              <button onClick={handleSave} disabled={saving||!form.name}
                style={{ padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600, opacity:(saving||!form.name)?.6:1 }}>
                {saving?'Creating...':'Create Workflow'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}