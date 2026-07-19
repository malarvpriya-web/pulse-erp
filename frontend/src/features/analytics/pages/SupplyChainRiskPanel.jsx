// frontend/src/features/analytics/pages/SupplyChainRiskPanel.jsx
// Phase 49H — Supply Chain Exposure (Section 8)
// Single-source suppliers, critical components, long-lead vendors, revenue at risk
import { AlertTriangle, Package, Zap, Clock, ShieldOff } from 'lucide-react';

const fmtL = (n) => {
  const v = parseFloat(n || 0);
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(1)} L`;
  if (v >= 1e3) return `₹${(v / 1e3).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};

const C = {
  primary: '#6B3FDB', green: '#16a34a', red: '#dc2626',
  amber: '#d97706', blue: '#2563eb', border: '#e9e4ff',
};

// Static critical component exposures for power electronics (Manifest specifics)
const CRITICAL_COMPONENTS = [
  { component: 'IGBT Modules',        risk: 'Critical', lead_days: 120, vendors: 1, impact: 'HVDC, STATCOM projects halted without IGBT supply' },
  { component: 'Power Transformers',  risk: 'High',     lead_days: 90,  vendors: 2, impact: 'SST and HVDC converter projects at risk' },
  { component: 'DC Capacitors',       risk: 'High',     lead_days: 60,  vendors: 2, impact: 'Converter assembly and energy storage systems' },
  { component: 'DSP Controllers',     risk: 'Critical', lead_days: 90,  vendors: 1, impact: 'All automation and control system builds' },
  { component: 'Semiconductors',      risk: 'High',     lead_days: 75,  vendors: 3, impact: 'PCB assemblies across all product lines' },
  { component: 'Gate Drive Boards',   risk: 'Medium',   lead_days: 45,  vendors: 2, impact: 'STATCOM and inverter assemblies' },
  { component: 'Current Sensors',     risk: 'Medium',   lead_days: 30,  vendors: 3, impact: 'Protection systems and metering assemblies' },
  { component: 'HV Cables & Bus Bars',risk: 'Medium',   lead_days: 45,  vendors: 4, impact: 'HVDC transmission line terminations' },
];

const RISK_BADGE = {
  Critical: { bg: '#fee2e2', color: '#dc2626', border: '#fca5a5' },
  High:     { bg: '#fef3c7', color: '#92400e', border: '#fcd34d' },
  Medium:   { bg: '#fef9c3', color: '#78350f', border: '#fde68a' },
  Low:      { bg: '#dcfce7', color: '#15803d', border: '#86efac' },
};

