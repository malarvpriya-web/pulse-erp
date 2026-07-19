// frontend/src/features/finance/pages/FixedAssets.jsx
import { useState, useEffect, useCallback } from 'react';
import {
  PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, LineChart, Line, CartesianGrid,
} from 'recharts';
import api from '@/services/api/client';
import { useFY } from '@/context/FYContext';
import { usePageAccess } from '@/hooks/usePageAccess';
import ReadOnlyBanner from '@/components/ReadOnlyBanner';

/* ─── helpers ─────────────────────────────────────────────── */
function formatINR(n) {
  if (n === null || n === undefined || isNaN(n)) return '₹0';
  const num = parseFloat(n);
  if (num >= 10000000) return `₹${(num / 10000000).toFixed(2)} Cr`;
  if (num >= 100000)   return `₹${(num / 100000).toFixed(2)} L`;
  return `₹${Math.round(num).toLocaleString('en-IN')}`;
}

function buildScheduleJS(asset) {
  const cost    = parseFloat(asset.purchase_cost)    || 0;
  const salvage = parseFloat(asset.salvage_value)    || 0;
  const life    = parseInt(asset.useful_life_years)  || 5;
  const rate    = parseFloat(asset.depreciation_rate)|| 0.2;
  const method  = asset.depreciation_method || 'SLM';
  let bv = cost;
  let accumulated = 0;
  const rows = [];
  for (let yr = 1; yr <= life; yr++) {
    const dep = method === 'WDV' ? bv * rate : (cost - salvage) / life;
    const actualDep = Math.min(dep, Math.max(0, bv - salvage));
    accumulated += actualDep;
    rows.push({
      year: `Yr ${yr}`,
      opening:       Math.round(bv),
      depreciation:  Math.round(actualDep),
      closing:       Math.round(bv - actualDep),
      accumulated:   Math.round(accumulated),
    });
    bv -= actualDep;
    if (bv <= salvage + 1) break;
  }
  return rows;
}

/* ─── constants ────────────────────────────────────────────── */

const EMPTY_FORM = {
  asset_code:'', name:'', category:'IT Equipment', location:'', department:'',
  purchase_date:'', purchase_cost:'', salvage_value:'0', depreciation_method:'SLM',
  depreciation_rate:'0.20', useful_life_years:'5', vendor:'', invoice_number:'',
  warranty_expiry:'', insurance_expiry:'', serial_number:'', barcode:'', notes:'',
};

const CATEGORIES = ['IT Equipment','Furniture','Vehicles','Electrical','Machinery','Office Equipment','Security','Land & Building','Other'];
const STATUS_COLORS = { active:'#16a34a', disposed:'#dc2626', 'under-maintenance':'#d97706' };
const PIE_COLORS = ['#6B3FDB','#2563eb','#d97706','#16a34a','#dc2626','#0891b2','#db2777','#6d28d9','#374151'];

/* ─── chart helpers ────────────────────────────────────────── */
function buildCategoryPie(assets) {
  const map = {};
  assets.forEach(a => { map[a.category] = (map[a.category] || 0) + parseFloat(a.purchase_cost || 0); });
  return Object.entries(map).map(([name, value]) => ({ name, value: Math.round(value / 100000) }));
}

function buildDeptBar(assets) {
  const map = {};
  assets.forEach(a => {
    const dept = a.department || 'Unassigned';
    map[dept] = (map[dept] || 0) + parseFloat(a.current_book_value || 0);
  });
  return Object.entries(map).map(([dept, value]) => ({ dept, value: Math.round(value / 1000) }));
}

function warrantyExpiringSoon(assets) {
  const now = new Date();
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() + 90);
  return assets
    .filter(a => a.warranty_expiry
      && new Date(a.warranty_expiry) >= now
      && new Date(a.warranty_expiry) <= cutoff
      && a.status !== 'disposed')
    .sort((a, b) => new Date(a.warranty_expiry) - new Date(b.warranty_expiry));
}

function warrantyExpired(assets) {
  const now = new Date();
  return assets
    .filter(a => a.warranty_expiry && new Date(a.warranty_expiry) < now && a.status !== 'disposed')
    .sort((a, b) => new Date(b.warranty_expiry) - new Date(a.warranty_expiry));
}

function fullyDepreciated(assets) {
  return assets.filter(a => parseFloat(a.current_book_value || 0) <= parseFloat(a.salvage_value || 0) + 1000 && a.status !== 'disposed');
}

