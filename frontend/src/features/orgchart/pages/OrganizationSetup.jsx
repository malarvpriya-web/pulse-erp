import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import api from '@/services/api/client';

const ROLE_OPTIONS = ['head', 'member'];

const th = {
  padding: '10px 14px', textAlign: 'left', fontWeight: 600,
  color: '#374151', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap',
  cursor: 'pointer', userSelect: 'none',
};
const td = { padding: '10px 14px', verticalAlign: 'middle' };

const fullName = (m) => `${m.first_name || ''} ${m.last_name || ''}`.trim();

export default function OrganizationSetup() {
  const [members, setMembers]       = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading]       = useState(false);
  const [saving,  setSaving]        = useState(false);
  const [search,  setSearch]        = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [sort, setSort]             = useState({ key: 'display_order', dir: 'asc' });
  const [selected, setSelected]     = useState(null);   // employee id of selected row
  const [drawer, setDrawer]         = useState(null);   // { mode: 'add'|'edit', ... }
  const [confirm, setConfirm]       = useState(null);   // member pending removal
  const [msg, setMsg]               = useState(null);
  const isMounted = useRef(true);

  const toast = useCallback((text, type = 'ok') => {
    setMsg({ text, type });
    setTimeout(() => { if (isMounted.current) setMsg(null); }, 3500);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [mRes, cRes] = await Promise.allSettled([
        api.get('/orgchart/members'),
        api.get('/orgchart/member-candidates'),
      ]);
      if (!isMounted.current) return;
      setMembers(mRes.status === 'fulfilled' && Array.isArray(mRes.value.data) ? mRes.value.data : []);
      setCandidates(cRes.status === 'fulfilled' && Array.isArray(cRes.value.data) ? cRes.value.data : []);
    } catch {
      if (isMounted.current) { setMembers([]); setCandidates([]); }
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    isMounted.current = true;
    load();
    return () => { isMounted.current = false; };
  }, [load]);

  const departments = useMemo(
    () => [...new Set(members.map(m => m.department).filter(Boolean))].sort(),
    [members]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = members.filter(m => {
      const matchSearch = !q ||
        fullName(m).toLowerCase().includes(q) ||
        (m.employee_id || '').toLowerCase().includes(q) ||
        (m.department || '').toLowerCase().includes(q) ||
        (m.sub_department || '').toLowerCase().includes(q) ||
        (m.designation || '').toLowerCase().includes(q);
      const matchDept = !deptFilter || m.department === deptFilter;
      return matchSearch && matchDept;
    });

    const { key, dir } = sort;
    const mul = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      let av, bv;
      if (key === 'name')            { av = fullName(a); bv = fullName(b); }
      else if (key === 'is_active')  { av = a.is_active ? 1 : 0; bv = b.is_active ? 1 : 0; }
      else if (key === 'display_order') { av = a.display_order ?? 0; bv = b.display_order ?? 0; }
      else                           { av = a[key] ?? ''; bv = b[key] ?? ''; }
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * mul;
      return String(av).localeCompare(String(bv)) * mul;
    });
  }, [members, search, deptFilter, sort]);

  const toggleSort = (key) => setSort(s => ({
    key,
    dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc',
  }));

  const sortArrow = (key) => sort.key !== key ? '' : sort.dir === 'asc' ? ' ▲' : ' ▼';

  const selectedMember = members.find(m => String(m.id) === String(selected)) || null;

  const saveMember = async (form) => {
    setSaving(true);
    try {
      if (drawer.mode === 'add') {
        await api.post('/orgchart/members', {
          employee_id: form.employee_id,
          role: form.role,
          display_order: Number(form.display_order) || 0,
          is_active: form.is_active,
        });
        toast('Member added to organization');
      } else {
        await api.put(`/orgchart/members/${form.employee_id}`, {
          role: form.role,
          display_order: Number(form.display_order) || 0,
          is_active: form.is_active,
        });
        toast('Member updated');
      }
      await load();
      if (isMounted.current) setDrawer(null);
    } catch (e) {
      if (isMounted.current) toast(e.response?.data?.error || 'Save failed', 'err');
    } finally {
      if (isMounted.current) setSaving(false);
    }
  };

  const removeMember = async () => {
    if (!confirm) return;
    setSaving(true);
    try {
      await api.delete(`/orgchart/members/${confirm.id}`);
      await load();
      if (isMounted.current) {
        setConfirm(null);
        setSelected(null);
        toast('Member removed from organization');
      }
    } catch (e) {
      if (isMounted.current) toast(e.response?.data?.error || 'Remove failed', 'err');
    } finally {
      if (isMounted.current) setSaving(false);
    }
  };

  return (
    <div className="pulse-page" style={{ padding: 24 }}>
      {msg && (
        <div style={{
          position: 'fixed', top: 20, right: 24, zIndex: 9999,
          background: msg.type === 'err' ? '#fef2f2' : '#f0fdf4',
          border: `1px solid ${msg.type === 'err' ? '#fca5a5' : '#86efac'}`,
          color: msg.type === 'err' ? '#dc2626' : '#16a34a',
          padding: '10px 18px', borderRadius: 8, fontWeight: 500, fontSize: 13,
          boxShadow: '0 2px 8px rgba(0,0,0,.12)',
        }}>{msg.text}</div>
      )}

      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#111827' }}>Organization Setup</h1>
        <p style={{ color: '#6b7280', fontSize: 13, margin: '4px 0 0' }}>
          Build the organization structure that drives the Org Chart.
        </p>
      </div>

      {/* Workflow helper text */}
      <div style={{
        background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 8,
        padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#4c1d95', lineHeight: 1.6,
      }}>
        <strong>How this works:</strong> Choose an employee by name in <em>Add Member</em> — their
        Employee ID, Department, Sub Department, Designation and Photo are pulled automatically from
        the employee master and cannot be edited here. You only set <strong>Role</strong>,{' '}
        <strong>Active</strong> and <strong>Display Order</strong>. To correct any auto-filled detail,
        edit the employee in the Employee master.
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          onClick={() => setDrawer({ mode: 'add' })}
          disabled={candidates.length === 0}
          title={candidates.length === 0 ? 'All employees are already members' : 'Add a member'}
          style={{
            background: candidates.length ? '#6B3FDB' : '#e5e7eb',
            color: candidates.length ? '#fff' : '#9ca3af',
            border: 'none', borderRadius: 8, padding: '8px 16px',
            fontWeight: 600, fontSize: 13, cursor: candidates.length ? 'pointer' : 'not-allowed',
          }}
        >
          + Add Member
        </button>
        <button
          onClick={() => selectedMember && setDrawer({ mode: 'edit', member: selectedMember })}
          disabled={!selectedMember}
          style={{
            background: '#fff', color: selectedMember ? '#374151' : '#9ca3af',
            border: '1px solid #d1d5db', borderRadius: 8, padding: '8px 16px',
            fontWeight: 500, fontSize: 13, cursor: selectedMember ? 'pointer' : 'not-allowed',
          }}
        >
          Edit Member
        </button>
        <button
          onClick={() => selectedMember && setConfirm(selectedMember)}
          disabled={!selectedMember}
          style={{
            background: '#fff', color: selectedMember ? '#dc2626' : '#9ca3af',
            border: `1px solid ${selectedMember ? '#fca5a5' : '#d1d5db'}`, borderRadius: 8,
            padding: '8px 16px', fontWeight: 500, fontSize: 13,
            cursor: selectedMember ? 'pointer' : 'not-allowed',
          }}
        >
          Remove Member
        </button>

        <input
          type="text"
          placeholder="Search by name, ID, department or designation…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            flex: '1 1 260px', maxWidth: 380, padding: '8px 14px',
            border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, outline: 'none',
          }}
        />
        {departments.length > 0 && (
          <select
            value={deptFilter}
            onChange={e => setDeptFilter(e.target.value)}
            style={{
              padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8,
              fontSize: 13, background: '#fff', outline: 'none',
            }}
          >
            <option value="">All Departments</option>
            {departments.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
      </div>

      {loading && (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Loading members…</div>
      )}

      {!loading && members.length === 0 && (
        <div style={{
          background: '#fff', borderRadius: 12, padding: 60, textAlign: 'center',
          color: '#9ca3af', boxShadow: '0 1px 4px rgba(0,0,0,.08)',
        }}>
          <div style={{ fontSize: 42, marginBottom: 12 }}>🏢</div>
          <div style={{ fontWeight: 600, color: '#374151', fontSize: 16, marginBottom: 6 }}>
            No org structure configured yet
          </div>
          <div style={{ fontSize: 13 }}>Use <strong>Add Member</strong> to place employees into the structure.</div>
        </div>
      )}

      {!loading && members.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,.08)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={{ ...th, width: 36 }} />
                  <th style={th} onClick={() => toggleSort('name')}>Name{sortArrow('name')}</th>
                  <th style={th} onClick={() => toggleSort('employee_id')}>Employee ID{sortArrow('employee_id')}</th>
                  <th style={th} onClick={() => toggleSort('department')}>Department{sortArrow('department')}</th>
                  <th style={th} onClick={() => toggleSort('sub_department')}>Sub Department{sortArrow('sub_department')}</th>
                  <th style={th} onClick={() => toggleSort('designation')}>Designation{sortArrow('designation')}</th>
                  <th style={th} onClick={() => toggleSort('role')}>Role{sortArrow('role')}</th>
                  <th style={th}>Photo</th>
                  <th style={th} onClick={() => toggleSort('is_active')}>Active{sortArrow('is_active')}</th>
                  <th style={th} onClick={() => toggleSort('display_order')}>Display Order{sortArrow('display_order')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(m => {
                  const isSel = String(selected) === String(m.id);
                  return (
                    <tr
                      key={m.id}
                      onClick={() => setSelected(isSel ? null : m.id)}
                      style={{
                        borderBottom: '1px solid #f3f4f6',
                        background: isSel ? '#f5f3ff' : 'transparent',
                        cursor: 'pointer',
                      }}
                    >
                      <td style={td}>
                        <input type="radio" readOnly checked={isSel} style={{ cursor: 'pointer' }} />
                      </td>
                      <td style={td}>
                        {m.unresolved ? (
                          <span
                            style={{ color: '#92400e', fontStyle: 'italic' }}
                            title="This member has no matching record in the employee master yet — not a data error."
                          >
                            Not yet resolved to employee master
                          </span>
                        ) : (
                          <span style={{ fontWeight: 600, color: '#6B3FDB' }}>{fullName(m)}</span>
                        )}
                      </td>
                      <td style={{ ...td, color: '#374151', fontFamily: 'monospace' }}>{m.employee_id || '—'}</td>
                      <td style={{ ...td, color: '#374151' }}>{m.department || '—'}</td>
                      <td style={{ ...td, color: '#374151' }}>{m.sub_department || '—'}</td>
                      <td style={{ ...td, color: '#374151' }}>{m.designation || '—'}</td>
                      <td style={td}>
                        <span style={{
                          background: m.role === 'head' ? '#ede9fe' : '#f3f4f6',
                          color: m.role === 'head' ? '#6B3FDB' : '#6b7280',
                          padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                          textTransform: 'capitalize',
                        }}>
                          {m.role || 'member'}
                        </span>
                      </td>
                      <td style={td}>
                        {m.profile_photo ? (
                          <img
                            src={m.profile_photo}
                            alt={fullName(m)}
                            style={{ width: 30, height: 30, borderRadius: '50%', objectFit: 'cover' }}
                          />
                        ) : (
                          <span style={{ color: '#9ca3af', fontSize: 11 }}>No photo in master DB</span>
                        )}
                      </td>
                      <td style={td}>
                        <span style={{
                          background: m.is_active ? '#dcfce7' : '#fee2e2',
                          color: m.is_active ? '#16a34a' : '#dc2626',
                          padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                        }}>
                          {m.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td style={{ ...td, color: '#374151' }}>{m.display_order ?? 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 && (search || deptFilter) && (
            <div style={{ padding: 28, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
              No members match your filter.
            </div>
          )}
          <div style={{
            padding: '10px 14px', borderTop: '1px solid #f3f4f6',
            color: '#9ca3af', fontSize: 12,
          }}>
            {filtered.length === members.length
              ? `${members.length} member${members.length !== 1 ? 's' : ''}`
              : `${filtered.length} of ${members.length} members`}
          </div>
        </div>
      )}

      {drawer && (
        <MemberDrawer
          mode={drawer.mode}
          member={drawer.member}
          candidates={candidates}
          saving={saving}
          onCancel={() => setDrawer(null)}
          onSave={saveMember}
        />
      )}

      {confirm && (
        <Modal onClose={() => setConfirm(null)}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 8px', color: '#111827' }}>
            Remove member?
          </h2>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 18px', lineHeight: 1.6 }}>
            This removes <strong>{fullName(confirm) || confirm.employee_id}</strong> from the
            organization structure only. The employee record in the master is not deleted.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={() => setConfirm(null)} style={btnSecondary}>Cancel</button>
            <button onClick={removeMember} disabled={saving}
              style={{ ...btnPrimary, background: '#dc2626' }}>
              {saving ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const btnPrimary = {
  background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8,
  padding: '9px 18px', fontWeight: 600, fontSize: 13, cursor: 'pointer',
};
const btnSecondary = {
  background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8,
  padding: '9px 18px', fontWeight: 500, fontSize: 13, cursor: 'pointer',
};
const label = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5 };
const input = {
  width: '100%', padding: '8px 12px', border: '1px solid #d1d5db',
  borderRadius: 8, fontSize: 13, outline: 'none',
};
const readOnlyBox = { ...input, background: '#f9fafb', color: '#6b7280' };

function Modal({ children, onClose }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(17,24,39,.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9998, padding: 20,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 12, padding: 24,
          width: '100%', maxWidth: 460, boxShadow: '0 10px 40px rgba(0,0,0,.2)',
        }}
      >
        {children}
      </div>
    </div>
  );
}

function MemberDrawer({ mode, member, candidates, saving, onCancel, onSave }) {
  const isEdit = mode === 'edit';
  const [empId, setEmpId] = useState(isEdit ? String(member.id) : '');
  const [role, setRole] = useState(isEdit ? (member.role || 'member') : 'member');
  const [order, setOrder] = useState(isEdit ? String(member.display_order ?? 0) : '0');
  const [active, setActive] = useState(isEdit ? !!member.is_active : true);

  // The auto-populate contract: details always mirror the master record for the
  // selected employee. Nothing here is typed by hand.
  const picked = isEdit ? member : candidates.find(c => String(c.id) === String(empId));

  return (
    <Modal onClose={onCancel}>
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px', color: '#111827' }}>
        {isEdit ? 'Edit Member' : 'Add Member'}
      </h2>
      <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 18px' }}>
        {isEdit
          ? 'Details come from the employee master. Only Role, Active and Display Order are editable.'
          : 'Pick an employee — their details fill in automatically from the employee master.'}
      </p>

      <div style={{ marginBottom: 14 }}>
        <label style={label}>Employee {!isEdit && <span style={{ color: '#dc2626' }}>*</span>}</label>
        {isEdit ? (
          <div style={readOnlyBox}>{fullName(member) || member.employee_id}</div>
        ) : (
          <select value={empId} onChange={e => setEmpId(e.target.value)} style={input}>
            <option value="">Select an employee…</option>
            {candidates.map(c => (
              <option key={c.id} value={c.id}>
                {`${c.first_name || ''} ${c.last_name || ''}`.trim()} — {c.employee_id}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Auto-populated, read-only mirror of the master record */}
      {picked && (
        <div style={{
          background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8,
          padding: 12, marginBottom: 14,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', marginBottom: 8, textTransform: 'uppercase' }}>
            From employee master
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 12 }}>
            <Detail label="Employee ID" value={picked.employee_id} mono />
            <Detail label="Department" value={picked.department} />
            <Detail label="Sub Department" value={picked.sub_department} />
            <Detail label="Designation" value={picked.designation} />
          </div>
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
            {picked.profile_photo ? (
              <img src={picked.profile_photo} alt="" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }} />
            ) : (
              <span style={{ fontSize: 11, color: '#9ca3af' }}>No photo in master DB</span>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
        <div>
          <label style={label}>Role</label>
          <select value={role} onChange={e => setRole(e.target.value)} style={input}>
            {ROLE_OPTIONS.map(r => (
              <option key={r} value={r}>{r === 'head' ? 'Head' : 'Member'}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={label}>Display Order</label>
          <input
            type="number" min="0" value={order}
            onChange={e => setOrder(e.target.value)} style={input}
          />
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', cursor: 'pointer' }}>
          <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
          Active in org chart
        </label>
      </div>

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={btnSecondary}>Cancel</button>
        <button
          onClick={() => onSave({ employee_id: isEdit ? member.id : empId, role, display_order: order, is_active: active })}
          disabled={saving || (!isEdit && !empId)}
          style={{
            ...btnPrimary,
            ...((!isEdit && !empId) || saving
              ? { background: '#e5e7eb', color: '#9ca3af', cursor: 'not-allowed' }
              : {}),
          }}
        >
          {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Member'}
        </button>
      </div>
    </Modal>
  );
}

function Detail({ label: l, value, mono }) {
  return (
    <div>
      <div style={{ color: '#9ca3af', fontSize: 10, marginBottom: 2 }}>{l}</div>
      <div style={{ color: '#374151', fontWeight: 500, fontFamily: mono ? 'monospace' : 'inherit' }}>
        {value || '—'}
      </div>
    </div>
  );
}
