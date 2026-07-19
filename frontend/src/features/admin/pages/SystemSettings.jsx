import { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Building2, Users, Calendar, IndianRupee, Package, ShoppingCart,
  Wrench, Factory, CheckSquare, TrendingUp, Headphones, Bell,
  FileText, Cloud, PenTool, Link2, Shield, Activity, BarChart2,
  Search, ChevronRight, Settings, PlayCircle, CheckCircle,
  AlertCircle, Clock, Globe, Lock, Database, Cpu, Mail,
  Zap, Star, ArrowRight, ExternalLink, Layers, RefreshCw,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import api from '@/services/api/client';

const P = '#6B3FDB';
const PL = '#f5f3ff';
const PB = '#e9e4ff';
const CARD = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4' };

// ─── Settings registry ────────────────────────────────────────────────────────
const CATEGORIES = [
  {
    id: 'company', label: 'Company', icon: Building2, color: '#6B3FDB',
    desc: 'Company profile, branches, GST, and organizational structure',
    items: [
      { label: 'Company Profile',            page: 'OrganizationSetup',   desc: 'Name, logo, address, GST/PAN',         status: 'configured' },
      { label: 'Branch Management',          page: 'MasterSetup',         desc: 'Multiple office and plant locations',   status: 'partial' },
      { label: 'Departments & Designations', page: 'MasterSetup',         desc: 'Org hierarchy and role types',          status: 'configured' },
      { label: 'Holiday Calendar',           page: 'HolidayCalendar',     desc: 'National holidays and plant shutdowns', status: 'configured' },
    ],
    wizard: null,
  },
  {
    id: 'hrms', label: 'HRMS', icon: Users, color: '#0891b2',
    desc: 'Employee management, roles, payroll structures, and HR workflows',
    items: [
      { label: 'User Roles & Permissions', page: 'RolesSetup',          desc: 'Module access and role definitions',        status: 'configured' },
      { label: 'User Accounts',            page: 'UserSetup',            desc: 'Employee login credentials',                status: 'configured' },
      { label: 'Salary Structures',        page: 'SalaryStructure',      desc: 'CTC components, HRA, PF, allowances',       status: 'configured' },
      { label: 'Approver Chains',          page: 'ApproverSetup',        desc: 'Multi-level approval routing',              status: 'configured' },
      { label: 'Succession Planning',      page: 'SuccessionPlanning',   desc: 'Leadership readiness and bench strength',   status: 'not_configured' },
      { label: 'Learning & Development',   page: 'LearningDevelopment',  desc: 'Training programs and certifications',      status: 'partial' },
    ],
    wizard: null,
  },
  {
    id: 'attendance', label: 'Attendance', icon: Calendar, color: '#059669',
    desc: 'Shift policies, geo-fencing, biometric devices, and attendance rules',
    items: [
      { label: 'Attendance Policies',  page: 'AttendancePolicies', desc: 'Late marks, grace time, overtime rules', status: 'configured' },
      { label: 'Shift Management',     page: 'ShiftManagement',    desc: 'Shift timings and rotation schedules',   status: 'configured' },
      { label: 'Geo Fencing',          page: 'GeoFencing',         desc: 'Location-based attendance zones',        status: 'partial' },
      { label: 'Face Attendance',      page: 'FaceAttendance',     desc: 'AI-based facial recognition setup',      status: 'not_configured' },
      { label: 'Device Management',    page: 'DeviceManagement',   desc: 'Biometric and RFID device config',       status: 'partial' },
      { label: 'Work Centres',         page: 'WorkCentres',        desc: 'Production floor attendance zones',      status: 'configured' },
      { label: 'Contract Labour',      page: 'ContractLabour',     desc: 'Third-party worker attendance',          status: 'not_configured' },
      { label: 'Attendance Settings',  page: 'AttendanceSettings', desc: 'Global attendance configuration',        status: 'configured' },
    ],
    wizard: 'AttendanceSetupWizard',
  },
  {
    id: 'payroll', label: 'Payroll', icon: IndianRupee, color: '#d97706',
    desc: 'Payroll processing, statutory compliance, and payslip configuration',
    items: [
      { label: 'Payroll Processing',   page: 'Payroll',            desc: 'Monthly payroll run and approval',         status: 'configured' },
      { label: 'Salary Structures',    page: 'SalaryStructure',    desc: 'Component definitions and formulas',       status: 'configured' },
      { label: 'Payroll Sync',         page: 'PayrollSync',        desc: 'Attendance-to-payroll integration',        status: 'partial' },
      { label: 'Payslip Generator',    page: 'PayslipGenerator',   desc: 'Payslip template and PDF generation',      status: 'configured' },
      { label: 'TDS Management',       page: 'TDSManagement',      desc: 'Tax deduction and Form 16 setup',          status: 'configured' },
    ],
    wizard: 'PayrollSetupWizard',
  },
  {
    id: 'inventory', label: 'Inventory', icon: Package, color: '#6B3FDB',
    desc: 'Warehouse setup, item master, reorder rules, and stock management',
    items: [
      { label: 'Item Master',          page: 'ItemMaster',              desc: 'Products, SKUs, and categories',        status: 'configured' },
      { label: 'Warehouse Management', page: 'WarehouseManagement',     desc: 'Bins, racks, and storage zones',        status: 'partial' },
      { label: 'Stock Alerts',         page: 'StockAlertsAndSuggestions', desc: 'Reorder levels and auto-PR rules',    status: 'configured' },
      { label: 'Batch Tracking',       page: 'BatchTracking',           desc: 'Lot-wise traceability setup',           status: 'not_configured' },
      { label: 'Inventory Intelligence', page: 'InventoryIntelligence', desc: 'AI-driven demand forecasting',          status: 'partial' },
    ],
    wizard: 'InventorySetupWizard',
  },
  {
    id: 'procurement', label: 'Procurement', icon: ShoppingCart, color: '#ef4444',
    desc: 'Vendor onboarding, RFQ workflows, PO approvals, and GRN',
    items: [
      { label: 'Vendor Management',    page: 'VendorManagement',        desc: 'Supplier profiles and scorecards',      status: 'configured' },
      { label: 'Purchase Orders',      page: 'PurchaseOrderManagement', desc: 'PO templates and approval flows',       status: 'configured' },
      { label: 'Order Policy',         page: 'OrderPolicy',             desc: 'Min order qty, lead times, tolerances', status: 'configured' },
      { label: 'Price History',        page: 'PriceHistory',            desc: 'Historical vendor pricing data',        status: 'configured' },
    ],
    wizard: null,
  },
  {
    id: 'engineering', label: 'Engineering', icon: Wrench, color: '#8b5cf6',
    desc: 'BOM policies, ECN workflows, revision rules, and R&D tracking',
    items: [
      { label: 'BOM Builder',          page: 'BOMBuilder',          desc: 'Bill of materials and MRP engine',      status: 'configured' },
      { label: 'ECN Workflow',         page: 'EngineeringDashboard', desc: 'Engineering change notice approvals',   status: 'partial' },
      { label: 'R&D Projects',         page: 'RDProjects',          desc: 'Research and development tracking',     status: 'configured' },
      { label: 'Design Phases',        page: 'DesignPhases',        desc: 'Stage-gate design review process',      status: 'configured' },
      { label: 'Power Quality Setup',  page: 'PowerQualityAnalytics', desc: 'Measurement parameters and alerts',   status: 'partial' },
    ],
    wizard: 'EngineeringSetupWizard',
  },
  {
    id: 'production', label: 'Production', icon: Factory, color: '#f59e0b',
    desc: 'Work orders, routing, capacity planning, and shop floor control',
    items: [
      { label: 'Production Orders',    page: 'ProductionOrders',    desc: 'Work order templates and schedules',    status: 'configured' },
      { label: 'Work Centre Planning', page: 'WorkCentrePlanning',  desc: 'Machine capacity and utilization',      status: 'configured' },
      { label: 'Production Dashboard', page: 'ProductionDashboard', desc: 'Real-time floor monitoring',            status: 'configured' },
    ],
    wizard: null,
  },
  {
    id: 'quality', label: 'Quality', icon: CheckSquare, color: '#10b981',
    desc: 'Quality inspection, test reports, and compliance tracking',
    items: [
      { label: 'Quality Management',   page: 'QualityManagement',   desc: 'IQC, IPQC, OQC inspection setups',     status: 'configured' },
      { label: 'Document Master',      page: 'DocumentMaster',      desc: 'QMS document control and versioning',   status: 'configured' },
    ],
    wizard: null,
  },
  {
    id: 'crm', label: 'CRM & Sales', icon: TrendingUp, color: '#0ea5e9',
    desc: 'Pipeline stages, lead scoring, email sequences, and pricing',
    items: [
      { label: 'Pipeline Automation',  page: 'PipelineAutomation',  desc: 'Stage rules, auto-assignment, scoring', status: 'configured' },
      { label: 'Pricing Engine',       page: 'PricingEngine',       desc: 'Price lists, discount tiers, promos',   status: 'configured' },
      { label: 'Commission Plans',     page: 'CommissionManagement', desc: 'Sales incentive structures',           status: 'partial' },
      { label: 'Sales Targets',        page: 'SalesTargets',        desc: 'Regional and rep-level quotas',         status: 'partial' },
      { label: 'CRM Email',           page: 'CRMEmail',             desc: 'Email accounts, templates, sequences',  status: 'not_configured' },
    ],
    wizard: null,
  },
  {
    id: 'service', label: 'Service Desk', icon: Headphones, color: '#8b5cf6',
    desc: 'SLA policies, escalation rules, field service, and AMC contracts',
    items: [
      { label: 'SLA Management',       page: 'SLAManagement',       desc: 'Response and resolution time targets',  status: 'configured' },
      { label: 'Service Contracts',    page: 'ServiceContracts',    desc: 'AMC and warranty terms',                status: 'configured' },
      { label: 'Knowledge Base',       page: 'KnowledgeBase',       desc: 'Resolution guides and troubleshooting', status: 'partial' },
      { label: 'Service Catalog',      page: 'ServiceMaster',       desc: 'Service catalog and rate cards',        status: 'not_configured' },
    ],
    wizard: null,
  },
  {
    id: 'notifications', label: 'Notifications', icon: Bell, color: '#f59e0b',
    desc: 'Alert triggers, delivery channels, and notification templates',
    items: [
      { label: 'Notification Setup',   page: 'SetupNotifications',  desc: 'Alert rules and trigger conditions',    status: 'partial' },
      { label: 'Notification Center',  page: 'NotificationCenter',  desc: 'In-app notification management',        status: 'configured' },
    ],
    wizard: null,
  },
  {
    id: 'documents', label: 'Documents', icon: FileText, color: '#6366f1',
    desc: 'Document templates, versioning, approval workflows, and storage',
    items: [
      { label: 'Document Setup',       page: 'DocumentSetup',       desc: 'Document types and approval chains',    status: 'configured' },
      { label: 'Document Master',      page: 'DocumentMaster',      desc: 'Master document library and revisions', status: 'configured' },
      { label: 'Document Signing',     page: 'DocumentSigning',     desc: 'E-signature workflow configuration',    status: 'configured' },
    ],
    wizard: null,
  },
  {
    id: 'gdrive', label: 'Google Drive', icon: Cloud, color: '#34a853',
    desc: 'Google Drive integration for document sync and backup',
    items: [
      { label: 'Drive Integration',    page: 'IntegrationsHub',     desc: 'OAuth connection and folder mapping',   status: 'not_configured' },
    ],
    wizard: null,
  },
  {
    id: 'signature', label: 'Digital Signature', icon: PenTool, color: '#ec4899',
    desc: 'ZohoSign integration and native signature setup',
    items: [
      { label: 'ZohoSign Setup',       page: 'ZohoSignIntegration', desc: 'API keys and workflow configuration',   status: 'not_configured' },
      { label: 'Native Signature',     page: 'NativeSignature',     desc: 'On-device signature capture setup',     status: 'configured' },
    ],
    wizard: null,
  },
  {
    id: 'integrations', label: 'Integrations', icon: Link2, color: '#14b8a6',
    desc: 'Tally, Zoho, and third-party system connections',
    items: [
      { label: 'Integrations Hub',     page: 'IntegrationsHub',     desc: 'All external system connections',       status: 'partial' },
    ],
    wizard: null,
  },
  {
    id: 'security', label: 'Security', icon: Shield, color: '#dc2626',
    desc: 'Access control, 2FA, session rules, and IP whitelisting',
    items: [
      { label: 'Security Center',      page: 'SecurityCenter',      desc: 'Password policy, 2FA, session timeout',  status: 'configured' },
      { label: 'Roles & Permissions',  page: 'RolesSetup',          desc: 'Role-based access controls',             status: 'configured' },
    ],
    wizard: null,
  },
  {
    id: 'audit', label: 'Audit', icon: Activity, color: '#6b7280',
    desc: 'Audit trail, change logs, and compliance reporting',
    items: [
      { label: 'Audit Logs',           page: 'AuditLogs',           desc: 'System-wide change audit trail',         status: 'configured' },
      { label: 'Attendance Audit',     page: 'AttendanceAuditLogs', desc: 'Attendance modification tracking',       status: 'configured' },
    ],
    wizard: null,
  },
  {
    id: 'reports', label: 'Reports', icon: BarChart2, color: '#6B3FDB',
    desc: 'Report templates, scheduled exports, and data analytics',
    items: [
      { label: 'Reports Center',       page: 'Reports',             desc: 'Operational and financial reports',      status: 'configured' },
      { label: 'Saved Reports',        page: 'SavedReports',        desc: 'Bookmarked and scheduled reports',       status: 'partial' },
      { label: 'HR Analytics',         page: 'HRDashboard',          desc: 'People analytics and insights',         status: 'configured' },
    ],
    wizard: null,
  },
];

// ─── Status config ────────────────────────────────────────────────────────────
const STATUS = {
  configured:     { label: 'Configured',     color: '#065f46', bg: '#d1fae5', dot: '#10b981' },
  partial:        { label: 'Partial',        color: '#92400e', bg: '#fef3c7', dot: '#f59e0b' },
  not_configured: { label: 'Not Configured', color: '#6b7280', bg: '#f3f4f6', dot: '#d1d5db' },
};

function StatusBadge({ status }) {
  const cfg = STATUS[status] || STATUS.not_configured;
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 600,
      background: cfg.bg, color: cfg.color,
    }}>
      <div style={{ width: 6, height: 6, borderRadius: '50%', background: cfg.dot }} />
      {cfg.label}
    </div>
  );
}

