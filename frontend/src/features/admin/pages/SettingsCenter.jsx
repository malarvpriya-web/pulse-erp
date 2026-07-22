import { useState, useMemo, useEffect, useCallback } from 'react';
import {
  Building2, Users, Landmark, GitBranch, ShieldCheck, UserCog,
  Search, ChevronRight, ChevronLeft, Settings2, PlayCircle,
  KeyRound, Calendar, IndianRupee, Repeat, MapPin, Fingerprint,
  Monitor, Cpu, ClipboardList, Package, Database, BarChart3,
  FileText, PenTool, Link2, Bell, History, Server, BookOpen,
  Plug2, RefreshCw, Star, Workflow, Truck, AlertTriangle,
} from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import './SettingsCenter.css';

const P  = 'var(--sc-primary)';
const PL = 'var(--sc-primary-light)';
const PB = 'var(--sc-primary-border)';

const DOMAIN_META = {
  company:      { color: 'var(--sc-company-color)', bg: 'var(--sc-company-bg)', border: 'var(--sc-company-border)', label: 'Company & Organization' },
  people_hr:    { color: 'var(--sc-hr-color)',      bg: 'var(--sc-hr-bg)',      border: 'var(--sc-hr-border)',      label: 'People & HR' },
  finance_tax:  { color: 'var(--sc-finance-color)', bg: 'var(--sc-finance-bg)', border: 'var(--sc-finance-border)', label: 'Finance & Tax' },
  operations:   { color: 'var(--sc-ops-color)',     bg: 'var(--sc-ops-bg)',     border: 'var(--sc-ops-border)',     label: 'Operations & Workflow' },
  integrations: { color: 'var(--sc-sec-color)',     bg: 'var(--sc-sec-bg)',     border: 'var(--sc-sec-border)',     label: 'Integrations & Security' },
  preferences:  { color: 'var(--sc-pref-color)',    bg: 'var(--sc-pref-bg)',    border: 'var(--sc-pref-border)',    label: 'User Preferences' },
};

