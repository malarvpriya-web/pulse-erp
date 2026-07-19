import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Users, ShieldCheck, Activity, Database, RefreshCw,
  Plus, Key, FileText, X, Search, ChevronRight,
  AlertCircle, CheckCircle, ToggleLeft, ToggleRight,
  Server, Zap, Eye, EyeOff, Upload, Lock, BarChart2, Inbox,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import ManagerDashboard from './ManagerDashboard';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell
} from 'recharts';
import api from '@/services/api/client';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import './AdminDashboard.css';

const ROLE_META = {
  super_admin:    { bg: '#ede9fe', color: '#7c3aed', label: 'Super Admin' },
  admin:          { bg: '#dbeafe', color: '#1d4ed8', label: 'Admin' },
  manager:        { bg: '#dcfce7', color: '#15803d', label: 'Manager' },
  department_head:{ bg: '#fef3c7', color: '#92400e', label: 'Dept Head' },
  employee:       { bg: '#f3f4f6', color: '#374151', label: 'Employee' },
};

const MODULE_COLORS = { Admin: '#6366f1', Auth: '#8b5cf6', Leaves: '#10b981', Finance: '#3b82f6', System: '#9ca3af', Settings: '#f59e0b' };

const DEPARTMENTS = [
  'Engineering', 'Product', 'Design', 'Marketing', 'Sales',
  'Finance', 'HR', 'Operations', 'Legal', 'Customer Success', 'Other',
];

const PERM_MODULES = ['Leaves', 'Finance', 'CRM', 'Inventory', 'Projects', 'Reports', 'HR'];

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
  if (score <= 3) return { label: 'Medium', color: '#f59e0b', pct: 66 };
  return              { label: 'Strong', color: '#10b981', pct: 100 };
};

const emptyPerms = () =>
  PERM_MODULES.reduce((a, m) => ({ ...a, [m]: { view: false, edit: false } }), {});

const defaultPerms = role => {
  if (['super_admin', 'admin'].includes(role))
    return PERM_MODULES.reduce((a, m) => ({ ...a, [m]: { view: true, edit: true } }), {});
  if (role === 'manager')
    return PERM_MODULES.reduce((a, m) => ({ ...a, [m]: { view: true, edit: m !== 'Finance' } }), {});
  if (role === 'department_head')
    return PERM_MODULES.reduce((a, m) => ({ ...a, [m]: { view: true, edit: ['Leaves', 'Projects', 'HR'].includes(m) } }), {});
  return PERM_MODULES.reduce((a, m) => ({ ...a, [m]: { view: m === 'Leaves', edit: false } }), {});
};

const emptyUser = () => ({ name: '', email: '', role: 'employee', department: '', password: '', force_change_pwd: false });

const parseCSV = text => {
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return [];
  return lines.slice(1).map(line => {
    const [name = '', email = '', role = 'employee', department = ''] =
      line.split(',').map(s => s.trim().replace(/^"|"$/g, ''));
    return { name, email, role: role || 'employee', department };
  }).filter(r => r.name && r.email);
};

