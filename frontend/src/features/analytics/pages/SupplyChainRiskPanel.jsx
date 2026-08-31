// frontend/src/features/analytics/pages/SupplyChainRiskPanel.jsx
// Phase 49H — Supply Chain Exposure (Section 8)
// Single-source, quality and delivery exposure across the live vendor base
import { AlertTriangle, Zap, Clock, ShieldOff } from 'lucide-react';

const fmtL = (n) => {
  const v = parseFloat(n || 0);
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(1)} L`;
  if (v >= 1e3) return `₹${(v / 1e3).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};

const C = {
  primary: '#6B3FDB', green: '#16a34a', red: '#dc2626',
  amber: '#6d28d9', blue: '#2563eb', border: '#e9e4ff',
};

// The mock `CRITICAL_COMPONENTS` array that used to sit here has been removed.
// It hardcoded eight parts — IGBT Modules, DSP Controllers, Power Transformers
// and so on — with invented lead times, invented vendor counts and invented
// business-impact prose, and drove two of the four KPI cards above plus a full
// table. None of it was ever read from the database, and none of it described
// this company's actual supply base. Everything on this panel now comes from
// `vendors`, `purchase_orders` and `ncr_reports` via /ceo-intelligence/vendors.

const RISK_BADGE = {
  Critical: { bg: '#fee2e2', color: '#dc2626', border: '#fca5a5' },
  High:     { bg: '#ede9fe', color: '#5b21b6', border: '#c4b5fd' },
  Medium:   { bg: '#ede9fe', color: '#4c1d95', border: '#ddd6fe' },
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

  // Spend actually committed to single-source suppliers. This used to be
  // multiplied by 1.5 and labelled "Revenue at risk" — the multiplier had no
  // basis, and PO value is spend, not revenue. Reported as what it is.
  const singleSourceSpend = singleSource.reduce((sum, v) => sum + (v.po_value || 0), 0);
  const criticalVendors   = allVendors.filter(v => v.critical_vendor);
  const vendorsWithNcrs   = allVendors.filter(v => (v.open_ncrs || 0) > 0);
  const lateVendors       = allVendors.filter(v => v.on_time_delivery_pct != null && v.on_time_delivery_pct < 80);

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
          count={singleSource.length}
          value={fmtL(singleSourceSpend)}
          color={singleSource.length > 0 ? C.red : C.green}
          icon={ShieldOff}
          sub="Committed PO value"
        />
        <ExposureCard
          title="Critical Vendors"
          count={criticalVendors.length}
          color={criticalVendors.length > 0 ? C.amber : C.green}
          icon={Zap}
          sub="Flagged critical in vendor master"
        />
        <ExposureCard
          title="Late Deliverers"
          count={lateVendors.length}
          color={lateVendors.length > 0 ? C.amber : C.green}
          icon={Clock}
          sub="On-time delivery below 80%"
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

      {/* Vendor exposure — every row is a real vendor from the vendor master. */}
      <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Zap size={14} color={C.amber} />
          <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>Vendor Exposure</span>
          <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 'auto' }}>
            Quality and delivery risk across the active vendor base
          </span>
        </div>
        {vendorsWithNcrs.length === 0 && lateVendors.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
            No vendor is carrying an open non-conformance or delivering below 80% on time.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Vendor', 'Exposure', 'Open NCRs', 'On-Time %', 'Committed Spend'].map(h => (
                  <th key={h} style={{ padding: '8px 14px', textAlign: 'left', fontWeight: 600, color: '#6b7280', fontSize: 11, textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...new Set([...vendorsWithNcrs, ...lateVendors])]
                .sort((a, b) => (b.open_ncrs || 0) - (a.open_ncrs || 0))
                .map((v, i) => {
                  const reasons = [];
                  if (v.single_source)  reasons.push('Single source');
                  if (v.critical_vendor) reasons.push('Critical');
                  if ((v.open_ncrs || 0) > 0) reasons.push('Open NCRs');
                  if (v.on_time_delivery_pct != null && v.on_time_delivery_pct < 80) reasons.push('Late delivery');
                  const level = v.single_source && (v.open_ncrs || 0) > 0 ? 'Critical'
                    : (v.open_ncrs || 0) > 2 || v.single_source ? 'High' : 'Medium';
                  const cfg = RISK_BADGE[level] || RISK_BADGE.Low;
                  return (
                    <tr key={v.id ?? i} style={{ borderBottom: '1px solid #f3f4f6', background: level === 'Critical' ? '#fff8f8' : '#fff' }}>
                      <td style={{ padding: '9px 14px', fontWeight: 700, color: '#111827' }}>{v.name}</td>
                      <td style={{ padding: '9px 14px' }}>
                        <span style={{ padding: '2px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}` }}>
                          {level}
                        </span>
                        <span style={{ marginLeft: 8, fontSize: 11, color: '#6b7280' }}>{reasons.join(' · ')}</span>
                      </td>
                      <td style={{ padding: '9px 14px', textAlign: 'center', color: (v.open_ncrs || 0) > 0 ? C.red : '#6b7280', fontWeight: (v.open_ncrs || 0) > 0 ? 700 : 400 }}>
                        {v.open_ncrs || 0}
                      </td>
                      <td style={{ padding: '9px 14px', color: v.on_time_delivery_pct != null && v.on_time_delivery_pct < 80 ? C.red : '#374151' }}>
                        {v.on_time_delivery_pct != null ? `${v.on_time_delivery_pct}%` : '—'}
                      </td>
                      <td style={{ padding: '9px 14px', fontWeight: 700, color: C.primary }}>{fmtL(v.po_value)}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        )}
      </div>

      {/* Mitigation actions.

          These were six fixed sentences naming IGBTs, DSP controllers and power
          transformers — components that appear nowhere in this database. Each
          line below is now emitted only when the condition behind it is true, and
          names the vendors it is talking about. */}
      {(() => {
        const actions = [];
        const names = (arr, n = 3) => arr.slice(0, n).map(v => v.name).join(', ')
          + (arr.length > n ? ` and ${arr.length - n} more` : '');
        const blocked = allVendors.filter(v => String(v.health_label || '').toLowerCase() === 'blocked');
        const ssNcr   = singleSource.filter(v => (v.open_ncrs || 0) > 0);

        if (blocked.length) actions.push(`Source alternates for ${names(blocked)} — blocked in the vendor master, so no PO can be raised.`);
        if (ssNcr.length)   actions.push(`Qualify a second source for ${names(ssNcr)} — single-source with open non-conformances and no fallback.`);
        else if (singleSource.length) actions.push(`Begin dual-source qualification for ${names(singleSource)} — currently single-source.`);
        if (lateVendors.length) actions.push(`Review delivery SLAs with ${names(lateVendors)} — on-time delivery below 80%.`);
        if (vendorsWithNcrs.length) actions.push(`Close out ${vendorsWithNcrs.reduce((n, v) => n + (v.open_ncrs || 0), 0)} open NCR(s) across ${vendorsWithNcrs.length} vendor(s) before the next scheduled receipt.`);
        if (criticalVendors.length && !ssNcr.length) actions.push(`Schedule quarterly audits for ${names(criticalVendors)} — flagged critical in the vendor master.`);

        if (!actions.length) {
          return (
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 14, padding: '16px 20px', fontSize: 13, color: '#166534' }}>
              No supply-chain mitigation is outstanding: no blocked vendors, no single-source supplier carrying an open NCR, and every vendor with delivery history is above 80% on time.
            </div>
          );
        }
        return (
          <div style={{ background: '#f5f3ff', border: '1px solid #c4b5fd', borderRadius: 14, padding: '16px 20px' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#5b21b6', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
              <AlertTriangle size={14} />
              Supply Chain Risk Mitigation Actions
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {actions.map((a, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: '#4c1d95' }}>
                  <span style={{ color: C.amber, flexShrink: 0, fontWeight: 800, marginTop: 1 }}>•</span>
                  {a}
                </div>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
