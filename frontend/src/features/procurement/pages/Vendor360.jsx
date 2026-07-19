import { useState, useEffect, useCallback, useRef } from 'react';
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, LineChart, Line,
} from 'recharts';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import VendorProjectImpact  from './VendorProjectImpact';
import VendorRiskPanel      from './VendorRiskPanel';
import VendorHealthWidget   from './VendorHealthWidget';
import VendorHealthTrend    from './VendorHealthTrend';

// ── Formatters ─────────────────────────────────────────────────────────────────
const fmtINR = n => {
  const v = parseFloat(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)} Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(2)} L`;
  if (v >= 1000)     return `₹${(v / 1000).toFixed(1)}K`;
  return `₹${v.toLocaleString('en-IN')}`;
};
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
const fmtPct  = v => v != null ? `${v}%` : '—';

// ── Design tokens ──────────────────────────────────────────────────────────────
const C = {
  primary: '#6B3FDB', light: '#f5f3ff', border: '#e9e4ff',
  green:   '#16a34a', red:   '#dc2626', amber:  '#d97706', blue:  '#2563eb',
  card: { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12 },
};

// ── Micro components ───────────────────────────────────────────────────────────
function Badge({ label, color = C.primary, bg = C.light }) {
  return (
    <span style={{ padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600, color, background: bg }}>
      {label}
    </span>
  );
}

function KpiCard({ label, value, sub, color = '#111827', warn }) {
  return (
    <div style={{ ...C.card, padding: '14px 16px', borderTop: warn ? `3px solid ${C.red}` : `3px solid transparent` }}>
      <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color }}>{value ?? '—'}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function EmptyState({ icon = '📭', msg = 'No data available' }) {
  return (
    <div style={{ padding: '48px 20px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
      <div style={{ fontSize: 38, marginBottom: 10 }}>{icon}</div>
      {msg}
    </div>
  );
}

function SectionCard({ title, children, action }) {
  return (
    <div style={{ ...C.card, overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px', borderBottom: `1px solid ${C.border}`, fontWeight: 700, fontSize: 14, color: '#111827', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        {title}
        {action}
      </div>
      {children}
    </div>
  );
}

function Table({ headers, rows, emptyMsg }) {
  if (!rows?.length) return <EmptyState msg={emptyMsg || 'No records found'} />;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: '#fafafa' }}>
            {headers.map(h => (
              <th key={h} style={{ padding: '8px 14px', fontSize: 11, fontWeight: 700, color: '#6b7280', textAlign: 'left', textTransform: 'uppercase', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}

function TD({ children, bold, primary, right }) {
  return (
    <td style={{ padding: '9px 14px', fontSize: 12, color: primary ? C.primary : bold ? '#111827' : '#374151', fontWeight: bold || primary ? 700 : 400, borderBottom: '1px solid #f8f8fc', textAlign: right ? 'right' : 'left' }}>
      {children}
    </td>
  );
}

function ScoreGauge({ label, score, color, maxScore = 100 }) {
  const pct  = Math.min((score / maxScore) * 100, 100);
  const circ = 2 * Math.PI * 32;
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ position: 'relative', width: 80, height: 80, margin: '0 auto 8px' }}>
        <svg width="80" height="80" viewBox="0 0 80 80">
          <circle cx="40" cy="40" r="32" fill="none" stroke="#f0f0f4" strokeWidth="8" />
          <circle cx="40" cy="40" r="32" fill="none" stroke={color} strokeWidth="8"
            strokeDasharray={`${(pct / 100) * circ} ${circ}`}
            strokeLinecap="round" transform="rotate(-90 40 40)" />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 800, color }}>
          {Math.round(score)}
        </div>
      </div>
      <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600 }}>{label}</div>
    </div>
  );
}

function ComplianceRow({ doc, done }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid #f8f8fc', fontSize: 13 }}>
      <span style={{ fontSize: 16, color: done ? C.green : '#d1d5db' }}>{done ? '✓' : '☐'}</span>
      <span style={{ color: done ? '#111827' : '#9ca3af', fontWeight: done ? 600 : 400 }}>{doc}</span>
      <span style={{ marginLeft: 'auto', fontSize: 11 }}>
        {done
          ? <Badge label="Complete" color={C.green} bg="#dcfce7" />
          : <Badge label="Pending" color={C.amber} bg="#fef3c7" />}
      </span>
    </div>
  );
}

// ── Timeline ───────────────────────────────────────────────────────────────────
const ICON_MAP = {
  building: '🏭', package: '📦', 'check-circle': '✅', 'alert-triangle': '⚠️',
  'file-text': '💰', star: '⭐', mail: '📧', registration: '📋',
  first_po: '🎯', po: '📦', grn: '✅', ncr: '⚠️', bill: '💰', scorecard: '⭐', rfq: '📧',
};
const TYPE_COLOR = {
  registration: '#6B3FDB', first_po: '#0891b2', po: '#2563eb', grn: '#16a34a',
  ncr: '#dc2626', bill: '#d97706', scorecard: '#0891b2', rfq: '#6b7280',
};

function TimelineView({ events }) {
  const [shown, setShown] = useState(20);
  if (!events?.length) return <EmptyState icon="📅" msg="No timeline events" />;
  return (
    <div style={{ position: 'relative', paddingLeft: 44 }}>
      <div style={{ position: 'absolute', left: 20, top: 0, bottom: 0, width: 2, background: C.border }} />
      {events.slice(0, shown).map((ev, i) => (
        <div key={i} style={{ position: 'relative', marginBottom: 10 }}>
          <div style={{ position: 'absolute', left: -32, top: 6, width: 24, height: 24, borderRadius: '50%', background: TYPE_COLOR[ev.type] || '#6b7280', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, zIndex: 1, border: '2px solid #fff', boxShadow: '0 1px 4px rgba(0,0,0,.1)' }}>
            {ICON_MAP[ev.icon] || ICON_MAP[ev.type] || '📌'}
          </div>
          <div style={{ ...C.card, padding: '10px 14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{ev.title}</span>
                {ev.amount > 0 && <span style={{ fontSize: 12, fontWeight: 700, color: C.primary }}>{fmtINR(ev.amount)}</span>}
                {ev.status && <Badge label={ev.status} color={ev.status === 'closed' || ev.status === 'completed' ? C.green : '#6b7280'} bg={ev.status === 'closed' ? '#dcfce7' : '#f3f4f6'} />}
              </div>
              <span style={{ fontSize: 11, color: '#9ca3af', flexShrink: 0 }}>{fmtDate(ev.date)}</span>
            </div>
            {ev.description && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>{ev.description}</div>}
          </div>
        </div>
      ))}
      {shown < events.length && (
        <button onClick={() => setShown(s => Math.min(s + 20, events.length))} style={{ padding: '7px 18px', border: `1px solid ${C.border}`, borderRadius: 8, background: C.light, color: C.primary, fontWeight: 600, cursor: 'pointer', fontSize: 12 }}>
          Load More ({events.length - shown} remaining)
        </button>
      )}
    </div>
  );
}

// ── Drive folder structure ─────────────────────────────────────────────────────
function DriveStructure({ docs }) {
  if (!docs) return <EmptyState icon="📁" msg="No document structure available" />;
  return (
    <div>
      <div style={{ padding: '14px 18px', background: C.light, borderRadius: 10, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 22 }}>📁</span>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>Google Drive Root</div>
          <div style={{ fontSize: 12, color: '#6b7280', fontFamily: 'monospace' }}>{docs.root}</div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
        {(docs.folders || []).map(f => (
          <div key={f.id} style={{ ...C.card, padding: '14px 16px', display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}
            onMouseEnter={e => e.currentTarget.style.boxShadow = '0 4px 12px rgba(107,63,219,.12)'}
            onMouseLeave={e => e.currentTarget.style.boxShadow = 'none'}
          >
            <span style={{ fontSize: 22, flexShrink: 0 }}>📂</span>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#111827' }}>{f.name}</div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>{f.description}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Scorecard Tab ──────────────────────────────────────────────────────────────
const SCORE_WEIGHTS = [
  { key: 'quality_score',    label: 'Quality',     weight: 30, color: '#6B3FDB' },
  { key: 'delivery_score',   label: 'Delivery',    weight: 25, color: '#2563eb' },
  { key: 'cost_score',       label: 'Cost',        weight: 15, color: '#16a34a' },
  { key: 'support_score',    label: 'Support',     weight: 15, color: '#d97706' },
  { key: 'compliance_score', label: 'Compliance',  weight: 15, color: '#0891b2' },
];
const CLASSIFICATION_CFG = {
  Preferred: { color: '#16a34a', bg: '#dcfce7', icon: '🌟' },
  Approved:  { color: '#2563eb', bg: '#dbeafe', icon: '✅' },
  Watchlist: { color: '#d97706', bg: '#fef3c7', icon: '⚠️' },
  Blocked:   { color: '#dc2626', bg: '#fee2e2', icon: '🚫' },
};

function ScorecardTab({ scorecard, onScore }) {
  if (!scorecard || scorecard.overall_score === 0) {
    return (
      <div style={{ ...C.card, padding: 48, textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
        <div style={{ fontWeight: 700, color: '#374151', fontSize: 15, marginBottom: 6 }}>No Scorecard Yet</div>
        <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 20 }}>Click "Score Vendor" to record the first evaluation.</div>
        <button onClick={onScore} style={{ padding: '9px 22px', background: C.primary, color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
          Score Vendor
        </button>
      </div>
    );
  }

  const cls = scorecard.classification || 'Approved';
  const clsCfg = CLASSIFICATION_CFG[cls] || CLASSIFICATION_CFG.Approved;
  const radarData = SCORE_WEIGHTS.map(w => ({ subject: w.label, A: parseFloat(scorecard[w.key] || 0) }));
  const barData   = SCORE_WEIGHTS.map(w => ({
    name:     w.label,
    raw:      parseFloat(scorecard[w.key] || 0),
    weighted: Math.round(parseFloat(scorecard[w.key] || 0) * (w.weight / 100)),
    weight:   w.weight,
    color:    w.color,
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Classification Banner */}
      <div style={{ padding: '20px 24px', borderRadius: 12, background: clsCfg.bg, border: `1px solid ${clsCfg.color}33`, display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 40 }}>{clsCfg.icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: clsCfg.color }}>{cls} Supplier</div>
          <div style={{ fontSize: 13, color: clsCfg.color, opacity: 0.8 }}>
            {{
              Preferred:  'Top-tier vendor — preferred for all orders',
              Approved:   'Approved for standard procurement',
              Watchlist:  'Under monitoring — improvement required',
              Blocked:    'Do not issue new orders without approval',
            }[cls]}
          </div>
          {scorecard.scored_at && (
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Last scored: {fmtDate(scorecard.scored_at)}</div>
          )}
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 48, fontWeight: 900, color: clsCfg.color, lineHeight: 1 }}>{Math.round(scorecard.overall_score)}</div>
          <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600 }}>/ 100</div>
        </div>
      </div>

      {/* Gauges + Radar */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div style={{ ...C.card, padding: 24 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 20 }}>Dimension Scores</div>
          <div style={{ display: 'flex', justifyContent: 'space-around', marginBottom: 16 }}>
            {SCORE_WEIGHTS.map(w => (
              <ScoreGauge key={w.key} label={w.label} score={parseFloat(scorecard[w.key] || 0)} color={w.color} />
            ))}
          </div>
        </div>

        <div style={{ ...C.card, padding: 24 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 8 }}>Radar Profile</div>
          <ResponsiveContainer width="100%" height={160}>
            <RadarChart data={radarData}>
              <PolarGrid />
              <PolarAngleAxis dataKey="subject" tick={{ fontSize: 11 }} />
              <Radar dataKey="A" stroke={C.primary} fill={C.primary} fillOpacity={0.2} />
            </RadarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Weighted breakdown table */}
      <SectionCard title="Weighted Score Breakdown">
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#fafafa' }}>
                {['Dimension', 'Weight', 'Raw Score', 'Weighted Points', 'Bar'].map(h => (
                  <th key={h} style={{ padding: '8px 16px', fontSize: 11, fontWeight: 700, color: '#6b7280', textAlign: 'left', borderBottom: '1px solid #f0f0f4', textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {barData.map(row => (
                <tr key={row.name} style={{ borderBottom: '1px solid #f8f8fc' }}>
                  <TD bold>{row.name}</TD>
                  <TD>{row.weight}%</TD>
                  <TD><span style={{ fontWeight: 700, color: row.color }}>{row.raw.toFixed(1)}</span></TD>
                  <TD bold>{row.weighted} pts</TD>
                  <td style={{ padding: '9px 14px' }}>
                    <div style={{ width: 120, height: 8, background: '#f0f0f4', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${(row.raw / 100) * 100}%`, background: row.color, borderRadius: 4 }} />
                    </div>
                  </td>
                </tr>
              ))}
              <tr style={{ background: C.light }}>
                <td colSpan={3} style={{ padding: '10px 16px', fontSize: 13, fontWeight: 700, color: '#111827' }}>Overall Score (Weighted)</td>
                <TD bold><span style={{ color: clsCfg.color, fontSize: 16 }}>{Math.round(scorecard.overall_score)} / 100</span></TD>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </SectionCard>

      {/* Scoring formula note */}
      <div style={{ padding: '12px 16px', background: '#fafafa', borderRadius: 8, fontSize: 12, color: '#6b7280', border: '1px solid #f0f0f4' }}>
        <strong style={{ color: '#374151' }}>Scoring Formula:</strong> Quality (30%) + Delivery (25%) + Cost (15%) + Support (15%) + Compliance (15%) = 100 points.
        {scorecard.source === 'computed' && ' Score is auto-computed from live quality/delivery/finance data.'}
        {scorecard.source === 'stored'   && ' Score is from the last manual evaluation.'}
      </div>
    </div>
  );
}

