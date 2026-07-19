import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { MessageSquare, ThumbsUp, ThumbsDown, Star, TrendingUp, CheckCircle, X, Plus } from 'lucide-react';

const CARD = { background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:'20px', marginBottom:16 };
const BTN  = (bg='#6B3FDB') => ({ background:bg, color:'#fff', border:'none', borderRadius:8, padding:'8px 16px', fontSize:13, fontWeight:600, cursor:'pointer', display:'flex', alignItems:'center', gap:6 });
const INP  = { width:'100%', padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' };
const LBL  = { display:'block', marginBottom:5, fontSize:11, fontWeight:700, color:'#374151', textTransform:'uppercase', letterSpacing:'.04em' };

const CLASSIFICATIONS = ['Product','Service','Documentation','Training','Software','General'];
const TRIGGER_EVENTS  = ['commissioning','service_visit','amc_visit','project_closure','manual'];

export default function VoiceOfCustomer() {
  const { showToast } = useToast();
  const [tab, setTab] = useState('dashboard');
  const [dashboard, setDashboard] = useState(null);
  const [responses, setResponses] = useState([]);
  const [surveys, setSurveys] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showAddResponse, setShowAddResponse] = useState(false);
  const [showAddSurvey, setShowAddSurvey] = useState(false);
  const [filter, setFilter] = useState({ classification:'', is_actioned:'' });
  const [respForm, setRespForm] = useState({ customer_name:'', trigger_event:'service_visit', rating:5, nps_score:8, suggestions:'', improvement_ideas:'', new_feature_requests:'', classification:'', company_id:'' });
  const [surveyForm, setSurveyForm] = useState({ name:'', trigger_event:'service_visit', is_active:true });

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filter.classification) params.set('classification', filter.classification);
    if (filter.is_actioned !== '') params.set('is_actioned', filter.is_actioned);
    try {
      const [dash, resp, surv] = await Promise.allSettled([
        api.get('/voc/dashboard'),
        api.get(`/voc/responses?${params}`),
        api.get('/voc/surveys'),
      ]);
      if (dash.status === 'fulfilled') setDashboard(dash.value.data);
      if (resp.status === 'fulfilled') setResponses(resp.value.data);
      if (surv.status === 'fulfilled') setSurveys(surv.value.data);
    } finally { setLoading(false); }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const actionResponse = async (id) => {
    try {
      await api.put(`/voc/responses/${id}/action`);
      showToast('Marked as actioned');
      load();
    } catch { showToast('Failed', 'error'); }
  };

  const classifyResponse = async (id, classification) => {
    try {
      await api.put(`/voc/responses/${id}/classify`, { classification });
      showToast('Classified');
      load();
    } catch { showToast('Failed', 'error'); }
  };

  const submitResponse = async () => {
    if (!respForm.customer_name) return showToast('Customer name required', 'error');
    try {
      const company_id = JSON.parse(localStorage.getItem('pulse_user') || '{}').company_id || respForm.company_id;
      await api.post('/voc/responses', { ...respForm, company_id });
      showToast('Feedback submitted');
      setShowAddResponse(false);
      load();
    } catch (err) { showToast(err.response?.data?.error || 'Failed', 'error'); }
  };

  const createSurvey = async () => {
    if (!surveyForm.name) return showToast('Survey name required', 'error');
    try {
      await api.post('/voc/surveys', surveyForm);
      showToast('Survey template created');
      setShowAddSurvey(false);
      load();
    } catch (err) { showToast(err.response?.data?.error || 'Failed', 'error'); }
  };

  const kpis = dashboard?.kpis || {};
  const nps = kpis.nps_score ?? 0;
  const npsColor = nps >= 50 ? '#059669' : nps >= 0 ? '#d97706' : '#dc2626';

  const SentimentBadge = ({ sentiment }) => {
    const map = { promoter:{ bg:'#d1fae5',c:'#065f46',label:'Promoter 😊' }, passive:{ bg:'#fef3c7',c:'#92400e',label:'Passive 😐' }, detractor:{ bg:'#fee2e2',c:'#991b1b',label:'Detractor 😞' } };
    const s = map[sentiment];
    if (!s) return null;
    return <span style={{ background:s.bg, color:s.c, padding:'2px 8px', borderRadius:9999, fontSize:11, fontWeight:700 }}>{s.label}</span>;
  };

  return (
    <div style={{ padding:'24px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#111', margin:0 }}>Voice of Customer</h1>
          <p style={{ fontSize:13, color:'#6b7280', margin:'4px 0 0' }}>NPS, CSAT, feedback classification, improvement pipeline</p>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <button onClick={() => setShowAddSurvey(true)} style={{ ...BTN('#374151') }}><Plus size={14}/>Survey Template</button>
          <button onClick={() => setShowAddResponse(true)} style={BTN()}><Plus size={14}/>Log Feedback</button>
        </div>
      </div>

      {/* NPS + Key Metrics */}
      {dashboard && (
        <div style={{ display:'grid', gridTemplateColumns:'auto 1fr 1fr 1fr 1fr 1fr', gap:12, marginBottom:20, alignItems:'stretch' }}>
          {/* NPS Gauge */}
          <div style={{ ...CARD, margin:0, textAlign:'center', minWidth:160, display:'flex', flexDirection:'column', justifyContent:'center' }}>
            <div style={{ fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase', letterSpacing:'.04em', marginBottom:8 }}>NPS Score</div>
            <div style={{ fontSize:52, fontWeight:900, color:npsColor, lineHeight:1 }}>{nps}</div>
            <div style={{ fontSize:12, color:npsColor, fontWeight:700, marginTop:4 }}>
              {nps >= 50 ? '✓ Excellent' : nps >= 30 ? '▲ Good' : nps >= 0 ? '~ Needs Work' : '▼ Critical'}
            </div>
            <div style={{ display:'flex', justifyContent:'center', gap:10, marginTop:10, fontSize:11 }}>
              <span style={{ color:'#059669' }}>{kpis.promoters||0} 😊</span>
              <span style={{ color:'#6b7280' }}>{kpis.passives||0} 😐</span>
              <span style={{ color:'#dc2626' }}>{kpis.detractors||0} 😞</span>
            </div>
          </div>
          {[
            { label:'Total Responses', value:parseInt(kpis.total_responses||0), color:'#6B3FDB' },
            { label:'Avg Rating', value:kpis.avg_rating ? `${parseFloat(kpis.avg_rating).toFixed(1)}/10` : '—', color:'#d97706' },
            { label:'Avg NPS', value:kpis.avg_nps ? parseFloat(kpis.avg_nps).toFixed(1) : '—', color:'#059669' },
            { label:'Unactioned', value:parseInt(kpis.unactioned||0), color:parseInt(kpis.unactioned||0)>5?'#dc2626':'#374151' },
            { label:'Promoters', value:`${kpis.promoters||0} / ${kpis.total_responses||0}`, color:'#059669' },
          ].map(s => (
            <div key={s.label} style={{ ...CARD, margin:0, textAlign:'center' }}>
              <div style={{ fontSize:26, fontWeight:800, color:s.color }}>{s.value}</div>
              <div style={{ fontSize:11, color:'#6b7280', marginTop:4, fontWeight:600 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display:'flex', gap:4, marginBottom:20, borderBottom:'2px solid #f0f0f4' }}>
        {[['dashboard','Dashboard'],['responses','Responses'],['surveys','Surveys']].map(([t,l]) => (
          <button key={t} onClick={() => setTab(t)} style={{ padding:'10px 18px', border:'none', cursor:'pointer', background:'none', fontSize:13, fontWeight:tab===t?700:500, color:tab===t?'#6B3FDB':'#6b7280', borderBottom:tab===t?'2px solid #6B3FDB':'2px solid transparent', marginBottom:-2 }}>
            {l}
          </button>
        ))}
      </div>

      {/* Dashboard */}
      {tab === 'dashboard' && dashboard && (
        <div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:16, marginBottom:16 }}>
            {/* By Trigger Event */}
            <div style={CARD}>
              <h3 style={{ fontSize:14, fontWeight:700, margin:'0 0 14px', color:'#374151' }}>By Event Type</h3>
              {(dashboard.by_trigger_event||[]).map(e => (
                <div key={e.trigger_event} style={{ display:'flex', justifyContent:'space-between', padding:'6px 0', borderBottom:'1px solid #f3f4f6', fontSize:13 }}>
                  <span style={{ color:'#374151', textTransform:'capitalize' }}>{e.trigger_event?.replace('_',' ')}</span>
                  <div>
                    <span style={{ fontWeight:700, color:'#6B3FDB', marginRight:12 }}>{e.cnt} responses</span>
                    {e.avg_nps && <span style={{ color:'#d97706', fontSize:12 }}>NPS {parseFloat(e.avg_nps).toFixed(1)}</span>}
                  </div>
                </div>
              ))}
              {!dashboard.by_trigger_event?.length && <div style={{ color:'#9ca3af', fontSize:13 }}>No data yet</div>}
            </div>

            {/* By Classification */}
            <div style={CARD}>
              <h3 style={{ fontSize:14, fontWeight:700, margin:'0 0 14px', color:'#374151' }}>Feedback Topics</h3>
              {(dashboard.by_classification||[]).map(c => (
                <div key={c.classification} style={{ marginBottom:10 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:4 }}>
                    <span style={{ fontWeight:600, color:'#374151' }}>{c.classification}</span>
                    <span style={{ color:'#6B3FDB', fontWeight:700 }}>{c.cnt}</span>
                  </div>
                  <div style={{ height:6, background:'#f0f0f4', borderRadius:9999 }}>
                    <div style={{ height:'100%', width:`${Math.max(4, (parseInt(c.cnt) / Math.max(...(dashboard.by_classification||[]).map(x=>parseInt(x.cnt)),1)) * 100)}%`, background:'#6B3FDB', borderRadius:9999 }} />
                  </div>
                </div>
              ))}
              {!dashboard.by_classification?.length && <div style={{ color:'#9ca3af', fontSize:13 }}>No classification data</div>}
            </div>

            {/* NPS Trend */}
            <div style={CARD}>
              <h3 style={{ fontSize:14, fontWeight:700, margin:'0 0 14px', color:'#374151' }}>NPS Trend (12 months)</h3>
              {(dashboard.trend||[]).length > 0 ? (
                <div style={{ display:'flex', alignItems:'flex-end', gap:4, height:80 }}>
                  {dashboard.trend.map((m,i) => {
                    const score = parseFloat(m.avg_nps || 0);
                    const maxScore = 10;
                    const h = Math.max(4, ((score + 10) / (maxScore + 10)) * 70);
                    const color = score >= 7 ? '#059669' : score >= 5 ? '#d97706' : '#dc2626';
                    return (
                      <div key={i} title={`${m.month}: NPS ${score.toFixed(1)}`} style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:2 }}>
                        <div style={{ fontSize:8, color:'#9ca3af' }}>{score.toFixed(0)}</div>
                        <div style={{ width:'100%', height:h, background:color, borderRadius:'2px 2px 0 0', opacity:.85 }} />
                        <div style={{ fontSize:8, color:'#9ca3af', transform:'rotate(-30deg)', transformOrigin:'top' }}>{m.month?.slice(5)}</div>
                      </div>
                    );
                  })}
                </div>
              ) : <div style={{ color:'#9ca3af', fontSize:13 }}>No trend data yet</div>}
            </div>
          </div>

          {/* Top Complaints & Suggestions */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
            <div style={CARD}>
              <h3 style={{ fontSize:14, fontWeight:700, margin:'0 0 12px', color:'#dc2626', display:'flex', alignItems:'center', gap:6 }}>
                <ThumbsDown size={16}/>Top Complaints (Detractors)
              </h3>
              {(dashboard.top_complaints||[]).length > 0 ? dashboard.top_complaints.slice(0,5).map((s,i) => (
                <div key={i} style={{ padding:'8px 12px', background:'#fef2f2', borderRadius:8, marginBottom:6, fontSize:13, color:'#374151', borderLeft:'3px solid #dc2626' }}>
                  {s}
                </div>
              )) : <div style={{ color:'#9ca3af', fontSize:13 }}>No complaints recorded</div>}
            </div>
            <div style={CARD}>
              <h3 style={{ fontSize:14, fontWeight:700, margin:'0 0 12px', color:'#059669', display:'flex', alignItems:'center', gap:6 }}>
                <ThumbsUp size={16}/>Top Improvement Suggestions
              </h3>
              {(dashboard.top_suggestions||[]).length > 0 ? dashboard.top_suggestions.slice(0,5).map((s,i) => (
                <div key={i} style={{ padding:'8px 12px', background:'#f0fdf4', borderRadius:8, marginBottom:6, fontSize:13, color:'#374151', borderLeft:'3px solid #059669' }}>
                  {s}
                </div>
              )) : <div style={{ color:'#9ca3af', fontSize:13 }}>No suggestions recorded</div>}
            </div>
          </div>
        </div>
      )}

      {/* Responses */}
      {tab === 'responses' && (
        <div>
          <div style={{ display:'flex', gap:10, marginBottom:14 }}>
            <select value={filter.classification} onChange={e => setFilter(p=>({...p,classification:e.target.value}))}
              style={{ ...INP, width:'auto', appearance:'auto' }}>
              <option value="">All Topics</option>
              {CLASSIFICATIONS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={filter.is_actioned} onChange={e => setFilter(p=>({...p,is_actioned:e.target.value}))}
              style={{ ...INP, width:'auto', appearance:'auto' }}>
              <option value="">All Status</option>
              <option value="false">Unactioned</option>
              <option value="true">Actioned</option>
            </select>
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            {responses.map(r => (
              <div key={r.id} style={{ ...CARD, margin:0 }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:10 }}>
                  <div>
                    <div style={{ fontWeight:700, color:'#111', fontSize:14 }}>{r.customer_name || 'Anonymous'}</div>
                    <div style={{ fontSize:12, color:'#6b7280', marginTop:2 }}>
                      {r.trigger_event?.replace('_',' ')} • {r.submitted_at ? new Date(r.submitted_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : ''}
                    </div>
                  </div>
                  <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                    {r.nps_score !== null && r.nps_score !== undefined && (
                      <div style={{ textAlign:'center' }}>
                        <div style={{ fontSize:20, fontWeight:800, color:r.nps_score>=9?'#059669':r.nps_score>=7?'#d97706':'#dc2626' }}>{r.nps_score}</div>
                        <div style={{ fontSize:10, color:'#9ca3af' }}>NPS</div>
                      </div>
                    )}
                    {r.rating && (
                      <div style={{ textAlign:'center' }}>
                        <div style={{ fontSize:16, fontWeight:700, color:'#d97706' }}>{'⭐'.repeat(Math.round(r.rating/2))}</div>
                        <div style={{ fontSize:10, color:'#9ca3af' }}>{r.rating}/10</div>
                      </div>
                    )}
                    <SentimentBadge sentiment={r.sentiment} />
                  </div>
                </div>
                <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:8 }}>
                  {r.classification && (
                    <span style={{ background:'#f5f3ff', color:'#6B3FDB', border:'1px solid #e9e4ff', padding:'2px 10px', borderRadius:9999, fontSize:11, fontWeight:700 }}>{r.classification}</span>
                  )}
                  <select value={r.classification || ''} onChange={e => classifyResponse(r.id, e.target.value)}
                    style={{ border:'1px solid #e5e7eb', borderRadius:6, padding:'2px 8px', fontSize:11, cursor:'pointer' }}>
                    <option value="">Classify…</option>
                    {CLASSIFICATIONS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  {r.is_actioned && <span style={{ background:'#d1fae5', color:'#065f46', padding:'2px 8px', borderRadius:9999, fontSize:11, fontWeight:700 }}>✓ Actioned by {r.actioned_by}</span>}
                </div>
                {r.suggestions && (
                  <div style={{ marginBottom:6 }}>
                    <span style={{ fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase' }}>Suggestions: </span>
                    <span style={{ fontSize:13, color:'#374151' }}>{r.suggestions}</span>
                  </div>
                )}
                {r.improvement_ideas && (
                  <div style={{ marginBottom:6 }}>
                    <span style={{ fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase' }}>Improvement Ideas: </span>
                    <span style={{ fontSize:13, color:'#374151' }}>{r.improvement_ideas}</span>
                  </div>
                )}
                {r.new_feature_requests && (
                  <div style={{ marginBottom:8 }}>
                    <span style={{ fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase' }}>Feature Requests: </span>
                    <span style={{ fontSize:13, color:'#374151' }}>{r.new_feature_requests}</span>
                  </div>
                )}
                {!r.is_actioned && (
                  <div style={{ display:'flex', justifyContent:'flex-end' }}>
                    <button onClick={() => actionResponse(r.id)} style={{ background:'none', border:'1px solid #e5e7eb', borderRadius:6, padding:'4px 12px', fontSize:12, cursor:'pointer', color:'#374151', display:'flex', alignItems:'center', gap:4 }}>
                      <CheckCircle size={12}/> Mark Actioned
                    </button>
                  </div>
                )}
              </div>
            ))}
            {!responses.length && (
              <div style={{ textAlign:'center', padding:60, color:'#9ca3af', background:'#fff', borderRadius:12, border:'1px solid #f0f0f4' }}>
                <MessageSquare size={40} style={{ marginBottom:12, opacity:.3 }}/>
                <p>No feedback responses yet. Log the first one or configure auto-trigger surveys.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Surveys */}
      {tab === 'surveys' && (
        <div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))', gap:14 }}>
            {surveys.map(s => (
              <div key={s.id} style={{ ...CARD, margin:0 }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:10 }}>
                  <div>
                    <div style={{ fontWeight:700, color:'#111', fontSize:14 }}>{s.name}</div>
                    <div style={{ fontSize:12, color:'#6b7280', marginTop:2, textTransform:'capitalize' }}>Trigger: {s.trigger_event?.replace('_',' ')}</div>
                  </div>
                  <span style={{ background:s.is_active?'#d1fae5':'#f3f4f6', color:s.is_active?'#065f46':'#6b7280', padding:'2px 8px', borderRadius:9999, fontSize:11, fontWeight:700 }}>
                    {s.is_active ? 'Active' : 'Inactive'}
                  </span>
                </div>
                <div style={{ fontSize:12, color:'#9ca3af' }}>{(s.questions||[]).length} questions</div>
              </div>
            ))}
            {!surveys.length && (
              <div style={{ gridColumn:'1/-1', textAlign:'center', padding:60, color:'#9ca3af', background:'#fff', borderRadius:12, border:'1px solid #f0f0f4' }}>
                No survey templates yet. Create one to auto-trigger feedback collection.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Log Feedback Modal */}
      {showAddResponse && (
        <>
          <div onClick={() => setShowAddResponse(false)} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.4)', zIndex:900 }} />
          <div style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', background:'#fff', borderRadius:16, padding:28, width:520, zIndex:901, maxHeight:'90vh', overflowY:'auto' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <h2 style={{ fontSize:17, fontWeight:700, margin:0 }}>Log Customer Feedback</h2>
              <button onClick={() => setShowAddResponse(false)} style={{ background:'none', border:'none', cursor:'pointer' }}><X size={18}/></button>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
              <div style={{ gridColumn:'1/-1' }}>
                <label style={LBL}>Customer Name *</label>
                <input type="text" value={respForm.customer_name} onChange={e => setRespForm(p=>({...p,customer_name:e.target.value}))} style={INP} />
              </div>
              <div>
                <label style={LBL}>Trigger Event</label>
                <select value={respForm.trigger_event} onChange={e => setRespForm(p=>({...p,trigger_event:e.target.value}))} style={{ ...INP, appearance:'auto' }}>
                  {TRIGGER_EVENTS.map(t => <option key={t} value={t}>{t.replace('_',' ')}</option>)}
                </select>
              </div>
              <div>
                <label style={LBL}>Classification</label>
                <select value={respForm.classification} onChange={e => setRespForm(p=>({...p,classification:e.target.value}))} style={{ ...INP, appearance:'auto' }}>
                  <option value="">Auto-detect</option>
                  {CLASSIFICATIONS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label style={LBL}>Rating (1-10)</label>
                <input type="number" min={1} max={10} value={respForm.rating} onChange={e => setRespForm(p=>({...p,rating:parseInt(e.target.value)}))} style={INP} />
              </div>
              <div>
                <label style={LBL}>NPS Score (0-10)</label>
                <input type="number" min={0} max={10} value={respForm.nps_score} onChange={e => setRespForm(p=>({...p,nps_score:parseInt(e.target.value)}))} style={INP} />
              </div>
              <div style={{ gridColumn:'1/-1' }}>
                <label style={LBL}>What went well / Suggestions</label>
                <textarea value={respForm.suggestions} onChange={e => setRespForm(p=>({...p,suggestions:e.target.value}))} style={{ ...INP, height:70, resize:'vertical' }} />
              </div>
              <div style={{ gridColumn:'1/-1' }}>
                <label style={LBL}>Improvement Ideas</label>
                <textarea value={respForm.improvement_ideas} onChange={e => setRespForm(p=>({...p,improvement_ideas:e.target.value}))} style={{ ...INP, height:70, resize:'vertical' }} />
              </div>
              <div style={{ gridColumn:'1/-1' }}>
                <label style={LBL}>New Feature Requests</label>
                <textarea value={respForm.new_feature_requests} onChange={e => setRespForm(p=>({...p,new_feature_requests:e.target.value}))} style={{ ...INP, height:60, resize:'vertical' }} />
              </div>
            </div>
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:20 }}>
              <button onClick={() => setShowAddResponse(false)} style={{ padding:'8px 16px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Cancel</button>
              <button onClick={submitResponse} style={BTN()}>Submit Feedback</button>
            </div>
          </div>
        </>
      )}

      {/* Create Survey Modal */}
      {showAddSurvey && (
        <>
          <div onClick={() => setShowAddSurvey(false)} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.4)', zIndex:900 }} />
          <div style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', background:'#fff', borderRadius:16, padding:28, width:420, zIndex:901 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <h2 style={{ fontSize:17, fontWeight:700, margin:0 }}>Create Survey Template</h2>
              <button onClick={() => setShowAddSurvey(false)} style={{ background:'none', border:'none', cursor:'pointer' }}><X size={18}/></button>
            </div>
            <div style={{ marginBottom:14 }}>
              <label style={LBL}>Survey Name *</label>
              <input type="text" value={surveyForm.name} onChange={e => setSurveyForm(p=>({...p,name:e.target.value}))} style={INP} placeholder="Post-Service Visit Survey" />
            </div>
            <div style={{ marginBottom:14 }}>
              <label style={LBL}>Auto-Trigger Event</label>
              <select value={surveyForm.trigger_event} onChange={e => setSurveyForm(p=>({...p,trigger_event:e.target.value}))} style={{ ...INP, appearance:'auto' }}>
                {TRIGGER_EVENTS.map(t => <option key={t} value={t}>{t.replace('_',' ')}</option>)}
              </select>
            </div>
            <div style={{ background:'#f0fdf4', padding:'10px 12px', borderRadius:8, fontSize:12, color:'#065f46', marginBottom:16 }}>
              ✓ Default questions (NPS + rating + open text) will be auto-generated based on trigger event.
            </div>
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button onClick={() => setShowAddSurvey(false)} style={{ padding:'8px 16px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Cancel</button>
              <button onClick={createSurvey} style={BTN()}>Create Survey</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