const DOMAINS = [
  {
    id: 'company',
    icon: Building2,
    desc: 'Company profile, org structure, departments, and master data',
    wizard: null,
    items: [
      { label: 'Org Setup',           page: 'OrganizationSetup',  icon: Building2,     desc: 'Company name, logo, address, GST / PAN' },
      { label: 'Departments & Master', page: 'MasterSetup',        icon: Building2,     desc: 'Org hierarchy, departments, grades, zones and leave types' },
      { label: 'Branch Management',   page: 'BranchManagement',   icon: Database,      desc: 'Multiple office and plant locations' },
      { label: 'Holiday Calendar',    page: 'HolidayCalendar',    icon: Calendar,      desc: 'National holidays and plant shutdowns' },
      { label: 'Product Setup',       page: 'ProductSetup',       icon: Package,       desc: 'Product catalogue and categories' },
    ],
  },
  {
    id: 'people_hr',
    icon: Users,
    desc: 'Users, roles, payroll, leave, attendance, and HR configuration',
    wizard: 'SetupWizard',
    items: [
      { label: 'User Management',     page: 'UserSetup',          icon: Users,         desc: 'Add, edit, and manage login accounts' },
      { label: 'Roles & Permissions', page: 'RolesSetup',         icon: KeyRound,      desc: 'Module access and role definitions' },
      { label: 'Approver Chains',     page: 'ApproverSetup',      icon: UserCog,       desc: 'Multi-level approval routing' },
      { label: 'Salary Structures',   page: 'SalaryStructure',    icon: IndianRupee,    desc: 'CTC components, HRA, PF, allowances' },
      { label: 'Leave Settings',      page: 'LeaveSettings',      icon: Calendar,      desc: 'Leave types, quotas, carry-forward' },
      { label: 'Attendance Policies', page: 'AttendancePolicies', icon: ClipboardList, desc: 'Late marks, grace time, overtime rules' },
      { label: 'Shift Management',    page: 'ShiftManagement',    icon: Repeat,        desc: 'Shift timings and rotation schedules' },
      { label: 'Geo Fencing',         page: 'GeoFencing',         icon: MapPin,        desc: 'Location-based attendance zones' },
      { label: 'Face Attendance',     page: 'FaceAttendance',     icon: Fingerprint,   desc: 'AI facial recognition setup' },
      { label: 'Device Management',   page: 'DeviceManagement',   icon: Monitor,       desc: 'Biometric and RFID device config' },
      { label: 'Work Centres',        page: 'WorkCentres',        icon: Cpu,           desc: 'Production floor attendance zones' },
      { label: 'Contract Labour',     page: 'ContractLabour',     icon: Users,         desc: 'Third-party worker attendance' },
      { label: 'Payroll Sync',        page: 'PayrollSync',        icon: Repeat,        desc: 'Attendance-to-payroll integration' },
    ],
  },
  {
    id: 'finance_tax',
    icon: Landmark,
    desc: 'Finance settings, GST, TDS, bank accounts, budgets, and pricing',
    wizard: null,
    items: [
      { label: 'Finance Settings',    page: 'FinanceSettings',    icon: Landmark,      desc: 'Global finance module configuration' },
      { label: 'GST & Tax',           page: 'GSTModule',          icon: FileText,      desc: 'GST rates, HSN/SAC codes, returns' },
      { label: 'TDS Management',      page: 'TDSManagement',      icon: FileText,      desc: 'TDS deduction and Form 16 setup' },
      { label: 'Bank Accounts',       page: 'BankAccounts',       icon: Landmark,      desc: 'Company bank account details' },
      { label: 'Chart of Accounts',   page: 'ChartOfAccounts',    icon: BarChart3,     desc: 'Ledger structure and account groups' },
      { label: 'Budget Management',   page: 'BudgetManagement',   icon: BarChart3,     desc: 'Annual budgets and cost centres' },
      { label: 'Pricing Engine',      page: 'PricingEngine',      icon: IndianRupee,    desc: 'Price lists, discount tiers, promos' },
      { label: 'Order Policy',        page: 'OrderPolicy',        icon: ClipboardList, desc: 'Purchase order policy and tolerances' },
    ],
  },
  {
    id: 'operations',
    icon: GitBranch,
    desc: 'Workflow automation, document setup, and operational configuration',
    wizard: null,
    items: [
      { label: 'Workflow Builder',    page: 'WorkflowBuilder',       icon: Workflow,   desc: 'Visual workflow automation builder' },
      { label: 'Workflow Config',     page: 'WorkflowConfiguration', icon: Settings2,  desc: 'Operational workflow rule configuration' },
      { label: 'Document Setup',      page: 'DocumentSetup',         icon: FileText,   desc: 'Document types and approval chains' },
      { label: 'Document Signing',    page: 'DocumentSigning',       icon: PenTool,    desc: 'E-signature workflow configuration' },
      { label: 'Asset Maintenance',   page: 'AssetMaintenance',      icon: Truck,      desc: 'Fixed asset and maintenance rules' },
      { label: 'Notification Setup',  page: 'SetupNotifications',    icon: Bell,       desc: 'Alert rules and notification routing' },
      { label: 'Master Setup',        page: 'MasterSetup',           icon: Database,   desc: 'Departments, grades, bands, leave types and master data' },
    ],
  },
  {
    id: 'integrations',
    icon: ShieldCheck,
    desc: 'Security, audit, third-party integrations, and system diagnostics',
    wizard: null,
    items: [
      { label: 'Security Center',     page: 'SecurityCenter',        icon: ShieldCheck, desc: 'Password policy, 2FA, session rules' },
      { label: 'Roles & Access',      page: 'RolesSetup',            icon: KeyRound,    desc: 'Role-based access control matrix' },
      { label: 'Audit Logs',          page: 'AuditLogs',             icon: History,     desc: 'System-wide change audit trail' },
      { label: 'Attendance Audit',    page: 'AttendanceAuditLogs',   icon: History,     desc: 'Attendance modification tracking' },
      { label: 'Integrations Hub',    page: 'IntegrationsHub',       icon: Plug2,       desc: 'All external system connections' },
      { label: 'Zoho Sign',           page: 'ZohoSignIntegration',   icon: PenTool,     desc: 'Digital signature integration' },
      { label: 'API Documentation',   page: 'APIDocumentation',      icon: BookOpen,    desc: 'REST API reference and testing' },
      { label: 'System Health',       page: 'SystemHealth',          icon: Server,      desc: 'Monitor system performance' },
      // Database Test deliberately excluded — it writes real production rows,
      // not a diagnostic on par with the rest of this domain. See DangerZoneCard.
    ],
  },
  {
    id: 'preferences',
    icon: Star,
    desc: 'Your personal preferences, profile, and notification settings',
    wizard: null,
    items: [
      { label: 'Profile Settings',    page: 'ProfileSettings',       icon: UserCog,    desc: 'Avatar, display name, and contact info' },
      { label: 'User Preferences',    page: 'UserPreferences',       icon: Settings2,  desc: 'Language, timezone, date format, theme' },
      { label: 'Notification Center', page: 'NotificationCenter',    icon: Bell,       desc: 'View and manage all notifications' },
    ],
  },
];

