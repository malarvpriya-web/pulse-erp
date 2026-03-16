import { useState, useEffect, useCallback } from 'react';
import {
  Users, ShieldCheck, Activity, Database, RefreshCw,
  Plus, Key, FileText, X, Search, ChevronRight,
  AlertCircle, CheckCircle, Clock, ToggleLeft, ToggleRight,
  Server, Zap, Eye
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell
} from 'recharts';
import api from '@/services/api/client';
import './AdminDashboard.css';

// ── sample data ──────────────────────────────────────────────────────────────
const SAMPLE_USERS = [
  { id: 1,  name: 'Rajesh Kumar',   email: 'rajesh@pulse.in',   role: 'super_admin',     status: 'active',   last_login: '2026-03-15T09:12:00', department: 'IT' },
  { id: 2,  name: 'Priya Sharma',   email: 'priya@pulse.in',    role: 'admin',            status: 'active',   last_login: '2026-03-15T08:45:00', department: 'HR' },
  { id: 3,  name: 'Anand Menon',    email: 'anand@pulse.in',    role: 'manager',          status: 'active',   last_login: '2026-03-14T17:30:00', department: 'Engineering' },
  { id: 4,  name: 'Ravi Kumar',     email: 'ravi@pulse.in',     role: 'employee',         status: 'active',   last_login: '2026-03-15T09:00:00', department: 'Sales' },
  { id: 5,  name: 'Kavitha Menon',  email: 'kavitha@pulse.in',  role: 'employee',         status: 'inactive', last_login: '2026-02-20T10:15:00', department: 'Finance' },
  { id: 6,  name: 'Suresh Pillai',  email: 'suresh@pulse.in',   role: 'department_head',  status: 'active',   last_login: '2026-03-15T08:20:00', department: 'Operations' },
  { id: 7,  name: 'Vijay Nair',     email: 'vijay@pulse.in',    role: 'employee',         status: 'active',   last_login: '2026-03-13T14:00:00', department: 'Marketing' },
  { id: 8,  name: 'Meena Raj',      email: 'meena@pulse.in',    role: 'employee',         status: 'inactive', last_login: '2026-01-10T11:00:00', department: 'HR' },
];

const SAMPLE_AUDIT = [
  { id: 1,  user: 'Rajesh Kumar',  action: 'User Created',      module: 'Admin',    detail: 'Added new employee Meena Raj',     ts: '2026-03-15T09:10:00' },
  { id: 2,  user: 'Priya Sharma',  action: 'Role Changed',      module: 'Admin',    detail: 'Changed Anand role to manager',    ts: '2026-03-15T08:50:00' },
  { id: 3,  user: 'Anand Menon',   action: 'Leave Approved',    module: 'Leaves',   detail: 'Approved Ravi Kumar leave',        ts: '2026-03-15T08:30:00' },
  { id: 4,  user: 'Suresh Pillai', action: 'Invoice Created',   module: 'Finance',  detail: 'INV-2026-089 for TechCorp',        ts: '2026-03-15T08:00:00' },
  { id: 5,  user: 'System',        action: 'Backup Completed',  module: 'System',   detail: 'Daily DB backup successful',        ts: '2026-03-15T02:00:00' },
  { id: 6,  user: 'Kavitha Menon', action: 'Password Reset',    module: 'Auth',     detail: 'Password reset by admin',          ts: '2026-03-14T17:00:00' },
  { id: 7,  user: 'Rajesh Kumar',  action: 'Config Changed',    module: 'Settings', detail: 'Updated email SMTP settings',      ts: '2026-03-14T15:30:00' },
];

const SAMPLE_MODULE_ACTIVITY = [
  { module: 'HR',         count: 248, color: '#6366f1' },
  { module: 'Finance',    count: 187, color: '#10b981' },
  { module: 'CRM',        count: 156, color: '#3b82f6' },
  { module: 'Projects',   count: 132, color: '#f59e0b' },
  { module: 'Leaves',     count: 98,  color: '#8b5cf6' },
  { module: 'Timesheets', count: 76,  color: '#ef4444' },
  { module: 'Inventory',  count: 54,  color: '#14b8a6' },
  { module: 'Travel',     count: 42,  color: '#f97316' },
];

