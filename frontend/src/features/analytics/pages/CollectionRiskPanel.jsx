// frontend/src/features/analytics/pages/CollectionRiskPanel.jsx
// Phase 49H — Collections Center (Section 11) + Service & AMC (Section 12)
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import { IndianRupee, Clock, AlertTriangle, CheckCircle, FileText, Activity } from 'lucide-react';

const fmtL = (n) => {
  const v = parseFloat(n || 0);
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(1)} L`;
  if (v >= 1e3) return `₹${(v / 1e3).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};
const fmtPct = n => `${parseFloat(n || 0).toFixed(1)}%`;
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

const C = {
  primary: '#6B3FDB', green: '#16a34a', red: '#dc2626',
  amber: '#d97706', blue: '#2563eb', border: '#e9e4ff', cyan: '#0891b2',
};

const BUCKET_CFG = [
  { key: 'bucket_0_30',  label: '0–30 Days',  color: C.amber },
  { key: 'bucket_31_60', label: '31–60 Days', color: '#f97316' },
  { key: 'bucket_61_90', label: '61–90 Days', color: C.red },
  { key: 'bucket_90plus',label: '90+ Days',   color: '#7f1d1d' },
];

const RISK_CFG = {
  Critical: { bg: '#fee2e2', color: C.red, border: '#fca5a5' },
  High:     { bg: '#fef3c7', color: '#92400e', border: '#fcd34d' },
  Medium:   { bg: '#fef9c3', color: '#78350f', border: '#fde68a' },
  Low:      { bg: '#dcfce7', color: C.green, border: '#86efac' },
};

