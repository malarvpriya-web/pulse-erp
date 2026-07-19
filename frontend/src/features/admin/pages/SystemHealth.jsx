import { useState, Fragment } from 'react';
import {
  Activity, RefreshCw, CheckCircle, AlertCircle, Wifi,
  Database, ChevronDown, ChevronRight, AlertTriangle,
  TrendingUp, Server, Shield, Zap,
} from 'lucide-react';
import { testAllConnections } from '@/utils/dbConnectionTest';

/* ─── group icon — two-letter abbreviation rendered as a badge ───────────── */
function GroupIcon({ name }) {
  const abbr = (name || '').slice(0, 2).toUpperCase();
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 22, height: 22, borderRadius: 5,
      background: '#e0e7ff', color: '#3730a3',
      fontSize: 9, fontWeight: 800, letterSpacing: '0.02em', flexShrink: 0,
    }}>{abbr}</span>
  );
}

const GROUP_ORDER = [
  'Core','Dashboard','HR','Payroll','Performance','Attendance',
  'Biometric','Self Service','Exit Mgmt','Recruitment',
  'Finance','Accounting','GST','TDS','Budgets','Fixed Assets','Forex',
  'Procurement','Inventory','Warehouse','Logistics',
  'Production','Quality','Maintenance',
  'CRM','Pipeline','Sales','Marketing',
  'Projects','Timesheets','Service Desk',
  'Operations','Workflows','Security','Travel','Documents','Org Chart',
  'Complaints','Analytics','AI','Integrations',
  'Approvals','Audit','Reports','Admin',
];

/* ─── tier logic ─────────────────────────────────────────────────────────── */
const getTier = (r) => {
  if (!r.ok) return 'error';
  if (r.status === 200 && r.records === 0) return 'empty';
  if (r.status === 401 || r.status === 403) return 'auth';
  return 'live';
};

const TIER = {
  live:  { dot: '#16a34a', pill: '#dcfce7', pillTxt: '#15803d', pillBdr: '#bbf7d0', label: 'Live'  },
  empty: { dot: '#d97706', pill: '#fef3c7', pillTxt: '#92400e', pillBdr: '#fde68a', label: 'Empty' },
  auth:  { dot: '#4f46e5', pill: '#e0e7ff', pillTxt: '#3730a3', pillBdr: '#c7d2fe', label: 'Auth'  },
  error: { dot: '#dc2626', pill: '#fee2e2', pillTxt: '#b91c1c', pillBdr: '#fca5a5', label: 'Error' },
};

const TIER_RANK = { error: 0, empty: 1, auth: 2, live: 3 };

/* ─── micro components ───────────────────────────────────────────────────── */
function StatusPill({ tier }) {
  const t = TIER[tier];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700,
      background: t.pill, color: t.pillTxt, border: `1px solid ${t.pillBdr}`,
      whiteSpace: 'nowrap', letterSpacing: '0.02em',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.dot, flexShrink: 0, display: 'inline-block' }} />
      {t.label}
    </span>
  );
}

function HttpBadge({ status }) {
  const MAP = {
    200: ['#dcfce7', '#15803d'],
    401: ['#e0e7ff', '#3730a3'],
    403: ['#fef3c7', '#92400e'],
    404: ['#fee2e2', '#b91c1c'],
    500: ['#fee2e2', '#b91c1c'],
  };
  const [bg, color] = MAP[status] || ['#f1f5f9', '#475569'];
  return (
    <span style={{
      padding: '2px 9px', borderRadius: 6, fontSize: 11, fontWeight: 800,
      background: bg, color, fontFamily: 'ui-monospace,monospace',
      display: 'inline-block', minWidth: 36, textAlign: 'center',
    }}>
      {status || 'ERR'}
    </span>
  );
}

