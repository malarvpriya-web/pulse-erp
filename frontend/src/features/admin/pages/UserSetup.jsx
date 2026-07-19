import { useState, useEffect, useRef, useCallback } from 'react';
import { Users, Plus, Edit2, Key, Trash2, X, Check, Shield, RefreshCw, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const ROLES = ['employee', 'manager', 'hr', 'finance', 'admin', 'super_admin'];

const ROLE_COLORS = {
  super_admin: { color: '#dc2626', bg: '#fee2e2' },
  admin:       { color: '#6B3FDB', bg: '#ede9fe' },
  hr:          { color: '#0369a1', bg: '#e0f2fe' },
  finance:     { color: '#16a34a', bg: '#dcfce7' },
  manager:     { color: '#d97706', bg: '#fef3c7' },
  employee:    { color: '#6b7280', bg: '#f3f4f6' },
};

const STATUS_CFG = {
  active:   { color: '#16a34a', bg: '#dcfce7', label: 'Active'   },
  inactive: { color: '#dc2626', bg: '#fee2e2', label: 'Inactive' },
};

// ── Seed / test account detection ────────────────────────────────────────────
const SEED_EMAIL_DOMAINS  = ['@company.com', '@pulse.com'];
const SEED_GENERIC_NAMES  = new Set([
  'admin user', 'super admin', 'hr manager', 'finance manager',
  'manager user', 'department head', 'dept head', 'employee user',
]);

function isSuspectSeed(u) {
  if (!u?.email) return false;
  const email = u.email.toLowerCase();
  if (SEED_EMAIL_DOMAINS.some(d => email.endsWith(d))) return true;
  const name = (u.name ?? '').trim().toLowerCase();
  if (SEED_GENERIC_NAMES.has(name)) return true;
  if (name.endsWith(' employee')) return true;  // "Jane Employee", "John Employee"
  return false;
}

function privilegedDeactivateMsg(u) {
  if (!u) return '';
  if (u.role === 'super_admin')
    return `Deactivate ${u.name ?? 'this user'}? This will remove Super Admin access from the system. Continue?`;
  if (u.role === 'admin')
    return `Deactivate ${u.name ?? 'this user'}? This will remove Admin access from the system. Continue?`;
  return `Deactivate ${u.name ?? 'this user'}? They will lose system access.`;
}
// ─────────────────────────────────────────────────────────────────────────────

function RoleBadge({ role }) {
  const c = ROLE_COLORS[(role ?? 'employee').toLowerCase()] ?? ROLE_COLORS.employee;
  return (
    <span style={{ padding: '2px 9px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: c.bg, color: c.color }}>
      {(role ?? 'employee').replace('_', ' ').toUpperCase()}
    </span>
  );
}

const EMPTY_FORM = { name: '', email: '', password: '', role: 'employee', department: '' };

export default function UserSetup() {
  const [users,               setUsers]               = useState([]);
  const [loading,             setLoading]             = useState(false);
  const [showCreate,          setShowCreate]          = useState(false);
  const [editUser,            setEditUser]            = useState(null);
  const [resetTarget,         setResetTarget]         = useState(null);
  const [resetPwd,            setResetPwd]            = useState('');
  const [form,                setForm]                = useState(EMPTY_FORM);
  const [pendingDeactivate,   setPendingDeactivate]   = useState(null);
  const [msg,                 setMsg]                 = useState(null);
  const [deptList,            setDeptList]            = useState([]);
  // Seed audit state
  const [showSeedAudit,       setShowSeedAudit]       = useState(false);
  const [selectedSeeds,       setSelectedSeeds]       = useState(new Set());
  const [pendingBulkDeact,    setPendingBulkDeact]    = useState(false);
  const isMounted = useRef(true);

  const toast = useCallback((text, type = 'ok') => {
    setMsg({ text, type });
    setTimeout(() => { if (isMounted.current) setMsg(null); }, 3500);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/admin/users');
      if (!isMounted.current) return;
      setUsers(Array.isArray(r.data) ? r.data : []);
    } catch {
      if (isMounted.current) setUsers([]);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    isMounted.current = true;
    load();
    api.get('/admin/config/departments')
      .then(r => setDeptList(Array.isArray(r.data) ? r.data.map(d => d.name || d) : []))
      .catch(() => setDeptList([]));
    return () => { isMounted.current = false; };
  }, [load]);

  const createUser = async () => {
    if (!form.name || !form.email || !form.password)
      return toast('Name, email and password are required', 'err');
    if (form.password.length < 8)
      return toast('Password must be at least 8 characters', 'err');
    try {
      await api.post('/admin/users', form);
      toast('User created successfully');
      setShowCreate(false);
      setForm(EMPTY_FORM);
      load();
    } catch (e) {
      toast(e.response?.data?.error || e.message, 'err');
    }
  };

  const saveEdit = async () => {
    if (!editUser) return;
    try {
      await api.put(`/admin/users/${editUser.id}`, {
        role:       editUser.role,
        status:     editUser.status,
        department: editUser.department,
      });
      toast('User updated');
      setEditUser(null);
      load();
    } catch (e) {
      toast(e.response?.data?.error || e.message, 'err');
    }
  };

  const deactivate = async () => {
    if (!pendingDeactivate) return;
    const u = pendingDeactivate;
    setPendingDeactivate(null);
    try {
      await api.delete(`/admin/users/${u.id}`);
      toast(`${u.name ?? 'User'} deactivated`);
      load();
    } catch (e) {
      toast(e.response?.data?.error || e.message, 'err');
    }
  };

  const doResetPwd = async () => {
    if (!resetPwd || resetPwd.length < 8)
      return toast('Password must be at least 8 characters', 'err');
    try {
      await api.post(`/admin/users/${resetTarget.id}/reset-password`, { password: resetPwd });
      toast('Password reset successfully');
      setResetTarget(null);
      setResetPwd('');
    } catch (e) {
      toast(e.response?.data?.error || e.message, 'err');
    }
  };

  const bulkDeactivate = async () => {
    setPendingBulkDeact(false);
    const ids = Array.from(selectedSeeds);
    try {
      const r = await api.post('/admin/users/bulk-deactivate', { ids });
      toast(`${r.data.deactivated} account(s) deactivated`);
      setSelectedSeeds(new Set());
      load();
    } catch (e) {
      toast(e.response?.data?.error || e.message, 'err');
    }
  };

  const suspects = users.filter(u => isSuspectSeed(u) && u.status === 'active');

  const toggleSeed = id =>
    setSelectedSeeds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const card = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' };

  return (
    <div style={{ padding: 24 }}>
      {/* Single deactivate confirm */}
      <ConfirmDialog
        open={!!pendingDeactivate}
        title="Deactivate User"
        message={privilegedDeactivateMsg(pendingDeactivate)}
        confirmLabel="Deactivate"
        variant="warning"
        onConfirm={deactivate}
        onCancel={() => setPendingDeactivate(null)}
      />

      {/* Bulk deactivate confirm */}
      <ConfirmDialog
        open={pendingBulkDeact}
        title="Bulk Deactivate Seed Accounts"
        message={`Deactivate ${selectedSeeds.size} selected account(s)? They will lose system access immediately. This cannot be undone without manual re-activation.`}
        confirmLabel={`Deactivate ${selectedSeeds.size} Account(s)`}
        variant="warning"
        onConfirm={bulkDeactivate}
        onCancel={() => setPendingBulkDeact(false)}
      />

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 42, height: 42, borderRadius: 10, background: '#ede9fe', color: '#6B3FDB', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Users size={20} />
          </div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#111827' }}>User Management</h1>
            <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>Manage system users, roles, and access. All changes are audit-logged.</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={{ padding: '8px 14px', background: '#f5f3ff', color: '#6B3FDB', border: '1px solid #e9e4ff', borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button onClick={() => setShowCreate(true)} style={{ padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>
            <Plus size={14} /> Add User
          </button>
        </div>
      </div>

      {/* Toast */}
      {msg && (
        <div style={{ marginBottom: 16, padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: msg.type === 'ok' ? '#dcfce7' : '#fee2e2', color: msg.type === 'ok' ? '#16a34a' : '#dc2626' }}>
          {msg.text}
        </div>
      )}

      {/* ── Seed Account Audit Banner ─────────────────────────────────────────── */}
      {!loading && suspects.length > 0 && (
        <div style={{ marginBottom: 20, border: '1px solid #fcd34d', borderRadius: 12, overflow: 'hidden' }}>
          {/* Banner header */}
          <button
            onClick={() => setShowSeedAudit(v => !v)}
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: '#fffbeb', border: 'none', cursor: 'pointer', textAlign: 'left' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <AlertTriangle size={16} color="#d97706" />
              <span style={{ fontWeight: 700, color: '#92400e', fontSize: 13 }}>
                Seed Account Audit — {suspects.length} suspect account{suspects.length > 1 ? 's' : ''} detected
              </span>
              <span style={{ fontSize: 12, color: '#b45309', fontWeight: 400 }}>
                (generic names or non-company email domains — review before go-live)
              </span>
            </div>
            {showSeedAudit ? <ChevronUp size={16} color="#92400e" /> : <ChevronDown size={16} color="#92400e" />}
          </button>

          {/* Expanded detail */}
          {showSeedAudit && (
            <div style={{ padding: 16, background: '#fff' }}>
              <p style={{ margin: '0 0 12px', fontSize: 12, color: '#6b7280' }}>
                Review each account below. Select the ones you want to deactivate, then click <strong>Bulk Deactivate Selected</strong>.
                Real employees with @manifest.in addresses should remain active.
              </p>

              {/* Select All / Deselect All */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <button
                  onClick={() => setSelectedSeeds(new Set(suspects.map(u => u.id)))}
                  style={{ fontSize: 12, padding: '4px 10px', background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d', borderRadius: 6, cursor: 'pointer' }}>
                  Select All ({suspects.length})
                </button>
                <button
                  onClick={() => setSelectedSeeds(new Set())}
                  style={{ fontSize: 12, padding: '4px 10px', background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer' }}>
                  Deselect All
                </button>
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#fffbeb' }}>
                      {['', 'Name', 'Email', 'Role', 'Dept', 'Last Login'].map(h => (
                        <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: '#92400e', borderBottom: '1px solid #fde68a' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {suspects.map(u => (
                      <tr key={u.id} style={{ borderBottom: '1px solid #fef3c7', background: selectedSeeds.has(u.id) ? '#fffbeb' : '#fff' }}>
                        <td style={{ padding: '7px 10px' }}>
                          <input
                            type="checkbox"
                            checked={selectedSeeds.has(u.id)}
                            onChange={() => toggleSeed(u.id)}
                            style={{ cursor: 'pointer' }}
                          />
                        </td>
                        <td style={{ padding: '7px 10px', fontWeight: 600, color: '#111827' }}>{u.name ?? '—'}</td>
                        <td style={{ padding: '7px 10px', color: '#6b7280' }}>{u.email ?? '—'}</td>
                        <td style={{ padding: '7px 10px' }}><RoleBadge role={u.role} /></td>
                        <td style={{ padding: '7px 10px', color: '#6b7280' }}>{u.department ?? '—'}</td>
                        <td style={{ padding: '7px 10px', color: '#9ca3af' }}>{u.last_login ? new Date(u.last_login).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : 'Never'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  disabled={selectedSeeds.size === 0}
                  onClick={() => setPendingBulkDeact(true)}
                  style={{
                    padding: '8px 18px', background: selectedSeeds.size === 0 ? '#f3f4f6' : '#dc2626',
                    color: selectedSeeds.size === 0 ? '#9ca3af' : '#fff',
                    border: 'none', borderRadius: 8, cursor: selectedSeeds.size === 0 ? 'default' : 'pointer',
                    fontWeight: 600, fontSize: 13,
                  }}>
                  Bulk Deactivate Selected ({selectedSeeds.size})
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Create user panel */}
      {showCreate && (
        <div style={{ marginBottom: 20, padding: 20, border: '1px solid #e9e4ff', borderRadius: 12, background: '#faf5ff' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h3 style={{ margin: 0, color: '#4c1d95', fontSize: 16, fontWeight: 700 }}>Create New User</h3>
            <button onClick={() => { setShowCreate(false); setForm(EMPTY_FORM); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><X size={18} /></button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            {[['Full Name', 'name', 'text'], ['Email', 'email', 'email'], ['Password', 'password', 'password']].map(([label, key, type]) => (
              <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>{label}</span>
                <input
                  type={type}
                  value={form[key]}
                  onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                  style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none' }}
                />
              </label>
            ))}
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Role</span>
              <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: '#fff', outline: 'none' }}>
                {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Department</span>
              <select
                value={form.department}
                onChange={e => setForm(f => ({ ...f, department: e.target.value }))}
                style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: '#fff', outline: 'none' }}>
                <option value="">-- Select Department --</option>
                {deptList.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
          </div>
          <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => { setShowCreate(false); setForm(EMPTY_FORM); }}
              style={{ padding: '8px 18px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
              Cancel
            </button>
            <button onClick={createUser}
              style={{ padding: '8px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
              Create User
            </button>
          </div>
        </div>
      )}

      {/* Reset password panel */}
      {resetTarget && (
        <div style={{ marginBottom: 20, padding: 20, border: '1px solid #fcd34d', borderRadius: 12, background: '#fffbeb' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0, color: '#92400e', fontSize: 15, fontWeight: 700 }}>Reset Password — {resetTarget.name}</h3>
            <button onClick={() => { setResetTarget(null); setResetPwd(''); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><X size={18} /></button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="password"
              value={resetPwd}
              onChange={e => setResetPwd(e.target.value)}
              placeholder="New password (min. 8 characters)"
              style={{ flex: 1, padding: '8px 12px', border: '1px solid #fcd34d', borderRadius: 8, fontSize: 13, outline: 'none' }}
            />
            <button onClick={doResetPwd}
              style={{ padding: '8px 18px', background: '#d97706', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
              Reset Password
            </button>
          </div>
        </div>
      )}

      {/* Users table */}
      <div style={card}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 48, color: '#9ca3af' }}>Loading users…</div>
        ) : users.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 48, color: '#9ca3af' }}>No users found.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['Name / Email', 'Role', 'Department', 'Status', '2FA', 'Last Login', 'Actions'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap', fontSize: 12 }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users?.map(u => {
                  const isEditing = editUser?.id === u.id;
                  const sc = STATUS_CFG[u?.status] ?? STATUS_CFG.inactive;
                  return (
                    <tr key={u.id} style={{ borderBottom: '1px solid #f3f4f6', opacity: u?.status === 'inactive' ? 0.6 : 1 }}>

                      <td style={{ padding: '10px 14px' }}>
                        <div style={{ fontWeight: 600, color: '#111827' }}>{u?.name ?? 'Unknown'}</div>
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>{u?.email ?? ''}</div>
                      </td>

                      <td style={{ padding: '10px 14px' }}>
                        {isEditing ? (
                          <select value={editUser.role} onChange={e => setEditUser(x => ({ ...x, role: e.target.value }))}
                            style={{ padding: '5px 8px', border: '1px solid #a78bfa', borderRadius: 6, fontSize: 12, background: '#fff', outline: 'none' }}>
                            {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                          </select>
                        ) : <RoleBadge role={u?.role ?? 'employee'} />}
                      </td>

                      <td style={{ padding: '10px 14px', color: '#6b7280' }}>
                        {isEditing ? (
                          <select value={editUser.department ?? ''} onChange={e => setEditUser(x => ({ ...x, department: e.target.value }))}
                            style={{ padding: '5px 8px', border: '1px solid #a78bfa', borderRadius: 6, fontSize: 12, width: 110, outline: 'none', background: '#fff' }}>
                            <option value="">— Dept —</option>
                            {deptList.map(d => <option key={d} value={d}>{d}</option>)}
                          </select>
                        ) : (u?.department ?? '—')}
                      </td>

                      <td style={{ padding: '10px 14px' }}>
                        {isEditing ? (
                          <select value={editUser.status} onChange={e => setEditUser(x => ({ ...x, status: e.target.value }))}
                            style={{ padding: '5px 8px', border: '1px solid #a78bfa', borderRadius: 6, fontSize: 12, background: '#fff', outline: 'none' }}>
                            <option value="active">Active</option>
                            <option value="inactive">Inactive</option>
                          </select>
                        ) : (
                          <span style={{ padding: '2px 9px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: sc.bg, color: sc.color }}>
                            {sc.label}
                          </span>
                        )}
                      </td>

                      <td style={{ padding: '10px 14px' }}>
                        <Shield size={15} color={u?.two_factor_enabled ? '#16a34a' : '#e5e7eb'} title={u?.two_factor_enabled ? '2FA enabled' : '2FA not set'} />
                      </td>

                      <td style={{ padding: '10px 14px', fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>
                        {u?.last_login ? new Date(u.last_login).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : 'Never'}
                      </td>

                      <td style={{ padding: '10px 14px' }}>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          {isEditing ? (
                            <>
                              <button onClick={saveEdit}
                                style={{ padding: '5px 10px', background: '#dcfce7', color: '#16a34a', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600 }}>
                                <Check size={12} /> Save
                              </button>
                              <button onClick={() => setEditUser(null)}
                                style={{ padding: '5px 8px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
                                <X size={12} />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => setEditUser({ id: u.id, role: u?.role ?? 'employee', status: u?.status ?? 'active', department: u?.department ?? '' })}
                                title="Edit"
                                style={{ padding: '5px 8px', background: '#f5f3ff', color: '#6B3FDB', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
                                <Edit2 size={13} />
                              </button>
                              <button
                                onClick={() => { setResetTarget({ id: u.id, name: u?.name ?? '' }); setResetPwd(''); }}
                                title="Reset password"
                                style={{ padding: '5px 8px', background: '#fffbeb', color: '#d97706', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
                                <Key size={13} />
                              </button>
                              {u?.status === 'active' && (
                                <button
                                  onClick={() => setPendingDeactivate(u)}
                                  title="Deactivate"
                                  style={{ padding: '5px 8px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
                                  <Trash2 size={13} />
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </td>

                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
