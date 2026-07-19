import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { getVendorPriceComparison } from '../services/inventoryService';
import '@/components/dashboard/dashkit.css';

const fmtVal = n => {
  const v = parseFloat(n) || 0;
  if (v >= 1_00_000) return `₹${(v / 1_00_000).toFixed(2)} L`;
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};

const fmtMoney = n => {
  const v = parseFloat(n);
  return isNaN(v) ? '—' : '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
};

const TodayCard = ({ label, value, color = '#374151', index = 0 }) => (
  <div className="dk-anim" style={{
    background: '#fff', borderRadius: 10, padding: '11px 15px',
    boxShadow: '0 1px 4px rgba(0,0,0,.07)', border: '1px solid #f0f0f4',
    display: 'flex', flexDirection: 'column', gap: 2, '--dk-i': index,
  }}>
    <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 500 }}>{label}</div>
    <div style={{ fontSize: 21, fontWeight: 700, color }}>{value}</div>
  </div>
);

export default function StoresDashboard({ setPage }) {
  const [data, setData]       = useState({ warehouses: [], today: {} });
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [pricing, setPricing] = useState(null);

  useEffect(() => {
    const fetchStores = async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await api.get('/inventory/stores-dashboard');
        setData(res.data?.data ?? { warehouses: [], today: {} });
      } catch {
        setError('Failed to load stores data');
      } finally {
        setLoading(false);
      }
    };
    fetchStores();
    getVendorPriceComparison().then(setPricing).catch(() => {});
  }, []);

  const warehouses = data.warehouses ?? [];
  const today      = data.today      ?? {};

  return (
    <div style={{ padding: '16px 18px 20px' }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 3 }}>Stores Dashboard</h1>
      <p style={{ color: '#6b7280', fontSize: 12.5, marginBottom: 14 }}>
        Stock summary per warehouse — {warehouses.reduce((s, w) => s + (w.total_skus || 0), 0)} total SKUs across {warehouses.length} stores
      </p>

      {loading && (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading...</div>
      )}

      {!loading && error && (
        <div style={{
          background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10,
          padding: 20, color: '#dc2626', fontSize: 14, textAlign: 'center',
        }}>
          {error}
        </div>
      )}

      {!loading && !error && (
        <>
          {/* Today's activity summary */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 7 }}>
              Today's Activity
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(155px, 1fr))', gap: 10 }}>
              <TodayCard label="Receipts"    value={today.receipts_count    ?? 0} color="#0891b2" index={0} />
              <TodayCard label="Issues"      value={today.issues_count      ?? 0} color="#6B3FDB" index={1} />
              <TodayCard label="Adjustments" value={today.adjustments_count ?? 0} color="#d97706" index={2} />
              <TodayCard label="Pending QC"  value={today.pending_qc_count  ?? 0} color="#dc2626" index={3} />
            </div>
          </div>

          {/* Vendor pricing & savings across stores */}
          {pricing?.summary && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 7 }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Vendor Pricing &amp; Savings
                </div>
                {setPage && (
                  <button
                    onClick={() => setPage('VendorPriceComparison')}
                    style={{ background: 'none', border: 'none', color: '#6B3FDB', fontWeight: 600, fontSize: 12.5, cursor: 'pointer', padding: 0 }}
                  >
                    Compare all →
                  </button>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(155px, 1fr))', gap: 10, marginBottom: 10 }}>
                <TodayCard label="Priced Components" value={`${pricing.summary.priced_components ?? 0} / ${pricing.summary.total_components ?? 0}`} color="#4c1d95" index={0} />
                <TodayCard label="Multi-Vendor Items" value={pricing.summary.multi_vendor_components ?? 0} color="#0891b2" index={1} />
                <TodayCard label="Potential Savings" value={fmtVal(pricing.summary.total_potential_savings)} color="#16a34a" index={2} />
                <TodayCard label="Avg Price Spread" value={`${pricing.summary.avg_spread_pct ?? 0}%`} color="#d97706" index={3} />
              </div>

              {(() => {
                const opps = (pricing.items || [])
                  .filter(i => (i.savings_vs_preferred || 0) > 0)
                  .sort((a, b) => (b.savings_vs_preferred || 0) - (a.savings_vs_preferred || 0))
                  .slice(0, 5);
                if (opps.length === 0) return null;
                return (
                  <div style={{ background: '#fff', borderRadius: 11, boxShadow: '0 1px 4px rgba(0,0,0,.08)', border: '1px solid #f0f0f4', overflow: 'hidden' }}>
                    <div style={{ padding: '9px 14px', fontSize: 12.5, fontWeight: 700, color: '#1f2937', borderBottom: '1px solid #f3f4f6' }}>
                      Top Savings Opportunities <span style={{ fontWeight: 400, color: '#9ca3af' }}>— switch preferred vendor to cheapest quote</span>
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                        <thead>
                          <tr style={{ background: '#f9fafb', color: '#374151' }}>
                            {['Component', 'Category', 'Best Vendor', 'Best Price', 'Preferred', 'Savings'].map((k, i) => (
                              <th key={k} style={{ padding: '8px 14px', textAlign: i >= 3 ? 'right' : 'left', fontWeight: 600, whiteSpace: 'nowrap' }}>{k}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {opps.map(o => (
                            <tr key={o.item_id} style={{ borderTop: '1px solid #f3f4f6' }}>
                              <td style={{ padding: '8px 14px', whiteSpace: 'nowrap' }}>{o.item_name}</td>
                              <td style={{ padding: '8px 14px', color: '#6b7280', whiteSpace: 'nowrap' }}>{o.category_name || '—'}</td>
                              <td style={{ padding: '8px 14px', whiteSpace: 'nowrap' }}>{o.best_vendor || '—'}</td>
                              <td style={{ padding: '8px 14px', textAlign: 'right', fontWeight: 700, color: '#15803d' }}>{fmtMoney(o.best_price)}</td>
                              <td style={{ padding: '8px 14px', textAlign: 'right', color: '#6b7280' }}>{fmtMoney(o.preferred_price)}</td>
                              <td style={{ padding: '8px 14px', textAlign: 'right', fontWeight: 700, color: '#16a34a' }}>{fmtMoney(o.savings_vs_preferred)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {warehouses.length === 0 ? (
            <div style={{
              background: '#fff', borderRadius: 12, padding: 40,
              textAlign: 'center', color: '#9ca3af',
              boxShadow: '0 1px 4px rgba(0,0,0,.08)',
            }}>
              No warehouse data available.
            </div>
          ) : (
            <>
              {/* Per-warehouse cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(255px, 1fr))', gap: 10, marginBottom: 14 }}>
                {warehouses.map((wh, i) => (
                  <div key={wh.id} className="dk-anim" style={{
                    background: '#fff', borderRadius: 11, padding: 13,
                    boxShadow: '0 1px 4px rgba(0,0,0,.08)', border: '1px solid #f0f0f4',
                    '--dk-i': i + 4,
                  }}>
                    <div style={{ fontWeight: 700, fontSize: 14.5, color: '#1f2937', marginBottom: 1 }}>{wh.name}</div>
                    {wh.code && (
                      <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 8 }}>{wh.code}</div>
                    )}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      <div>
                        <div style={{ fontSize: 11, color: '#6b7280' }}>Total SKUs</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: '#4c1d95' }}>{wh.total_skus}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 11, color: '#6b7280' }}>Stock Value</div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: '#0891b2' }}>{fmtVal(wh.total_value)}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 11, color: '#6b7280' }}>Low Stock</div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: wh.low_stock_count > 0 ? '#d97706' : '#16a34a' }}>
                          {wh.low_stock_count}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 11, color: '#6b7280' }}>Out of Stock</div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: wh.out_of_stock_count > 0 ? '#dc2626' : '#16a34a' }}>
                          {wh.out_of_stock_count}
                        </div>
                      </div>
                    </div>
                    {wh.last_activity_at && (
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 8 }}>
                        Last activity: {new Date(wh.last_activity_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Summary table */}
              <div style={{ background: '#fff', borderRadius: 11, boxShadow: '0 1px 4px rgba(0,0,0,.08)', overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto', maxHeight: '45vh', overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr>
                        {['Warehouse', 'Code', 'SKUs', 'Stock Value', 'Low Stock', 'Out of Stock'].map(k => (
                          <th key={k} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb', position: 'sticky', top: 0, background: '#f9fafb', zIndex: 1 }}>{k}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {warehouses.map((wh, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                          <td style={{ padding: '9px 14px', fontWeight: 600 }}>{wh.name}</td>
                          <td style={{ padding: '9px 14px', color: '#6b7280' }}>{wh.code || '—'}</td>
                          <td style={{ padding: '9px 14px' }}>{wh.total_skus}</td>
                          <td style={{ padding: '9px 14px', fontWeight: 600, color: '#0891b2' }}>{fmtVal(wh.total_value)}</td>
                          <td style={{ padding: '9px 14px', color: wh.low_stock_count > 0 ? '#d97706' : '#6b7280', fontWeight: wh.low_stock_count > 0 ? 700 : 400 }}>{wh.low_stock_count}</td>
                          <td style={{ padding: '9px 14px', color: wh.out_of_stock_count > 0 ? '#dc2626' : '#6b7280', fontWeight: wh.out_of_stock_count > 0 ? 700 : 400 }}>{wh.out_of_stock_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
