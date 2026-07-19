import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  ShieldCheck, Eye, EyeOff, Pencil, RotateCcw, Search, Save,
  ChevronDown, ChevronRight, Layers, Info, Users, KeyRound, CornerDownRight,
} from 'lucide-react';
import api from '@/services/api/client';
import { getMenuSections, SELF_SERVICE_LOCK } from '@/config/menuCatalog';

/**
 * MenuPermissions — "Page Access" control center.
 *
 * Two modes:
 *   • By Role     — set Not Visible / View / Edit / Default per section for a role.
 *   • By Employee — override individual sections for one person, on top of their
 *                   role. "Inherit" falls back to the role setting.
 *
 * Resolution for a logged-in user: user override > role override > built-in default.
 */

const LEVELS = {
  hidden: { label: 'Not Visible', icon: EyeOff, color: '#dc2626', bg: '#fee2e2' },
  view:   { label: 'View',        icon: Eye,    color: '#0369a1', bg: '#e0f2fe' },
  edit:   { label: 'Edit',        icon: Pencil, color: '#16a34a', bg: '#dcfce7' },
};
const ORDER = ['hidden', 'view', 'edit'];

const ROLE_ACCENT = {
  admin: '#6B3FDB', manager: '#d97706', hr: '#0369a1',
  finance: '#16a34a', engineer: '#0891b2', employee: '#6b7280',
};