function ExposureCard({ title, count, value, color, icon: Icon, sub }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: '18px 20px', borderLeft: `4px solid ${color}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</div>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: `${color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon size={16} color={color} />
        </div>
      </div>
      <div style={{ fontSize: 26, fontWeight: 800, color, marginTop: 6 }}>{count}</div>
      {value && <div style={{ fontSize: 13, fontWeight: 700, color: C.primary }}>{value}</div>}
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

export default function SupplyChainRiskPanel({ singleSource = [], data }) {
  const allVendors = data?.all_vendors || [];
  const summary = data?.summary || {};

  const longLeadVendors = allVendors.filter(v => v.critical_items > 0);
  const singleSourceRevAtRisk = singleSource.reduce((s, v) => s + v.po_value, 0) * 1.5;
  const criticalComponents = CRITICAL_COMPONENTS.filter(c => c.risk === 'Critical' || c.risk === 'High');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <div style={{ fontSize: 18, fontWeight: 800, color: '#111827' }}>Supply Chain Exposure</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3 }}>Single-source risk, critical components, long lead-time items, revenue at risk</div>
      </div>

      {/* Exposure Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
        <ExposureCard
          title="Single Source Suppliers"
          count={singleSource.length || summary.single_source_count || '—'}
          value={fmtL(singleSourceRevAtRisk)}
          color={C.red}
          icon={ShieldOff}
          sub="Revenue at risk"
        />
        <ExposureCard
          title="Critical Components"
          count={CRITICAL_COMPONENTS.filter(c => c.risk === 'Critical').length}
          color={C.red}
          icon={Zap}
          sub="Requiring immediate attention"
        />
        <ExposureCard
          title="Long Lead Vendors"
          count={longLeadVendors.length || CRITICAL_COMPONENTS.filter(c => c.lead_days >= 60).length}
          color={C.amber}
          icon={Clock}
          sub="Lead time ≥ 60 days"
        />
        <ExposureCard
          title="Blocked Vendors"
          count={summary.blocked_count || 0}
          color={summary.blocked_count > 0 ? C.red : C.green}
          icon={AlertTriangle}
          sub="Require immediate alternate sourcing"
        />
      </div>

      {/* Single Source Vendors */}
      {singleSource.length > 0 && (
        <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden' }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 8 }}>
            <ShieldOff size={14} color={C.red} />
            <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>Single-Source Suppliers — Highest Risk</span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Vendor', 'Type', 'Spend', 'Open POs', 'NCRs', 'OTD %', 'Status'].map(h => (
                  <th key={h} style={{ padding: '8px 14px', textAlign: 'left', fontWeight: 600, color: '#6b7280', fontSize: 11, textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {singleSource.map((v, i) => (
                <tr key={v.id} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 === 0 ? '#fff8f8' : '#fff5f5' }}>
                  <td style={{ padding: '9px 14px', fontWeight: 700, color: '#111827' }}>
                    {v.name}
                    <span style={{ marginLeft: 6, fontSize: 10, background: '#fee2e2', color: '#991b1b', padding: '1px 5px', borderRadius: 4, fontWeight: 600 }}>SINGLE SOURCE</span>
                  </td>
                  <td style={{ padding: '9px 14px', color: '#6b7280' }}>{v.vendor_type || '—'}</td>
                  <td style={{ padding: '9px 14px', fontWeight: 700, color: C.primary }}>{fmtL(v.po_value)}</td>
                  <td style={{ padding: '9px 14px', textAlign: 'center', color: v.open_pos > 0 ? C.amber : '#6b7280' }}>{v.open_pos}</td>
                  <td style={{ padding: '9px 14px', textAlign: 'center', color: v.open_ncrs > 0 ? C.red : '#6b7280', fontWeight: v.open_ncrs > 0 ? 700 : 400 }}>{v.open_ncrs}</td>
                  <td style={{ padding: '9px 14px', color: v.on_time_delivery_pct < 80 ? C.red : C.green, fontWeight: 600 }}>
                    {v.on_time_delivery_pct != null ? `${v.on_time_delivery_pct}%` : '—'}
                  </td>
                  <td style={{ padding: '9px 14px' }}>
                    <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: `${v.health_color}18`, color: v.health_color }}>
                      {v.health_label}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Critical Components Matrix */}
      <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Zap size={14} color={C.amber} />
          <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>Critical Component Risk Matrix</span>
          <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 'auto' }}>Power electronics industry — strategic components</span>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              {['Component', 'Risk', 'Lead Time', 'Source Count', 'Business Impact'].map(h => (
                <th key={h} style={{ padding: '8px 14px', textAlign: 'left', fontWeight: 600, color: '#6b7280', fontSize: 11, textTransform: 'uppercase' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CRITICAL_COMPONENTS.map((comp, i) => {
              const cfg = RISK_BADGE[comp.risk] || RISK_BADGE.Low;
              return (
                <tr key={i} style={{ borderBottom: '1px solid #f3f4f6', background: comp.risk === 'Critical' ? '#fff8f8' : '#fff' }}>
                  <td style={{ padding: '9px 14px', fontWeight: 700, color: '#111827' }}>{comp.component}</td>
                  <td style={{ padding: '9px 14px' }}>
                    <span style={{ padding: '2px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}` }}>
                      {comp.risk}
                    </span>
                  </td>
                  <td style={{ padding: '9px 14px', color: comp.lead_days >= 90 ? C.red : comp.lead_days >= 60 ? C.amber : '#374151', fontWeight: comp.lead_days >= 60 ? 700 : 400 }}>
                    {comp.lead_days} days
                  </td>
                  <td style={{ padding: '9px 14px', textAlign: 'center', color: comp.vendors === 1 ? C.red : comp.vendors === 2 ? C.amber : C.green, fontWeight: 700 }}>
                    {comp.vendors}
                  </td>
                  <td style={{ padding: '9px 14px', color: '#6b7280', fontSize: 11 }}>{comp.impact}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Action Recommendations */}
      <div style={{ background: '#fffbeb', border: `1px solid #fcd34d`, borderRadius: 14, padding: '16px 20px' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#92400e', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
          <AlertTriangle size={14} />
          Supply Chain Risk Mitigation Actions
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {[
            'Qualify alternate IGBT suppliers immediately — current single-source is highest supply chain risk',
            'Maintain 90-day safety stock for IGBTs, DSP controllers, and power transformers',
            'Issue advance purchase orders 90+ days before project start for long lead components',
            'Negotiate SLAs with critical vendors — include penalty clauses for late delivery',
            'Perform quarterly vendor audits for all Critical/Single-Source vendors',
            'Develop dual-source qualification plans for all Critical-rated components by next quarter',
          ].map((a, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: '#78350f' }}>
              <span style={{ color: C.amber, flexShrink: 0, fontWeight: 800, marginTop: 1 }}>•</span>
              {a}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
