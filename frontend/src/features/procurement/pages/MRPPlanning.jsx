import { useState, useEffect, useRef } from 'react';
import { RefreshCw, AlertTriangle, TrendingUp, ShoppingCart, Calculator, ChevronRight, Plus } from 'lucide-react';
import api from '@/services/api/client';

const fmt = n => `₹${parseFloat(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

function KPI({ icon: Icon, label, value, color, bg }) {
  return (
    <div style={{ background: '#fff', borderRadius: 12, padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 14, boxShadow: '0 1px 3px rgba(0,0,0,.07)', flex: 1, minWidth: 160 }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', color }}>
        <Icon size={18} />
      </div>
      <div>
        <div style={{ fontSize: 22, fontWeight: 700, color: '#111' }}>{value}</div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>{label}</div>
      </div>
    </div>
  );
}

export default function MRPPlanning() {
  const [alerts,      setAlerts]      = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [eoq,         setEoq]         = useState(null);
  const [eoqItemId,   setEoqItemId]   = useState('');
  const [eoqLoading,  setEoqLoading]  = useState(false);
  const [items,       setItems]       = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [converting,  setConverting]  = useState(null);
  const [toast,       setToast]       = useState(null);
  const [tab,         setTab]         = useState('alerts');
  const isMounted = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => { if (isMounted.current) setToast(null); }, 3000);
  };

  const load = async () => {
    setLoading(true);
    try {
      const [alertsR, suggestionsR, itemsR] = await Promise.allSettled([
        api.get('/inventory/reorder-alerts'),
        api.get('/inventory/purchase-suggestions'),
        api.get('/inventory/items'),
      ]);
      if (!isMounted.current) return;
      setAlerts(alertsR.status === 'fulfilled' ? (alertsR.value.data?.alerts || alertsR.value.data || []) : []);
      setSuggestions(suggestionsR.status === 'fulfilled' ? (suggestionsR.value.data?.suggestions || suggestionsR.value.data || []) : []);
      setItems(itemsR.status === 'fulfilled' ? (itemsR.value.data?.items || itemsR.value.data || []) : []);
    } finally { if (isMounted.current) setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const convertToPR = async (id) => {
    setConverting(id);
    try {
      await api.post(`/inventory/purchase-suggestions/${id}/convert`);
      if (!isMounted.current) return;
      showToast('Purchase Request created from suggestion');
      load();
    } catch (e) {
      if (!isMounted.current) return;
      showToast(e.response?.data?.error || 'Failed to convert', 'error');
    } finally { if (isMounted.current) setConverting(null); }
  };

  const calcEOQ = async () => {
    if (!eoqItemId) return showToast('Select an item', 'error');
    setEoqLoading(true);
    setEoq(null);
    try {
      const r = await api.get('/procurement/analytics/eoq', { params: { item_id: eoqItemId } });
      if (!isMounted.current) return;
      setEoq(r.data);
    } catch (e) {
      showToast(e.response?.data?.error || 'EOQ calculation failed', 'error');
    } finally { if (isMounted.current) setEoqLoading(false); }
  };

  const ackAlert = async (id) => {
    try {
      await api.post(`/inventory/alerts/${id}/acknowledge`);
      if (!isMounted.current) return;
      setAlerts(a => a.filter(x => x.id !== id));
    } catch { showToast('Failed to acknowledge', 'error'); }
  };

  const sev = a => {
    const pct = a.reorder_level > 0 ? (a.current_stock / a.reorder_level) * 100 : 100;
    if (pct === 0) return { label: 'Out of Stock', color: '#dc2626', bg: '#fee2e2' };
    if (pct < 25)  return { label: 'Critical',     color: '#c2410c', bg: '#ffedd5' };
    if (pct < 75)  return { label: 'Low',          color: '#92400e', bg: '#fef3c7' };
    return                 { label: 'Watch',        color: '#1d4ed8', bg: '#dbeafe' };
  };

  const tabStyle = active => ({
    padding: '8px 18px', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer',
    background: active ? '#6B3FDB' : 'transparent',
    color: active ? '#fff' : '#6b7280',
    border: active ? 'none' : '1px solid #e5e7eb',
  });

  return (
    <div style={{ padding: '24px 28px', margin: '0 auto' }}>
      {toast && (
        <div style={{ position: 'fixed', top: 20, right: 20, zIndex: 9999, padding: '10px 20px', borderRadius: 8, background: toast.type === 'error' ? '#fee2e2' : '#dcfce7', color: toast.type === 'error' ? '#991b1b' : '#166534', fontWeight: 600, fontSize: 14 }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#111' }}>MRP &amp; Planning</h1>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 14 }}>Reorder alerts, purchase suggestions, and EOQ calculator</p>
        </div>
        <button onClick={load} style={{ background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* KPIs */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        <KPI icon={AlertTriangle} label="Reorder Alerts" value={alerts.length} color="#c2410c" bg="#ffedd5" />
        <KPI icon={TrendingUp} label="Purchase Suggestions" value={suggestions.filter(s => s.status === 'pending').length} color="#1d4ed8" bg="#dbeafe" />
        <KPI icon={ShoppingCart} label="Out of Stock" value={alerts.filter(a => (a.current_stock || 0) === 0).length} color="#dc2626" bg="#fee2e2" />
        <KPI icon={Calculator} label="Items Tracked" value={items.length} color="#6B3FDB" bg="#f5f3ff" />
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {[['alerts', 'Reorder Alerts'], ['suggestions', 'Purchase Suggestions'], ['eoq', 'EOQ Calculator']].map(([key, label]) => (
          <button key={key} style={tabStyle(tab === key)} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      {/* ── Reorder Alerts ── */}
      {tab === 'alerts' && (
        <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,.07)', overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading alerts…</div>
          ) : alerts.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
              <AlertTriangle size={36} style={{ marginBottom: 8, opacity: 0.4 }} />
              <p>No reorder alerts — all items are adequately stocked.</p>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb', borderBottom: '1px solid #f0f0f4' }}>
                  {['Item', 'Item Code', 'Current Stock', 'Reorder Level', 'Shortage', 'Severity', 'Actions'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {alerts.map((a, i) => {
                  const s = sev(a);
                  const shortage = Math.max(0, (a.reorder_level || 0) - (a.current_stock || 0));
                  return (
                    <tr key={a.id || i} style={{ borderBottom: '1px solid #f5f5f5' }}>
                      <td style={{ padding: '10px 14px', fontWeight: 600 }}>{a.item_name || a.name || '—'}</td>
                      <td style={{ padding: '10px 14px', color: '#6b7280', fontFamily: 'monospace' }}>{a.item_code || '—'}</td>
                      <td style={{ padding: '10px 14px', fontWeight: 700, color: (a.current_stock || 0) === 0 ? '#dc2626' : '#111' }}>{a.current_stock || 0} {a.unit_of_measure || ''}</td>
                      <td style={{ padding: '10px 14px', color: '#6b7280' }}>{a.reorder_level || 0}</td>
                      <td style={{ padding: '10px 14px', fontWeight: 600, color: '#c2410c' }}>{shortage} {a.unit_of_measure || ''}</td>
                      <td style={{ padding: '10px 14px' }}>
                        <span style={{ padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700, color: s.color, background: s.bg }}>{s.label}</span>
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button onClick={() => ackAlert(a.id)} style={{ padding: '4px 12px', borderRadius: 6, background: '#f3f4f6', border: '1px solid #e5e7eb', cursor: 'pointer', fontSize: 12, color: '#374151' }}>Acknowledge</button>
                          <button onClick={() => { setTab('suggestions'); }} style={{ padding: '4px 12px', borderRadius: 6, background: '#6B3FDB', border: 'none', cursor: 'pointer', fontSize: 12, color: '#fff' }}>
                            <Plus size={10} style={{ marginRight: 4 }} />Create PR
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── Purchase Suggestions ── */}
      {tab === 'suggestions' && (
        <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,.07)', overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading suggestions…</div>
          ) : suggestions.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
              <TrendingUp size={36} style={{ marginBottom: 8, opacity: 0.4 }} />
              <p>No purchase suggestions at this time.</p>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb', borderBottom: '1px solid #f0f0f4' }}>
                  {['Item', 'Qty Needed', 'Est. Cost', 'Status', 'Created', 'Actions'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {suggestions.map((s, i) => (
                  <tr key={s.id || i} style={{ borderBottom: '1px solid #f5f5f5' }}>
                    <td style={{ padding: '10px 14px', fontWeight: 600 }}>{s.item_name || s.name || '—'}</td>
                    <td style={{ padding: '10px 14px' }}>{s.quantity_needed || s.quantity || '—'} {s.unit_of_measure || ''}</td>
                    <td style={{ padding: '10px 14px' }}>{s.estimated_cost ? fmt(s.estimated_cost) : '—'}</td>
                    <td style={{ padding: '10px 14px' }}>
                      <span style={{ padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700,
                        color: s.status === 'converted' ? '#166534' : '#92400e',
                        background: s.status === 'converted' ? '#dcfce7' : '#fef3c7' }}>
                        {s.status || 'pending'}
                      </span>
                    </td>
                    <td style={{ padding: '10px 14px', color: '#6b7280' }}>{(s.created_at || '').slice(0, 10) || '—'}</td>
                    <td style={{ padding: '10px 14px' }}>
                      {s.status !== 'converted' && (
                        <button
                          onClick={() => convertToPR(s.id)}
                          disabled={converting === s.id}
                          style={{ padding: '5px 14px', borderRadius: 6, background: '#6B3FDB', border: 'none', cursor: 'pointer', fontSize: 12, color: '#fff', display: 'flex', alignItems: 'center', gap: 5 }}>
                          {converting === s.id ? 'Creating…' : <><Plus size={10} /> Create PR</>}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── EOQ Calculator ── */}
      {tab === 'eoq' && (
        <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 20 }}>
          {/* Input panel */}
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 1px 3px rgba(0,0,0,.07)' }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700, color: '#111' }}>EOQ Calculator</h3>
            <p style={{ margin: '0 0 20px', fontSize: 12, color: '#6b7280' }}>Computes Economic Order Quantity using 12-month consumption history.</p>

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Item *</label>
              <select value={eoqItemId} onChange={e => setEoqItemId(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13 }}>
                <option value="">Select item…</option>
                {items.map(it => <option key={it.id} value={it.id}>{it.item_name} ({it.item_code})</option>)}
              </select>
            </div>

            <button onClick={calcEOQ} disabled={eoqLoading || !eoqItemId}
              style={{ width: '100%', padding: '10px', borderRadius: 8, background: eoqItemId ? '#6B3FDB' : '#d1d5db', border: 'none', color: '#fff', fontWeight: 600, fontSize: 14, cursor: eoqItemId ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <Calculator size={16} />
              {eoqLoading ? 'Calculating…' : 'Calculate EOQ'}
            </button>
          </div>

          {/* Results */}
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 1px 3px rgba(0,0,0,.07)' }}>
            {!eoq ? (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', flexDirection: 'column', gap: 12 }}>
                <Calculator size={40} style={{ opacity: 0.3 }} />
                <p style={{ margin: 0, fontSize: 13 }}>Select an item and click Calculate EOQ</p>
              </div>
            ) : (
              <>
                <h3 style={{ margin: '0 0 20px', fontSize: 15, fontWeight: 700 }}>{eoq.item_name}</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
                  {[
                    { label: 'Annual Demand', value: `${eoq.annual_demand?.toFixed(0)} units` },
                    { label: 'EOQ (Optimal Order Qty)', value: `${eoq.eoq?.toFixed(0)} units`, highlight: true },
                    { label: 'Reorder Point', value: `${eoq.reorder_point?.toFixed(0)} units` },
                    { label: 'Unit Cost', value: fmt(eoq.unit_cost) },
                    { label: 'Annual Ordering Cost', value: fmt(eoq.annual_ordering_cost) },
                    { label: 'Annual Holding Cost', value: fmt(eoq.annual_holding_cost) },
                  ].map(({ label, value, highlight }) => (
                    <div key={label} style={{ background: highlight ? '#f5f3ff' : '#f9fafb', borderRadius: 10, padding: '14px 16px', border: highlight ? '1.5px solid #6B3FDB' : '1px solid #f0f0f4' }}>
                      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>{label}</div>
                      <div style={{ fontSize: 20, fontWeight: 700, color: highlight ? '#6B3FDB' : '#111' }}>{value}</div>
                    </div>
                  ))}
                </div>
                {eoq.expected_delivery_date && (
                  <div style={{ background: '#f0fdf4', borderRadius: 8, padding: '12px 16px', fontSize: 13, color: '#166534' }}>
                    <strong>Expected delivery if ordered today:</strong> {new Date(eoq.expected_delivery_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
