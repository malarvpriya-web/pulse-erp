// frontend/src/features/crm/pages/Customer360.jsx
// Customer 360° Command Center — 17 sections, CEO traceability test
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie, Legend,
} from 'recharts';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

// ── Action Button Component ────────────────────────────────────────────────────
function ActionBtn({ icon, label, color = '#6B3FDB', onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
        border: `1.5px solid ${color}`, background: '#fff', color,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'all .15s', whiteSpace: 'nowrap',
      }}
      onMouseEnter={e => { if (!disabled) { e.currentTarget.style.background = color; e.currentTarget.style.color = '#fff'; }}}
      onMouseLeave={e => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.color = color; }}
    >
      <span>{icon}</span>{label}
    </button>
  );
}

// ── Formatters ─────────────────────────────────────────────────────────────────
const fmtINR = n => {
  const v = parseFloat(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)} Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(2)} L`;
  if (v >= 1000)     return `₹${(v / 1000).toFixed(1)}K`;
  return `₹${v.toLocaleString('en-IN')}`;
};

const fmtDate = d => {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
};

const fmtDays = n => {
  if (!n && n !== 0) return '—';
  return `${n}d`;
};

// ── Design tokens ──────────────────────────────────────────────────────────────
const C = {
  primary:   '#6B3FDB',
  green:     '#16a34a',
  red:       '#dc2626',
  amber:     '#d97706',
  blue:      '#2563eb',
  light:     '#f5f3ff',
  border:    '#e9e4ff',
  card:      { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12 },
  surface:   '#f8f7fd',
};

const STAGE_COLORS = {
  qualification: '#6b7280',
  proposal:      '#2563eb',
  negotiation:   '#d97706',
  won:           '#16a34a',
  lost:          '#dc2626',
};

const STATUS_BADGE = {
  paid:       { bg: '#dcfce7', color: '#16a34a' },
  active:     { bg: '#dcfce7', color: '#16a34a' },
  completed:  { bg: '#dcfce7', color: '#16a34a' },
  won:        { bg: '#dcfce7', color: '#16a34a' },
  resolved:   { bg: '#dcfce7', color: '#16a34a' },
  accepted:   { bg: '#dcfce7', color: '#16a34a' },
  overdue:    { bg: '#fee2e2', color: '#dc2626' },
  lost:       { bg: '#fee2e2', color: '#dc2626' },
  critical:   { bg: '#fee2e2', color: '#dc2626' },
  cancelled:  { bg: '#fee2e2', color: '#dc2626' },
  expired:    { bg: '#fee2e2', color: '#dc2626' },
  pending:    { bg: '#fef9c3', color: '#854d0e' },
  open:       { bg: '#fef9c3', color: '#854d0e' },
  sent:       { bg: '#ede9fe', color: '#6B3FDB' },
  draft:      { bg: '#f3f4f6', color: '#374151' },
  planning:   { bg: '#dbeafe', color: '#2563eb' },
  processing: { bg: '#dbeafe', color: '#2563eb' },
  'in_progress': { bg: '#dbeafe', color: '#2563eb' },
  'on_hold':  { bg: '#fef9c3', color: '#854d0e' },
};

function Badge({ status }) {
  const s = STATUS_BADGE[(status || '').toLowerCase()] || { bg: '#f3f4f6', color: '#374151' };
  return (
    <span style={{
      padding: '2px 9px', borderRadius: 20, fontSize: 11, fontWeight: 600,
      background: s.bg, color: s.color, textTransform: 'capitalize', whiteSpace: 'nowrap',
    }}>
      {(status || '').replace(/_/g, ' ')}
    </span>
  );
}

// ── Reusable primitives ────────────────────────────────────────────────────────
function Card({ children, style = {} }) {
  return <div style={{ ...C.card, ...style }}>{children}</div>;
}

function SectionHeader({ title, count, color = C.primary }) {
  return (
    <div style={{
      padding: '14px 18px', borderBottom: '1px solid #f0f0f4',
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{title}</span>
      {count != null && (
        <span style={{
          background: color, color: '#fff', borderRadius: 20,
          fontSize: 11, fontWeight: 700, padding: '1px 8px',
        }}>{count}</span>
      )}
    </div>
  );
}

function KpiCard({ label, value, sub, color = '#111827', bg = '#fff' }) {
  return (
    <div style={{
      ...C.card, padding: '16px 20px', background: bg,
      display: 'flex', flexDirection: 'column', gap: 4, minWidth: 130,
    }}>
      <span style={{ fontSize: 20, fontWeight: 800, color }}>{value}</span>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>{label}</span>
      {sub && <span style={{ fontSize: 11, color: '#9ca3af' }}>{sub}</span>}
    </div>
  );
}

function EmptyState({ icon = '📭', msg = 'No data available' }) {
  return (
    <div style={{ padding: '36px 20px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
      <div style={{ fontSize: 32, marginBottom: 8 }}>{icon}</div>
      {msg}
    </div>
  );
}

function Table({ headers, rows, emptyMsg }) {
  if (!rows || !rows.length) return <EmptyState msg={emptyMsg || 'No records found'} />;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: '#fafafa' }}>
            {headers.map(h => (
              <th key={h} style={{
                padding: '8px 14px', fontSize: 11, fontWeight: 700,
                color: '#6b7280', textAlign: 'left', textTransform: 'uppercase',
                borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap',
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}

function TD({ children, bold, primary }) {
  return (
    <td style={{
      padding: '9px 14px', fontSize: 12,
      color: primary ? C.primary : bold ? '#111827' : '#374151',
      fontWeight: bold || primary ? 700 : 400,
      borderBottom: '1px solid #f8f8fc',
    }}>
      {children}
    </td>
  );
}

// ── Customer Search Combobox ───────────────────────────────────────────────────
function CustomerCombobox({ selected, onSelect, onClear }) {
  const [query, setQuery]   = useState('');
  const [results, setRes]   = useState([]);
  const [busy, setBusy]     = useState(false);
  const [open, setOpen]     = useState(false);
  const inputRef = useRef(null);
  const timer    = useRef(null);

  useEffect(() => {
    if (!query.trim()) { setRes([]); setOpen(false); return; }
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await api.get(`/crm/parties?search=${encodeURIComponent(query)}`);
        setRes(r.data || []);
        setOpen(true);
      } catch {}
      setBusy(false);
    }, 300);
    return () => clearTimeout(timer.current);
  }, [query]);

  function pick(p) { onSelect(p); setQuery(''); setRes([]); setOpen(false); }
  function clear() { onClear(); setQuery(''); setRes([]); setOpen(false); setTimeout(() => inputRef.current?.focus(), 50); }

  return (
    <div style={{ position: 'relative', flex: 1, maxWidth: 500 }}>
      <div style={{
        display: 'flex', alignItems: 'center',
        border: `1.5px solid ${open ? C.primary : C.border}`,
        borderRadius: 10, background: '#fff', overflow: 'hidden', transition: 'border-color .15s',
      }}>
        {selected ? (
          <>
            <div style={{ flex: 1, padding: '9px 14px' }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{selected.name}</span>
              {selected.city && <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 8 }}>{selected.city}</span>}
            </div>
            <button onClick={clear} style={{
              padding: '9px 14px', border: 'none', background: 'transparent',
              color: '#9ca3af', cursor: 'pointer', fontSize: 18, fontWeight: 700,
            }} title="Clear">×</button>
          </>
        ) : (
          <>
            <span style={{ padding: '0 10px', color: '#9ca3af', fontSize: 16 }}>🔍</span>
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onFocus={() => results.length && setOpen(true)}
              onBlur={() => setTimeout(() => setOpen(false), 160)}
              placeholder="Search customer by name or GSTIN…"
              style={{ flex: 1, padding: '10px 4px', border: 'none', outline: 'none', fontSize: 13, background: 'transparent' }}
            />
            {busy && <span style={{ padding: '0 12px', color: '#9ca3af', fontSize: 12 }}>…</span>}
          </>
        )}
      </div>

      {open && results.length > 0 && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0,
          background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10,
          boxShadow: '0 8px 24px rgba(0,0,0,.1)', zIndex: 300, maxHeight: 280, overflowY: 'auto',
        }}>
          {results.map(p => (
            <div
              key={p.id}
              onMouseDown={() => pick(p)}
              style={{ padding: '10px 14px', cursor: 'pointer', borderBottom: `1px solid #f8f8fc` }}
              onMouseEnter={e => e.currentTarget.style.background = C.light}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{p.name}</div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                {[p.city, p.state, p.gstin].filter(Boolean).join(' · ')}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Health Score Gauge ─────────────────────────────────────────────────────────
