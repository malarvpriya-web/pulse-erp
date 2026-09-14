import { useState, useEffect, useCallback } from 'react';
import {
  Users, ShieldCheck, Activity, Database, RefreshCw,
  Plus, Key, FileText, X, Search, ChevronRight,
  AlertCircle, CheckCircle, ToggleLeft, ToggleRight,
  Server, Zap, Eye, EyeOff, Lock, BarChart2, Inbox,
  Gauge,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import ManagerDashboard from './ManagerDashboard';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell
} from 'recharts';
import api from '@/services/api/client';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import { PageHero, PageShell, StatBand, Stat, SectionTitle } from '@/components/pulse-ui';
import './AdminDashboard.css';

const ROLE_META = {
  super_admin:    { bg: '#ede9fe', color: '#7c3aed', label: 'Super Admin' },
  admin:          { bg: '#dbeafe', color: '#1d4ed8', label: 'Admin' },
  manager:        { bg: '#dcfce7', color: '#15803d', label: 'Manager' },
  department_head:{ bg: '#ede9fe', color: '#5b21b6', label: 'Dept Head' },
  employee:       { bg: '#f3f4f6', color: '#374151', label: 'Employee' },
};

const MODULE_COLORS = { Admin: '#6366f1', Auth: '#8b5cf6', Leaves: '#10b981', Finance: '#3b82f6', System: '#9ca3af', Settings: '#6b21a8' };


