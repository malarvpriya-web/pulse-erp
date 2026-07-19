import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { TrendingUp, TrendingDown, IndianRupee, Layers, Search, BarChart2, Plus, X } from 'lucide-react';

const fmtL = v => {
  const n = Number(v||0);
  if (n >= 10000000) return `₹${(n/10000000).toFixed(2)}Cr`;
  if (n >= 100000)   return `₹${(n/100000).toFixed(1)}L`;
  if (n >= 1000)     return `₹${(n/1000).toFixed(0)}K`;
  return `₹${n.toLocaleString('en-IN')}`;
};

const pctColor = v => Number(v) >= 20 ? '#10b981' : Number(v) >= 10 ? '#f59e0b' : '#ef4444';
const pctBg   = v => Number(v) >= 20 ? '#f0fdf4' : Number(v) >= 10 ? '#fffbeb' : '#fef2f2';

const COST_TYPES = [
  'Sales Travel','Application Engineering','Design','Procurement','Material',
  'Manufacturing','Quality','FAT','Transport','Installation','Commissioning','Service','AMC',
];

const EMPTY_COST = { cost_type:'Material', description:'', customer_name:'', project_number:'', po_number:'', site_name:'', amount:'', cost_date:'' };

export default function ProjectProfitability() {
  const [projects, setProjects] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showCostForm, setShowCostForm] = useState(false);
  const [costForm, setCostForm] = useState(EMPTY_COST);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState('projects'); // 'projects' | 'cost-lines'
  const [costLines, setCostLines] = useState([]);
  const [clLoading, setClLoading] = useState(false);

  const load = () => {
    setLoading(true);
    api.get('/project-profitability/all')
      .then(r => setProjects(Array.isArray(r.data) ? r.data : []))
      .catch(() => setProjects([]))
      .finally(() => setLoading(false));
  };

  const loadCostLines = () => {
    setClLoading(true);
    api.get('/project-profitability/cost-lines', { params: { limit:100 } })
      .then(r => setCostLines(Array.isArray(r.data) ? r.data : []))
      .catch(() => setCostLines([]))
      .finally(() => setClLoading(false));
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { if (tab === 'cost-lines') loadCostLines(); }, [tab]);

  const openDetail = async (p) => {
    setSelected(p);
    setDetailLoading(true);
    try {
      const { data } = await api.get(`/project-profitability/summary/${p.id}`);
      setDetail(data);
    } catch { setDetail(null); }
    finally { setDetailLoading(false); }
  };

  const handleSaveCost = async () => {
    if (!costForm.cost_type || !costForm.amount) return;
    setSaving(true);
    try {
      await api.post('/project-profitability/cost-lines', { ...costForm, amount: Number(costForm.amount) });
      setShowCostForm(false); setCostForm(EMPTY_COST);
      if (tab === 'cost-lines') loadCostLines();
    } catch (err) { console.error(err); }
    finally { setSaving(false); }
  };

  const filtered = projects.filter(p => {
    return !search || [p.project_name, p.project_number, p.customer_name]
      .some(v => (v||'').toLowerCase().includes(search.toLowerCase()));
  });

  const totals = {
    revenue: filtered.reduce((s,p) => s + p.revenue, 0),
    profit: filtered.reduce((s,p) => s + p.actual_profit, 0),
    cost: filtered.reduce((s,p) => s + (p.revenue - p.actual_profit), 0),
  };

  const inputStyle = { width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' };
  const labelStyle = { display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:5 };

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Project Profitability</h1>
          <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>Revenue, cost breakdown and margin analysis per project</p>
        </div>
        <button onClick={() => setShowCostForm(true)}
          style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
          <Plus size={15}/> Add Cost Line
        </button>
      </div>

      {/* Summary cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:14, marginBottom:20 }}>
        {[
          { label:'Total Revenue', value: fmtL(totals.revenue), icon: IndianRupee, color:'#10b981' },
          { label:'Total Cost', value: fmtL(totals.cost), icon: Layers, color:'#f59e0b' },
          { label:'Gross Profit', value: fmtL(totals.profit), icon: totals.profit >= 0 ? TrendingUp : TrendingDown, color: totals.profit >= 0 ? '#10b981' : '#ef4444' },
        ].map(k => (
          <div key={k.label} style={{ background:'#fff', borderRadius:12, padding:20, border:'1px solid #f0f0f4' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <div>
                <p style={{ fontSize:12, color:'#9ca3af', margin:'0 0 8px', fontWeight:500, textTransform:'uppercase' }}>{k.label}</p>
                <p style={{ fontSize:24, fontWeight:700, color:'#1f2937', margin:0 }}>{k.value}</p>
              </div>
              <div style={{ background:k.color+'18', borderRadius:10, padding:10 }}>
                <k.icon size={20} color={k.color}/>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display:'flex', gap:0, marginBottom:20, background:'#fff', borderRadius:10, padding:4, border:'1px solid #f0f0f4', alignSelf:'flex-start', width:'fit-content' }}>
        {['projects','cost-lines'].map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{ padding:'7px 18px', borderRadius:7, border:'none', cursor:'pointer', fontSize:13, fontWeight:500,
              background: tab===t ? '#6B3FDB' : 'transparent',
              color: tab===t ? '#fff' : '#6b7280' }}>
            {t === 'projects' ? 'Project Margins' : 'Cost Lines'}
          </button>
        ))}
      </div>

      {tab === 'projects' && (
        <>
          <div style={{ display:'flex', gap:12, marginBottom:16 }}>
            <div style={{ position:'relative', flex:1 }}>
              <Search size={14} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }}/>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search project, customer..."
                style={{ width:'100%', paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8, border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
            </div>
          </div>

          <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden' }}>
            {loading ? (
              <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>Loading...</div>
            ) : filtered.length === 0 ? (
              <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>No projects found.</div>
            ) : (
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                <thead>
                  <tr style={{ background:'#f9fafb' }}>
                    {['Project','Customer','Revenue','Material','Labour','Travel','Profit','Margin %','Status'].map(h => (
                      <th key={h} style={{ padding:'10px 14px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4', whiteSpace:'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p, i) => (
                    <tr key={p.id} onClick={() => openDetail(p)} style={{ borderBottom:'1px solid #f9fafb', background:i%2===0?'#fff':'#fafafa', cursor:'pointer' }}>
                      <td style={{ padding:'10px 14px' }}>
                        <div style={{ fontWeight:600, color:'#1f2937' }}>{p.project_name}</div>
                        {p.project_number && <div style={{ fontSize:11, color:'#9ca3af' }}>{p.project_number}</div>}
                      </td>
                      <td style={{ padding:'10px 14px', color:'#6b7280' }}>{p.customer_name || '—'}</td>
                      <td style={{ padding:'10px 14px', fontWeight:500, color:'#374151' }}>{fmtL(p.revenue)}</td>
                      <td style={{ padding:'10px 14px', color:'#6b7280' }}>{fmtL(p.material_cost)}</td>
                      <td style={{ padding:'10px 14px', color:'#6b7280' }}>{fmtL(p.labour_cost)}</td>
                      <td style={{ padding:'10px 14px', color:'#6b7280' }}>{fmtL(p.travel_cost)}</td>
                      <td style={{ padding:'10px 14px', fontWeight:600, color: p.actual_profit>=0?'#10b981':'#ef4444' }}>{fmtL(p.actual_profit)}</td>
                      <td style={{ padding:'10px 14px' }}>
                        <span style={{ background:pctBg(p.margin_pct), color:pctColor(p.margin_pct), padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:700 }}>
                          {Number(p.margin_pct).toFixed(1)}%
                        </span>
                      </td>
                      <td style={{ padding:'10px 14px', color:'#9ca3af', fontSize:12 }}>{p.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {tab === 'cost-lines' && (
        <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden' }}>
          {clLoading ? (
            <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>Loading...</div>
          ) : costLines.length === 0 ? (
            <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>No cost lines recorded.</div>
          ) : (
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <thead>
                <tr style={{ background:'#f9fafb' }}>
                  {['Date','Cost Type','Customer','Project #','PO #','Site','Amount'].map(h => (
                    <th key={h} style={{ padding:'10px 14px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4', whiteSpace:'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {costLines.map((cl, i) => (
                  <tr key={cl.id} style={{ borderBottom:'1px solid #f9fafb', background:i%2===0?'#fff':'#fafafa' }}>
                    <td style={{ padding:'10px 14px', color:'#9ca3af' }}>{cl.cost_date?.slice(0,10)||'—'}</td>
                    <td style={{ padding:'10px 14px', fontWeight:600, color:'#1f2937' }}>{cl.cost_type}</td>
                    <td style={{ padding:'10px 14px', color:'#6b7280' }}>{cl.customer_name||'—'}</td>
                    <td style={{ padding:'10px 14px', color:'#6b7280' }}>{cl.project_number||'—'}</td>
                    <td style={{ padding:'10px 14px', color:'#9ca3af', fontSize:12 }}>{cl.po_number||'—'}</td>
                    <td style={{ padding:'10px 14px', color:'#9ca3af', fontSize:12 }}>{cl.site_name||'—'}</td>
                    <td style={{ padding:'10px 14px', fontWeight:600, color:'#374151' }}>{fmtL(cl.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Project detail modal */}
      {selected && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}
             onClick={e => { if (e.target === e.currentTarget) { setSelected(null); setDetail(null); }}}>
          <div style={{ background:'#fff', borderRadius:16, padding:32, width:680, maxHeight:'92vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <h2 style={{ fontSize:18, fontWeight:700, color:'#1f2937', margin:0 }}>{selected.project_name}</h2>
              <button onClick={() => { setSelected(null); setDetail(null); }} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
            </div>
            {detailLoading ? (
              <div style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>Loading...</div>
            ) : detail ? (
              <>
                {/* Revenue vs Profit bar */}
                <div style={{ background:'#f9fafb', borderRadius:10, padding:16, marginBottom:20 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
                    <span style={{ fontSize:13, color:'#374151', fontWeight:600 }}>Revenue</span>
                    <span style={{ fontSize:13, fontWeight:700, color:'#10b981' }}>{fmtL(detail.revenue)}</span>
                  </div>
                  <div style={{ height:8, background:'#e5e7eb', borderRadius:4, overflow:'hidden', marginBottom:14 }}>
                    <div style={{ height:'100%', width:`${detail.revenue>0?Math.min((detail.actual_profit/detail.revenue)*100+50, 100):50}%`, background:'#10b981', borderRadius:4 }}/>
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12 }}>
                    <div style={{ textAlign:'center' }}>
                      <div style={{ fontSize:11, color:'#9ca3af', marginBottom:4 }}>TOTAL COST</div>
                      <div style={{ fontSize:18, fontWeight:700, color:'#ef4444' }}>{fmtL(detail.total_cost)}</div>
                    </div>
                    <div style={{ textAlign:'center' }}>
                      <div style={{ fontSize:11, color:'#9ca3af', marginBottom:4 }}>ACTUAL PROFIT</div>
                      <div style={{ fontSize:18, fontWeight:700, color: detail.actual_profit>=0?'#10b981':'#ef4444' }}>{fmtL(detail.actual_profit)}</div>
                    </div>
                    <div style={{ textAlign:'center' }}>
                      <div style={{ fontSize:11, color:'#9ca3af', marginBottom:4 }}>GROSS MARGIN</div>
                      <div style={{ fontSize:18, fontWeight:700, color:pctColor(detail.gross_margin_pct) }}>{Number(detail.gross_margin_pct).toFixed(1)}%</div>
                    </div>
                  </div>
                </div>

                {/* Cost breakdown */}
                <div style={{ fontSize:13, fontWeight:700, color:'#374151', marginBottom:12 }}>Cost Breakdown</div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                  {Object.entries(detail.cost_breakdown).filter(([,v]) => v > 0).map(([key, val]) => (
                    <div key={key} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 12px', background:'#f9fafb', borderRadius:8 }}>
                      <span style={{ fontSize:12, color:'#6b7280', textTransform:'capitalize' }}>{key.replace(/_/g,' ')}</span>
                      <span style={{ fontWeight:600, color:'#374151', fontSize:13 }}>{fmtL(val)}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>Unable to load project details.</div>
            )}
          </div>
        </div>
      )}

      {/* Add Cost Line Modal */}
      {showCostForm && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:'#fff', borderRadius:16, padding:32, width:580, maxHeight:'90vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
              <h2 style={{ fontSize:18, fontWeight:700, color:'#1f2937', margin:0 }}>Add Cost Line</h2>
              <button onClick={() => { setShowCostForm(false); setCostForm(EMPTY_COST); }} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
              <div>
                <label style={labelStyle}>Cost Type *</label>
                <select value={costForm.cost_type} onChange={e => setCostForm(p => ({...p, cost_type:e.target.value}))} style={inputStyle}>
                  {COST_TYPES.map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Cost Date</label>
                <input type="date" value={costForm.cost_date} onChange={e => setCostForm(p => ({...p, cost_date:e.target.value}))} style={inputStyle}/>
              </div>
              <div>
                <label style={labelStyle}>Amount (₹) *</label>
                <input type="number" value={costForm.amount} onChange={e => setCostForm(p => ({...p, amount:e.target.value}))} placeholder="0" style={inputStyle}/>
              </div>
              <div>
                <label style={labelStyle}>Project Number</label>
                <input value={costForm.project_number} onChange={e => setCostForm(p => ({...p, project_number:e.target.value}))} placeholder="PRJ-2026-0001" style={inputStyle}/>
              </div>
              <div>
                <label style={labelStyle}>Customer</label>
                <input value={costForm.customer_name} onChange={e => setCostForm(p => ({...p, customer_name:e.target.value}))} placeholder="Customer name" style={inputStyle}/>
              </div>
              <div>
                <label style={labelStyle}>PO Number</label>
                <input value={costForm.po_number} onChange={e => setCostForm(p => ({...p, po_number:e.target.value}))} placeholder="PO number" style={inputStyle}/>
              </div>
              <div>
                <label style={labelStyle}>Site Name</label>
                <input value={costForm.site_name} onChange={e => setCostForm(p => ({...p, site_name:e.target.value}))} placeholder="Site" style={inputStyle}/>
              </div>
              <div style={{ gridColumn:'1/-1' }}>
                <label style={labelStyle}>Description</label>
                <input value={costForm.description} onChange={e => setCostForm(p => ({...p, description:e.target.value}))} placeholder="Brief description" style={inputStyle}/>
              </div>
            </div>
            <div style={{ display:'flex', gap:12, justifyContent:'flex-end', marginTop:20 }}>
              <button onClick={() => { setShowCostForm(false); setCostForm(EMPTY_COST); }}
                style={{ padding:'9px 20px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13, color:'#374151' }}>Cancel</button>
              <button onClick={handleSaveCost} disabled={saving}
                style={{ padding:'9px 20px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600, opacity:saving?0.6:1 }}>
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
