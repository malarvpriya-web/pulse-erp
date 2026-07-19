import { useState, useEffect } from 'react';
import { Clock, AlertTriangle, RefreshCw } from 'lucide-react';
import api from '@/services/api/client';

export default function OrderPolicy() {
  const [stages, setStages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = () => {
    setLoading(true);
    setError(null);
    api.get('/admin/order-policy')
      .then(r => setStages(Array.isArray(r.data) ? r.data : []))
      .catch(() => setError('Could not load order policy.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const totalDays = stages.reduce((s, st) => s + (st.sla_days || 0), 0);

  return (
    <div style={{ padding: 24 }}>
      <div className="page-header" style={{ marginBottom: 24 }}>
        <h1 className="page-title">Order to Delivery Cycle</h1>
        <p className="page-subtitle">
          Manifest Technologies — standard {totalDays}-day manufacturing and delivery workflow
        </p>
      </div>

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#9ca3af', padding: 40 }}>
          <RefreshCw size={16} style={{ animation: 'spin 0.9s linear infinite' }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          Loading…
        </div>
      )}

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '12px 16px', color: '#dc2626', display: 'flex', gap: 8, alignItems: 'center' }}>
          <AlertTriangle size={16} /> {error}
          <button onClick={load} style={{ marginLeft: 8, fontSize: 12, color: '#dc2626', background: 'none', border: '1px solid #fecaca', borderRadius: 6, padding: '2px 10px', cursor: 'pointer' }}>
            Retry
          </button>
        </div>
      )}

      {!loading && !error && stages.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,.08)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb', width: 40 }}>#</th>
                <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Stage</th>
                <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Description</th>
                <th style={{ padding: '10px 16px', textAlign: 'center', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>SLA Days</th>
                <th style={{ padding: '10px 16px', textAlign: 'center', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Escalate After</th>
              </tr>
            </thead>
            <tbody>
              {stages.map((st, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '10px 16px', color: '#9ca3af', fontWeight: 600 }}>{st.sort_order}</td>
                  <td style={{ padding: '10px 16px', fontWeight: 600, color: '#111827' }}>{st.stage}</td>
                  <td style={{ padding: '10px 16px', color: '#6b7280' }}>{st.description}</td>
                  <td style={{ padding: '10px 16px', textAlign: 'center' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#f0f9ff', color: '#0369a1', padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600 }}>
                      <Clock size={11} />{st.sla_days}d
                    </span>
                  </td>
                  <td style={{ padding: '10px 16px', textAlign: 'center' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#fff7ed', color: '#c2410c', padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600 }}>
                      <AlertTriangle size={11} />{st.escalate_after_days}d
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: '#f9fafb', borderTop: '2px solid #e5e7eb' }}>
                <td colSpan={3} style={{ padding: '10px 16px', fontWeight: 700, color: '#111827' }}>Total Order-to-Delivery Cycle</td>
                <td style={{ padding: '10px 16px', textAlign: 'center', fontWeight: 700, color: '#0369a1' }}>{totalDays} days</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