/* ─── component ────────────────────────────────────────────── */
export default function FixedAssets() {
  const { readOnly } = usePageAccess();
  const [tab, setTab]                   = useState('dashboard');
  const [assets, setAssets]             = useState([]);
  const [kpis, setKpis]                 = useState(null);
  const [loading, setLoading]           = useState(false);
  const [msg, setMsg]                   = useState({ text:'', type:'' });
  const [form, setForm]                 = useState(EMPTY_FORM);
  const [editId, setEditId]             = useState(null);
  const [showFormModal, setShowFormModal] = useState(false);
  const [scheduleAsset, setScheduleAsset] = useState(null);
  const [schedule, setSchedule]         = useState([]);
  const [schedLoading, setSchedLoading] = useState(false);
  const [runningDep, setRunningDep]     = useState(false);
  const [disposeAsset, setDisposeAsset] = useState(null);
  const [disposeForm, setDisposeForm]   = useState({ disposal_date:'', disposal_value:'', notes:'' });
  const [disposeResult, setDisposeResult] = useState(null);
  const [searchText, setSearchText]     = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterCat, setFilterCat]       = useState('');
  const [filterFY, setFilterFY]         = useState('all');
  const { availableFYs } = useFY();
  const [deptList, setDeptList]         = useState([]);

  const flash = (text, type = 'success') => {
    setMsg({ text, type });
    setTimeout(() => setMsg({ text:'', type:'' }), 3500);
  };

  const closeModal = () => { setShowFormModal(false); setForm(EMPTY_FORM); setEditId(null); };

  const loadAll = useCallback(async () => {
    const [assetsRes, kpisRes] = await Promise.allSettled([
      api.get('/fixed-assets'),
      api.get('/fixed-assets/kpis'),
    ]);
    setAssets(assetsRes.status === 'fulfilled' && Array.isArray(assetsRes.value.data)
      ? assetsRes.value.data : []);
    setKpis(kpisRes.status === 'fulfilled'
      ? (kpisRes.value.data?.data || kpisRes.value.data || null) : null);
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);
  useEffect(() => {
    api.get('/admin/config/departments')
      .then(r => setDeptList(Array.isArray(r.data) ? r.data.map(d => d.name || d) : []))
      .catch(() => setDeptList([]));
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const payload = { ...form, wdv_rate: Math.round(parseFloat(form.depreciation_rate || '0.20') * 100) };
      if (editId) { await api.put(`/fixed-assets/${editId}`, payload); flash('Asset updated'); }
      else        { await api.post('/fixed-assets', payload);          flash('Asset added'); }
      setForm(EMPTY_FORM); setEditId(null); setShowFormModal(false); loadAll();
    } catch (err) { flash(err.response?.data?.message || 'Save failed', 'error'); }
    finally { setLoading(false); }
  };

  const openSchedule = async (asset) => {
    setScheduleAsset(asset);
    setTab('schedule');
    try {
      const res = await api.get(`/fixed-assets/${asset.id}/depreciation`);
      const rows = res.data?.data?.schedule || buildScheduleJS(asset);
      setSchedule(rows.map((r, i) => ({ ...r, year: r.year ?? `Yr ${i + 1}` })));
    } catch { setSchedule(buildScheduleJS(asset)); }
    finally   { setSchedLoading(false); }
  };

  const runDepreciation = async () => {
    setRunningDep(true);
    try {
      await api.post('/fixed-assets/run-depreciation');
      flash('Depreciation run completed for current FY');
      loadAll();
    } catch (err) {
      flash(err.response?.data?.message || 'Depreciation run failed — please check logs', 'error');
    } finally { setRunningDep(false); }
  };

  const handleDispose = async (e) => {
    e.preventDefault();
    if (!disposeAsset) return;
    try {
      const res = await api.post(`/fixed-assets/${disposeAsset.id}/dispose`, disposeForm);
      const gain = res.data?.gain_loss ?? (parseFloat(disposeForm.disposal_value) - parseFloat(disposeAsset.current_book_value));
      setDisposeResult({ gain, msg: gain >= 0 ? `Gain on disposal: ${formatINR(gain)}` : `Loss on disposal: ${formatINR(Math.abs(gain))}` });
      loadAll();
    } catch (err) {
      flash(err.response?.data?.message || 'Dispose failed', 'error');
    } finally { setLoading(false); }
  };

  const startEdit = (a) => {
    setForm({
      asset_code: a.asset_code, name: a.name, category: a.category, location: a.location,
      department: a.department || '', purchase_date: a.purchase_date?.split('T')[0] || '',
      purchase_cost: a.purchase_cost, salvage_value: a.salvage_value,
      depreciation_method: a.depreciation_method,
      depreciation_rate: a.wdv_rate ? (parseFloat(a.wdv_rate) / 100).toFixed(4) : '0.20',
      useful_life_years: a.useful_life_years, vendor: a.vendor || '',
      invoice_number: a.invoice_number || '', warranty_expiry: a.warranty_expiry?.split('T')[0] || '',
      insurance_expiry: a.insurance_expiry?.split('T')[0] || '',
      serial_number: a.serial_number || '', barcode: a.barcode || '', notes: a.notes || '',
    });
    setEditId(a.id);
    setShowFormModal(true);
  };

  const fyRange = availableFYs.find(f => f.fy === filterFY) || null;
  const filtered = assets.filter(a => {
    const q = searchText.toLowerCase();
    const matchQ = !q || a.name?.toLowerCase().includes(q) || a.asset_code?.toLowerCase().includes(q) || a.department?.toLowerCase().includes(q);
    const matchS = !filterStatus || a.status === filterStatus;
    const matchC = !filterCat   || a.category === filterCat;
    let matchFY = true;
    if (fyRange) {
      const d = (a.purchase_date || '').slice(0, 10);
      matchFY = d && d >= fyRange.startStr && d <= fyRange.endStr;
    }
    return matchQ && matchS && matchC && matchFY;
  });

  const catPieData      = buildCategoryPie(assets);
  const deptBarData     = buildDeptBar(assets);
  const expiringWarranties = warrantyExpiringSoon(assets);
  const expiredWarranties  = warrantyExpired(assets);
  const fullyDep           = fullyDepreciated(assets);

  /* ─── UI ─────────────────────────────────────────────────── */
  const tabStyle = (t) => ({
    padding: '8px 18px', border: 'none', cursor: 'pointer', borderRadius: '6px 6px 0 0',
    fontWeight: 600, fontSize: 14,
    background: tab === t ? '#6B3FDB' : '#e9e4ff',
    color: tab === t ? '#fff' : '#6B3FDB',
  });

  const formFields = (
    <form onSubmit={handleSubmit}>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))', gap:14 }}>
        {[
          ['asset_code','Asset Code','text',true],
          ['name','Asset Name','text',true],
          ['vendor','Vendor','text'],
          ['invoice_number','Invoice Number','text'],
          ['serial_number','Serial / Model Number','text'],
          ['barcode','Barcode','text'],
          ['purchase_date','Purchase Date','date',true],
          ['purchase_cost','Purchase Cost (₹)','number',true],
          ['salvage_value','Salvage Value (₹)','number'],
          ['warranty_expiry','Warranty Expiry','date'],
          ['insurance_expiry','Insurance Expiry','date'],
        ].map(([key, label, type, req]) => (
          <div key={key}>
            <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#4c1d95', marginBottom:4 }}>{label}{req && ' *'}</label>
            <input type={type} value={form[key]} required={!!req}
              onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
              style={{ width:'100%', boxSizing:'border-box', padding:'8px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }} />
          </div>
        ))}

        <div>
          <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#4c1d95', marginBottom:4 }}>Category *</label>
          <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} required
            style={{ width:'100%', padding:'8px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13, background:'#fff' }}>
            {CATEGORIES.map(c => <option key={c}>{c}</option>)}
          </select>
        </div>

        <div>
          <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#4c1d95', marginBottom:4 }}>Depreciation Method *</label>
          <select value={form.depreciation_method}
            onChange={e => setForm(f => ({ ...f, depreciation_method: e.target.value }))}
            style={{ width:'100%', padding:'8px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13, background:'#fff' }}>
            <option value='SLM'>SLM — Straight Line Method</option>
            <option value='WDV'>WDV — Written Down Value</option>
          </select>
        </div>

        {form.depreciation_method === 'SLM' && (
          <div>
            <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#4c1d95', marginBottom:4 }}>Useful Life (Years) *</label>
            <input type='number' min={1} max={50} value={form.useful_life_years} required
              onChange={e => setForm(f => ({ ...f, useful_life_years: e.target.value }))}
              style={{ width:'100%', boxSizing:'border-box', padding:'8px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }} />
          </div>
        )}

        {form.depreciation_method === 'WDV' && (
          <div>
            <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#4c1d95', marginBottom:4 }}>Depreciation Rate (%) *</label>
            <input type='number' min={1} max={100} step={0.5}
              value={Math.round((parseFloat(form.depreciation_rate) || 0.2) * 100)}
              required
              onChange={e => setForm(f => ({ ...f, depreciation_rate: (parseFloat(e.target.value) / 100).toFixed(4) }))}
              style={{ width:'100%', boxSizing:'border-box', padding:'8px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }} />
          </div>
        )}

        <div>
          <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#4c1d95', marginBottom:4 }}>Location</label>
          <input value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))}
            style={{ width:'100%', boxSizing:'border-box', padding:'8px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }} />
        </div>

        <div>
          <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#4c1d95', marginBottom:4 }}>Department Assigned *</label>
          <select required value={form.department} onChange={e => setForm(f => ({ ...f, department: e.target.value }))}
            style={{ width:'100%', boxSizing:'border-box', padding:'8px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13, background:'#fff' }}>
            <option value="">-- Select Department --</option>
            {deptList.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>

        <div style={{ gridColumn:'1/-1' }}>
          <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#4c1d95', marginBottom:4 }}>Notes</label>
          <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2}
            style={{ width:'100%', boxSizing:'border-box', padding:'8px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }} />
        </div>
      </div>

      {/* depreciation preview */}
      {form.purchase_cost && (
        <div style={{ marginTop:16, padding:'12px 16px', background:'#f5f3ff', borderRadius:8, border:'1px solid #e9e4ff' }}>
          <strong style={{ color:'#4c1d95', fontSize:13 }}>Depreciation Preview</strong>
          {(() => {
            const cost    = parseFloat(form.purchase_cost)    || 0;
            const salvage = parseFloat(form.salvage_value)    || 0;
            const life    = parseInt(form.useful_life_years)  || 5;
            const rate    = parseFloat(form.depreciation_rate)|| 0.2;
            const method  = form.depreciation_method;
            const annualDep = method === 'WDV' ? cost * rate : (cost - salvage) / life;
            return (
              <div style={{ fontSize:13, color:'#6b7280', marginTop:6 }}>
                Annual Depreciation ({method}): <strong style={{ color:'#6B3FDB' }}>{formatINR(annualDep)}</strong>
                {method === 'SLM' && <span style={{ marginLeft:10 }}>= ({formatINR(cost)} − {formatINR(salvage)}) ÷ {life} yrs</span>}
                {method === 'WDV' && <span style={{ marginLeft:10 }}>= {formatINR(cost)} × {(rate * 100).toFixed(0)}% (Year 1)</span>}
              </div>
            );
          })()}
        </div>
      )}

      <div style={{ display:'flex', gap:10, marginTop:20 }}>
        <button type='submit' disabled={loading}
          style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'9px 24px', cursor:'pointer', fontWeight:600 }}>
          {loading ? 'Saving…' : editId ? 'Update Asset' : 'Add Asset'}
        </button>
        <button type='button' onClick={closeModal}
          style={{ background:'#e9e4ff', color:'#6B3FDB', border:'none', borderRadius:8, padding:'9px 20px', cursor:'pointer', fontWeight:600 }}>
          Cancel
        </button>
      </div>
    </form>
  );

  return (
    <div style={{ padding: 24, background: '#f5f3ff', minHeight: '100vh' }}>
      {readOnly && <ReadOnlyBanner />}
      {/* header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin:0, color:'#4c1d95', fontSize:22 }}>🏭 Fixed Assets Register</h2>
          <p style={{ margin:0, color:'#6b7280', fontSize:13 }}>Manage assets, depreciation schedules, and disposals</p>
        </div>
        {!readOnly && (
          <button onClick={() => { setForm(EMPTY_FORM); setEditId(null); setShowFormModal(true); }}
            style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'9px 20px', cursor:'pointer', fontWeight:600 }}>
            + Add Asset
          </button>
        )}
      </div>

      {/* flash message */}
      {msg.text && (
        <div style={{ marginBottom:12, padding:'10px 16px', borderRadius:8, fontWeight:500, fontSize:14,
          background: msg.type === 'error' ? '#fef2f2' : '#f0fdf4',
          color:      msg.type === 'error' ? '#dc2626'  : '#16a34a',
          border:`1px solid ${msg.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>
          {msg.text}
        </div>
      )}

      {/* tabs */}
      <div style={{ display:'flex', gap:4, borderBottom:'2px solid #e9e4ff', flexWrap:'wrap' }}>
        {[
          ['dashboard','Dashboard'],
          ['register','Asset Register'],
          ['schedule','Depreciation'],
          ['dispose','Disposal'],
        ].map(([k,l]) => (
          <button key={k} style={tabStyle(k)} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>

      <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderTop:'none', borderRadius:'0 8px 8px 8px', padding:20 }}>

        {/* ── DASHBOARD ── */}
        {tab === 'dashboard' && (
          <div>
            {/* KPI cards */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))', gap:14, marginBottom:24 }}>
              {[
                { label:'Total Asset Value',        value: formatINR(kpis?.total_cost),            icon:'🏭', color:'#6B3FDB' },
                { label:'Accumulated Depreciation', value: formatINR(kpis?.total_accumulated_dep), icon:'📉', color:'#d97706' },
                { label:'Net Book Value',            value: formatINR(kpis?.net_book_value),        icon:'📊', color:'#16a34a' },
                { label:'Active Assets',             value: kpis?.total_assets ?? 0,               icon:'✅', color:'#0891b2' },
              ].map(({ label, value, icon, color }) => (
                <div key={label} style={{ background:'#f5f3ff', borderRadius:10, padding:'16px 18px', border:'1px solid #e9e4ff' }}>
                  <div style={{ fontSize:24, marginBottom:6 }}>{icon}</div>
                  <div style={{ fontSize:22, fontWeight:700, color }}>{value}</div>
                  <div style={{ fontSize:12, color:'#6b7280', marginTop:4 }}>{label}</div>
                </div>
              ))}
            </div>

            {/* charts row */}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:18, marginBottom:24 }}>
              {/* pie by category */}
              <div style={{ background:'#f5f3ff', borderRadius:10, padding:16, border:'1px solid #e9e4ff' }}>
                <h4 style={{ margin:'0 0 12px', color:'#4c1d95', fontSize:14 }}>Asset Value by Category (₹ Lakhs)</h4>
                <div style={{ height:220 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={catPieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={({ name, percent }) => `${name} ${(percent*100).toFixed(0)}%`} labelLine={false}>
                        {catPieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                      </Pie>
                      <Tooltip formatter={(v) => [`₹${v}L`, 'Value']} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* bar by department */}
              <div style={{ background:'#f5f3ff', borderRadius:10, padding:16, border:'1px solid #e9e4ff' }}>
                <h4 style={{ margin:'0 0 12px', color:'#4c1d95', fontSize:14 }}>Net Book Value by Department (₹ Thousands)</h4>
                <div style={{ height:220 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={deptBarData} margin={{ top:4, right:12, left:0, bottom:4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e9e4ff" />
                      <XAxis dataKey="dept" tick={{ fontSize:11 }} />
                      <YAxis tick={{ fontSize:11 }} />
                      <Tooltip formatter={(v) => [`₹${v}K`, 'Net Book Value']} />
                      <Bar dataKey="value" fill="#6B3FDB" radius={[4,4,0,0]} name="Net Book Value" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* fully depreciated assets */}
            {fullyDep.length > 0 && (
              <div style={{ marginBottom:20 }}>
                <h4 style={{ color:'#dc2626', marginBottom:10, fontSize:14 }}>⚠️ Fully Depreciated Assets ({fullyDep.length})</h4>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <thead>
                    <tr style={{ background:'#fee2e2' }}>
                      {['Code','Name','Category','Purchase Cost','Book Value','Dept'].map(h => (
                        <th key={h} style={{ padding:'7px 10px', textAlign:'left', borderBottom:'1px solid #fecaca', color:'#dc2626', fontWeight:600 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {fullyDep.map(a => (
                      <tr key={a.id} style={{ borderBottom:'1px solid #fef2f2' }}>
                        <td style={{ padding:'7px 10px', color:'#dc2626', fontWeight:700 }}>{a.asset_code}</td>
                        <td style={{ padding:'7px 10px' }}>{a.name}</td>
                        <td style={{ padding:'7px 10px', color:'#6b7280' }}>{a.category}</td>
                        <td style={{ padding:'7px 10px' }}>{formatINR(a.purchase_cost)}</td>
                        <td style={{ padding:'7px 10px', color:'#dc2626', fontWeight:600 }}>{formatINR(a.current_book_value)}</td>
                        <td style={{ padding:'7px 10px', color:'#6b7280' }}>{a.department || 'Unassigned'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* warranty expiry alerts */}
            <div>
              <h4 style={{ color:'#d97706', marginBottom:10, fontSize:14 }}>🛡️ Warranty Expiring (Next 90 Days)</h4>
              {expiringWarranties.length === 0 ? (
                <p style={{ color:'#16a34a', fontSize:13, margin:'0 0 8px' }}>✓ No warranties expiring in the next 90 days.</p>
              ) : (
                <div style={{ display:'flex', flexDirection:'column', gap:8, marginBottom:12 }}>
                  {expiringWarranties.map(a => {
                    const daysLeft = Math.ceil((new Date(a.warranty_expiry) - new Date()) / 86400000);
                    return (
                      <div key={a.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
                        padding:'10px 14px', borderRadius:8, border:'1px solid #fef3c7', background:'#fffbeb' }}>
                        <div>
                          <span style={{ fontWeight:600, fontSize:13 }}>{a.name}</span>
                          <span style={{ color:'#6b7280', fontSize:12, marginLeft:8 }}>{a.asset_code} · {a.department || 'Unassigned'}</span>
                        </div>
                        <span style={{ fontSize:12, fontWeight:700, color: daysLeft <= 30 ? '#dc2626' : '#d97706' }}>
                          Expires in {daysLeft}d ({a.warranty_expiry?.split('T')[0]})
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* expired warranties — collapsed, action needed */}
              {expiredWarranties.length > 0 && (
                <details style={{ marginTop:4 }}>
                  <summary style={{ cursor:'pointer', color:'#dc2626', fontWeight:600, fontSize:13, padding:'6px 0', userSelect:'none' }}>
                    ⚠️ Expired Warranties — Action Needed ({expiredWarranties.length})
                  </summary>
                  <div style={{ display:'flex', flexDirection:'column', gap:6, marginTop:8 }}>
                    {expiredWarranties.map(a => {
                      const daysAgo = Math.abs(Math.ceil((new Date(a.warranty_expiry) - new Date()) / 86400000));
                      return (
                        <div key={a.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
                          padding:'8px 14px', borderRadius:8, border:'1px solid #fecaca', background:'#fef2f2' }}>
                          <div>
                            <span style={{ fontWeight:600, fontSize:13 }}>{a.name}</span>
                            <span style={{ color:'#6b7280', fontSize:12, marginLeft:8 }}>{a.asset_code} · {a.department || 'Unassigned'}</span>
                          </div>
                          <span style={{ fontSize:12, fontWeight:700, color:'#dc2626' }}>
                            Expired {daysAgo}d ago ({a.warranty_expiry?.split('T')[0]})
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </details>
              )}
            </div>
          </div>
        )}

        {/* ── ASSET REGISTER ── */}
        {tab === 'register' && (
          <div>
            <div style={{ display:'flex', gap:10, marginBottom:16, flexWrap:'wrap' }}>
              <input value={searchText} onChange={e => setSearchText(e.target.value)}
                placeholder="Search name, code, dept…"
                style={{ flex:'1 1 200px', padding:'7px 12px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }} />
              <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
                style={{ padding:'7px 12px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13, color:'#374151' }}>
                <option value=''>All Status</option>
                <option value='active'>Active</option>
                <option value='disposed'>Disposed</option>
                <option value='under-maintenance'>Under Maintenance</option>
              </select>
              <select value={filterCat} onChange={e => setFilterCat(e.target.value)}
                style={{ padding:'7px 12px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13, color:'#374151' }}>
                <option value=''>All Categories</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <select value={filterFY} onChange={e => setFilterFY(e.target.value)}
                title="Filter by acquisition Financial Year"
                style={{ padding:'7px 12px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13, color:'#374151' }}>
                <option value='all'>All Financial Years</option>
                {availableFYs.map(f => <option key={f.fy} value={f.fy}>{f.label}</option>)}
              </select>
            </div>

            {loading ? <div style={{ textAlign:'center', padding:40, color:'#6B3FDB' }}>Loading…</div> : (
              <div style={{ overflowX:'auto' }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <thead>
                    <tr style={{ background:'#f5f3ff' }}>
                      {['Code','Name','Category','Department','Purchase Date','Cost','Book Value','Method','Life','Status','Actions'].map(h => (
                        <th key={h} style={{ padding:'8px 10px', textAlign:'left', borderBottom:'1px solid #e9e4ff', color:'#4c1d95', fontWeight:600, whiteSpace:'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(a => (
                      <tr key={a.id} style={{ borderBottom:'1px solid #f0ebff' }}>
                        <td style={{ padding:'7px 10px', color:'#6B3FDB', fontWeight:700 }}>{a.asset_code}</td>
                        <td style={{ padding:'7px 10px', fontWeight:500 }}>{a.name}</td>
                        <td style={{ padding:'7px 10px', color:'#6b7280' }}>{a.category}</td>
                        <td style={{ padding:'7px 10px', color: a.department ? '#6b7280' : '#d97706', fontStyle: a.department ? 'normal' : 'italic' }}>
                          {a.department || 'Unassigned'}
                        </td>
                        <td style={{ padding:'7px 10px', whiteSpace:'nowrap' }}>{a.purchase_date?.split('T')[0]}</td>
                        <td style={{ padding:'7px 10px', whiteSpace:'nowrap' }}>{formatINR(a.purchase_cost)}</td>
                        <td style={{ padding:'7px 10px', fontWeight:600, color:'#16a34a', whiteSpace:'nowrap' }}>{formatINR(a.current_book_value)}</td>
                        <td style={{ padding:'7px 10px' }}>
                          <span style={{ padding:'2px 8px', borderRadius:10, fontSize:11, fontWeight:600,
                            background: a.depreciation_method==='WDV' ? '#ede9fe' : '#dbeafe',
                            color:      a.depreciation_method==='WDV' ? '#6B3FDB' : '#2563eb' }}>
                            {a.depreciation_method}
                          </span>
                        </td>
                        <td style={{ padding:'7px 10px', textAlign:'center' }}>{a.useful_life_years}y</td>
                        <td style={{ padding:'7px 10px' }}>
                          <span style={{ padding:'2px 8px', borderRadius:12, fontSize:11, fontWeight:600,
                            background: a.status==='active' ? '#d1fae5' : a.status==='disposed' ? '#fee2e2' : '#fef3c7',
                            color: STATUS_COLORS[a.status] || '#6b7280' }}>
                            {a.status}
                          </span>
                        </td>
                        <td style={{ padding:'7px 10px', whiteSpace:'nowrap' }}>
                          {!readOnly && (
                            <button onClick={() => startEdit(a)}
                              style={{ background:'#ede9fe', color:'#6B3FDB', border:'none', borderRadius:6, padding:'4px 9px', cursor:'pointer', marginRight:4, fontSize:12, fontWeight:600 }}>Edit</button>
                          )}
                          <button onClick={() => openSchedule(a)}
                            style={{ background:'#dbeafe', color:'#2563eb', border:'none', borderRadius:6, padding:'4px 9px', cursor:'pointer', marginRight:4, fontSize:12, fontWeight:600 }}>Schedule</button>
                          {!readOnly && a.status !== 'disposed' && (
                            <button onClick={() => { setDisposeAsset(a); setDisposeForm({ disposal_date:'', disposal_value:'', notes:'' }); setDisposeResult(null); setTab('dispose'); }}
                              style={{ background:'#fee2e2', color:'#dc2626', border:'none', borderRadius:6, padding:'4px 9px', cursor:'pointer', fontSize:12, fontWeight:600 }}>Dispose</button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {filtered.length === 0 && (
                      <tr><td colSpan={11} style={{ textAlign:'center', padding:30, color:'#9ca3af' }}>No assets found</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── DEPRECIATION SCHEDULE ── */}
        {tab === 'schedule' && (
          <div>
            {/* top actions */}
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16, flexWrap:'wrap', gap:10 }}>
              <div style={{ display:'flex', gap:10, alignItems:'center' }}>
                <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95' }}>Select Asset:</label>
                <select
                  value={scheduleAsset?.id ?? ''}
                  onChange={e => {
                    const a = assets.find(x => x.id === parseInt(e.target.value));
                    if (a) openSchedule(a);
                  }}
                  style={{ padding:'7px 12px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13, color:'#374151', minWidth:220 }}>
                  {assets.map(a => <option key={a.id} value={a.id}>{a.asset_code} — {a.name}</option>)}
                </select>
              </div>
              {!readOnly && (
                <button onClick={runDepreciation} disabled={runningDep}
                  style={{ background:'#16a34a', color:'#fff', border:'none', borderRadius:8, padding:'9px 20px', cursor:'pointer', fontWeight:600, fontSize:13 }}>
                  {runningDep ? 'Running…' : '▶ Run Depreciation (Current FY)'}
                </button>
              )}
            </div>

            {scheduleAsset && (
              <div>
                <div style={{ marginBottom:14, padding:'10px 14px', background:'#f5f3ff', borderRadius:8, border:'1px solid #e9e4ff', fontSize:13 }}>
                  <strong style={{ color:'#4c1d95' }}>{scheduleAsset.name}</strong>
                  <span style={{ color:'#6b7280', marginLeft:10 }}>
                    {scheduleAsset.asset_code} · {scheduleAsset.depreciation_method} ·
                    Cost: {formatINR(scheduleAsset.purchase_cost)} · Salvage: {formatINR(scheduleAsset.salvage_value)} · Life: {scheduleAsset.useful_life_years} yrs
                  </span>
                </div>

                {/* book value line chart */}
                {schedule.length > 0 && (
                  <div style={{ marginBottom:20 }}>
                    <h4 style={{ color:'#4c1d95', margin:'0 0 10px', fontSize:14 }}>Book Value Decline</h4>
                    <div style={{ height:200 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={schedule} margin={{ top:4, right:16, left:0, bottom:4 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e9e4ff" />
                          <XAxis dataKey="year" tick={{ fontSize:11 }} />
                          <YAxis tick={{ fontSize:11 }} tickFormatter={v => `₹${(v/100000).toFixed(1)}L`} />
                          <Tooltip formatter={(v) => [formatINR(v), '']} />
                          <Legend />
                          <Line type="monotone" dataKey="closing" stroke="#6B3FDB" strokeWidth={2} dot={{ r:4 }} name="Book Value" />
                          <Line type="monotone" dataKey="accumulated" stroke="#d97706" strokeWidth={2} strokeDasharray="4 4" dot={{ r:3 }} name="Accumulated Dep" />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}

                {schedLoading ? (
                  <div style={{ textAlign:'center', padding:30, color:'#6B3FDB' }}>Loading schedule…</div>
                ) : (
                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                    <thead>
                      <tr style={{ background:'#6B3FDB', color:'#fff' }}>
                        {['Year','Opening Value','Depreciation','Closing Value','Accumulated Dep'].map(h => (
                          <th key={h} style={{ padding:'10px 14px', textAlign:'right', fontWeight:600 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {schedule.map((row, i) => (
                        <tr key={i} style={{ background: i%2===0 ? '#f5f3ff' : '#fff', borderBottom:'1px solid #e9e4ff' }}>
                          <td style={{ padding:'9px 14px', textAlign:'right', fontWeight:600, color:'#4c1d95' }}>{row.year}</td>
                          <td style={{ padding:'9px 14px', textAlign:'right' }}>{formatINR(row.opening)}</td>
                          <td style={{ padding:'9px 14px', textAlign:'right', color:'#dc2626', fontWeight:500 }}>{formatINR(row.depreciation)}</td>
                          <td style={{ padding:'9px 14px', textAlign:'right', fontWeight:600, color:'#16a34a' }}>{formatINR(row.closing)}</td>
                          <td style={{ padding:'9px 14px', textAlign:'right', color:'#d97706' }}>{formatINR(row.accumulated)}</td>
                        </tr>
                      ))}
                      {schedule.length > 0 && (
                        <tr style={{ background:'#ede9fe', fontWeight:700 }}>
                          <td style={{ padding:'9px 14px', textAlign:'right', color:'#4c1d95' }}>Total</td>
                          <td style={{ padding:'9px 14px', textAlign:'right', color:'#4c1d95' }}>{formatINR(schedule[0]?.opening)}</td>
                          <td style={{ padding:'9px 14px', textAlign:'right', color:'#dc2626' }}>{formatINR(schedule.reduce((s,r) => s + (r.depreciation||0), 0))}</td>
                          <td style={{ padding:'9px 14px', textAlign:'right', color:'#16a34a' }}>{formatINR(schedule[schedule.length-1]?.closing)}</td>
                          <td style={{ padding:'9px 14px', textAlign:'right', color:'#d97706' }}>{formatINR(schedule[schedule.length-1]?.accumulated)}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── DISPOSAL ── */}
        {tab === 'dispose' && (
          <div>
            <h3 style={{ color:'#4c1d95', marginBottom:16 }}>Asset Disposal</h3>
            {!disposeAsset ? (
              <div style={{ textAlign:'center', padding:40 }}>
                <p style={{ color:'#6b7280' }}>Select an asset from the Register tab and click Dispose.</p>
                <button onClick={() => setTab('register')}
                  style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'9px 20px', cursor:'pointer', fontWeight:600 }}>
                  Go to Register
                </button>
              </div>
            ) : disposeResult ? (
              <div style={{ textAlign:'center', padding:40 }}>
                <div style={{ fontSize:48, marginBottom:12 }}>{disposeResult.gain >= 0 ? '📈' : '📉'}</div>
                <h3 style={{ color: disposeResult.gain >= 0 ? '#16a34a' : '#dc2626', margin:'0 0 8px' }}>{disposeResult.msg}</h3>
                <p style={{ color:'#6b7280' }}>Asset <strong>{disposeAsset.name}</strong> has been disposed.</p>
                <button onClick={() => { setDisposeAsset(null); setDisposeResult(null); setTab('register'); }}
                  style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'9px 20px', cursor:'pointer', fontWeight:600 }}>
                  Back to Register
                </button>
              </div>
            ) : (
              <div style={{ maxWidth:540 }}>
                <div style={{ padding:'12px 16px', background:'#fef2f2', borderRadius:8, border:'1px solid #fecaca', marginBottom:20 }}>
                  <strong style={{ color:'#dc2626' }}>Disposing: {disposeAsset.name}</strong>
                  <div style={{ fontSize:13, color:'#6b7280', marginTop:4 }}>
                    Current Book Value: <strong style={{ color:'#374151' }}>{formatINR(disposeAsset.current_book_value)}</strong>
                  </div>
                </div>
                <form onSubmit={handleDispose}>
                  <div style={{ marginBottom:14 }}>
                    <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#4c1d95', marginBottom:4 }}>Disposal Date *</label>
                    <input type='date' required value={disposeForm.disposal_date}
                      onChange={e => setDisposeForm(f => ({ ...f, disposal_date: e.target.value }))}
                      style={{ width:'100%', boxSizing:'border-box', padding:'8px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }} />
                  </div>
                  <div style={{ marginBottom:14 }}>
                    <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#4c1d95', marginBottom:4 }}>Disposal Value (₹) *</label>
                    <input type='number' required value={disposeForm.disposal_value}
                      onChange={e => setDisposeForm(f => ({ ...f, disposal_value: e.target.value }))}
                      style={{ width:'100%', boxSizing:'border-box', padding:'8px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }} />
                    {disposeForm.disposal_value && (
                      <div style={{ marginTop:6, fontSize:12 }}>
                        {parseFloat(disposeForm.disposal_value) >= parseFloat(disposeAsset.current_book_value)
                          ? <span style={{ color:'#16a34a', fontWeight:600 }}>Gain: {formatINR(parseFloat(disposeForm.disposal_value) - parseFloat(disposeAsset.current_book_value))}</span>
                          : <span style={{ color:'#dc2626', fontWeight:600 }}>Loss: {formatINR(parseFloat(disposeAsset.current_book_value) - parseFloat(disposeForm.disposal_value))}</span>}
                      </div>
                    )}
                  </div>
                  <div style={{ marginBottom:14 }}>
                    <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#4c1d95', marginBottom:4 }}>Notes</label>
                    <textarea value={disposeForm.notes} onChange={e => setDisposeForm(f => ({ ...f, notes: e.target.value }))} rows={3}
                      style={{ width:'100%', boxSizing:'border-box', padding:'8px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }} />
                  </div>
                  <div style={{ display:'flex', gap:10 }}>
                    <button type='submit' disabled={loading}
                      style={{ background:'#dc2626', color:'#fff', border:'none', borderRadius:8, padding:'9px 24px', cursor:'pointer', fontWeight:600 }}>
                      {loading ? 'Processing…' : 'Confirm Disposal'}
                    </button>
                    <button type='button' onClick={() => { setDisposeAsset(null); setTab('register'); }}
                      style={{ background:'#e9e4ff', color:'#6B3FDB', border:'none', borderRadius:8, padding:'9px 20px', cursor:'pointer', fontWeight:600 }}>
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            )}
          </div>
        )}

      </div>

      {/* ── ADD / EDIT ASSET MODAL ── */}
      {showFormModal && (
        <div
          style={{ position:'fixed', inset:0, background:'rgba(76,29,149,0.18)', zIndex:1000,
            display:'flex', alignItems:'flex-start', justifyContent:'center',
            overflowY:'auto', padding:'32px 16px' }}
          onClick={e => { if (e.target === e.currentTarget) closeModal(); }}>
          <div style={{ background:'#fff', borderRadius:12, padding:28, width:'100%', maxWidth:900,
            boxShadow:'0 8px 48px rgba(107,63,219,0.22)', position:'relative' }}>
            {/* modal header */}
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <h3 style={{ color:'#4c1d95', margin:0, fontSize:18 }}>
                {editId ? '✏️ Edit Asset' : '+ Add New Asset'}
              </h3>
              <button onClick={closeModal}
                style={{ background:'#f5f3ff', border:'none', borderRadius:6, padding:'5px 12px',
                  cursor:'pointer', color:'#6B3FDB', fontWeight:700, fontSize:17, lineHeight:1 }}>✕</button>
            </div>
            {formFields}
          </div>
        </div>
      )}

    </div>
  );
}
