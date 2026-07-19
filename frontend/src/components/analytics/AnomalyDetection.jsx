// frontend/src/components/analytics/AnomalyDetection.jsx
import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api/client';

function formatINR(n) {
  const num = parseFloat(n);
  if (isNaN(num) || num === 0) return null;
  if (num >= 100000) return `₹${(num/100000).toFixed(2)}L`;
  return `₹${Math.round(num).toLocaleString('en-IN')}`;
}


const TYPE_ICONS = {
  'Invoice Amount Outlier': '🧾',
  'Low Attendance':         '📅',
  'PO Price Variance':      '📦',
  'TDS Mismatch':           '💰',
};

const MODULE_MAP = {
  'Invoice Amount Outlier': 'Finance',
  'Low Attendance':         'Attendance',
  'PO Price Variance':      'Procurement',
  'TDS Mismatch':           'Payroll',
};

const SEV_STYLE = {
  high:   { bg:'#fee2e2', color:'#dc2626', label:'High',   dot:'#dc2626' },
  medium: { bg:'#fef3c7', color:'#d97706', label:'Medium', dot:'#d97706' },
  low:    { bg:'#d1fae5', color:'#16a34a', label:'Low',    dot:'#16a34a' },
};

export default function AnomalyDetection({ setPage }) {
  const [anomalies, setAnomalies] = useState([]);
  const [loading, setLoading]     = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [filter, setFilter]       = useState('all');

  const controllerRef = useRef(null);

  const load = useCallback(async () => {
    controllerRef.current?.abort();
    controllerRef.current = new AbortController();
    const { signal } = controllerRef.current;
    setLoading(true);
    try {
      const res = await api.get('/ai/anomalies', { signal });
      if (signal.aborted) return;
      const data = res.data?.data || res.data;
      setAnomalies(Array.isArray(data) ? data : []);
    } catch (err) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
      setAnomalies([]);
    } finally {
      if (!signal.aborted) {
        setLoading(false);
        setLastRefresh(new Date());
      }
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 5 * 60 * 1000); // refresh every 5 min
    return () => {
      clearInterval(interval);
      controllerRef.current?.abort();
    };
  }, [load]);

  const counts = {
    high:   anomalies.filter(a => a.severity === 'high').length,
    medium: anomalies.filter(a => a.severity === 'medium').length,
    low:    anomalies.filter(a => a.severity === 'low').length,
  };

  const filtered = filter === 'all' ? anomalies : anomalies.filter(a => a.severity === filter);

  return (
    <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:12, padding:20 }}>
      {/* header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
        <div>
          <h3 style={{ margin:0, color:'#4c1d95', fontSize:16 }}>🔍 Anomaly Detection</h3>
          {lastRefresh && <p style={{ margin:'2px 0 0', fontSize:11, color:'#9ca3af' }}>Last scan: {lastRefresh.toLocaleTimeString('en-IN')}</p>}
        </div>
        <button onClick={load} disabled={loading}
          style={{ background:'#ede9fe', color:'#7c3aed', border:'none', borderRadius:7, padding:'5px 12px', cursor:'pointer', fontWeight:600, fontSize:12 }}>
          {loading ? '⟳' : '↻ Refresh'}
        </button>
      </div>

      {/* severity counters */}
      <div style={{ display:'flex', gap:8, marginBottom:14 }}>
        {[['all','All',anomalies.length,'#7c3aed'],['high','Critical',counts.high,'#dc2626'],['medium','Warning',counts.medium,'#d97706'],['low','Info',counts.low,'#16a34a']].map(([k,l,n,c]) => (
          <button key={k} onClick={() => setFilter(k)}
            style={{ flex:1, padding:'7px 4px', borderRadius:8, border:`1.5px solid ${filter===k ? c : '#e9e4ff'}`, background: filter===k ? `${c}15` : '#fff', cursor:'pointer', textAlign:'center' }}>
            <div style={{ fontSize:18, fontWeight:700, color:c }}>{n}</div>
            <div style={{ fontSize:10, color:'#6b7280', fontWeight:600 }}>{l}</div>
          </button>
        ))}
      </div>

      {/* anomaly list */}
      <div style={{ maxHeight:320, overflowY:'auto', display:'flex', flexDirection:'column', gap:8 }}>
        {loading && (
          <div style={{ textAlign:'center', padding:30, color:'#7c3aed' }}>Scanning for anomalies…</div>
        )}
        {!loading && filtered.length === 0 && (
          <div style={{ textAlign:'center', padding:30, color:'#6b7280', fontSize:13 }}>
            ✅ No anomalies detected in this category.
          </div>
        )}
        {!loading && filtered.map((a, i) => {
          const sev = SEV_STYLE[a.severity] || SEV_STYLE.low;
          const amtStr = formatINR(a.variance_amount);
          return (
            <div key={i} style={{ display:'flex', gap:12, padding:'12px 14px', background:'#fafafa', borderRadius:10, border:`1px solid ${sev.bg}`, borderLeft:`4px solid ${sev.dot}` }}>
              <div style={{ fontSize:22, flexShrink:0, marginTop:2 }}>{TYPE_ICONS[a.type] || '⚠️'}</div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
                  <span style={{ fontSize:11, fontWeight:700, color:sev.color, background:sev.bg, padding:'1px 7px', borderRadius:10 }}>{sev.label}</span>
                  <span style={{ fontSize:12, fontWeight:600, color:'#374151' }}>{a.type}</span>
                </div>
                <p style={{ margin:'0 0 4px', fontSize:12, color:'#6b7280', lineHeight:1.4 }}>{a.description}</p>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                  <span style={{ fontSize:11, color:'#9ca3af' }}>
                    {a.affected_name}
                    {amtStr && <> · <strong style={{ color:'#dc2626' }}>{amtStr}</strong> variance</>}
                  </span>
                  {setPage && (
                    <button onClick={() => setPage(MODULE_MAP[a.type] || 'Finance')}
                      style={{ background:'#ede9fe', color:'#7c3aed', border:'none', borderRadius:6, padding:'3px 10px', cursor:'pointer', fontSize:11, fontWeight:600 }}>
                      Investigate →
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {anomalies.length > 0 && (
        <p style={{ margin:'10px 0 0', fontSize:11, color:'#9ca3af', textAlign:'center' }}>
          Auto-refreshes every 5 minutes · {anomalies.length} total anomalies found
        </p>
      )}
    </div>
  );
}
