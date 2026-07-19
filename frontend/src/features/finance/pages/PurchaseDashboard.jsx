import { useState, useEffect, useCallback } from 'react';
import { ShoppingCart, AlertTriangle, Clock, CheckCircle, FileText } from 'lucide-react';
import api from '@/services/api/client';
import { useFY } from '@/context/FYContext';
import '@/components/dashboard/dashkit.css';

const fmt = (n) => '₹' + (+n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

const STATUS_STYLE = {
  draft:    { background: '#f3f4f6', color: '#6b7280' },
  pending:  { background: '#fef3c7', color: '#d97706' },
  approved: { background: '#dbeafe', color: '#2563eb' },
  overdue:  { background: '#fee2e2', color: '#dc2626' },
  paid:     { background: '#dcfce7', color: '#16a34a' },
};

export default function PurchaseDashboard() {
  const { availableFYs } = useFY();
  const [kpis, setKpis]       = useState(null);
  const [bills, setBills]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);
  const [fyFilter, setFyFilter] = useState('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { data } = await api.get('/finance/purchase-dashboard/payable');
      setKpis({
        total_payable:  data.total_payable  ?? 0,
        overdue:        data.overdue        ?? 0,
        due_in_30_days: data.due_in_30_days ?? 0,
      });
      setBills(Array.isArray(data.bills) ? data.bills : []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const fyRange = availableFYs.find(f => f.fy === fyFilter) || null;
  const visibleBills = fyRange
    ? bills.filter(b => {
        const d = (b.bill_date || b.created_at || '').slice(0, 10);
        return d && d >= fyRange.startStr && d <= fyRange.endStr;
      })
    : bills;

  const kpiCards = kpis ? [
    { label: 'Total Payable',   value: fmt(kpis.total_payable),  icon: <ShoppingCart size={20} />, color: '#6366f1', bg: '#eef2ff' },
    { label: 'Overdue',         value: fmt(kpis.overdue),         icon: <AlertTriangle size={20} />, color: '#dc2626', bg: '#fef2f2' },
    { label: 'Due in 30 Days',  value: fmt(kpis.due_in_30_days),  icon: <Clock size={20} />,        color: '#d97706', bg: '#fffbeb' },
  ] : [];

  return (
    <div style={{ padding: '16px 18px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Purchase Dashboard</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select
            value={fyFilter}
            onChange={e => setFyFilter(e.target.value)}
            title="Filter pending bills by Financial Year"
            style={{ padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, background: '#fff', cursor: 'pointer' }}
          >
            <option value="all">All Financial Years</option>
            {availableFYs.map(f => <option key={f.fy} value={f.fy}>{f.label}</option>)}
          </select>
          <button
            onClick={load}
            disabled={loading}
            style={{ padding: '8px 16px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1 }}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {loading && (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af', fontSize: 14 }}>Loading purchase data…</div>
      )}

      {!loading && error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '16px 20px', color: '#dc2626', marginBottom: 20 }}>
          Could not load purchase data. Please try again.
        </div>
      )}

      {!loading && !error && (
        <>
          {/* KPI Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, marginBottom: 14 }}>
            {kpiCards.map((c, i) => (
              <div key={c.label} className="dk-anim" style={{ background: '#fff', borderRadius: 11, padding: '13px 16px', boxShadow: '0 1px 4px rgba(0,0,0,.08)', display: 'flex', gap: 12, alignItems: 'center', '--dk-i': i }}>
                <div style={{ width: 38, height: 38, borderRadius: 10, background: c.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', color: c.color, flexShrink: 0 }}>
                  {c.icon}
                </div>
                <div>
                  <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 500, marginBottom: 2 }}>{c.label}</div>
                  <div style={{ fontSize: 19, fontWeight: 700, color: '#111827' }}>{c.value}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Pending Bills Table */}
          <div className="dk-anim" style={{ background: '#fff', borderRadius: 11, boxShadow: '0 1px 4px rgba(0,0,0,.08)', overflow: 'hidden', '--dk-i': 3 }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 8 }}>
              <FileText size={16} color="#6b7280" />
              <span style={{ fontWeight: 600, fontSize: 14, color: '#374151' }}>Pending Bills</span>
              {visibleBills.length > 0 && (
                <span style={{ marginLeft: 'auto', fontSize: 12, color: '#6b7280' }}>{visibleBills.length} bill{visibleBills.length !== 1 ? 's' : ''}</span>
              )}
            </div>

            {visibleBills.length === 0 ? (
              <div style={{ padding: 48, textAlign: 'center' }}>
                <CheckCircle size={40} color="#d1d5db" style={{ margin: '0 auto 12px' }} />
                <div style={{ fontWeight: 600, color: '#374151', marginBottom: 6 }}>All bills settled</div>
                <div style={{ fontSize: 13, color: '#9ca3af' }}>No pending supplier bills at this time.</div>
              </div>
            ) : (
              <div style={{ overflowX: 'auto', maxHeight: '58vh', overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr>
                      {['Bill #', 'Vendor', 'Bill Date', 'Due Date', 'Amount', 'Status'].map(h => (
                        <th key={h} style={{ padding: '9px 16px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap', position: 'sticky', top: 0, background: '#f9fafb', zIndex: 1 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleBills.map((b, i) => {
                      const isOverdue = b.due_date && new Date(b.due_date) < new Date() && b.status !== 'paid';
                      const status = isOverdue ? 'overdue' : (b.status || 'pending');
                      const s = STATUS_STYLE[status] || STATUS_STYLE.pending;
                      return (
                        <tr key={b.id ?? i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                          <td style={{ padding: '10px 16px', fontWeight: 500, color: '#6366f1' }}>{b.bill_number || b.id || '—'}</td>
                          <td style={{ padding: '10px 16px', color: '#374151' }}>{b.vendor_name || '—'}</td>
                          <td style={{ padding: '10px 16px', color: '#6b7280' }}>{fmtDate(b.bill_date || b.created_at)}</td>
                          <td style={{ padding: '10px 16px', color: isOverdue ? '#dc2626' : '#6b7280', fontWeight: isOverdue ? 600 : 400 }}>{fmtDate(b.due_date)}</td>
                          <td style={{ padding: '10px 16px', fontWeight: 600, color: '#111827' }}>{fmt(b.amount ?? b.total_amount)}</td>
                          <td style={{ padding: '10px 16px' }}>
                            <span style={{ padding: '3px 10px', borderRadius: 99, fontSize: 11, fontWeight: 600, ...s }}>{status.charAt(0).toUpperCase() + status.slice(1)}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