// ── Score Form ─────────────────────────────────────────────────────────────────
function ScoreForm({ vendorId, onSaved, onCancel }) {
  const [form, setForm] = useState({ quality_score: 70, delivery_score: 70, cost_score: 70, support_score: 70, compliance_score: 70, notes: '' });
  const [saving, setSaving] = useState(false);

  const overall = Math.round(
    form.quality_score * 0.30 + form.delivery_score * 0.25 +
    form.cost_score * 0.15 + form.support_score * 0.15 + form.compliance_score * 0.15
  );
  const cls = overall >= 80 ? 'Preferred' : overall >= 60 ? 'Approved' : overall >= 40 ? 'Watchlist' : 'Blocked';

  const save = async () => {
    setSaving(true);
    try {
      await api.post(`/vendor-360/${vendorId}/scorecard`, form);
      onSaved();
    } catch { /* silent */ } finally { setSaving(false); }
  };

  return (
    <div style={{ padding: 16, background: C.light, borderRadius: 10, marginBottom: 12 }}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 14, color: '#374151' }}>
        Vendor Scorecard (0–100 per dimension) → Overall: <span style={{ color: CLASSIFICATION_CFG[cls]?.color }}>{overall}/100 — {cls}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 12 }}>
        {SCORE_WEIGHTS.map(w => (
          <div key={w.key}>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>{w.label} ({w.weight}%)</div>
            <input type="number" min={0} max={100} step={5} value={form[w.key]}
              onChange={e => setForm(f => ({ ...f, [w.key]: parseFloat(e.target.value) || 0 }))}
              style={{ width: '100%', padding: '6px 8px', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14, fontWeight: 700, textAlign: 'center', boxSizing: 'border-box' }} />
          </div>
        ))}
      </div>
      <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
        placeholder="Notes (optional)" style={{ width: '100%', padding: '7px 10px', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, marginBottom: 10, boxSizing: 'border-box' }} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={save} disabled={saving} style={{ padding: '7px 18px', background: C.primary, color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: saving ? 0.7 : 1 }}>
          {saving ? 'Saving…' : 'Save Score'}
        </button>
        <button onClick={onCancel} style={{ padding: '7px 16px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
      </div>
    </div>
  );
}

