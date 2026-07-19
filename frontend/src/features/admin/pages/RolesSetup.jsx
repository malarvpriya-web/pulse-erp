import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Shield, RefreshCw, Plus, Trash2, Search, X, Star,
  ChevronLeft, ChevronRight, ChevronUp, ChevronDown,
} from 'lucide-react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const PAGE_SIZES = [10, 25, 50, 100];

const ROLE_COLORS = {
  super_admin:     { color: '#dc2626', bg: '#fee2e2' },
  admin:           { color: '#6B3FDB', bg: '#ede9fe' },
  hr:              { color: '#0369a1', bg: '#e0f2fe' },
  hr_manager:      { color: '#0369a1', bg: '#e0f2fe' },
  finance:         { color: '#16a34a', bg: '#dcfce7' },
  finance_manager: { color: '#16a34a', bg: '#dcfce7' },
  manager:         { color: '#d97706', bg: '#fef3c7' },
  department_head: { color: '#d97706', bg: '#fef3c7' },
  employee:        { color: '#6b7280', bg: '#f3f4f6' },
};
const DEFAULT_ROLE_COLOR = { color: '#4b5563', bg: '#eef2f7' };
const roleColor = (r) => ROLE_COLORS[r] ?? DEFAULT_ROLE_COLOR;

// Granting these is super_admin-only server-side; warn before asking.
const PRIVILEGED = new Set(['super_admin', 'admin']);

const COLUMNS = [
  { key: 'member_id', label: 'Member ID', sortable: true  },
  { key: 'name',      label: 'Member',    sortable: true  },
  { key: 'login',     label: 'Login',     sortable: true  },
  { key: 'role',      label: 'Role',      sortable: true  },
  { key: 'status',    label: 'Status',    sortable: false },
  { key: 'actions',   label: '',          sortable: false },
];