// ── KPI card ──────────────────────────────────────────────────────────────────
const KPI = ({ icon: Icon, label, value, sub, color, alert }) => (
  <div className={`adm-kpi${alert ? ' adm-kpi-alert' : ''}`} style={{ '--c': color }}>
    <div className="adm-kpi-icon"><Icon size={19} /></div>
    <div>
      <p className="adm-kpi-label">{label}</p>
      <h3 className="adm-kpi-val">{value}</h3>
      {sub && <p className="adm-kpi-sub">{sub}</p>}
    </div>
  </div>
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
  const { role, user } = useAuth();
  const isSuperAdmin = role === 'super_admin';
  const isAdmin = ['super_admin', 'admin'].includes(role);
  const [activeTab, setActiveTab] = useState(() => isAdmin ? 'admin' : 'team');

  const [users,      setUsers]      = useState([]);
  const [audit,      setAudit]      = useState([]);
  const [activity,   setActivity]   = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [search,     setSearch]     = useState('');
  const [drawer,     setDrawer]     = useState(null);
  const [form,       setForm]       = useState(emptyUser());
  const [perms,      setPerms]      = useState(emptyPerms());
  const [deptOther,  setDeptOther]  = useState('');
  const [showPerms,  setShowPerms]  = useState(false);
  const [pwdUser,    setPwdUser]    = useState(null);
  const [newPwd,     setNewPwd]     = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [toast,      setToast]      = useState(null);
  const [csvDrawer,  setCsvDrawer]  = useState(false);
  const [csvRows,    setCsvRows]    = useState([]);
  const [csvError,   setCsvError]   = useState('');
  const [importing,  setImporting]  = useState(false);
  const fileRef = useRef();

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    const [usersRes, auditRes, actRes] = await Promise.allSettled([
      api.get('/admin/users'),
      api.get('/audit/', { params: { limit: 20 } }),
      api.get('/admin/module-activity'),
    ]);
    const rawUsers = usersRes.status === 'fulfilled' ? (usersRes.value.data?.users || usersRes.value.data) : [];
    setUsers(Array.isArray(rawUsers) ? rawUsers : []);
    const rawAudit = auditRes.status === 'fulfilled'
      ? (auditRes.value.data?.logs ?? (Array.isArray(auditRes.value.data) ? auditRes.value.data : []))
      : [];
    setAudit(Array.isArray(rawAudit) ? rawAudit : []);
    const rawAct = actRes.status === 'fulfilled' ? (actRes.value.data?.activity || actRes.value.data) : [];
    setActivity(Array.isArray(rawAct) ? rawAct : []);
    setLoading(false);
  }, []);

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

  const closeAddUser = () => {
    setDrawer(null);
    setForm(emptyUser());
    setPerms(emptyPerms());
    setDeptOther('');
    setShowPerms(false);
  };

  const handleRoleChange = role => {
    setForm(f => ({ ...f, role }));
    setPerms(defaultPerms(role));
  };

  const handleAddUser = async () => {
    if (!form.name || !form.email) return showToast('Name and email required', 'error');
    if (!form.password || form.password.length < 8) return showToast('Password must be at least 8 characters', 'error');
    const dept = form.department === 'Other' ? deptOther : form.department;
    const payload = { ...form, department: dept, permissions: perms };
    setSubmitting(true);
    try {
      await api.post('/admin/users', payload);
      showToast('User created');
      closeAddUser();
      load();
    } catch(err) {
      showToast(err.response?.data?.error || 'Failed to create user', 'error');
    } finally {
      setSubmitting(false);
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

  const handleCSVFile = e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const rows = parseCSV(ev.target.result);
        if (rows.length === 0) { setCsvError('No valid rows found. Check your CSV format.'); setCsvRows([]); }
        else { setCsvRows(rows); setCsvError(''); }
      } catch { setCsvError('Failed to parse file.'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleImportCSV = async () => {
    if (csvRows.length === 0) return;
    setImporting(true);
    let ok = 0;
    for (const row of csvRows) {
      try {
        await api.post('/admin/users', { ...row, password: generatePassword(), force_change_pwd: true });
        ok++;
      } catch {
        // Count failures — reported in toast below
      }
    }
    const failed = csvRows.length - ok;
    showToast(
      failed === 0
        ? `Imported all ${ok} users successfully`
        : `Imported ${ok} of ${csvRows.length} users (${failed} failed)`,
      failed > 0 ? 'error' : 'success'
    );
    setCsvDrawer(false);
    setCsvRows([]);
    setCsvError('');
    setImporting(false);
    load();
  };

  const togglePerm = (mod, key, checked) => {
    setPerms(p => ({
      ...p,
      [mod]: {
        ...p[mod],
        [key]: checked,
        ...(key === 'view' && !checked ? { edit: false } : {}),
      },
    }));
  };

  const displayed = users.filter(u => {
    const q = search.toLowerCase();
    return !q || u.name?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q) || u.role?.includes(q);
  });

  const activeUsers   = users.filter(u => u.status === 'active').length;
  const inactiveUsers = users.filter(u => u.status === 'inactive').length;
  const adminCount    = users.filter(u => ['admin','super_admin'].includes(u.role)).length;

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
    <div className="adm-root">
      <style>{`@keyframes adm-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>

      {toast && <div className={`adm-toast adm-toast-${toast.type}`}>{toast.msg}</div>}

      {/* header */}
      <div className="adm-header">
        <div>
          <h2 className="adm-title">Operations Dashboard</h2>
          <p className="adm-sub">
            {activeTab === 'team' ? 'Team management & approvals' : 'User administration & system management'}
          </p>
        </div>
        <div className="adm-header-r">
          {/* Tab switcher — admin tab only visible to admin/super_admin */}
          <div style={{ display: 'flex', gap: 2, background: '#f3f4f6', borderRadius: 10, padding: 3, marginRight: 8 }}>
            <button
              onClick={() => setActiveTab('team')}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '5px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500,
                background: activeTab === 'team' ? '#fff' : 'transparent',
                color: activeTab === 'team' ? '#6366f1' : '#6b7280',
                boxShadow: activeTab === 'team' ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
              }}
            >
              <Users size={13} /> Team Ops
            </button>
            {isAdmin && (
              <button
                onClick={() => setActiveTab('admin')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  padding: '5px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500,
                  background: activeTab === 'admin' ? '#fff' : 'transparent',
                  color: activeTab === 'admin' ? '#6366f1' : '#6b7280',
                  boxShadow: activeTab === 'admin' ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
                }}
              >
                <BarChart2 size={13} /> Admin
              </button>
            )}
          </div>
          {activeTab === 'admin' && <>
          <button className="adm-btn-outline" onClick={() => setPage && setPage('AuditLogs')}>
            <Eye size={13} /> Audit Trail
          </button>
          <button className="adm-btn-outline" onClick={() => { setCsvRows([]); setCsvError(''); setCsvDrawer(true); }}>
            <Upload size={13} /> Import CSV
          </button>
          <button className="adm-btn-outline" onClick={() => { setPwdUser(null); setNewPwd(''); setDrawer('resetPwd'); }}>
            <Key size={13} /> Reset Password
          </button>
          <button className="adm-btn-primary" onClick={() => { setForm(emptyUser()); setPerms(defaultPerms('employee')); setDrawer('addUser'); }}>
            <Plus size={14} /> Add User
          </button>
          <button className="adm-icon-btn" onClick={load}><RefreshCw size={14} /></button>
          </>}
        </div>
      </div>

      {/* ── Team Ops Tab (ManagerDashboard) ──────────────────────────────────── */}
      {activeTab === 'team' && <ManagerDashboard setPage={setPage} hideHeader />}

      {/* ── Admin Tab ────────────────────────────────────────────────────────── */}
      {activeTab === 'admin' && <>

      {/* KPIs */}
      <div className="adm-kpis">
        <KPI icon={Users}      label="Total Users"    value={users.length}  color="#6366f1" sub={`${activeUsers} active`} />
        <KPI icon={CheckCircle}label="Active Users"   value={activeUsers}   color="#10b981" sub="Currently enabled" />
        <KPI icon={AlertCircle}label="Inactive Users" value={inactiveUsers} color="#ef4444" alert={inactiveUsers > 0} sub="Disabled accounts" />
        <KPI icon={ShieldCheck}label="Admins"         value={adminCount}    color="#8b5cf6" sub="Admin & Super Admin" />
        <KPI icon={Server}     label="System Health"  value="Healthy"       color="#10b981" sub="All services running" />
        <KPI icon={Database}   label="Storage"        value="—"             color="#3b82f6" sub="Usage not available" />
      </div>

      {/* main layout */}
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
                { label: 'Add New User',    icon: Plus,     action: () => { setForm(emptyUser()); setPerms(defaultPerms('employee')); setDrawer('addUser'); }, color: '#6366f1' },
                { label: 'Import CSV',      icon: Upload,   action: () => { setCsvRows([]); setCsvError(''); setCsvDrawer(true); }, color: '#10b981' },
                { label: 'Reset Password',  icon: Key,      action: () => { setPwdUser(null); setNewPwd(''); setDrawer('resetPwd'); }, color: '#f59e0b' },
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
              <div style={{ width: 40, height: 40, borderRadius: '50%', background: '#f0fdf4', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Activity size={20} color="#10b981" />
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>All Systems Operational</div>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>Click to run full health check</div>
              <div style={{ fontSize: 11, color: '#6366f1', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 3 }}>
                Open System Health <ChevronRight size={11} />
              </div>
            </div>
          </div>
        </div>

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

      {/* ── Add User Drawer ────────────────────────────────────────────────────── */}
      {drawer === 'addUser' && (
        <div className="adm-overlay" onClick={closeAddUser}>
          <div className="adm-drawer adm-drawer-lg" onClick={e => e.stopPropagation()}>
            <div className="adm-drawer-hd">
              <h3>Add New User</h3>
              <button className="adm-icon-btn" onClick={closeAddUser}><X size={16} /></button>
            </div>
            <div className="adm-drawer-body">
              <div className="adm-field">
                <label>Full Name *</label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Full name…" />
              </div>
              <div className="adm-field">
                <label>Email *</label>
                <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="user@company.com" />
              </div>
              <div className="adm-row2">
                <div className="adm-field">
                  <label>Role</label>
                  <select value={form.role} onChange={e => handleRoleChange(e.target.value)}>
                    <option value="employee">Employee</option>
                    <option value="manager">Manager</option>
                    <option value="department_head">Dept Head</option>
                    <option value="admin">Admin</option>
                    {isSuperAdmin && <option value="super_admin">Super Admin</option>}
                  </select>
                </div>
                <div className="adm-field">
                  <label>Department</label>
                  <select value={form.department} onChange={e => setForm(f => ({ ...f, department: e.target.value }))}>
                    <option value="">Select…</option>
                    {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
              </div>
              {form.department === 'Other' && (
                <div className="adm-field">
                  <label>Custom Department</label>
                  <input value={deptOther} onChange={e => setDeptOther(e.target.value)} placeholder="Enter department name…" />
                </div>
              )}

              <PwdField
                label="Temporary Password *"
                value={form.password}
                onChange={v => setForm(f => ({ ...f, password: v }))}
              />

              <label className="adm-checkbox-row">
                <input type="checkbox" checked={form.force_change_pwd}
                  onChange={e => setForm(f => ({ ...f, force_change_pwd: e.target.checked }))} />
                <span>Force password change on first login</span>
              </label>

              {/* Module permissions */}
              <div className="adm-perms-block">
                <button className="adm-perms-toggle" type="button" onClick={() => setShowPerms(v => !v)}>
                  <Lock size={12} />
                  Module Permissions
                  <ChevronRight size={13} style={{ transform: showPerms ? 'rotate(90deg)' : 'none', transition: 'transform .2s', marginLeft: 'auto' }} />
                </button>
                {showPerms && (
                  <div className="adm-perms-grid">
                    <div className="adm-perms-hd"><span>Module</span><span>View</span><span>Edit</span></div>
                    {PERM_MODULES.map(m => (
                      <div key={m} className="adm-perms-row">
                        <span>{m}</span>
                        <input type="checkbox" checked={perms[m]?.view || false}
                          onChange={e => togglePerm(m, 'view', e.target.checked)} />
                        <input type="checkbox" checked={perms[m]?.edit || false}
                          disabled={!perms[m]?.view}
                          onChange={e => togglePerm(m, 'edit', e.target.checked)} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="adm-drawer-ft">
              <button className="adm-btn-outline" onClick={closeAddUser}>Cancel</button>
              <button className="adm-btn-primary" onClick={handleAddUser} disabled={submitting}>
                {submitting ? 'Creating…' : 'Create User'}
              </button>
            </div>
          </div>
        </div>
      )}

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

      {/* ── CSV Import Drawer ─────────────────────────────────────────────────── */}
      {csvDrawer && (
        <div className="adm-overlay" onClick={() => { if (!importing) { setCsvDrawer(false); setCsvRows([]); setCsvError(''); } }}>
          <div className="adm-drawer adm-drawer-lg" onClick={e => e.stopPropagation()}>
            <div className="adm-drawer-hd">
              <h3>Bulk Import Users</h3>
              <button className="adm-icon-btn" onClick={() => { setCsvDrawer(false); setCsvRows([]); setCsvError(''); }}><X size={16} /></button>
            </div>
            <div className="adm-drawer-body">
              <div className="adm-csv-hint">
                <p style={{ margin: '0 0 4px', fontWeight: 600, fontSize: 12 }}>Expected CSV format (include header row):</p>
                <code>Name, Email, Role, Department</code>
                <p style={{ margin: '6px 0 0', fontSize: 11, color: '#9ca3af' }}>
                  Role values: employee · manager · department_head · admin{isSuperAdmin ? ' · super_admin' : ''}<br />
                  A random temporary password is generated per user. Force-change-on-login is enabled by default.
                </p>
              </div>

              <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={handleCSVFile} />
              <button className="adm-csv-upload-btn" onClick={() => fileRef.current?.click()}>
                <Upload size={16} />
                {csvRows.length > 0 ? `${csvRows.length} users loaded — click to replace` : 'Choose CSV file…'}
              </button>
              {csvError && <p className="adm-csv-error">{csvError}</p>}

              {csvRows.length > 0 && (
                <div>
                  <p style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 600, color: '#374151' }}>
                    {csvRows.length} user{csvRows.length !== 1 ? 's' : ''} ready to import
                  </p>
                  <div className="adm-table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
                    <table className="adm-table">
                      <thead>
                        <tr><th>Name</th><th>Email</th><th>Role</th><th>Department</th></tr>
                      </thead>
                      <tbody>
                        {csvRows.map((r, i) => (
                          <tr key={i} className="adm-row">
                            <td>{r.name}</td><td>{r.email}</td><td>{r.role}</td><td>{r.department || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
            <div className="adm-drawer-ft">
              <button className="adm-btn-outline" onClick={() => { setCsvDrawer(false); setCsvRows([]); setCsvError(''); }}>Cancel</button>
              <button className="adm-btn-primary" onClick={handleImportCSV} disabled={importing || csvRows.length === 0}>
                {importing ? 'Importing…' : `Import ${csvRows.length > 0 ? `${csvRows.length} Users` : 'Users'}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}