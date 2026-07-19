// frontend/src/features/inventory/pages/QualityManagement.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';


/* ── helpers ── */
function statusBadge(status) {
  const map = {
    pass:        { bg:'#d1fae5', color:'#16a34a', label:'✓ Pass' },
    fail:        { bg:'#fee2e2', color:'#dc2626', label:'✗ Fail' },
    conditional: { bg:'#fef3c7', color:'#d97706', label:'⚠ Conditional' },
    pending:     { bg:'#f3f4f6', color:'#6b7280', label:'Pending' },
  };
  const s = map[status] || map.pending;
  return <span style={{ padding:'2px 9px', borderRadius:10, fontSize:11, fontWeight:700, background:s.bg, color:s.color }}>{s.label}</span>;
}

// minor=amber | major=orange | critical=red
function sevBadge(sev) {
  const map = {
    critical: ['#fee2e2','#dc2626'],
    major:    ['#ffedd5','#c2410c'],
    minor:    ['#fef3c7','#d97706'],
  };
  const [bg, color] = map[sev] || ['#f3f4f6','#6b7280'];
  return <span style={{ padding:'2px 8px', borderRadius:10, fontSize:11, fontWeight:700, background:bg, color }}>{sev}</span>;
}

/* ══════════════════════
   TAB 1 — Checklists
══════════════════════ */
function ChecklistsTab() {
  const toast = useToast();
  const [lists, setLists]     = useState([]);
  const [editing, setEditing] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [newForm, setNewForm] = useState({ name:'', type:'inward', items:[] });

  const load = useCallback(async () => {
    try {
      const res = await api.get('/quality/checklists');
      setLists(res.data?.data || res.data || []);
    } catch { setLists([]); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const addItem = (setForm) => {
    setForm(f => ({ ...f, items: [...(f.items||[]), { step:(f.items||[]).length+1, criteria:'', measurement_type:'pass_fail' }] }));
  };

  const saveChecklist = async (form) => {
    try {
      if (form.id) {
        await api.put(`/quality/checklists/${form.id}`, form);
      } else {
        await api.post('/quality/checklists', form);
      }
      setEditing(null); setShowNew(false);
      load();
    } catch(e) {
      toast.error(e?.response?.data?.error || e?.message || 'Failed to save checklist');
      setEditing(null); setShowNew(false);
      load();
    }
  };

  const ChecklistForm = ({ form, setForm, onCancel }) => (
    <div style={{ background:'#faf5ff', border:'1px solid #e9e4ff', borderRadius:10, padding:16, marginBottom:14 }}>
      <div style={{ display:'flex', gap:10, marginBottom:12 }}>
        <input value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="Checklist name"
          style={{ flex:2, padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }}/>
        <select value={form.type} onChange={e=>setForm(f=>({...f,type:e.target.value}))}
          style={{ flex:1, padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }}>
          {['inward','in-process','final','fat','periodic'].map(t=><option key={t}>{t}</option>)}
        </select>
      </div>
      {(form.items||[]).map((item,i)=>(
        <div key={i} style={{ display:'flex', gap:8, marginBottom:6, alignItems:'center' }}>
          <span style={{ fontSize:12, color:'#9ca3af', width:18 }}>{i+1}</span>
          <input value={item.criteria} onChange={e=>{const items=[...form.items];items[i]={...items[i],criteria:e.target.value};setForm(f=>({...f,items}));}}
            placeholder="Criteria / question" style={{ flex:2, padding:'5px 8px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12 }}/>
          <select value={item.measurement_type} onChange={e=>{const items=[...form.items];items[i]={...items[i],measurement_type:e.target.value};setForm(f=>({...f,items}));}}
            style={{ padding:'5px 8px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12 }}>
            <option value="pass_fail">Pass/Fail</option>
            <option value="numeric">Numeric</option>
            <option value="text">Text</option>
          </select>
          {item.measurement_type==='numeric' && <>
            <input type="number" placeholder="Min" value={item.min||''} onChange={e=>{const items=[...form.items];items[i]={...items[i],min:e.target.value};setForm(f=>({...f,items}));}}
              style={{ width:55, padding:'5px 6px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12 }}/>
            <input type="number" placeholder="Max" value={item.max||''} onChange={e=>{const items=[...form.items];items[i]={...items[i],max:e.target.value};setForm(f=>({...f,items}));}}
              style={{ width:55, padding:'5px 6px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12 }}/>
          </>}
          <button onClick={()=>{const items=form.items.filter((_,j)=>j!==i);setForm(f=>({...f,items}));}}
            style={{ background:'none', border:'none', color:'#dc2626', cursor:'pointer', fontSize:14 }}>✕</button>
        </div>
      ))}
      <div style={{ display:'flex', gap:8, marginTop:10 }}>
        <button onClick={()=>addItem(setForm)}
          style={{ background:'#ede9fe', color:'#6B3FDB', border:'none', borderRadius:7, padding:'5px 12px', cursor:'pointer', fontSize:12, fontWeight:600 }}>
          + Add Question
        </button>
        <button onClick={()=>saveChecklist(form)}
          style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:7, padding:'5px 16px', cursor:'pointer', fontSize:12, fontWeight:700 }}>
          Save
        </button>
        <button onClick={onCancel}
          style={{ background:'#f3f4f6', color:'#374151', border:'none', borderRadius:7, padding:'5px 12px', cursor:'pointer', fontSize:12 }}>
          Cancel
        </button>
      </div>
    </div>
  );

  const typeColor = { inward:'#dbeafe|#2563eb', 'in-process':'#fef3c7|#d97706', final:'#d1fae5|#16a34a', fat:'#ede9fe|#6B3FDB', periodic:'#f3f4f6|#6b7280' };

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:14 }}>
        <button onClick={()=>{ setShowNew(true); setNewForm({ name:'', type:'inward', items:[] }); }}
          style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'7px 16px', cursor:'pointer', fontWeight:600, fontSize:13 }}>
          + New Checklist
        </button>
      </div>
      {showNew && <ChecklistForm form={newForm} setForm={setNewForm} onCancel={()=>setShowNew(false)}/>}
      <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
        {lists.map(cl=>(
          <div key={cl.id}>
            {editing?.id===cl.id ? (
              <ChecklistForm form={editing} setForm={setEditing} onCancel={()=>setEditing(null)}/>
            ) : (
              <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:10, padding:'12px 16px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                    <span style={{ fontWeight:700, color:'#1f2937', fontSize:14 }}>{cl.name}</span>
                    {(() => {
                      const [bg, color] = (typeColor[cl.type] || '#f3f4f6|#6b7280').split('|');
                      return <span style={{ fontSize:11, padding:'2px 8px', borderRadius:10, fontWeight:600, background:bg, color }}>{cl.type}</span>;
                    })()}
                    <span style={{ fontSize:11, color:'#9ca3af' }}>{(cl.items||[]).length} items</span>
                  </div>
                  <button onClick={()=>setEditing({...cl, items: cl.items||[]})}
                    style={{ background:'#ede9fe', color:'#6B3FDB', border:'none', borderRadius:7, padding:'4px 12px', cursor:'pointer', fontSize:12, fontWeight:600 }}>
                    Edit
                  </button>
                </div>
                <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                  {(cl.items||[]).map((item,i)=>(
                    <span key={i} style={{ fontSize:11, background:'#f5f3ff', color:'#6b7280', padding:'2px 8px', borderRadius:8 }}>
                      {i+1}. {item.criteria} ({item.measurement_type==='pass_fail'?'P/F':item.measurement_type==='numeric'?`${item.min}–${item.max}${item.unit||''}`:item.measurement_type})
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
        {!lists.length && <p style={{ color:'#9ca3af', fontSize:13, textAlign:'center', padding:24 }}>No checklists yet. Create your first one above.</p>}
      </div>
    </div>
  );
}

/* ══════════════════════
   TAB 2 — Inspection Reports
══════════════════════ */
function ReportsTab() {
  const toast = useToast();
  const [reports, setReports]   = useState([]);
  const [checklists, setCLs]    = useState([]);
  const [showInspect, setShow]  = useState(false);
  const [selCL, setSelCL]       = useState(null);
  const [inspForm, setInspForm] = useState({});
  const [submitting, setSub]    = useState(false);
  const [refType, setRefType]   = useState('GR');
  const [refId, setRefId]       = useState('');
  const [inspector, setInspector] = useState('');

  const load = useCallback(async () => {
    try {
      const [rRes, cRes] = await Promise.allSettled([
        api.get('/quality/reports'),
        api.get('/quality/checklists'),
      ]);
      if (rRes.status==='fulfilled') setReports(rRes.value.data?.data || rRes.value.data || []);
      if (cRes.status==='fulfilled') setCLs(cRes.value.data?.data || cRes.value.data || []);
    } catch { /* empty on error */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    if (!selCL) return;
    setSub(true);
    try {
      await api.post('/quality/inspect', {
        checklist_id: selCL.id, reference_type: refType,
        reference_id: refId, inspector_name: inspector, results: inspForm,
      });
      setShow(false); setSelCL(null); setInspForm({}); load();
      toast.success('Inspection submitted');
    } catch(e) {
      toast.error(e?.response?.data?.error || e?.message || 'Failed to submit inspection');
      setShow(false);
      load();
    }
    setSub(false);
  };

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:14 }}>
        <button onClick={()=>setShow(true)}
          style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'7px 16px', cursor:'pointer', fontWeight:600, fontSize:13 }}>
          + New Inspection
        </button>
      </div>

      {showInspect && (
        <div style={{ background:'#faf5ff', border:'1px solid #a78bfa', borderRadius:10, padding:18, marginBottom:16 }}>
          <h4 style={{ margin:'0 0 12px', color:'#4c1d95' }}>New Inspection Report</h4>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))', gap:10, marginBottom:14 }}>
            <div>
              <label style={{ display:'block', fontSize:11, fontWeight:600, color:'#4c1d95', marginBottom:4 }}>Checklist</label>
              <select value={selCL?.id||''} onChange={e=>{const cl=checklists.find(c=>String(c.id)===e.target.value);setSelCL(cl||null);setInspForm({});}}
                style={{ width:'100%', padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }}>
                <option value="">Select…</option>
                {checklists.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label style={{ display:'block', fontSize:11, fontWeight:600, color:'#4c1d95', marginBottom:4 }}>Reference Type</label>
              <select value={refType} onChange={e=>setRefType(e.target.value)}
                style={{ width:'100%', padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }}>
                <option>GR</option><option>production_order</option><option>batch</option>
              </select>
            </div>
            <div>
              <label style={{ display:'block', fontSize:11, fontWeight:600, color:'#4c1d95', marginBottom:4 }}>Reference Number</label>
              <input value={refId} onChange={e=>setRefId(e.target.value)} placeholder="e.g. GR-2026-042"
                style={{ width:'100%', boxSizing:'border-box', padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }}/>
            </div>
            <div>
              <label style={{ display:'block', fontSize:11, fontWeight:600, color:'#4c1d95', marginBottom:4 }}>Inspector</label>
              <input value={inspector} onChange={e=>setInspector(e.target.value)} placeholder="Inspector name"
                style={{ width:'100%', boxSizing:'border-box', padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }}/>
            </div>
          </div>

          {selCL && (
            <div style={{ marginBottom:14 }}>
              {(selCL.items||[]).map(item=>(
                <div key={item.step} style={{ display:'flex', alignItems:'center', gap:12, padding:'8px 0', borderBottom:'1px solid #f0ebff' }}>
                  <span style={{ width:18, fontSize:12, color:'#9ca3af' }}>{item.step}</span>
                  <span style={{ flex:1, fontSize:13, color:'#374151' }}>{item.criteria}</span>
                  {item.measurement_type==='pass_fail' ? (
                    <div style={{ display:'flex', gap:6 }}>
                      <button onClick={()=>setInspForm(f=>({...f,[item.step]:true}))}
                        style={{ padding:'4px 12px', border:'none', borderRadius:6, cursor:'pointer', fontWeight:700, fontSize:12,
                          background:inspForm[item.step]===true?'#16a34a':'#f3f4f6', color:inspForm[item.step]===true?'#fff':'#374151' }}>Pass</button>
                      <button onClick={()=>setInspForm(f=>({...f,[item.step]:false}))}
                        style={{ padding:'4px 12px', border:'none', borderRadius:6, cursor:'pointer', fontWeight:700, fontSize:12,
                          background:inspForm[item.step]===false?'#dc2626':'#f3f4f6', color:inspForm[item.step]===false?'#fff':'#374151' }}>Fail</button>
                    </div>
                  ) : (
                    <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                      <input type="number" value={inspForm[item.step]||''} onChange={e=>setInspForm(f=>({...f,[item.step]:e.target.value}))}
                        placeholder={item.min!=null||item.max!=null ? `${item.min??''}–${item.max??''}` : 'Value'}
                        style={{ width:90, padding:'5px 8px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:13 }}/>
                      {item.unit && <span style={{ fontSize:11, color:'#9ca3af' }}>{item.unit}</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div style={{ display:'flex', gap:8 }}>
            <button onClick={submit} disabled={submitting||!selCL}
              style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'8px 20px', cursor:'pointer', fontWeight:700, fontSize:13, opacity:(!selCL)?0.5:1 }}>
              {submitting?'Submitting…':'Submit Inspection'}
            </button>
            <button onClick={()=>{setShow(false);setSelCL(null);setInspForm({});}}
              style={{ background:'#f3f4f6', color:'#374151', border:'none', borderRadius:8, padding:'8px 16px', cursor:'pointer', fontSize:13 }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div style={{ overflowX:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
          <thead>
            <tr style={{ background:'#f5f3ff' }}>
              {['Date','Checklist','Reference','Inspector','Result'].map(h=>(
                <th key={h} style={{ padding:'9px 12px', textAlign:'left', borderBottom:'1px solid #e9e4ff', color:'#4c1d95', fontWeight:600, fontSize:12 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {reports.map(r=>(
              <tr key={r.id} style={{ borderBottom:'1px solid #f0ebff' }}>
                <td style={{ padding:'9px 12px', color:'#9ca3af', fontSize:11 }}>
                  {r.inspected_at ? new Date(r.inspected_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                </td>
                <td style={{ padding:'9px 12px', fontWeight:600, color:'#374151' }}>{r.checklist_name}</td>
                <td style={{ padding:'9px 12px', color:'#6B3FDB', fontWeight:600 }}>{r.reference_type} {r.reference_id ? `#${r.reference_id}` : ''}</td>
                <td style={{ padding:'9px 12px', color:'#6b7280' }}>{r.inspector_name}</td>
                <td style={{ padding:'9px 12px' }}>{statusBadge(r.status)}</td>
              </tr>
            ))}
            {!reports.length && (
              <tr><td colSpan={5} style={{ padding:24, textAlign:'center', color:'#9ca3af', fontSize:13 }}>No inspection reports yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ══════════════════════
   TAB 3 — NCR Board
══════════════════════ */
function NCRTab() {
  const toast = useToast();
  const [ncrs, setNCRs]         = useState([]);
  const [selected, setSelected] = useState(null);
  const [showNew, setShowNew]   = useState(false);
  const [newForm, setNewForm]   = useState({ title:'', description:'', severity:'minor', detected_by:'' });

  const load = useCallback(async () => {
    try {
      const res = await api.get('/quality/ncr');
      setNCRs(res.data?.data || res.data || []);
    } catch { setNCRs([]); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const updateNCR = async (id, updates) => {
    try {
      await api.put(`/quality/ncr/${id}`, updates);
      setNCRs(prev => prev.map(n => n.id===id ? {...n,...updates} : n));
      setSelected(n => n?.id===id ? {...n,...updates} : n);
    } catch(e) {
      toast.error(e?.response?.data?.error || e?.message || 'Failed to update NCR');
    }
  };

  const resolveNCR = async (id, resolution) => {
    try {
      await api.patch(`/quality/ncr/${id}/resolve`, { resolution });
      setNCRs(prev => prev.map(n => n.id===id ? {...n, status:'resolved', resolution} : n));
      setSelected(n => n?.id===id ? {...n, status:'resolved', resolution} : n);
      toast.success('NCR resolved');
    } catch(e) {
      toast.error(e?.response?.data?.error || e?.message || 'Failed to resolve NCR');
    }
  };

  const createNCR = async () => {
    if (!newForm.title) { toast.error('Title is required'); return; }
    try {
      await api.post('/quality/ncr', newForm);
      setShowNew(false);
      setNewForm({ title:'', description:'', severity:'minor', detected_by:'' });
      load();
      toast.success('NCR raised');
    } catch(e) {
      toast.error(e?.response?.data?.error || e?.message || 'Failed to create NCR');
      setShowNew(false);
      load();
    }
  };

  const columns = [
    { key:'open',         label:'Open',         color:'#dc2626', bg:'#fee2e2' },
    { key:'under-review', label:'Under Review',  color:'#d97706', bg:'#fef3c7' },
    { key:'resolved',     label:'Resolved',      color:'#2563eb', bg:'#dbeafe' },
    { key:'closed',       label:'Closed',        color:'#16a34a', bg:'#d1fae5' },
  ];

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:14 }}>
        <button onClick={()=>setShowNew(true)}
          style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'7px 16px', cursor:'pointer', fontWeight:600, fontSize:13 }}>
          + Raise NCR
        </button>
      </div>

      {showNew && (
        <div style={{ background:'#faf5ff', border:'1px solid #a78bfa', borderRadius:10, padding:16, marginBottom:14 }}>
          <h4 style={{ margin:'0 0 12px', color:'#4c1d95', fontSize:14 }}>Raise Non-Conformance Report</h4>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:10 }}>
            <input value={newForm.title} onChange={e=>setNewForm(f=>({...f,title:e.target.value}))} placeholder="NCR title *"
              style={{ padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }}/>
            <select value={newForm.severity} onChange={e=>setNewForm(f=>({...f,severity:e.target.value}))}
              style={{ padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }}>
              <option value="minor">Minor</option>
              <option value="major">Major</option>
              <option value="critical">Critical</option>
            </select>
          </div>
          <textarea value={newForm.description} onChange={e=>setNewForm(f=>({...f,description:e.target.value}))} placeholder="Description of non-conformance…" rows={2}
            style={{ width:'100%', boxSizing:'border-box', padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13, resize:'vertical', marginBottom:10 }}/>
          <input value={newForm.detected_by} onChange={e=>setNewForm(f=>({...f,detected_by:e.target.value}))} placeholder="Detected by"
            style={{ padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13, marginBottom:10, display:'block', width:'100%', boxSizing:'border-box' }}/>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={createNCR} style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:7, padding:'6px 16px', cursor:'pointer', fontWeight:700, fontSize:13 }}>Submit NCR</button>
            <button onClick={()=>setShowNew(false)} style={{ background:'#f3f4f6', color:'#374151', border:'none', borderRadius:7, padding:'6px 12px', cursor:'pointer', fontSize:13 }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Kanban board — 4 columns */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12 }}>
        {columns.map(col=>(
          <div key={col.key}>
            <div style={{ padding:'8px 12px', background:col.bg, borderRadius:'8px 8px 0 0', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <span style={{ fontWeight:700, color:col.color, fontSize:12 }}>{col.label}</span>
              <span style={{ fontWeight:700, color:col.color, background:'#fff', borderRadius:'50%', width:20, height:20, display:'flex', alignItems:'center', justifyContent:'center', fontSize:11 }}>
                {ncrs.filter(n=>n.status===col.key).length}
              </span>
            </div>
            <div style={{ background:'#f9f8ff', border:'1px solid #e9e4ff', borderTop:'none', borderRadius:'0 0 8px 8px', padding:8, minHeight:180, display:'flex', flexDirection:'column', gap:8 }}>
              {ncrs.filter(n=>n.status===col.key).map(ncr=>(
                <div key={ncr.id} onClick={()=>setSelected(ncr)}
                  style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:8, padding:10, cursor:'pointer', boxShadow:'0 1px 3px rgba(0,0,0,0.04)' }}>
                  <div style={{ fontWeight:600, color:'#6B3FDB', fontSize:10, marginBottom:2 }}>{ncr.ncr_number}</div>
                  <div style={{ fontWeight:700, color:'#1f2937', fontSize:12, marginBottom:5, lineHeight:1.3 }}>{ncr.title}</div>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    {sevBadge(ncr.severity)}
                    {ncr.days_open != null && <span style={{ fontSize:10, color:'#9ca3af' }}>{ncr.days_open}d</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* NCR Detail Drawer */}
      {selected && (
        <div style={{ position:'fixed', right:0, top:0, bottom:0, width:380, background:'#fff', boxShadow:'-4px 0 20px rgba(0,0,0,0.12)', zIndex:500, overflowY:'auto', padding:24 }}>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:18 }}>
            <div>
              <div style={{ fontWeight:700, color:'#6B3FDB', fontSize:12 }}>{selected.ncr_number}</div>
              <h3 style={{ margin:'4px 0 0', color:'#1f2937', fontSize:16 }}>{selected.title}</h3>
            </div>
            <button onClick={()=>setSelected(null)} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:'#6b7280' }}>✕</button>
          </div>
          <div style={{ marginBottom:12 }}>{sevBadge(selected.severity)}</div>
          <p style={{ fontSize:13, color:'#6b7280', lineHeight:1.6, marginBottom:14 }}>{selected.description}</p>
          <div style={{ marginBottom:12 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:600, color:'#4c1d95', marginBottom:4 }}>Root Cause</label>
            <textarea defaultValue={selected.root_cause||''} rows={2}
              onBlur={e=>updateNCR(selected.id,{root_cause:e.target.value})}
              style={{ width:'100%', boxSizing:'border-box', padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13, resize:'vertical' }}/>
          </div>
          <div style={{ marginBottom:12 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:600, color:'#4c1d95', marginBottom:4 }}>Disposition</label>
            <select defaultValue={selected.disposition||''} onChange={e=>updateNCR(selected.id,{disposition:e.target.value})}
              style={{ width:'100%', padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }}>
              <option value=''>Select…</option>
              {['use-as-is','rework','scrap','return'].map(d=><option key={d}>{d}</option>)}
            </select>
          </div>
          {selected.status !== 'resolved' && selected.status !== 'closed' && (
            <div style={{ marginBottom:12 }}>
              <label style={{ display:'block', fontSize:11, fontWeight:600, color:'#4c1d95', marginBottom:4 }}>Resolution notes</label>
              <textarea id="resolution-text" rows={2} placeholder="Describe resolution…"
                style={{ width:'100%', boxSizing:'border-box', padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13, resize:'vertical' }}/>
              <button onClick={()=>{
                const txt = document.getElementById('resolution-text')?.value || '';
                resolveNCR(selected.id, txt);
              }}
                style={{ marginTop:6, background:'#6B3FDB', color:'#fff', border:'none', borderRadius:7, padding:'5px 14px', cursor:'pointer', fontSize:12, fontWeight:600 }}>
                Mark Resolved
              </button>
            </div>
          )}
          <div style={{ marginBottom:16 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:600, color:'#4c1d95', marginBottom:4 }}>Move Status</label>
            <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
              {['open','under-review','resolved','closed'].map(s=>(
                <button key={s} onClick={()=>updateNCR(selected.id,{status:s})}
                  style={{ flex:1, minWidth:70, padding:'5px', border:'none', borderRadius:7, cursor:'pointer', fontWeight:600, fontSize:11,
                    background: selected.status===s?'#6B3FDB':'#f3f4f6',
                    color:      selected.status===s?'#fff':'#374151' }}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════
   TAB 4 — CAPA
══════════════════════ */
function CAPATab() {
  const toast = useToast();
  const [capas, setCAPAs]     = useState([]);
  const [ncrs, setNCRs]       = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [newForm, setNewForm] = useState({ ncr_id:'', action_type:'corrective', description:'', assigned_to:'', due_date:'' });

  const load = useCallback(async () => {
    try {
      const [cRes, nRes] = await Promise.allSettled([
        api.get('/quality/capa'),
        api.get('/quality/ncr'),
      ]);
      if (cRes.status==='fulfilled') setCAPAs(cRes.value.data?.data || cRes.value.data || []);
      if (nRes.status==='fulfilled') setNCRs(nRes.value.data?.data || nRes.value.data || []);
    } catch { /* silent */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const updateStatus = async (id, status) => {
    try {
      const updates = { status, ...(status==='completed' ? { completion_date: new Date().toISOString().split('T')[0] } : {}) };
      await api.put(`/quality/capa/${id}`, updates);
      setCAPAs(prev => prev.map(c => c.id===id ? {...c,...updates} : c));
    } catch(e) {
      toast.error(e?.response?.data?.error || e?.message || 'Failed to update CAPA status');
    }
  };

  const createCAPA = async () => {
    if (!newForm.ncr_id || !newForm.description) { toast.error('NCR and description are required'); return; }
    try {
      await api.post('/quality/capa', newForm);
      setShowNew(false);
      setNewForm({ ncr_id:'', action_type:'corrective', description:'', assigned_to:'', due_date:'' });
      load();
      toast.success('CAPA created');
    } catch(e) {
      toast.error(e?.response?.data?.error || e?.message || 'Failed to create CAPA');
    }
  };

  const Stars = ({ rating }) => (
    <span>{[1,2,3,4,5].map(i => <span key={i} style={{ color: i<=(rating||0)?'#f59e0b':'#d1d5db', fontSize:14 }}>★</span>)}</span>
  );

  const statusColors = { open:'#fef3c7|#d97706', 'in-progress':'#dbeafe|#2563eb', completed:'#d1fae5|#16a34a', verified:'#ede9fe|#6B3FDB' };

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:14 }}>
        <button onClick={()=>setShowNew(s=>!s)}
          style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'7px 16px', cursor:'pointer', fontWeight:600, fontSize:13 }}>
          {showNew ? '✕ Cancel' : '+ New CAPA'}
        </button>
      </div>

      {showNew && (
        <div style={{ background:'#faf5ff', border:'1px solid #a78bfa', borderRadius:10, padding:16, marginBottom:14 }}>
          <h4 style={{ margin:'0 0 12px', color:'#4c1d95', fontSize:14 }}>New CAPA Action</h4>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:10 }}>
            <div>
              <label style={{ display:'block', fontSize:11, fontWeight:600, color:'#4c1d95', marginBottom:3 }}>Linked NCR *</label>
              <select value={newForm.ncr_id} onChange={e=>setNewForm(f=>({...f,ncr_id:e.target.value}))}
                style={{ width:'100%', padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }}>
                <option value="">Select NCR…</option>
                {ncrs.map(n=><option key={n.id} value={n.id}>{n.ncr_number} — {n.title?.slice(0,40)}</option>)}
              </select>
            </div>
            <div>
              <label style={{ display:'block', fontSize:11, fontWeight:600, color:'#4c1d95', marginBottom:3 }}>Type</label>
              <select value={newForm.action_type} onChange={e=>setNewForm(f=>({...f,action_type:e.target.value}))}
                style={{ width:'100%', padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }}>
                <option value="corrective">Corrective</option>
                <option value="preventive">Preventive</option>
              </select>
            </div>
            <div>
              <label style={{ display:'block', fontSize:11, fontWeight:600, color:'#4c1d95', marginBottom:3 }}>Assigned To</label>
              <input value={newForm.assigned_to} onChange={e=>setNewForm(f=>({...f,assigned_to:e.target.value}))} placeholder="Name"
                style={{ width:'100%', boxSizing:'border-box', padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }}/>
            </div>
            <div>
              <label style={{ display:'block', fontSize:11, fontWeight:600, color:'#4c1d95', marginBottom:3 }}>Due Date</label>
              <input type="date" value={newForm.due_date} onChange={e=>setNewForm(f=>({...f,due_date:e.target.value}))}
                style={{ width:'100%', boxSizing:'border-box', padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }}/>
            </div>
          </div>
          <div style={{ marginBottom:10 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:600, color:'#4c1d95', marginBottom:3 }}>Description *</label>
            <textarea value={newForm.description} onChange={e=>setNewForm(f=>({...f,description:e.target.value}))} rows={2} placeholder="Describe the corrective / preventive action…"
              style={{ width:'100%', boxSizing:'border-box', padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13, resize:'vertical' }}/>
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={createCAPA} style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:7, padding:'6px 16px', cursor:'pointer', fontWeight:700, fontSize:13 }}>Create CAPA</button>
            <button onClick={()=>setShowNew(false)} style={{ background:'#f3f4f6', color:'#374151', border:'none', borderRadius:7, padding:'6px 12px', cursor:'pointer', fontSize:13 }}>Cancel</button>
          </div>
        </div>
      )}

      <div style={{ overflowX:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
          <thead>
            <tr style={{ background:'#f5f3ff' }}>
              {['NCR Ref','Type','Description','Assigned To','Due Date','Status','Effectiveness','Action'].map(h=>(
                <th key={h} style={{ padding:'9px 12px', textAlign:'left', borderBottom:'1px solid #e9e4ff', color:'#4c1d95', fontWeight:600, fontSize:12 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {capas.map(c=>{
              const [sbg, scolor] = (statusColors[c.status] || '#f3f4f6|#6b7280').split('|');
              return (
                <tr key={c.id} style={{ borderBottom:'1px solid #f0ebff', background: c.overdue?'#fff5f5':'#fff' }}>
                  <td style={{ padding:'9px 12px' }}>
                    <div style={{ fontWeight:600, color:'#6B3FDB', fontSize:11 }}>{c.ncr_number}</div>
                    <div style={{ fontSize:11, color:'#6b7280' }}>{c.ncr_title?.slice(0,25)}</div>
                  </td>
                  <td style={{ padding:'9px 12px' }}>
                    <span style={{ fontSize:11, padding:'2px 8px', borderRadius:10, fontWeight:700,
                      background: c.action_type==='corrective'?'#fee2e2':'#dbeafe',
                      color:      c.action_type==='corrective'?'#dc2626':'#2563eb' }}>
                      {c.action_type}
                    </span>
                  </td>
                  <td style={{ padding:'9px 12px', fontSize:12, color:'#374151', maxWidth:200 }}>{c.description}</td>
                  <td style={{ padding:'9px 12px', color:'#6b7280' }}>{c.assigned_to || c.employee_name}</td>
                  <td style={{ padding:'9px 12px' }}>
                    <span style={{ color: c.overdue?'#dc2626':'#6b7280', fontWeight: c.overdue?700:400 }}>
                      {c.due_date ? new Date(c.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                      {c.overdue && ' ⚠'}
                    </span>
                  </td>
                  <td style={{ padding:'9px 12px' }}>
                    <span style={{ fontSize:11, padding:'2px 8px', borderRadius:10, fontWeight:700, background:sbg, color:scolor }}>{c.status}</span>
                  </td>
                  <td style={{ padding:'9px 12px' }}>
                    {c.status==='completed'||c.status==='verified'
                      ? <Stars rating={c.effectiveness_rating}/>
                      : <span style={{ color:'#9ca3af', fontSize:11 }}>—</span>}
                  </td>
                  <td style={{ padding:'9px 12px' }}>
                    {c.status==='open' && (
                      <button onClick={()=>updateStatus(c.id,'in-progress')}
                        style={{ background:'#dbeafe', color:'#2563eb', border:'none', borderRadius:6, padding:'3px 8px', cursor:'pointer', fontSize:11, fontWeight:600 }}>
                        Start
                      </button>
                    )}
                    {c.status==='in-progress' && (
                      <button onClick={()=>updateStatus(c.id,'completed')}
                        style={{ background:'#d1fae5', color:'#16a34a', border:'none', borderRadius:6, padding:'3px 8px', cursor:'pointer', fontSize:11, fontWeight:600 }}>
                        Complete
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!capas.length && (
              <tr><td colSpan={8} style={{ padding:24, textAlign:'center', color:'#9ca3af', fontSize:13 }}>No CAPA actions yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ══════════════════════════════════
   MAIN PAGE
══════════════════════════════════ */
const TABS = ['Inspection Checklists', 'Inspection Reports', 'NCR Board', 'CAPA'];

export default function QualityManagement() {
  const [tab, setTab] = useState('Inspection Checklists');

  const tabStyle = (t) => ({
    padding:'9px 18px', border:'none', cursor:'pointer', fontWeight:600, fontSize:13,
    background: tab===t ? '#6B3FDB' : 'transparent',
    color:      tab===t ? '#fff'    : '#6B3FDB',
    borderBottom: tab===t ? '2px solid #6B3FDB' : '2px solid transparent',
  });

  return (
    <div style={{ padding:24, background:'#f5f3ff', minHeight:'100vh' }}>
      <div style={{ marginBottom:20 }}>
        <h2 style={{ margin:'0 0 4px', color:'#4c1d95', fontSize:22 }}>Quality Management</h2>
        <p style={{ margin:0, color:'#6b7280', fontSize:13 }}>Inspection checklists, NCR tracking, and corrective action management</p>
      </div>

      <div style={{ display:'flex', gap:0, borderBottom:'2px solid #e9e4ff', background:'#fff', borderRadius:'10px 10px 0 0', padding:'0 8px', flexWrap:'wrap' }}>
        {TABS.map(t=><button key={t} style={tabStyle(t)} onClick={()=>setTab(t)}>{t}</button>)}
      </div>
      <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderTop:'none', borderRadius:'0 0 10px 10px', padding:20 }}>
        {tab==='Inspection Checklists' && <ChecklistsTab />}
        {tab==='Inspection Reports'    && <ReportsTab />}
        {tab==='NCR Board'             && <NCRTab />}
        {tab==='CAPA'                  && <CAPATab />}
      </div>
    </div>
  );
}
