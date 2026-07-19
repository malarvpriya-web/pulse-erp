// frontend/src/features/analytics/pages/VendorRiskPanel.jsx
// Phase 49H — Supply Chain Risk Center (Section 7) — CEO Executive View
// High-risk vendors sorted by worst first: Green / Amber / Red
import { AlertTriangle, Package, TrendingDown, ShieldOff, Activity } from 'lucide-react';

const fmtL = (n) => {
  const v = parseFloat(n || 0);
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(1)} L`;
  if (v >= 1e3) return `₹${(v / 1e3).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};
const fmtPct = n => `${parseFloat(n || 0).toFixed(1)}%`;

const C = {
  primary: '#6B3FDB', green: '#16a34a', red: '#dc2626',
  amber: '#d97706', blue: '#2563eb', border: '#e9e4ff',
};

const RISK_ROW_COLOR = {
  Critical: '#fff5f5',
  High:     '#fffbeb',
  Medium:   '#fffff0',
  Low:      '#f9fafb',
};

const RISK_BADGE = {
  Critical: { bg: '#fee2e2', color: '#dc2626', border: '#fca5a5' },
  High:     { bg: '#fef3c7', color: '#92400e', border: '#fcd34d' },
  Medium:   { bg: '#fef9c3', color: '#713f12', border: '#fde68a' },
  Low:      { bg: '#dcfce7', color: '#15803d', border: '#86efac' },
};

function ScoreDot({ value, max = 5 }) {
  const pct = (value / max) * 100;
  const color = pct >= 80 ? C.green : pct >= 60 ? C.blue : pct >= 40 ? C.amber : C.red;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 60, background: '#f3f4f6', borderRadius: 4, height: 6 }}>
        <div style={{ width: `${pct}%`, background: color, height: '100%', borderRadius: 4 }} />
      </div>
      <span style={{ fontSize: 11, fontWeight: 700, color }}>{parseFloat(value || 0).toFixed(1)}</span>
    </div>
  );
}

export default function VendorRiskPanel({ highRisk = [] }) {
  if (highRisk.length === 0) {
    return (
      <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 14, padding: 40, textAlign: 'center' }}>
        <Activity size={32} color={C.green} style={{ marginBottom: 12 }} />
        <div style={{ fontSize: 16, fontWeight: 700, color: C.green }}>Supply Chain Risk is Low</div>
        <div style={{ fontSize: 13, color: '#6b7280', marginTop: 6 }}>No high-risk or blocked vendors detected.</div>
      </div>
    );
  }

  const sorted = [...highRisk].sort((a, b) => {
    const order = { Critical: 0, High: 1, Medium: 2, Low: 3 };
    return (order[a.risk_level] ?? 4) - (order[b.risk_level] ?? 4);
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 800, color: '#111827' }}>Supply Chain Risk Center</div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>High-risk suppliers threatening project delivery · sorted by severity</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {['Critical', 'High'].map(lvl => {
            const count = sorted.filter(v => v.risk_level === lvl).length;
            const cfg = RISK_BADGE[lvl];
            return count > 0 ? (
              <div key={lvl} style={{ padding: '4px 12px', background: cfg.bg, border: `1px solid ${cfg.border}`, borderRadius: 8, fontSize: 12, fontWeight: 700, color: cfg.color }}>
                {count} {lvl}
              </div>
            ) : null;
          })}
        </div>
      </div>

      <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#f9fafb', borderBottom: '1px solid #f3f4f6' }}>
                {['Vendor', 'Health', 'Spend', 'Projects Impacted', 'Revenue At Risk', 'Open NCRs', 'OTD %', 'Risk Level'].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#6b7280', fontSize: 11, textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((v, i) => {
                const riskCfg = RISK_BADGE[v.risk_level] || RISK_BADGE.Low;
                const rowBg = RISK_ROW_COLOR[v.risk_level] || '#fff';
                const revenueAtRisk = v.projects_impacted * 2000000; // estimate ₹20L per project
                return (
                  <tr key={v.id} style={{ borderBottom: '1px solid #f3f4f6', background: rowBg }}>
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{ fontWeight: 700, color: '#111827' }}>{v.name}</div>
                      <div style={{ fontSize: 10, color: '#9ca3af', display: 'flex', gap: 4, marginTop: 2 }}>
                        {v.single_source && <span style={{ background: '#fef3c7', color: '#92400e', padding: '1px 5px', borderRadius: 4 }}>SINGLE SOURCE</span>}
                        {v.critical_vendor && <span style={{ background: '#fee2e2', color: '#991b1b', padding: '1px 5px', borderRadius: 4 }}>CRITICAL VENDOR</span>}
                      </div>
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{ marginBottom: 4 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: v.health_color }}>{v.health_label}</span>
                      </div>
                      <ScoreDot value={v.overall_score} />
                    </td>
                    <td style={{ padding: '10px 14px', fontWeight: 700, color: C.primary }}>{fmtL(v.po_value)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'center', color: v.projects_impacted > 0 ? C.red : '#6b7280', fontWeight: v.projects_impacted > 0 ? 700 : 400 }}>
                      {v.projects_impacted || '—'}
                    </td>
                    <td style={{ padding: '10px 14px', color: revenueAtRisk > 0 ? C.amber : '#6b7280', fontWeight: 600 }}>
                      {v.projects_impacted > 0 ? `~${fmtL(revenueAtRisk)}` : '—'}
                    </td>
                    <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                      {v.open_ncrs > 0
                        ? <span style={{ fontWeight: 700, color: C.red }}>{v.open_ncrs}</span>
                        : <span style={{ color: '#9ca3af' }}>0</span>}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      {v.on_time_delivery_pct != null ? (
                        <span style={{ fontWeight: 700, color: v.on_time_delivery_pct < 80 ? C.red : v.on_time_delivery_pct < 90 ? C.amber : C.green }}>
                          {fmtPct(v.on_time_delivery_pct)}
                        </span>
                      ) : <span style={{ color: '#9ca3af' }}>—</span>}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5,
                        padding: '4px 10px', borderRadius: 8, fontWeight: 700, fontSize: 11,
                        background: riskCfg.bg, border: `1px solid ${riskCfg.border}`, color: riskCfg.color,
                      }}>
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: riskCfg.color }} />
                        {v.risk_level}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600 }}>KEY:</span>
        <span style={{ fontSize: 11, background: '#fef3c7', color: '#92400e', padding: '2px 8px', borderRadius: 6 }}>SS = Single Source</span>
        <span style={{ fontSize: 11, background: '#fee2e2', color: '#991b1b', padding: '2px 8px', borderRadius: 6 }}>CV = Critical Vendor</span>
        <span style={{ fontSize: 11, color: '#9ca3af' }}>Revenue At Risk = estimated based on open project count</span>
      </div>
    </div>
  );
}
