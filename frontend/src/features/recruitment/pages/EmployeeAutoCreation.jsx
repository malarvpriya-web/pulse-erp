import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { UserPlus, CheckCircle, Clock, AlertCircle, RefreshCw, ChevronRight, X } from 'lucide-react';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const CARD = { background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:'20px', marginBottom:16 };
const BTN  = (bg='#6B3FDB') => ({ background:bg, color:'#fff', border:'none', borderRadius:8, padding:'8px 16px', fontSize:13, fontWeight:600, cursor:'pointer', display:'flex', alignItems:'center', gap:6 });

export default function EmployeeAutoCreation() {
  const toast = useToast();
  const [pending, setPending] = useState([]);
  const [log, setLog] = useState([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(null);
  const [tab, setTab] = useState('pending');
  const [result, setResult] = useState(null);
  const [pendingCreateEmployee, setPendingCreateEmployee] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, l] = await Promise.allSettled([
        api.get('/recruitment/auto-creation/pending'),
        api.get('/recruitment/auto-creation/log'),
      ]);
      if (p.status === 'fulfilled') setPending(Array.isArray(p.value.data) ? p.value.data : []);
      if (l.status === 'fulfilled') setLog(Array.isArray(l.value.data) ? l.value.data : []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const createEmployee = async () => {
    if (!pendingCreateEmployee) return;
    const { candidateId, candidateName } = pendingCreateEmployee;
    setPendingCreateEmployee(null);
    setCreating(candidateId);
    try {
      const { data } = await api.post(`/recruitment/auto-creation/${candidateId}/trigger`);
      setResult(data);
      toast.success(`Employee ${data.employee_code} created for ${data.candidate_name}`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Employee creation failed');
    } finally { setCreating(null); }
  };

  const CHECKLIST_ITEMS = [
    { step: 'Employee Code Generated', icon: '🆔', desc: 'Unique EMP-XXXX code assigned' },
    { step: 'Employee Record Created', icon: '📋', desc: 'Name, department, designation, joining date from offer' },
    { step: 'Email Request', icon: '📧', desc: 'Official email creation request to IT' },
    { step: 'Onboarding Checklist', icon: '✅', desc: 'Welcome kit, ID card, documents checklist' },
    { step: 'Attendance Profile', icon: '🕐', desc: 'Shift assignment, geo-fence registration' },
    { step: 'Leave Profile', icon: '🏖️', desc: 'Annual, sick, casual leave allocation' },
    { step: 'Payroll Profile', icon: '💰', desc: 'Salary structure from offer letter' },
    { step: 'Document Folder', icon: '📁', desc: 'Google Drive folder / NAS folder created' },
    { step: 'Org Chart', icon: '🏢', desc: 'Reporting manager and org node added' },
  ];

  return (
    <div style={{ padding:'24px' }}>
      <ConfirmDialog
        open={!!pendingCreateEmployee}
        title="Create Employee Record"
        message={pendingCreateEmployee ? `Create employee record for ${pendingCreateEmployee.candidateName}?` : ''}
        confirmLabel="Create"
        variant="info"
        onConfirm={createEmployee}
        onCancel={() => setPendingCreateEmployee(null)}
      />
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#111', margin:0 }}>Employee Auto-Creation</h1>
          <p style={{ fontSize:13, color:'#6b7280', margin:'4px 0 0' }}>When a candidate reaches "Hired" stage — auto-create employee record with zero duplicate entry</p>
        </div>
        <button onClick={load} style={{ background:'#f5f3ff', color:'#6B3FDB', border:'1px solid #e9e4ff', borderRadius:8, padding:'8px 16px', fontSize:13, fontWeight:600, cursor:'pointer', display:'flex', alignItems:'center', gap:6 }}>
          <RefreshCw size={14}/>Refresh
        </button>
      </div>

      {/* How It Works */}
      <div style={{ ...CARD, background:'linear-gradient(135deg,#f5f3ff,#ede9fe)', border:'1px solid #e9e4ff', marginBottom:20 }}>
        <h3 style={{ fontSize:14, fontWeight:700, margin:'0 0 14px', color:'#6B3FDB' }}>Auto-Creation Pipeline</h3>
        <div style={{ display:'flex', alignItems:'center', gap:0, flexWrap:'wrap' }}>
          {['Job Opening', 'Applications', 'Screening', 'L1 Interview', 'L2 Interview', 'Management', 'Offer', '★ Hired', '→ Employee Created'].map((s, i, arr) => (
            <div key={s} style={{ display:'flex', alignItems:'center' }}>
              <div style={{ background:s.startsWith('★')?'#6B3FDB':s.startsWith('→')?'#059669':'#fff', color:s.startsWith('★')||s.startsWith('→')?'#fff':'#374151', border:s.startsWith('★')?'2px solid #6B3FDB':s.startsWith('→')?'2px solid #059669':'1px solid #d1d5db', borderRadius:8, padding:'5px 10px', fontSize:11, fontWeight:s.startsWith('★')||s.startsWith('→')?700:500, whiteSpace:'nowrap' }}>
                {s}
              </div>
              {i < arr.length - 1 && <div style={{ fontSize:14, color:'#9ca3af', margin:'0 4px' }}>→</div>}
            </div>
          ))}
        </div>
        <p style={{ fontSize:12, color:'#6b7280', margin:'12px 0 0' }}>
          When you click "Create Employee" for a Hired candidate, the system auto-populates: employee code, name, email, phone, department, designation, joining date — from the candidate and offer records.
        </p>
      </div>

      {/* What Gets Created */}
      <div style={{ ...CARD, marginBottom:20 }}>
        <h3 style={{ fontSize:14, fontWeight:700, margin:'0 0 14px', color:'#374151' }}>What Gets Auto-Created</h3>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10 }}>
          {CHECKLIST_ITEMS.map(item => (
            <div key={item.step} style={{ background:'#f9fafb', borderRadius:8, padding:'10px 14px', display:'flex', gap:10, alignItems:'flex-start' }}>
              <span style={{ fontSize:18 }}>{item.icon}</span>
              <div>
                <div style={{ fontSize:12, fontWeight:700, color:'#374151' }}>{item.step}</div>
                <div style={{ fontSize:11, color:'#9ca3af', marginTop:2 }}>{item.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12, marginBottom:20 }}>
        {[
          { label:'Awaiting Creation', value:pending.length, color:'#d97706' },
          { label:'Already Created', value:log.filter(l=>l.status==='completed').length, color:'#059669' },
          { label:'Creation Errors', value:log.filter(l=>l.status==='failed').length, color:'#dc2626' },
        ].map(s => (
          <div key={s.label} style={{ ...CARD, margin:0, textAlign:'center', padding:'16px 20px' }}>
            <div style={{ fontSize:26, fontWeight:800, color:s.color }}>{s.value}</div>
            <div style={{ fontSize:12, color:'#6b7280', marginTop:4, fontWeight:600 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display:'flex', gap:4, marginBottom:16, borderBottom:'2px solid #f0f0f4' }}>
        {[['pending','Pending Creation'],['log','Creation Log']].map(([t,l]) => (
          <button key={t} onClick={() => setTab(t)} style={{ padding:'10px 20px', border:'none', cursor:'pointer', background:'none', fontSize:13, fontWeight:tab===t?700:500, color:tab===t?'#6B3FDB':'#6b7280', borderBottom:tab===t?'2px solid #6B3FDB':'2px solid transparent', marginBottom:-2 }}>
            {l} {t==='pending'&&pending.length>0&&<span style={{ background:'#6B3FDB', color:'#fff', borderRadius:9999, padding:'1px 7px', fontSize:11, marginLeft:4 }}>{pending.length}</span>}
          </button>
        ))}
      </div>

      {/* Pending Tab */}
      {tab === 'pending' && (
        <div style={CARD}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ background:'#f9fafb' }}>
                {['Candidate','Email','Job Title','Department','Joining Date','Offered Salary','Status','Action'].map(h => (
                  <th key={h} style={{ padding:'10px 12px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pending.map(c => (
                <tr key={c.id} style={{ borderTop:'1px solid #f3f4f6' }}>
                  <td style={{ padding:'10px 12px', fontWeight:700, color:'#111' }}>{c.full_name}</td>
                  <td style={{ padding:'10px 12px', color:'#374151', fontSize:12 }}>{c.email}</td>
                  <td style={{ padding:'10px 12px', color:'#374151' }}>{c.job_title || '—'}</td>
                  <td style={{ padding:'10px 12px', color:'#6b7280' }}>{c.department || '—'}</td>
                  <td style={{ padding:'10px 12px', color:'#374151' }}>{c.joining_date ? new Date(c.joining_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                  <td style={{ padding:'10px 12px', color:'#059669', fontWeight:600 }}>
                    {c.offered_salary ? `₹${Number(c.offered_salary).toLocaleString('en-IN')}/mo` : '—'}
                  </td>
                  <td style={{ padding:'10px 12px' }}>
                    {c.creation_status === 'completed' ? (
                      <span style={{ background:'#d1fae5', color:'#065f46', padding:'2px 8px', borderRadius:9999, fontSize:11, fontWeight:700 }}>✓ Created ({c.employee_code})</span>
                    ) : c.creation_status === 'in_progress' ? (
                      <span style={{ background:'#dbeafe', color:'#1e40af', padding:'2px 8px', borderRadius:9999, fontSize:11, fontWeight:700 }}>Creating…</span>
                    ) : c.creation_status === 'failed' ? (
                      <span style={{ background:'#fee2e2', color:'#991b1b', padding:'2px 8px', borderRadius:9999, fontSize:11, fontWeight:700 }}>Failed</span>
                    ) : (
                      <span style={{ background:'#fef3c7', color:'#92400e', padding:'2px 8px', borderRadius:9999, fontSize:11, fontWeight:700 }}>Pending</span>
                    )}
                  </td>
                  <td style={{ padding:'10px 12px' }}>
                    {c.creation_status === 'completed' ? (
                      <span style={{ fontSize:12, color:'#059669' }}>✓ Done</span>
                    ) : (
                      <button onClick={() => setPendingCreateEmployee({ candidateId: c.id, candidateName: c.full_name })} disabled={creating === c.id}
                        style={{ ...BTN('#059669'), opacity:creating===c.id?.5:1, cursor:creating===c.id?'not-allowed':'pointer', fontSize:12, padding:'6px 12px' }}>
                        <UserPlus size={12}/>{creating===c.id?'Creating…':'Create Employee'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!pending.length && (
                <tr>
                  <td colSpan={8} style={{ textAlign:'center', padding:60, color:'#9ca3af' }}>
                    <CheckCircle size={40} style={{ marginBottom:12, opacity:.3, color:'#059669' }}/>
                    <p>No pending candidate-to-employee conversions.</p>
                    <p style={{ fontSize:12 }}>When a candidate's stage changes to "Hired", they appear here for one-click employee creation.</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Log Tab */}
      {tab === 'log' && (
        <div style={CARD}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ background:'#f9fafb' }}>
                {['Candidate','Job Title','Employee Code','Status','Employee ID','Triggered','Completed'].map(h => (
                  <th key={h} style={{ padding:'10px 12px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {log.map(l => (
                <tr key={l.id} style={{ borderTop:'1px solid #f3f4f6' }}>
                  <td style={{ padding:'10px 12px', fontWeight:600, color:'#111' }}>{l.candidate_name}</td>
                  <td style={{ padding:'10px 12px', color:'#374151' }}>{l.job_title || '—'}</td>
                  <td style={{ padding:'10px 12px', fontWeight:700, color:'#6B3FDB', fontFamily:'monospace' }}>{l.employee_code || '—'}</td>
                  <td style={{ padding:'10px 12px' }}>
                    <span style={{ background:{completed:'#d1fae5',failed:'#fee2e2',in_progress:'#dbeafe',pending:'#fef3c7'}[l.status]||'#f3f4f6', color:{completed:'#065f46',failed:'#991b1b',in_progress:'#1e40af',pending:'#92400e'}[l.status]||'#374151', padding:'2px 8px', borderRadius:9999, fontSize:11, fontWeight:700, textTransform:'capitalize' }}>
                      {l.status}
                    </span>
                  </td>
                  <td style={{ padding:'10px 12px', color:'#374151' }}>{l.employee_id || '—'}</td>
                  <td style={{ padding:'10px 12px', color:'#6b7280' }}>{l.triggered_at ? new Date(l.triggered_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                  <td style={{ padding:'10px 12px', color:'#6b7280' }}>{l.completed_at ? new Date(l.completed_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : l.error_log ? <span style={{ color:'#dc2626', fontSize:11 }}>{l.error_log.slice(0,50)}</span> : '—'}</td>
                </tr>
              ))}
              {!log.length && (
                <tr><td colSpan={7} style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>No employee creation history yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Result Modal */}
      {result && (
        <>
          <div onClick={() => setResult(null)} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.4)', zIndex:900 }} />
          <div style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', background:'#fff', borderRadius:20, padding:36, width:440, zIndex:901, textAlign:'center' }}>
            <div style={{ width:60, height:60, borderRadius:9999, background:'#d1fae5', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 16px' }}>
              <CheckCircle size={30} color="#059669" />
            </div>
            <h2 style={{ fontSize:20, fontWeight:800, margin:'0 0 6px', color:'#111' }}>Employee Created!</h2>
            <p style={{ fontSize:13, color:'#6b7280', margin:'0 0 20px' }}>
              <strong>{result.candidate_name}</strong> is now an employee.
            </p>
            <div style={{ background:'#f0fdf4', borderRadius:10, padding:16, marginBottom:20 }}>
              <div style={{ fontSize:24, fontWeight:900, color:'#059669' }}>{result.employee_code}</div>
              <div style={{ fontSize:12, color:'#6b7280', marginTop:4 }}>Employee Code</div>
            </div>
            <div style={{ textAlign:'left', marginBottom:20 }}>
              <div style={{ fontSize:12, fontWeight:700, color:'#374151', marginBottom:8, textTransform:'uppercase' }}>Pending Next Steps:</div>
              {(result.next_steps || []).map((s, i) => (
                <div key={i} style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 0', fontSize:13, color:'#374151' }}>
                  <div style={{ width:6, height:6, borderRadius:9999, background:'#d97706', flexShrink:0 }} />
                  {s}
                </div>
              ))}
            </div>
            <button onClick={() => setResult(null)} style={{ ...BTN(), width:'100%', justifyContent:'center', padding:12, fontSize:14 }}>
              Done
            </button>
          </div>
        </>
      )}
    </div>
  );
}
