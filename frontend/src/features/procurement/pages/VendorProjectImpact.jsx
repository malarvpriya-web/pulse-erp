const fmtINR = n => {
  const v = parseFloat(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)} Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(2)} L`;
  if (v >= 1000)     return `₹${(v / 1000).toFixed(1)}K`;
  return `₹${v.toLocaleString('en-IN')}`;
};
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

const C = {
  primary: '#6B3FDB', light: '#f5f3ff', border: '#e9e4ff',
  green: '#16a34a', red: '#dc2626', amber: '#d97706', blue: '#2563eb',
  card: { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12 },
};

const RISK_CFG = {
  Low:      { color: C.green, bg: '#dcfce7' },
  Medium:   { color: C.amber, bg: '#fef3c7' },
  High:     { color: C.red,   bg: '#fee2e2' },
  Critical: { color: '#7f1d1d', bg: '#fecaca' },
};

const STATUS_CFG = {
  Active:      { color: C.green,   bg: '#dcfce7' },
  'In Progress': { color: C.blue,  bg: '#dbeafe' },
  Completed:   { color: '#6b7280', bg: '#f3f4f6' },
  'On Hold':   { color: C.amber,   bg: '#fef3c7' },
  Delayed:     { color: C.red,     bg: '#fee2e2' },
  Planning:    { color: C.primary, bg: C.light },
};

function Badge({ label, color, bg }) {
  return (
    <span style={{ padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600, color, background: bg }}>
      {label}
    </span>
  );
}

function KpiCard({ label, value, sub, color = '#111827' }) {
  return (
    <div style={{ ...C.card, padding: '16px 18px' }}>
      <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 500, marginBottom: 4, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function BudgetBar({ used, total }) {
  if (!total) return <span style={{ color: '#9ca3af', fontSize: 12 }}>No budget set</span>;
  const pct   = Math.min((used / total) * 100, 100);
  const color = pct > 90 ? C.red : pct > 70 ? C.amber : C.green;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
        <span style={{ color: '#6b7280' }}>{fmtINR(used)} used</span>
        <span style={{ color, fontWeight: 700 }}>{pct.toFixed(0)}%</span>
      </div>
      <div style={{ height: 5, background: '#f0f0f4', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3, transition: 'width .4s' }} />
      </div>
    </div>
  );
}

export default function VendorProjectImpact({ projectsData }) {
  if (!projectsData) {
    return (
      <div style={{ padding: '60px 20px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>⏳</div>
        Loading project data…
      </div>
    );
  }

  const { projects = [], summary = {} } = projectsData;

  if (!projects.length) {
    return (
      <div style={{ padding: '60px 20px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🏗️</div>
        <div style={{ fontWeight: 600, color: '#374151', marginBottom: 6 }}>No Projects Found</div>
        <div>This vendor has no purchase orders linked to projects yet.</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Summary KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 14 }}>
        <KpiCard label="Total Projects"   value={summary.total_projects || 0}   color={C.primary} />
        <KpiCard label="Active Projects"  value={summary.active_projects || 0}  color={C.blue} />
        <KpiCard label="Total PO Value"   value={fmtINR(summary.total_po_value)} color={C.green} />
        <KpiCard label="Open PO Value"    value={fmtINR(summary.open_po_value)}  color={C.amber} />
        <KpiCard label="At Risk"          value={summary.at_risk || 0}           color={(summary.at_risk || 0) > 0 ? C.red : C.green} />
      </div>

      {/* Project Cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {projects.map((p, i) => {
          const riskCfg   = RISK_CFG[p.risk]   || RISK_CFG.Low;
          const statusCfg = STATUS_CFG[p.status] || { color: '#6b7280', bg: '#f3f4f6' };
          return (
            <div key={p.id || i} style={{ ...C.card, padding: 20 }}>
              {/* Row 1: name + badges */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#111827', marginBottom: 3 }}>{p.project_name || `Project #${p.id}`}</div>
                  <div style={{ fontSize: 12, color: '#6b7280', fontFamily: 'monospace' }}>{p.project_code || '—'}</div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Badge label={p.status || 'Unknown'} color={statusCfg.color} bg={statusCfg.bg} />
                  <Badge label={`${p.risk} Risk`} color={riskCfg.color} bg={riskCfg.bg} />
                  {p.project_type && <Badge label={p.project_type} color={C.primary} bg={C.light} />}
                </div>
              </div>

              {/* Row 2: metrics grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16, marginBottom: 14 }}>
                <div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 2 }}>PO Value from Vendor</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: C.primary }}>{fmtINR(p.po_value)}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{p.po_count} PO{p.po_count !== 1 ? 's' : ''}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 2 }}>Open PO Value</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: p.open_po_value > 0 ? C.amber : '#6b7280' }}>{fmtINR(p.open_po_value)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 2 }}>NCRs Raised</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: p.ncr_count > 0 ? C.red : C.green }}>{p.ncr_count}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 2 }}>Timeline</div>
                  <div style={{ fontSize: 12, color: '#374151', fontWeight: 500 }}>{fmtDate(p.start_date)}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>to {fmtDate(p.end_date)}</div>
                </div>
              </div>

              {/* Row 3: budget utilization */}
              {p.budget > 0 && (
                <div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>Budget Utilization (Vendor PO vs Project Budget)</div>
                  <BudgetBar used={p.po_value} total={p.budget} />
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>Project Budget: {fmtINR(p.budget)}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Risk Legend */}
      <div style={{ ...C.card, padding: '14px 18px', display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Risk Key:</span>
        {Object.entries(RISK_CFG).map(([level, cfg]) => (
          <div key={level} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: cfg.color }} />
            <span style={{ fontSize: 12, color: '#374151' }}>{level}</span>
          </div>
        ))}
        <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 'auto' }}>
          High = On Hold status or 3+ NCRs · Medium = Delayed or 1-2 NCRs
        </span>
      </div>
    </div>
  );
}
