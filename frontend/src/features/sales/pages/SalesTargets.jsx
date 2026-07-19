import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Target, TrendingUp, Plus, X, Trash2, Edit2, Users, Globe, Building2 } from 'lucide-react';
import ConfirmDialog from '@/components/core/ConfirmDialog';

// ── Formatters ────────────────────────────────────────────────────────────────
const fmtL = (n) => {
  const v = Number(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)}Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(1)}L`;
  return `₹${v.toLocaleString('en-IN')}`;
};
const fmtPct = (n) => `${Number(n || 0).toFixed(1)}%`;

// ── India FY helpers ──────────────────────────────────────────────────────────
const getFYStartYear = (date = new Date()) => {
  const m = date.getMonth() + 1;
  return m >= 4 ? date.getFullYear() : date.getFullYear() - 1;
};
const fyLabel = (y) => `FY ${y}-${String(y + 1).slice(2)}`;

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const indiaFYQuarter = (calMonth) => {
  if (calMonth >= 4 && calMonth <= 6)  return 1;
  if (calMonth >= 7 && calMonth <= 9)  return 2;
  if (calMonth >= 10 && calMonth <= 12) return 3;
  return 4;
};

const defaultPeriod = () => {
  const now    = new Date();
  const fyYear = getFYStartYear(now);
  const month  = now.getMonth() + 1;
  return { period_type: 'monthly', period_year: fyYear, period_value: month };
};

const pctColor = (pct) => {
  const v = Number(pct || 0);
  if (v >= 100) return '#10b981';
  if (v >= 70)  return '#f59e0b';
  return '#ef4444';
};

const periodLabel = (type, year, value) => {
  if (type === 'monthly')   return `${MONTH_NAMES[(value - 1) % 12]} ${year}`;
  if (type === 'quarterly') return `Q${value} ${fyLabel(year)}`;
  return fyLabel(year);
};

const S = {
  overlay: { position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' },
  modal:   { background:'#fff', borderRadius:16, padding:32, width:480, boxShadow:'0 20px 60px rgba(0,0,0,.2)', maxHeight:'90vh', overflowY:'auto' },
  label:   { display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 },
  input:   { width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' },
  select:  { width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box', background:'#fff' },
};

// ── Individual Target Modal ────────────────────────────────────────────────────
function SetTargetModal({ onClose, onSaved, initialData }) {
  const toast = useToast();
  const [employees, setEmployees] = useState([]);
  const [form, setForm] = useState(() => {
    const def = defaultPeriod();
    return {
      owner_id:      initialData?.owner_id     ?? '',
      period_type:   initialData?.period_type  ?? def.period_type,
      period_year:   initialData?.period_year  ?? def.period_year,
      period_value:  initialData?.period_value ?? def.period_value,
      target_amount: initialData?.target_amount ?? '',
      target_orders: initialData?.target_orders ?? '',
      target_margin: initialData?.target_margin ?? '',
      commission_rate: initialData?.commission_rate ?? '',
      notes:         initialData?.notes        ?? '',
    };
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/employees?status=active&limit=500')
      .then(r => { const rows = Array.isArray(r.data) ? r.data : (r.data?.data ?? []); setEmployees(rows); })
      .catch(() => {});
  }, []);

  const handleTypeChange = (type) => {
    const now    = new Date();
    const fyYear = getFYStartYear(now);
    const month  = now.getMonth() + 1;
    let value = month;
    if (type === 'quarterly') value = indiaFYQuarter(month);
    if (type === 'annual')    value = fyYear;
    setForm(f => ({ ...f, period_type: type, period_year: fyYear, period_value: value }));
  };

  const FY_YEARS = [getFYStartYear() - 1, getFYStartYear(), getFYStartYear() + 1];

  const periodOptions = () => {
    if (form.period_type === 'monthly')   return MONTH_NAMES.map((name, i) => ({ label: name, value: i + 1 }));
    if (form.period_type === 'quarterly') return [
      { label: 'Q1 (Apr–Jun)', value: 1 }, { label: 'Q2 (Jul–Sep)', value: 2 },
      { label: 'Q3 (Oct–Dec)', value: 3 }, { label: 'Q4 (Jan–Mar)', value: 4 },
    ];
    return [];
  };

  const handleSave = async () => {
    if (!form.owner_id || !form.target_amount) { toast.error('Sales rep and target revenue are required.'); return; }
    setSaving(true);
    try {
      const payload = {
        owner_id:       Number(form.owner_id),
        period_type:    form.period_type,
        period_year:    Number(form.period_year),
        period_value:   form.period_type === 'annual' ? Number(form.period_year) : Number(form.period_value),
        target_amount:  Number(form.target_amount),
        target_orders:  form.target_orders ? Number(form.target_orders) : 0,
        target_margin:  form.target_margin ? Number(form.target_margin) : 0,
        commission_rate: form.commission_rate ? Number(form.commission_rate) : 0,
        notes:          form.notes || null,
        target_type:    'individual',
      };
      if (initialData?.id) await api.put(`/sales/targets/${initialData.id}`, payload);
      else await api.post('/sales/targets', payload);
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed.');
    } finally { setSaving(false); }
  };

  const opts = periodOptions();

  return (
    <div style={S.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={S.modal}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
          <h2 style={{ fontSize:17, fontWeight:700, color:'#1f2937', margin:0 }}>Set Individual Sales Target</h2>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
        </div>

        <div style={{ display:'grid', gap:14 }}>
          {/* Sales Rep */}
          <div>
            <label style={S.label}>Sales Rep *</label>
            <select style={S.select} value={form.owner_id} onChange={e => setForm(f => ({ ...f, owner_id: e.target.value }))}>
              <option value="">— Select rep —</option>
              {employees.map(emp => (
                <option key={emp.id} value={emp.id}>
                  {emp.name || `${emp.first_name || ''} ${emp.last_name || ''}`.trim() || emp.full_name}
                  {emp.designation ? ` (${emp.designation})` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Period Type */}
          <div>
            <label style={S.label}>Period Type *</label>
            <div style={{ display:'flex', gap:8 }}>
              {['monthly','quarterly','annual'].map(t => (
                <button key={t} onClick={() => handleTypeChange(t)}
                  style={{ flex:1, padding:'8px 0', border:`1px solid ${form.period_type===t ? '#6B3FDB' : '#e5e7eb'}`,
                           borderRadius:8, background: form.period_type===t ? '#ede9fe' : '#fff',
                           color: form.period_type===t ? '#6B3FDB' : '#374151', cursor:'pointer', fontSize:12, fontWeight:600, textTransform:'capitalize' }}>
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* FY Year */}
          <div>
            <label style={S.label}>Financial Year *</label>
            <select style={S.select} value={form.period_year} onChange={e => setForm(f => ({ ...f, period_year: Number(e.target.value) }))}>
              {FY_YEARS.map(y => <option key={y} value={y}>{fyLabel(y)}</option>)}
            </select>
          </div>

          {form.period_type !== 'annual' && opts.length > 0 && (
            <div>
              <label style={S.label}>{form.period_type === 'monthly' ? 'Month' : 'Quarter'} *</label>
              <select style={S.select} value={form.period_value} onChange={e => setForm(f => ({ ...f, period_value: Number(e.target.value) }))}>
                {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          )}

          {/* Revenue Target */}
          <div>
            <label style={S.label}>Target Revenue (₹) *</label>
            <input type="number" min="0" style={S.input} placeholder="e.g. 10000000"
              value={form.target_amount} onChange={e => setForm(f => ({ ...f, target_amount: e.target.value }))} />
          </div>

          {/* Orders + Margin (optional) */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <div>
              <label style={S.label}>Target Orders (optional)</label>
              <input type="number" min="0" style={S.input} placeholder="e.g. 12"
                value={form.target_orders} onChange={e => setForm(f => ({ ...f, target_orders: e.target.value }))} />
            </div>
            <div>
              <label style={S.label}>Target Margin ₹ (optional)</label>
              <input type="number" min="0" style={S.input} placeholder="e.g. 1500000"
                value={form.target_margin} onChange={e => setForm(f => ({ ...f, target_margin: e.target.value }))} />
            </div>
          </div>

          {/* Commission Rate */}
          <div>
            <label style={S.label}>Commission Rate % (optional)</label>
            <input type="number" min="0" max="100" step="0.1" style={S.input} placeholder="e.g. 2.5"
              value={form.commission_rate} onChange={e => setForm(f => ({ ...f, commission_rate: e.target.value }))} />
          </div>

          <div>
            <label style={S.label}>Notes (optional)</label>
            <input type="text" style={S.input} placeholder="Any notes…"
              value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
        </div>

        <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:20 }}>
          <button onClick={onClose} style={{ padding:'9px 18px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Cancel</button>
          <button onClick={handleSave} disabled={saving || !form.owner_id || !form.target_amount}
            style={{ padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8,
                     cursor: saving || !form.owner_id || !form.target_amount ? 'not-allowed' : 'pointer',
                     opacity: saving || !form.owner_id || !form.target_amount ? 0.65 : 1, fontSize:13, fontWeight:600 }}>
            {saving ? 'Saving…' : initialData ? 'Update Target' : 'Set Target'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Team / Region / BU Target Modal ──────────────────────────────────────────
function TeamTargetModal({ onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    target_type: 'team', team_name: '', region: '', business_unit: '',
    target_amount: '', target_orders: '',
    period_year: getFYStartYear(),
  });
  const [saving, setSaving] = useState(false);
  const FY_YEARS = [getFYStartYear() - 1, getFYStartYear(), getFYStartYear() + 1];

  const handleSave = async () => {
    if (!form.target_amount) { toast.error('Target revenue is required.'); return; }
    if (form.target_type === 'team' && !form.team_name) { toast.error('Team name is required.'); return; }
    if (form.target_type === 'regional' && !form.region) { toast.error('Region is required.'); return; }
    if (form.target_type === 'bu' && !form.business_unit) { toast.error('Business unit is required.'); return; }
    setSaving(true);
    try {
      await api.post('/sales-command-center/team-targets', {
        target_type:    form.target_type,
        team_name:      form.team_name || null,
        region:         form.region || null,
        business_unit:  form.business_unit || null,
        target_amount:  Number(form.target_amount),
        target_orders:  Number(form.target_orders || 0),
        period_year:    Number(form.period_year),
      });
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed.');
    } finally { setSaving(false); }
  };

  return (
    <div style={S.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={S.modal}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
          <h2 style={{ fontSize:17, fontWeight:700, color:'#1f2937', margin:0 }}>Set Team / Region / BU Target</h2>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
        </div>

        <div style={{ display:'grid', gap:14 }}>
          {/* Target type */}
          <div>
            <label style={S.label}>Target Type *</label>
            <div style={{ display:'flex', gap:8 }}>
              {[['team','Team'],['regional','Region'],['bu','Business Unit']].map(([val, lbl]) => (
                <button key={val} onClick={() => setForm(f => ({ ...f, target_type: val }))}
                  style={{ flex:1, padding:'8px 0', border:`1px solid ${form.target_type===val ? '#6B3FDB' : '#e5e7eb'}`,
                           borderRadius:8, background: form.target_type===val ? '#ede9fe' : '#fff',
                           color: form.target_type===val ? '#6B3FDB' : '#374151', cursor:'pointer', fontSize:12, fontWeight:600 }}>
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          {form.target_type === 'team' && (
            <div>
              <label style={S.label}>Team Name *</label>
              <input style={S.input} placeholder="e.g. North Sales Team" value={form.team_name}
                onChange={e => setForm(f => ({ ...f, team_name: e.target.value }))} />
            </div>
          )}
          {form.target_type === 'regional' && (
            <div>
              <label style={S.label}>Region *</label>
              <input style={S.input} placeholder="e.g. South India, Maharashtra" value={form.region}
                onChange={e => setForm(f => ({ ...f, region: e.target.value }))} />
            </div>
          )}
          {form.target_type === 'bu' && (
            <div>
              <label style={S.label}>Business Unit *</label>
              <input style={S.input} placeholder="e.g. HVDC, STATCOM, Services" value={form.business_unit}
                onChange={e => setForm(f => ({ ...f, business_unit: e.target.value }))} />
            </div>
          )}

          <div>
            <label style={S.label}>Financial Year *</label>
            <select style={S.select} value={form.period_year} onChange={e => setForm(f => ({ ...f, period_year: Number(e.target.value) }))}>
              {FY_YEARS.map(y => <option key={y} value={y}>{fyLabel(y)}</option>)}
            </select>
          </div>

          <div>
            <label style={S.label}>Target Revenue (₹) *</label>
            <input type="number" min="0" style={S.input} placeholder="e.g. 50000000"
              value={form.target_amount} onChange={e => setForm(f => ({ ...f, target_amount: e.target.value }))} />
          </div>

          <div>
            <label style={S.label}>Target Orders (optional)</label>
            <input type="number" min="0" style={S.input} placeholder="e.g. 50"
              value={form.target_orders} onChange={e => setForm(f => ({ ...f, target_orders: e.target.value }))} />
          </div>
        </div>

        <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:20 }}>
          <button onClick={onClose} style={{ padding:'9px 18px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Cancel</button>
          <button onClick={handleSave} disabled={saving}
            style={{ padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8,
                     cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.65 : 1, fontSize:13, fontWeight:600 }}>
            {saving ? 'Saving…' : 'Set Target'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function SalesTargets() {
  const toast = useToast();

  const [activeTab,    setActiveTab]   = useState('individual');
  const [filter,       setFilter]      = useState(defaultPeriod);
  const [targets,      setTargets]     = useState([]);
  const [teamTargets,  setTeamTargets] = useState([]);
  const [stats,        setStats]       = useState(null);
  const [loading,      setLoading]     = useState(true);
  const [showModal,    setShowModal]   = useState(false);
  const [showTeamModal,setShowTeamModal] = useState(false);
  const [editTarget,   setEditTarget]  = useState(null);
  const [pendingHandleDelete, setPendingHandleDelete] = useState(null);

  const FY_YEARS = [getFYStartYear() - 1, getFYStartYear(), getFYStartYear() + 1];
  const fyYear = filter.period_year;

  const load = useCallback(() => {
    setLoading(true);
    const params = {
      period_type:  filter.period_type,
      period_year:  filter.period_year,
      period_value: filter.period_type === 'annual' ? filter.period_year : filter.period_value,
    };
    Promise.all([
      api.get('/sales/targets',       { params }).catch(() => ({ data: [] })),
      api.get('/sales/targets/stats', { params }).catch(() => ({ data: null })),
      api.get(`/sales-command-center/team-targets?fy_year=${filter.period_year}`).catch(() => ({ data: [] })),
    ]).then(([tRes, sRes, ttRes]) => {
      setTargets(Array.isArray(tRes.data) ? tRes.data : []);
      setStats(sRes.data || null);
      setTeamTargets(Array.isArray(ttRes.data) ? ttRes.data : []);
    }).finally(() => setLoading(false));
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async () => {
    if (!pendingHandleDelete) return;
    const id = pendingHandleDelete;
    setPendingHandleDelete(null);
    try {
      await api.delete(`/sales/targets/${id}`);
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Delete failed.'); }
  };

  const handleTypeChange = (type) => {
    const now    = new Date();
    const fyYear = getFYStartYear(now);
    const month  = now.getMonth() + 1;
    let value    = month;
    if (type === 'quarterly') value = indiaFYQuarter(month);
    if (type === 'annual')    value = fyYear;
    setFilter({ period_type: type, period_year: fyYear, period_value: value });
  };

  const periodOptions = () => {
    if (filter.period_type === 'monthly')   return MONTH_NAMES.map((name, i) => ({ label: name, value: i + 1 }));
    if (filter.period_type === 'quarterly') return [
      { label: 'Q1 (Apr–Jun)', value: 1 }, { label: 'Q2 (Jul–Sep)', value: 2 },
      { label: 'Q3 (Oct–Dec)', value: 3 }, { label: 'Q4 (Jan–Mar)', value: 4 },
    ];
    return [];
  };

  const repCount    = stats?.rep_count          ?? 0;
  const teamPct     = Number(stats?.team_achievement_pct ?? 0);
  const totalTarget = Number(stats?.total_target   ?? 0);
  const totalAchiev = Number(stats?.total_achieved ?? 0);
  const filterLabel = periodLabel(filter.period_type, filter.period_year, filter.period_value);

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>
      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Sales Targets</h1>
          <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>
            {repCount} {repCount === 1 ? 'rep' : 'reps'} · Team achievement {fmtPct(teamPct)} · {filterLabel}
          </p>
        </div>
        <div style={{ display:'flex', gap:10 }}>
          <button onClick={() => setShowTeamModal(true)}
            style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 16px', background:'#fff', color:'#374151', border:'1px solid #e5e7eb', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
            <Users size={14}/> Team Target
          </button>
          <button onClick={() => { setEditTarget(null); setShowModal(true); }}
            style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 16px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
            <Plus size={14}/> Individual Target
          </button>
        </div>
      </div>

      {/* Period filter bar */}
      <div style={{ background:'#fff', borderRadius:12, padding:'14px 16px', border:'1px solid #f0f0f4', marginBottom:20, display:'flex', flexWrap:'wrap', gap:12, alignItems:'center' }}>
        <div style={{ display:'flex', gap:6 }}>
          {['monthly','quarterly','annual'].map(t => (
            <button key={t} onClick={() => handleTypeChange(t)}
              style={{ padding:'6px 14px', border:`1px solid ${filter.period_type===t ? '#6B3FDB' : '#e5e7eb'}`,
                       borderRadius:20, background: filter.period_type===t ? '#ede9fe' : '#fff',
                       color: filter.period_type===t ? '#6B3FDB' : '#6b7280', cursor:'pointer', fontSize:12, fontWeight:600, textTransform:'capitalize' }}>
              {t}
            </button>
          ))}
        </div>
        <select value={filter.period_year}
          onChange={e => setFilter(f => ({ ...f, period_year: Number(e.target.value) }))}
          style={{ padding:'6px 10px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:12, color:'#374151', outline:'none', background:'#fff' }}>
          {FY_YEARS.map(y => <option key={y} value={y}>{fyLabel(y)}</option>)}
        </select>
        {filter.period_type !== 'annual' && (
          <select value={filter.period_value}
            onChange={e => setFilter(f => ({ ...f, period_value: Number(e.target.value) }))}
            style={{ padding:'6px 10px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:12, color:'#374151', outline:'none', background:'#fff' }}>
            {periodOptions().map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
      </div>

      {/* KPI cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:16, marginBottom:20 }}>
        {[
          { label:'Total Target',     value: fmtL(totalTarget), color:'#6366f1' },
          { label:'Total Achieved',   value: fmtL(totalAchiev), color:'#10b981' },
          { label:'Team Achievement', value: fmtPct(teamPct),   color: pctColor(teamPct) },
        ].map(k => (
          <div key={k.label} style={{ background:'#fff', borderRadius:12, padding:20, border:'1px solid #f0f0f4' }}>
            <p style={{ fontSize:12, color:'#9ca3af', margin:'0 0 6px', fontWeight:500, textTransform:'uppercase', letterSpacing:'0.05em' }}>{k.label}</p>
            <p style={{ fontSize:24, fontWeight:700, color:k.color, margin:0 }}>{k.value}</p>
          </div>
        ))}
      </div>

      {/* Sub tabs */}
      <div style={{ display:'flex', gap:4, marginBottom:16 }}>
        {[['individual','Individual Targets'],['team','Team / Region / BU']].map(([key, label]) => (
          <button key={key} onClick={() => setActiveTab(key)}
            style={{ padding:'7px 18px', borderRadius:8, border:'none', cursor:'pointer', fontSize:13, fontWeight:600,
              background: activeTab===key ? '#6B3FDB' : '#fff', color: activeTab===key ? '#fff' : '#6b7280',
              boxShadow: activeTab===key ? '0 1px 4px rgba(107,63,219,.3)' : 'none' }}>
            {label}
          </button>
        ))}
      </div>

      {/* ── Individual Targets ─────────────────────────────────────────────── */}
      {activeTab === 'individual' && (
        loading ? (
          <div style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>Loading…</div>
        ) : targets.length === 0 ? (
          <div style={{ background:'#fff', borderRadius:12, padding:60, textAlign:'center', border:'1px solid #f0f0f4' }}>
            <Target size={40} color="#d1d5db" style={{ marginBottom:12 }}/>
            <p style={{ color:'#9ca3af', marginBottom:16 }}>No targets set for {filterLabel}</p>
            <button onClick={() => { setEditTarget(null); setShowModal(true); }}
              style={{ padding:'9px 20px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
              Set First Target
            </button>
          </div>
        ) : (
          <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden' }}>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse' }}>
                <thead>
                  <tr style={{ background:'#f9fafb', borderBottom:'1px solid #f0f0f4' }}>
                    {['Sales Rep','Target Rev','Target Orders','Achieved','Achievement %','Target Margin','Commission %','Progress','Actions'].map(h => (
                      <th key={h} style={{ padding:'12px 14px', textAlign:'left', fontSize:11, fontWeight:600, color:'#6b7280', textTransform:'uppercase', letterSpacing:'0.05em', whiteSpace:'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {targets.map((t, idx) => {
                    const pct = Number(t.achievement_pct || 0);
                    const barW = Math.min(100, pct);
                    const clr  = pctColor(pct);
                    return (
                      <tr key={t.id} style={{ borderBottom: idx < targets.length - 1 ? '1px solid #f3f4f6' : 'none' }}>
                        <td style={{ padding:'12px 14px' }}>
                          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                            <div style={{ width:34, height:34, borderRadius:'50%', background:'#ede9fe', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                              <span style={{ fontSize:13, fontWeight:700, color:'#6B3FDB' }}>{(t.owner_name || '?')[0].toUpperCase()}</span>
                            </div>
                            <div>
                              <div style={{ fontSize:13, fontWeight:600, color:'#1f2937' }}>{t.owner_name || '—'}</div>
                              <div style={{ fontSize:11, color:'#9ca3af' }}>{t.designation || ''}</div>
                            </div>
                          </div>
                        </td>
                        <td style={{ padding:'12px 14px', fontSize:13, fontWeight:600, color:'#1f2937' }}>{fmtL(t.target_amount)}</td>
                        <td style={{ padding:'12px 14px', fontSize:13, color:'#6b7280' }}>{t.target_orders > 0 ? t.target_orders : '—'}</td>
                        <td style={{ padding:'12px 14px', fontSize:13, color:'#374151' }}>{fmtL(t.achieved_amount)}</td>
                        <td style={{ padding:'12px 14px' }}>
                          <span style={{ display:'inline-block', padding:'3px 10px', borderRadius:12,
                                         background: pct >= 100 ? '#d1fae5' : pct >= 70 ? '#fef3c7' : '#fee2e2',
                                         color: clr, fontSize:12, fontWeight:700 }}>
                            {pct >= 100 ? 'On Target' : `${pct.toFixed(1)}%`}
                          </span>
                        </td>
                        <td style={{ padding:'12px 14px', fontSize:13, color:'#6b7280' }}>{t.target_margin > 0 ? fmtL(t.target_margin) : '—'}</td>
                        <td style={{ padding:'12px 14px', fontSize:13, color:'#374151' }}>{t.commission_rate > 0 ? `${Number(t.commission_rate).toFixed(1)}%` : '—'}</td>
                        <td style={{ padding:'12px 14px', minWidth:100 }}>
                          <div style={{ background:'#f3f4f6', borderRadius:6, height:8 }}>
                            <div style={{ width:`${barW}%`, height:'100%', background:clr, borderRadius:6, transition:'width .3s' }}/>
                          </div>
                        </td>
                        <td style={{ padding:'12px 14px' }}>
                          <div style={{ display:'flex', gap:6 }}>
                            <button onClick={() => { setEditTarget(t); setShowModal(true); }} title="Edit"
                              style={{ background:'none', border:'1px solid #e5e7eb', borderRadius:6, padding:'5px 8px', cursor:'pointer', color:'#6b7280', display:'flex', alignItems:'center' }}>
                              <Edit2 size={13}/>
                            </button>
                            <button onClick={() => setPendingHandleDelete(t.id)} title="Delete"
                              style={{ background:'none', border:'1px solid #fee2e2', borderRadius:6, padding:'5px 8px', cursor:'pointer', color:'#ef4444', display:'flex', alignItems:'center' }}>
                              <Trash2 size={13}/>
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}

      {/* ── Team / Region / BU Targets ─────────────────────────────────────── */}
      {activeTab === 'team' && (
        <div>
          {teamTargets.length === 0 ? (
            <div style={{ background:'#fff', borderRadius:12, padding:60, textAlign:'center', border:'1px solid #f0f0f4' }}>
              <Users size={40} color="#d1d5db" style={{ marginBottom:12 }}/>
              <p style={{ color:'#9ca3af', marginBottom:16 }}>No team / region / BU targets set for {fyLabel(fyYear)}</p>
              <button onClick={() => setShowTeamModal(true)}
                style={{ padding:'9px 20px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
                Set Team Target
              </button>
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
              {teamTargets.map((t, i) => {
                const pct = Number(t.achievement_pct || 0);
                const clr = pctColor(pct);
                const Icon = t.target_type === 'regional' ? Globe : t.target_type === 'bu' ? Building2 : Users;
                return (
                  <div key={i} style={{ background:'#fff', borderRadius:12, padding:20, border:'1px solid #f0f0f4' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:14 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                        <div style={{ width:38, height:38, borderRadius:10, background:'#ede9fe', display:'flex', alignItems:'center', justifyContent:'center' }}>
                          <Icon size={18} color="#6B3FDB"/>
                        </div>
                        <div>
                          <div style={{ fontSize:15, fontWeight:700, color:'#1f2937' }}>{t.group_name}</div>
                          <div style={{ fontSize:11, color:'#9ca3af', textTransform:'uppercase', fontWeight:600 }}>{t.target_type}</div>
                        </div>
                      </div>
                      <span style={{ fontSize:16, fontWeight:700, color:clr }}>{fmtPct(pct)}</span>
                    </div>
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginBottom:12 }}>
                      {[
                        { label:'Target', value: fmtL(t.target_revenue) },
                        { label:'Achieved', value: fmtL(t.achieved_revenue), color: '#10b981' },
                        { label:'Gap', value: fmtL(t.gap_value), color: '#ef4444' },
                        { label:'Orders', value: t.achieved_orders || 0 },
                      ].map(k => (
                        <div key={k.label} style={{ textAlign:'center' }}>
                          <div style={{ fontSize:11, color:'#9ca3af', fontWeight:500 }}>{k.label}</div>
                          <div style={{ fontSize:15, fontWeight:700, color: k.color || '#1f2937' }}>{k.value}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ background:'#f3f4f6', borderRadius:6, height:8 }}>
                      <div style={{ width:`${Math.min(pct, 100)}%`, height:'100%', background:clr, borderRadius:6, transition:'width .3s' }}/>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      <ConfirmDialog
        open={!!pendingHandleDelete}
        title="Delete Target"
        message="Delete this target?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingHandleDelete(null)}
      />
      {showModal && (
        <SetTargetModal
          onClose={() => { setShowModal(false); setEditTarget(null); }}
          onSaved={load}
          initialData={editTarget}
        />
      )}
      {showTeamModal && (
        <TeamTargetModal onClose={() => setShowTeamModal(false)} onSaved={load} />
      )}
    </div>
  );
}
