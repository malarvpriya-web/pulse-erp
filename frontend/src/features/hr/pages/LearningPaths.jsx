// frontend/src/features/hr/pages/LearningPaths.jsx
import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/context/ToastContext';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const inputStyle = { width:'100%', boxSizing:'border-box', padding:'8px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 };

function Modal({ title, onClose, children, wide }) {
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}>
      <div style={{ background:'#fff', borderRadius:12, padding:24, width:'100%', maxWidth: wide ? 760 : 540, maxHeight:'90vh', overflowY:'auto' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
          <h3 style={{ margin:0, color:'#4c1d95', fontSize:16 }}>{title}</h3>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', fontSize:20, color:'#6b7280' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function LearningPaths() {
  const toast = useToast();
  const [paths, setPaths] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [selectedPath, setSelectedPath] = useState(null);
  const [pathItems, setPathItems] = useState([]);
  const [progress, setProgress] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editPath, setEditPath] = useState(null);
  const [showItemsModal, setShowItemsModal] = useState(false);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [showProgressModal, setShowProgressModal] = useState(false);
  const [assignIds, setAssignIds] = useState([]);
  const [assignDue, setAssignDue] = useState('');
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ name:'', description:'', path_type:'role', target_role:'', target_department:'' });
  const [pendingArchivePath, setPendingArchivePath] = useState(null);
  const [deptList, setDeptList] = useState([]);

  const load = useCallback(async () => {
    const [pRes, prRes] = await Promise.allSettled([
      api.get('/learning-paths'),
      api.get('/training/programs'),
    ]);
    if (pRes.status === 'fulfilled') setPaths(pRes.value.data || []);
    if (prRes.status === 'fulfilled') setPrograms(prRes.value.data || []);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/orgchart/departments')
      .then(r => setDeptList(Array.isArray(r.data.data) ? r.data.data : []))
      .catch(() => setDeptList([]));
  }, []);

  const savePath = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (editPath) {
        await api.put(`/learning-paths/${editPath.id}`, form);
        toast.success('Path updated');
      } else {
        await api.post('/learning-paths', form);
        toast.success('Learning path created');
      }
      setShowForm(false); setEditPath(null);
      setForm({ name:'', description:'', path_type:'role', target_role:'', target_department:'' });
      load();
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed'); }
    finally { setLoading(false); }
  };

  const openItems = async (path) => {
    setSelectedPath(path);
    try {
      const r = await api.get(`/learning-paths/${path.id}`);
      setPathItems((r.data?.items || []).map(it => ({ program_id: it.program_id, sequence_order: it.sequence_order, is_mandatory: it.is_mandatory, title: it.title })));
    } catch { setPathItems([]); }
    setShowItemsModal(true);
  };

  const saveItems = async () => {
    setLoading(true);
    try {
      const payload = pathItems.map((it, i) => ({ program_id: parseInt(it.program_id), sequence_order: i + 1, is_mandatory: it.is_mandatory !== false }));
      await api.put(`/learning-paths/${selectedPath.id}/items`, { items: payload });
      toast.success('Path items saved');
      setShowItemsModal(false);
      load();
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed'); }
    finally { setLoading(false); }
  };

  const addItem = (programId) => {
    const prog = programs.find(p => p.id === parseInt(programId));
    if (!prog || pathItems.find(it => it.program_id === parseInt(programId))) return;
    setPathItems(items => [...items, { program_id: parseInt(programId), sequence_order: items.length + 1, is_mandatory: true, title: prog.title }]);
  };

  const removeItem = (idx) => setPathItems(items => items.filter((_, i) => i !== idx));

  const moveItem = (idx, dir) => {
    setPathItems(items => {
      const n = [...items];
      const target = idx + dir;
      if (target < 0 || target >= n.length) return n;
      [n[idx], n[target]] = [n[target], n[idx]];
      return n.map((it, i) => ({ ...it, sequence_order: i + 1 }));
    });
  };

  const assignPath = async () => {
    if (!assignIds.length) { toast.error('Select at least one employee'); return; }
    setLoading(true);
    try {
      await api.post(`/learning-paths/${selectedPath.id}/assign`, { employee_ids: assignIds, due_date: assignDue || undefined });
      toast.success(`Path assigned to ${assignIds.length} employee(s)`);
      setShowAssignModal(false); setAssignIds([]); setAssignDue('');
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed'); }
    finally { setLoading(false); }
  };

  const openProgress = async (path) => {
    setSelectedPath(path);
    try {
      const r = await api.get(`/learning-paths/${path.id}/progress`);
      setProgress(r.data || []);
    } catch { setProgress([]); }
    setShowProgressModal(true);
  };

  const archivePath = async () => {
    if (!pendingArchivePath) return;
    const id = pendingArchivePath;
    setPendingArchivePath(null);
    try { await api.delete(`/learning-paths/${id}`); toast.success('Archived'); load(); }
    catch (err) { toast.error(err?.response?.data?.error || 'Failed'); }
  };

  return (
    <div style={{ padding:24, background:'#f5f3ff', minHeight:'100vh' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20, flexWrap:'wrap', gap:10 }}>
        <div>
          <h2 style={{ margin:0, color:'#4c1d95', fontSize:22 }}>🛤️ Learning Paths</h2>
          <p style={{ margin:0, color:'#6b7280', fontSize:13 }}>Build role-based or onboarding learning journeys</p>
        </div>
        <button onClick={() => { setShowForm(true); setEditPath(null); setForm({ name:'', description:'', path_type:'role', target_role:'', target_department:'' }); }}
          style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'8px 18px', cursor:'pointer', fontWeight:600 }}>
          + New Learning Path
        </button>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(320px,1fr))', gap:16 }}>
        {paths.map(path => (
          <div key={path.id} style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:12, padding:20 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:8 }}>
              <h4 style={{ margin:0, color:'#4c1d95', fontSize:15 }}>{path.name}</h4>
              <span style={{ fontSize:11, padding:'2px 8px', borderRadius:10, background:'#e9e4ff', color:'#6B3FDB', fontWeight:600 }}>{path.path_type}</span>
            </div>
            {path.description && <p style={{ fontSize:12, color:'#6b7280', margin:'0 0 10px', lineHeight:1.5 }}>{path.description}</p>}
            <div style={{ display:'flex', gap:16, fontSize:12, color:'#6b7280', marginBottom:12, flexWrap:'wrap' }}>
              {path.target_role && <span>Role: <strong>{path.target_role}</strong></span>}
              {path.target_department && <span>Dept: <strong>{path.target_department}</strong></span>}
              <span>Programs: <strong>{path.total_items || 0}</strong></span>
              <span>Hours: <strong>{path.total_hours || 0}h</strong></span>
            </div>
            <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
              <button onClick={() => openItems(path)} style={{ padding:'5px 12px', background:'#e9e4ff', color:'#6B3FDB', border:'none', borderRadius:6, cursor:'pointer', fontWeight:600, fontSize:12 }}>Edit Items</button>
              <button onClick={() => {
                setSelectedPath(path); setShowAssignModal(true); setAssignIds([]); setAssignDue('');
                api.get('/employees').then(r => setEmployees((r.data || []).filter(e => !['left','terminated'].includes((e.status || '').toLowerCase())))).catch(() => setEmployees([]));
              }} style={{ padding:'5px 12px', background:'#dcfce7', color:'#16a34a', border:'none', borderRadius:6, cursor:'pointer', fontWeight:600, fontSize:12 }}>Assign</button>
              <button onClick={() => openProgress(path)} style={{ padding:'5px 12px', background:'#fef3c7', color:'#d97706', border:'none', borderRadius:6, cursor:'pointer', fontWeight:600, fontSize:12 }}>Progress</button>
              <button onClick={() => { setEditPath(path); setForm({ name:path.name, description:path.description||'', path_type:path.path_type, target_role:path.target_role||'', target_department:path.target_department||'' }); setShowForm(true); }} style={{ padding:'5px 12px', background:'#f5f3ff', color:'#6b7280', border:'none', borderRadius:6, cursor:'pointer', fontWeight:600, fontSize:12 }}>Edit</button>
              <button onClick={() => setPendingArchivePath(path.id)} style={{ padding:'5px 12px', background:'#fef2f2', color:'#dc2626', border:'none', borderRadius:6, cursor:'pointer', fontWeight:600, fontSize:12 }}>Archive</button>
            </div>
          </div>
        ))}
        {paths.length === 0 && (
          <div style={{ gridColumn:'1/-1', textAlign:'center', padding:'48px 16px', color:'#9ca3af' }}>
            No learning paths defined. Create one to start building structured journeys.
          </div>
        )}
      </div>

      {/* Create / Edit path form */}
      {showForm && (
        <Modal title={editPath ? 'Edit Learning Path' : 'New Learning Path'} onClose={() => { setShowForm(false); setEditPath(null); }}>
          <form onSubmit={savePath}>
            <div style={{ marginBottom:12 }}>
              <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Path Name *</label>
              <input required value={form.name} onChange={e => setForm(f => ({...f, name:e.target.value}))} style={inputStyle} />
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Type</label>
              <select value={form.path_type} onChange={e => setForm(f => ({...f, path_type:e.target.value}))} style={inputStyle}>
                {['role','onboarding','upskilling','compliance','leadership'].map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 }}>
              <div>
                <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Target Role</label>
                <select value={form.target_role} onChange={e => setForm(f => ({...f, target_role:e.target.value}))} style={inputStyle}>
                  <option value="">-- Select Role --</option>
                  {['Engineer','Senior Engineer','Team Lead','Manager','Senior Manager','Director','VP','Analyst','Consultant','Executive','Other'].map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Target Department</label>
                <select value={form.target_department} onChange={e => setForm(f => ({...f, target_department:e.target.value}))} style={inputStyle}>
                  <option value="">-- Select Department --</option>
                  {deptList.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Description</label>
              <textarea value={form.description} onChange={e => setForm(f => ({...f, description:e.target.value}))} style={{...inputStyle, height:80, resize:'vertical'}} />
            </div>
            <div style={{ display:'flex', gap:10 }}>
              <button type="submit" disabled={loading} style={{ flex:1, background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'9px 0', cursor:'pointer', fontWeight:600 }}>
                {loading ? 'Saving…' : editPath ? 'Update' : 'Create'}
              </button>
              <button type="button" onClick={() => { setShowForm(false); setEditPath(null); }} style={{ flex:1, background:'#e9e4ff', color:'#6B3FDB', border:'none', borderRadius:8, padding:'9px 0', cursor:'pointer', fontWeight:600 }}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}

      {/* Items editor modal */}
      {showItemsModal && selectedPath && (
        <Modal title={`Programs in: ${selectedPath.name}`} wide onClose={() => setShowItemsModal(false)}>
          <div style={{ marginBottom:16 }}>
            <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:6 }}>Add Program</label>
            <select onChange={e => { addItem(e.target.value); e.target.value = ''; }} style={inputStyle} defaultValue="">
              <option value="">Select program to add…</option>
              {programs.filter(p => !pathItems.find(it => it.program_id === p.id)).map(p => (
                <option key={p.id} value={p.id}>{p.title} ({p.category}, {p.duration_hours}h)</option>
              ))}
            </select>
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:8, marginBottom:16 }}>
            {pathItems.map((it, i) => (
              <div key={i} style={{ display:'flex', alignItems:'center', gap:10, background:'#f5f3ff', borderRadius:8, padding:'10px 12px', border:'1px solid #e9e4ff' }}>
                <span style={{ width:24, height:24, background:'#6B3FDB', color:'#fff', borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:700, flexShrink:0 }}>{i+1}</span>
                <span style={{ flex:1, fontSize:13, fontWeight:600, color:'#1f2937' }}>{it.title}</span>
                <label style={{ fontSize:12, color:'#6b7280', display:'flex', alignItems:'center', gap:4 }}>
                  <input type="checkbox" checked={it.is_mandatory !== false} onChange={e => setPathItems(items => items.map((x,j) => j===i ? {...x, is_mandatory: e.target.checked} : x))} />
                  Mandatory
                </label>
                <button onClick={() => moveItem(i, -1)} disabled={i===0} style={{ background:'none', border:'none', cursor:'pointer', color:'#6B3FDB', fontSize:16 }}>↑</button>
                <button onClick={() => moveItem(i, 1)} disabled={i===pathItems.length-1} style={{ background:'none', border:'none', cursor:'pointer', color:'#6B3FDB', fontSize:16 }}>↓</button>
                <button onClick={() => removeItem(i)} style={{ background:'none', border:'none', cursor:'pointer', color:'#dc2626', fontSize:16 }}>✕</button>
              </div>
            ))}
            {pathItems.length === 0 && <p style={{ color:'#9ca3af', fontSize:13, textAlign:'center', padding:'20px 0' }}>No programs added yet</p>}
          </div>
          <div style={{ display:'flex', gap:10 }}>
            <button onClick={saveItems} disabled={loading} style={{ flex:1, background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'9px 0', cursor:'pointer', fontWeight:600 }}>
              {loading ? 'Saving…' : 'Save Path Items'}
            </button>
            <button onClick={() => setShowItemsModal(false)} style={{ flex:1, background:'#e9e4ff', color:'#6B3FDB', border:'none', borderRadius:8, padding:'9px 0', cursor:'pointer', fontWeight:600 }}>Cancel</button>
          </div>
        </Modal>
      )}

      {/* Assign modal */}
      {showAssignModal && selectedPath && (
        <Modal title={`Assign: ${selectedPath.name}`} onClose={() => { setShowAssignModal(false); setAssignIds([]); setAssignDue(''); }}>
          <p style={{ fontSize:13, color:'#6b7280', margin:'0 0 16px' }}>Assign this path to employees (will auto-enroll them in all programs).</p>
          <div style={{ marginBottom:12 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:4 }}>
              <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95' }}>Employees *</label>
              {assignIds.length > 0 && (
                <span style={{ fontSize:11, color:'#6B3FDB', fontWeight:600 }}>{assignIds.length} selected</span>
              )}
            </div>
            <div style={{ border:'1px solid #e9e4ff', borderRadius:7, maxHeight:160, overflowY:'auto', background:'#fff' }}>
              {employees.length === 0 ? (
                <p style={{ margin:0, padding:'12px', fontSize:12, color:'#9ca3af', textAlign:'center' }}>Loading employees…</p>
              ) : (
                employees.map(e => {
                  const id = e.id;
                  const checked = assignIds.includes(id);
                  const empName = e.name || `${e.first_name || ''} ${e.last_name || ''}`.trim() || `Employee #${id}`;
                  return (
                    <label key={id} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 12px', cursor:'pointer', borderBottom:'1px solid #f5f3ff', background: checked ? '#f5f3ff' : 'transparent' }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => setAssignIds(ids => checked ? ids.filter(x => x !== id) : [...ids, id])}
                        style={{ accentColor:'#6B3FDB', width:15, height:15, flexShrink:0 }}
                      />
                      <span style={{ flex:1, fontSize:13, color:'#1f2937' }}>{empName}</span>
                      {(e.department || e.designation) && (
                        <span style={{ fontSize:11, color:'#9ca3af' }}>{e.department}{e.department && e.designation ? ' · ' : ''}{e.designation}</span>
                      )}
                    </label>
                  );
                })
              )}
            </div>
          </div>
          <div style={{ marginBottom:16 }}>
            <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Due Date (optional)</label>
            <input type="date" value={assignDue} onChange={e => setAssignDue(e.target.value)} style={inputStyle} />
          </div>
          <div style={{ display:'flex', gap:10 }}>
            <button onClick={assignPath} disabled={loading} style={{ flex:1, background:'#16a34a', color:'#fff', border:'none', borderRadius:8, padding:'9px 0', cursor:'pointer', fontWeight:600 }}>
              {loading ? 'Assigning…' : 'Assign Path'}
            </button>
            <button onClick={() => { setShowAssignModal(false); setAssignIds([]); setAssignDue(''); }} style={{ flex:1, background:'#e9e4ff', color:'#6B3FDB', border:'none', borderRadius:8, padding:'9px 0', cursor:'pointer', fontWeight:600 }}>Cancel</button>
          </div>
        </Modal>
      )}

      <ConfirmDialog
        open={!!pendingArchivePath}
        title="Archive Learning Path"
        message="Archive this learning path?"
        confirmLabel="Archive"
        variant="warning"
        onConfirm={archivePath}
        onCancel={() => setPendingArchivePath(null)}
      />

      {/* Progress modal */}
      {showProgressModal && selectedPath && (
        <Modal title={`Progress: ${selectedPath.name}`} wide onClose={() => setShowProgressModal(false)}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead><tr style={{ background:'#f5f3ff' }}>
              {['Employee','Department','Progress','Items Done','Status','Due Date'].map(h => (
                <th key={h} style={{ padding:'8px 12px', textAlign:'left', borderBottom:'1px solid #e9e4ff', color:'#4c1d95', fontWeight:600 }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {progress.map(r => (
                <tr key={r.id} style={{ borderBottom:'1px solid #f0ebff' }}>
                  <td style={{ padding:'8px 12px', fontWeight:600 }}>{r.employee_name}</td>
                  <td style={{ padding:'8px 12px', color:'#6b7280' }}>{r.department}</td>
                  <td style={{ padding:'8px 12px' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <div style={{ flex:1, height:8, background:'#e9e4ff', borderRadius:4, overflow:'hidden' }}>
                        <div style={{ height:'100%', width:`${r.progress_pct||0}%`, background: r.progress_pct >= 100 ? '#16a34a' : r.progress_pct >= 50 ? '#d97706' : '#6B3FDB', borderRadius:4 }} />
                      </div>
                      <span style={{ fontSize:12, fontWeight:700, color:'#4c1d95', minWidth:36 }}>{r.progress_pct||0}%</span>
                    </div>
                  </td>
                  <td style={{ padding:'8px 12px' }}>{r.completed_items}/{r.total_items}</td>
                  <td style={{ padding:'8px 12px' }}>
                    <span style={{ padding:'2px 8px', borderRadius:10, fontSize:11, fontWeight:600, background: r.status==='completed' ? '#dcfce7' : '#e9e4ff', color: r.status==='completed' ? '#16a34a' : '#6B3FDB' }}>
                      {r.status}
                    </span>
                  </td>
                  <td style={{ padding:'8px 12px', color:'#6b7280' }}>{r.due_date || '—'}</td>
                </tr>
              ))}
              {progress.length === 0 && <tr><td colSpan={6} style={{ padding:'24px 16px', textAlign:'center', color:'#9ca3af' }}>No employees assigned to this path yet</td></tr>}
            </tbody>
          </table>
        </Modal>
      )}
    </div>
  );
}