// ── Completion ring ──────────────────────────────────────────────────────────
function CompletionRing({ pct, color, size = 48 }) {
  const r    = (size / 2) - 4;
  const circ = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} style={{ flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--sc-border-subtle)" strokeWidth={4} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke={color} strokeWidth={4}
        strokeDasharray={circ}
        strokeDashoffset={circ * (1 - pct / 100)}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 0.5s ease' }}
      />
      <text x={size / 2} y={size / 2 + 0.5} textAnchor="middle" dominantBaseline="central"
        style={{ fontSize: size < 48 ? 9 : 11, fontWeight: 700, fill: color, fontFamily: 'inherit' }}>
        {pct}%
      </text>
    </svg>
  );
}

// ── Domain card (L1) ────────────────────────────────────────────────────────
function DomainCard({ domain, domainData, onClick }) {
  const [hov, setHov] = useState(false);
  const m    = DOMAIN_META[domain.id];
  const Icon = domain.icon;
  const p    = domainData?.pct ?? 0;
  const conf = domainData?.configured ?? 0;
  const tot  = domainData?.total ?? 0;

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        background: hov ? m.bg : 'var(--sc-card-bg)',
        border: `1px solid ${hov ? m.color : 'var(--sc-border)'}`,
        borderRadius: 14, padding: '20px 20px 16px',
        cursor: 'pointer', textAlign: 'left',
        transition: 'all 0.15s',
        boxShadow: hov ? '0 4px 16px rgba(0,0,0,.08)' : '0 1px 4px rgba(0,0,0,.03)',
        display: 'flex', flexDirection: 'column', gap: 14,
        fontFamily: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{
          width: 44, height: 44, borderRadius: 10,
          background: m.bg, border: `1px solid ${m.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={20} color={m.color} />
        </div>
        <CompletionRing pct={p} color={m.color} size={48} />
      </div>

      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--sc-text-strong)', marginBottom: 4 }}>
          {m.label}
        </div>
        <div style={{ fontSize: 12, color: 'var(--sc-text-muted)', lineHeight: 1.5 }}>{domain.desc}</div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 11, color: m.color, fontWeight: 600 }}>
          {conf}/{tot} configured
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4,
          fontSize: 12, color: hov ? m.color : 'var(--sc-text-faint)', fontWeight: 600,
        }}>
          {domain.items.length} settings <ChevronRight size={13} />
        </div>
      </div>
    </button>
  );
}

// ── Setting item card (L2) ───────────────────────────────────────────────────
function SettingCard({ item, color, bg, border, onClick }) {
  const [hov, setHov] = useState(false);
  const Icon = item.icon;
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 12,
        padding: '14px 16px', borderRadius: 10,
        border: `1px solid ${hov ? color : border}`,
        background: hov ? bg : 'var(--sc-card-bg)',
        cursor: 'pointer', transition: 'all 0.15s',
        textAlign: 'left', outline: 'none', fontFamily: 'inherit',
        boxShadow: hov ? '0 2px 10px rgba(0,0,0,.08)' : 'none',
      }}
    >
      <div style={{
        width: 34, height: 34, borderRadius: 8, flexShrink: 0,
        background: bg, border: `1px solid ${border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon size={15} color={color} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 600, color: 'var(--sc-text-body)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          {item.label}
          <ChevronRight size={13} color={hov ? color : 'var(--sc-text-faint)'} style={{ flexShrink: 0, marginLeft: 4 }} />
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--sc-text-muted)', marginTop: 2, lineHeight: 1.4 }}>{item.desc}</div>
      </div>
    </button>
  );
}

