import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Plus, X, Search, Star, TrendingUp, AlertTriangle } from 'lucide-react';

const RISK_COLORS = { Low:'#10b981', Medium:'#f59e0b', High:'#ef4444' };
const SCORE_DIMS = [
  { key:'quality_score',        label:'Quality' },
  { key:'delivery_score',       label:'Delivery' },
  { key:'cost_score',           label:'Cost' },
  { key:'support_score',        label:'Support' },
  { key:'compliance_score',     label:'Compliance' },
  { key:'documentation_score',  label:'Documentation' },
];

const EMPTY_SCORE = { vendor_id:'', period_year: new Date().getFullYear(), period_quarter:1, quality_score:0, delivery_score:0, cost_score:0, support_score:0, compliance_score:0, documentation_score:0, remarks:'' };

const fmtScore = v => Number(v || 0).toFixed(1);
const pctBar = (v) => (
  <div style={{ height:6, background:'#f0f0f4', borderRadius:3, marginTop:4, overflow:'hidden' }}>
    <div style={{ height:'100%', width:`${Math.min(Number(v),100)}%`, background: Number(v)>=80 ? '#10b981' : Number(v)>=60 ? '#f59e0b' : '#ef4444', borderRadius:3 }}/>
  </div>
);

export default function VendorScorecard() {
  const toast = useToast();
  const [scorecards, setScorecards] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [top, setTop] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_SCORE);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [riskFilter, setRiskFilter] = useState('All');
  const [yrFilter, setYrFilter] = useState(String(new Date().getFullYear()));

  const load = () => {
    setLoading(true);
    Promise.allSettled([
      api.get('/vendor-portal/scorecards', { params: { year: yrFilter } }),
      api.get('/procurement/vendors', { params: { limit: 200 } }),
      api.get('/vendor-portal/scorecards/top'),
    ]).then(([scRes, vRes, topRes]) => {
      setScorecards(scRes.status==='fulfilled' ? (scRes.value?.data||[]) : []);
      setVendors(vRes.status==='fulfilled' ? (vRes.value?.data?.vendors||[]) : []);
      setTop(topRes.status==='fulfilled' ? (topRes.value?.data||[]) : []);
    }).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [yrFilter]);

  const fld = (key, val) => setForm(p => ({ ...p, [key]: val }));

  const computedOverall = () => {
    const vals = SCORE_DIMS.map(d => Number(form[d.key]||0));
    return (vals.reduce((s,v) => s+v, 0) / vals.length).toFixed(1);
  };

  const handleSave = async () => {
    if (!form.vendor_id) { toast.error('Select a vendor'); return; }
    setSaving(true);
    try {
      await api.post('/vendor-portal/scorecards', { ...form,
        ...Object.fromEntries(SCORE_DIMS.map(d => [d.key, Number(form[d.key]||0)])),
      });
      setShowForm(false); setForm(EMPTY_SCORE); load();
      toast.success('Scorecard saved');
    } catch (err) { toast.error(err.response?.data?.error || 'Save failed'); }
    finally { setSaving(false); }
  };

  const filtered = scorecards.filter(sc => {
    const matchRisk = riskFilter === 'All' || sc.risk_rating === riskFilter;
    const matchSearch = !search || (sc.vendor_name||'').toLowerCase().includes(search.toLowerCase());
    return matchRisk && matchSearch;
  });

  const inputStyle = { width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' };
  const labelStyle = { display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:5 };

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Vendor Scorecards</h1>
          <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>Quarterly evaluation — Quality, Delivery, Cost, Support, Compliance, Documentation</p>
        </div>
        <button onClick={() => setShowForm(true)}
          style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
          <Plus size={15}/> Add Scorecard
        </button>
      </div>

      {/* Top vendors */}
      {top.length > 0 && (
        <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:20, marginBottom:20 }}>
          <div style={{ fontSize:13, fontWeight:700, color:'#374151', marginBottom:14 }}>Top Vendors by Score</div>
          <div style={{ display:'flex', gap:12, overflow:'auto', paddingBottom:4 }}>
            {top.slice(0,6).map((v, i) => (
              <div key={i} style={{ flex:'0 0 160px', background:'#f9fafb', borderRadius:10, padding:'14px 16px', border:'1px solid #f0f0f4' }}>
                <div style={{ fontSize:11, color:'#9ca3af', marginBottom:6, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{v.vendor_name}</div>
                <div style={{ fontSize:22, fontWeight:700, color: Number(v.avg_score)>=80 ? '#10b981' : Number(v.avg_score)>=60 ? '#f59e0b' : '#ef4444' }}>
                  {fmtScore(v.avg_score)}
                </div>
                <div style={{ fontSize:11, color:'#9ca3af' }}>/ 100</div>
                <span style={{ display:'inline-block', marginTop:6, padding:'2px 8px', borderRadius:12, fontSize:10, fontWeight:600, background:RISK_COLORS[v.risk_rating]+'18', color:RISK_COLORS[v.risk_rating] }}>{v.risk_rating} Risk</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div style={{ display:'flex', gap:12, marginBottom:20, flexWrap:'wrap' }}>
        <div style={{ position:'relative', flex:1, minWidth:200 }}>
          <Search size={14} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }}/>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search vendor..."
            style={{ width:'100%', paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8, border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
        </div>
        <select value={yrFilter} onChange={e => setYrFilter(e.target.value)}
          style={{ padding:'7px 14px', borderRadius:8, border:'1px solid #e5e7eb', fontSize:13, outline:'none' }}>
          {[2026,2025,2024,2023].map(y => <option key={y}>{y}</option>)}
        </select>
        {['All','Low','Medium','High'].map(r => (
          <button key={r} onClick={() => setRiskFilter(r)}
            style={{ padding:'7px 14px', borderRadius:8, border:'1px solid', fontSize:12, fontWeight:500, cursor:'pointer',
              borderColor: riskFilter===r ? (RISK_COLORS[r]||'#6B3FDB') : '#e5e7eb',
              background:  riskFilter===r ? (RISK_COLORS[r]||'#6B3FDB') : '#fff',
              color:       riskFilter===r ? '#fff' : '#374151' }}>
            {r === 'All' ? 'All Risk' : `${r} Risk`}
          </button>
        ))}
      </div>

      {/* Scorecard Table */}
      <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden' }}>
        {loading ? (
          <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>No scorecards found for this period.</div>
        ) : (
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ background:'#f9fafb' }}>
                {['Vendor','Period','Quality','Delivery','Cost','Support','Compliance','Docs','Overall','Risk'].map(h => (
                  <th key={h} style={{ padding:'10px 14px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4', whiteSpace:'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((sc, i) => {
                const rc = RISK_COLORS[sc.risk_rating] || '#9ca3af';
                const ov = Number(sc.overall_score||0);
                return (
                  <tr key={sc.id} style={{ borderBottom:'1px solid #f9fafb', background:i%2===0?'#fff':'#fafafa' }}>
                    <td style={{ padding:'10px 14px', fontWeight:600, color:'#1f2937' }}>
                      {sc.vendor_name}
                      {sc.category && <div style={{ fontSize:11, color:'#9ca3af', marginTop:2 }}>{sc.category}</div>}
                    </td>
                    <td style={{ padding:'10px 14px', color:'#6b7280' }}>Q{sc.period_quarter} {sc.period_year}</td>
                    {SCORE_DIMS.map(d => (
                      <td key={d.key} style={{ padding:'10px 14px', color:'#374151', width:70 }}>
                        <div style={{ fontWeight:500 }}>{fmtScore(sc[d.key])}</div>
                        {pctBar(sc[d.key])}
                      </td>
                    ))}
                    <td style={{ padding:'10px 14px', fontWeight:700, color: ov>=80 ? '#10b981' : ov>=60 ? '#f59e0b' : '#ef4444' }}>
                      {fmtScore(ov)}
                    </td>
                    <td style={{ padding:'10px 14px' }}>
                      <span style={{ background:rc+'18', color:rc, padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:600 }}>{sc.risk_rating}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Add Scorecard Modal */}
      {showForm && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:'#fff', borderRadius:16, padding:32, width:600, maxHeight:'92vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
              <h2 style={{ fontSize:18, fontWeight:700, color:'#1f2937', margin:0 }}>New Vendor Scorecard</h2>
              <button onClick={() => { setShowForm(false); setForm(EMPTY_SCORE); }} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
            </div>

            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:14, marginBottom:20 }}>
              <div style={{ gridColumn:'1/-1' }}>
                <label style={labelStyle}>Vendor *</label>
                <select value={form.vendor_id} onChange={e => fld('vendor_id', e.target.value)} style={inputStyle}>
                  <option value="">Select vendor...</option>
                  {vendors.map(v => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Year</label>
                <select value={form.period_year} onChange={e => fld('period_year', Number(e.target.value))} style={inputStyle}>
                  {[2026,2025,2024,2023].map(y => <option key={y}>{y}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Quarter</label>
                <select value={form.period_quarter} onChange={e => fld('period_quarter', Number(e.target.value))} style={inputStyle}>
                  {[1,2,3,4].map(q => <option key={q} value={q}>Q{q}</option>)}
                </select>
              </div>
            </div>

            <div style={{ fontSize:12, fontWeight:700, color:'#6B3FDB', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:14 }}>Evaluation Scores (0–100)</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:20 }}>
              {SCORE_DIMS.map(d => (
                <div key={d.key}>
                  <label style={labelStyle}>{d.label}</label>
                  <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                    <input type="range" min={0} max={100} value={form[d.key]}
                      onChange={e => fld(d.key, Number(e.target.value))}
                      style={{ flex:1, accentColor:'#6B3FDB' }}/>
                    <span style={{ width:36, textAlign:'right', fontWeight:700, color: Number(form[d.key])>=80?'#10b981':Number(form[d.key])>=60?'#f59e0b':'#ef4444' }}>
                      {form[d.key]}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Overall preview */}
            <div style={{ background:'#f5f3ff', borderRadius:10, padding:'14px 16px', marginBottom:20, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <span style={{ fontSize:13, color:'#6b7280' }}>Overall Score</span>
              <span style={{ fontSize:24, fontWeight:700, color:'#6B3FDB' }}>{computedOverall()}</span>
            </div>

            <div>
              <label style={labelStyle}>Remarks</label>
              <textarea value={form.remarks} onChange={e => fld('remarks', e.target.value)} rows={3}
                placeholder="Performance summary and observations..."
                style={{ ...inputStyle, resize:'vertical' }}/>
            </div>

            <div style={{ display:'flex', gap:12, justifyContent:'flex-end', marginTop:20 }}>
              <button onClick={() => { setShowForm(false); setForm(EMPTY_SCORE); }}
                style={{ padding:'9px 20px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13, color:'#374151' }}>Cancel</button>
              <button onClick={handleSave} disabled={saving}
                style={{ padding:'9px 20px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600, opacity:saving?0.6:1 }}>
                {saving ? 'Saving...' : 'Save Scorecard'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