function KpiCard({ label, value, sub, color, icon: Icon, warn }) {
  const activeColor = warn ? C.red : (color || C.primary);
  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: '16px 18px', borderLeft: `4px solid ${activeColor}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
        {Icon && <div style={{ width: 30, height: 30, borderRadius: 8, background: `${activeColor}18`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon size={15} color={activeColor} /></div>}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: activeColor, marginTop: 6 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

export default function CollectionRiskPanel({ data, serviceData }) {
  const summary  = data?.summary  || {};
  const aging    = data?.aging    || [];
  const amc      = serviceData?.amc     || {};
  const tickets  = serviceData?.tickets || {};
  const expiring = serviceData?.expiring_contracts || [];

  // Aging bar chart
  const agingChartData = BUCKET_CFG.map(b => ({
    bucket: b.label,
    value: parseFloat(summary[b.key] || 0),
    color: b.color,
  }));

  // Top defaulters
  const topDefaulters = [...aging]
    .sort((a, b) => b.total_outstanding - a.total_outstanding)
    .slice(0, 10);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>

      {/* ── COLLECTIONS CENTER ── */}
      <div>
        <div style={{ fontSize: 18, fontWeight: 800, color: '#111827', marginBottom: 16 }}>Collections Center</div>

        {/* Aging Buckets KPIs */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 20 }}>
          <KpiCard label="Total Outstanding" value={fmtL(summary.total_outstanding)} color={C.primary} icon={IndianRupee} warn={summary.total_outstanding > 0} />
          {BUCKET_CFG.map(b => (
            <KpiCard key={b.key} label={b.label} value={fmtL(summary[b.key])} color={b.color} />
          ))}
        </div>

        {/* Aging chart + table */}
        <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16 }}>
          <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: '18px 20px' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Aging Distribution</div>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={agingChartData} layout="vertical" barSize={22}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" horizontal={false} />
                <XAxis type="number" tickFormatter={v => fmtL(v)} tick={{ fontSize: 10 }} />
                <YAxis type="category" dataKey="bucket" tick={{ fontSize: 12 }} width={75} />
                <Tooltip formatter={v => fmtL(v)} />
                <Bar dataKey="value" radius={[0, 6, 6, 0]}>
                  {agingChartData.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Top Defaulters Table */}
          <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden' }}>
            <div style={{ padding: '14px 18px', borderBottom: `1px solid #f3f4f6`, fontSize: 13, fontWeight: 700, color: '#374151' }}>
              Top Defaulters — Sorted by Outstanding
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    {['Customer', 'Outstanding', '0–30', '31–60', '61–90', '90+', 'Max OD Days', 'Risk'].map(h => (
                      <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#6b7280', fontSize: 11, textTransform: 'uppercase' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {topDefaulters.map((r, i) => {
                    const riskCfg = RISK_CFG[r.risk] || RISK_CFG.Low;
                    return (
                      <tr key={r.customer_id} style={{ borderBottom: '1px solid #f3f4f6', background: r.risk === 'Critical' ? '#fff8f8' : i % 2 === 0 ? '#fff' : '#fafafa' }}>
                        <td style={{ padding: '8px 12px', fontWeight: 700, color: '#111827' }}>{r.customer}</td>
                        <td style={{ padding: '8px 12px', fontWeight: 700, color: C.red }}>{fmtL(r.total_outstanding)}</td>
                        <td style={{ padding: '8px 12px', color: r.bucket_0_30 > 0 ? C.amber : '#9ca3af' }}>{fmtL(r.bucket_0_30)}</td>
                        <td style={{ padding: '8px 12px', color: r.bucket_31_60 > 0 ? '#f97316' : '#9ca3af' }}>{fmtL(r.bucket_31_60)}</td>
                        <td style={{ padding: '8px 12px', color: r.bucket_61_90 > 0 ? C.red : '#9ca3af' }}>{fmtL(r.bucket_61_90)}</td>
                        <td style={{ padding: '8px 12px', color: r.bucket_90plus > 0 ? '#7f1d1d' : '#9ca3af', fontWeight: r.bucket_90plus > 0 ? 700 : 400 }}>{fmtL(r.bucket_90plus)}</td>
                        <td style={{ padding: '8px 12px', color: r.max_overdue_days > 60 ? C.red : '#374151' }}>{r.max_overdue_days}d</td>
                        <td style={{ padding: '8px 12px' }}>
                          <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: riskCfg.bg, color: riskCfg.color, border: `1px solid ${riskCfg.border}` }}>
                            {r.risk}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {topDefaulters.length === 0 && (
                    <tr><td colSpan={8} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>No outstanding collections</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* ── SERVICE & AMC CENTER ── */}
      <div>
        <div style={{ fontSize: 18, fontWeight: 800, color: '#111827', marginBottom: 16 }}>Service & AMC Center</div>

        {/* AMC KPIs */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12, marginBottom: 20 }}>
          <KpiCard label="Open Tickets" value={tickets.open || 0} color={C.blue} icon={FileText} warn={tickets.open > 10} />
          <KpiCard label="Escalations" value={tickets.escalations || 0} color={C.red} icon={AlertTriangle} warn={tickets.escalations > 0} />
          <KpiCard label="Active AMC" value={amc.active_count || 0} color={C.green} icon={CheckCircle} />
          <KpiCard label="Expiring (90d)" value={amc.expiring_90_days || 0} color={C.amber} icon={Clock} warn={amc.expiring_90_days > 0} />
          <KpiCard label="AMC Revenue" value={fmtL(amc.annual_revenue)} color={C.primary} icon={IndianRupee} sub="Annual" />
          <KpiCard label="Renewal Forecast" value={fmtL(amc.renewal_forecast)} color={C.cyan} icon={Activity} sub="Next 90 days" />
        </div>

        {/* Expiring Contracts */}
        {expiring.length > 0 && (
          <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden' }}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>AMC Contracts Expiring in 90 Days</span>
              <span style={{ fontSize: 12, color: C.amber, fontWeight: 600 }}>Renewal action required</span>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['Customer', 'Contract #', 'Expiry Date', 'Days Left', 'Annual Value'].map(h => (
                    <th key={h} style={{ padding: '8px 14px', textAlign: 'left', fontWeight: 600, color: '#6b7280', fontSize: 11, textTransform: 'uppercase' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {expiring.map((c, i) => {
                  const urgentColor = c.days_to_expiry <= 30 ? C.red : c.days_to_expiry <= 60 ? C.amber : C.amber;
                  return (
                    <tr key={c.id} style={{ borderBottom: '1px solid #f3f4f6', background: c.days_to_expiry <= 30 ? '#fff8f8' : '#fff' }}>
                      <td style={{ padding: '9px 14px', fontWeight: 700, color: '#111827' }}>{c.customer_name}</td>
                      <td style={{ padding: '9px 14px', color: '#374151', fontFamily: 'monospace' }}>{c.contract_number}</td>
                      <td style={{ padding: '9px 14px', color: '#374151' }}>{fmtDate(c.end_date)}</td>
                      <td style={{ padding: '9px 14px' }}>
                        <span style={{ fontWeight: 700, color: urgentColor, padding: '2px 8px', background: `${urgentColor}15`, borderRadius: 6 }}>
                          {c.days_to_expiry}d
                        </span>
                      </td>
                      <td style={{ padding: '9px 14px', fontWeight: 700, color: C.primary }}>{fmtL(c.annual_value)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
