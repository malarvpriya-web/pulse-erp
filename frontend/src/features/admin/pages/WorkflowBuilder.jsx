import { useState, useEffect, useCallback, useRef } from 'react';
import { ClipboardList, Bell, Zap, Settings, Users } from 'lucide-react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

/* ─── constants ─────────────────────────────────────────────── */
const MODULES = ['Leave','Expense','Purchase Order','Invoice','Recruitment','Travel'];
const EVENTS  = ['Created','Updated','Status Changed','Amount Exceeds'];
const OPERATORS = ['equals','not equals','greater than','less than','contains','is empty','is not empty'];
const LOGIC_OPS = ['AND','OR'];
const ACTION_TYPES = ['Send Email','Send Notification','Update Field','Create Task','Escalate To'];
const ROLES = ['Manager','HR Head','Finance Head','Department Head','Admin','CEO'];
const REJECT_ACTIONS = ['stop','skip to next','notify manager'];
const APPROVAL_TYPES = ['any one','all must approve'];

const EMPTY_FORM = {
  name:'', description:'', trigger_module:'Leave', trigger_event:'Created',
  conditions:[], actions:[], approval_chain:[],
};

/* ─── helpers ─────────────────────────────────────────────── */
const fmtDate = (s) => s ? new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

/* ─── sub-components ─────────────────────────────────────────── */
function ChipStatus({ active }) {
  return (
    <span style={{
      padding:'2px 10px', borderRadius:12, fontSize:11, fontWeight:700,
      background: active ? '#d1fae5' : '#f3f4f6',
      color:      active ? '#16a34a' : '#9ca3af',
    }}>
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}

function ConditionRow({ cond, idx, onChange, onRemove }) {
  return (
    <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:8, background:'#f5f3ff', padding:'8px 10px', borderRadius:8 }}>
      {idx > 0 && (
        <select value={cond.logic} onChange={e => onChange({ ...cond, logic: e.target.value })}
          style={{ width:60, padding:'5px 6px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12, background:'#fff' }}>
          {LOGIC_OPS.map(l => <option key={l}>{l}</option>)}
        </select>
      )}
      <input value={cond.field} onChange={e => onChange({ ...cond, field: e.target.value })}
        placeholder='Field name' style={{ flex:1, padding:'5px 8px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12 }} />
      <select value={cond.operator} onChange={e => onChange({ ...cond, operator: e.target.value })}
        style={{ flex:1, padding:'5px 6px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12, background:'#fff' }}>
        {OPERATORS.map(o => <option key={o}>{o}</option>)}
      </select>
      {!['is empty','is not empty'].includes(cond.operator) && (
        <input value={cond.value} onChange={e => onChange({ ...cond, value: e.target.value })}
          placeholder='Value' style={{ flex:1, padding:'5px 8px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12 }} />
      )}
      <button onClick={onRemove} style={{ background:'#fee2e2', color:'#dc2626', border:'none', borderRadius:6, padding:'4px 8px', cursor:'pointer', fontSize:12 }}>✕</button>
    </div>
  );
}

function ActionRow({ action, idx, onChange, onRemove }) {
  const cfg = action.config || {};
  const set = (key, val) => onChange({ ...action, config: { ...cfg, [key]: val } });
  return (
    <div style={{ border:'1px solid #e9e4ff', borderRadius:8, padding:'10px 12px', marginBottom:10, background:'#faf9ff' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <span style={{ width:20, height:20, background:'#6B3FDB', color:'#fff', borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:700 }}>{idx+1}</span>
          <select value={action.type} onChange={e => onChange({ ...action, type: e.target.value, config: {} })}
            style={{ padding:'5px 8px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:13, background:'#fff', fontWeight:600, color:'#4c1d95' }}>
            {ACTION_TYPES.map(t => <option key={t}>{t}</option>)}
          </select>
        </div>
        <button onClick={onRemove} style={{ background:'#fee2e2', color:'#dc2626', border:'none', borderRadius:6, padding:'4px 8px', cursor:'pointer', fontSize:12 }}>✕</button>
      </div>

      {action.type === 'Send Email' && (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
          <div>
            <label style={{ fontSize:11, fontWeight:600, color:'#6b7280' }}>To (Role)</label>
            <select value={cfg.to_role||''} onChange={e => set('to_role', e.target.value)}
              style={{ width:'100%', marginTop:3, padding:'5px 8px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12, background:'#fff' }}>
              <option value=''>Select Role</option>
              {ROLES.map(r => <option key={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize:11, fontWeight:600, color:'#6b7280' }}>Subject</label>
            <input value={cfg.subject||''} onChange={e => set('subject', e.target.value)}
              style={{ width:'100%', marginTop:3, boxSizing:'border-box', padding:'5px 8px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12 }} />
          </div>
          <div style={{ gridColumn:'1/-1' }}>
            <label style={{ fontSize:11, fontWeight:600, color:'#6b7280' }}>Body (use {'{{variable}}'} placeholders)</label>
            <textarea value={cfg.body||''} onChange={e => set('body', e.target.value)} rows={2}
              style={{ width:'100%', marginTop:3, boxSizing:'border-box', padding:'5px 8px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12 }} />
          </div>
        </div>
      )}
      {action.type === 'Send Notification' && (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
          <div>
            <label style={{ fontSize:11, fontWeight:600, color:'#6b7280' }}>To (Role)</label>
            <select value={cfg.to_role||''} onChange={e => set('to_role', e.target.value)}
              style={{ width:'100%', marginTop:3, padding:'5px 8px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12, background:'#fff' }}>
              <option value=''>Select Role</option>
              {ROLES.map(r => <option key={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize:11, fontWeight:600, color:'#6b7280' }}>Message</label>
            <input value={cfg.body||''} onChange={e => set('body', e.target.value)}
              style={{ width:'100%', marginTop:3, boxSizing:'border-box', padding:'5px 8px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12 }} />
          </div>
        </div>
      )}
      {action.type === 'Update Field' && (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
          <div>
            <label style={{ fontSize:11, fontWeight:600, color:'#6b7280' }}>Field Name</label>
            <input value={cfg.field||''} onChange={e => set('field', e.target.value)}
              style={{ width:'100%', marginTop:3, boxSizing:'border-box', padding:'5px 8px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12 }} />
          </div>
          <div>
            <label style={{ fontSize:11, fontWeight:600, color:'#6b7280' }}>New Value</label>
            <input value={cfg.value||''} onChange={e => set('value', e.target.value)}
              style={{ width:'100%', marginTop:3, boxSizing:'border-box', padding:'5px 8px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12 }} />
          </div>
        </div>
      )}
      {action.type === 'Create Task' && (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8 }}>
          <div>
            <label style={{ fontSize:11, fontWeight:600, color:'#6b7280' }}>Assignee Role</label>
            <select value={cfg.assignee_role||''} onChange={e => set('assignee_role', e.target.value)}
              style={{ width:'100%', marginTop:3, padding:'5px 8px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12, background:'#fff' }}>
              <option value=''>Select</option>
              {ROLES.map(r => <option key={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize:11, fontWeight:600, color:'#6b7280' }}>Task Title</label>
            <input value={cfg.title||''} onChange={e => set('title', e.target.value)}
              style={{ width:'100%', marginTop:3, boxSizing:'border-box', padding:'5px 8px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12 }} />
          </div>
          <div>
            <label style={{ fontSize:11, fontWeight:600, color:'#6b7280' }}>Due Date Offset (days)</label>
            <input type='number' value={cfg.due_date_offset||''} onChange={e => set('due_date_offset', e.target.value)}
              style={{ width:'100%', marginTop:3, boxSizing:'border-box', padding:'5px 8px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12 }} />
          </div>
        </div>
      )}
      {action.type === 'Escalate To' && (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
          <div>
            <label style={{ fontSize:11, fontWeight:600, color:'#6b7280' }}>Escalate To (Role)</label>
            <select value={cfg.role||''} onChange={e => set('role', e.target.value)}
              style={{ width:'100%', marginTop:3, padding:'5px 8px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12, background:'#fff' }}>
              <option value=''>Select</option>
              {ROLES.map(r => <option key={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize:11, fontWeight:600, color:'#6b7280' }}>After (hours)</label>
            <input type='number' value={cfg.after_hours||''} onChange={e => set('after_hours', e.target.value)}
              style={{ width:'100%', marginTop:3, boxSizing:'border-box', padding:'5px 8px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12 }} />
          </div>
        </div>
      )}
    </div>
  );
}

function ApprovalLevelRow({ level, idx, onChange, onRemove }) {
  return (
    <div style={{ display:'flex', gap:8, alignItems:'flex-start', padding:'10px 12px', background:'#f5f3ff', borderRadius:8, marginBottom:8 }}>
      <span style={{ width:22, height:22, minWidth:22, background:'#6B3FDB', color:'#fff', borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:700, marginTop:2 }}>
        {idx+1}
      </span>
      <div style={{ flex:1, display:'grid', gridTemplateColumns:'1fr 1fr 1fr 1fr', gap:8 }}>
        <div>
          <label style={{ fontSize:11, fontWeight:600, color:'#6b7280' }}>Approver Role</label>
          <select value={level.approver_role||''} onChange={e => onChange({ ...level, approver_role: e.target.value })}
            style={{ width:'100%', marginTop:3, padding:'5px 8px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12, background:'#fff' }}>
            <option value=''>Select</option>
            {ROLES.map(r => <option key={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize:11, fontWeight:600, color:'#6b7280' }}>Approval Type</label>
          <select value={level.type||'any one'} onChange={e => onChange({ ...level, type: e.target.value })}
            style={{ width:'100%', marginTop:3, padding:'5px 8px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12, background:'#fff' }}>
            {APPROVAL_TYPES.map(t => <option key={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize:11, fontWeight:600, color:'#6b7280' }}>Escalate after (hrs)</label>
          <input type='number' value={level.escalate_after_hours||''} onChange={e => onChange({ ...level, escalate_after_hours: e.target.value })}
            style={{ width:'100%', marginTop:3, boxSizing:'border-box', padding:'5px 8px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12 }} />
        </div>
        <div>
          <label style={{ fontSize:11, fontWeight:600, color:'#6b7280' }}>On Rejection</label>
          <select value={level.on_reject||'stop'} onChange={e => onChange({ ...level, on_reject: e.target.value })}
            style={{ width:'100%', marginTop:3, padding:'5px 8px', border:'1px solid #e9e4ff', borderRadius:6, fontSize:12, background:'#fff' }}>
            {REJECT_ACTIONS.map(r => <option key={r}>{r}</option>)}
          </select>
        </div>
      </div>
      <button onClick={onRemove} style={{ background:'#fee2e2', color:'#dc2626', border:'none', borderRadius:6, padding:'4px 8px', cursor:'pointer', fontSize:12, marginTop:2 }}>✕</button>
    </div>
  );
}

/* ─── visual flowchart preview ────────────────────────────────── */
function WorkflowPreview({ wf }) {
  const nodes = [];
  nodes.push({ id:'trigger', label: `[Trigger]\n${wf.trigger_module}: ${wf.trigger_event}`, color:'#6B3FDB', bg:'#ede9fe' });

  if (wf.conditions?.length) {
    const condText = wf.conditions.map((c,i) => `${i>0?c.logic+' ':''}${c.field} ${c.operator}${c.value?' '+c.value:''}`).join('\n');
    nodes.push({ id:'conditions', label: `[Conditions]\n${condText}`, color:'#d97706', bg:'#fef3c7' });
  }

  wf.actions?.forEach((a, i) => {
    const detail = a.config?.to_role || a.config?.field || a.config?.role || '';
    nodes.push({ id:`action_${i}`, label: `Step ${i+1}: ${a.type}${detail ? '\n→ '+detail : ''}`, color:'#2563eb', bg:'#dbeafe' });
  });

  if (wf.approval_chain?.length) {
    wf.approval_chain.forEach((lvl, i) => {
      nodes.push({ id:`approval_${i}`, label: `Approval L${i+1}\n${lvl.approver_role||'?'} (${lvl.type||'any one'})`, color:'#16a34a', bg:'#d1fae5' });
    });
  }

  nodes.push({ id:'end', label:'🏁 End', color:'#6b7280', bg:'#f3f4f6' });

  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:0, padding:'16px 0', minHeight:100 }}>
      {nodes.map((node, i) => (
        <div key={node.id} style={{ display:'flex', flexDirection:'column', alignItems:'center' }}>
          <div style={{
            background: node.bg, border:`2px solid ${node.color}`, borderRadius:10,
            padding:'10px 20px', minWidth:240, textAlign:'center',
            fontSize:13, color:'#1f2937', fontWeight:500, lineHeight:1.5,
            whiteSpace:'pre-line',
          }}>
            {node.label}
          </div>
          {i < nodes.length - 1 && (
            <div style={{ width:2, height:28, background:`${nodes[i+1].color}55`, position:'relative', display:'flex', alignItems:'center', justifyContent:'center' }}>
              <div style={{ width:8, height:8, borderRight:`2px solid ${nodes[i+1].color}`, borderBottom:`2px solid ${nodes[i+1].color}`, transform:'rotate(45deg)', position:'absolute', bottom:2 }} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ─── run log modal ──────────────────────────────────────────── */
function RunLogPanel({ wfName, runs, loading, onClose }) {
  const fmtTs = (s) => s ? new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:1000, display:'flex', alignItems:'flex-start', justifyContent:'flex-end' }}
      onClick={onClose}>
      <div style={{ background:'#fff', width:520, maxWidth:'95vw', height:'100vh', overflowY:'auto', padding:24, boxShadow:'-4px 0 24px rgba(0,0,0,0.15)' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
          <div>
            <h3 style={{ margin:0, color:'#4c1d95', fontSize:17 }}>Run History</h3>
            <p style={{ margin:0, fontSize:12, color:'#6b7280' }}>{wfName}</p>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', fontSize:20, color:'#6b7280', lineHeight:1 }}>✕</button>
        </div>
        {loading ? (
          <div style={{ textAlign:'center', padding:40, color:'#6B3FDB' }}>Loading…</div>
        ) : runs.length === 0 ? (
          <div style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>
            <ClipboardList size={36} strokeWidth={1.5} color="#9ca3af" style={{ marginBottom:10 }} />
            <p>No run history yet.</p>
            <p style={{ fontSize:12 }}>Runs will appear here after the workflow is triggered.</p>
          </div>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            {runs.map((r, i) => (
              <div key={r.id || i} style={{ border:'1px solid #e9e4ff', borderRadius:8, padding:'12px 14px', background:'#faf9ff' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
                  <span style={{ fontSize:12, fontWeight:700, padding:'2px 8px', borderRadius:10,
                    background: r.status === 'completed' ? '#d1fae5' : '#fee2e2',
                    color:      r.status === 'completed' ? '#16a34a' : '#dc2626' }}>
                    {r.status || 'completed'}
                  </span>
                  <span style={{ fontSize:11, color:'#9ca3af' }}>{fmtTs(r.triggered_at)}</span>
                </div>
                {r.entity_module && (
                  <div style={{ fontSize:12, color:'#6b7280', marginBottom:3 }}>
                    <strong style={{ color:'#4c1d95' }}>Module:</strong> {r.entity_module}
                    {r.entity_id ? ` · ID ${r.entity_id}` : ''}
                  </div>
                )}
                {r.duration_ms != null && (
                  <div style={{ fontSize:12, color:'#6b7280', marginBottom:3 }}>
                    <strong style={{ color:'#4c1d95' }}>Duration:</strong> {r.duration_ms}ms
                  </div>
                )}
                {r.error_message && (
                  <div style={{ fontSize:12, color:'#dc2626', marginTop:4, padding:'6px 8px', background:'#fef2f2', borderRadius:6 }}>
                    {r.error_message}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── main component ─────────────────────────────────────────── */
export default function WorkflowBuilder({ setPage }) {
  const [view, setView]         = useState('list');   // list | create | preview
  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading]   = useState(false);
  const [msg, setMsg]           = useState({ text:'', type:'' });
  const [form, setForm]         = useState(EMPTY_FORM);
  const [editId, setEditId]     = useState(null);
  const [previewWf, setPreviewWf] = useState(null);
  const [triggering, setTriggering] = useState(null);
  const [runLog, setRunLog]     = useState(null);  // null | { wfId, wfName, runs, loading }
  const [pendingDelete, setPendingDelete] = useState(null); // null | workflow object

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const flash = (text, type = 'success') => {
    setMsg({ text, type });
    setTimeout(() => setMsg({ text:'', type:'' }), 3500);
  };

  const load = useCallback(async () => {
    try {
      const res = await api.get('/workflows');
      if (!isMounted.current) return;
      setWorkflows(Array.isArray(res.data) ? res.data : []);
    } catch {
      if (!isMounted.current) return;
      setWorkflows([]);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleActive = async (wf) => {
    setWorkflows(ws => ws.map(w => w.id === wf.id ? { ...w, is_active: !w.is_active } : w));
    try {
      await api.patch(`/workflows/${wf.id}/toggle`);
    } catch(e) {
      setWorkflows(ws => ws.map(w => w.id === wf.id ? { ...w, is_active: wf.is_active } : w));
      flash(e?.response?.data?.error || 'Failed to toggle workflow', 'error');
    }
  };

  const handleTrigger = async (wf) => {
    setTriggering(wf.id);
    try {
      const res = await api.post(`/workflows/${wf.id}/trigger`);
      flash(res.data?.message || `Workflow "${wf.name}" triggered`);
      load();
    } catch { flash(`Workflow "${wf.name}" triggered (simulated)`); }
    finally  { setTriggering(null); }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    try {
      await api.delete(`/workflows/${id}`);
      setWorkflows(ws => ws.filter(w => w.id !== id));
      flash('Workflow deleted');
    } catch { flash('Delete failed', 'error'); }
  };

  const openRunLog = async (wf) => {
    setRunLog({ wfId: wf.id, wfName: wf.name, runs: [], loading: true });
    try {
      const res = await api.get(`/workflows/${wf.id}/runs`);
      setRunLog(prev => prev ? { ...prev, runs: Array.isArray(res.data) ? res.data : [], loading: false } : null);
    } catch {
      setRunLog(prev => prev ? { ...prev, runs: [], loading: false } : null);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { flash('Name is required', 'error'); return; }

    try {
      if (editId) {
        const res = await api.put(`/workflows/${editId}`, form);
        setWorkflows(ws => ws.map(w => w.id === editId ? (res.data?.data || { ...w, ...form }) : w));
        flash('Workflow updated');
      } else {
        const res = await api.post('/workflows', form);
        setWorkflows(ws => [res.data?.data || { id: Date.now(), ...form, is_active:true, trigger_count:0 }, ...ws]);
        flash('Workflow created');
      }
      setForm(EMPTY_FORM);
      setEditId(null);
      setView('list');
    } catch (err) {
      flash(err.response?.data?.message || 'Save failed', 'error');
    } finally { setLoading(false); }
  };

  const startEdit = (wf) => {
    setForm({
      name: wf.name, description: wf.description || '',
      trigger_module: wf.trigger_module, trigger_event: wf.trigger_event,
      conditions: wf.conditions || [], actions: wf.actions || [],
      approval_chain: wf.approval_chain || [],
    });
    setEditId(wf.id);
    setView('create');
  };

  const addCondition  = () => setForm(f => ({ ...f, conditions: [...f.conditions, { field:'', operator:'equals', value:'', logic:'AND' }] }));
  const addAction     = () => setForm(f => ({ ...f, actions: [...f.actions, { type:'Send Email', config:{} }] }));
  const addApproval   = () => {
    if ((form.approval_chain||[]).length >= 5) return;
    setForm(f => ({ ...f, approval_chain: [...(f.approval_chain||[]), { level: f.approval_chain.length+1, approver_role:'', type:'any one', escalate_after_hours:4, on_reject:'stop' }] }));
  };

  /* ─── UI ─── */
  const btnPrimary = { background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'9px 20px', cursor:'pointer', fontWeight:600, fontSize:14 };
  const btnSecondary = { background:'#e9e4ff', color:'#6B3FDB', border:'none', borderRadius:8, padding:'9px 16px', cursor:'pointer', fontWeight:600, fontSize:14 };

  return (
    <div style={{ padding:24, background:'#f5f3ff', minHeight:'100vh' }}>
      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete Workflow"
        message={pendingDelete ? `Delete "${pendingDelete?.name ?? 'this workflow'}"? This cannot be undone.` : ''}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />

      {/* header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <div>
          <h2 style={{ margin:0, color:'#4c1d95', fontSize:22 }}>Workflow Automation Builder</h2>
          <p style={{ margin:0, color:'#6b7280', fontSize:13 }}>Visual no-code rule engine for automating business processes</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {setPage && view === 'list' && (
            <button style={btnSecondary} onClick={() => setPage('ApproverSetup')}>
              Approver Setup →
            </button>
          )}
          {view === 'list' && (
            <button style={btnPrimary} onClick={() => { setForm(EMPTY_FORM); setEditId(null); setView('create'); }}>
              + New Workflow
            </button>
          )}
          {view !== 'list' && (
            <button style={btnSecondary} onClick={() => { setView('list'); setEditId(null); setForm(EMPTY_FORM); }}>
              ← Back to List
            </button>
          )}
        </div>
      </div>

      {/* flash msg */}
      {msg.text && (
        <div style={{ marginBottom:12, padding:'10px 16px', borderRadius:8, fontWeight:500, fontSize:14,
          background: msg.type==='error' ? '#fef2f2' : '#f0fdf4',
          color:      msg.type==='error' ? '#dc2626'  : '#16a34a',
          border:`1px solid ${msg.type==='error' ? '#fecaca' : '#bbf7d0'}` }}>
          {msg.text}
        </div>
      )}

      {/* ── LIST VIEW ── */}
      {view === 'list' && (
        <div>
          {/* Two-layer system explanation */}
          <div style={{ marginBottom:16, padding:'12px 16px', background:'#fff', border:'1px solid #ddd6fe', borderRadius:10, display:'flex', gap:20, flexWrap:'wrap', alignItems:'flex-start' }}>
            <div style={{ flex:1, minWidth:200 }}>
              <div style={{ fontSize:12, fontWeight:700, color:'#4c1d95', marginBottom:4, display:'flex', alignItems:'center', gap:5 }}><Zap size={12} />Automation Rules (this page)</div>
              <div style={{ fontSize:12, color:'#6b7280' }}>Defines WHEN automation fires — auto-approve short leaves, send reminders, escalate on delays. Each rule has its own conditions, action steps, and optional inline approval chain.</div>
            </div>
            <div style={{ flex:1, minWidth:200 }}>
              <div style={{ fontSize:12, fontWeight:700, color:'#d97706', marginBottom:4 }}>Approver Setup (global fallback)</div>
              <div style={{ fontSize:12, color:'#6b7280' }}>Defines WHO approves each module (leave: manager → HR). Automation rules with no inline approval chain fall back to these levels — shown as <span style={{ background:'#ede9fe', color:'#6B3FDB', padding:'0 4px', borderRadius:4, fontSize:11, fontWeight:600 }}>via Approver Setup</span> above.</div>
            </div>
            <div style={{ flex:1, minWidth:200 }}>
              <div style={{ fontSize:12, fontWeight:700, color:'#16a34a', marginBottom:4 }}>🔗 Workflow Configuration (Operations)</div>
              <div style={{ fontSize:12, color:'#6b7280' }}>Defines step-based process workflows (Leave Approval: manager → HR, Project Creation: manager). These run at submission time; automation rules layer on top with reminders and escalations.</div>
            </div>
          </div>

          {loading ? <div style={{ textAlign:'center', padding:50, color:'#6B3FDB' }}>Loading…</div> : (
            <div style={{ display:'grid', gap:12 }}>
              {workflows.map(wf => (
                <div key={wf.id} style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:10, padding:'16px 20px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:10 }}>
                    <div style={{ flex:1 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
                        <h3 style={{ margin:0, color:'#4c1d95', fontSize:16 }}>{wf.name}</h3>
                        <ChipStatus active={wf.is_active} />
                      </div>
                      <p style={{ margin:'0 0 8px', color:'#6b7280', fontSize:13 }}>{wf.description}</p>
                      <div style={{ display:'flex', gap:16, flexWrap:'wrap' }}>
                        <span style={{ fontSize:12, color:'#6b7280' }}>
                          <strong style={{ color:'#4c1d95' }}>Trigger:</strong> {wf.trigger_module} → {wf.trigger_event}
                        </span>
                        <span style={{ fontSize:12, color:'#6b7280' }}>
                          <strong style={{ color:'#4c1d95' }}>Conditions:</strong> {wf?.conditions?.length ?? 0}
                        </span>
                        <span style={{ fontSize:12, color:'#6b7280' }}>
                          <strong style={{ color:'#4c1d95' }}>Steps:</strong> {wf?.actions?.length ?? 0}
                        </span>
                        <span style={{ fontSize:12, color:'#6b7280' }}>
                          <strong style={{ color:'#4c1d95' }}>Approvals:</strong>{' '}
                          {(() => {
                            const own = wf?.approval_chain?.length ?? 0;
                            if (own > 0) return `${own} levels`;
                            const global = wf?._global_approver_levels ?? 0;
                            if (global > 0) return (
                              <>{global} levels{' '}
                                <span style={{ fontSize:10, background:'#ede9fe', color:'#6B3FDB', padding:'1px 6px', borderRadius:6, fontWeight:600 }}>
                                  via Approver Setup
                                </span>
                              </>
                            );
                            return (
                              <span style={{ color:'#9ca3af' }}>0 levels{' '}
                                {setPage && (
                                  <button onClick={() => setPage('ApproverSetup')}
                                    style={{ fontSize:11, color:'#6B3FDB', background:'none', border:'none', cursor:'pointer', textDecoration:'underline', padding:0 }}>
                                    Configure →
                                  </button>
                                )}
                              </span>
                            );
                          })()}
                        </span>
                        <span style={{ fontSize:12, color:'#6b7280' }}>
                          <strong style={{ color:'#4c1d95' }}>Last Triggered:</strong> {fmtDate(wf?.last_triggered_at)}
                        </span>
                        <button onClick={() => openRunLog(wf)}
                          style={{ fontSize:12, color:'#6B3FDB', fontWeight:600, background:'none', border:'none', cursor:'pointer', padding:0, textDecoration:'underline dotted' }}>
                          {wf?.trigger_count ?? 0} runs
                        </button>
                      </div>
                    </div>
                    <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                      <button onClick={() => { setPreviewWf(wf); setView('preview'); }}
                        style={{ ...btnSecondary, padding:'6px 12px', fontSize:12 }}>Preview</button>
                      <button onClick={() => startEdit(wf)}
                        style={{ ...btnSecondary, padding:'6px 12px', fontSize:12 }}>Edit</button>
                      <button onClick={() => toggleActive(wf)}
                        style={{ background: wf.is_active ? '#fef3c7' : '#d1fae5', color: wf.is_active ? '#d97706' : '#16a34a',
                          border:'none', borderRadius:8, padding:'6px 12px', cursor:'pointer', fontWeight:600, fontSize:12 }}>
                        {wf.is_active ? 'Disable' : 'Enable'}
                      </button>
                      <button onClick={() => handleTrigger(wf)} disabled={triggering === wf.id}
                        style={{ background:'#ede9fe', color:'#6B3FDB', border:'none', borderRadius:8, padding:'6px 12px', cursor:'pointer', fontWeight:600, fontSize:12 }}>
                        {triggering === wf.id ? '⏳' : '▶ Test'}
                      </button>
                      <button onClick={() => setPendingDelete(wf)}
                        style={{ background:'#fee2e2', color:'#dc2626', border:'none', borderRadius:8, padding:'6px 12px', cursor:'pointer', fontWeight:600, fontSize:12 }}>Delete</button>
                    </div>
                  </div>
                </div>
              ))}
              {workflows.length === 0 && (
                <div style={{ textAlign:'center', padding:60, color:'#9ca3af', background:'#fff', borderRadius:10, border:'1px solid #e9e4ff' }}>
                  <div style={{ marginBottom:12, color:'#c4b5fd' }}><Settings size={48} strokeWidth={1.2} /></div>
                  <p>No workflows yet. Create your first automation rule.</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── CREATE / EDIT ── */}
      {view === 'create' && (
        <form onSubmit={handleSubmit}>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
            {/* left panel: form */}
            <div style={{ display:'flex', flexDirection:'column', gap:0 }}>

              {/* basic info */}
              <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:10, padding:18, marginBottom:14 }}>
                <h3 style={{ margin:'0 0 14px', color:'#4c1d95', fontSize:15 }}>Basic Info</h3>
                <div style={{ marginBottom:12 }}>
                  <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#4c1d95', marginBottom:4 }}>Workflow Name *</label>
                  <input required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    style={{ width:'100%', boxSizing:'border-box', padding:'8px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }} />
                </div>
                <div>
                  <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#4c1d95', marginBottom:4 }}>Description</label>
                  <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2}
                    style={{ width:'100%', boxSizing:'border-box', padding:'8px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }} />
                </div>
              </div>

              {/* trigger */}
              <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:10, padding:18, marginBottom:14 }}>
                <h3 style={{ margin:'0 0 14px', color:'#4c1d95', fontSize:15, display:'flex', alignItems:'center', gap:6 }}><Bell size={14} />Trigger</h3>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                  <div>
                    <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#4c1d95', marginBottom:4 }}>Module</label>
                    <select value={form.trigger_module} onChange={e => setForm(f => ({ ...f, trigger_module: e.target.value }))}
                      style={{ width:'100%', padding:'8px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13, background:'#fff' }}>
                      {MODULES.map(m => <option key={m}>{m}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#4c1d95', marginBottom:4 }}>Event</label>
                    <select value={form.trigger_event} onChange={e => setForm(f => ({ ...f, trigger_event: e.target.value }))}
                      style={{ width:'100%', padding:'8px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13, background:'#fff' }}>
                      {EVENTS.map(ev => <option key={ev}>{ev}</option>)}
                    </select>
                  </div>
                </div>
              </div>

              {/* conditions */}
              <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:10, padding:18, marginBottom:14 }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                  <h3 style={{ margin:0, color:'#4c1d95', fontSize:15, display:'flex', alignItems:'center', gap:6 }}><Settings size={14} />Conditions</h3>
                  <button type='button' onClick={addCondition}
                    style={{ background:'#ede9fe', color:'#6B3FDB', border:'none', borderRadius:7, padding:'5px 12px', cursor:'pointer', fontWeight:600, fontSize:12 }}>
                    + Add Condition
                  </button>
                </div>
                {form.conditions.length === 0 && <p style={{ color:'#9ca3af', fontSize:13, margin:0 }}>No conditions — workflow runs on every trigger event.</p>}
                {form.conditions.map((c, i) => (
                  <ConditionRow key={i} cond={c} idx={i}
                    onChange={updated => setForm(f => ({ ...f, conditions: f.conditions.map((x,j) => j===i ? updated : x) }))}
                    onRemove={() => setForm(f => ({ ...f, conditions: f.conditions.filter((_,j) => j!==i) }))} />
                ))}
              </div>

              {/* actions */}
              <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:10, padding:18, marginBottom:14 }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                  <h3 style={{ margin:0, color:'#4c1d95', fontSize:15 }}>▶ Action Steps</h3>
                  <button type='button' onClick={addAction}
                    style={{ background:'#ede9fe', color:'#6B3FDB', border:'none', borderRadius:7, padding:'5px 12px', cursor:'pointer', fontWeight:600, fontSize:12 }}>
                    + Add Step
                  </button>
                </div>
                {form.actions.length === 0 && <p style={{ color:'#9ca3af', fontSize:13, margin:0 }}>No actions added yet.</p>}
                {form.actions.map((a, i) => (
                  <ActionRow key={i} action={a} idx={i}
                    onChange={updated => setForm(f => ({ ...f, actions: f.actions.map((x,j) => j===i ? updated : x) }))}
                    onRemove={() => setForm(f => ({ ...f, actions: f.actions.filter((_,j) => j!==i) }))} />
                ))}
              </div>

              {/* approval chain */}
              <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:10, padding:18, marginBottom:14 }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                  <h3 style={{ margin:0, color:'#4c1d95', fontSize:15, display:'flex', alignItems:'center', gap:6 }}><Users size={14} />Approval Chain (max 5 levels)</h3>
                  <button type='button' onClick={addApproval} disabled={(form.approval_chain||[]).length >= 5}
                    style={{ background:'#ede9fe', color:'#6B3FDB', border:'none', borderRadius:7, padding:'5px 12px', cursor:'pointer', fontWeight:600, fontSize:12, opacity:(form.approval_chain||[]).length>=5?0.5:1 }}>
                    + Add Level
                  </button>
                </div>
                {(form.approval_chain||[]).length === 0 && <p style={{ color:'#9ca3af', fontSize:13, margin:0 }}>No approval levels — workflow auto-completes.</p>}
                {(form.approval_chain||[]).map((lvl, i) => (
                  <ApprovalLevelRow key={i} level={lvl} idx={i}
                    onChange={updated => setForm(f => ({ ...f, approval_chain: (f.approval_chain||[]).map((x,j) => j===i ? updated : x) }))}
                    onRemove={() => setForm(f => ({ ...f, approval_chain: (f.approval_chain||[]).filter((_,j) => j!==i) }))} />
                ))}
              </div>

              <div style={{ display:'flex', gap:10 }}>
                <button type='submit' style={btnPrimary} disabled={loading}>
                  {loading ? 'Saving…' : editId ? 'Update Workflow' : 'Create Workflow'}
                </button>
                <button type='button' style={btnSecondary} onClick={() => { setView('list'); setEditId(null); setForm(EMPTY_FORM); }}>
                  Cancel
                </button>
              </div>
            </div>

            {/* right panel: live preview */}
            <div style={{ position:'sticky', top:20, alignSelf:'start' }}>
              <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:10, padding:18 }}>
                <h3 style={{ margin:'0 0 14px', color:'#4c1d95', fontSize:15 }}>🔍 Live Workflow Preview</h3>
                <div style={{ overflowY:'auto', maxHeight:600 }}>
                  <WorkflowPreview wf={form} />
                </div>
              </div>
            </div>
          </div>
        </form>
      )}

      {/* ── RUN LOG PANEL ── */}
      {runLog && (
        <RunLogPanel
          wfName={runLog.wfName}
          runs={runLog.runs}
          loading={runLog.loading}
          onClose={() => setRunLog(null)}
        />
      )}

      {/* ── PREVIEW ── */}
      {view === 'preview' && previewWf && (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 2fr', gap:16 }}>
          <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:10, padding:18 }}>
            <h3 style={{ margin:'0 0 12px', color:'#4c1d95' }}>{previewWf.name}</h3>
            <ChipStatus active={previewWf.is_active} />
            <p style={{ color:'#6b7280', fontSize:13, marginTop:10 }}>{previewWf.description}</p>
            <hr style={{ border:'none', borderTop:'1px solid #e9e4ff', margin:'12px 0' }} />
            <div style={{ fontSize:13, color:'#374151' }}>
              <div style={{ marginBottom:8 }}><strong style={{ color:'#4c1d95' }}>Trigger:</strong> {previewWf.trigger_module} → {previewWf.trigger_event}</div>
              <div style={{ marginBottom:8 }}><strong style={{ color:'#4c1d95' }}>Conditions:</strong> {previewWf.conditions?.length || 0}</div>
              <div style={{ marginBottom:8 }}><strong style={{ color:'#4c1d95' }}>Action Steps:</strong> {previewWf.actions?.length || 0}</div>
              <div style={{ marginBottom:8 }}><strong style={{ color:'#4c1d95' }}>Approval Levels:</strong> {previewWf.approval_chain?.length || 0}</div>
              <div style={{ marginBottom:8 }}><strong style={{ color:'#4c1d95' }}>Total Runs:</strong> {previewWf.trigger_count || 0}</div>
              <div><strong style={{ color:'#4c1d95' }}>Last Run:</strong> {fmtDate(previewWf.last_triggered_at)}</div>
            </div>
            <div style={{ marginTop:16, display:'flex', flexDirection:'column', gap:8 }}>
              <button style={btnPrimary} onClick={() => startEdit(previewWf)}>Edit Workflow</button>
              <button style={{ ...btnSecondary, textAlign:'center' }} onClick={() => handleTrigger(previewWf)}>
                {triggering === previewWf.id ? '⏳ Triggering…' : '▶ Test Trigger'}
              </button>
            </div>
          </div>
          <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:10, padding:18, overflowY:'auto', maxHeight:'80vh' }}>
            <h3 style={{ margin:'0 0 14px', color:'#4c1d95' }}>Workflow Flowchart</h3>
            <WorkflowPreview wf={previewWf} />
          </div>
        </div>
      )}
    </div>
  );
}