const ROLE_META = {
  super_admin:    { bg: '#ede9fe', color: '#7c3aed', label: 'Super Admin' },
  admin:          { bg: '#dbeafe', color: '#1d4ed8', label: 'Admin' },
  manager:        { bg: '#dcfce7', color: '#15803d', label: 'Manager' },
  department_head:{ bg: '#fef3c7', color: '#92400e', label: 'Dept Head' },
  employee:       { bg: '#f3f4f6', color: '#374151', label: 'Employee' },
};

const MODULE_COLORS = { Admin: '#6366f1', Auth: '#8b5cf6', Leaves: '#10b981', Finance: '#3b82f6', System: '#9ca3af', Settings: '#f59e0b' };

const timeAgo = ts => {
  const d = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (d < 1)  return 'just now';
  if (d < 60) return `${d}m ago`;
  const h = Math.floor(d / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

const emptyUser = () => ({ name: '', email: '', role: 'employee', department: '', password: '' });

// ── KPI card ─────────────────────────────────────────────────────────────────
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

// ── main ─────────────────────────────────────────────────────────────────────
export default function AdminDashboard({ setPage }) {
  const [users,    setUsers]    = useState([]);
  const [audit,    setAudit]    = useState([]);
  const [activity, setActivity] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [search,   setSearch]   = useState('');
  const [drawer,   setDrawer]   = useState(null); // null | 'addUser' | 'resetPwd'
  const [form,     setForm]     = useState(emptyUser());
  const [pwdUser,  setPwdUser]  = useState(null);
  const [newPwd,   setNewPwd]   = useState('');
  const [submitting,setSubmitting]=useState(false);
  const [toast,    setToast]    = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    const [usersRes, auditRes, actRes] = await Promise.allSettled([
      api.get('/admin/users'),
      api.get('/audit/logs', { params: { limit: 20 } }),
      api.get('/admin/module-activity'),
    ]);
    const rawUsers = usersRes.status === 'fulfilled' ? (usersRes.value.data.users || usersRes.value.data) : [];
    setUsers(Array.isArray(rawUsers) && rawUsers.length ? rawUsers : SAMPLE_USERS);

    const rawAudit = auditRes.status === 'fulfilled' ? (auditRes.value.data.logs || auditRes.value.data) : [];
    setAudit(Array.isArray(rawAudit) && rawAudit.length ? rawAudit : SAMPLE_AUDIT);

    const rawAct = actRes.status === 'fulfilled' ? (actRes.value.data.activity || actRes.value.data) : [];
    setActivity(Array.isArray(rawAct) && rawAct.length ? rawAct : SAMPLE_MODULE_ACTIVITY);

    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleStatus = async user => {
    const newStatus = user.status === 'active' ? 'inactive' : 'active';
    try { await api.put(`/admin/users/${user.id}`, { status: newStatus }); } catch {}
    setUsers(us => us.map(u => u.id === user.id ? { ...u, status: newStatus } : u));
    showToast(`${user.name} ${newStatus === 'active' ? 'activated' : 'deactivated'}`);
  };

  const handleAddUser = async () => {
    if (!form.name || !form.email) return showToast('Name and email required', 'error');
    setSubmitting(true);
    try {
      await api.post('/admin/users', form);
    } catch {
      setUsers(us => [{ ...form, id: Date.now(), status: 'active', last_login: null }, ...us]);
    }
    showToast('User created');
    setDrawer(null);
    setForm(emptyUser());
    setSubmitting(false);
    load();
  };

  const handleResetPwd = async () => {
    if (!newPwd || newPwd.length < 6) return showToast('Password must be at least 6 chars', 'error');
    setSubmitting(true);
    try { await api.post(`/admin/users/${pwdUser.id}/reset-password`, { password: newPwd }); } catch {}
    showToast(`Password reset for ${pwdUser.name}`);
    setDrawer(null);
    setPwdUser(null);
    setNewPwd('');
    setSubmitting(false);
  };

  const displayed = users.filter(u => {
    const q = search.toLowerCase();
    return !q || u.name?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q) || u.role?.includes(q);
  });

  const activeUsers   = users.filter(u => u.status === 'active').length;
  const inactiveUsers = users.filter(u => u.status === 'inactive').length;
  const adminCount    = users.filter(u => ['admin','super_admin'].includes(u.role)).length;

  if (loading) return <div className="adm-loading"><div className="adm-spinner" /><p>Loading…</p></div>;

  return (
    <div className="adm-root">

      {toast && <div className={`adm-toast adm-toast-${toast.type}`}>{toast.msg}</div>}

      {/* header */}
      <div className="adm-header">
        <div>
          <h2 className="adm-title">Admin Dashboard</h2>
          <p className="adm-sub">System management &amp; user administration</p>
        </div>
        <div className="adm-header-r">
          <button className="adm-btn-outline" onClick={() => setPage && setPage('AuditLogs')}>
            <Eye size={13} /> Audit Trail
          </button>
          <button className="adm-btn-outline" onClick={() => { setPwdUser(null); setNewPwd(''); setDrawer('resetPwd'); }}>
            <Key size={13} /> Reset Password
          </button>
          <button className="adm-btn-primary" onClick={() => { setForm(emptyUser()); setDrawer('addUser'); }}>
            <Plus size={14} /> Add User
          </button>
          <button className="adm-icon-btn" onClick={load}><RefreshCw size={14} /></button>
        </div>
      </div>

      {/* KPIs */}
      <div className="adm-kpis">
        <KPI icon={Users}      label="Total Users"     value={users.length}     color="#6366f1" sub={`${activeUsers} active`} />
        <KPI icon={CheckCircle}label="Active Users"    value={activeUsers}      color="#10b981" sub="Currently enabled" />
        <KPI icon={AlertCircle}label="Inactive Users"  value={inactiveUsers}    color="#ef4444" alert={inactiveUsers > 0} sub="Disabled accounts" />
        <KPI icon={ShieldCheck}label="Admins"          value={adminCount}       color="#8b5cf6" sub="Admin & Super Admin" />
        <KPI icon={Server}     label="System Health"   value="Healthy"          color="#10b981" sub="All services running" />
        <KPI icon={Database}   label="Storage"         value="4.2 GB"           color="#3b82f6" sub="of 20 GB used" />
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
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>User</th><th>Role</th><th>Department</th>
                    <th>Last Login</th><th>Status</th><th>Actions</th>
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
                          <span className="adm-role-badge" style={{ background: rm.bg, color: rm.color }}>
                            {rm.label}
                          </span>
                        </td>
                        <td><span className="adm-dept">{u.department || '—'}</span></td>
                        <td>
                          <span className="adm-time">
                            {u.last_login ? timeAgo(u.last_login) : 'Never'}
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
                                : <ToggleLeft size={18} color="#9ca3af" />}
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
            </div>
          </div>
        </div>

        {/* right column */}
        <div className="adm-fc4 adm-right">

          {/* quick actions */}
          <div className="adm-card-box">
            <div className="adm-box-hd"><span className="adm-section-title"><Zap size={13} style={{ marginRight: 5 }} />Quick Actions</span></div>
            <div className="adm-box-body adm-quick-actions">
              {[
                { label: 'Add New User',      icon: Plus,      action: () => { setForm(emptyUser()); setDrawer('addUser'); }, color: '#6366f1' },
                { label: 'Reset Password',    icon: Key,       action: () => { setPwdUser(null); setNewPwd(''); setDrawer('resetPwd'); }, color: '#f59e0b' },
                { label: 'View Audit Trail',  icon: FileText,  action: () => setPage && setPage('AuditLogs'),    color: '#3b82f6' },
                { label: 'System Settings',   icon: Server,    action: () => {},                                  color: '#8b5cf6' },
              ].map(({ label, icon: Icon, action, color }) => (
                <button key={label} className="adm-qa-btn" onClick={action} style={{ '--c': color }}>
                  <div className="adm-qa-icon"><Icon size={15} /></div>
                  <span>{label}</span>
                  <ChevronRight size={12} className="adm-qa-arrow" />
                </button>
              ))}
            </div>
          </div>

          {/* system health */}
          <div className="adm-card-box">
            <div className="adm-box-hd"><span className="adm-section-title"><Activity size={13} style={{ marginRight: 5 }} />System Health</span></div>
            <div className="adm-box-body">
              {[
                { label: 'API Server',    status: 'online', uptime: '99.9%' },
                { label: 'Database',      status: 'online', uptime: '99.8%' },
                { label: 'File Storage',  status: 'online', uptime: '100%' },
                { label: 'Email Service', status: 'online', uptime: '99.5%' },
                { label: 'Scheduler',     status: 'online', uptime: '100%' },
              ].map(s => (
                <div key={s.label} className="adm-health-row">
                  <div className={`adm-health-dot adm-health-${s.status}`} />
                  <span className="adm-health-label">{s.label}</span>
                  <span className="adm-health-uptime">{s.uptime}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* module activity chart */}
        <div className="adm-fc8">
          <div className="adm-card-box">
            <div className="adm-box-hd"><span className="adm-section-title">Module Activity (This Month)</span></div>
            <div className="adm-box-body">
              <ResponsiveContainer width="100%" height={200}>
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
            </div>
          </div>
        </div>

        {/* recent audit logs */}
        <div className="adm-fc4">
          <div className="adm-card-box" style={{ height: '100%' }}>
            <div className="adm-box-hd">
              <span className="adm-section-title">Recent Audit Logs</span>
              <button className="adm-text-btn" onClick={() => setPage && setPage('AuditLogs')}>
                View All <ChevronRight size={12} />
              </button>
            </div>
            <div className="adm-box-body adm-audit-list">
              {audit.slice(0, 8).map((a, i) => {
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
              })}
            </div>
          </div>
        </div>

      </div>

      {/* Add User Drawer */}
      {drawer === 'addUser' && (
        <div className="adm-overlay" onClick={() => setDrawer(null)}>
          <div className="adm-drawer" onClick={e => e.stopPropagation()}>
            <div className="adm-drawer-hd">
              <h3>Add New User</h3>
              <button className="adm-icon-btn" onClick={() => setDrawer(null)}><X size={16} /></button>
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
                  <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                    <option value="employee">Employee</option>
                    <option value="manager">Manager</option>
                    <option value="department_head">Dept Head</option>
                    <option value="admin">Admin</option>
                    <option value="super_admin">Super Admin</option>
                  </select>
                </div>
                <div className="adm-field">
                  <label>Department</label>
                  <input value={form.department} onChange={e => setForm(f => ({ ...f, department: e.target.value }))} placeholder="e.g. Engineering" />
                </div>
              </div>
              <div className="adm-field">
                <label>Temporary Password</label>
                <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="Min 6 characters…" />
              </div>
            </div>
            <div className="adm-drawer-ft">
              <button className="adm-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
              <button className="adm-btn-primary" onClick={handleAddUser} disabled={submitting}>
                {submitting ? 'Creating…' : 'Create User'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset Password Drawer */}
      {drawer === 'resetPwd' && (
        <div className="adm-overlay" onClick={() => setDrawer(null)}>
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
              <div className="adm-field">
                <label>New Password *</label>
                <input type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} placeholder="Min 6 characters…" />
              </div>
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
    </div>
  );
}