// ─── Progress bar ─────────────────────────────────────────────────────────────
function ProgressRing({ pct }) {
  const r = 20, c = 2 * Math.PI * r;
  return (
    <svg width={50} height={50} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={25} cy={25} r={r} fill="none" stroke={PB} strokeWidth={4} />
      <circle cx={25} cy={25} r={r} fill="none" stroke={P} strokeWidth={4}
        strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)}
        strokeLinecap="round" style={{ transition: 'stroke-dashoffset 0.5s ease' }} />
      <text x={25} y={25} textAnchor="middle" dominantBaseline="central"
        style={{ fontSize: 11, fontWeight: 700, fill: P, transform: 'rotate(90deg)', transformOrigin: '25px 25px' }}>
        {pct}%
      </text>
    </svg>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function SystemSettings() {
  const navigate = useNavigate();
  const { role }  = useAuth();
  const [activeId, setActiveId] = useState(CATEGORIES[0].id);
  const [query, setQuery]       = useState('');
  const [seeding,  setSeeding]  = useState(false);
  const [seedMsg,  setSeedMsg]  = useState(null);

  const runSeedDefaults = useCallback(async () => {
    setSeeding(true);
    setSeedMsg(null);
    try {
      await api.post('/admin/seed-defaults');
      setSeedMsg({ ok: true, text: 'Default registry data seeded successfully.' });
    } catch (e) {
      setSeedMsg({ ok: false, text: e.response?.data?.error || e.message });
    } finally {
      setSeeding(false);
      setTimeout(() => setSeedMsg(null), 4000);
    }
  }, []);

  const goto = (page) => navigate(page === 'Home' ? '/' : `/${page}`);

  // Compute overall completion stats
  const stats = useMemo(() => {
    let total = 0, configured = 0, partial = 0, empty = 0;
    CATEGORIES.forEach(cat => {
      cat.items.forEach(it => {
        total++;
        if (it.status === 'configured') configured++;
        else if (it.status === 'partial') partial++;
        else empty++;
      });
    });
    return { total, configured, partial, empty, pct: Math.round((configured / total) * 100) };
  }, []);

  // Search filtering
  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return CATEGORIES;
    return CATEGORIES.map(cat => ({
      ...cat,
      items: cat.items.filter(it =>
        it.label.toLowerCase().includes(q) || it.desc.toLowerCase().includes(q)
      ),
    })).filter(cat => cat.items.length > 0 || cat.label.toLowerCase().includes(q));
  }, [query]);

  const active = filtered.find(c => c.id === activeId) || filtered[0];

  const alertCount = CATEGORIES.reduce((n, cat) =>
    n + cat.items.filter(it => it.status === 'not_configured').length, 0);

  return (
    <div style={{ minHeight: '100vh', background: '#fafbff', fontFamily: 'inherit' }}>

      {/* ── Header ── */}
      <div style={{ background: '#fff', borderBottom: '1px solid #f0f0f4', padding: '20px 32px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10,
                background: PL, border: `1px solid ${PB}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Settings size={20} color={P} />
              </div>
              <div>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#1f2937' }}>System Settings</div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 1 }}>
                  Configure all modules and enterprise workflows
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
            {/* Completion ring */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <ProgressRing pct={stats.pct} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#1f2937' }}>
                  {stats.configured}/{stats.total} Configured
                </div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>{alertCount} need attention</div>
              </div>
            </div>

            {/* Quick stats */}
            <div style={{ display: 'flex', gap: 8 }}>
              {[
                { label: 'Done',    count: stats.configured, color: '#10b981', bg: '#d1fae5' },
                { label: 'Partial', count: stats.partial,    color: '#f59e0b', bg: '#fef3c7' },
                { label: 'Pending', count: stats.empty,      color: '#6b7280', bg: '#f3f4f6' },
              ].map(s => (
                <div key={s.label} style={{
                  padding: '4px 12px', borderRadius: 20, background: s.bg,
                  fontSize: 12, fontWeight: 600, color: s.color,
                }}>
                  {s.count} {s.label}
                </div>
              ))}
            </div>

            {/* Seed Defaults — super_admin only */}
            {role === 'super_admin' && (
              <button
                onClick={runSeedDefaults}
                disabled={seeding}
                title="Seed all default registry data (departments, designations, leave types, notification rules, products)"
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '7px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                  border: '1px solid #e5e7eb', cursor: seeding ? 'not-allowed' : 'pointer',
                  background: seeding ? '#f3f4f6' : '#fff',
                  color: seeding ? '#9ca3af' : '#374151',
                  opacity: seeding ? 0.7 : 1,
                }}
              >
                {seeding
                  ? <RefreshCw size={13} style={{ animation: 'spin 1s linear infinite' }} />
                  : <Layers size={13} />}
                {seeding ? 'Seeding…' : 'Seed Defaults'}
              </button>
            )}
          </div>
        </div>

        {/* Search bar */}
        <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 8,
          background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8,
          padding: '8px 14px', maxWidth: 400,
        }}>
          <Search size={14} color="#9ca3af" />
          <input
            value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Search settings…"
            style={{ border: 'none', outline: 'none', background: 'transparent',
              fontSize: 13, color: '#374151', width: '100%' }}
          />
        </div>
      </div>

      {/* Seed feedback toast */}
      {seedMsg && (
        <div style={{
          margin: '0 32px 0',
          padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
          background: seedMsg.ok ? '#dcfce7' : '#fee2e2',
          color: seedMsg.ok ? '#16a34a' : '#dc2626',
          borderBottom: '1px solid #f0f0f4',
        }}>
          {seedMsg.text}
        </div>
      )}

      <div style={{ display: 'flex', height: 'calc(100vh - 142px)' }}>

        {/* ── Left sidebar ── */}
        <div style={{
          width: 220, background: '#fff', borderRight: '1px solid #f0f0f4',
          overflowY: 'auto', flexShrink: 0,
        }}>
          <div style={{ padding: '12px 8px' }}>
            {filtered.map(cat => {
              const Icon = cat.icon;
              const catStats = {
                done: cat.items.filter(i => i.status === 'configured').length,
                total: cat.items.length,
              };
              const isActive = active?.id === cat.id;
              return (
                <button
                  key={cat.id}
                  onClick={() => setActiveId(cat.id)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center',
                    gap: 10, padding: '9px 12px', borderRadius: 8, border: 'none',
                    background: isActive ? PL : 'transparent',
                    cursor: 'pointer', textAlign: 'left', marginBottom: 2,
                    transition: 'background 0.15s',
                  }}
                >
                  <div style={{
                    width: 28, height: 28, borderRadius: 6,
                    background: isActive ? PB : '#f3f4f6',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}>
                    <Icon size={14} color={isActive ? P : '#6b7280'} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 12, fontWeight: isActive ? 700 : 500,
                      color: isActive ? P : '#374151', whiteSpace: 'nowrap',
                      overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {cat.label}
                    </div>
                    <div style={{ fontSize: 10, color: '#9ca3af' }}>
                      {catStats.done}/{catStats.total}
                    </div>
                  </div>
                  {cat.items.some(i => i.status === 'not_configured') && (
                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#f59e0b', flexShrink: 0 }} />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Right panel ── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 28 }}>
          {active ? (
            <>
              {/* Category header */}
              <div style={{ marginBottom: 24 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{
                      width: 44, height: 44, borderRadius: 10,
                      background: active.color + '18',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <active.icon size={22} color={active.color} />
                    </div>
                    <div>
                      <div style={{ fontSize: 18, fontWeight: 800, color: '#1f2937' }}>{active.label}</div>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>{active.desc}</div>
                    </div>
                  </div>

                  {/* Wizard launcher */}
                  {active.wizard && (
                    <button
                      onClick={() => goto(active.wizard)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 7,
                        padding: '9px 18px', borderRadius: 8, border: 'none',
                        background: P, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                      }}
                    >
                      <PlayCircle size={15} />
                      Run Setup Wizard
                      <ArrowRight size={13} />
                    </button>
                  )}
                </div>

                {/* Category progress bar */}
                <div style={{ marginTop: 16 }}>
                  {(() => {
                    const done = active.items.filter(i => i.status === 'configured').length;
                    const pct = Math.round((done / active.items.length) * 100);
                    return (
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                          <span style={{ fontSize: 11, color: '#6b7280' }}>Configuration progress</span>
                          <span style={{ fontSize: 11, fontWeight: 700, color: P }}>{pct}%</span>
                        </div>
                        <div style={{ height: 6, background: PB, borderRadius: 10 }}>
                          <div style={{
                            height: '100%', width: `${pct}%`, borderRadius: 10, background: P,
                            transition: 'width 0.4s ease',
                          }} />
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>

              {/* Setting items grid */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                gap: 14,
              }}>
                {active.items.map(item => (
                  <SettingCard key={item.page} item={item} onClick={() => goto(item.page)} />
                ))}
              </div>
            </>
          ) : (
            <div style={{ textAlign: 'center', color: '#6b7280', marginTop: 80 }}>
              No settings found for "{query}"
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Setting card ─────────────────────────────────────────────────────────────
function SettingCard({ item, onClick }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        ...CARD,
        padding: '16px 18px', border: hov ? `1px solid ${PB}` : '1px solid #f0f0f4',
        textAlign: 'left', cursor: 'pointer', background: hov ? PL : '#fff',
        transition: 'all 0.15s', display: 'flex', flexDirection: 'column', gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#1f2937' }}>{item.label}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <StatusBadge status={item.status} />
          <ExternalLink size={12} color={hov ? P : '#d1d5db'} />
        </div>
      </div>
      <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.5 }}>{item.desc}</div>
      {item.status === 'not_configured' && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#d97706',
        }}>
          <AlertCircle size={11} />
          Action required — click to configure
        </div>
      )}
      {item.status === 'partial' && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#6B3FDB',
        }}>
          <Clock size={11} />
          Setup incomplete — review configuration
        </div>
      )}
    </button>
  );
}
