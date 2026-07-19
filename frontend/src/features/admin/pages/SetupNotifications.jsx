import { useState, useEffect, useRef, useCallback } from 'react';
import { Bell, Mail, MessageCircle, Plus, Edit2, Trash2, X, Check,
         RefreshCw, ToggleLeft, ToggleRight, ChevronDown, ChevronRight, Lock } from 'lucide-react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

// ── Constants ────────────────────────────────────────────────────────────────

const CHANNEL_OPTIONS = ['in_app', 'email', 'whatsapp'];
const ROLE_OPTIONS    = ['employee', 'manager', 'hr', 'finance', 'admin', 'super_admin',
                         'approver', 'service_desk', 'self'];

const MODULE_GROUPS = [
  { key: 'hr',         label: 'HR',            prefixes: ['leave', 'attendance', 'recruitment'] },
  { key: 'approvals',  label: 'Approvals',      prefixes: ['approval'] },
  { key: 'finance',    label: 'Finance',        prefixes: ['invoice', 'expense'] },
  { key: 'crm',        label: 'CRM / Sales',    prefixes: ['crm', 'sales'] },
  { key: 'servicedesk',label: 'Service Desk',   prefixes: ['ticket'] },
  { key: 'system',     label: 'System',         prefixes: ['user', 'security'] },
  { key: 'other',      label: 'Other',          prefixes: [] },
];

const EMPTY_FORM = { event_key: '', title: '', channel: 'in_app', recipient_roles: ['employee'], enabled: true };

// ── Helpers ──────────────────────────────────────────────────────────────────

function groupRules(rules) {
  const groups = MODULE_GROUPS.map(g => ({ ...g, rules: [] }));
  for (const rule of rules) {
    const prefix = rule.event_key.split('.')[0];
    const group = groups.find(g => g.prefixes.includes(prefix)) ?? groups.find(g => g.key === 'other');
    group.rules.push(rule);
  }
  return groups.filter(g => g.rules.length > 0);
}

function parseChannels(channel) {
  if (!channel) return [];
  return String(channel).split(',').map(s => s.trim()).filter(Boolean);
}

function channelString(arr) {
  return Array.isArray(arr) ? arr.join(',') : String(arr ?? 'in_app');
}

// ── Sub-components ───────────────────────────────────────────────────────────

function ChannelBadges({ channel }) {
  const channels = parseChannels(channel);
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {channels.includes('in_app') && (
        <span title="In-App" style={badgeStyle('#eff6ff', '#2563eb')}>
          <Bell size={11} /> In-App
        </span>
      )}
      {channels.includes('email') && (
        <span title="Email" style={badgeStyle('#f0fdf4', '#16a34a')}>
          <Mail size={11} /> Email
        </span>
      )}
      {channels.includes('whatsapp') && (
        <span title="WhatsApp" style={badgeStyle('#f0fdf4', '#15803d')}>
          <MessageCircle size={11} /> WhatsApp
        </span>
      )}
    </div>
  );
}

function badgeStyle(bg, color) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 3,
    background: bg, color, padding: '2px 7px', borderRadius: 8, fontSize: 11, fontWeight: 600,
  };
}

function ChannelCheckboxes({ value, onChange }) {
  const channels = parseChannels(value);
  const toggle = (ch) => {
    const next = channels.includes(ch) ? channels.filter(c => c !== ch) : [...channels, ch];
    onChange(channelString(next));
  };
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      {CHANNEL_OPTIONS.map(ch => (
        <label key={ch} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 12 }}>
          <input type="checkbox" checked={channels.includes(ch)} onChange={() => toggle(ch)} />
          {ch === 'in_app' ? 'In-App' : ch.charAt(0).toUpperCase() + ch.slice(1)}
        </label>
      ))}
    </div>
  );
}