// ── Main tabs ──────────────────────────────────────────────────────────────────
const TABS = ['Overview', 'Commercial', 'Quality', 'Projects', 'Inventory', 'Finance', 'Documents', 'Scorecard', 'Health', 'Health Trend', 'Timeline', 'Risk'];

export default function Vendor360() {
  const toast = useToast();
  const [vendors,     setVendors]     = useState([]);
  const [selectedId,  setSelectedId]  = useState(null);
  const [data,        setData]        = useState(null);
  const [listLoading, setListLoading] = useState(true);
  const [loading,     setLoading]     = useState(false);
  const [tab,         setTab]         = useState('Overview');
  const [search,      setSearch]      = useState('');
  const [timelineEvents, setTimelineEvents] = useState(null);
  const [riskData,    setRiskData]    = useState(null);
  const [showScoreForm, setShowScoreForm] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // ── Load vendor list ───────────────────────────────────────────────────────
  const loadVendors = useCallback(async () => {
    setListLoading(true);
    try {
      const res = await api.get('/vendor-360', { params: { search: search || undefined } });
      if (!mountedRef.current) return;
      const rows = Array.isArray(res.data) ? res.data : [];
      setVendors(rows);
      if (!selectedId && rows.length > 0) setSelectedId(rows[0].id);
    } catch { if (mountedRef.current) setVendors([]); }
    finally  { if (mountedRef.current) setListLoading(false); }
  }, [search]);

  // ── Load single vendor (full 360) ─────────────────────────────────────────
  const loadVendor = useCallback(async (id) => {
    if (!id) return;
    setLoading(true);
    setData(null);
    setTimelineEvents(null);
    setRiskData(null);
    try {
      const res = await api.get(`/vendor-360/${id}`);
      if (mountedRef.current) setData(res.data);
    } catch { if (mountedRef.current) setData(null); }
    finally  { if (mountedRef.current) setLoading(false); }
  }, []);

  // ── Lazy-load timeline ─────────────────────────────────────────────────────
  useEffect(() => {
    if (tab === 'Timeline' && selectedId && !timelineEvents) {
      api.get(`/vendor-360/${selectedId}/timeline`)
        .then(r => { if (mountedRef.current) setTimelineEvents(r.data); })
        .catch(() => { if (mountedRef.current) setTimelineEvents([]); });
    }
  }, [tab, selectedId, timelineEvents]);

  // ── Lazy-load risk ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (tab === 'Risk' && selectedId && !riskData) {
      api.get(`/vendor-360/${selectedId}/risk`)
        .then(r => { if (mountedRef.current) setRiskData(r.data); })
        .catch(() => { if (mountedRef.current) toast.error('Could not load vendor risk data'); });
    }
  }, [tab, selectedId, riskData]);

  useEffect(() => { loadVendors(); }, [loadVendors]);
  useEffect(() => { if (selectedId) { setTab('Overview'); loadVendor(selectedId); } }, [selectedId, loadVendor]);

  // ── Derived from data ──────────────────────────────────────────────────────
  const v  = data?.vendor         || {};
  const reg = data?.registration  || {};
  const proc = data?.procurement  || {};
  const del  = data?.delivery     || {};
  const qual = data?.quality      || {};
  const inv  = data?.inventory    || {};
  const proj = data?.projects     || {};
  const fin  = data?.finance      || {};
  const docs = data?.documents    || null;
  const sc   = data?.scorecard    || {};
  const health = data?.health     || {};

  const statusBadge = s => {
    const m = { Active: { bg: '#dcfce7', c: C.green }, approved: { bg: '#dcfce7', c: C.green }, Blacklisted: { bg: '#fee2e2', c: C.red }, Suspended: { bg: '#fef3c7', c: C.amber } };
    const cfg = m[s] || { bg: '#f3f4f6', c: '#6b7280' };
    return <Badge label={s || 'Unknown'} color={cfg.c} bg={cfg.bg} />;
  };

  // ── Action buttons ─────────────────────────────────────────────────────────
  const actionBtn = (label, onClick) => (
    <button key={label} onClick={onClick} style={{ padding: '6px 14px', border: `1px solid ${C.border}`, borderRadius: 8, background: '#fff', color: '#374151', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}
      onMouseEnter={e => e.currentTarget.style.borderColor = C.primary}
      onMouseLeave={e => e.currentTarget.style.borderColor = C.border}
    >{label}</button>
  );

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 60px)', fontFamily: 'inherit', overflow: 'hidden' }}>

      {/* ── Left Panel: Vendor List ──────────────────────────────────────────── */}
      <div style={{ width: 280, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 }}>
        <div style={{ padding: '16px 14px 12px', borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#111827', marginBottom: 10 }}>Vendor 360°</div>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && loadVendors()}
            placeholder="Search vendors…"
            style={{ width: '100%', padding: '7px 12px', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, boxSizing: 'border-box', outline: 'none' }}
          />
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {listLoading ? <div style={{ padding: 20, color: '#9ca3af', textAlign: 'center', fontSize: 13 }}>Loading…</div> : (
            vendors.map(vv => (
              <div key={vv.id} onClick={() => setSelectedId(vv.id)}
                style={{ padding: '12px 14px', borderBottom: `1px solid ${C.border}`, cursor: 'pointer', background: selectedId === vv.id ? C.light : '#fff', borderLeft: selectedId === vv.id ? `3px solid ${C.primary}` : '3px solid transparent' }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: '#111827', marginBottom: 2 }}>{vv.name}</div>
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>{vv.vendor_code} · {vv.vendor_type || vv.category || 'Vendor'}</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {vv.po_value > 0 && <span style={{ fontSize: 11, color: C.primary, fontWeight: 600 }}>{fmtINR(vv.po_value)}</span>}
                  {vv.po_count > 0 && <span style={{ fontSize: 10, color: '#9ca3af' }}>{vv.po_count} POs</span>}
                  {vv.score > 0 && <span style={{ fontSize: 11, background: '#fef3c7', color: '#92400e', padding: '1px 6px', borderRadius: 8, fontWeight: 600 }}>★ {parseFloat(vv.score).toFixed(1)}</span>}
                </div>
              </div>
            ))
          )}
          {!listLoading && !vendors.length && (
            <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No vendors found</div>
          )}
        </div>
      </div>

      {/* ── Right Panel ─────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {!selectedId ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>
            <div style={{ textAlign: 'center' }}><div style={{ fontSize: 48, marginBottom: 12 }}>🏭</div><div style={{ fontWeight: 600 }}>Select a vendor</div></div>
          </div>
        ) : loading ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>Loading vendor data…</div>
        ) : !data ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.red }}>Failed to load vendor</div>
        ) : (
          <>
            {/* ── Header ──────────────────────────────────────────────────────── */}
            <div style={{ padding: '18px 24px 0', background: '#fff', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
              {/* Row 1: Name + actions */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#111827' }}>{v.name}</h2>
                    {v.vendor_code && <span style={{ fontSize: 13, color: '#6b7280', fontWeight: 600, fontFamily: 'monospace' }}>{v.vendor_code}</span>}
                    {statusBadge(v.status)}
                    {reg.msme_status && <Badge label={reg.msme_status} color={C.green} bg="#dcfce7" />}
                    {reg.iso_certificates && reg.iso_certificates !== '[]' && reg.iso_certificates !== '' && (
                      <Badge label="ISO Certified" color="#0891b2" bg="#e0f2fe" />
                    )}
                    {health?.label && (
                      <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 700, color: health.color, background: `${health.color}18`, border: `1px solid ${health.color}44` }}>
                        {health.label} · {health.score}%
                      </span>
                    )}
                  </div>
                  {v.category && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>{v.category}</div>}
                </div>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  {actionBtn('+ Score Vendor', () => setShowScoreForm(f => !f))}
                  {actionBtn('Create RFQ', () => {})}
                  {actionBtn('Create PO', () => {})}
                  {actionBtn('Raise NCR', () => {})}
                  {actionBtn('Vendor Portal', () => {})}
                </div>
              </div>

              {showScoreForm && (
                <ScoreForm vendorId={selectedId}
                  onSaved={() => { setShowScoreForm(false); loadVendor(selectedId); }}
                  onCancel={() => setShowScoreForm(false)}
                />
              )}

              {/* Row 2: 8 KPI Header Cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginBottom: 14 }}>
                <KpiCard label="Total Spend"      value={fmtINR(proc.summary?.total_po_value)}      color={C.primary} />
                <KpiCard label="Outstanding"      value={fmtINR(fin.summary?.outstanding_amount)}    color={fin.summary?.outstanding_amount > 0 ? C.amber : C.green} />
                <KpiCard label="Open PO Value"    value={fmtINR(proc.summary?.open_po_value)}        color={C.blue} />
                <KpiCard label="On-Time Delivery" value={fmtPct(del.summary?.on_time_delivery_percent)} color={parseFloat(del.summary?.on_time_delivery_percent || 0) >= 80 ? C.green : C.amber} />
                <KpiCard label="Overall Score"    value={sc.overall_score > 0 ? `${Math.round(sc.overall_score)}/100` : '—'} color={sc.overall_score >= 80 ? C.green : sc.overall_score >= 60 ? C.blue : C.amber} />
                <KpiCard label="Open NCRs"        value={qual.summary?.open_ncr || 0}               color={(qual.summary?.open_ncr || 0) > 0 ? C.red : C.green} warn={(qual.summary?.open_ncr || 0) > 0} />
                <KpiCard label="Open CAPAs"       value={qual.summary?.open_capa || 0}              color={(qual.summary?.open_capa || 0) > 0 ? C.amber : C.green} />
                <KpiCard label="Projects"         value={proj.summary?.projects_count || 0}         color={C.primary} sub={proj.summary?.active_projects > 0 ? `${proj.summary.active_projects} active` : undefined} />
              </div>

              {/* Tabs */}
              <div style={{ display: 'flex', gap: 2, overflowX: 'auto', paddingBottom: 1 }}>
                {TABS.map(t => (
                  <button key={t} onClick={() => setTab(t)} style={{ padding: '8px 14px', border: 'none', background: tab === t ? C.light : 'transparent', cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', color: tab === t ? C.primary : '#6b7280', borderBottom: tab === t ? `2px solid ${C.primary}` : '2px solid transparent', marginBottom: -1, borderRadius: '6px 6px 0 0' }}>
                    {t}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Tab Content ──────────────────────────────────────────────────── */}
            <div style={{ flex: 1, padding: 24, minHeight: 0 }}>

              {/* ─── OVERVIEW ─────────────────────────────────────────────────── */}
              {tab === 'Overview' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                    {/* Vendor Profile */}
                    <SectionCard title="Vendor Profile">
                      <div style={{ padding: '4px 18px 12px' }}>
                        {[
                          ['GST',           reg.gstin],
                          ['PAN',           reg.pan],
                          ['Email',         v.email],
                          ['Phone',         v.phone],
                          ['Location',      [v.city, v.state].filter(Boolean).join(', ')],
                          ['Payment Terms', v.payment_terms],
                          ['Credit Limit',  v.credit_limit > 0 ? fmtINR(v.credit_limit) : null],
                          ['Products',      v.products_services],
                          ['Bank',          reg.bank_name],
                          ['IFSC',          reg.ifsc],
                          ['MSME',          reg.msme_status],
                          ['ISO',           reg.iso_certificates ? 'Certified' : null],
                        ].filter(([, v]) => v).map(([k, val]) => (
                          <div key={k} style={{ display: 'flex', padding: '5px 0', borderBottom: '1px solid #f9f9fb', gap: 8 }}>
                            <span style={{ width: 110, fontSize: 12, color: '#6b7280', flexShrink: 0 }}>{k}</span>
                            <span style={{ fontSize: 12, color: '#111827', fontWeight: 500, wordBreak: 'break-word' }}>{val}</span>
                          </div>
                        ))}
                      </div>
                    </SectionCard>

                    {/* Health + Scorecard */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                      {health?.score > 0 && (
                        <SectionCard title="Vendor Health">
                          <div style={{ padding: '16px 20px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 14 }}>
                              <div style={{ position: 'relative', width: 72, height: 72 }}>
                                <svg width="72" height="72" viewBox="0 0 72 72">
                                  <circle cx="36" cy="36" r="28" fill="none" stroke="#f0f0f4" strokeWidth="8" />
                                  <circle cx="36" cy="36" r="28" fill="none" stroke={health.color}
                                    strokeWidth="8" strokeDasharray={`${(health.score / 100) * 175.9} 175.9`}
                                    strokeLinecap="round" transform="rotate(-90 36 36)" />
                                </svg>
                                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 800, color: health.color }}>{health.score}</div>
                              </div>
                              <div>
                                <div style={{ fontSize: 18, fontWeight: 800, color: health.color }}>{health.label}</div>
                                <div style={{ fontSize: 12, color: '#6b7280' }}>Vendor health score</div>
                              </div>
                            </div>
                            {health.breakdown && (
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                                {Object.entries(health.breakdown).map(([k, val]) => (
                                  <div key={k} style={{ fontSize: 12 }}>
                                    <span style={{ color: '#9ca3af', textTransform: 'capitalize' }}>{k.replace(/_/g, ' ')}:</span>
                                    <span style={{ fontWeight: 700, color: '#374151', marginLeft: 4 }}>{typeof val === 'number' ? Math.round(val) : val}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </SectionCard>
                      )}

                      {/* Quick stats */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        <KpiCard label="Total POs"       value={proc.summary?.awarded_orders || 0} />
                        <KpiCard label="Open POs"        value={proc.summary?.open_pos || 0}       color={C.blue} />
                        <KpiCard label="Total GRNs"      value={del.summary?.total_grns || 0} />
                        <KpiCard label="Total Bills"     value={fin.summary?.total_bills || 0} />
                      </div>
                    </div>
                  </div>

                  {/* Contacts */}
                  {data.contacts?.length > 0 && (
                    <SectionCard title="Contacts">
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12, padding: 16 }}>
                        {data.contacts.map((c, i) => (
                          <div key={i} style={{ ...C.card, padding: 14, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                            <div style={{ width: 36, height: 36, borderRadius: 18, background: C.primary, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 15, flexShrink: 0 }}>
                              {(c.contact_name || c.name || 'V')[0].toUpperCase()}
                            </div>
                            <div>
                              <div style={{ fontWeight: 700, fontSize: 13, color: '#111827' }}>{c.contact_name || c.name || '—'}</div>
                              <div style={{ fontSize: 12, color: '#6b7280' }}>{c.designation || c.role || 'Contact'}</div>
                              {c.email && <div style={{ fontSize: 11, color: '#374151', marginTop: 3 }}>📧 {c.email}</div>}
                              {c.phone && <div style={{ fontSize: 11, color: '#374151' }}>📞 {c.phone || c.mobile}</div>}
                              {c.is_primary && <Badge label="Primary" color={C.primary} bg={C.light} />}
                            </div>
                          </div>
                        ))}
                      </div>
                    </SectionCard>
                  )}
                </div>
              )}

              {/* ─── COMMERCIAL ───────────────────────────────────────────────── */}
              {tab === 'Commercial' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 14 }}>
                    <KpiCard label="Total PO Value"    value={fmtINR(proc.summary?.total_po_value)}    color={C.primary} />
                    <KpiCard label="Open PO Value"     value={fmtINR(proc.summary?.open_po_value)}     color={C.blue} />
                    <KpiCard label="Avg Order Value"   value={fmtINR(proc.summary?.average_order_value)} />
                    <KpiCard label="POs Awarded"       value={proc.summary?.awarded_orders || 0} />
                    <KpiCard label="Open POs"          value={proc.summary?.open_pos || 0}          color={C.blue} />
                    <KpiCard label="Closed POs"        value={proc.summary?.closed_pos || 0}        color={C.green} />
                    <KpiCard label="RFQs"              value={proc.summary?.rfq_count || 0} />
                    <KpiCard label="RFQ Wins"          value={proc.summary?.rfq_wins || 0}          color={C.green} />
                  </div>

                  <SectionCard title="Recent Purchase Orders">
                    <Table
                      headers={['PO Number', 'Order Date', 'Amount', 'Status', 'Delivery Date']}
                      emptyMsg="No purchase orders yet"
                      rows={(proc.purchase_orders || []).map((po, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #f9f9fb' }}>
                          <TD primary>{po.po_number || '—'}</TD>
                          <TD>{fmtDate(po.order_date)}</TD>
                          <TD bold>{fmtINR(po.total_amount_inr || po.amount)}</TD>
                          <td style={{ padding: '8px 12px' }}>
                            <Badge label={po.status || '—'} color={po.status === 'Received' ? C.green : po.status === 'Approved' ? C.blue : '#374151'} bg={po.status === 'Received' ? '#dcfce7' : po.status === 'Approved' ? '#dbeafe' : '#f3f4f6'} />
                          </td>
                          <TD>{fmtDate(po.expected_delivery_date || po.delivery_date)}</TD>
                        </tr>
                      ))}
                    />
                  </SectionCard>

                  {(proc.rfqs || []).length > 0 && (
                    <SectionCard title="RFQ History">
                      <Table
                        headers={['RFQ Number', 'Date', 'Required By', 'Quote Value', 'Delivery Days', 'Winner']}
                        emptyMsg="No RFQs"
                        rows={(proc.rfqs || []).map((r, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid #f9f9fb' }}>
                            <TD primary>{r.rfq_number || `RFQ-${r.id}`}</TD>
                            <TD>{fmtDate(r.created_at)}</TD>
                            <TD>{fmtDate(r.required_by)}</TD>
                            <TD bold>{fmtINR(r.total_amount)}</TD>
                            <TD>{r.delivery_days ? `${r.delivery_days}d` : '—'}</TD>
                            <td style={{ padding: '8px 12px' }}>
                              {r.is_winner ? <Badge label="Winner" color={C.green} bg="#dcfce7" /> : <span style={{ color: '#9ca3af', fontSize: 12 }}>—</span>}
                            </td>
                          </tr>
                        ))}
                      />
                    </SectionCard>
                  )}
                </div>
              )}

              {/* ─── QUALITY ──────────────────────────────────────────────────── */}
              {tab === 'Quality' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 14 }}>
                    <KpiCard label="Total Inspections"  value={qual.summary?.total_inspections || 0} />
                    <KpiCard label="Pass Rate"          value={fmtPct(qual.summary?.inspection_pass_rate)} color={parseFloat(qual.summary?.inspection_pass_rate || 0) >= 90 ? C.green : C.amber} />
                    <KpiCard label="Total NCRs"         value={qual.summary?.total_ncrs || 0}        color="#374151" />
                    <KpiCard label="Open NCRs"          value={qual.summary?.open_ncr || 0}          color={(qual.summary?.open_ncr || 0) > 0 ? C.red : C.green} warn={(qual.summary?.open_ncr || 0) > 0} />
                    <KpiCard label="Critical NCRs"      value={qual.summary?.critical_ncrs || 0}     color={(qual.summary?.critical_ncrs || 0) > 0 ? C.red : C.green} />
                    <KpiCard label="Open CAPAs"         value={qual.summary?.open_capa || 0}         color={(qual.summary?.open_capa || 0) > 0 ? C.amber : C.green} />
                    <KpiCard label="Rejection Qty"      value={qual.summary?.rejection_qty || 0}     color={C.amber} />
                  </div>

                  <SectionCard title="NCR / Rejection Log">
                    <Table
                      headers={['NCR #', 'Date', 'Defect', 'Severity', 'Qty Affected', 'Status']}
                      emptyMsg="No NCRs found"
                      rows={(qual.ncrs || []).map((n, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #f9f9fb' }}>
                          <TD primary>{n.ncr_number || `NCR-${n.id}`}</TD>
                          <TD>{fmtDate(n.created_at)}</TD>
                          <TD>{n.defect_description || n.description || '—'}</TD>
                          <td style={{ padding: '8px 12px' }}><Badge label={n.severity || '—'} color={n.severity === 'Critical' ? C.red : C.amber} bg={n.severity === 'Critical' ? '#fee2e2' : '#fef3c7'} /></td>
                          <TD>{n.quantity_affected || '—'}</TD>
                          <td style={{ padding: '8px 12px' }}><Badge label={n.status || '—'} color={n.status === 'Closed' ? C.green : C.red} bg={n.status === 'Closed' ? '#dcfce7' : '#fee2e2'} /></td>
                        </tr>
                      ))}
                    />
                  </SectionCard>

                  {(qual.capas || []).length > 0 && (
                    <SectionCard title="CAPA Actions">
                      <Table
                        headers={['CAPA ID', 'NCR', 'Action', 'Due Date', 'Status', 'Verified']}
                        emptyMsg="No CAPAs"
                        rows={(qual.capas || []).map((c, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid #f9f9fb' }}>
                            <TD primary>CAPA-{c.id}</TD>
                            <TD>{c.ncr_number || `NCR-${c.ncr_id}`}</TD>
                            <TD>{c.action_description || '—'}</TD>
                            <TD>{fmtDate(c.due_date)}</TD>
                            <td style={{ padding: '8px 12px' }}><Badge label={c.status || '—'} color={c.status === 'closed' ? C.green : C.amber} bg={c.status === 'closed' ? '#dcfce7' : '#fef3c7'} /></td>
                            <TD>{fmtDate(c.verified_at)}</TD>
                          </tr>
                        ))}
                      />
                    </SectionCard>
                  )}
                </div>
              )}

              {/* ─── PROJECTS ─────────────────────────────────────────────────── */}
              {tab === 'Projects' && (
                <VendorProjectImpact
                  projectsData={proj.summary || proj.projects ? {
                    projects: (proj.projects || []).map(p => ({
                      ...p,
                      project_name:  p.project_name || p.name,
                      po_value:      parseFloat(p.vendor_po_value || p.po_value || 0),
                      open_po_value: parseFloat(p.open_po_value || 0),
                      budget:        parseFloat(p.contract_value || p.budget || 0),
                      ncr_count:     p.ncr_count || 0,
                      risk:          p.priority === 'critical' || p.status === 'On Hold' ? 'High'
                                   : p.priority === 'high' ? 'Medium' : 'Low',
                    })),
                    summary: {
                      total_projects:  proj.summary?.projects_count || 0,
                      active_projects: proj.summary?.active_projects || 0,
                      total_po_value:  proj.summary?.total_vendor_value || 0,
                      open_po_value:   0,
                      at_risk:         proj.summary?.critical_projects || 0,
                    },
                  } : null}
                />
              )}

              {/* ─── INVENTORY ────────────────────────────────────────────────── */}
              {tab === 'Inventory' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 14 }}>
                    <KpiCard label="Unique Items"      value={inv.summary?.unique_items || 0}          color={C.blue} />
                    <KpiCard label="Stock Value"       value={fmtINR(inv.summary?.stock_value)}        color={C.primary} />
                    <KpiCard label="Critical Items"    value={inv.summary?.critical_materials || 0}    color={(inv.summary?.critical_materials || 0) > 0 ? C.red : C.green} />
                    <KpiCard label="Long Lead Items"   value={inv.summary?.long_lead_items || 0}       color={(inv.summary?.long_lead_items || 0) > 0 ? C.amber : C.green} />
                  </div>

                  {(inv.critical_stock || []).filter(s => s.reorder_level != null && parseFloat(s.current_stock) <= parseFloat(s.reorder_level)).length > 0 && (
                    <div style={{ ...C.card, padding: 16, border: '1px solid #fecaca', background: '#fff5f5' }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: C.red, marginBottom: 10 }}>⚠ Critical Stock Alerts</div>
                      {(inv.critical_stock || []).filter(s => s.reorder_level != null && parseFloat(s.current_stock) <= parseFloat(s.reorder_level)).map((item, i) => (
                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #ffe4e4', fontSize: 12 }}>
                          <span style={{ fontWeight: 600, color: '#374151' }}>{item.item_name} ({item.item_code})</span>
                          <span style={{ color: C.red }}>Stock: {item.current_stock} | Reorder: {item.reorder_level}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <SectionCard title="Items Supplied (by value)">
                    <Table
                      headers={['Item Name', 'Code', 'UOM', 'Total Ordered', 'Total Value', 'POs', 'Last Ordered']}
                      emptyMsg="No supplied items found"
                      rows={(inv.supplied_items || []).map((item, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #f9f9fb' }}>
                          <TD bold>{item.item_name}</TD>
                          <TD primary>{item.item_code || '—'}</TD>
                          <TD>{item.uom || '—'}</TD>
                          <TD>{parseFloat(item.total_ordered || 0).toFixed(0)}</TD>
                          <TD bold>{fmtINR(item.total_value)}</TD>
                          <TD>{item.po_count}</TD>
                          <TD>{fmtDate(item.last_ordered)}</TD>
                        </tr>
                      ))}
                    />
                  </SectionCard>
                </div>
              )}

              {/* ─── FINANCE ──────────────────────────────────────────────────── */}
              {tab === 'Finance' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14 }}>
                    <KpiCard label="Total Spend"         value={fmtINR(fin.summary?.total_spend)}              color={C.primary} />
                    <KpiCard label="Amount Paid"         value={fmtINR(fin.summary?.paid_amount)}              color={C.green} />
                    <KpiCard label="Outstanding"         value={fmtINR(fin.summary?.outstanding_amount)}       color={fin.summary?.outstanding_amount > 0 ? C.amber : C.green} warn={fin.summary?.outstanding_amount > 0} />
                    <KpiCard label="Total Bills"         value={fin.summary?.total_bills || 0} />
                    <KpiCard label="Pending Bills"       value={fin.summary?.pending_bills || 0}               color={(fin.summary?.pending_bills || 0) > 0 ? C.amber : C.green} />
                    <KpiCard label="Avg Payment Days"    value={fin.summary?.average_payment_days > 0 ? `${parseFloat(fin.summary.average_payment_days).toFixed(0)}d` : '—'} />
                    <KpiCard label="TDS Deducted"        value={fmtINR(fin.summary?.total_tds)} />
                  </div>

                  <SectionCard title="Bills / Invoices">
                    <Table
                      headers={['Bill #', 'Date', 'Due Date', 'Amount', 'Balance', 'Status', 'TDS']}
                      emptyMsg="No bills found"
                      rows={(fin.bills || []).map((b, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #f9f9fb' }}>
                          <TD primary>{b.bill_number || `BILL-${b.id}`}</TD>
                          <TD>{fmtDate(b.bill_date || b.date)}</TD>
                          <TD>{fmtDate(b.due_date)}</TD>
                          <TD bold>{fmtINR(b.total_amount || b.amount)}</TD>
                          <TD>{fmtINR(b.balance)}</TD>
                          <td style={{ padding: '8px 12px' }}><Badge label={b.status || '—'} color={b.status === 'Paid' || b.status === 'paid' ? C.green : C.amber} bg={b.status === 'Paid' || b.status === 'paid' ? '#dcfce7' : '#fef3c7'} /></td>
                          <TD>{b.tds_amount > 0 ? fmtINR(b.tds_amount) : '—'}</TD>
                        </tr>
                      ))}
                    />
                  </SectionCard>
                </div>
              )}

              {/* ─── DOCUMENTS ────────────────────────────────────────────────── */}
              {tab === 'Documents' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  <DriveStructure docs={docs} />

                  {docs?.compliance && (
                    <SectionCard title="Compliance & Document Checklist">
                      <div style={{ padding: '4px 18px 12px' }}>
                        <ComplianceRow doc="GST Registration Certificate"   done={!!docs.compliance.gstin} />
                        <ComplianceRow doc="PAN Card"                       done={!!docs.compliance.pan} />
                        <ComplianceRow doc="Bank Details"                   done={!!(reg.bank_name)} />
                        <ComplianceRow doc="MSME / Udyam Registration"     done={!!docs.compliance.msme_status} />
                        <ComplianceRow doc="ISO Certification"              done={!!(docs.compliance.iso_certificates)} />
                        <ComplianceRow doc="Vendor Agreement Signed"        done={v.status === 'Active' || v.status === 'approved'} />
                      </div>
                    </SectionCard>
                  )}
                </div>
              )}

              {/* ─── SCORECARD ────────────────────────────────────────────────── */}
              {tab === 'Scorecard' && (
                <ScorecardTab scorecard={sc} onScore={() => setShowScoreForm(true)} />
              )}

              {/* ─── TIMELINE ─────────────────────────────────────────────────── */}
              {tab === 'Timeline' && (
                <div>
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 20 }}>
                    {Object.entries(TYPE_COLOR).map(([type, color]) => (
                      <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
                        <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block' }} />
                        <span style={{ color: '#6b7280', textTransform: 'capitalize' }}>{type.replace('_', ' ')}</span>
                      </div>
                    ))}
                  </div>
                  {timelineEvents === null
                    ? <div style={{ textAlign: 'center', padding: '48px 20px', color: '#9ca3af' }}>⏳ Loading timeline…</div>
                    : <TimelineView events={timelineEvents} />}
                </div>
              )}

              {/* ─── HEALTH SCORE ─────────────────────────────────────────────── */}
              {tab === 'Health' && (
                <VendorHealthWidget
                  vendorId={selectedId}
                  onRecalculate={() => loadVendor(selectedId)}
                />
              )}

              {/* ─── HEALTH TREND ─────────────────────────────────────────────── */}
              {tab === 'Health Trend' && (
                <VendorHealthTrend vendorId={selectedId} />
              )}

              {/* ─── RISK ─────────────────────────────────────────────────────── */}
              {tab === 'Risk' && (
                <VendorRiskPanel riskData={riskData} vendorName={v.name} />
              )}

            </div>
          </>
        )}
      </div>
    </div>
  );
}