// ── Danger Zone — production write-tests, deliberately not a "setting" ─────
// Kept out of the domain grid above: it doesn't configure anything and has no
// completion %, it creates real rows in live tables. super_admin only.
function DangerZoneCard({ onClick }) {
  const [btnHov, setBtnHov] = useState(false);
  return (
    <div style={{
      marginTop: 22, borderRadius: 14, border: '1px solid #fecaca',
      background: '#fff', padding: '18px 20px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 16, flexWrap: 'wrap',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10, flexShrink: 0,
          background: '#fee2e2', border: '1px solid #fecaca',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <AlertTriangle size={18} color="#dc2626" />
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 800, color: '#991b1b', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            Danger Zone
            <span style={{
              fontSize: 9, fontWeight: 700, color: '#991b1b',
              background: '#fee2e2', border: '1px solid #fecaca',
              borderRadius: 20, padding: '2px 8px', letterSpacing: '.03em',
            }}>
              SUPER ADMIN ONLY
            </span>
          </div>
          <div style={{ fontSize: 12, color: '#7f1d1d', marginTop: 3, maxWidth: 480, lineHeight: 1.5 }}>
            Database Test writes real records straight into production tables
            (employees, leaves, announcements, leads…). It's a diagnostic tool,
            not a sandbox — kept out of Setup Center and everyday settings on purpose.
          </div>
        </div>
      </div>
      <button
        onClick={onClick}
        onMouseEnter={() => setBtnHov(true)}
        onMouseLeave={() => setBtnHov(false)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
          padding: '9px 16px', borderRadius: 8, border: '1px solid #dc2626',
          background: btnHov ? '#dc2626' : '#fff', color: btnHov ? '#fff' : '#dc2626',
          fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
          transition: 'all .15s',
        }}
      >
        <Database size={13} /> Open Database Test
      </button>
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
export default function SettingsCenter({ setPage }) {
  const { role: authRole } = useAuth();
  const role = (authRole || '').toLowerCase();
  const isSuperAdmin = role === 'super_admin' || role === 'superadmin';

  const [activeDomain, setActiveDomain] = useState(null);
  const [query,        setQuery]        = useState('');
  const [statusData,   setStatusData]   = useState(null);
  const [loading,      setLoading]      = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const { data } = await api.get('/settings/status');
      setStatusData(data);
    } catch {
      // API unavailable — render with zero progress; user can still navigate
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const q = query.trim().toLowerCase();

  const filteredDomains = useMemo(() => {
    if (!q) return DOMAINS;
    return DOMAINS.map(d => ({
      ...d,
      items: d.items.filter(i =>
        i.label.toLowerCase().includes(q) || i.desc.toLowerCase().includes(q)
      ),
    })).filter(d =>
      d.items.length > 0 ||
      DOMAIN_META[d.id].label.toLowerCase().includes(q) ||
      d.desc.toLowerCase().includes(q)
    );
  }, [q]);

  // Deselect domain if it disappears in search
  useEffect(() => {
    if (activeDomain && !filteredDomains.find(d => d.id === activeDomain)) {
      setActiveDomain(null);
    }
  }, [filteredDomains, activeDomain]);

  const activeData   = filteredDomains.find(d => d.id === activeDomain);
  const domainStatus = statusData?.domains ?? {};
  const overall      = statusData?.overall ?? 0;

  const totalSearchResults = useMemo(() =>
    filteredDomains.reduce((s, d) => s + d.items.length, 0), [filteredDomains]);

  const navigateTo = (page) => setPage(page);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--sc-page-bg)' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* ── Sticky header ── */}
      <div style={{
        background: 'var(--sc-header-bg)', borderBottom: '1px solid var(--sc-border)',
        padding: '18px 28px', position: 'sticky', top: 0, zIndex: 50,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14 }}>

          {/* Left: back + title */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {activeDomain && (
              <button
                onClick={() => { setActiveDomain(null); setQuery(''); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '6px 12px', borderRadius: 7,
                  border: '1px solid var(--sc-border-subtle)', background: 'var(--sc-page-bg)',
                  fontSize: 12, color: 'var(--sc-text-muted)', cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                <ChevronLeft size={13} /> All Settings
              </button>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 38, height: 38, borderRadius: 9, background: PL,
                border: `1px solid ${PB}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Settings2 size={18} color={P} />
              </div>
              <div>
                <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: 'var(--sc-text-strong)' }}>
                  {activeDomain ? DOMAIN_META[activeDomain].label : 'Settings Center'}
                </h1>
                <p style={{ margin: 0, fontSize: 11.5, color: 'var(--sc-text-muted)' }}>
                  {activeDomain
                    ? activeData?.desc ?? ''
                    : `${DOMAINS.reduce((s, d) => s + d.items.length, 0)} settings across ${DOMAINS.length} domains`}
                </p>
              </div>
            </div>
          </div>

          {/* Right: overall ring + search */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {!activeDomain && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {loading
                  ? <RefreshCw size={16} color="var(--sc-text-faint)" style={{ animation: 'spin 1s linear infinite' }} />
                  : <CompletionRing pct={overall} color={P} size={44} />
                }
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--sc-text-body)' }}>Overall</div>
                  <div style={{ fontSize: 11, color: 'var(--sc-text-muted)' }}>{overall}% configured</div>
                </div>
              </div>
            )}

            <div style={{ position: 'relative', width: 260 }}>
              <Search size={14} color="var(--sc-text-faint)"
                style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
              <input
                type="text"
                placeholder="Search settings…"
                value={query}
                onChange={e => setQuery(e.target.value)}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '8px 10px 8px 30px',
                  border: '1px solid var(--sc-border-subtle)', borderRadius: 8,
                  fontSize: 13, outline: 'none', fontFamily: 'inherit',
                  background: 'var(--sc-page-bg)', color: 'var(--sc-text-body)',
                  transition: 'border-color 0.15s',
                }}
                onFocus={e => { e.target.style.borderColor = 'var(--sc-primary)'; e.target.style.background = 'var(--sc-card-bg)'; }}
                onBlur={e => { e.target.style.borderColor = 'var(--sc-border-subtle)'; e.target.style.background = 'var(--sc-page-bg)'; }}
              />
              {q && (
                <span style={{ position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%)', fontSize: 10, color: 'var(--sc-text-faint)' }}>
                  {totalSearchResults}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: '24px 28px' }}>

        {/* ── L1: Domain grid ── */}
        {!activeDomain && (
          <>
            {/* Overall progress bar */}
            {!q && !loading && (
              <div style={{
                background: 'var(--sc-card-bg)', border: '1px solid var(--sc-border)', borderRadius: 12,
                padding: '14px 20px', marginBottom: 22,
                display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
              }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                    <span style={{ fontSize: 12, color: 'var(--sc-text-muted)' }}>System configuration progress</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: P }}>{overall}%</span>
                  </div>
                  <div style={{ height: 6, background: 'var(--sc-border-subtle)', borderRadius: 10 }}>
                    <div style={{
                      height: '100%', width: `${overall}%`,
                      background: `linear-gradient(90deg, ${P}, var(--sc-primary-end))`,
                      borderRadius: 10, transition: 'width 0.5s ease',
                    }} />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {DOMAINS.map(d => {
                    const m = DOMAIN_META[d.id];
                    const s = domainStatus[d.id];
                    const dp = s?.pct ?? 0;
                    return (
                      <button
                        key={d.id}
                        onClick={() => setActiveDomain(d.id)}
                        title={m.label}
                        style={{
                          width: 30, height: 30, borderRadius: 7,
                          background: m.bg, border: `1px solid ${m.border}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer', position: 'relative',
                          fontFamily: 'inherit',
                        }}
                      >
                        <d.icon size={13} color={m.color} />
                        <div style={{
                          position: 'absolute', bottom: -2, right: -2,
                          width: 10, height: 10, borderRadius: '50%',
                          background: dp >= 100 ? 'var(--sc-dot-done)' : dp > 0 ? 'var(--sc-dot-partial)' : 'var(--sc-dot-empty)',
                          border: '2px solid var(--sc-card-bg)',
                        }} />
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Search hint */}
            {q && (
              <div style={{ marginBottom: 14, fontSize: 12, color: 'var(--sc-text-muted)' }}>
                {totalSearchResults === 0
                  ? `No settings match "${query}"`
                  : `${totalSearchResults} result${totalSearchResults !== 1 ? 's' : ''} across ${filteredDomains.length} domain${filteredDomains.length !== 1 ? 's' : ''}`
                }
              </div>
            )}

            {/* Domain cards (no search) */}
            {!q && filteredDomains.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
                {filteredDomains.map(domain => (
                  <DomainCard
                    key={domain.id}
                    domain={domain}
                    domainData={domainStatus[domain.id]}
                    onClick={() => setActiveDomain(domain.id)}
                  />
                ))}
              </div>
            )}

            {/* Danger Zone — separate from the domain grid, super_admin only */}
            {!q && isSuperAdmin && (
              <DangerZoneCard onClick={() => navigateTo('DatabaseTest')} />
            )}

            {/* Flat search results */}
            {q && filteredDomains.length === 0 && (
              <div style={{ textAlign: 'center', padding: '64px 0', color: 'var(--sc-text-faint)' }}>
                <Search size={36} style={{ marginBottom: 12, opacity: 0.4 }} />
                <div style={{ fontSize: 14 }}>No settings found for "{query}"</div>
              </div>
            )}
            {q && filteredDomains.map(domain => {
              if (!domain.items.length) return null;
              const m = DOMAIN_META[domain.id];
              return (
                <div key={domain.id} style={{ marginBottom: 24 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}>
                    <div style={{
                      width: 22, height: 22, borderRadius: 5, background: m.bg,
                      border: `1px solid ${m.border}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <domain.icon size={11} color={m.color} />
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--sc-text-body)' }}>{m.label}</span>
                    <span style={{
                      fontSize: 10, fontWeight: 600, color: m.color,
                      background: m.bg, border: `1px solid ${m.border}`,
                      borderRadius: 8, padding: '1px 6px',
                    }}>{domain.items.length}</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
                    {domain.items.map(item => (
                      <SettingCard
                        key={item.page + item.label}
                        item={item}
                        color={m.color} bg={m.bg} border={m.border}
                        onClick={() => navigateTo(item.page)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </>
        )}

        {/* ── L2: Domain detail ── */}
        {activeDomain && activeData && (() => {
          const m     = DOMAIN_META[activeDomain];
          const s     = domainStatus[activeDomain];
          const p     = s?.pct ?? 0;
          const items = q
            ? activeData.items.filter(i =>
                i.label.toLowerCase().includes(q) || i.desc.toLowerCase().includes(q)
              )
            : activeData.items;

          return (
            <>
              {/* Domain summary card */}
              <div style={{
                background: 'var(--sc-card-bg)', border: '1px solid var(--sc-border)',
                borderRadius: 12, padding: '20px 24px', marginBottom: 22,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <div style={{
                      width: 50, height: 50, borderRadius: 12,
                      background: m.bg, border: `1px solid ${m.border}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <activeData.icon size={22} color={m.color} />
                    </div>
                    <div>
                      <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--sc-text-strong)' }}>{m.label}</div>
                      <div style={{ fontSize: 12, color: 'var(--sc-text-muted)', marginTop: 2 }}>{activeData.desc}</div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <div style={{ padding: '4px 10px', borderRadius: 20, background: 'var(--sc-done-bg)', fontSize: 11, fontWeight: 600, color: 'var(--sc-done-text)' }}>
                        {s?.configured ?? 0} done
                      </div>
                      <div style={{ padding: '4px 10px', borderRadius: 20, background: 'var(--sc-pending-bg)', fontSize: 11, fontWeight: 600, color: 'var(--sc-pending-text)' }}>
                        {(s?.total ?? 0) - (s?.configured ?? 0)} pending
                      </div>
                    </div>

                    {activeData.wizard && (
                      <button
                        onClick={() => navigateTo(activeData.wizard)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          padding: '8px 15px', borderRadius: 8, border: 'none',
                          background: m.color, color: 'var(--sc-on-primary)',
                          fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                        }}
                      >
                        <PlayCircle size={13} /> Run Setup Wizard
                      </button>
                    )}
                  </div>
                </div>

                {/* Progress bar */}
                <div style={{ marginTop: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                    <span style={{ fontSize: 11, color: 'var(--sc-text-muted)' }}>Configuration progress</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: m.color }}>{p}%</span>
                  </div>
                  <div style={{ height: 5, background: 'var(--sc-border-subtle)', borderRadius: 10 }}>
                    <div style={{ height: '100%', width: `${p}%`, background: m.color, borderRadius: 10, transition: 'width 0.4s ease' }} />
                  </div>
                </div>
              </div>

              {/* Setting items */}
              {items.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--sc-text-faint)' }}>
                  <Search size={28} style={{ marginBottom: 8, opacity: 0.4 }} />
                  <div style={{ fontSize: 13 }}>No settings match "{query}"</div>
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
                  {items.map(item => (
                    <SettingCard
                      key={item.page + item.label}
                      item={item}
                      color={m.color} bg={m.bg} border={m.border}
                      onClick={() => navigateTo(item.page)}
                    />
                  ))}
                </div>
              )}
            </>
          );
        })()}
      </div>
    </div>
  );
}