function RoleSelect({ value, onChange }) {
  const roles = Array.isArray(value) ? value : [];
  const toggle = (r) => onChange(roles.includes(r) ? roles.filter(x => x !== r) : [...roles, r]);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {ROLE_OPTIONS.map(r => (
        <label key={r} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 12 }}>
          <input type="checkbox" checked={roles.includes(r)} onChange={() => toggle(r)} />
          {r}
        </label>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SetupNotifications() {
  const [rows,         setRows]         = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [saving,       setSaving]       = useState(false);
  const [showCreate,   setShowCreate]   = useState(false);
  const [editId,       setEditId]       = useState(null);
  const [editData,     setEditData]     = useState(null);
  const [form,         setForm]         = useState(EMPTY_FORM);
  const [msg,          setMsg]          = useState(null);
  const [filter,       setFilter]       = useState('');
  const [collapsed,    setCollapsed]    = useState({});
  const [pendingRemove,setPendingRemove]= useState(null);
  const isMounted = useRef(true);

  const toast = useCallback((text, type = 'ok') => {
    setMsg({ text, type });
    setTimeout(() => { if (isMounted.current) setMsg(null); }, 3500);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/admin/notification-rules');
      if (isMounted.current) setRows(Array.isArray(r.data) ? r.data : []);
    } catch { if (isMounted.current) setRows([]); }
    finally  { if (isMounted.current) setLoading(false); }
  }, []);

  useEffect(() => {
    isMounted.current = true;
    load();
    return () => { isMounted.current = false; };
  }, [load]);

  // ── CRUD ──────────────────────────────────────────────────────────────────

  const create = async () => {
    if (!form.event_key.trim()) return toast('Event key is required', 'err');
    if (!form.title.trim())     return toast('Title is required', 'err');
    setSaving(true);
    try {
      await api.post('/admin/notification-rules', {
        ...form,
        recipient_roles: form.recipient_roles,
      });
      toast('Notification rule created');
      setShowCreate(false);
      setForm(EMPTY_FORM);
      load();
    } catch (e) { toast(e.response?.data?.error || e.message, 'err'); }
    finally { setSaving(false); }
  };

  const saveEdit = async () => {
    if (!editData.title.trim()) return toast('Title is required', 'err');
    setSaving(true);
    try {
      await api.put(`/admin/notification-rules/${editId}`, editData);
      toast('Notification rule updated');
      setEditId(null);
      setEditData(null);
      load();
    } catch (e) { toast(e.response?.data?.error || e.message, 'err'); }
    finally { setSaving(false); }
  };

  const toggleEnabled = async (row) => {
    try {
      const r = await api.patch(`/admin/notification-rules/${row.id}/toggle`);
      setRows(prev => prev.map(x => x.id === row.id ? { ...x, enabled: r.data.enabled } : x));
      toast(`Rule ${r.data.enabled ? 'enabled' : 'disabled'}`);
    } catch (e) { toast(e.response?.data?.error || e.message, 'err'); }
  };

  const remove = async () => {
    if (!pendingRemove) return;
    const row = pendingRemove;
    setPendingRemove(null);
    try {
      await api.delete(`/admin/notification-rules/${row.id}`);
      toast('Notification rule deleted');
      load();
    } catch (e) { toast(e.response?.data?.error || e.message, 'err'); }
  };

  // ── Derived state ─────────────────────────────────────────────────────────

  const filtered = filter
    ? rows.filter(r => [r.event_key, r.title].some(v => v?.toLowerCase().includes(filter.toLowerCase())))
    : rows;

  const groups    = groupRules(filtered);
  const activeCount = rows.filter(r => r.enabled).length;

  const toggleSection = (key) => setCollapsed(prev => ({ ...prev, [key]: !prev[key] }));

  // ── Styles ────────────────────────────────────────────────────────────────

  const inp = {
    padding: '7px 11px', border: '1px solid #e5e7eb', borderRadius: 7,
    fontSize: 13, outline: 'none', background: '#fff',
  };
  const editInp = { ...inp, border: '1px solid var(--color-primary, #6366f1)', minWidth: 110 };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: 24 }}>
      <ConfirmDialog
        open={!!pendingRemove}
        title="Delete Notification Rule"
        message={pendingRemove ? `Permanently delete rule "${pendingRemove.title}"? This cannot be undone.` : ''}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={remove}
        onCancel={() => setPendingRemove(null)}
      />

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 42, height: 42, borderRadius: 10,
            background: 'color-mix(in srgb, var(--color-primary, #6366f1) 12%, #fff)',
            color: 'var(--color-primary, #6366f1)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Bell size={20} />
          </div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#111827' }}>Notification Rules</h1>
            <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
              Configure event-driven notifications across modules and channels.
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter rules…"
            style={{ ...inp, width: 160 }}
          />
          <button
            onClick={load}
            style={{
              padding: '8px 14px', fontSize: 13, borderRadius: 8, cursor: 'pointer',
              background: 'color-mix(in srgb, var(--color-primary, #6366f1) 10%, #fff)',
              color: 'var(--color-primary, #6366f1)',
              border: '1px solid color-mix(in srgb, var(--color-primary, #6366f1) 30%, #fff)',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <RefreshCw size={14} /> Refresh
          </button>
          <button
            onClick={() => { setShowCreate(true); setForm(EMPTY_FORM); }}
            style={{
              padding: '8px 16px', fontSize: 13, fontWeight: 600, borderRadius: 8, cursor: 'pointer',
              background: 'var(--color-primary, #6366f1)', color: '#fff', border: 'none',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <Plus size={14} /> Add Rule
          </button>
        </div>
      </div>

      {/* Toast */}
      {msg && (
        <div style={{
          marginBottom: 16, padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
          background: msg.type === 'ok' ? '#dcfce7' : '#fee2e2',
          color: msg.type === 'ok' ? '#16a34a' : '#dc2626',
        }}>
          {msg.text}
        </div>
      )}

      {/* Create panel */}
      {showCreate && (
        <div style={{
          marginBottom: 20, padding: 20,
          border: '1px solid color-mix(in srgb, var(--color-primary, #6366f1) 30%, #fff)',
          borderRadius: 12,
          background: 'color-mix(in srgb, var(--color-primary, #6366f1) 6%, #fff)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <h3 style={{ margin: 0, color: 'var(--color-primary, #6366f1)', fontSize: 15, fontWeight: 700 }}>
              New Notification Rule
            </h3>
            <button onClick={() => setShowCreate(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}>
              <X size={17} />
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12, marginBottom: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Event Key *</span>
              <input
                value={form.event_key}
                onChange={e => setForm(f => ({ ...f, event_key: e.target.value }))}
                placeholder="e.g. leave.approved"
                style={inp}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Title *</span>
              <input
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Leave Request Approved"
                style={inp}
              />
            </label>
          </div>
          <div style={{ marginBottom: 12 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Channels *</span>
            <ChannelCheckboxes value={form.channel} onChange={ch => setForm(f => ({ ...f, channel: ch }))} />
          </div>
          <div style={{ marginBottom: 14 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Recipients</span>
            <RoleSelect value={form.recipient_roles} onChange={r => setForm(f => ({ ...f, recipient_roles: r }))} />
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              onClick={() => setShowCreate(false)}
              style={{ padding: '7px 16px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 13 }}
            >
              Cancel
            </button>
            <button
              onClick={create}
              disabled={saving}
              style={{
                padding: '7px 16px', background: 'var(--color-primary, #6366f1)',
                color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer',
                fontWeight: 600, fontSize: 13, opacity: saving ? 0.7 : 1,
              }}
            >
              {saving ? 'Saving…' : 'Create Rule'}
            </button>
          </div>
        </div>
      )}

      {/* Stats */}
      {!loading && rows.length > 0 && (
        <div style={{ marginBottom: 12, fontSize: 12, color: '#6b7280' }}>
          {rows.length} rule{rows.length !== 1 ? 's' : ''} · {activeCount} active · {rows.length - activeCount} disabled
          {filter && ` · showing ${filtered.length} match${filtered.length !== 1 ? 'es' : ''}`}
        </div>
      )}

      {/* Grouped table */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 48, color: '#9ca3af' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 48, color: '#9ca3af' }}>
          No notification rules. Click "Add Rule" to create one.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {groups.map(group => (
            <div key={group.key} style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
              {/* Group header */}
              <button
                onClick={() => toggleSection(group.key)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '10px 16px', background: '#f9fafb', border: 'none', cursor: 'pointer',
                  borderBottom: collapsed[group.key] ? 'none' : '1px solid #e5e7eb',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 13, color: '#111827' }}>{group.label}</span>
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: '1px 7px', borderRadius: 8,
                    background: 'color-mix(in srgb, var(--color-primary, #6366f1) 12%, #fff)',
                    color: 'var(--color-primary, #6366f1)',
                  }}>
                    {group.rules.length}
                  </span>
                </div>
                {collapsed[group.key] ? <ChevronRight size={15} color="#6b7280" /> : <ChevronDown size={15} color="#6b7280" />}
              </button>

              {/* Group rows */}
              {!collapsed[group.key] && (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#f9fafb' }}>
                        {['Event Key', 'Title', 'Channels', 'Recipients', 'Enabled', 'Actions'].map(h => (
                          <th key={h} style={{
                            padding: '8px 14px', textAlign: 'left', fontWeight: 600,
                            color: '#6b7280', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap', fontSize: 11,
                          }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {group.rules.map(row => {
                        const isEditing = editId === row.id;
                        return (
                          <tr
                            key={row.id}
                            style={{
                              borderBottom: '1px solid #f3f4f6',
                              opacity: row.enabled ? 1 : 0.55,
                              background: isEditing
                                ? 'color-mix(in srgb, var(--color-primary, #6366f1) 4%, #fff)'
                                : '#fff',
                            }}
                          >
                            {/* Event Key */}
                            <td style={{ padding: '10px 14px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                {row.is_system_default && (
                                  <Lock size={11} color="#9ca3af" title="System default — event key locked" />
                                )}
                                {isEditing && !row.is_system_default ? (
                                  <input
                                    value={editData.event_key}
                                    onChange={e => setEditData(d => ({ ...d, event_key: e.target.value }))}
                                    style={{ ...editInp, minWidth: 140 }}
                                  />
                                ) : (
                                  <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#374151' }}>
                                    {row.event_key}
                                  </span>
                                )}
                              </div>
                            </td>

                            {/* Title */}
                            <td style={{ padding: '10px 14px', fontWeight: 500, color: '#111827' }}>
                              {isEditing && !row.is_system_default ? (
                                <input
                                  value={editData.title}
                                  onChange={e => setEditData(d => ({ ...d, title: e.target.value }))}
                                  style={{ ...editInp, minWidth: 180 }}
                                />
                              ) : (
                                row.title
                              )}
                            </td>

                            {/* Channels */}
                            <td style={{ padding: '10px 14px' }}>
                              {isEditing ? (
                                <ChannelCheckboxes
                                  value={editData.channel}
                                  onChange={ch => setEditData(d => ({ ...d, channel: ch }))}
                                />
                              ) : (
                                <ChannelBadges channel={row.channel} />
                              )}
                            </td>

                            {/* Recipients */}
                            <td style={{ padding: '10px 14px', color: '#6b7280', fontSize: 12 }}>
                              {isEditing ? (
                                <RoleSelect
                                  value={editData.recipient_roles}
                                  onChange={r => setEditData(d => ({ ...d, recipient_roles: r }))}
                                />
                              ) : (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                                  {(row.recipient_roles ?? []).map(r => (
                                    <span key={r} style={{
                                      background: '#f3f4f6', color: '#374151',
                                      padding: '1px 6px', borderRadius: 6, fontSize: 11, fontWeight: 500,
                                    }}>{r}</span>
                                  ))}
                                </div>
                              )}
                            </td>

                            {/* Enabled toggle */}
                            <td style={{ padding: '10px 14px' }}>
                              {isEditing ? (
                                <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 12 }}>
                                  <input
                                    type="checkbox"
                                    checked={editData.enabled}
                                    onChange={e => setEditData(d => ({ ...d, enabled: e.target.checked }))}
                                  />
                                  Active
                                </label>
                              ) : (
                                <button
                                  onClick={() => toggleEnabled(row)}
                                  title={row.enabled ? 'Click to disable' : 'Click to enable'}
                                  style={{
                                    background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                                    display: 'flex', alignItems: 'center', gap: 4, fontSize: 12,
                                    color: row.enabled ? '#16a34a' : '#9ca3af',
                                  }}
                                >
                                  {row.enabled
                                    ? <ToggleRight size={20} color="#16a34a" />
                                    : <ToggleLeft  size={20} color="#9ca3af" />}
                                  {row.enabled ? 'On' : 'Off'}
                                </button>
                              )}
                            </td>

                            {/* Actions */}
                            <td style={{ padding: '10px 14px' }}>
                              <div style={{ display: 'flex', gap: 6 }}>
                                {isEditing ? (
                                  <>
                                    <button
                                      onClick={saveEdit}
                                      disabled={saving}
                                      style={{
                                        padding: '5px 10px', background: '#dcfce7', color: '#16a34a',
                                        border: 'none', borderRadius: 6, cursor: 'pointer',
                                        display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600,
                                      }}
                                    >
                                      <Check size={12} /> Save
                                    </button>
                                    <button
                                      onClick={() => { setEditId(null); setEditData(null); }}
                                      style={{ padding: '5px 8px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 6, cursor: 'pointer' }}
                                    >
                                      <X size={12} />
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    <button
                                      onClick={() => { setEditId(row.id); setEditData({ ...row }); }}
                                      title="Edit"
                                      style={{
                                        padding: '5px 8px', border: 'none', borderRadius: 6, cursor: 'pointer',
                                        background: 'color-mix(in srgb, var(--color-primary, #6366f1) 10%, #fff)',
                                        color: 'var(--color-primary, #6366f1)',
                                      }}
                                    >
                                      <Edit2 size={13} />
                                    </button>
                                    {row.is_system_default ? (
                                      <span title="System defaults cannot be deleted" style={{
                                        padding: '5px 8px', background: '#f3f4f6', color: '#d1d5db',
                                        borderRadius: 6, display: 'flex', alignItems: 'center',
                                      }}>
                                        <Lock size={13} />
                                      </span>
                                    ) : (
                                      <button
                                        onClick={() => setPendingRemove(row)}
                                        title="Delete"
                                        style={{ padding: '5px 8px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 6, cursor: 'pointer' }}
                                      >
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
          ))}
        </div>
      )}
    </div>
  );
}
