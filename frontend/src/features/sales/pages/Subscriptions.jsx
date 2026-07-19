import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { RefreshCw, Plus, X, TrendingUp, Users, IndianRupee, AlertCircle } from 'lucide-react';

const STATUS_TABS = ['all','active','paused','cancelled','expired'];
const STATUS_LABEL = { all:'All', active:'Active', paused:'Paused', cancelled:'Cancelled', expired:'Expired' };
const STATUS_COLOR = {
  active:    { bg:'#d1fae5', color:'#065f46' },
  paused:    { bg:'#fef3c7', color:'#92400e' },
  cancelled: { bg:'#fee2e2', color:'#991b1b' },
  expired:   { bg:'#f3f4f6', color:'#6b7280' },
};
const CYCLES = ['monthly','quarterly','annual'];

function fmtL(n) {
  const v = parseFloat(n) || 0;
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)} Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(2)} L`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
}

const EMPTY = { customer_name:'', plan_name:'', amount:'', currency:'INR', billing_cycle:'monthly', start_date:'', next_billing_date:'', auto_renew:true };

function KPICard({ icon: Icon, label, value, color }) {
  return (
    <div style={{ background:'#fff', borderRadius:12, padding:'16px 20px', border:'1px solid #f0f0f4', display:'flex', alignItems:'center', gap:14, flex:1, minWidth:160 }}>
      <div style={{ width:42, height:42, borderRadius:10, background: color + '18', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
        <Icon size={20} color={color}/>
      </div>
      <div>
        <p style={{ fontSize:12, color:'#9ca3af', margin:0, fontWeight:500 }}>{label}</p>
        <p style={{ fontSize:18, fontWeight:700, color:'#1f2937', margin:'2px 0 0' }}>{value}</p>
      </div>
    </div>
  );
}

export default function Subscriptions() {
  const toast = useToast();
  const [subs,      setSubs]      = useState([]);
  const [stats,     setStats]     = useState({ total:0, active:0, paused:0, cancelled:0, expired:0, mrr:0, arr:0, churn_count:0 });
  const [loading,   setLoading]   = useState(true);
  const [activeTab, setActiveTab] = useState('all');
  const [showForm,  setShowForm]  = useState(false);
  const [form,      setForm]      = useState(EMPTY);
  const [saving,    setSaving]    = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    const tab = activeTab === 'all' ? undefined : activeTab;
    Promise.all([
      api.get('/sales/subscriptions', { params: { limit:200, status: tab } }),
      api.get('/sales/subscriptions/stats'),
    ])
      .then(([subsRes, statsRes]) => {
        setSubs(Array.isArray(subsRes.data) ? subsRes.data : []);
        setStats(statsRes.data || { total:0, active:0, paused:0, cancelled:0, expired:0, mrr:0, arr:0, churn_count:0 });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [activeTab]);

  useEffect(() => { load(); }, [load]);

  async function handleSave(e) {
    e.preventDefault();
    if (!form.customer_name || !form.plan_name || !form.amount || !form.start_date) return;
    setSaving(true);
    try {
      await api.post('/sales/subscriptions', { ...form, amount: Number(form.amount) });
      toast.success('Subscription created');
      setShowForm(false);
      setForm(EMPTY);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create subscription');
    } finally { setSaving(false); }
  }

  async function handleAction(id, action) {
    try {
      await api.patch(`/sales/subscriptions/${id}/${action}`);
      toast.success(`Subscription ${action}d`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || `Failed to ${action}`);
    }
  }

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>

      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Subscriptions</h1>
        <button onClick={() => setShowForm(true)}
          style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
          <Plus size={15}/> New Subscription
        </button>
      </div>

      {/* KPI cards */}
      <div style={{ display:'flex', gap:12, marginBottom:20, flexWrap:'wrap' }}>
        <KPICard icon={Users}       label="Active"        value={stats.active}             color="#10b981"/>
        <KPICard icon={IndianRupee} label="MRR"           value={fmtL(stats.mrr)}          color="#6B3FDB"/>
        <KPICard icon={TrendingUp}  label="ARR"           value={fmtL(stats.arr)}          color="#3b82f6"/>
        <KPICard icon={AlertCircle} label="Churned (mo.)" value={stats.churn_count || 0}   color="#ef4444"/>
      </div>

      {/* Status filter tabs */}
      <div style={{ display:'flex', gap:6, marginBottom:16, flexWrap:'wrap' }}>
        {STATUS_TABS.map(tab => {
          const countMap = { all: stats.total, active: stats.active, paused: stats.paused, cancelled: stats.cancelled, expired: stats.expired };
          const count = countMap[tab] ?? 0;
          return (
            <button key={tab} onClick={() => setActiveTab(tab)}
              style={{ padding:'5px 14px', borderRadius:20, fontSize:12, fontWeight:600, cursor:'pointer', border:'none',
                background: activeTab === tab ? '#6B3FDB' : '#f3f4f6',
                color:      activeTab === tab ? '#fff'    : '#374151' }}>
              {STATUS_LABEL[tab]} ({count})
            </button>
          );
        })}
      </div>

      {/* Table */}
      <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden' }}>
        {loading ? (
          <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>Loading...</div>
        ) : subs.length === 0 ? (
          <div style={{ padding:60, textAlign:'center', color:'#9ca3af' }}>
            <RefreshCw size={36} color="#d1d5db" style={{ display:'block', margin:'0 auto 12px' }}/>
            <p>No subscriptions found. Click "+ New Subscription" to create one.</p>
          </div>
        ) : (
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ background:'#f9fafb' }}>
                {['Customer','Plan','Amount','Cycle','Status','Next Billing','Actions'].map(h => (
                  <th key={h} style={{ padding:'10px 16px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {subs.map((s, i) => {
                const sc = STATUS_COLOR[s.status] || STATUS_COLOR.active;
                return (
                  <tr key={s.id || i} style={{ borderBottom:'1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ padding:'10px 16px', fontWeight:500, color:'#1f2937' }}>{s.customer_name || '—'}</td>
                    <td style={{ padding:'10px 16px', color:'#374151' }}>{s.plan_name || '—'}</td>
                    <td style={{ padding:'10px 16px', fontWeight:600, color:'#10b981' }}>{fmtL(s.amount)}</td>
                    <td style={{ padding:'10px 16px', color:'#6b7280', textTransform:'capitalize' }}>{s.billing_cycle || 'monthly'}</td>
                    <td style={{ padding:'10px 16px' }}>
                      <span style={{ background: sc.bg, color: sc.color, padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:600, textTransform:'capitalize' }}>{s.status || 'active'}</span>
                    </td>
                    <td style={{ padding:'10px 16px', color:'#374151' }}>{(s.next_billing_date || s.end_date || '—').toString().slice(0, 10)}</td>
                    <td style={{ padding:'10px 16px' }}>
                      <div style={{ display:'flex', gap:6 }}>
                        {s.status === 'active' && (
                          <button onClick={() => handleAction(s.id, 'pause')}
                            style={{ padding:'4px 10px', fontSize:11, fontWeight:600, background:'#fef3c7', color:'#92400e', border:'none', borderRadius:6, cursor:'pointer' }}>Pause</button>
                        )}
                        {s.status === 'paused' && (
                          <button onClick={() => handleAction(s.id, 'renew')}
                            style={{ padding:'4px 10px', fontSize:11, fontWeight:600, background:'#d1fae5', color:'#065f46', border:'none', borderRadius:6, cursor:'pointer' }}>Renew</button>
                        )}
                        {['active','paused'].includes(s.status) && (
                          <button onClick={() => handleAction(s.id, 'cancel')}
                            style={{ padding:'4px 10px', fontSize:11, fontWeight:600, background:'#fee2e2', color:'#991b1b', border:'none', borderRadius:6, cursor:'pointer' }}>Cancel</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* New Subscription modal */}
      {showForm && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:'#fff', borderRadius:16, padding:28, width:460, maxHeight:'90vh', overflowY:'auto', boxShadow:'0 8px 32px rgba(0,0,0,.18)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <h3 style={{ margin:0, fontSize:16, fontWeight:700, color:'#1f2937' }}>New Subscription</h3>
              <button onClick={() => setShowForm(false)} style={{ background:'none', border:'none', cursor:'pointer', color:'#6b7280' }}><X size={18}/></button>
            </div>
            <form onSubmit={handleSave} style={{ display:'flex', flexDirection:'column', gap:14 }}>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                <div style={{ gridColumn:'1/-1' }}>
                  <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>Customer Name</label>
                  <input required value={form.customer_name} onChange={e => setForm(f => ({...f, customer_name: e.target.value}))}
                    placeholder="e.g. Acme Corp"
                    style={{ width:'100%', padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
                </div>
                <div>
                  <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>Plan Name *</label>
                  <input required value={form.plan_name} onChange={e => setForm(f => ({...f, plan_name: e.target.value}))}
                    placeholder="e.g. Enterprise Pro"
                    style={{ width:'100%', padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
                </div>
                <div>
                  <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>Amount (₹) *</label>
                  <input required type="number" min="0" step="0.01" value={form.amount} onChange={e => setForm(f => ({...f, amount: e.target.value}))}
                    placeholder="0.00"
                    style={{ width:'100%', padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
                </div>
                <div>
                  <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>Billing Cycle</label>
                  <select value={form.billing_cycle} onChange={e => setForm(f => ({...f, billing_cycle: e.target.value}))}
                    style={{ width:'100%', padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', background:'#fff', boxSizing:'border-box' }}>
                    {CYCLES.map(c => <option key={c} value={c} style={{ textTransform:'capitalize' }}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>Start Date *</label>
                  <input required type="date" value={form.start_date} onChange={e => setForm(f => ({...f, start_date: e.target.value}))}
                    style={{ width:'100%', padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
                </div>
                <div>
                  <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>Next Billing Date</label>
                  <input type="date" value={form.next_billing_date} onChange={e => setForm(f => ({...f, next_billing_date: e.target.value}))}
                    style={{ width:'100%', padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
                </div>
                <div style={{ gridColumn:'1/-1', display:'flex', alignItems:'center', gap:8 }}>
                  <input type="checkbox" id="auto_renew" checked={form.auto_renew} onChange={e => setForm(f => ({...f, auto_renew: e.target.checked}))}/>
                  <label htmlFor="auto_renew" style={{ fontSize:13, color:'#374151', cursor:'pointer' }}>Auto-renew</label>
                </div>
              </div>
              <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:4 }}>
                <button type="button" onClick={() => setShowForm(false)}
                  style={{ padding:'8px 18px', background:'#f5f5f5', border:'1px solid #e0e0e0', borderRadius:8, cursor:'pointer', fontSize:13 }}>Cancel</button>
                <button type="submit" disabled={saving}
                  style={{ padding:'8px 20px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor: saving ? 'not-allowed' : 'pointer', fontWeight:600, fontSize:13, opacity: saving ? 0.7 : 1 }}>
                  {saving ? 'Saving...' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