function HealthGauge({ score, label, grade }) {
  const color = score >= 90 ? C.green : score >= 75 ? '#16a34a' : score >= 60 ? C.amber : C.red;
  const labelColor = score >= 90 ? C.green : score >= 75 ? '#16a34a' : score >= 60 ? C.amber : C.red;
  const pct = Math.min(100, Math.max(0, score));
  return (
    <div style={{ textAlign: 'center', padding: '12px 0' }}>
      <svg width="120" height="70" viewBox="0 0 120 70">
        <path d="M10,65 A50,50,0,0,1,110,65" fill="none" stroke="#f0f0f4" strokeWidth="12" strokeLinecap="round" />
        <path
          d="M10,65 A50,50,0,0,1,110,65"
          fill="none" stroke={color} strokeWidth="12" strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * 157} 157`}
        />
        <text x="60" y="58" textAnchor="middle" fontSize="20" fontWeight="800" fill={color}>{score}</text>
      </svg>
      <div style={{ fontSize: 13, fontWeight: 700, color: labelColor, marginTop: -4 }}>{label}</div>
      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>Grade {grade}</div>
    </div>
  );
}

// ── Sales Funnel Visual ────────────────────────────────────────────────────────
function SalesFunnel({ summary }) {
  const stages = [
    { label: 'Leads',        value: summary.lead_count,        color: '#6b7280' },
    { label: 'Opportunities',value: summary.opportunity_count, color: '#2563eb' },
    { label: 'Quotations',   value: summary.quotation_count,   color: '#d97706' },
    { label: 'POs Received', value: summary.po_count,          color: '#16a34a' },
  ];
  const max = Math.max(...stages.map(s => s.value), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '16px 20px' }}>
      {stages.map((s, i) => (
        <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', width: 100, textAlign: 'right' }}>{s.label}</span>
          <div style={{
            height: 26, borderRadius: 6, background: s.color,
            width: `${Math.max(6, (s.value / max) * 60)}%`,
            display: 'flex', alignItems: 'center', paddingLeft: 8,
            transition: 'width .4s',
          }}>
            <span style={{ color: '#fff', fontWeight: 700, fontSize: 12 }}>{s.value}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Project Progress Bar ───────────────────────────────────────────────────────
function MilestoneBar({ milestones }) {
  const STAGES = ['Engineering', 'Procurement', 'Manufacturing', 'FAT', 'Dispatch', 'Installation', 'Commissioning', 'SAT'];
  if (!milestones || !milestones.length) {
    return (
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
        {STAGES.map(s => (
          <span key={s} style={{
            padding: '2px 7px', borderRadius: 4, fontSize: 10, fontWeight: 600,
            background: '#f3f4f6', color: '#9ca3af',
          }}>{s}</span>
        ))}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
      {milestones.map(m => {
        const done = m.status === 'completed';
        return (
          <span key={m.id} style={{
            padding: '2px 7px', borderRadius: 4, fontSize: 10, fontWeight: 600,
            background: done ? '#dcfce7' : '#f3f4f6',
            color: done ? '#16a34a' : '#6b7280',
          }}>
            {done ? '✓ ' : ''}{m.milestone_name}
          </span>
        );
      })}
    </div>
  );
}

// ── Tab navigation ─────────────────────────────────────────────────────────────
const TABS = [
  { id: 'overview',       label: 'Overview',        icon: '🏠' },
  { id: 'contacts',       label: 'Contacts',         icon: '👥' },
  { id: 'pipeline',       label: 'Sales Pipeline',   icon: '📊' },
  { id: 'tenders',        label: 'Tenders',          icon: '📑' },
  { id: 'commercial',     label: 'Commercial',        icon: '📄' },
  { id: 'projects',       label: 'Projects',         icon: '🏗' },
  { id: 'engineering',    label: 'Engineering',      icon: '⚙' },
  { id: 'procurement',    label: 'Procurement & Mfg',icon: '🔧' },
  { id: 'quality',        label: 'Quality',          icon: '✅' },
  { id: 'commissioning',  label: 'Commissioning',    icon: '🚀' },
  { id: 'service',        label: 'Service',          icon: '🎫' },
  { id: 'amc',            label: 'AMC',              icon: '🔄' },
  { id: 'finance',        label: 'Finance',          icon: '💰' },
  { id: 'travel',         label: 'Travel Cost',      icon: '✈' },
  { id: 'documents',      label: 'Documents',        icon: '📁' },
  { id: 'timeline',       label: 'Timeline',         icon: '📅' },
  { id: 'ceo',            label: 'CEO Test',         icon: '🎯' },
];

function TabBar({ active, onChange }) {
  return (
    <div style={{
      display: 'flex', overflowX: 'auto', gap: 2,
      borderBottom: `2px solid ${C.border}`, marginBottom: 20,
      paddingBottom: 2,
    }}>
      {TABS.map(t => (
        <button key={t.id} onClick={() => onChange(t.id)} style={{
          padding: '9px 14px', border: 'none', cursor: 'pointer',
          fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
          borderBottom: active === t.id ? `2px solid ${C.primary}` : '2px solid transparent',
          color: active === t.id ? C.primary : '#6b7280',
          background: active === t.id ? C.light : 'transparent',
          borderRadius: '8px 8px 0 0', transition: 'all .15s',
          display: 'flex', alignItems: 'center', gap: 5,
        }}>
          <span>{t.icon}</span>{t.label}
        </button>
      ))}
    </div>
  );
}

// ── Timeline event renderer ────────────────────────────────────────────────────
const EVENT_COLOR = {
  email:          '#6B3FDB',
  invoice:        '#16a34a',
  ticket:         '#dc2626',
  order:          '#2563eb',
  quotation:      '#d97706',
  project:        '#0891b2',
  commissioning:  '#059669',
  amc:            '#6366f1',
};

function TimelineView({ events }) {
  const [shown, setShown] = useState(25);
  if (!events || !events.length) return <EmptyState icon="📅" msg="No timeline events yet" />;
  return (
    <div style={{ position: 'relative', paddingLeft: 44 }}>
      <div style={{ position: 'absolute', left: 20, top: 0, bottom: 0, width: 2, background: C.border }} />
      {events.slice(0, shown).map((ev, i) => (
        <div key={i} style={{ position: 'relative', marginBottom: 14 }}>
          <div style={{
            position: 'absolute', left: -32, top: 8, width: 24, height: 24,
            borderRadius: '50%', background: EVENT_COLOR[ev.type] || '#6b7280',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, zIndex: 1, border: '2px solid #fff', boxShadow: '0 1px 4px rgba(0,0,0,.1)',
          }}>
            {ev.icon}
          </div>
          <Card style={{ padding: '10px 14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{ev.title}</span>
                {ev.amount > 0 && (
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.primary }}>{fmtINR(ev.amount)}</span>
                )}
                {ev.status && <Badge status={ev.status} />}
              </div>
              <span style={{ fontSize: 11, color: '#9ca3af', flexShrink: 0 }}>{fmtDate(ev.date)}</span>
            </div>
          </Card>
        </div>
      ))}
      {shown < events.length && (
        <button onClick={() => setShown(s => Math.min(s + 20, events.length))} style={{
          padding: '8px 20px', border: `1px solid ${C.border}`, borderRadius: 8,
          background: C.light, color: C.primary, fontWeight: 600, cursor: 'pointer', fontSize: 13,
        }}>
          Load More ({events.length - shown} remaining)
        </button>
      )}
    </div>
  );
}

// ── Google Drive Folder Structure (legacy static view) ────────────────────────
function DriveStructure({ folders, root }) {
  return (
    <div>
      <div style={{
        padding: '14px 18px', background: C.light,
        borderRadius: 10, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <span style={{ fontSize: 22 }}>📁</span>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>Google Drive Root</div>
          <div style={{ fontSize: 12, color: '#6b7280', fontFamily: 'monospace' }}>{root}</div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
        {folders.map(f => (
          <div key={f.id} style={{
            ...C.card, padding: '14px 16px',
            display: 'flex', alignItems: 'flex-start', gap: 10,
            cursor: 'pointer', transition: 'box-shadow .15s',
          }}
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
      <div style={{ marginTop: 20, padding: 16, background: '#fffbeb', borderRadius: 10, border: '1px solid #fde68a' }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: '#92400e', marginBottom: 8 }}>Auto-Upload Rules</div>
        {[
          '📧 Every document emailed to customer → auto-uploaded to customer folder',
          '✍ Every signed document → stored in Google Drive',
          '🔬 FAT/SAT Reports → stored in respective customer subfolder',
          '📦 Dispatch proofs → stored in customer folder',
        ].map(rule => (
          <div key={rule} style={{ fontSize: 12, color: '#78350f', padding: '3px 0' }}>{rule}</div>
        ))}
      </div>
    </div>
  );
}

// ── Documents Tab — real Drive integration ─────────────────────────────────────
function DocumentsTab({ partyId, driveFolders, driveFiles, legacyDrive, driveProvisioning, onProvision, onOpenFolder }) {
  const [activeDocType, setActiveDocType] = useState(null);

  const fmtBytes = bytes => {
    if (!bytes) return '—';
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${bytes} B`;
  };

  // Use real Drive folder data when available
  const folders = driveFolders?.folders;
  const files   = driveFiles?.files || [];
  const counts  = driveFiles?.counts || {};

  const filteredFiles = activeDocType
    ? files.filter(f => f.doc_type === activeDocType)
    : files;

  const recentFiles = [...files].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 5);

  // Not provisioned yet
  if (folders && !driveFolders?.provisioned) {
    return (
      <div>
        {/* Show legacy static view as fallback */}
        {legacyDrive && <DriveStructure folders={legacyDrive.folders} root={legacyDrive.root} />}
        <div style={{ marginTop: 20, padding: 24, background: '#f5f3ff', borderRadius: 12, border: '1px solid #e9e4ff', textAlign: 'center' }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>📁</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 6 }}>Google Drive Not Yet Provisioned</div>
          <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 16 }}>
            Click below to create 14 standard subfolders for this customer in Google Drive.
          </div>
          <button
            onClick={onProvision}
            disabled={driveProvisioning}
            style={{
              padding: '10px 24px', background: '#6B3FDB', color: '#fff',
              border: 'none', borderRadius: 8, fontWeight: 700, cursor: driveProvisioning ? 'not-allowed' : 'pointer',
              fontSize: 13, opacity: driveProvisioning ? 0.6 : 1,
            }}
          >
            {driveProvisioning ? 'Creating Folders…' : 'Provision Google Drive Folders'}
          </button>
        </div>
      </div>
    );
  }

  // Drive provisioned — show full folder grid with live links
  if (folders && driveFolders?.provisioned) {
    return (
      <div>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 24 }}>📁</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>Google Drive</div>
              <div style={{ fontSize: 12, color: '#6b7280', fontFamily: 'monospace' }}>{driveFolders.drive_root}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <span style={{
              padding: '4px 12px', background: '#dcfce7', color: '#16a34a',
              borderRadius: 20, fontSize: 11, fontWeight: 700,
            }}>✓ Drive Provisioned</span>
            {files.length > 0 && (
              <span style={{
                padding: '4px 12px', background: '#ede9fe', color: '#6B3FDB',
                borderRadius: 20, fontSize: 11, fontWeight: 700,
              }}>{files.length} files uploaded</span>
            )}
          </div>
        </div>

        {/* Recent files */}
        {recentFiles.length > 0 && (
          <Card style={{ marginBottom: 20, padding: 0 }}>
            <SectionHeader title="Recent Documents" count={recentFiles.length} />
            <Table
              headers={['File Name', 'Type', 'Size', 'Uploaded', 'Link']}
              emptyMsg="No recent documents"
              rows={recentFiles.map(f => (
                <tr key={f.id}>
                  <TD bold>{f.file_name}</TD>
                  <TD>{f.doc_type}</TD>
                  <TD>{fmtBytes(f.file_size_bytes)}</TD>
                  <TD>{fmtDate(f.created_at)}</TD>
                  <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}>
                    {f.drive_link
                      ? <a href={f.drive_link} target="_blank" rel="noopener noreferrer"
                          style={{ color: C.primary, fontWeight: 600, fontSize: 12 }}>Open ↗</a>
                      : <span style={{ color: '#9ca3af' }}>—</span>}
                  </td>
                </tr>
              ))}
            />
          </Card>
        )}

        {/* Folder filter chips */}
        {files.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
            <button
              onClick={() => setActiveDocType(null)}
              style={{
                padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                border: `1px solid ${!activeDocType ? C.primary : C.border}`,
                background: !activeDocType ? C.light : '#fff',
                color: !activeDocType ? C.primary : '#6b7280',
                cursor: 'pointer',
              }}
            >All ({files.length})</button>
            {folders.filter(f => counts[f.doc_type]?.count > 0).map(f => (
              <button key={f.label} onClick={() => setActiveDocType(activeDocType === f.doc_type ? null : f.doc_type)} style={{
                padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                border: `1px solid ${activeDocType === f.doc_type ? C.primary : C.border}`,
                background: activeDocType === f.doc_type ? C.light : '#fff',
                color: activeDocType === f.doc_type ? C.primary : '#6b7280',
                cursor: 'pointer',
              }}>
                {f.key} ({counts[f.doc_type]?.count || 0})
              </button>
            ))}
          </div>
        )}

        {/* Filtered file list */}
        {filteredFiles.length > 0 && (
          <Card style={{ marginBottom: 20, padding: 0 }}>
            <SectionHeader title={activeDocType ? `Files: ${activeDocType}` : 'All Files'} count={filteredFiles.length} />
            <Table
              headers={['File Name', 'Folder', 'Size', 'Uploaded', 'Link']}
              emptyMsg="No files in this folder"
              rows={filteredFiles.map(f => (
                <tr key={f.id}>
                  <TD bold>{f.file_name}</TD>
                  <TD>{f.doc_type}</TD>
                  <TD>{fmtBytes(f.file_size_bytes)}</TD>
                  <TD>{fmtDate(f.created_at)}</TD>
                  <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}>
                    {f.drive_link
                      ? <a href={f.drive_link} target="_blank" rel="noopener noreferrer"
                          style={{ color: C.primary, fontWeight: 600, fontSize: 12 }}>Open ↗</a>
                      : <span style={{ color: '#9ca3af' }}>—</span>}
                  </td>
                </tr>
              ))}
            />
          </Card>
        )}

        {/* Folder grid with links */}
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 12 }}>Folder Structure</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
            {folders.map(f => {
              const docCounts = counts[f.doc_type] || {};
              return (
                <div key={f.label}
                  onClick={() => f.folder_url && window.open(f.folder_url, '_blank', 'noopener,noreferrer')}
                  style={{
                    ...C.card, padding: '14px 16px',
                    display: 'flex', alignItems: 'flex-start', gap: 10,
                    cursor: f.folder_url ? 'pointer' : 'default',
                    transition: 'box-shadow .15s',
                    opacity: f.provisioned ? 1 : 0.6,
                  }}
                  onMouseEnter={e => { if (f.folder_url) e.currentTarget.style.boxShadow = '0 4px 12px rgba(107,63,219,.12)'; }}
                  onMouseLeave={e => e.currentTarget.style.boxShadow = 'none'}
                >
                  <span style={{ fontSize: 22, flexShrink: 0 }}>{f.provisioned ? '📂' : '📁'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#111827' }}>{f.label}</div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center' }}>
                      {docCounts.count > 0 && (
                        <span style={{ fontSize: 11, color: C.primary, fontWeight: 600 }}>{docCounts.count} file{docCounts.count !== 1 ? 's' : ''}</span>
                      )}
                      {docCounts.last_uploaded && (
                        <span style={{ fontSize: 10, color: '#9ca3af' }}>Last: {fmtDate(docCounts.last_uploaded)}</span>
                      )}
                      {!f.provisioned && <span style={{ fontSize: 10, color: '#d97706' }}>Not provisioned</span>}
                    </div>
                    {f.folder_url && (
                      <div style={{ fontSize: 10, color: C.primary, marginTop: 4, fontWeight: 600 }}>Open in Drive ↗</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Auto-routing rules */}
        <div style={{ marginTop: 20, padding: 16, background: '#fffbeb', borderRadius: 10, border: '1px solid #fde68a' }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: '#92400e', marginBottom: 8 }}>Auto-Document Routing</div>
          {[
            ['📋 Quotation PDF', '→ 02 Quotations'],
            ['📦 Purchase Order', '→ 03 Purchase Orders'],
            ['🔬 FAT Report',    '→ 07 FAT Reports'],
            ['🏗 SAT Report',    '→ 08 SAT Reports'],
            ['⚙ Commissioning', '→ 09 Commissioning Reports'],
            ['🔧 Service Report','→ 10 Service Reports'],
            ['🔄 AMC Contract',  '→ 11 AMC'],
            ['🧾 Invoice PDF',   '→ 12 Invoices'],
          ].map(([doc, folder]) => (
            <div key={doc} style={{ display: 'flex', gap: 12, fontSize: 12, color: '#78350f', padding: '3px 0' }}>
              <span style={{ width: 160 }}>{doc}</span>
              <span style={{ fontWeight: 600 }}>{folder}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Fallback: no Drive data yet — show legacy static structure
  return legacyDrive
    ? <DriveStructure folders={legacyDrive.folders} root={legacyDrive.root} />
    : <EmptyState icon="📁" msg="Loading document structure…" />;
}

// ── CEO Traceability Test ──────────────────────────────────────────────────────
function CEOTraceTest({ core, pipeline, projects, manufacturing, service, amc, finance }) {
  const checks = [
    {
      q: 'Who sold this customer?',
      ans: core?.account?.account_manager_name || pipeline?.opportunities?.[0]
        ? `${pipeline?.opportunities?.[0]?.assigned_to_name || '—'} (Opportunity)`
        : null,
      pass: !!(core?.account?.account_manager_name || pipeline?.opportunities?.[0]?.assigned_to_name),
    },
    {
      q: 'Which quotation was accepted?',
      ans: pipeline?.quotations?.find(q => q.status === 'accepted')?.quotation_number || null,
      pass: !!(pipeline?.quotations?.some(q => q.status === 'accepted')),
    },
    {
      q: 'Which PO was received?',
      ans: pipeline?.sales_orders?.length > 0
        ? pipeline.sales_orders.map(o => o.order_number).join(', ')
        : null,
      pass: !!(pipeline?.sales_orders?.length > 0),
    },
    {
      q: 'Which project was executed?',
      ans: projects?.projects?.length > 0
        ? projects.projects.map(p => p.project_code).join(', ')
        : null,
      pass: !!(projects?.projects?.length > 0),
    },
    {
      q: 'Which BOM revision was used?',
      ans: manufacturing?.boms?.length > 0
        ? manufacturing.boms.map(b => `${b.bom_code} Rev ${b.revision || 'A'}`).join(', ')
        : null,
      pass: !!(manufacturing?.boms?.length > 0),
    },
    {
      q: 'Which serial numbers were delivered?',
      ans: manufacturing?.production_orders?.length > 0
        ? `${manufacturing.production_orders.length} production order(s) tracked`
        : null,
      pass: !!(manufacturing?.production_orders?.length > 0),
    },
    {
      q: 'Which FAT report belongs to them?',
      ans: manufacturing?.fat_records?.length > 0
        ? manufacturing.fat_records.map(f => f.report_number || `FAT-${f.id?.slice(0,8)}`).join(', ')
        : null,
      pass: !!(manufacturing?.fat_records?.length > 0),
    },
    {
      q: 'Which SAT report belongs to them?',
      ans: manufacturing?.commissioning?.sat_reports?.length > 0
        ? `${manufacturing?.commissioning?.sat_reports?.length} SAT report(s)`
        : null,
      pass: false, // check commissioning data
    },
    {
      q: 'Which service tickets exist?',
      ans: service?.tickets?.length > 0
        ? `${service.tickets.length} ticket(s) — ${service.summary?.open_tickets || 0} open`
        : null,
      pass: !!(service?.tickets?.length >= 0), // 0 is also valid (no tickets = good)
    },
    {
      q: 'Which AMC is active?',
      ans: amc?.amc_contracts?.find(a => a.status === 'active')?.contract_number || null,
      pass: !!(amc?.amc_contracts?.some(a => a.status === 'active')),
    },
    {
      q: 'How much revenue generated?',
      ans: finance ? fmtINR(finance.total_revenue) : null,
      pass: finance != null,
    },
    {
      q: 'How much profit generated?',
      ans: projects?.summary
        ? `Budget: ${fmtINR(projects.summary.total_budget)} | Actual: ${fmtINR(projects.summary.total_actual_cost)} | Margin: ${projects.summary.margin}%`
        : null,
      pass: !!(projects?.summary?.total_budget > 0),
    },
    {
      q: 'What is pending today?',
      ans: [
        service?.summary?.open_tickets ? `${service.summary.open_tickets} open tickets` : null,
        finance?.outstanding_balance > 0 ? `${fmtINR(finance.outstanding_balance)} outstanding` : null,
        projects?.projects?.filter(p => p.status === 'active').length
          ? `${projects.projects.filter(p => p.status === 'active').length} active project(s)` : null,
        amc?.summary?.expiring_soon ? `${amc.summary.expiring_soon} AMC expiring in 90d` : null,
      ].filter(Boolean).join(' | ') || 'Nothing critical pending',
      pass: true,
    },
  ];

  const passed = checks.filter(c => c.pass).length;
  const total  = checks.length;
  const pct    = Math.round((passed / total) * 100);
  const allPass = passed === total;

  return (
    <div>
      <div style={{
        ...C.card, padding: '20px 24px', marginBottom: 20,
        background: allPass ? '#f0fdf4' : pct >= 70 ? '#fffbeb' : '#fef2f2',
        border: `1px solid ${allPass ? '#bbf7d0' : pct >= 70 ? '#fde68a' : '#fecaca'}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: '#111827' }}>CEO Traceability Score</div>
            <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>
              {allPass
                ? '✅ All questions answerable from this screen — Customer 360 PASS'
                : `⚠ ${total - passed} question(s) require opening additional modules — review below`}
            </div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 32, fontWeight: 800, color: allPass ? C.green : pct >= 70 ? C.amber : C.red }}>
              {pct}%
            </div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{passed}/{total} passed</div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {checks.map((c, i) => (
          <Card key={i} style={{ padding: '14px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
              <span style={{ fontSize: 18, flexShrink: 0 }}>{c.pass ? '✅' : '❌'}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 4 }}>{c.q}</div>
                {c.ans
                  ? <div style={{ fontSize: 12, color: '#374151', background: '#f8f7fd', padding: '5px 10px', borderRadius: 6 }}>{c.ans}</div>
                  : <div style={{ fontSize: 12, color: '#dc2626' }}>Not available — data missing or not yet entered</div>
                }
              </div>
              {!c.pass && (
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 20,
                  background: '#fee2e2', color: '#dc2626', flexShrink: 0,
                }}>FAILURE</span>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────
export default function Customer360() {
  const toast = useToast();
  const [partyId, setPartyId]         = useState('');
  const [selected, setSelected]       = useState(null);
  const [activeTab, setActiveTab]     = useState('overview');

  // Section data
  const [core, setCore]               = useState(null);
  const [pipeline, setPipeline]       = useState(null);
  const [projects, setProjects]       = useState(null);
  const [service, setService]         = useState(null);
  const [amc, setAmc]                 = useState(null);
  const [manufacturing, setMfg]       = useState(null);
  const [commissioning, setComm]      = useState(null);
  const [health, setHealth]           = useState(null);
  const [timeline, setTimeline]       = useState(null);
  const [drive, setDrive]             = useState(null);

  const [tenders, setTenders]         = useState(null);
  const [travel, setTravel]           = useState(null);
  const [driveFolders, setDriveFolders] = useState(null);
  const [driveFiles, setDriveFiles]     = useState(null);
  const [driveProvisioning, setDriveProvisioning] = useState(false);

  const [loadingCore, setLoadingCore]         = useState(false);
  const [loadingSections, setLoadingSections] = useState(false);
  const [error, setError]                     = useState('');

  const abortRef = useRef(null);

  const loadAll = useCallback(async (id) => {
    if (!id) return;
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();

    setLoadingCore(true);
    setError('');
    setCore(null); setPipeline(null); setProjects(null);
    setService(null); setAmc(null); setMfg(null); setComm(null);
    setHealth(null); setTimeline(null); setDrive(null);
    setTenders(null); setTravel(null);
    setDriveFolders(null); setDriveFiles(null);

    // Wave 1: core data
    try {
      const r = await api.get(`/crm/customer360/${id}`);
      setCore(r.data);
    } catch (e) {
      if (e.name !== 'CanceledError') setError(e?.response?.data?.error || 'Failed to load customer');
      setLoadingCore(false);
      return;
    }
    setLoadingCore(false);
    setLoadingSections(true);

    // Wave 2: section data in parallel
    const safeGet = async (url, setter) => {
      try { const r = await api.get(url); setter(r.data); } catch {}
    };

    await Promise.all([
      safeGet(`/crm/customer360/${id}/pipeline`,        setPipeline),
      safeGet(`/crm/customer360/${id}/projects`,        setProjects),
      safeGet(`/crm/customer360/${id}/service`,         setService),
      safeGet(`/crm/customer360/${id}/amc`,             setAmc),
      safeGet(`/crm/customer360/${id}/manufacturing`,   setMfg),
      safeGet(`/crm/customer360/${id}/commissioning`,   setComm),
      safeGet(`/crm/customer360/${id}/health-score`,    setHealth),
      safeGet(`/crm/customer360/${id}/timeline`,        setTimeline),
      safeGet(`/crm/customer360/${id}/drive-folders`,   setDrive),
      safeGet(`/crm/customer360/${id}/tenders`,         setTenders),
      safeGet(`/crm/customer360/${id}/travel`,          setTravel),
      safeGet(`/crm/customer-drive/${id}/folders`,      setDriveFolders),
      safeGet(`/crm/customer-drive/${id}/files`,        setDriveFiles),
    ]);
    setLoadingSections(false);
  }, []);

  function handleSelect(p) {
    setPartyId(String(p.id));
    setSelected(p);
    setActiveTab('overview');
    loadAll(String(p.id));
  }

  function handleClear() {
    setPartyId('');
    setSelected(null);
    setError('');
    setCore(null);
    setDriveFolders(null);
    setDriveFiles(null);
  }

  async function handleProvisionDrive() {
    if (!partyId) return;
    setDriveProvisioning(true);
    try {
      await api.post(`/crm/customer-drive/provision/${partyId}`);
      const r = await api.get(`/crm/customer-drive/${partyId}/folders`);
      setDriveFolders(r.data);
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed to provision customer drive'); }
    setDriveProvisioning(false);
  }

  function openDriveFolder(folderUrl) {
    if (folderUrl) window.open(folderUrl, '_blank', 'noopener,noreferrer');
  }

  // ── Render tab content ───────────────────────────────────────────────────────
  function renderTab() {
    if (!core) return null;
    const { party, account, contacts, invoices, crm_emails,
            outstanding_balance, total_revenue, lifetime_value } = core;

    switch (activeTab) {

      // ── OVERVIEW ──────────────────────────────────────────────────────────────
      case 'overview': return (
        <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {/* Left sidebar */}
          <div style={{ width: 260, flexShrink: 0 }}>
            {/* Health score */}
            <Card style={{ marginBottom: 14, padding: '8px 0 4px' }}>
              <div style={{ textAlign: 'center', padding: '4px 0 8px', fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                Health Score
              </div>
              {health
                ? <HealthGauge score={health.score} label={health.label} grade={health.grade} />
                : <EmptyState icon="⏳" msg="Loading…" />}
            </Card>

            {/* Profile */}
            <Card style={{ marginBottom: 14, padding: 0 }}>
              <SectionHeader title="Customer Profile" />
              <div style={{ padding: '10px 16px' }}>
                {[
                  ['Type',         party.type],
                  ['GSTIN',        party.gstin],
                  ['PAN',          party.pan],
                  ['Industry',     account?.industry],
                  ['City / State', [party.city, party.state].filter(Boolean).join(', ')],
                  ['Email',        party.email],
                  ['Phone',        party.phone],
                  ['Credit Limit', account?.credit_limit ? fmtINR(account.credit_limit) : null],
                  ['Account Mgr',  account?.account_manager_name],
                  ['Status',       account?.status || party.status],
                ].map(([label, value]) => (
                  <div key={label} style={{
                    display: 'flex', justifyContent: 'space-between',
                    padding: '5px 0', borderBottom: '1px solid #f8f8fc',
                  }}>
                    <span style={{ fontSize: 11, color: '#9ca3af' }}>{label}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#111827', maxWidth: 150, textAlign: 'right' }}>
                      {value || '—'}
                    </span>
                  </div>
                ))}
              </div>
            </Card>

            {/* Customer type badge */}
            {account?.account_type && (
              <Card style={{ marginBottom: 14, padding: '12px 16px', textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6 }}>CUSTOMER TYPE</div>
                <Badge status={account.account_type} />
              </Card>
            )}
          </div>

          {/* Right main */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* KPI row */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
              <KpiCard label="Total Revenue" value={fmtINR(total_revenue)} color={C.green} />
              <KpiCard label="Outstanding" value={fmtINR(outstanding_balance)} color={outstanding_balance > 0 ? C.red : C.green} />
              <KpiCard label="Lifetime Value" value={fmtINR(lifetime_value)} color={C.primary} />
              <KpiCard label="Pipeline Value" value={fmtINR(pipeline?.summary?.total_pipeline_value)} color={C.blue} />
              <KpiCard label="Active Projects" value={String(projects?.summary?.active_projects || 0)} color={C.blue} />
              <KpiCard label="Open Tickets" value={String(service?.summary?.open_tickets || 0)} color={service?.summary?.open_tickets > 0 ? C.amber : C.green} />
              <KpiCard label="Win Rate" value={pipeline?.summary?.win_rate != null ? `${pipeline.summary.win_rate}%` : '—'} color={C.primary} />
              <KpiCard label="AMC Contracts" value={String(amc?.summary?.active_contracts || 0)} sub={amc?.summary?.expiring_soon ? `${amc.summary.expiring_soon} expiring soon` : undefined} color={C.green} />
            </div>

            {/* Health score breakdown */}
            {health && (
              <Card style={{ marginBottom: 16, padding: 0 }}>
                <SectionHeader title="Health Score Breakdown" />
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1 }}>
                  {[
                    ['Payment',        health.breakdown.payment_score,        25],
                    ['Engagement',     health.breakdown.engagement_score,     25],
                    ['Order Frequency',health.breakdown.order_frequency_score,25],
                    ['Support',        health.breakdown.support_score,        25],
                  ].map(([label, score, max]) => (
                    <div key={label} style={{ padding: '14px 16px', textAlign: 'center', borderRight: '1px solid #f0f0f4' }}>
                      <div style={{ fontSize: 16, fontWeight: 800, color: score >= max * 0.8 ? C.green : score >= max * 0.5 ? C.amber : C.red }}>
                        {score}/{max}
                      </div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>{label}</div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* Sales funnel */}
            {pipeline && (
              <Card style={{ marginBottom: 16, padding: 0 }}>
                <SectionHeader title="Sales Funnel" />
                <SalesFunnel summary={pipeline.summary} />
              </Card>
            )}
          </div>
        </div>
      );

      // ── CONTACTS ──────────────────────────────────────────────────────────────
      case 'contacts': {
        const avatarColors = [C.primary, C.blue, C.green, C.amber, C.red, '#0891b2'];
        const init = name => (name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
        const ROLE_MAP = {
          primary: { label: 'Primary', color: C.primary },
          technical: { label: 'Technical', color: C.blue },
          commercial: { label: 'Commercial', color: C.green },
          accounts: { label: 'Accounts', color: C.amber },
          service: { label: 'Service', color: '#0891b2' },
        };
        return (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14 }}>
            {contacts && contacts.length > 0 ? contacts.map((c, i) => (
              <Card key={c.id} style={{ padding: 18 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                  <div style={{
                    width: 44, height: 44, borderRadius: '50%',
                    background: avatarColors[i % avatarColors.length],
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#fff', fontWeight: 700, fontSize: 15, flexShrink: 0,
                  }}>{init(c.full_name)}</div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>{c.full_name}</div>
                    <div style={{ fontSize: 11, color: C.primary, fontWeight: 600 }}>{c.title || c.department || '—'}</div>
                    {c.contact_type && (
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 20, marginTop: 4, display: 'inline-block',
                        background: (ROLE_MAP[c.contact_type]?.color || '#6b7280') + '22',
                        color: ROLE_MAP[c.contact_type]?.color || '#6b7280',
                      }}>{ROLE_MAP[c.contact_type]?.label || c.contact_type}</span>
                    )}
                  </div>
                </div>
                {[['✉', c.email], ['📞', c.phone]].filter(([, v]) => v).map(([ic, val]) => (
                  <div key={ic} style={{ fontSize: 12, color: '#374151', padding: '3px 0' }}>
                    <span style={{ marginRight: 6 }}>{ic}</span>{val}
                  </div>
                ))}
              </Card>
            )) : <EmptyState icon="👥" msg="No contacts linked to this customer" />}
          </div>
        );
      }

      // ── SALES PIPELINE ────────────────────────────────────────────────────────
      case 'pipeline': return pipeline ? (
        <div>
          {/* KPIs */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
            <KpiCard label="Leads" value={pipeline.summary.lead_count} color="#6b7280" />
            <KpiCard label="Opportunities" value={pipeline.summary.opportunity_count} color={C.blue} />
            <KpiCard label="Pipeline Value" value={fmtINR(pipeline.summary.total_pipeline_value)} color={C.primary} />
            <KpiCard label="Quotations" value={pipeline.summary.quotation_count} color={C.amber} />
            <KpiCard label="POs Received" value={pipeline.summary.po_count} color={C.green} />
            <KpiCard label="Won Value" value={fmtINR(pipeline.summary.won_value)} color={C.green} />
            <KpiCard label="Win Rate" value={`${pipeline.summary.win_rate}%`} color={pipeline.summary.win_rate >= 50 ? C.green : C.red} />
          </div>

          {/* Funnel */}
          <Card style={{ marginBottom: 20, padding: 0 }}>
            <SectionHeader title="Sales Funnel — Lead → Opportunity → Quotation → PO" />
            <SalesFunnel summary={pipeline.summary} />
          </Card>

          {/* Opportunities table */}
          <Card style={{ marginBottom: 20, padding: 0 }}>
            <SectionHeader title="Opportunities" count={pipeline.opportunities.length} />
            <Table
              headers={['Opportunity', 'Value', 'Probability', 'Stage', 'Assigned To', 'Close Date']}
              emptyMsg="No opportunities found"
              rows={pipeline.opportunities.map(o => (
                <tr key={o.id}>
                  <TD bold>{o.opportunity_name}</TD>
                  <TD primary>{fmtINR(o.expected_value)}</TD>
                  <TD>{o.probability_percentage != null ? `${o.probability_percentage}%` : '—'}</TD>
                  <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}>
                    <Badge status={o.stage} />
                  </td>
                  <TD>{o.assigned_to_name || '—'}</TD>
                  <TD>{fmtDate(o.expected_closing_date)}</TD>
                </tr>
              ))}
            />
          </Card>

          {/* Leads table */}
          {pipeline.leads.length > 0 && (
            <Card style={{ padding: 0 }}>
              <SectionHeader title="Associated Leads" count={pipeline.leads.length} />
              <Table
                headers={['Company', 'Contact', 'Source', 'Status', 'Assigned To', 'Date']}
                emptyMsg="No leads"
                rows={pipeline.leads.map(l => (
                  <tr key={l.id}>
                    <TD bold>{l.company_name}</TD>
                    <TD>{l.contact_person}</TD>
                    <TD>{l.lead_source}</TD>
                    <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}><Badge status={l.status} /></td>
                    <TD>{l.assigned_to_name || '—'}</TD>
                    <TD>{fmtDate(l.created_at)}</TD>
                  </tr>
                ))}
              />
            </Card>
          )}
        </div>
      ) : <EmptyState icon="📊" msg="Loading pipeline data…" />;

      // ── COMMERCIAL ────────────────────────────────────────────────────────────
      case 'commercial': return (
        <div>
          <Card style={{ marginBottom: 20, padding: 0 }}>
            <SectionHeader title="All Quotations" count={pipeline?.quotations?.length || 0} />
            <Table
              headers={['Quotation No.', 'Date', 'Validity', 'Value', 'Status']}
              emptyMsg="No quotations found"
              rows={(pipeline?.quotations || []).map(q => (
                <tr key={q.id}>
                  <TD primary>{q.quotation_number}</TD>
                  <TD>{fmtDate(q.quotation_date)}</TD>
                  <TD>{fmtDate(q.validity_date)}</TD>
                  <TD bold>{fmtINR(q.total_amount)}</TD>
                  <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}><Badge status={q.status} /></td>
                </tr>
              ))}
            />
          </Card>

          <Card style={{ padding: 0 }}>
            <SectionHeader title="Purchase Orders Received" count={pipeline?.sales_orders?.length || 0} />
            <Table
              headers={['PO Number', 'PO Date', 'Delivery Date', 'Value', 'Status']}
              emptyMsg="No purchase orders found"
              rows={(pipeline?.sales_orders || []).map(o => (
                <tr key={o.id}>
                  <TD primary>{o.order_number}</TD>
                  <TD>{fmtDate(o.order_date)}</TD>
                  <TD>{fmtDate(o.delivery_date)}</TD>
                  <TD bold>{fmtINR(o.total_amount)}</TD>
                  <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}><Badge status={o.status} /></td>
                </tr>
              ))}
            />
          </Card>
        </div>
      );

      // ── PROJECTS ──────────────────────────────────────────────────────────────
      case 'projects': return projects ? (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
            <KpiCard label="Total Projects" value={projects.summary.total_projects} />
            <KpiCard label="Active" value={projects.summary.active_projects} color={C.blue} />
            <KpiCard label="Completed" value={projects.summary.completed_projects} color={C.green} />
            <KpiCard label="Total Budget" value={fmtINR(projects.summary.total_budget)} color={C.primary} />
            <KpiCard label="Actual Cost" value={fmtINR(projects.summary.total_actual_cost)} color={C.amber} />
            <KpiCard label="Margin" value={`${projects.summary.margin}%`} color={projects.summary.margin >= 20 ? C.green : C.red} />
          </div>

          {projects.projects.length === 0
            ? <EmptyState icon="🏗" msg="No projects found for this customer" />
            : projects.projects.map(p => (
              <Card key={p.id} style={{ marginBottom: 14, padding: 0 }}>
                <div style={{ padding: '14px 18px', borderBottom: '1px solid #f0f0f4' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                    <div>
                      <span style={{ fontSize: 13, fontWeight: 700, color: C.primary }}>{p.project_code}</span>
                      <span style={{ marginLeft: 10, fontSize: 14, fontWeight: 700, color: '#111827' }}>{p.project_name}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Badge status={p.status} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 20, marginTop: 10, flexWrap: 'wrap' }}>
                    {[
                      ['PM',       p.project_manager_name],
                      ['Start',    fmtDate(p.start_date)],
                      ['End',      fmtDate(p.end_date)],
                      ['Budget',   fmtINR(p.budget_amount)],
                      ['Actual',   fmtINR(p.actual_cost)],
                      ['Margin',   p.budget_amount > 0 ? `${Math.round(((p.budget_amount - p.actual_cost) / p.budget_amount) * 100)}%` : '—'],
                      ['Health',   p.health_score != null ? `${p.health_score}%` : '—'],
                      ['Milestones', `${p.milestones_done}/${p.milestone_count}`],
                    ].map(([k, v]) => (
                      <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span style={{ fontSize: 10, color: '#9ca3af', textTransform: 'uppercase' }}>{k}</span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>{v || '—'}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ padding: '10px 18px' }}>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>MILESTONE STAGES</div>
                  <MilestoneBar milestones={p.milestones} />
                </div>
              </Card>
            ))}
        </div>
      ) : <EmptyState icon="⏳" msg="Loading projects…" />;

      // ── ENGINEERING ───────────────────────────────────────────────────────────
      case 'engineering': return (
        <div>
          <Card style={{ marginBottom: 20, padding: 0 }}>
            <SectionHeader title="Associated BOMs" count={manufacturing?.boms?.length || 0} />
            <Table
              headers={['BOM Code', 'Product', 'Revision', 'Status', 'Created']}
              emptyMsg="No BOMs linked to this customer's production orders"
              rows={(manufacturing?.boms || []).map(b => (
                <tr key={b.id}>
                  <TD primary>{b.bom_code}</TD>
                  <TD bold>{b.product_name}</TD>
                  <TD>{b.revision || 'A'}</TD>
                  <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}><Badge status={b.status} /></td>
                  <TD>{fmtDate(b.created_at)}</TD>
                </tr>
              ))}
            />
          </Card>

          <Card style={{ padding: 16 }}>
            <div style={{ fontWeight: 700, fontSize: 13, color: '#374151', marginBottom: 12 }}>
              Engineering Document Checklist
            </div>
            {[
              'BOM Revisions',
              'Engineering Change Notices (ECNs)',
              'Drawings (GA, Electrical, Piping)',
              'Technical Documents',
              'Approval History',
              'Test Procedures',
            ].map(item => (
              <div key={item} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '6px 0', borderBottom: '1px solid #f8f8fc', fontSize: 12, color: '#374151',
              }}>
                <span style={{ color: '#d1d5db', fontSize: 16 }}>☐</span>
                {item}
              </div>
            ))}
          </Card>
        </div>
      );

      // ── PROCUREMENT & MANUFACTURING ───────────────────────────────────────────
      case 'procurement': return (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
            <KpiCard label="Production Orders" value={manufacturing?.summary?.total_production_orders || 0} />
            <KpiCard label="FAT Records" value={manufacturing?.summary?.fat_count || 0} color={C.blue} />
            <KpiCard label="NCR Count" value={manufacturing?.summary?.ncr_count || 0} color={manufacturing?.summary?.open_ncrs > 0 ? C.red : C.green} />
            <KpiCard label="Open NCRs" value={manufacturing?.summary?.open_ncrs || 0} color={C.red} />
          </div>

          <Card style={{ marginBottom: 20, padding: 0 }}>
            <SectionHeader title="Production Orders" count={manufacturing?.production_orders?.length || 0} />
            <Table
              headers={['Order No.', 'BOM', 'Product', 'Status', 'Planned Start', 'Planned End', 'Qty Planned', 'Qty Produced']}
              emptyMsg="No production orders linked to this customer"
              rows={(manufacturing?.production_orders || []).map(o => (
                <tr key={o.id}>
                  <TD primary>{o.order_number || o.id?.slice(0, 8)}</TD>
                  <TD>{o.bom_code || '—'}</TD>
                  <TD bold>{o.product_name || '—'}</TD>
                  <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}><Badge status={o.status} /></td>
                  <TD>{fmtDate(o.planned_start)}</TD>
                  <TD>{fmtDate(o.planned_end)}</TD>
                  <TD>{o.quantity_planned}</TD>
                  <TD>{o.quantity_produced}</TD>
                </tr>
              ))}
            />
          </Card>

          <Card style={{ padding: 0 }}>
            <SectionHeader title="Non-Conformance Reports (NCRs)" count={manufacturing?.ncrs?.length || 0} />
            <Table
              headers={['NCR Number', 'Description', 'Severity', 'Status', 'Date']}
              emptyMsg="No NCRs for this customer"
              rows={(manufacturing?.ncrs || []).map(n => (
                <tr key={n.id}>
                  <TD primary>{n.ncr_number}</TD>
                  <TD>{n.description}</TD>
                  <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}><Badge status={n.severity} /></td>
                  <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}><Badge status={n.status} /></td>
                  <TD>{fmtDate(n.created_at)}</TD>
                </tr>
              ))}
            />
          </Card>
        </div>
      );

      // ── QUALITY ───────────────────────────────────────────────────────────────
      case 'quality': return (
        <div>
          <Card style={{ marginBottom: 20, padding: 0 }}>
            <SectionHeader title="FAT Reports (Factory Acceptance Tests)" count={manufacturing?.fat_records?.length || 0} />
            <Table
              headers={['Report No.', 'Scheduled', 'Completed', 'Witness', 'Result', 'Status']}
              emptyMsg="No FAT reports for this customer"
              rows={(manufacturing?.fat_records || []).map(f => (
                <tr key={f.id}>
                  <TD primary>{f.report_number || f.id?.slice(0, 8)}</TD>
                  <TD>{fmtDate(f.scheduled_date)}</TD>
                  <TD>{fmtDate(f.completed_date)}</TD>
                  <TD>{f.witness_name || '—'}</TD>
                  <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}><Badge status={f.result} /></td>
                  <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}><Badge status={f.status} /></td>
                </tr>
              ))}
            />
          </Card>

          <Card style={{ marginBottom: 20, padding: 0 }}>
            <SectionHeader title="SAT Reports (Site Acceptance Tests)" count={commissioning?.sat_reports?.length || 0} />
            <Table
              headers={['Report No.', 'SAT Date', 'Witness', 'Result', 'Status']}
              emptyMsg="No SAT reports for this customer"
              rows={(commissioning?.sat_reports || []).map(s => (
                <tr key={s.id}>
                  <TD primary>{s.report_number}</TD>
                  <TD>{fmtDate(s.sat_date)}</TD>
                  <TD>{s.witness_name || '—'}</TD>
                  <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}><Badge status={s.result} /></td>
                  <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}><Badge status={s.status} /></td>
                </tr>
              ))}
            />
          </Card>

          <Card style={{ padding: 0 }}>
            <SectionHeader title="NCRs & Quality Issues" count={manufacturing?.ncrs?.length || 0} />
            {manufacturing?.ncrs?.length === 0
              ? <EmptyState icon="✅" msg="No NCRs — clean quality record" />
              : <Table
                headers={['NCR No.', 'Issue', 'Severity', 'Status', 'Date']}
                rows={(manufacturing?.ncrs || []).map(n => (
                  <tr key={n.id}>
                    <TD primary>{n.ncr_number}</TD>
                    <TD>{n.description}</TD>
                    <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}><Badge status={n.severity} /></td>
                    <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}><Badge status={n.status} /></td>
                    <TD>{fmtDate(n.created_at)}</TD>
                  </tr>
                ))}
              />
            }
          </Card>
        </div>
      );

      // ── COMMISSIONING ─────────────────────────────────────────────────────────
      case 'commissioning': return commissioning ? (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
            <KpiCard label="Commissioning Reports" value={commissioning.summary.commissioning_count} />
            <KpiCard label="SAT Reports" value={commissioning.summary.sat_count} color={C.blue} />
            <KpiCard label="Dispatches" value={commissioning.summary.dispatch_count} color={C.green} />
            <KpiCard label="Pending Commissioning" value={commissioning.summary.pending_commissioning} color={C.amber} />
            <KpiCard label="Accepted SATs" value={commissioning.summary.accepted_sat} color={C.green} />
          </div>

          <Card style={{ marginBottom: 20, padding: 0 }}>
            <SectionHeader title="Commissioning Reports" count={commissioning.commissioning_reports.length} />
            <Table
              headers={['Report No.', 'Site', 'Date', 'Engineer', 'Acceptance Status', 'Status']}
              emptyMsg="No commissioning reports"
              rows={commissioning.commissioning_reports.map(c => (
                <tr key={c.id}>
                  <TD primary>{c.report_number || c.id?.slice(0, 8)}</TD>
                  <TD>{c.site_location || '—'}</TD>
                  <TD>{fmtDate(c.commissioning_date)}</TD>
                  <TD>{c.engineer_id || '—'}</TD>
                  <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}><Badge status={c.acceptance_status} /></td>
                  <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}><Badge status={c.status} /></td>
                </tr>
              ))}
            />
          </Card>

          <Card style={{ padding: 0 }}>
            <SectionHeader title="Dispatch Records" count={commissioning.dispatch_records.length} />
            <Table
              headers={['Dispatch No.', 'Date', 'Mode', 'Tracking', 'Vehicle', 'Driver', 'Delivery Date', 'Status']}
              emptyMsg="No dispatch records"
              rows={commissioning.dispatch_records.map(d => (
                <tr key={d.id}>
                  <TD primary>{d.dispatch_number}</TD>
                  <TD>{fmtDate(d.dispatch_date)}</TD>
                  <TD>{d.transport_mode || '—'}</TD>
                  <TD>{d.tracking_number || '—'}</TD>
                  <TD>{d.vehicle_number || '—'}</TD>
                  <TD>{d.driver_name || '—'}</TD>
                  <TD>{fmtDate(d.delivery_date)}</TD>
                  <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}><Badge status={d.status} /></td>
                </tr>
              ))}
            />
          </Card>
        </div>
      ) : <EmptyState icon="⏳" msg="Loading commissioning data…" />;

      // ── SERVICE ───────────────────────────────────────────────────────────────
      case 'service': return service ? (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
            <KpiCard label="Open Tickets" value={service.summary.open_tickets} color={service.summary.open_tickets > 0 ? C.red : C.green} />
            <KpiCard label="Closed Tickets" value={service.summary.closed_tickets} color={C.green} />
            <KpiCard label="Critical Open" value={service.summary.critical_open} color={service.summary.critical_open > 0 ? C.red : '#6b7280'} />
            <KpiCard label="Field Visits" value={service.summary.total_visits} color={C.blue} />
            <KpiCard label="Avg Resolution" value={fmtDays(service.summary.avg_resolution_days)} color={C.amber} />
          </div>

          <Card style={{ marginBottom: 20, padding: 0 }}>
            <SectionHeader title="Support Tickets" count={service.tickets.length} />
            <Table
              headers={['Subject', 'Priority', 'Status', 'Created', 'Resolved', 'Resolution Days']}
              emptyMsg="No support tickets"
              rows={service.tickets.map(t => (
                <tr key={t.id}>
                  <TD bold>{t.subject}</TD>
                  <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}><Badge status={t.priority} /></td>
                  <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}><Badge status={t.status} /></td>
                  <TD>{fmtDate(t.created_at)}</TD>
                  <TD>{fmtDate(t.resolved_at)}</TD>
                  <TD>{t.resolution_days != null ? `${t.resolution_days}d` : '—'}</TD>
                </tr>
              ))}
            />
          </Card>

          <Card style={{ marginBottom: 20, padding: 0 }}>
            <SectionHeader title="Service Contracts" count={service.service_contracts.length} />
            <Table
              headers={['Contract No.', 'Start', 'End', 'Coverage', 'Value', 'Status']}
              emptyMsg="No service contracts"
              rows={service.service_contracts.map(c => (
                <tr key={c.id}>
                  <TD primary>{c.contract_number}</TD>
                  <TD>{fmtDate(c.start_date)}</TD>
                  <TD>{fmtDate(c.end_date)}</TD>
                  <TD>{c.coverage_type || '—'}</TD>
                  <TD bold>{fmtINR(c.contract_value)}</TD>
                  <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}><Badge status={c.status} /></td>
                </tr>
              ))}
            />
          </Card>

          <Card style={{ padding: 0 }}>
            <SectionHeader title="Field Service Visits" count={service.field_visits.length} />
            <Table
              headers={['Visit Date', 'Purpose', 'Engineer', 'Status', 'Notes']}
              emptyMsg="No field service visits"
              rows={service.field_visits.map(v => (
                <tr key={v.id}>
                  <TD>{fmtDate(v.visit_date)}</TD>
                  <TD bold>{v.purpose || '—'}</TD>
                  <TD>{v.engineer_name || '—'}</TD>
                  <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}><Badge status={v.status} /></td>
                  <TD>{v.notes || '—'}</TD>
                </tr>
              ))}
            />
          </Card>
        </div>
      ) : <EmptyState icon="⏳" msg="Loading service data…" />;

      // ── AMC ───────────────────────────────────────────────────────────────────
      case 'amc': return amc ? (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
            <KpiCard label="Total Contracts" value={amc.summary.total_contracts} />
            <KpiCard label="Active" value={amc.summary.active_contracts} color={C.green} />
            <KpiCard label="Expiring in 90d" value={amc.summary.expiring_soon} color={amc.summary.expiring_soon > 0 ? C.red : C.green} />
            <KpiCard label="AMC Revenue" value={fmtINR(amc.summary.total_amc_revenue)} color={C.primary} />
          </div>

          <Card style={{ marginBottom: 20, padding: 0 }}>
            <SectionHeader title="AMC Contracts" count={amc.amc_contracts.length} />
            <Table
              headers={['Contract No.', 'Coverage', 'Start', 'End', 'Renewal Date', 'Annual Value', 'Total Value', 'Status']}
              emptyMsg="No AMC contracts"
              rows={amc.amc_contracts.map(a => (
                <tr key={a.id}>
                  <TD primary>{a.contract_number}</TD>
                  <TD>{a.coverage_type || '—'}</TD>
                  <TD>{fmtDate(a.start_date)}</TD>
                  <TD>{fmtDate(a.end_date)}</TD>
                  <TD>{fmtDate(a.renewal_date)}</TD>
                  <TD bold>{fmtINR(a.annual_value)}</TD>
                  <TD>{fmtINR(a.total_value)}</TD>
                  <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}><Badge status={a.status} /></td>
                </tr>
              ))}
            />
          </Card>

          {amc.warranty_records.length > 0 && (
            <Card style={{ padding: 0 }}>
              <SectionHeader title="Warranty Register" count={amc.warranty_records.length} />
              <Table
                headers={['Product', 'Serial No.', 'Type', 'Warranty Start', 'Warranty End', 'Status']}
                emptyMsg="No warranty records"
                rows={amc.warranty_records.map(w => (
                  <tr key={w.id}>
                    <TD bold>{w.product_name}</TD>
                    <TD primary>{w.serial_number}</TD>
                    <TD>{w.warranty_type || '—'}</TD>
                    <TD>{fmtDate(w.warranty_start)}</TD>
                    <TD>{fmtDate(w.warranty_end)}</TD>
                    <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}><Badge status={w.status} /></td>
                  </tr>
                ))}
              />
            </Card>
          )}
        </div>
      ) : <EmptyState icon="⏳" msg="Loading AMC data…" />;

      // ── FINANCE ───────────────────────────────────────────────────────────────
      case 'finance': {
        // Aging buckets
        const now = Date.now();
        const agingBuckets = [
          { range: 'Current',    amount: 0 },
          { range: '1–30 days',  amount: 0 },
          { range: '31–60 days', amount: 0 },
          { range: '61–90 days', amount: 0 },
          { range: '90+ days',   amount: 0 },
        ];
        (invoices || []).filter(i => i.status !== 'paid').forEach(inv => {
          const age = Math.floor((now - new Date(inv.created_at)) / 86400000);
          const amt = parseFloat(inv.total_amount || 0);
          if (age <= 0)       agingBuckets[0].amount += amt;
          else if (age <= 30) agingBuckets[1].amount += amt;
          else if (age <= 60) agingBuckets[2].amount += amt;
          else if (age <= 90) agingBuckets[3].amount += amt;
          else                agingBuckets[4].amount += amt;
        });
        const hasAging = agingBuckets.some(b => b.amount > 0);

        return (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
              <KpiCard label="Total Revenue" value={fmtINR(total_revenue)} color={C.green} />
              <KpiCard label="Outstanding" value={fmtINR(outstanding_balance)} color={outstanding_balance > 0 ? C.red : C.green} />
              <KpiCard label="Lifetime Value" value={fmtINR(lifetime_value)} color={C.primary} />
              <KpiCard label="Avg Order Value" value={fmtINR(core.avg_order_value)} color={C.blue} />
              <KpiCard label="Total Invoices" value={core.total_invoices} />
              <KpiCard label="Orders This Year" value={core.orders_this_year} />
              <KpiCard label="Avg Days to Pay" value={fmtDays(core.avg_days_to_pay)} color={core.avg_days_to_pay > 45 ? C.red : C.green} />
            </div>

            <Card style={{ marginBottom: 20, padding: 0 }}>
              <SectionHeader title="Invoices" count={invoices?.length || 0} />
              <Table
                headers={['Invoice No.', 'Date', 'Due Date', 'Amount', 'Status']}
                emptyMsg="No invoices found"
                rows={(invoices || []).map(inv => (
                  <tr key={inv.id}>
                    <TD primary>{inv.invoice_number || inv.id}</TD>
                    <TD>{fmtDate(inv.created_at)}</TD>
                    <TD>{fmtDate(inv.due_date)}</TD>
                    <TD bold>{fmtINR(inv.total_amount)}</TD>
                    <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}><Badge status={inv.status} /></td>
                  </tr>
                ))}
              />
            </Card>

            {hasAging && (
              <Card style={{ padding: 20 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: '#111827', marginBottom: 16 }}>Aging Analysis (Outstanding)</div>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={agingBuckets.filter(b => b.amount > 0)} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" />
                    <XAxis dataKey="range" tick={{ fontSize: 12 }} />
                    <YAxis tickFormatter={v => v >= 100000 ? `₹${(v / 100000).toFixed(1)}L` : `₹${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={v => [fmtINR(v), 'Outstanding']} />
                    <Bar dataKey="amount" radius={[6, 6, 0, 0]}>
                      {agingBuckets.map((_, i) => (
                        <Cell key={i} fill={['#6B3FDB', '#a78bfa', '#fbbf24', '#f87171', '#dc2626'][i]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </Card>
            )}
          </div>
        );
      }

      // ── DOCUMENTS ─────────────────────────────────────────────────────────────
      case 'documents': return (
        <DocumentsTab
          partyId={partyId}
          driveFolders={driveFolders}
          driveFiles={driveFiles}
          legacyDrive={drive}
          driveProvisioning={driveProvisioning}
          onProvision={handleProvisionDrive}
          onOpenFolder={openDriveFolder}
        />
      );

      // ── TENDERS ───────────────────────────────────────────────────────────────
      case 'tenders': return tenders ? (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
            <KpiCard label="Total Tenders" value={tenders.summary.total} />
            <KpiCard label="Live / Active" value={tenders.summary.live} color={C.blue} />
            <KpiCard label="Won" value={tenders.summary.won} color={C.green} />
            <KpiCard label="Lost" value={tenders.summary.lost} color={C.red} />
            <KpiCard label="Total Bid Value" value={fmtINR(tenders.summary.total_bid_value)} color={C.primary} />
            <KpiCard label="Won Value" value={fmtINR(tenders.summary.won_value)} color={C.green} />
            <KpiCard label="Strike Rate" value={`${tenders.summary.strike_rate}%`} color={tenders.summary.strike_rate >= 40 ? C.green : C.amber} />
          </div>

          <Card style={{ marginBottom: 20, padding: 0 }}>
            <SectionHeader title="Tender / Bid Register" count={tenders.tenders.length} />
            {tenders.tenders.length === 0
              ? <EmptyState icon="📑" msg="No tenders found for this customer" />
              : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: '#fafafa' }}>
                        {['Opportunity', 'Tender No.', 'Source', 'Bid Value', 'Deadline', 'Bid Type', 'EMD', 'EMD Status', 'LOA Received', 'LOA Value', 'Stage', 'Assigned To'].map(h => (
                          <th key={h} style={{ padding: '8px 14px', fontSize: 11, fontWeight: 700, color: '#6b7280', textAlign: 'left', textTransform: 'uppercase', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tenders.tenders.map(t => (
                        <tr key={t.id}>
                          <TD bold>{t.opportunity_name}</TD>
                          <TD primary>{t.tender_number || '—'}</TD>
                          <TD>{t.tender_source || '—'}</TD>
                          <TD bold>{fmtINR(t.expected_value)}</TD>
                          <TD>{fmtDate(t.submission_deadline)}</TD>
                          <TD>{t.bid_type || '—'}</TD>
                          <TD>{t.emd_amount ? fmtINR(t.emd_amount) : '—'}</TD>
                          <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}>
                            {t.emd_status ? <Badge status={t.emd_status} /> : <span style={{ color: '#9ca3af' }}>—</span>}
                          </td>
                          <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}>
                            {t.loa_received
                              ? <span style={{ color: C.green, fontWeight: 700 }}>Yes {t.loa_date ? `(${fmtDate(t.loa_date)})` : ''}</span>
                              : <span style={{ color: '#9ca3af' }}>No</span>}
                          </td>
                          <TD bold>{t.loa_amount ? fmtINR(t.loa_amount) : '—'}</TD>
                          <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}>
                            <Badge status={t.stage} />
                          </td>
                          <TD>{t.assigned_to_name || '—'}</TD>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </Card>
        </div>
      ) : <EmptyState icon="⏳" msg="Loading tender data…" />;

      // ── TRAVEL COST ────────────────────────────────────────────────────────────
      case 'travel': return travel ? (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
            <KpiCard label="Customer Visits" value={travel.summary.total_visits} color={C.blue} />
            <KpiCard label="Project Trips" value={travel.summary.total_project_trips} color={C.primary} />
            <KpiCard label="Total Travel Cost" value={fmtINR(travel.summary.total_travel_cost)} color={C.amber} />
          </div>

          {/* By Type breakdown */}
          {travel.by_type.length > 0 && (
            <Card style={{ marginBottom: 20, padding: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#111827', marginBottom: 14 }}>Travel Cost by Type</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {travel.by_type.map(t => {
                  const total = travel.summary.total_travel_cost || 1;
                  return (
                    <div key={t.type} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ width: 140, fontSize: 12, fontWeight: 600, color: '#374151' }}>{t.type}</span>
                      <div style={{ flex: 1, height: 22, background: '#f3f4f6', borderRadius: 6, overflow: 'hidden' }}>
                        <div style={{ height: '100%', background: C.primary, width: `${Math.min(100, (t.cost / total) * 100)}%`, borderRadius: 6, display: 'flex', alignItems: 'center', paddingLeft: 8 }}>
                          <span style={{ color: '#fff', fontSize: 11, fontWeight: 700 }}>{t.trips} trip{t.trips !== 1 ? 's' : ''}</span>
                        </div>
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 700, color: C.primary, width: 90, textAlign: 'right' }}>{fmtINR(t.cost)}</span>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* Customer Visits */}
          <Card style={{ marginBottom: 20, padding: 0 }}>
            <SectionHeader title="Customer Visits (Sales / Pre-Sales)" count={travel.customer_visits.length} />
            <Table
              headers={['Visit Date', 'Type', 'Purpose', 'Location', 'Visited By', 'Next Follow-up']}
              emptyMsg="No customer visits recorded"
              rows={(travel.customer_visits || []).map(v => (
                <tr key={v.id}>
                  <TD bold>{fmtDate(v.visit_date)}</TD>
                  <TD>{v.visit_type || '—'}</TD>
                  <TD>{v.purpose || '—'}</TD>
                  <TD>{v.location || '—'}</TD>
                  <TD>{v.visited_by_name || '—'}</TD>
                  <TD>{fmtDate(v.next_followup_date)}</TD>
                </tr>
              ))}
            />
          </Card>

          {/* Project Travel */}
          <Card style={{ padding: 0 }}>
            <SectionHeader title="Project Travel (Commissioning / Engineering)" count={travel.project_travel.length} />
            <Table
              headers={['Request No.', 'Type', 'From', 'To', 'Destination', 'Project', 'Budget', 'Actual Cost', 'Status']}
              emptyMsg="No project travel records"
              rows={(travel.project_travel || []).map(t => (
                <tr key={t.id}>
                  <TD primary>{t.request_number || t.id}</TD>
                  <TD>{t.travel_type || '—'}</TD>
                  <TD>{fmtDate(t.from_date)}</TD>
                  <TD>{fmtDate(t.to_date)}</TD>
                  <TD>{t.destination || '—'}</TD>
                  <TD bold>{t.project_code ? `${t.project_code} — ${t.project_name}` : '—'}</TD>
                  <TD>{fmtINR(t.budget)}</TD>
                  <TD bold>{fmtINR(t.actual_cost)}</TD>
                  <td style={{ padding: '9px 14px', borderBottom: '1px solid #f8f8fc' }}><Badge status={t.status} /></td>
                </tr>
              ))}
            />
          </Card>
        </div>
      ) : <EmptyState icon="⏳" msg="Loading travel data…" />;

      // ── TIMELINE ──────────────────────────────────────────────────────────────
      case 'timeline': return (
        <div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 20 }}>
            {Object.entries(EVENT_COLOR).map(([type, color]) => (
              <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block' }} />
                <span style={{ color: '#6b7280', textTransform: 'capitalize' }}>{type}</span>
              </div>
            ))}
          </div>
          {timeline ? <TimelineView events={timeline} /> : <EmptyState icon="⏳" msg="Loading timeline…" />}
        </div>
      );

      // ── CEO TRACEABILITY TEST ─────────────────────────────────────────────────
      case 'ceo': return (
        <CEOTraceTest
          core={core}
          pipeline={pipeline}
          projects={projects}
          manufacturing={manufacturing ? { ...manufacturing, commissioning } : null}
          service={service}
          amc={amc}
          finance={{ total_revenue, outstanding_balance, lifetime_value }}
        />
      );

      default: return null;
    }
  }

  const hasData = !!core;

  return (
    <div style={{ padding: 24, background: C.surface, minHeight: '100vh', fontFamily: 'system-ui, -apple-system, sans-serif' }}>

      {/* Page header */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#111827' }}>
          Customer 360° Command Center
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
          Complete customer intelligence — Lead creation to AMC renewal in one screen
        </p>
      </div>

      {/* Search bar */}
      <Card style={{ padding: '14px 20px', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#374151', whiteSpace: 'nowrap' }}>Select Customer</span>
          <CustomerCombobox selected={selected} onSelect={handleSelect} onClear={handleClear} />
          {loadingSections && (
            <span style={{ fontSize: 12, color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                width: 14, height: 14, border: `2px solid ${C.border}`, borderTopColor: C.primary,
                borderRadius: '50%', display: 'inline-block',
                animation: 'spin360 0.7s linear infinite',
              }} />
              Loading sections…
              <style>{`@keyframes spin360{to{transform:rotate(360deg)}}`}</style>
            </span>
          )}
        </div>
      </Card>

      {/* Empty state */}
      {!partyId && (
        <Card style={{ padding: 60, textAlign: 'center' }}>
          <div style={{ fontSize: 56, marginBottom: 16 }}>🎯</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: '#374151', marginBottom: 8 }}>
            Select a Customer
          </div>
          <div style={{ fontSize: 14, color: '#9ca3af', maxWidth: 400, margin: '0 auto' }}>
            Search for a customer to load their complete 360° profile — from first lead to active AMC contracts.
          </div>
          <div style={{ marginTop: 24, display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            {['Sales Pipeline', 'Projects', 'FAT / SAT', 'AMC', 'Finance', 'CEO Test'].map(tag => (
              <span key={tag} style={{
                padding: '4px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                background: C.light, color: C.primary, border: `1px solid ${C.border}`,
              }}>{tag}</span>
            ))}
          </div>
        </Card>
      )}

      {/* Error state */}
      {partyId && error && (
        <Card style={{ padding: 40, textAlign: 'center', border: '1px solid #fecaca' }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#dc2626', marginBottom: 8 }}>Failed to Load Customer</div>
          <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 20 }}>{error}</div>
          <button onClick={() => loadAll(partyId)} style={{
            padding: '8px 20px', background: C.primary, color: '#fff',
            border: 'none', borderRadius: 8, fontWeight: 600, cursor: 'pointer', fontSize: 13,
          }}>Retry</button>
        </Card>
      )}

      {/* Loading state */}
      {partyId && loadingCore && !error && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{
              width: 44, height: 44, border: `3px solid ${C.border}`, borderTopColor: C.primary,
              borderRadius: '50%', animation: 'spin360 0.8s linear infinite', margin: '0 auto 14px',
            }} />
            <div style={{ color: '#6b7280', fontSize: 14 }}>Loading customer profile…</div>
          </div>
        </div>
      )}

      {/* Loaded content */}
      {hasData && !loadingCore && !error && (() => {
        const { party } = core;
        const name = party.name || 'Unknown Customer';

        return (
          <>
            {/* Customer header banner */}
            <Card style={{ padding: '18px 24px', marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: '#111827' }}>{name}</h2>
                  <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>
                    {[core.account?.industry, party.city, party.state, party.gstin ? `GSTIN: ${party.gstin}` : null, core.account?.account_manager_name ? `AM: ${core.account.account_manager_name}` : null].filter(Boolean).join(' · ')}
                  </div>
                  {party.created_at && (
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                      Customer Since {new Date(party.created_at).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  {health && (
                    <div style={{
                      padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 700,
                      background: health.score >= 90 ? '#dcfce7' : health.score >= 75 ? '#fef9c3' : '#fee2e2',
                      color: health.score >= 90 ? C.green : health.score >= 75 ? C.amber : C.red,
                      border: `1px solid ${health.score >= 90 ? '#bbf7d0' : health.score >= 75 ? '#fde68a' : '#fecaca'}`,
                    }}>
                      {health.label} · {health.score}/100
                    </div>
                  )}
                  {core.account?.status && <Badge status={core.account.status} />}
                </div>
              </div>

              {/* Action Buttons */}
              <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
                <ActionBtn icon="💡" label="New Opportunity"
                  color="#2563eb"
                  onClick={() => window.dispatchEvent(new CustomEvent('pulse:navigate', { detail: { page: 'OpportunitiesKanban' } }))} />
                <ActionBtn icon="📋" label="New Quotation"
                  color="#d97706"
                  onClick={() => window.dispatchEvent(new CustomEvent('pulse:navigate', { detail: { page: 'Quotations' } }))} />
                <ActionBtn icon="🏗" label="New Project"
                  color="#0891b2"
                  onClick={() => window.dispatchEvent(new CustomEvent('pulse:navigate', { detail: { page: 'Projects' } }))} />
                <ActionBtn icon="🎫" label="Raise Ticket"
                  color="#dc2626"
                  onClick={() => window.dispatchEvent(new CustomEvent('pulse:navigate', { detail: { page: 'ServiceDesk' } }))} />
                <ActionBtn icon="🔄" label="Create AMC"
                  color="#16a34a"
                  onClick={() => window.dispatchEvent(new CustomEvent('pulse:navigate', { detail: { page: 'AMCManagement' } }))} />
                {driveFolders?.provisioned ? (
                  <ActionBtn icon="📁" label="Open Google Drive"
                    color="#6B3FDB"
                    onClick={() => {
                      const rootFolder = driveFolders?.folders?.find(f => f.folder_url);
                      if (rootFolder?.folder_url) {
                        const parts = rootFolder.folder_url.split('/');
                        const folderId = parts[parts.length - 1];
                        window.open(`https://drive.google.com/drive/folders/${folderId}`, '_blank', 'noopener,noreferrer');
                      } else {
                        openDriveFolder(driveFolders?.folders?.[0]?.folder_url);
                      }
                    }} />
                ) : (
                  <ActionBtn icon="📁" label={driveProvisioning ? 'Setting up…' : 'Setup Drive Folder'}
                    color="#6B3FDB"
                    disabled={driveProvisioning}
                    onClick={handleProvisionDrive} />
                )}
              </div>

              {/* Quick KPIs strip */}
              <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
                {[
                  { label: 'Revenue',           value: fmtINR(core.total_revenue),          color: C.green },
                  { label: 'Outstanding',        value: fmtINR(core.outstanding_balance),    color: core.outstanding_balance > 0 ? C.red : '#6b7280' },
                  { label: 'Pipeline',           value: fmtINR(pipeline?.summary?.total_pipeline_value), color: C.blue },
                  { label: 'Active Projects',    value: String(projects?.summary?.active_projects || 0), color: C.blue },
                  { label: 'Open Tickets',       value: String(service?.summary?.open_tickets || 0), color: C.amber },
                  { label: 'AMC Active',         value: String(amc?.summary?.active_contracts || 0), color: C.green },
                ].map(chip => (
                  <div key={chip.label} style={{
                    padding: '8px 16px', background: C.light, borderRadius: 10, border: `1px solid ${C.border}`,
                    display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 110,
                  }}>
                    <span style={{ fontSize: 16, fontWeight: 800, color: chip.color }}>{chip.value ?? '—'}</span>
                    <span style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, marginTop: 2 }}>{chip.label}</span>
                  </div>
                ))}
              </div>
            </Card>

            <TabBar active={activeTab} onChange={setActiveTab} />
            {renderTab()}
          </>
        );
      })()}
    </div>
  );
}
