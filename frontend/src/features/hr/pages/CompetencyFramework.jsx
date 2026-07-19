// frontend/src/features/hr/pages/CompetencyFramework.jsx
import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/context/ToastContext';
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Cell } from 'recharts';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const inputStyle = { width:'100%', boxSizing:'border-box', padding:'8px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 };
const LEVEL_LABELS = { 1:'Novice', 2:'Developing', 3:'Proficient', 4:'Advanced', 5:'Expert' };
const LEVEL_COLORS = { 1:'#dc2626', 2:'#f97316', 3:'#eab308', 4:'#86efac', 5:'#16a34a' };

function Modal({ title, onClose, children, wide }) {
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}>

      <ConfirmDialog
        open={!!pendingDeleteComp}
        title="Delete Competency"
        message="Delete this competency?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteComp}
        onCancel={() => setPendingDeleteComp(null)}
      />
      <div style={{ background:'#fff', borderRadius:12, padding:24, width:'100%', maxWidth: wide ? 760 : 560, maxHeight:'90vh', overflowY:'auto' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
          <h3 style={{ margin:0, color:'#4c1d95', fontSize:16 }}>{title}</h3>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', fontSize:20, color:'#6b7280' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function CompetencyFramework() {
  const toast = useToast();
  const [tab, setTab] = useState('library');
  const [competencies, setCompetencies] = useState([]);
  const [gaps, setGaps] = useState([]);
  const [empId, setEmpId] = useState('');
  const [empCompetencies, setEmpCompetencies] = useState([]);
  const [assessValues, setAssessValues] = useState({});
  const [showForm, setShowForm] = useState(false);
  const [editComp, setEditComp] = useState(null);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ name:'', category:'', description:'', level_1_descriptor:'Awareness', level_2_descriptor:'Basic application', level_3_descriptor:'Independent application', level_4_descriptor:'Advanced application', level_5_descriptor:'Expert / Coach' });
  const [pendingDeleteComp, setPendingDeleteComp] = useState(null);

  const load = useCallback(async () => {
    const [cRes, gRes] = await Promise.allSettled([
      api.get('/competencies'),
      api.get('/competencies/gaps/department'),
    ]);
    if (cRes.status === 'fulfilled') setCompetencies(cRes.value.data || []);
    if (gRes.status === 'fulfilled') setGaps(gRes.value.data || []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveCompetency = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (editComp) {
        await api.put(`/competencies/${editComp.id}`, form);
        toast.success('Competency updated');
      } else {
        await api.post('/competencies', form);
        toast.success('Competency created');
      }
      setShowForm(false); setEditComp(null);
      setForm({ name:'', category:'', description:'', level_1_descriptor:'Awareness', level_2_descriptor:'Basic application', level_3_descriptor:'Independent application', level_4_descriptor:'Advanced application', level_5_descriptor:'Expert / Coach' });
      load();
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed'); }
    finally { setLoading(false); }
  };

  const deleteComp = async () => {
    if (!pendingDeleteComp) return;
    const id = pendingDeleteComp;
    setPendingDeleteComp(null);
    try { await api.delete(`/competencies/${id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err?.response?.data?.error || 'Failed'); }
  };

  const loadEmpCompetencies = async () => {
    if (!empId) return;
    try {
      const r = await api.get(`/competencies/employee/${empId}`);
      setEmpCompetencies(r.data || []);
      const vals = {};
      r.data.forEach(c => { vals[c.id] = c.assessed_level || 0; });
      setAssessValues(vals);
    } catch { setEmpCompetencies([]); }
  };

  const submitAssessment = async () => {
    if (!empId) { toast.error('Enter an employee ID'); return; }
    setLoading(true);
    try {
      const assessments = Object.entries(assessValues)
        .filter(([, v]) => v > 0)
        .map(([competency_id, assessed_level]) => ({ competency_id: parseInt(competency_id), assessed_level: parseInt(assessed_level) }));
      await api.post(`/competencies/employee/${empId}/assess`, { assessments });
      toast.success(`${assessments.length} competencies assessed`);
      loadEmpCompetencies();
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed'); }
    finally { setLoading(false); }
  };

  const tabStyle = (k) => ({ padding:'8px 18px', border:'none', cursor:'pointer', borderRadius:'6px 6px 0 0', fontWeight:600, fontSize:14, background: tab===k ? '#6B3FDB' : '#e9e4ff', color: tab===k ? '#fff' : '#6B3FDB' });
  const categories = [...new Set(competencies.map(c => c.category).filter(Boolean))];

  return (
    <div style={{ padding:24, background:'#f5f3ff', minHeight:'100vh' }}>
      <div style={{ marginBottom:16 }}>
        <h2 style={{ margin:0, color:'#4c1d95', fontSize:22 }}>🧠 Competency Framework</h2>
        <p style={{ margin:0, color:'#6b7280', fontSize:13 }}>Define competencies, assess employees, and identify gaps</p>
      </div>

      <div style={{ display:'flex', gap:4, borderBottom:'2px solid #e9e4ff', flexWrap:'wrap' }}>
        {[['library','Competency Library'],['assess','Employee Assessment'],['gaps','Gap Analysis']].map(([k,l]) => (
          <button key={k} style={tabStyle(k)} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderTop:'none', borderRadius:'0 8px 8px 8px', padding:20 }}>

        {/* ── LIBRARY TAB ── */}
        {tab === 'library' && (
          <div>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
              <h3 style={{ margin:0, color:'#4c1d95' }}>Competency Library ({competencies.length})</h3>
              <button onClick={() => { setShowForm(true); setEditComp(null); setForm({ name:'', category:'', description:'', level_1_descriptor:'Awareness', level_2_descriptor:'Basic application', level_3_descriptor:'Independent application', level_4_descriptor:'Advanced application', level_5_descriptor:'Expert / Coach' }); }}
                style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'8px 18px', cursor:'pointer', fontWeight:600 }}>
                + Add Competency
              </button>
            </div>

            {categories.length > 0 && categories.map(cat => (
              <div key={cat} style={{ marginBottom:24 }}>
                <h4 style={{ color:'#6B3FDB', margin:'0 0 10px', fontSize:13, textTransform:'uppercase', letterSpacing:1 }}>{cat}</h4>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))', gap:12 }}>
                  {competencies.filter(c => c.category === cat).map(c => (
                    <div key={c.id} style={{ background:'#f5f3ff', border:'1px solid #e9e4ff', borderRadius:10, padding:16 }}>
                      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:6 }}>
                        <span style={{ fontWeight:700, color:'#1f2937', fontSize:14 }}>{c.name}</span>
                        <div style={{ display:'flex', gap:6 }}>
                          <button onClick={() => { setEditComp(c); setForm({ name:c.name, category:c.category||'', description:c.description||'', level_1_descriptor:c.level_1_descriptor||'', level_2_descriptor:c.level_2_descriptor||'', level_3_descriptor:c.level_3_descriptor||'', level_4_descriptor:c.level_4_descriptor||'', level_5_descriptor:c.level_5_descriptor||'' }); setShowForm(true); }} style={{ background:'none', border:'none', cursor:'pointer', color:'#6B3FDB', fontSize:13 }}>✎</button>
                          <button onClick={() => setPendingDeleteComp(c.id)} style={{ background:'none', border:'none', cursor:'pointer', color:'#dc2626', fontSize:13 }}>✕</button>
                        </div>
                      </div>
                      {c.description && <p style={{ fontSize:12, color:'#6b7280', margin:'0 0 8px', lineHeight:1.4 }}>{c.description}</p>}
                      <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
                        {[1,2,3,4,5].map(l => (
                          <div key={l} title={c[`level_${l}_descriptor`] || LEVEL_LABELS[l]}
                            style={{ width:20, height:20, borderRadius:4, background:LEVEL_COLORS[l], opacity:0.8, cursor:'help' }} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {/* Uncategorized */}
            {competencies.filter(c => !c.category).length > 0 && (
              <div>
                <h4 style={{ color:'#9ca3af', margin:'0 0 10px', fontSize:13, textTransform:'uppercase', letterSpacing:1 }}>Uncategorized</h4>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))', gap:12 }}>
                  {competencies.filter(c => !c.category).map(c => (
                    <div key={c.id} style={{ background:'#f5f3ff', border:'1px solid #e9e4ff', borderRadius:10, padding:16, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                      <span style={{ fontWeight:600, color:'#1f2937', fontSize:13 }}>{c.name}</span>
                      <div style={{ display:'flex', gap:6 }}>
                        <button onClick={() => { setEditComp(c); setShowForm(true); }} style={{ background:'none', border:'none', cursor:'pointer', color:'#6B3FDB', fontSize:13 }}>✎</button>
                        <button onClick={() => deleteComp(c.id)} style={{ background:'none', border:'none', cursor:'pointer', color:'#dc2626', fontSize:13 }}>✕</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {competencies.length === 0 && <p style={{ color:'#9ca3af', textAlign:'center', padding:'32px 0' }}>No competencies defined yet</p>}
          </div>
        )}

        {/* ── ASSESS TAB ── */}
        {tab === 'assess' && (
          <div>
            <div style={{ display:'flex', gap:10, alignItems:'flex-end', marginBottom:20, flexWrap:'wrap' }}>
              <div>
                <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Employee ID</label>
                <input value={empId} onChange={e => setEmpId(e.target.value)} style={{ ...inputStyle, width:180 }} placeholder="Employee ID" />
              </div>
              <button onClick={loadEmpCompetencies} style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'9px 18px', cursor:'pointer', fontWeight:600 }}>Load</button>
            </div>

            {empCompetencies.length > 0 && (
              <div>
                <div style={{ display:'flex', flexDirection:'column', gap:12, marginBottom:20 }}>
                  {empCompetencies.map(c => (
                    <div key={c.id} style={{ background:'#f5f3ff', border:'1px solid #e9e4ff', borderRadius:10, padding:16 }}>
                      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10, flexWrap:'wrap', gap:8 }}>
                        <div>
                          <span style={{ fontWeight:700, color:'#1f2937', fontSize:14 }}>{c.name}</span>
                          {c.category && <span style={{ fontSize:11, color:'#9ca3af', marginLeft:8 }}>{c.category}</span>}
                        </div>
                        <div style={{ display:'flex', alignItems:'center', gap:8, fontSize:12, color:'#6b7280' }}>
                          <span>Current: <strong style={{ color: LEVEL_COLORS[c.assessed_level] || '#9ca3af' }}>{c.assessed_level ? `L${c.assessed_level} ${LEVEL_LABELS[c.assessed_level]}` : 'Not assessed'}</strong></span>
                          {c.gap > 0 && <span style={{ background:'#fef2f2', color:'#dc2626', padding:'2px 8px', borderRadius:10, fontWeight:600, fontSize:11 }}>Gap: {c.gap}</span>}
                        </div>
                      </div>
                      <div style={{ display:'flex', gap:6 }}>
                        {[1,2,3,4,5].map(l => (
                          <div key={l} onClick={() => setAssessValues(v => ({...v, [c.id]: l}))}
                            title={c[`level_${l}_descriptor`] || LEVEL_LABELS[l]}
                            style={{ flex:1, padding:'8px 4px', borderRadius:7, background: assessValues[c.id]===l ? LEVEL_COLORS[l] : LEVEL_COLORS[l]+'30', border:`2px solid ${assessValues[c.id]===l ? LEVEL_COLORS[l] : 'transparent'}`, cursor:'pointer', textAlign:'center', fontSize:12, fontWeight:700, color: assessValues[c.id]===l ? '#fff' : '#374151', transition:'all 0.15s' }}>
                            L{l}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <button onClick={submitAssessment} disabled={loading} style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'10px 28px', cursor:'pointer', fontWeight:700, fontSize:15 }}>
                  {loading ? 'Saving…' : 'Save Assessment'}
                </button>
              </div>
            )}
            {empCompetencies.length === 0 && <p style={{ color:'#9ca3af', textAlign:'center', padding:'32px 0' }}>Enter an employee ID and click Load to begin assessment</p>}
          </div>
        )}

        {/* ── GAPS TAB ── */}
        {tab === 'gaps' && (
          <div>
            <h3 style={{ margin:'0 0 16px', color:'#4c1d95' }}>Department Competency Gaps</h3>
            {gaps.length > 0 ? (
              <div>
                <div style={{ height:260, marginBottom:24 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={gaps.slice(0,15)} layout="vertical" margin={{ left:160, right:20, top:4, bottom:4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e9e4ff" />
                      <XAxis type="number" domain={[0,5]} tick={{ fontSize:10 }} />
                      <YAxis type="category" dataKey="competency" tick={{ fontSize:10 }} width={160} />
                      <Tooltip formatter={(v,n) => [v, n.replace(/_/g,' ')]} />
                      <Bar dataKey="avg_assessed" name="Avg Assessed" radius={[0,4,4,0]}>
                        {gaps.slice(0,15).map((g,i) => <Cell key={i} fill={g.avg_gap > 1 ? '#dc2626' : g.avg_gap > 0 ? '#f97316' : '#16a34a'} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <thead><tr style={{ background:'#f5f3ff' }}>
                    {['Competency','Category','Department','Avg Assessed','Avg Required','Avg Gap','Employees'].map(h => (
                      <th key={h} style={{ padding:'8px 12px', textAlign:'left', borderBottom:'1px solid #e9e4ff', color:'#4c1d95', fontWeight:600 }}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {gaps.map((g,i) => (
                      <tr key={i} style={{ borderBottom:'1px solid #f0ebff' }}>
                        <td style={{ padding:'8px 12px', fontWeight:600 }}>{g.competency}</td>
                        <td style={{ padding:'8px 12px', color:'#6b7280' }}>{g.category}</td>
                        <td style={{ padding:'8px 12px' }}>{g.department}</td>
                        <td style={{ padding:'8px 12px', fontWeight:700, color:LEVEL_COLORS[Math.round(g.avg_assessed)] }}>{g.avg_assessed}</td>
                        <td style={{ padding:'8px 12px', color:'#6b7280' }}>{g.avg_required}</td>
                        <td style={{ padding:'8px 12px', fontWeight:700, color: g.avg_gap > 1 ? '#dc2626' : '#f97316' }}>{g.avg_gap}</td>
                        <td style={{ padding:'8px 12px' }}>{g.employee_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p style={{ color:'#9ca3af', textAlign:'center', padding:'48px 0' }}>No competency gap data. Assess employees first to see gaps.</p>
            )}
          </div>
        )}
      </div>

      {/* Competency form modal */}
      {showForm && (
        <Modal title={editComp ? 'Edit Competency' : 'Add Competency'} wide onClose={() => { setShowForm(false); setEditComp(null); }}>
          <form onSubmit={saveCompetency}>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 }}>
              <div style={{ gridColumn:'1/-1' }}>
                <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Name *</label>
                <input required value={form.name} onChange={e => setForm(f => ({...f, name:e.target.value}))} style={inputStyle} />
              </div>
              <div>
                <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Category</label>
                <select value={form.category} onChange={e => setForm(f => ({...f, category:e.target.value}))} style={inputStyle}>
                  <option value="">-- Select Category --</option>
                  {['Technical','Leadership','Behavioral','Functional','Managerial','Core'].map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Description</label>
                <input value={form.description} onChange={e => setForm(f => ({...f, description:e.target.value}))} style={inputStyle} />
              </div>
            </div>
            <h4 style={{ color:'#6B3FDB', margin:'8px 0 10px', fontSize:13 }}>Level Descriptors</h4>
            {[1,2,3,4,5].map(l => (
              <div key={l} style={{ marginBottom:10 }}>
                <label style={{ fontSize:12, fontWeight:600, color: LEVEL_COLORS[l], display:'block', marginBottom:4 }}>L{l} — {LEVEL_LABELS[l]}</label>
                <input value={form[`level_${l}_descriptor`]} onChange={e => setForm(f => ({...f, [`level_${l}_descriptor`]:e.target.value}))} style={inputStyle} />
              </div>
            ))}
            <div style={{ display:'flex', gap:10, marginTop:16 }}>
              <button type="submit" disabled={loading} style={{ flex:1, background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'9px 0', cursor:'pointer', fontWeight:600 }}>{loading ? 'Saving…' : editComp ? 'Update' : 'Create'}</button>
              <button type="button" onClick={() => { setShowForm(false); setEditComp(null); }} style={{ flex:1, background:'#e9e4ff', color:'#6B3FDB', border:'none', borderRadius:8, padding:'9px 0', cursor:'pointer', fontWeight:600 }}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