export default function RolesSetup() {
  const [rows,       setRows]       = useState([]);
  const [roles,      setRoles]      = useState([]);   // catalog [{code,label}]
  const [roleCounts, setRoleCounts] = useState({});
  const [members,    setMembers]    = useState([]);   // picker [{id,name,email}]
  const [total,      setTotal]      = useState(0);
  const [page,       setPage]       = useState(1);
  const [limit,      setLimit]      = useState(25);
  const [q,          setQ]          = useState('');
  const [sort,       setSort]       = useState('member_id');
  const [dir,        setDir]        = useState('asc');
  const [selected,   setSelected]   = useState(() => new Set());
  const [loading,    setLoading]    = useState(false);
  const [busy,       setBusy]       = useState(false);
  const [msg,        setMsg]        = useState(null);
  const [showNew,    setShowNew]    = useState(false);
  const [confirm,    setConfirm]    = useState(null);

  const isMounted = useRef(true);

  const toast = useCallback((text, type = 'ok') => {
    setMsg({ text, type });
    setTimeout(() => { if (isMounted.current) setMsg(null); }, 3500);
  }, []);

  // Every filter/sort/page control funnels through here — the server owns
  // paging and sorting, so the grid stays correct past page 1.
  const load = useCallback(async (opts = {}) => {
    const p = { page, limit, sort, dir, q: q.trim() || undefined, ...opts };
    setLoading(true);
    try {
      const r = await api.get('/admin/roles-setup', { params: p });
      if (!isMounted.current) return;
      const body = r?.data ?? {};
      setRows(Array.isArray(body.data) ? body.data : []);
      if (Array.isArray(body.roles)) setRoles(body.roles);
      setRoleCounts(body.roleCounts ?? {});
      setTotal(body.total ?? 0);
      setSelected(new Set());
    } catch (e) {
      if (!isMounted.current) return;
      setRows([]); setRoleCounts({}); setTotal(0);
      toast(e?.response?.data?.error ?? 'Could not load role assignments', 'err');
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [page, limit, sort, dir, q, toast]);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  // Debounced search; immediate for every other dependency.
  useEffect(() => {
    const t = setTimeout(() => { load(); }, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const toggleSort = (key) => {
    if (sort === key) setDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(key); setDir('asc'); }
    setPage(1);
  };

  const openNew = async () => {
    setShowNew(true);
    try {
      const r = await api.get('/admin/roles-setup/members');
      if (isMounted.current) setMembers(Array.isArray(r?.data) ? r.data : []);
    } catch {
      if (isMounted.current) toast('Could not load members', 'err');
    }
  };

  const doAssign = async (userId, roleCode) => {
    setBusy(true);
    try {
      await api.post('/admin/roles-setup/assignments', { user_id: Number(userId), role_code: roleCode });
      toast(`Granted "${roleCode}"`);
      setShowNew(false);
      await load();
    } catch (e) {
      toast(e?.response?.data?.error ?? 'Could not grant role', 'err');
    } finally {
      if (isMounted.current) setBusy(false);
    }
  };

  const doDelete = async (ids) => {
    setBusy(true);
    const results = await Promise.allSettled(
      ids.map(id => api.delete(`/admin/roles-setup/assignments/${id}`))
    );
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length) {
      // Surface the server's reason (last-role guard, privilege guard) rather
      // than a generic failure — these are expected, actionable refusals.
      toast(failed[0].reason?.response?.data?.error ?? `${failed.length} removal(s) failed`, 'err');
    } else {
      toast(`Removed ${ids.length} assignment${ids.length !== 1 ? 's' : ''}`);
    }
    if (isMounted.current) { setBusy(false); await load(); }
  };

  const makePrimary = async (id) => {
    setBusy(true);
    try {
      await api.put(`/admin/roles-setup/assignments/${id}/primary`);
      toast('Primary role updated');
      await load();
    } catch (e) {
      toast(e?.response?.data?.error ?? 'Could not set primary role', 'err');
    } finally {
      if (isMounted.current) setBusy(false);
    }
  };

  const totalPages = Math.ceil(total / limit) || 1;
  const allChecked = rows.length > 0 && rows.every(r => selected.has(r.assignment_id));

  const toggleAll = () =>
    setSelected(allChecked ? new Set() : new Set(rows.map(r => r.assignment_id)));
  const toggleOne = (id) =>
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div className="pulse-page" style={{ padding: 24 }}>

      <ConfirmDialog
        open={!!confirm}
        variant="warning"
        title={confirm?.title}
        message={confirm?.message}
        confirmLabel={confirm?.confirmLabel ?? 'Confirm'}
        onConfirm={() => { const c = confirm; setConfirm(null); c?.onConfirm?.(); }}
        onCancel={() => setConfirm(null)}
      />

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 42, height: 42, borderRadius: 10, background: '#ede9fe', color: '#6B3FDB', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Shield size={20} />
          </div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#111827' }}>Roles Setup</h1>
            <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
              One row per role assignment — a member can hold several. All changes are audit-logged.
              {total > 0 && <span style={{ marginLeft: 8, fontWeight: 600, color: '#374151' }}>{total} assignments.</span>}
            </p>
          </div>
        </div>
      </div>

      {msg && (
        <div style={{ marginBottom: 16, padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: msg.type === 'ok' ? '#dcfce7' : '#fee2e2', color: msg.type === 'ok' ? '#16a34a' : '#dc2626' }}>
          {msg.text}
        </div>
      )}

      {/* Role summary chips — assignment counts across the whole company */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
        {roles.filter(({ code }) => roleCounts[code]).map(({ code, label }) => {
          const c = roleColor(code);
          return (
            <button key={code} title={`Filter by ${label || code}`}
              onClick={() => { setQ(code); setPage(1); }}
              style={{ padding: '7px 16px', borderRadius: 20, background: c.bg, color: c.color, fontWeight: 700, fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, border: 'none', cursor: 'pointer' }}>
              {(label || code).toUpperCase()}
              <span style={{ background: c.color, color: '#fff', borderRadius: 10, padding: '1px 7px', fontSize: 11 }}>{roleCounts[code]}</span>
            </button>
          );
        })}
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <button onClick={openNew} disabled={busy} className="pulse-btn-primary"
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, border: 'none', background: '#6B3FDB', color: '#fff', cursor: 'pointer' }}>
          <Plus size={14} /> New
        </button>

        <button
          disabled={!selected.size || busy}
          onClick={() => setConfirm({
            title: 'Remove role assignments?',
            message: `This revokes ${selected.size} role assignment${selected.size !== 1 ? 's' : ''}. Members keep any other roles they hold. A member's last remaining role cannot be removed.`,
            confirmLabel: 'Remove',
            onConfirm: () => doDelete([...selected]),
          })}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, border: '1px solid #e5e7eb', background: selected.size ? '#fee2e2' : '#f9fafb', color: selected.size ? '#dc2626' : '#d1d5db', cursor: selected.size ? 'pointer' : 'default' }}>
          <Trash2 size={14} /> Delete{selected.size ? ` (${selected.size})` : ''}
        </button>

        <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: 340 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input
            value={q}
            onChange={e => { setQ(e.target.value); setPage(1); }}
            placeholder="Search member, login or role…"
            style={{ width: '100%', padding: '8px 30px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none' }}
          />
          {q && (
            <button onClick={() => { setQ(''); setPage(1); }} aria-label="Clear search"
              style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'none', cursor: 'pointer', color: '#9ca3af', display: 'flex' }}>
              <X size={13} />
            </button>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#6b7280' }}>
          <span>Rows</span>
          <select value={limit} onChange={e => { setLimit(Number(e.target.value)); setPage(1); }}
            style={{ padding: '7px 8px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, background: '#fff' }}>
            {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>

        <button onClick={() => load()} disabled={loading}
          style={{ padding: '8px 14px', background: '#f5f3ff', color: '#6B3FDB', border: '1px solid #e9e4ff', borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Grid */}
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 48, color: '#9ca3af' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 48, color: '#9ca3af' }}>
            {q ? `No assignments match "${q}".` : 'No role assignments found.'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={{ padding: '10px 14px', borderBottom: '1px solid #e5e7eb', width: 36 }}>
                    <input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="Select all" />
                  </th>
                  {COLUMNS.map(c => (
                    <th key={c.key}
                      onClick={c.sortable ? () => toggleSort(c.key) : undefined}
                      style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb', fontSize: 12, cursor: c.sortable ? 'pointer' : 'default', userSelect: 'none', whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {c.label}
                        {c.sortable && sort === c.key && (
                          dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />
                        )}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const rc       = roleColor(String(r.role || '').toLowerCase());
                  const isActive = r.is_active !== false;
                  const isLast   = Number(r.role_count) <= 1;
                  return (
                    <tr key={r.assignment_id} style={{ borderBottom: '1px solid #f3f4f6', opacity: isActive ? 1 : 0.55 }}>
                      <td style={{ padding: '10px 14px' }}>
                        <input
                          type="checkbox"
                          checked={selected.has(r.assignment_id)}
                          onChange={() => toggleOne(r.assignment_id)}
                          aria-label={`Select ${r.login} ${r.role}`}
                        />
                      </td>

                      <td style={{ padding: '10px 14px', color: '#9ca3af', fontSize: 11 }}>#{r.member_id}</td>
                      <td style={{ padding: '10px 14px', color: '#374151' }}>{r.name ?? '—'}</td>
                      <td style={{ padding: '10px 14px', fontWeight: 600, color: '#111827' }}>{r.login ?? '—'}</td>

                      <td style={{ padding: '10px 14px' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          <span style={{ padding: '3px 10px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: rc.bg, color: rc.color }}>
                            {(r.role_label || r.role || '').toUpperCase()}
                          </span>
                          {r.is_primary && (
                            <span title="Primary role — drives users.role and legacy single-role checks"
                              style={{ display: 'inline-flex', color: '#d97706' }}>
                              <Star size={12} fill="#d97706" />
                            </span>
                          )}
                        </span>
                      </td>

                      <td style={{ padding: '10px 14px' }}>
                        <span style={{ padding: '2px 8px', borderRadius: 8, fontSize: 11, fontWeight: 600, background: isActive ? '#dcfce7' : '#f3f4f6', color: isActive ? '#16a34a' : '#9ca3af' }}>
                          {isActive ? 'Active' : 'Inactive'}
                        </span>
                      </td>

                      <td style={{ padding: '10px 14px' }}>
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          {!r.is_primary && (
                            <button onClick={() => makePrimary(r.assignment_id)} disabled={busy}
                              title="Make this the member's primary role"
                              style={{ padding: '4px 9px', background: '#fffbeb', color: '#d97706', border: '1px solid #fef3c7', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                              Set primary
                            </button>
                          )}
                          <button
                            disabled={busy || isLast}
                            title={isLast ? 'A member must keep at least one role' : 'Remove this role'}
                            onClick={() => setConfirm({
                              title: 'Remove role assignment?',
                              message: `Revoke "${r.role_label || r.role}" from ${r.login}. They keep their other roles.`,
                              confirmLabel: 'Remove',
                              onConfirm: () => doDelete([r.assignment_id]),
                            })}
                            style={{ padding: '4px 8px', background: isLast ? '#f9fafb' : '#fee2e2', color: isLast ? '#d1d5db' : '#dc2626', border: 'none', borderRadius: 6, cursor: isLast ? 'default' : 'pointer', display: 'flex', alignItems: 'center' }}>
                            <Trash2 size={12} />
                          </button>
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

      {/* Pagination */}
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 16 }}>
        <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1 || loading}
          style={{ padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 7, background: page <= 1 ? '#f9fafb' : '#fff', color: page <= 1 ? '#d1d5db' : '#374151', cursor: page <= 1 ? 'default' : 'pointer', display: 'flex', alignItems: 'center' }}>
          <ChevronLeft size={14} />
        </button>
        <span style={{ fontSize: 13, color: '#6b7280' }}>
          Page {page} of {totalPages} &nbsp;·&nbsp; {total} assignments
        </span>
        <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages || loading}
          style={{ padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 7, background: page >= totalPages ? '#f9fafb' : '#fff', color: page >= totalPages ? '#d1d5db' : '#374151', cursor: page >= totalPages ? 'default' : 'pointer', display: 'flex', alignItems: 'center' }}>
          <ChevronRight size={14} />
        </button>
      </div>

      {showNew && (
        <NewAssignmentDrawer
          members={members}
          roles={roles}
          busy={busy}
          onClose={() => setShowNew(false)}
          onSubmit={(userId, roleCode) => {
            if (PRIVILEGED.has(roleCode)) {
              setConfirm({
                title: 'Escalate privileges?',
                message: `This grants full ${roleCode === 'super_admin' ? 'super administrator' : 'administrator'} access. The change is audit-logged.`,
                confirmLabel: 'Yes, grant',
                onConfirm: () => doAssign(userId, roleCode),
              });
            } else {
              doAssign(userId, roleCode);
            }
          }}
        />
      )}
    </div>
  );
}

function NewAssignmentDrawer({ members, roles, busy, onClose, onSubmit }) {
  const [userId, setUserId]     = useState('');
  const [roleCode, setRoleCode] = useState('');

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 12, padding: 24, width: 420, maxWidth: '92vw', boxShadow: '0 20px 40px rgba(0,0,0,0.18)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0, color: '#111827' }}>New role assignment</h2>
          <button onClick={onClose} aria-label="Close"
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#9ca3af', display: 'flex' }}>
            <X size={16} />
          </button>
        </div>
        <p style={{ margin: '0 0 18px', fontSize: 12, color: '#6b7280' }}>
          Grants an additional role. Existing roles are kept.
        </p>

        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Member</label>
        <select value={userId} onChange={e => setUserId(e.target.value)}
          style={{ width: '100%', padding: '9px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, marginBottom: 16, background: '#fff' }}>
          <option value="">Select a member…</option>
          {members.map(m => (
            <option key={m.id} value={m.id}>{m.name ? `${m.name} — ${m.email}` : m.email}</option>
          ))}
        </select>

        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Role</label>
        <select value={roleCode} onChange={e => setRoleCode(e.target.value)}
          style={{ width: '100%', padding: '9px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, marginBottom: 22, background: '#fff' }}>
          <option value="">Select a role…</option>
          {roles.map(({ code, label }) => (
            <option key={code} value={code}>{label || code}</option>
          ))}
        </select>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose}
            style={{ padding: '8px 14px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            Cancel
          </button>
          <button
            disabled={!userId || !roleCode || busy}
            onClick={() => onSubmit(userId, roleCode)}
            style={{ padding: '8px 16px', background: (!userId || !roleCode || busy) ? '#c4b5fd' : '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: (!userId || !roleCode || busy) ? 'default' : 'pointer', fontSize: 13, fontWeight: 600 }}>
            {busy ? 'Granting…' : 'Grant role'}
          </button>
        </div>
      </div>
    </div>
  );
}