const timeAgo = ts => {
  if (!ts) return '—';
  const ms = new Date(ts).getTime();
  if (!ms || isNaN(ms)) return '—';
  const d = Math.floor((Date.now() - ms) / 60000);
  if (d < 1)  return 'just now';
  if (d < 60) return `${d}m ago`;
  const h = Math.floor(d / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

const cryptoRand = (max) => crypto.getRandomValues(new Uint32Array(1))[0] % max;
const generatePassword = () => {
  const upper   = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower   = 'abcdefghjkmnpqrstuvwxyz';
  const digits  = '23456789';
  const symbols = '!@#$%&*';
  const all = upper + lower + digits + symbols;
  const guaranteed = [
    upper[cryptoRand(upper.length)],
    lower[cryptoRand(lower.length)],
    digits[cryptoRand(digits.length)],
    symbols[cryptoRand(symbols.length)],
  ];
  const rest = Array.from({ length: 8 }, () => all[cryptoRand(all.length)]);
  const buf = [...guaranteed, ...rest];
  for (let i = buf.length - 1; i > 0; i--) {
    const j = cryptoRand(i + 1);
    [buf[i], buf[j]] = [buf[j], buf[i]];
  }
  return buf.join('');
};

const pwdStrength = pwd => {
  if (!pwd) return null;
  let score = 0;
  if (pwd.length >= 8)  score++;
  if (pwd.length >= 12) score++;
  if (/[A-Z]/.test(pwd)) score++;
  if (/[0-9]/.test(pwd)) score++;
  if (/[^a-zA-Z0-9]/.test(pwd)) score++;
  if (score <= 2) return { label: 'Weak',   color: '#ef4444', pct: 33 };
  if (score <= 3) return { label: 'Medium', color: '#6d28d9', pct: 66 };
  return              { label: 'Strong', color: '#10b981', pct: 100 };
};



// ── KPI card ──────────────────────────────────────────────────────────────────
// Delegates to the design-system <Stat> (manual §116.4) — the signature is
// unchanged so every call site below keeps working untouched.
const KPI = ({ icon: Icon, label, value, sub, color, alert, index = 0 }) => (
  <Stat
    icon={Icon}
    label={label}
    value={value}
    sub={sub}
    color={color}
    warn={alert}
    index={index}
  />
);

const EmptyState = ({ Icon: IconComponent = Inbox, message }) => (
  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px 16px', color: '#9ca3af', gap: 8 }}>
    <IconComponent size={28} color="#d1d5db" strokeWidth={1.5} />
    <p style={{ margin: 0, fontSize: 13 }}>{message}</p>
  </div>
);

// ── Password field ────────────────────────────────────────────────────────────
const PwdField = ({ label, value, onChange }) => {
  const [show, setShow] = useState(false);
  const strength = pwdStrength(value);
  return (
    <div className="adm-field">
      <label>{label}</label>
      <div className="adm-pwd-wrap">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="Min 8 characters…"
        />
        <button className="adm-pwd-toggle" type="button" onClick={() => setShow(v => !v)} title={show ? 'Hide' : 'Show'}>
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
        <button className="adm-pwd-gen" type="button" onClick={() => { onChange(generatePassword()); setShow(true); }}>
          Generate
        </button>
      </div>
      {strength && (
        <div className="adm-pwd-strength">
          <div className="adm-strength-bar">
            <div style={{ width: `${strength.pct}%`, background: strength.color, height: '100%', borderRadius: 3, transition: 'width .3s' }} />
          </div>
          <span style={{ color: strength.color, fontSize: 11, fontWeight: 600 }}>{strength.label}</span>
        </div>
      )}
    </div>
  );
};

// ── main ─────────────────────────────────────────────────────────────────────
export default function AdminDashboard({ setPage }) {
  const { role } = useAuth();
  const isAdmin = ['super_admin', 'admin'].includes(role);
  const [activeTab, setActiveTab] = useState(() => isAdmin ? 'admin' : 'team');

  const [users,      setUsers]      = useState([]);
  const [audit,      setAudit]      = useState([]);
  const [activity,   setActivity]   = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [search,     setSearch]     = useState('');
  const [drawer,     setDrawer]     = useState(null);
  const [pwdUser,    setPwdUser]    = useState(null);
  const [newPwd,     setNewPwd]     = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [toast,      setToast]      = useState(null);
  const [storage,    setStorage]    = useState(null);
  const [health,     setHealth]     = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    const [usersRes, auditRes, actRes, storageRes, healthRes] = await Promise.allSettled([
      api.get('/admin/users'),
      api.get('/audit/', { params: { limit: 20 } }),
      api.get('/admin/module-activity'),
      // Both are admin-only; skipped for non-admins so the Team Ops tab does not
      // fire 403s that land in access_denials.
      isAdmin ? api.get('/system-health/storage') : Promise.resolve(null),
      isAdmin ? api.get('/system-health/status')  : Promise.resolve(null),
    ]);
    const rawUsers = usersRes.status === 'fulfilled' ? (usersRes.value.data?.users || usersRes.value.data) : [];
    setUsers(Array.isArray(rawUsers) ? rawUsers : []);
    const rawAudit = auditRes.status === 'fulfilled'
      ? (auditRes.value.data?.logs ?? (Array.isArray(auditRes.value.data) ? auditRes.value.data : []))
      : [];
    setAudit(Array.isArray(rawAudit) ? rawAudit : []);
    const rawAct = actRes.status === 'fulfilled' ? (actRes.value.data?.activity || actRes.value.data) : [];
    setActivity(Array.isArray(rawAct) ? rawAct : []);
    // Left null when the call fails or is skipped, so the tiles show an explicit
    // unknown state. Defaulting to 0 would render as a real measurement.
    setStorage(storageRes.status === 'fulfilled' && storageRes.value?.data?.ok     ? storageRes.value.data : null);
    setHealth (healthRes .status === 'fulfilled' && healthRes .value?.data?.status ? healthRes .value.data : null);
    setLoading(false);
  }, [isAdmin]);

  useEffect(() => { load(); }, [load]);

  const toggleStatus = async user => {
    const newStatus = user.status === 'active' ? 'inactive' : 'active';
    // Optimistic update first
    setUsers(us => us.map(u => u.id === user.id ? { ...u, status: newStatus } : u));
    try {
      await api.put(`/admin/users/${user.id}`, { status: newStatus });
      showToast(`${user.name} ${newStatus === 'active' ? 'activated' : 'deactivated'}`);
    } catch (err) {
      // Revert optimistic update on failure
      setUsers(us => us.map(u => u.id === user.id ? { ...u, status: user.status } : u));
      showToast(err.response?.data?.error || 'Failed to update user status', 'error');
    }
  };

  const handleResetPwd = async () => {
    if (!newPwd || newPwd.length < 8) return showToast('Password must be at least 8 characters', 'error');
    setSubmitting(true);
    try {
      await api.post(`/admin/users/${pwdUser.id}/reset-password`, { password: newPwd });
      showToast(`Password reset for ${pwdUser.name}`);
      setDrawer(null);
      setPwdUser(null);
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to reset password. Please try again.', 'error');
    } finally {
      setSubmitting(false);
      setNewPwd('');
    }
  };


  const displayed = users.filter(u => {
    const q = search.toLowerCase();
    return !q || u.name?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q) || u.role?.includes(q);
  });

  const fmtBytes = b => {
    if (b === null || b === undefined) return '—';
    if (b < 1024) return `${b} B`;
    if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
    return `${(b / 1024 ** 3).toFixed(2)} GB`;
  };

  const activeUsers   = users.filter(u => u.status === 'active').length;
  const inactiveUsers = users.filter(u => u.status === 'inactive').length;
  const adminCount    = users.filter(u => ['admin','super_admin'].includes(u.role)).length;

  // Storage: total_bytes is null when the file store could not be sized (S3/R2),
  // so fall back to showing the database figure alone and say so in the subtitle
  // rather than presenting a partial sum as a total.
  const storageValue = storage ? fmtBytes(storage.total_bytes ?? storage.database.bytes) : '—';
  const storageSub   = !storage
    ? (loading ? 'Measuring…' : 'Usage unavailable')
    : storage.files.measured
      ? `DB ${fmtBytes(storage.database.bytes)} · ${storage.files.file_count} files ${fmtBytes(storage.files.bytes)}`
      : `DB only · ${storage.files.provider.toUpperCase()} files not measured`;

  // No amber anywhere in this palette — degraded uses the lavender step of the
  // ramp, matching the rest of the app.
  const healthColor = { up: '#10b981', degraded: '#a78bfa', down: '#ef4444' }[health?.status] || '#9ca3af';
  const healthSub   = health ? health.summary : (loading ? 'Checking services…' : 'Status unavailable');

  const activityChart = (h = 200) => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={activity} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="module" tick={{ fontSize: 12 }} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip />
        <Bar dataKey="count" name="Actions" radius={[4, 4, 0, 0]}>
          {activity.map((d, i) => <Cell key={i} fill={d.color || '#6366f1'} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );


  return (
    <PageShell className="adm-root" dock={<>
      <PageHero
        icon={Gauge}
        eyebrow="Administration"
        title="Operations Dashboard"
        subtitle={activeTab === 'team'
          ? 'Team management & approvals'
          : 'User administration & system management'}
        meta={activeTab === 'admin' ? [
          { label: 'users',    value: users.length },
          { label: 'active',   value: activeUsers, tone: 'good' },
          { label: 'inactive', value: inactiveUsers, tone: inactiveUsers > 0 ? 'bad' : undefined },
          { label: 'admins',   value: adminCount },
        ] : undefined}
        actions={activeTab === 'admin' ? <>
          <button className="plh-cta plh-cta--ghost" onClick={() => setPage && setPage('AuditLogs')}>
            <Eye size={13} /> Audit Trail
          </button>
          <button className="plh-cta plh-cta--ghost" onClick={() => { setPwdUser(null); setNewPwd(''); setDrawer('resetPwd'); }}>
            <Key size={13} /> Reset Password
          </button>
          <button className="plh-cta" onClick={() => setPage && setPage('AccessControl')}>
            <Plus size={14} /> Add User
          </button>
          <button className="plh-icon-btn" onClick={load} title="Refresh" disabled={loading}>
            <RefreshCw size={14} className={loading ? 'adm-spin' : undefined} />
          </button>
        </> : undefined}
      />

      {/* Tab strip. The Admin tab is admin-only, so a non-admin gets no strip
          at all rather than a one-tab strip that switches nothing. It lives in
          the frozen dock, so switching never scrolls the control out of reach. */}
      {isAdmin && (
        <div className="tax-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={activeTab === 'team'}
            className={`tax-tab${activeTab === 'team' ? ' is-on' : ''}`}
            onClick={() => setActiveTab('team')}
          >
            <Users size={14} /> Team Ops
          </button>
          <button
            role="tab"
            aria-selected={activeTab === 'admin'}
            className={`tax-tab${activeTab === 'admin' ? ' is-on' : ''}`}
            onClick={() => setActiveTab('admin')}
          >
            <BarChart2 size={14} /> Admin
          </button>
        </div>
      )}
    </>}>

      {toast && <div className={`adm-toast adm-toast-${toast.type}`}>{toast.msg}</div>}

      {/* ── Team Ops Tab (ManagerDashboard) ──────────────────────────────────── */}
      {activeTab === 'team' && <ManagerDashboard setPage={setPage} hideHeader />}

      {/* ── Admin Tab ────────────────────────────────────────────────────────── */}
      {activeTab === 'admin' && <>

      {/* KPIs */}
      <StatBand cols={6}>
        <KPI icon={Users}      label="Total Users"    value={users.length}  color="#6366f1" sub={`${activeUsers} active`} index={0} />
        <KPI icon={CheckCircle}label="Active Users"   value={activeUsers}   color="#10b981" sub="Currently enabled" index={1} />
        <KPI icon={AlertCircle}label="Inactive Users" value={inactiveUsers} color="#ef4444" alert={inactiveUsers > 0} sub="Disabled accounts" index={2} />
        <KPI icon={ShieldCheck}label="Admins"         value={adminCount}    color="#8b5cf6" sub="Admin & Super Admin" index={3} />
        <KPI icon={Server}     label="System Health"  value={health?.label ?? '—'} color={healthColor} alert={health?.status === 'down'} sub={healthSub} index={4} />
        <KPI icon={Database}   label="Storage"        value={storageValue}         color="#3b82f6" sub={storageSub} index={5} />
      </StatBand>

      {/* main layout */}
      <SectionTitle rule>Access &amp; Directory</SectionTitle>
      <div className="adm-grid">

        {/* user management */}
        <div className="adm-fc8">
          <div className="adm-section">
            <div className="adm-section-hd">
              <span className="adm-section-title">User Management</span>
              <div className="adm-search">
                <Search size={13} />
                <input placeholder="Search users…" value={search} onChange={e => setSearch(e.target.value)} />
                {search && <button onClick={() => setSearch('')}><X size={11} /></button>}
              </div>
            </div>
            <div className="adm-table-wrap">
              {displayed.length === 0 ? (
                <EmptyState Icon={Users} message="No users found" />
              ) : (
                <table className="adm-table">
                  <thead>
                    <tr>
                      <th>User</th><th>Role</th><th>Department</th>
                      <th>Last Login</th><th>2FA</th><th>Status</th><th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayed.map(u => {
                      const rm = ROLE_META[u.role] || ROLE_META.employee;
                      return (
                        <tr key={u.id} className="adm-row">
                          <td>
                            <div className="adm-user-cell">
                              <div className="adm-avatar" style={{ background: rm.bg, color: rm.color }}>
                                {u.name?.charAt(0)}
                              </div>
                              <div>
                                <div className="adm-user-name">{u.name}</div>
                                <div className="adm-user-email">{u.email}</div>
                              </div>
                            </div>
                          </td>
                          <td>
                            <span className="adm-role-badge" style={{ background: rm.bg, color: rm.color }}>{rm.label}</span>
                          </td>
                          <td><span className="adm-dept">{u.department || '—'}</span></td>
                          <td><span className="adm-time">{u.last_login ? timeAgo(u.last_login) : 'Never'}</span></td>
                          <td>
                            <span className={`adm-2fa adm-2fa-${u.two_factor_enabled ? 'on' : 'off'}`}>
                              {u.two_factor_enabled ? 'On' : 'Off'}
                            </span>
                          </td>
                          <td>
                            <span className={`adm-status adm-status-${u.status}`}>
                              {u.status === 'active' ? 'Active' : 'Inactive'}
                            </span>
                          </td>
                          <td>
                            <div className="adm-actions">
                              <button className="adm-toggle-btn" onClick={() => toggleStatus(u)}
                                title={u.status === 'active' ? 'Deactivate' : 'Activate'}>
                                {u.status === 'active'
                                  ? <ToggleRight size={18} color="#10b981" />
                                  : <ToggleLeft  size={18} color="#9ca3af" />}
                              </button>
                              <button className="adm-action-btn" onClick={() => {
                                setPwdUser(u); setNewPwd(''); setDrawer('resetPwd');
                              }} title="Reset Password">
                                <Key size={13} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

        {/* right column */}
        <div className="adm-fc4 adm-right">
          <div className="adm-card-box">
            <div className="adm-box-hd"><span className="adm-section-title"><Zap size={13} style={{ marginRight: 5 }} />Quick Actions</span></div>
            <div className="adm-box-body adm-quick-actions">
              {[
                { label: 'Add New User',    icon: Plus,     action: () => setPage && setPage('AccessControl'), color: '#6366f1' },
                { label: 'Roles & Access',  icon: ShieldCheck, action: () => setPage && setPage('AccessControl'), color: '#10b981' },
                { label: 'Reset Password',  icon: Key,      action: () => { setPwdUser(null); setNewPwd(''); setDrawer('resetPwd'); }, color: '#6d28d9' },
                { label: 'View Audit Trail',icon: FileText, action: () => setPage && setPage('AuditLogs'), color: '#3b82f6' },
                { label: 'System Settings', icon: Server,   action: () => setPage && setPage('SettingsCenter'), color: '#8b5cf6' },
              ].map(({ label, icon: Icon, action, color }) => (
                <button key={label} className="adm-qa-btn" onClick={action} style={{ '--c': color }}>
                  <div className="adm-qa-icon"><Icon size={15} /></div>
                  <span>{label}</span>
                  <ChevronRight size={12} className="adm-qa-arrow" />
                </button>
              ))}
            </div>
          </div>

          <div className="adm-card-box" style={{ cursor: 'pointer' }} onClick={() => setPage && setPage('SystemHealth')}>
            <div className="adm-box-hd"><span className="adm-section-title"><Activity size={13} style={{ marginRight: 5 }} />System Health</span></div>
            <div className="adm-box-body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '20px 16px', textAlign: 'center' }}>
              {/* Reads the same /system-health/status the KPI above does, so the
                  card cannot claim "operational" while the KPI says degraded.
                  Until it answers, this says so rather than asserting health. */}
              <div style={{ width: 40, height: 40, borderRadius: '50%', background: `color-mix(in srgb, ${healthColor} 12%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Activity size={20} color={healthColor} />
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>
                {health ? health.label : (loading ? 'Checking services…' : 'Status unavailable')}
              </div>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>{health ? healthSub : 'Click to run full health check'}</div>
              <div style={{ fontSize: 11, color: '#6366f1', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 3 }}>
                Open System Health <ChevronRight size={11} />
              </div>
            </div>
          </div>
        </div>

      </div>

      <SectionTitle rule>Activity</SectionTitle>
      <div className="adm-grid">

        {/* module activity chart */}
        <div className="adm-fc8">
          <div className="adm-card-box">
            <div className="adm-box-hd">
              <span className="adm-section-title">Module Activity (This Month)</span>
              {activity.length > 0 && (
                <ChartExpandButton title="Module Activity" subtitle="Actions per module · this month"
                  onViewAll={() => setPage && setPage('AuditLogs')} viewAllLabel="Full Audit Log">
                  {activityChart(440)}
                </ChartExpandButton>
              )}
            </div>
            <div className="adm-box-body">
              {activity.length === 0 ? (
                <EmptyState Icon={Inbox} message="No activity data available" />
              ) : (
                activityChart(180)
              )}
            </div>
          </div>
        </div>

        {/* recent audit logs — compact preview */}
        <div className="adm-fc4">
          <div className="adm-card-box" style={{ height: '100%' }}>
            <div className="adm-box-hd">
              <span className="adm-section-title">Recent Activity</span>
              <button className="adm-text-btn" onClick={() => setPage && setPage('AuditLogs')}>
                Full Audit Log <ChevronRight size={12} />
              </button>
            </div>
            <div className="adm-box-body adm-audit-list">
              {audit.length === 0 ? (
                <EmptyState Icon={CheckCircle} message="No recent activity" />
              ) : (
                audit.slice(0, 3).map((a, i) => {
                  const mc = MODULE_COLORS[a.module] || '#9ca3af';
                  return (
                    <div key={a.id || i} className="adm-audit-row">
                      <div className="adm-audit-dot" style={{ background: mc }} />
                      <div className="adm-audit-info">
                        <div className="adm-audit-action">{a.action}</div>
                        <div className="adm-audit-user">{a.user} · <span style={{ color: mc }}>{a.module}</span></div>
                      </div>
                      <div className="adm-audit-time">{timeAgo(a.ts || a.created_at)}</div>
                    </div>
                  );
                })
              )}
              <button
                onClick={() => setPage && setPage('AuditLogs')}
                style={{ width: '100%', marginTop: 10, padding: '8px 0', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontSize: 12, color: '#6366f1', fontWeight: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
              >
                View all audit logs <ChevronRight size={12} />
              </button>
            </div>
          </div>
        </div>

      </div>

      </>} {/* end activeTab === 'admin' */}

      {/* ── Reset Password Drawer ─────────────────────────────────────────────── */}
      {drawer === 'resetPwd' && (
        <div className="adm-overlay" onClick={() => { setDrawer(null); setPwdUser(null); setNewPwd(''); }}>
          <div className="adm-drawer" onClick={e => e.stopPropagation()}>
            <div className="adm-drawer-hd">
              <h3>Reset Password</h3>
              <button className="adm-icon-btn" onClick={() => setDrawer(null)}><X size={16} /></button>
            </div>
            <div className="adm-drawer-body">
              {!pwdUser && (
                <div className="adm-field">
                  <label>Select User</label>
                  <select value={pwdUser?.id || ''} onChange={e => {
                    const u = users.find(u => String(u.id) === e.target.value);
                    setPwdUser(u || null);
                  }}>
                    <option value="">Choose a user…</option>
                    {users.map(u => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
                  </select>
                </div>
              )}
              {pwdUser && (
                <div className="adm-reset-user">
                  <div className="adm-avatar" style={{ background: '#eef2ff', color: '#6366f1', width: 36, height: 36, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>
                    {pwdUser.name?.charAt(0)}
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{pwdUser.name}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>{pwdUser.email}</div>
                  </div>
                  <button className="adm-text-btn" onClick={() => setPwdUser(null)} style={{ marginLeft: 'auto' }}>Change</button>
                </div>
              )}
              <PwdField label="New Password *" value={newPwd} onChange={setNewPwd} />
            </div>
            <div className="adm-drawer-ft">
              <button className="adm-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
              <button className="adm-btn-primary" onClick={handleResetPwd} disabled={submitting || !pwdUser}>
                {submitting ? 'Resetting…' : 'Reset Password'}
              </button>
            </div>
          </div>
        </div>
      )}

    </PageShell>
  );
}