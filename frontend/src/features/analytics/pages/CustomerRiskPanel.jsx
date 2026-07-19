// frontend/src/features/analytics/pages/CustomerRiskPanel.jsx
// Phase 49H — Customer Risk Center (Section 3) — CEO Executive View
// Shows customers at risk sorted by highest risk first
import { AlertTriangle, Clock, FileText, Ticket, Shield } from 'lucide-react';

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

const RISK_CFG = {
  Critical: { bg: '#fef2f2', border: '#fca5a5', color: '#dc2626', dot: '#dc2626' },
  High:     { bg: '#fffbeb', border: '#fcd34d', color: '#92400e', dot: '#d97706' },
  Medium:   { bg: '#fefce8', border: '#fde68a', color: '#78350f', dot: '#f59e0b' },
  Low:      { bg: '#f0fdf4', border: '#bbf7d0', color: '#15803d', dot: '#16a34a' },
};

function RiskBar({ score, max = 100 }) {
  const pct = Math.min(Math.round((score / max) * 100), 100);
  const color = score >= 80 ? C.green : score >= 60 ? C.blue : score >= 40 ? C.amber : C.red;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, background: '#f3f4f6', borderRadius: 6, height: 8 }}>
        <div style={{ width: `${pct}%`, background: color, height: '100%', borderRadius: 6, transition: 'width .4s' }} />
      </div>
      <span style={{ fontSize: 11, fontWeight: 700, color, minWidth: 24 }}>{score}</span>
    </div>
  );
}

function MetricPill({ icon: Icon, value, color, label }) {
  if (!value && value !== 0) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', background: `${color}15`, borderRadius: 6, fontSize: 11, color }}>
      <Icon size={11} />
      <span style={{ fontWeight: 600 }}>{value} {label}</span>
    </div>
  );
}

export default function CustomerRiskPanel({ atRisk = [] }) {
  if (atRisk.length === 0) {
    return (
      <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 14, padding: 40, textAlign: 'center' }}>
        <Shield size={32} color={C.green} style={{ marginBottom: 12 }} />
        <div style={{ fontSize: 16, fontWeight: 700, color: C.green }}>No Customers At Risk</div>
        <div style={{ fontSize: 13, color: '#6b7280', marginTop: 6 }}>All customers have acceptable health scores.</div>
      </div>
    );
  }

  const sorted = [...atRisk].sort((a, b) => a.health_score - b.health_score);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 800, color: '#111827' }}>Customer Risk Center</div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>Customers requiring immediate attention · sorted by highest risk</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {['Critical','High'].map(lvl => {
            const count = sorted.filter(c => c.risk_level === lvl).length;
            const cfg = RISK_CFG[lvl];
            return count > 0 ? (
              <div key={lvl} style={{ padding: '4px 12px', background: cfg.bg, border: `1px solid ${cfg.border}`, borderRadius: 8, fontSize: 12, fontWeight: 700, color: cfg.color }}>
                {count} {lvl}
              </div>
            ) : null;
          })}
        </div>
      </div>

      {/* Table */}
      <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#f9fafb', borderBottom: `1px solid #f3f4f6` }}>
                {['Customer', 'Health Score', 'Outstanding', 'Open NCR', 'Tickets', 'AMC Status', 'Risk Level'].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#6b7280', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((c, i) => {
                const riskCfg = RISK_CFG[c.risk_level] || RISK_CFG.Low;
                const rowBg = c.risk_level === 'Critical' ? '#fff8f8'
                  : c.risk_level === 'High' ? '#fffdf0' : i % 2 === 0 ? '#fff' : '#fafafa';
                return (
                  <tr key={c.id} style={{ borderBottom: '1px solid #f3f4f6', background: rowBg }}>
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{ fontWeight: 700, color: '#111827' }}>{c.name}</div>
                      {c.city && <div style={{ fontSize: 10, color: '#9ca3af' }}>{c.city}{c.state ? `, ${c.state}` : ''}</div>}
                    </td>
                    <td style={{ padding: '10px 14px', minWidth: 160 }}>
                      <div style={{ marginBottom: 4 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: c.health_color }}>{c.health_label}</span>
                      </div>
                      <RiskBar score={c.health_score} />
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      {c.outstanding > 0 ? (
                        <span style={{ fontWeight: 700, color: C.red }}>{fmtL(c.outstanding)}</span>
                      ) : (
                        <span style={{ color: '#9ca3af' }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      {c.open_ncr > 0
                        ? <span style={{ fontWeight: 700, color: C.red }}>{c.open_ncr}</span>
                        : <span style={{ color: '#9ca3af' }}>0</span>}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {c.open_tickets > 0 && (
                          <MetricPill icon={Ticket} value={c.open_tickets} color={C.blue} label="open" />
                        )}
                        {c.escalated_tickets > 0 && (
                          <MetricPill icon={AlertTriangle} value={c.escalated_tickets} color={C.red} label="escalated" />
                        )}
                        {!c.open_tickets && !c.escalated_tickets && <span style={{ color: '#9ca3af' }}>—</span>}
                      </div>
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      {c.active_amc > 0 ? (
                        <span style={{ color: C.green, fontWeight: 600, fontSize: 11 }}>Active ({c.active_amc})</span>
                      ) : (
                        <span style={{ color: C.amber, fontWeight: 600, fontSize: 11 }}>No AMC</span>
                      )}
                      {c.amc_next_expiry && (
                        <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>
                          Exp: {new Date(c.amc_next_expiry).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5,
                        padding: '4px 10px', borderRadius: 8, fontWeight: 700, fontSize: 11,
                        background: riskCfg.bg, border: `1px solid ${riskCfg.border}`, color: riskCfg.color,
                      }}>
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: riskCfg.dot }} />
                        {c.risk_level}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Action guidance */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
        {[
          { level: 'Critical', action: 'Immediate CEO/MD intervention required. Schedule emergency review within 48 hours.', color: C.red, icon: AlertTriangle },
          { level: 'High', action: 'VP Sales engagement required this week. Collections + project health review needed.', color: C.amber, icon: Clock },
        ].filter(a => sorted.some(c => c.risk_level === a.level)).map(a => (
          <div key={a.level} style={{ background: `${a.color}08`, border: `1px solid ${a.color}30`, borderRadius: 12, padding: '12px 14px', display: 'flex', gap: 10 }}>
            <a.icon size={16} color={a.color} style={{ flexShrink: 0, marginTop: 1 }} />
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: a.color, marginBottom: 3 }}>{a.level} Risk Action</div>
              <div style={{ fontSize: 11, color: '#6b7280', lineHeight: 1.5 }}>{a.action}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
