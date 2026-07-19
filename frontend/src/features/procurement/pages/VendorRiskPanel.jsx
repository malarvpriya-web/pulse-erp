const fmtINR = n => {
  const v = parseFloat(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)} Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(2)} L`;
  if (v >= 1000)     return `₹${(v / 1000).toFixed(1)}K`;
  return `₹${v.toLocaleString('en-IN')}`;
};

const C = {
  primary: '#6B3FDB', light: '#f5f3ff', border: '#e9e4ff',
  green: '#16a34a', red: '#dc2626', amber: '#d97706', blue: '#2563eb',
  card: { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12 },
};

const RISK_CFG = {
  Low:      { color: '#16a34a', bg: '#dcfce7', icon: '✅', score: 1 },
  Medium:   { color: '#d97706', bg: '#fef3c7', icon: '⚠️', score: 2 },
  High:     { color: '#dc2626', bg: '#fee2e2', icon: '🔴', score: 3 },
  Critical: { color: '#7f1d1d', bg: '#fecaca', icon: '🚨', score: 4 },
};

const OVERALL_CFG = {
  Low:      { color: '#16a34a', bg: '#dcfce7', label: 'Low Risk',      desc: 'Vendor is performing well across all dimensions.' },
  Medium:   { color: '#d97706', bg: '#fef3c7', label: 'Medium Risk',   desc: 'Some areas need attention. Monitor closely.' },
  High:     { color: '#dc2626', bg: '#fee2e2', label: 'High Risk',     desc: 'Significant issues detected. Action required.' },
  Critical: { color: '#7f1d1d', bg: '#fecaca', label: 'Critical Risk', desc: 'Immediate escalation required. Consider alternate vendor.' },
};

function RiskBadge({ level }) {
  const cfg = RISK_CFG[level] || RISK_CFG.Low;
  return (
    <span style={{ padding: '3px 12px', borderRadius: 12, fontSize: 12, fontWeight: 700, color: cfg.color, background: cfg.bg, border: `1px solid ${cfg.color}33` }}>
      {cfg.icon} {level}
    </span>
  );
}

function RiskMeter({ level }) {
  const score = RISK_CFG[level]?.score || 1;
  const colors = ['#16a34a', '#d97706', '#dc2626', '#7f1d1d'];
  return (
    <div style={{ display: 'flex', gap: 3 }}>
      {[1, 2, 3, 4].map(i => (
        <div key={i} style={{ flex: 1, height: 6, borderRadius: 3, background: i <= score ? colors[i - 1] : '#f0f0f4' }} />
      ))}
    </div>
  );
}

function DimensionCard({ title, icon, level, detail, description }) {
  const cfg = RISK_CFG[level] || RISK_CFG.Low;
  return (
    <div style={{ ...C.card, padding: 20, borderLeft: `4px solid ${cfg.color}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 22 }}>{icon}</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{title}</div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{description}</div>
          </div>
        </div>
        <RiskBadge level={level} />
      </div>
      <RiskMeter level={level} />
      {detail && (
        <div style={{ marginTop: 12, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {detail.map((d, i) => (
            <div key={i} style={{ fontSize: 12, color: d.highlight ? cfg.color : '#6b7280', fontWeight: d.highlight ? 700 : 400 }}>
              {d.label}: <strong style={{ color: d.highlight ? cfg.color : '#374151' }}>{d.value}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FlagCard({ flag }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', background: '#fff5f5', borderRadius: 8, border: '1px solid #fecaca' }}>
      <span style={{ color: C.red, fontSize: 14, flexShrink: 0, marginTop: 1 }}>🚩</span>
      <span style={{ fontSize: 13, color: '#7f1d1d', fontWeight: 500 }}>{flag}</span>
    </div>
  );
}

function StrategicFlag({ label, icon, active, description }) {
  return (
    <div style={{
      ...C.card,
      padding: '14px 16px',
      opacity: active ? 1 : 0.45,
      borderLeft: active ? `3px solid ${C.red}` : '3px solid transparent',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 20 }}>{icon}</span>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: active ? '#111827' : '#9ca3af' }}>{label}</div>
          {active && <div style={{ fontSize: 11, color: C.red, fontWeight: 600, marginTop: 2 }}>FLAGGED</div>}
        </div>
        {active && (
          <span style={{ marginLeft: 'auto', width: 10, height: 10, borderRadius: '50%', background: C.red, flexShrink: 0 }} />
        )}
      </div>
      <div style={{ fontSize: 11, color: '#9ca3af' }}>{description}</div>
    </div>
  );
}

export default function VendorRiskPanel({ riskData, vendorName }) {
  if (!riskData) {
    return (
      <div style={{ padding: '60px 20px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>⏳</div>
        Loading risk assessment…
      </div>
    );
  }

  const { overall_risk, dimensions = {}, strategic_flags = {}, red_flags = [] } = riskData;
  const overallCfg = OVERALL_CFG[overall_risk] || OVERALL_CFG.Low;
  const fin  = dimensions.financial   || {};
  const qual = dimensions.quality     || {};
  const del  = dimensions.delivery    || {};
  const dep  = dimensions.dependency  || {};
  const comp = dimensions.compliance  || {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* Overall Risk Banner */}
      <div style={{ padding: '20px 24px', borderRadius: 12, background: overallCfg.bg, border: `1px solid ${overallCfg.color}33`, display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 40 }}>{RISK_CFG[overall_risk]?.icon || '✅'}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: overallCfg.color }}>{overallCfg.label}</div>
          <div style={{ fontSize: 13, color: overallCfg.color, opacity: 0.8, marginTop: 3 }}>{overallCfg.desc}</div>
          {vendorName && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>Vendor: <strong>{vendorName}</strong></div>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
          <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', fontWeight: 600 }}>Risk Meter</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {['Low','Medium','High','Critical'].map(lvl => {
              const active = RISK_CFG[overall_risk]?.score >= RISK_CFG[lvl]?.score;
              return (
                <div key={lvl} style={{ textAlign: 'center' }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: active ? RISK_CFG[lvl].color : '#f0f0f4', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: active ? '#fff' : '#9ca3af', marginBottom: 4 }}>
                    {lvl[0]}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Red Flags */}
      {red_flags.length > 0 && (
        <div style={{ ...C.card, padding: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.red, marginBottom: 12 }}>🚩 Red Flag Dashboard ({red_flags.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {red_flags.map((flag, i) => <FlagCard key={i} flag={flag} />)}
          </div>
        </div>
      )}

      {/* 5 Dimension Cards */}
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 14 }}>Risk Dimensions</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
          <DimensionCard
            title="Financial Risk"
            icon="💰"
            level={fin.level || 'Low'}
            description={fin.description || 'Based on overdue invoices and outstanding payables'}
            detail={[
              { label: 'Overdue Invoices', value: fin.overdue_invoices ?? 0, highlight: (fin.overdue_invoices || 0) > 0 },
              { label: 'Outstanding',       value: fmtINR(fin.outstanding),  highlight: parseFloat(fin.outstanding || 0) > 0 },
              { label: 'Overdue Amount',    value: fmtINR(fin.overdue_amount), highlight: parseFloat(fin.overdue_amount || 0) > 0 },
            ]}
          />
          <DimensionCard
            title="Quality Risk"
            icon="🔬"
            level={qual.level || 'Low'}
            description={qual.description || 'Based on NCR count, open NCRs and critical severity'}
            detail={[
              { label: 'Total NCRs',    value: qual.total_ncrs ?? 0,    highlight: false },
              { label: 'Open NCRs',     value: qual.open_ncrs ?? 0,     highlight: (qual.open_ncrs || 0) > 0 },
              { label: 'Critical NCRs', value: qual.critical_ncrs ?? 0, highlight: (qual.critical_ncrs || 0) > 0 },
            ]}
          />
          <DimensionCard
            title="Delivery Risk"
            icon="🚚"
            level={del.level || 'Low'}
            description={del.description || 'Based on POs past delivery date'}
            detail={[
              { label: 'Overdue POs',   value: del.overdue_pos ?? 0,                               highlight: (del.overdue_pos || 0) > 0 },
              { label: 'Total POs',     value: del.total_pos ?? 0,                                 highlight: false },
              { label: 'Overdue Ratio', value: `${del.overdue_ratio ?? 0}%`,                       highlight: parseFloat(del.overdue_ratio || 0) > 10 },
            ]}
          />
          <DimensionCard
            title="Dependency Risk"
            icon="🔗"
            level={dep.level || 'Low'}
            description={dep.description || 'Based on project dependency and item concentration'}
            detail={[
              { label: 'Projects Dependent', value: dep.projects ?? 0,      highlight: (dep.projects || 0) > 3 },
              { label: 'Unique Items',        value: dep.unique_items ?? 0,  highlight: (dep.unique_items || 0) > 15 },
              { label: 'Open POs',            value: dep.open_pos ?? 0,      highlight: false },
            ]}
          />
          <DimensionCard
            title="Compliance Risk"
            icon="📋"
            level={comp.level || 'Low'}
            description={comp.description || 'Based on document and regulatory compliance'}
            detail={[
              { label: 'Docs Complete', value: `${comp.docs_complete ?? 0} / ${comp.docs_total ?? 5}`, highlight: (comp.docs_complete || 0) < 3 },
              { label: 'GST',           value: comp.has_gst ? '✓ Present' : '✗ Missing',               highlight: !comp.has_gst },
              { label: 'PAN',           value: comp.has_pan ? '✓ Present' : '✗ Missing',               highlight: !comp.has_pan },
              { label: 'Bank Details',  value: comp.has_bank ? '✓ Present' : '✗ Missing',              highlight: !comp.has_bank },
            ]}
          />
        </div>
      </div>

      {/* Strategic Supplier Panel */}
      <div style={{ ...C.card, padding: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 14 }}>Strategic Supplier Classification</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
          <StrategicFlag
            label="Single Source Supplier"
            icon="🎯"
            active={strategic_flags.single_source}
            description="Sole supplier for critical items — no alternate source available"
          />
          <StrategicFlag
            label="Long Lead Supplier"
            icon="⏳"
            active={strategic_flags.long_lead_supplier}
            description="Lead time exceeds standard thresholds"
          />
          <StrategicFlag
            label="Critical Supplier"
            icon="⚡"
            active={strategic_flags.critical_supplier}
            description="High or Critical overall risk rating"
          />
          <StrategicFlag
            label="High Spend Supplier"
            icon="💸"
            active={strategic_flags.high_spend}
            description="Total spend exceeds ₹50L threshold"
          />
          <StrategicFlag
            label="Project Critical"
            icon="🏗️"
            active={strategic_flags.project_critical}
            description="Vendor supplies 3 or more active projects"
          />
        </div>
      </div>

      {/* Manifest Special: Component Categories */}
      <div style={{ ...C.card, padding: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 6 }}>Manifest Validation — Component Category Tracking</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 14 }}>Track vendor supply by power electronics category for traceability compliance.</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
          {[
            { label: 'IGBT Suppliers',          icon: '⚡' },
            { label: 'Transformer Suppliers',   icon: '🔋' },
            { label: 'Capacitor Suppliers',     icon: '🔌' },
            { label: 'Semiconductor Suppliers', icon: '💻' },
            { label: 'Fabrication Vendors',     icon: '🏭' },
            { label: 'Panel Builders',          icon: '🗂️' },
            { label: 'Testing Vendors',         icon: '🔬' },
            { label: 'Logistics Vendors',       icon: '🚚' },
            { label: 'Commissioning Partners',  icon: '🔧' },
          ].map(({ label, icon }) => (
            <div key={label} style={{ padding: '10px 12px', background: '#fafafa', borderRadius: 8, border: '1px solid #f0f0f4', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 18 }}>{icon}</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#374151' }}>{label}</span>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 12 }}>
          Link vendor to category via Vendor Management → Category field to enable category-level risk tracking.
        </div>
      </div>
    </div>
  );
}