export default function MenuPermissions() {
  const [mode, setMode] = useState('role');          // 'role' | 'user'
  const [sections] = useState(() => getMenuSections());

  // Role mode
  const [roles, setRoles] = useState([]);
  const [activeRole, setActiveRole] = useState(null);

  // User mode
  const [users, setUsers] = useState([]);
  const [userQuery, setUserQuery] = useState('');
  const [activeUser, setActiveUser] = useState(null);   // { id, name, email, role }
  const [roleBaseline, setRoleBaseline] = useState({}); // role overrides for the selected user's role

  // Shared editing state
  const [draft, setDraft] = useState({});   // { [section]: 'hidden'|'view'|'edit'|'default' }
  const [saved, setSaved] = useState({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState({});
  const [msg, setMsg] = useState(null);

  const isMounted = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const toast = useCallback((text, type = 'ok') => {
    setMsg({ text, type });
    setTimeout(() => { if (isMounted.current) setMsg(null); }, 3200);
  }, []);

  // ── Load roles + users once ───────────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    api.get('/admin/menu-roles').then(r => {
      if (!active) return;
      const list = Array.isArray(r.data) ? r.data : [];
      setRoles(list);
      setActiveRole(prev => prev ?? list.find(x => x.code === 'employee')?.code ?? list[0]?.code ?? null);
    }).catch(() => { if (active) setRoles([]); });

    api.get('/admin/users').then(r => {
      if (active) setUsers(Array.isArray(r.data) ? r.data : []);
    }).catch(() => { if (active) setUsers([]); });

    return () => { active = false; };
  }, []);

  const blankDraft = useCallback(() => {
    const d = {}; for (const s of sections) d[s.name] = 'default'; return d;
  }, [sections]);

  // ── Role mode: load a role's overrides ────────────────────────────────────────
  const loadRole = useCallback(async (role) => {
    if (!role) return;
    setLoading(true);
    try {
      const { data } = await api.get('/admin/menu-permissions', { params: { role } });
      if (!isMounted.current) return;
      const ov = data?.overrides ?? {};
      const next = {}; for (const s of sections) next[s.name] = ov[s.name] ?? 'default';
      setDraft(next); setSaved(next); setRoleBaseline({});
    } catch { if (isMounted.current) { setDraft(blankDraft()); setSaved(blankDraft()); } }
    finally { if (isMounted.current) setLoading(false); }
  }, [sections, blankDraft]);

  // ── User mode: load one user's overrides + role baseline ──────────────────────
  const loadUser = useCallback(async (userId) => {
    if (!userId) return;
    setLoading(true);
    try {
      const { data } = await api.get('/admin/user-menu-permissions', { params: { user_id: userId } });
      if (!isMounted.current) return;
      const userOv = data?.userOverrides ?? {};
      const next = {}; for (const s of sections) next[s.name] = userOv[s.name] ?? 'default';
      setDraft(next); setSaved(next);
      setRoleBaseline(data?.roleOverrides ?? {});
    } catch { if (isMounted.current) { setDraft(blankDraft()); setSaved(blankDraft()); setRoleBaseline({}); } }
    finally { if (isMounted.current) setLoading(false); }
  }, [sections, blankDraft]);

  useEffect(() => { if (mode === 'role' && activeRole) loadRole(activeRole); }, [mode, activeRole, loadRole]);
  useEffect(() => { if (mode === 'user' && activeUser?.id) loadUser(activeUser.id); }, [mode, activeUser, loadUser]);

  // ── Derived ───────────────────────────────────────────────────────────────────
  const guardRole = mode === 'role' ? activeRole : String(activeUser?.role || '').toLowerCase();
  const isSuperAdminTarget = guardRole === 'super_admin';

  const dirty = useMemo(
    () => sections.some(s => (draft[s.name] ?? 'default') !== (saved[s.name] ?? 'default')),
    [draft, saved, sections]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections.filter(s =>
      s.name.toLowerCase().includes(q) || s.pages.some(p => p.label.toLowerCase().includes(q)));
  }, [sections, query]);

  const counts = useMemo(() => {
    const c = { hidden: 0, view: 0, edit: 0, default: 0 };
    for (const s of sections) c[draft[s.name] ?? 'default']++;
    return c;
  }, [draft, sections]);

  const filteredUsers = useMemo(() => {
    const q = userQuery.trim().toLowerCase();
    const base = users.filter(u => u.role !== 'super_admin');
    if (!q) return base.slice(0, 60);
    return base.filter(u =>
      (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q)
    ).slice(0, 60);
  }, [users, userQuery]);

  const isLocked = useCallback(
    (name) => guardRole === 'admin' && SELF_SERVICE_LOCK.has(name),
    [guardRole]
  );

  // What a section resolves to when set to Default/Inherit.
  const resolvedBaseline = useCallback((name) => {
    if (mode === 'role') return null;         // role default = built-in, not shown
    return roleBaseline[name] ?? null;        // user inherits the role setting
  }, [mode, roleBaseline]);

  // ── Mutations ─────────────────────────────────────────────────────────────────
  const setLevel = (name, level) => {
    if (isLocked(name) && level === 'hidden') return;
    setDraft(d => ({ ...d, [name]: level }));
  };
  const bulk = (level) => setDraft(() => {
    const next = {};
    for (const s of sections) next[s.name] = isLocked(s.name) && level === 'hidden' ? 'view' : level;
    return next;
  });

  const save = async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      const permissions = sections.map(s => ({ module_id: s.name, access_level: draft[s.name] ?? 'default' }));
      let ov;
      if (mode === 'role') {
        const { data } = await api.put('/admin/menu-permissions', { role: activeRole, permissions });
        ov = data?.overrides ?? {};
        toast(`Page access saved for role "${roleLabel(activeRole)}".`);
      } else {
        const { data } = await api.put('/admin/user-menu-permissions', { user_id: activeUser.id, permissions });
        ov = data?.userOverrides ?? {};
        toast(`Page access saved for ${activeUser.name}.`);
      }
      if (!isMounted.current) return;
      const next = {}; for (const s of sections) next[s.name] = ov[s.name] ?? 'default';
      setDraft(next); setSaved(next);
    } catch (e) {
      toast(e?.response?.data?.error ?? 'Save failed', 'err');
    } finally { if (isMounted.current) setSaving(false); }
  };

  const roleLabel = (code) => roles.find(r => r.code === code)?.label ?? code;
  const accent = mode === 'role'
    ? (ROLE_ACCENT[activeRole] ?? '#6B3FDB')
    : (ROLE_ACCENT[String(activeUser?.role || '').toLowerCase()] ?? '#6B3FDB');
  const resetLabel = mode === 'role' ? 'Default' : 'Inherit';
  const hasTarget = mode === 'role' ? !!activeRole : !!activeUser;

  return (
    <div style={{ padding: 24, fontFamily: 'Inter, sans-serif' }}>

      {msg && (
        <div style={{
          position: 'fixed', top: 18, right: 18, zIndex: 50, padding: '11px 18px', borderRadius: 10,
          fontSize: 13, fontWeight: 600, boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
          background: msg.type === 'ok' ? '#dcfce7' : '#fee2e2', color: msg.type === 'ok' ? '#15803d' : '#dc2626',
        }}>{msg.text}</div>
      )}

      {/* Intro + mode toggle */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 42, height: 42, borderRadius: 11, background: '#ede9fe', color: '#6B3FDB', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ShieldCheck size={21} />
          </div>
          <div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#111827' }}>Page Access</h2>
            <p style={{ margin: '2px 0 0', fontSize: 13, color: '#6b7280' }}>
              Control which sections each role — or a specific employee — can see and edit.
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', background: '#f3f4f6', borderRadius: 10, padding: 3 }}>
          {[['role', 'By Role', KeyRound], ['user', 'By Employee', Users]].map(([id, label, Icon]) => {
            const on = mode === id;
            return (
              <button key={id} onClick={() => setMode(id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', border: 'none', borderRadius: 8,
                  background: on ? '#fff' : 'transparent', color: on ? '#6B3FDB' : '#6b7280',
                  fontWeight: 700, fontSize: 13, cursor: 'pointer', boxShadow: on ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                }}>
                <Icon size={14} /> {label}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>

        {/* ── Left rail ─────────────────────────────────────────────── */}
        <div style={{ width: 230, flexShrink: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#9ca3af', margin: '4px 4px 10px' }}>
            {mode === 'role' ? 'Roles' : 'Employees'}
          </div>

          {mode === 'role' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {roles.map(r => {
                const on = r.code === activeRole; const a = ROLE_ACCENT[r.code] ?? '#6b7280';
                return (
                  <button key={r.code} onClick={() => setActiveRole(r.code)}
                    style={{
                      textAlign: 'left', padding: '11px 14px', borderRadius: 10, cursor: 'pointer',
                      border: on ? `1.5px solid ${a}` : '1px solid #eceef2', background: on ? `${a}0d` : '#fff',
                      display: 'flex', flexDirection: 'column', gap: 2,
                    }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 700, color: on ? a : '#374151' }}>
                      <span style={{ width: 8, height: 8, borderRadius: 4, background: a }} /> {r.label}
                    </span>
                    <span style={{ fontSize: 11, color: '#9ca3af', paddingLeft: 16 }}>{r.description}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div>
              <div style={{ position: 'relative', marginBottom: 8 }}>
                <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
                <input value={userQuery} onChange={e => setUserQuery(e.target.value)} placeholder="Search employees…"
                  style={{ width: '100%', padding: '8px 10px 8px 30px', border: '1px solid #e5e7eb', borderRadius: 9, fontSize: 12.5, outline: 'none', boxSizing: 'border-box' }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 460, overflowY: 'auto' }}>
                {filteredUsers.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#9ca3af', padding: 10 }}>No employees found.</div>
                ) : filteredUsers.map(u => {
                  const on = activeUser?.id === u.id; const a = ROLE_ACCENT[String(u.role || '').toLowerCase()] ?? '#6b7280';
                  return (
                    <button key={u.id} onClick={() => setActiveUser(u)}
                      style={{
                        textAlign: 'left', padding: '9px 12px', borderRadius: 9, cursor: 'pointer',
                        border: on ? `1.5px solid ${a}` : '1px solid #eceef2', background: on ? `${a}0d` : '#fff',
                      }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: on ? a : '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.name || u.email}</div>
                      <div style={{ fontSize: 10.5, color: '#9ca3af', display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span style={{ textTransform: 'uppercase', fontWeight: 700, color: a }}>{(u.role || 'employee').replace('_', ' ')}</span>
                        · {u.department || '—'}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* ── Matrix ──────────────────────────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 480 }}>
          {!hasTarget ? (
            <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af', fontSize: 14, background: '#fff', border: '1px dashed #e5e7eb', borderRadius: 12 }}>
              {mode === 'role' ? 'Select a role to configure.' : 'Select an employee to configure their page access.'}
            </div>
          ) : isSuperAdminTarget ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#6b7280', fontSize: 14, background: '#fff', border: '1px solid #eef0f3', borderRadius: 12 }}>
              Super Admin always has full access and cannot be restricted.
            </div>
          ) : (
            <>
              {/* Employee context banner */}
              {mode === 'user' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, padding: '10px 14px', background: '#faf5ff', border: '1px solid #ede9fe', borderRadius: 10, fontSize: 13, color: '#5b21b6' }}>
                  <Info size={15} />
                  <span>Overrides for <b>{activeUser.name}</b>. Sections left on <b>Inherit</b> follow the <b>{String(activeUser.role || 'employee').replace('_', ' ')}</b> role settings.</span>
                </div>
              )}

              {/* Toolbar */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
                <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
                  <Search size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
                  <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search sections or pages…"
                    style={{ width: '100%', padding: '9px 12px 9px 34px', border: '1px solid #e5e7eb', borderRadius: 9, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <BulkBtn onClick={() => bulk('edit')} label="All Edit" color="#16a34a" />
                  <BulkBtn onClick={() => bulk('view')} label="All View" color="#0369a1" />
                  <BulkBtn onClick={() => bulk('hidden')} label="Hide All" color="#dc2626" />
                  <BulkBtn onClick={() => bulk('default')} label={mode === 'role' ? 'Reset' : 'Inherit All'} color="#6b7280" />
                </div>
              </div>

              {/* Summary chips */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
                <Chip color="#16a34a" bg="#dcfce7" label="Edit" n={counts.edit} />
                <Chip color="#0369a1" bg="#e0f2fe" label="View" n={counts.view} />
                <Chip color="#dc2626" bg="#fee2e2" label="Not Visible" n={counts.hidden} />
                <Chip color="#6b7280" bg="#f3f4f6" label={resetLabel} n={counts.default} />
              </div>

              {/* Rows */}
              <div style={{ background: '#fff', border: '1px solid #eef0f3', borderRadius: 12, overflow: 'hidden' }}>
                {loading ? (
                  <div style={{ padding: 48, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Loading…</div>
                ) : filtered.length === 0 ? (
                  <div style={{ padding: 48, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No sections match.</div>
                ) : filtered.map((s, i) => {
                  const level = draft[s.name] ?? 'default';
                  const isOpen = !!expanded[s.name];
                  const locked = isLocked(s.name);
                  const baseline = resolvedBaseline(s.name); // for user inherit hint
                  return (
                    <div key={s.name} style={{ borderTop: i === 0 ? 'none' : '1px solid #f3f4f6' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px' }}>
                        <button onClick={() => setExpanded(e => ({ ...e, [s.name]: !e[s.name] }))}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', display: 'flex', alignItems: 'center', padding: 0 }}>
                          {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                        </button>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600, color: '#111827' }}>
                            <Layers size={14} style={{ color: '#c4b5fd' }} /> {s.name}
                            {locked && (
                              <span title="Kept visible so Admins keep access to this screen"
                                style={{ fontSize: 10, fontWeight: 700, color: '#92400e', background: '#fef3c7', padding: '1px 6px', borderRadius: 6 }}>LOCKED</span>
                            )}
                          </div>
                          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1, display: 'flex', alignItems: 'center', gap: 5 }}>
                            {s.pages.length} page{s.pages.length === 1 ? '' : 's'}
                            {mode === 'user' && level === 'default' && (
                              <span style={{ color: '#6B3FDB', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                <CornerDownRight size={11} /> inherits role: <b>{LEVELS[baseline]?.label ?? 'Default'}</b>
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Segmented control */}
                        <div style={{ display: 'flex', border: '1px solid #e5e7eb', borderRadius: 9, overflow: 'hidden' }}>
                          {ORDER.map(lv => {
                            const meta = LEVELS[lv]; const on = level === lv;
                            const disabled = locked && lv === 'hidden'; const Icon = meta.icon;
                            return (
                              <button key={lv} onClick={() => setLevel(s.name, lv)} disabled={disabled}
                                title={disabled ? 'Cannot hide — protects Admin access to this screen' : meta.label}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: 5, padding: '7px 12px', border: 'none',
                                  borderRight: lv !== 'edit' ? '1px solid #eef0f3' : 'none',
                                  background: on ? meta.bg : '#fff', color: on ? meta.color : disabled ? '#d1d5db' : '#6b7280',
                                  fontWeight: on ? 700 : 500, fontSize: 12, cursor: disabled ? 'not-allowed' : 'pointer',
                                }}>
                                <Icon size={13} /> {meta.label}
                              </button>
                            );
                          })}
                        </div>

                        {/* Default / Inherit */}
                        <button onClick={() => setLevel(s.name, 'default')}
                          title={mode === 'role' ? 'Use built-in role defaults' : 'Inherit from role'}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 5, padding: '7px 10px', borderRadius: 8,
                            border: level === 'default' ? '1px solid #d1d5db' : '1px solid #eef0f3',
                            background: level === 'default' ? '#f3f4f6' : '#fff',
                            color: level === 'default' ? '#374151' : '#9ca3af',
                            fontWeight: level === 'default' ? 700 : 500, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
                          }}>
                          <RotateCcw size={12} /> {resetLabel}
                        </button>
                      </div>

                      {isOpen && (
                        <div style={{ padding: '2px 16px 14px 44px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {s.pages.map(p => (
                            <span key={p.page + p.label} style={{ fontSize: 11, color: '#6b7280', background: '#f9fafb', border: '1px solid #f0f1f4', borderRadius: 6, padding: '3px 8px' }}>{p.label}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Footer */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginTop: 16, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12, color: '#9ca3af', maxWidth: 520 }}>
                  <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>
                    <b>Not Visible</b> removes the section from the sidebar and blocks its pages.{' '}
                    {mode === 'role' ? <><b>Default</b> keeps the built-in rules for that role.</> : <><b>Inherit</b> follows the role setting.</>}{' '}
                    Applies after the user's next permission refresh (focus / re-login).
                  </span>
                </div>
                <button onClick={save} disabled={!dirty || saving}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '11px 22px', borderRadius: 10, border: 'none',
                    background: !dirty || saving ? '#e5e7eb' : accent, color: !dirty || saving ? '#9ca3af' : '#fff',
                    fontWeight: 700, fontSize: 14, cursor: !dirty || saving ? 'default' : 'pointer',
                    boxShadow: !dirty || saving ? 'none' : '0 4px 14px rgba(107,63,219,0.25)',
                  }}>
                  <Save size={16} />
                  {saving ? 'Saving…' : !dirty ? 'All saved'
                    : mode === 'role' ? `Save role "${roleLabel(activeRole)}"` : `Save for ${activeUser.name}`}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function BulkBtn({ onClick, label, color }) {
  return (
    <button onClick={onClick}
      style={{ padding: '8px 12px', border: `1px solid ${color}22`, background: `${color}0d`, color, borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
      {label}
    </button>
  );
}

function Chip({ color, bg, label, n }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 18, background: bg, color, fontSize: 12, fontWeight: 700 }}>
      {label}<span style={{ background: color, color: '#fff', borderRadius: 9, padding: '0 7px', fontSize: 11 }}>{n}</span>
    </div>
  );
}