function TimePill({ ms }) {
  if (!ms) return <span style={{ color: '#94a3b8', fontSize: 11 }}>—</span>;
  const [bg, color] =
    ms > 2000 ? ['#fee2e2', '#b91c1c'] :
    ms > 800  ? ['#fef3c7', '#92400e'] :
                ['#dcfce7', '#15803d'];
  return (
    <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: bg, color }}>
      {ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`}
    </span>
  );
}

function RecordsPill({ records }) {
  if (records === null || records === undefined)
    return <span style={{ color: '#94a3b8', fontSize: 11 }}>—</span>;
  if (records === -1)
    return <span style={{ background: '#f3e8ff', color: '#6B3FDB', border: '1px solid #ddd6fe', borderRadius: 20, padding: '2px 9px', fontSize: 10, fontWeight: 700 }}>KPI</span>;
  if (records === 0)
    return <span style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a', borderRadius: 20, padding: '2px 9px', fontSize: 10, fontWeight: 700 }}>⚠ 0</span>;
  return (
    <span style={{ background: '#dcfce7', color: '#15803d', border: '1px solid #bbf7d0', borderRadius: 20, padding: '2px 9px', fontSize: 10, fontWeight: 700 }}>
      ✓ {records.toLocaleString()}
    </span>
  );
}

function MiniTag({ children, bg, color }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: bg, color, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

/* ─── issues panel ───────────────────────────────────────────────────────── */
function IssuesPanel({ errors, empties }) {
  const [open, setOpen] = useState(true);

  if (errors.length === 0 && empties.length === 0) {
    return (
      <div style={{
        background: 'linear-gradient(135deg,#f0fdf4,#dcfce7)',
        border: '1px solid #bbf7d0', borderRadius: 12,
        padding: '14px 20px', marginBottom: 16,
        display: 'flex', alignItems: 'center', gap: 14,
      }}>
        <div style={{ background: '#16a34a', borderRadius: '50%', width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <CheckCircle size={18} color="#fff" />
        </div>
        <div>
          <div style={{ fontWeight: 700, color: '#14532d', fontSize: 14 }}>All Systems Operational</div>
          <div style={{ color: '#166534', fontSize: 12, marginTop: 2 }}>Every endpoint is connected and returning live data. Database is fully healthy.</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: '#fff', border: '1px solid #fca5a5', borderRadius: 12, marginBottom: 16, overflow: 'hidden' }}>
      <div
        onClick={() => setOpen(v => !v)}
        style={{ background: '#fef2f2', padding: '12px 18px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', userSelect: 'none' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <AlertCircle size={15} color="#dc2626" />
          <span style={{ fontWeight: 700, fontSize: 13, color: '#7f1d1d' }}>Issues Found</span>
          {errors.length > 0 && (
            <span style={{ background: '#dc2626', color: '#fff', borderRadius: 20, padding: '1px 9px', fontSize: 11, fontWeight: 700 }}>
              {errors.length} error{errors.length !== 1 ? 's' : ''}
            </span>
          )}
          {empties.length > 0 && (
            <span style={{ background: '#d97706', color: '#fff', borderRadius: 20, padding: '1px 9px', fontSize: 11, fontWeight: 700 }}>
              {empties.length} empty
            </span>
          )}
        </div>
        {open ? <ChevronDown size={14} color="#b91c1c" /> : <ChevronRight size={14} color="#b91c1c" />}
      </div>

      {open && (
        <div style={{
          padding: '14px 18px',
          display: 'grid',
          gridTemplateColumns: errors.length > 0 && empties.length > 0 ? '1fr 1fr' : '1fr',
          gap: 16,
        }}>
          {errors.length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 800, color: '#dc2626', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                Connection Errors ({errors.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {errors.map((r, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: '#fef2f2', borderRadius: 8, borderLeft: '3px solid #dc2626' }}>
                    <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: '#1e293b', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.module}</span>
                    <span style={{ fontSize: 10, fontFamily: 'ui-monospace,monospace', color: '#64748b', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.url}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#dc2626', whiteSpace: 'nowrap', marginLeft: 'auto' }}>
                      {r.error || (r.status === 404 ? '404 Missing' : r.status === 0 ? 'No Response' : `HTTP ${r.status}`)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {empties.length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 800, color: '#d97706', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                Empty Tables ({empties.length}) — Connected, no data yet
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {empties.map((r, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: '#fffbeb', borderRadius: 8, borderLeft: '3px solid #d97706' }}>
                    <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: '#1e293b', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.module}</span>
                    <span style={{ fontSize: 10, fontFamily: 'ui-monospace,monospace', color: '#64748b', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.url}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#d97706', whiteSpace: 'nowrap', marginLeft: 'auto' }}>No data</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── main ───────────────────────────────────────────────────────────────── */
export default function SystemHealth() {
  const [results,  setResults]  = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [tested,   setTested]   = useState(false);
  const [testedAt, setTestedAt] = useState(null);
  const [progress, setProgress] = useState(0);
  const [collapsed, setCollapsed] = useState({});

  const run = async () => {
    setLoading(true);
    setTested(false);
    setResults([]);
    setCollapsed({});
    setProgress(0);
    try {
      const r = await testAllConnections((p) => setProgress(p));
      setResults(r);
    } finally {
      setTested(true);
      setTestedAt(new Date().toLocaleTimeString());
      setLoading(false);
    }
  };

  const toggleGroup = (g) => setCollapsed(p => ({ ...p, [g]: !p[g] }));

  /* ── derived stats ── */
  const total       = results.length;
  const live200     = results.filter(r => r.status === 200).length;
  const withRecords = results.filter(r => r.status === 200 && r.records > 0).length;
  const emptyTables = results.filter(r => r.status === 200 && r.records === 0).length;
  const authOk      = results.filter(r => r.status === 401 || r.status === 403).length;
  const failing     = results.filter(r => !r.ok).length;
  const healthy     = results.filter(r => r.ok).length;
  const totalRecs   = results.reduce((s, r) => s + (r.records > 0 ? r.records : 0), 0);
  const score       = total ? Math.round((healthy / total) * 100) : 0;
  const avgMs       = live200 > 0
    ? Math.round(results.filter(r => r.status === 200 && r.ms > 0).reduce((s, r) => s + r.ms, 0) / live200)
    : 0;

  /* ── build ordered groups, sort rows within each group ── */
  const groupMap = {};
  for (const r of results) {
    if (!groupMap[r.group]) groupMap[r.group] = [];
    groupMap[r.group].push(r);
  }
  for (const g in groupMap) {
    groupMap[g].sort((a, b) => {
      const diff = TIER_RANK[getTier(a)] - TIER_RANK[getTier(b)];
      return diff !== 0 ? diff : a.module.localeCompare(b.module);
    });
  }
  const orderedGroups = [
    ...GROUP_ORDER.filter(g => groupMap[g]).map(g => [g, groupMap[g]]),
    ...Object.keys(groupMap).filter(g => !GROUP_ORDER.includes(g)).map(g => [g, groupMap[g]]),
  ];

  const errors  = results.filter(r => getTier(r) === 'error');
  const empties = results.filter(r => getTier(r) === 'empty');

  const KPI = [
    { label: 'Total Tables',     val: total,                      icon: Activity,      color: '#6B3FDB', bg: '#f5f3ff' },
    { label: 'Live & Connected', val: live200,                    icon: Server,        color: '#16a34a', bg: '#f0fdf4' },
    { label: 'Auth Protected',   val: authOk,                     icon: Shield,        color: '#4f46e5', bg: '#eef2ff' },
    { label: 'Empty Tables',     val: emptyTables,                icon: AlertTriangle, color: emptyTables > 0 ? '#d97706' : '#16a34a', bg: emptyTables > 0 ? '#fffbeb' : '#f0fdf4' },
    { label: 'Errors',           val: failing,                    icon: AlertCircle,   color: failing > 0 ? '#dc2626' : '#16a34a',   bg: failing > 0 ? '#fef2f2' : '#f0fdf4'   },
    { label: 'Total DB Records', val: totalRecs.toLocaleString(), icon: Database,      color: '#0891b2', bg: '#ecfeff' },
  ];

  return (
    <div style={{ padding: '20px 24px', background: '#f1f5f9', minHeight: '100vh', fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif' }}>
      <style>{`
        @keyframes spin    { to { transform: rotate(360deg); } }
        @keyframes fadeUp  { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:none; } }
        .sh-row:hover td   { background: #faf8ff !important; }
        .sh-grp:hover      { background: #e8e4f8 !important; cursor: pointer; }
        .sh-run:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 24px rgba(107,63,219,.45) !important; }
      `}</style>

      {/* ══ HEADER ══════════════════════════════════════════════════════════ */}
      <div style={{
        background: 'linear-gradient(135deg,#4c1d95 0%,#6B3FDB 55%,#6366f1 100%)',
        borderRadius: 16, padding: '22px 28px', marginBottom: 18,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        boxShadow: '0 8px 32px rgba(107,63,219,.28)', position: 'relative', overflow: 'hidden',
      }}>
        {/* decorative circles */}
        <div style={{ position:'absolute', top:-40, right:220, width:180, height:180, borderRadius:'50%', background:'rgba(255,255,255,.05)', pointerEvents:'none' }} />
        <div style={{ position:'absolute', bottom:-50, right:60,  width:150, height:150, borderRadius:'50%', background:'rgba(255,255,255,.04)', pointerEvents:'none' }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, zIndex: 1 }}>
          <div style={{ background: 'rgba(255,255,255,.18)', borderRadius: 12, padding: 10, backdropFilter: 'blur(4px)' }}>
            <Activity size={22} color="#fff" />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#fff', letterSpacing: '-.3px' }}>
              System Health Monitor
            </h1>
            <p style={{ margin: '3px 0 0', fontSize: 12, color: 'rgba(255,255,255,.6)' }}>
              Live database table introspection &amp; data verification — {total || '200+'}  tables
              {testedAt && <span style={{ marginLeft: 8, color: 'rgba(255,255,255,.38)' }}>· Last run {testedAt}</span>}
            </p>
            {tested && (
              <div style={{ display: 'flex', gap: 14, marginTop: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: score === 100 ? '#4ade80' : score >= 80 ? '#fbbf24' : '#f87171' }}>
                  {score}% health
                </span>
                <span style={{ fontSize: 12, color: 'rgba(255,255,255,.6)' }}>{healthy}/{total} passing</span>
                <span style={{ fontSize: 12, color: 'rgba(255,255,255,.6)' }}>{totalRecs.toLocaleString()} DB records</span>
                {avgMs > 0 && <span style={{ fontSize: 12, color: avgMs > 1000 ? '#fbbf24' : '#4ade80' }}>avg {avgMs}ms</span>}
              </div>
            )}
          </div>
        </div>

        <button
          className="sh-run"
          onClick={run}
          disabled={loading}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: '#fff', color: '#6B3FDB',
            border: 'none', borderRadius: 10, padding: '11px 22px',
            fontSize: 13, fontWeight: 700, cursor: loading ? 'wait' : 'pointer',
            transition: 'all .2s', boxShadow: '0 4px 16px rgba(0,0,0,.18)',
            whiteSpace: 'nowrap', zIndex: 1, flexShrink: 0,
          }}
        >
          {loading
            ? <RefreshCw size={14} style={{ animation: 'spin .8s linear infinite' }} />
            : <Wifi size={14} />}
          {loading ? `Testing… ${progress}%` : 'Run Connection Test'}
        </button>
      </div>

      {/* ══ PROGRESS BAR (visible while loading) ══════════════════════════ */}
      {loading && (
        <div style={{ background: '#fff', borderRadius: 12, padding: '14px 20px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 14, boxShadow: '0 1px 6px rgba(0,0,0,.06)', border: '1px solid #e9e4ff' }}>
          <div style={{ width: 30, height: 30, border: '3px solid #ede9fe', borderTopColor: '#6B3FDB', borderRadius: '50%', animation: 'spin .8s linear infinite', flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
              Reading database catalog — introspecting all tables…
            </div>
            <div style={{ height: 6, background: '#f1f5f9', borderRadius: 99, overflow: 'hidden' }}>
              <div style={{ height: '100%', borderRadius: 99, width: `${progress}%`, background: 'linear-gradient(90deg,#6B3FDB,#6366f1)', transition: 'width .3s ease' }} />
            </div>
          </div>
          <span style={{ fontSize: 16, fontWeight: 800, color: '#6B3FDB', minWidth: 42, textAlign: 'right' }}>{progress}%</span>
        </div>
      )}

      {/* ══ KPI CARDS (after test) ════════════════════════════════════════ */}
      {tested && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 12, marginBottom: 16, animation: 'fadeUp .4s ease' }}>
          {KPI.map(({ label, val, icon: Icon, color, bg }) => (
            <div key={label} style={{ background: '#fff', borderRadius: 12, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 10, boxShadow: '0 1px 5px rgba(0,0,0,.06)', border: '1px solid #e9e4ff' }}>
              <div style={{ background: bg, borderRadius: 9, padding: 8, flexShrink: 0 }}>
                <Icon size={16} color={color} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 2, whiteSpace: 'nowrap' }}>{label}</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#0f172a', lineHeight: 1 }}>{val}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ══ PROGRESS BARS (after test) ════════════════════════════════════ */}
      {tested && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
          {/* Connectivity */}
          <div style={{ background: '#fff', borderRadius: 12, padding: '14px 18px', boxShadow: '0 1px 5px rgba(0,0,0,.06)', border: '1px solid #e9e4ff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#334155' }}>Connectivity Health</span>
              <span style={{ fontSize: 12, fontWeight: 800, color: score >= 95 ? '#16a34a' : score >= 80 ? '#d97706' : '#dc2626' }}>{score}%</span>
            </div>
            <div style={{ height: 7, background: '#f1f5f9', borderRadius: 99, overflow: 'hidden', marginBottom: 8 }}>
              <div style={{ height: '100%', borderRadius: 99, width: `${score}%`, background: score >= 95 ? 'linear-gradient(90deg,#16a34a,#4ade80)' : score >= 80 ? 'linear-gradient(90deg,#d97706,#fbbf24)' : 'linear-gradient(90deg,#dc2626,#f87171)', transition: 'width 1.2s ease' }} />
            </div>
            <div style={{ display: 'flex', gap: 14, fontSize: 11, color: '#64748b' }}>
              <span><strong style={{ color: '#16a34a' }}>{healthy}</strong> passing</span>
              <span><strong style={{ color: '#dc2626' }}>{failing}</strong> failing</span>
              <span><strong style={{ color: '#4f46e5' }}>{authOk}</strong> auth</span>
            </div>
          </div>

          {/* Data Coverage */}
          <div style={{ background: '#fff', borderRadius: 12, padding: '14px 18px', boxShadow: '0 1px 5px rgba(0,0,0,.06)', border: '1px solid #e9e4ff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#334155' }}>Data Coverage</span>
              <span style={{ fontSize: 12, fontWeight: 800, color: '#0891b2' }}>{live200 > 0 ? Math.round((withRecords / live200) * 100) : 0}% populated</span>
            </div>
            <div style={{ height: 7, background: '#f1f5f9', borderRadius: 99, overflow: 'hidden', marginBottom: 8 }}>
              <div style={{ height: '100%', borderRadius: 99, display: 'flex', overflow: 'hidden' }}>
                {live200 > 0 && <>
                  <div style={{ width: `${(withRecords / live200) * 100}%`, background: 'linear-gradient(90deg,#16a34a,#4ade80)', transition: 'width 1.2s ease' }} />
                  <div style={{ width: `${(emptyTables / live200) * 100}%`, background: 'linear-gradient(90deg,#d97706,#fbbf24)', transition: 'width 1.2s ease' }} />
                </>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 14, fontSize: 11, color: '#64748b' }}>
              <span><strong style={{ color: '#16a34a' }}>{withRecords}</strong> with data</span>
              <span><strong style={{ color: '#d97706' }}>{emptyTables}</strong> empty</span>
              <span><strong style={{ color: '#0891b2' }}>{totalRecs.toLocaleString()}</strong> total records</span>
            </div>
          </div>
        </div>
      )}

      {/* ══ ISSUES PANEL (after test) ═════════════════════════════════════ */}
      {tested && <IssuesPanel errors={errors} empties={empties} />}

      {/* ══ EMPTY STATE (before first run) ═══════════════════════════════ */}
      {!tested && !loading && (
        <div style={{ background: '#fff', border: '2px dashed #ddd6fe', borderRadius: 16, textAlign: 'center', padding: '64px 32px', animation: 'fadeUp .3s ease' }}>
          <div style={{ background: 'linear-gradient(135deg,#f5f3ff,#ede9fe)', borderRadius: 20, width: 68, height: 68, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
            <Database size={30} color="#6B3FDB" />
          </div>
          <div style={{ fontSize: 18, fontWeight: 800, color: '#0f172a', marginBottom: 6 }}>Live Database Health Check</div>
          <div style={{ fontSize: 13, color: '#64748b', maxWidth: 420, margin: '0 auto 20px', lineHeight: 1.65 }}>
            Introspects the live database catalog — auto-discovers every table and inspects real record counts to confirm data is flowing. Newly created tables appear here automatically.
          </div>
          <button
            onClick={run}
            style={{ background: 'linear-gradient(135deg,#6B3FDB,#6366f1)', color: '#fff', border: 'none', borderRadius: 10, padding: '11px 24px', fontSize: 13, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8, boxShadow: '0 4px 16px rgba(107,63,219,.35)', transition: 'all .2s' }}
          >
            <Wifi size={14} /> Run Connection Test
          </button>
        </div>
      )}

      {/* ══ RESULTS TABLE ════════════════════════════════════════════════ */}
      {tested && !loading && (
        <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', overflow: 'hidden', boxShadow: '0 1px 8px rgba(0,0,0,.07)', animation: 'fadeUp .35s ease' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>

            {/* ── Column headers ── */}
            <thead>
              <tr style={{ background: '#f8f7ff', borderBottom: '2px solid #e9e4ff' }}>
                {[
                  { label: 'Status',       w: 86  },
                  { label: 'Department',   w: 110 },
                  { label: 'Module',       w: 170 },
                  { label: 'Table',        w: null },
                  { label: 'HTTP',         w: 60,  center: true },
                  { label: 'Time',         w: 80,  center: true },
                  { label: 'DB Records',   w: 100, center: true },
                  { label: 'Data Preview', w: 180 },
                ].map(({ label, w, center }) => (
                  <th key={label} style={{
                    padding: '9px 14px',
                    textAlign: center ? 'center' : 'left',
                    fontSize: 10, fontWeight: 700, color: '#94a3b8',
                    textTransform: 'uppercase', letterSpacing: '.07em',
                    whiteSpace: 'nowrap',
                    ...(w ? { width: w } : {}),
                  }}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>

            {/* ── Groups + rows ── */}
            <tbody>
              {orderedGroups.map(([group, rows]) => {
                const gLive  = rows.filter(r => getTier(r) === 'live').length;
                const gEmpty = rows.filter(r => getTier(r) === 'empty').length;
                const gAuth  = rows.filter(r => getTier(r) === 'auth').length;
                const gErr   = rows.filter(r => getTier(r) === 'error').length;
                const gRecs  = rows.reduce((s, r) => s + (r.records > 0 ? r.records : 0), 0);
                const isOpen = !collapsed[group];

                return (
                  <Fragment key={group}>
                    {/* ── Group header row ── */}
                    <tr
                      className="sh-grp"
                      onClick={() => toggleGroup(group)}
                      style={{ background: '#f1f5f9', borderTop: '2px solid #e2e8f0', borderBottom: isOpen ? '1px solid #e9e4ff' : '2px solid #e2e8f0' }}
                    >
                      <td colSpan={8} style={{ padding: '9px 16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          {isOpen
                            ? <ChevronDown size={13} color="#64748b" />
                            : <ChevronRight size={13} color="#64748b" />}
                          <GroupIcon name={group} />
                          <span style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>{group}</span>
                          <span style={{ fontSize: 11, color: '#94a3b8' }}>({rows.length})</span>
                          {gRecs > 0 && (
                            <span style={{ fontSize: 11, fontWeight: 600, color: '#0891b2' }}>
                              · {gRecs.toLocaleString()} records
                            </span>
                          )}
                          <div style={{ marginLeft: 'auto', display: 'flex', gap: 5, alignItems: 'center' }}>
                            {gErr   > 0 && <MiniTag bg="#fee2e2" color="#b91c1c">{gErr} error{gErr !== 1 ? 's' : ''}</MiniTag>}
                            {gEmpty > 0 && <MiniTag bg="#fef3c7" color="#92400e">{gEmpty} empty</MiniTag>}
                            {gAuth  > 0 && <MiniTag bg="#e0e7ff" color="#3730a3">{gAuth} auth</MiniTag>}
                            {gLive  > 0 && <MiniTag bg="#dcfce7" color="#15803d">{gLive} live</MiniTag>}
                            {gErr === 0 && gEmpty === 0 && (
                              <MiniTag bg="#dcfce7" color="#15803d">✓ All OK</MiniTag>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>

                    {/* ── Endpoint rows ── */}
                    {isOpen && rows.map((r, idx) => {
                      const tier = getTier(r);
                      const t    = TIER[tier];
                      const isLast = idx === rows.length - 1;

                      return (
                        <tr
                          key={`${group}-${idx}`}
                          className="sh-row"
                          style={{ borderBottom: isLast ? '2px solid #e2e8f0' : '1px solid #f1f5f9' }}
                        >
                          {/* Status */}
                          <td style={{ padding: '8px 14px', borderLeft: `3px solid ${t.dot}` }}>
                            <StatusPill tier={tier} />
                          </td>

                          {/* Department */}
                          <td style={{ padding: '8px 14px' }}>
                            <span style={{ fontSize: 11, fontWeight: 600, color: '#64748b', whiteSpace: 'nowrap' }}>
                              {group}
                            </span>
                          </td>

                          {/* Module */}
                          <td style={{ padding: '8px 14px', maxWidth: 170 }}>
                            <span style={{ display: 'block', fontWeight: 600, color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {r.module}
                            </span>
                          </td>

                          {/* Endpoint */}
                          <td style={{ padding: '8px 14px' }}>
                            <span style={{ display: 'block', fontFamily: 'ui-monospace,monospace', fontSize: 11, color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>
                              {r.url}
                            </span>
                          </td>

                          {/* HTTP */}
                          <td style={{ padding: '8px 14px', textAlign: 'center' }}>
                            <HttpBadge status={r.status} />
                          </td>

                          {/* Time */}
                          <td style={{ padding: '8px 14px', textAlign: 'center' }}>
                            <TimePill ms={r.ms} />
                          </td>

                          {/* DB Records */}
                          <td style={{ padding: '8px 14px', textAlign: 'center' }}>
                            <RecordsPill records={tier === 'error' || tier === 'auth' ? null : r.records} />
                          </td>

                          {/* Data Preview */}
                          <td style={{ padding: '8px 14px', maxWidth: 180 }}>
                            {r.dataSnippet ? (
                              <span style={{ color: '#334155', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                                {r.dataSnippet}
                              </span>
                            ) : (
                              <span style={{ fontSize: 11, fontStyle: 'italic', color: tier === 'error' ? '#dc2626' : '#94a3b8' }}>
                                {tier === 'error'  ? (r.error || `HTTP ${r.status}`) :
                                 tier === 'empty'  ? 'No records yet' :
                                 tier === 'auth'   ? 'Auth required' : '—'}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ══ LEGEND ══════════════════════════════════════════════════════════ */}
      {tested && !loading && (
        <div style={{ background: '#fff', borderRadius: 12, padding: '10px 18px', marginTop: 10, display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap', boxShadow: '0 1px 4px rgba(0,0,0,.05)', border: '1px solid #e9e4ff' }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.07em' }}>Legend</span>
          {Object.entries(TIER).map(([tier, t]) => (
            <div key={tier} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: t.dot, display: 'inline-block' }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: t.pillTxt }}>{t.label}</span>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>
                {tier === 'live'  && '— Connected, data flowing'}
                {tier === 'empty' && '— Connected, no records yet'}
                {tier === 'auth'  && '— 401/403 protected route'}
                {tier === 'error' && '— Failed / Timeout / Missing'}
              </span>
            </div>
          ))}
          <span style={{ fontSize: 11, color: '#94a3b8', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Database size={10} style={{ display: 'inline' }} />
            DB Records are catalog estimates (approximate)
          </span>
          <div style={{ marginLeft: 'auto', fontSize: 11, color: '#94a3b8', whiteSpace: 'nowrap' }}>
            <TrendingUp size={10} style={{ display: 'inline', marginRight: 4 }} />
            Time: <span style={{ color: '#16a34a', fontWeight: 700 }}>green &lt;800ms</span>
            {' · '}<span style={{ color: '#d97706', fontWeight: 700 }}>amber 800ms–2s</span>
            {' · '}<span style={{ color: '#dc2626', fontWeight: 700 }}>red &gt;2s</span>
          </div>
        </div>
      )}
    </div>
  );
}
