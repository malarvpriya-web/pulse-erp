// frontend/src/features/hr/pages/SkillMatrix.jsx
import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const P      = '#6B3FDB';
const LIGHT  = '#f5f3ff';
const BORDER = '#e9e4ff';

const LEVEL_META = {
  beginner:     { label: 'Beginner',     color: '#6b7280', bg: '#f3f4f6', rank: 1 },
  intermediate: { label: 'Intermediate', color: '#d97706', bg: '#fef3c7', rank: 2 },
  advanced:     { label: 'Advanced',     color: '#6B3FDB', bg: '#ede9fe', rank: 3 },
  expert:       { label: 'Expert',       color: '#16a34a', bg: '#dcfce7', rank: 4 },
};

function LevelBadge({ level }) {
  const m = LEVEL_META[level] || LEVEL_META.beginner;
  return (
    <span style={{ padding: '2px 9px', borderRadius: 10, fontSize: 11, fontWeight: 700,
                   background: m.bg, color: m.color }}>
      {m.label}
    </span>
  );
}

function SkillModal({ employeeId, employeeName, skill, categories, onSave, onClose }) {
  const [form, setForm] = useState({
    skill_name: skill?.skill_name || '',
    category: skill?.category || '',
    proficiency_level: skill?.proficiency_level || 'beginner',
    years_experience: skill?.years_experience || '',
    is_certified: skill?.is_certified || false,
    certified_by: skill?.certified_by || '',
    certification_date: skill?.certification_date?.split('T')[0] || '',
    expiry_date: skill?.expiry_date?.split('T')[0] || '',
    notes: skill?.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    if (!form.skill_name.trim()) { setErr('Skill name is required'); return; }
    setSaving(true); setErr('');
    try {
      if (skill?.id) {
        await api.put(`/employee-skills/${skill.id}`, form);
      } else {
        await api.post('/employee-skills', { ...form, employee_id: employeeId });
      }
      onSave();
    } catch (e) {
      setErr(e.response?.data?.message || e.message);
    } finally {
      setSaving(false);
    }
  };

  const inp = (field, label, type = 'text', opts = {}) => (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>{label}</label>
      {type === 'select' ? (
        <select value={form[field]} onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))}
          style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${BORDER}`, fontSize: 13 }}>
          {opts.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : type === 'checkbox' ? (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={form[field]} onChange={e => setForm(f => ({ ...f, [field]: e.target.checked }))} />
          {opts.checkLabel}
        </label>
      ) : (
        <input type={type} value={form[field]}
          onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))}
          style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${BORDER}`, fontSize: 13, boxSizing: 'border-box' }}
        />
      )}
    </div>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 540, maxHeight: '90vh', overflowY: 'auto', padding: 24, boxShadow: '0 20px 60px rgba(0,0,0,.25)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>{skill ? 'Edit Skill' : 'Add Skill'}</div>
            <div style={{ fontSize: 12, color: '#9ca3af' }}>{employeeName}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#9ca3af' }}>×</button>
        </div>

        {inp('skill_name', 'Skill Name *')}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Category</label>
          <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${BORDER}`, fontSize: 13 }}>
            <option value="">— Select Category —</option>
            {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
        </div>
        {inp('proficiency_level', 'Proficiency Level', 'select', {
          options: [
            { value: 'beginner', label: 'Beginner' },
            { value: 'intermediate', label: 'Intermediate' },
            { value: 'advanced', label: 'Advanced' },
            { value: 'expert', label: 'Expert' },
          ],
        })}
        {inp('years_experience', 'Years of Experience', 'number')}
        {inp('is_certified', '', 'checkbox', { checkLabel: 'Has Certification / Licence' })}
        {form.is_certified && <>
          {inp('certified_by', 'Certifying Body / Authority')}
          {inp('certification_date', 'Certification Date', 'date')}
          {inp('expiry_date', 'Expiry Date', 'date')}
        </>}
        {inp('notes', 'Notes')}

        {err && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 12 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '9px 18px', borderRadius: 8, border: `1px solid ${BORDER}`, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          <button onClick={save} disabled={saving}
            style={{ padding: '9px 18px', borderRadius: 8, border: 'none', background: P, color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            {saving ? 'Saving…' : (skill ? 'Update' : 'Add Skill')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function SkillMatrix({ setPage }) {
  const [skills,     setSkills]     = useState([]);
  const [categories, setCategories] = useState([]);
  const [expiring,   setExpiring]   = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState(null);
  const [search,     setSearch]     = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [catFilter,  setCatFilter]  = useState('');
  const [view,       setView]       = useState('matrix'); // matrix | list | expiring
  const [modal,      setModal]      = useState(null);    // { employeeId, employeeName, skill? }
  const [pendingDeleteSkill, setPendingDeleteSkill] = useState(null);
  const abortRef = useRef(null);

  const load = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();
    setLoading(true); setError(null);
    try {
      const [allRes, catRes, expRes] = await Promise.allSettled([
        api.get('/employee-skills'),
        api.get('/employee-skills/categories'),
        api.get('/employee-skills/expiring?days=60'),
      ]);
      setSkills(allRes.status === 'fulfilled' ? (allRes.value.data || []) : []);
      setCategories(catRes.status === 'fulfilled' ? (catRes.value.data || []) : []);
      setExpiring(expRes.status === 'fulfilled' ? (expRes.value.data || []) : []);
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [load]);

  const deleteSkill = async () => {
    if (!pendingDeleteSkill) return;
    const id = pendingDeleteSkill;
    setPendingDeleteSkill(null);
    await api.delete(`/employee-skills/${id}`);
    load();
  };

  // Derive unique departments and group skills by employee
  const depts = [...new Set(skills.map(s => s.department).filter(Boolean))].sort();

  const filtered = skills.filter(s => {
    const q = search.toLowerCase();
    const matchSearch = !q || s.skill_name?.toLowerCase().includes(q) || s.employee_name?.toLowerCase().includes(q) || s.category?.toLowerCase().includes(q);
    const matchDept = !deptFilter || s.department === deptFilter;
    const matchCat  = !catFilter  || s.category   === catFilter;
    return matchSearch && matchDept && matchCat;
  });

  // Group by employee for matrix/list views
  const byEmployee = filtered.reduce((acc, s) => {
    if (!acc[s.employee_id]) acc[s.employee_id] = { ...s, skills: [] };
    acc[s.employee_id].skills.push(s);
    return acc;
  }, {});
  const empList = Object.values(byEmployee);

  const exportCSV = () => {
    const headers = ['Emp Code','Employee','Department','Designation','Skill','Category','Level','Certified','Expiry Date'];
    const rows = filtered.map(s => [
      s.office_id || '—',
      s.employee_name || '—',
      s.department || '—',
      s.designation || '—',
      s.skill_name,
      s.category || '—',
      s.proficiency_level,
      s.is_certified ? 'Yes' : 'No',
      s.expiry_date ? s.expiry_date.split('T')[0] : '—',
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    a.download = `skill-matrix-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  const certCount   = skills.filter(s => s.is_certified).length;
  const uniqueSkills= [...new Set(skills.map(s => s.skill_name))].length;
  const expiryCount = expiring.length;

  return (
    <div style={{ padding: 24, background: '#f5f3ff', minHeight: '100vh' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, color: '#4c1d95', fontSize: 22 }}>Skill Matrix</h2>
          <p style={{ margin: '2px 0 0', color: '#6b7280', fontSize: 13 }}>Employee competencies, certifications and gap analysis</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={exportCSV} style={{ padding: '8px 14px', borderRadius: 8, border: `1px solid ${BORDER}`, background: LIGHT, color: P, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
            ⬇ Export CSV
          </button>
        </div>
      </div>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Total Skills',     value: skills.length,   color: P },
          { label: 'Unique Skills',    value: uniqueSkills,    color: '#2563eb' },
          { label: 'Certified',        value: certCount,       color: '#16a34a' },
          { label: 'Expiring (60d)',   value: expiryCount,     color: expiryCount > 0 ? '#dc2626' : '#6b7280' },
          { label: 'Employees',        value: Object.keys(byEmployee).length, color: '#d97706' },
        ].map(k => (
          <div key={k.label} style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: '14px 16px' }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: k.color }}>{loading ? '—' : k.value}</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{k.label}</div>
          </div>
        ))}
      </div>

      {/* Filters + View Toggle */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search skill, employee…"
          style={{ flex: 1, minWidth: 200, padding: '8px 12px', borderRadius: 8, border: `1px solid ${BORDER}`, fontSize: 13 }} />
        <select value={deptFilter} onChange={e => setDeptFilter(e.target.value)}
          style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${BORDER}`, fontSize: 13, background: '#fff' }}>
          <option value="">All Departments</option>
          {depts.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)}
          style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${BORDER}`, fontSize: 13, background: '#fff' }}>
          <option value="">All Categories</option>
          {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
        <div style={{ display: 'flex', gap: 4, background: '#e9e4ff', borderRadius: 8, padding: 3 }}>
          {[['matrix','Matrix'],['list','By Employee'],['expiring','Expiring']].map(([k,l]) => (
            <button key={k} onClick={() => setView(k)}
              style={{ padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 12,
                       background: view === k ? P : 'transparent', color: view === k ? '#fff' : P }}>
              {l}{k === 'expiring' && expiryCount > 0 ? ` (${expiryCount})` : ''}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: P }}>Loading skill data…</div>
      ) : error ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#dc2626' }}>{error}</div>
      ) : view === 'expiring' ? (
        /* ── Expiring certifications ── */
        <div style={{ background: '#fff', borderRadius: 12, border: `1px solid ${BORDER}`, overflow: 'hidden' }}>
          {expiring.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No certifications expiring in the next 60 days</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: LIGHT }}>
                <tr>
                  {['Employee','Department','Skill','Category','Certified By','Expiry Date','Days Left'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', borderBottom: `2px solid ${BORDER}`, color: '#4c1d95', fontWeight: 700 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {expiring.map((s, i) => {
                  const days = Math.round((new Date(s.expiry_date) - new Date()) / 86400000);
                  return (
                    <tr key={s.id} style={{ borderBottom: `1px solid #f0ebff`, background: i % 2 === 0 ? '#fff' : '#faf9ff' }}>
                      <td style={{ padding: '9px 14px', fontWeight: 600 }}>{s.employee_name}</td>
                      <td style={{ padding: '9px 14px', color: '#374151' }}>{s.department}</td>
                      <td style={{ padding: '9px 14px', color: '#374151' }}>{s.skill_name}</td>
                      <td style={{ padding: '9px 14px', color: '#6b7280' }}>{s.category || '—'}</td>
                      <td style={{ padding: '9px 14px', color: '#6b7280' }}>{s.certified_by || '—'}</td>
                      <td style={{ padding: '9px 14px', color: days <= 7 ? '#dc2626' : days <= 30 ? '#d97706' : '#374151', fontWeight: 600 }}>
                        {s.expiry_date?.split('T')[0]}
                      </td>
                      <td style={{ padding: '9px 14px' }}>
                        <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700,
                          background: days <= 7 ? '#fef2f2' : days <= 30 ? '#fef3c7' : '#f0fdf4',
                          color:      days <= 7 ? '#dc2626' : days <= 30 ? '#d97706' : '#16a34a' }}>
                          {days}d
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      ) : view === 'list' ? (
        /* ── By Employee view ── */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {empList.length === 0 && (
            <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>No results found</div>
          )}
          {empList.map(emp => (
            <div key={emp.employee_id} style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                <div>
                  <div style={{ fontWeight: 700, color: '#111827', fontSize: 14 }}>{emp.employee_name}</div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>{emp.designation} · {emp.department}</div>
                </div>
                <button onClick={() => setModal({ employeeId: emp.employee_id, employeeName: emp.employee_name })}
                  style={{ padding: '5px 12px', borderRadius: 8, border: `1px solid ${BORDER}`, background: LIGHT, color: P, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                  + Add Skill
                </button>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {emp.skills.map(s => (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: LIGHT, borderRadius: 20, border: `1px solid ${BORDER}` }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>{s.skill_name}</span>
                    <LevelBadge level={s.proficiency_level} />
                    {s.is_certified && <span title="Certified" style={{ fontSize: 12 }}>✓</span>}
                    {s.expiry_date && new Date(s.expiry_date) < new Date(Date.now() + 60*86400000) && (
                      <span title={`Expires ${s.expiry_date.split('T')[0]}`} style={{ fontSize: 12 }}>⚠️</span>
                    )}
                    <button onClick={() => setModal({ employeeId: emp.employee_id, employeeName: emp.employee_name, skill: s })}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#9ca3af', padding: 0 }}>✏</button>
                    <button onClick={() => setPendingDeleteSkill(s.id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#dc2626', padding: 0 }}>×</button>
                  </div>
                ))}
                {emp.skills.length === 0 && <span style={{ fontSize: 12, color: '#9ca3af' }}>No skills recorded</span>}
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* ── Matrix table view ── */
        <div style={{ background: '#fff', borderRadius: 12, border: `1px solid ${BORDER}`, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead style={{ background: LIGHT, position: 'sticky', top: 0 }}>
              <tr>
                {['Employee','Department','Designation','Skills','Certifications','Expiring'].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', borderBottom: `2px solid ${BORDER}`, color: '#4c1d95', fontWeight: 700 }}>{h}</th>
                ))}
                <th style={{ padding: '10px 14px', borderBottom: `2px solid ${BORDER}` }} />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={7} style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No employees found. Add skills via the <strong>By Employee</strong> view.</td></tr>
              )}
              {empList.map((emp, i) => {
                const certSkills = emp.skills.filter(s => s.is_certified);
                const expSkills  = emp.skills.filter(s => s.expiry_date && new Date(s.expiry_date) < new Date(Date.now() + 60*86400000));
                return (
                  <tr key={emp.employee_id} style={{ borderBottom: `1px solid #f0ebff`, background: i % 2 === 0 ? '#fff' : '#faf9ff' }}>
                    <td style={{ padding: '9px 14px', fontWeight: 600, color: '#111827' }}>
                      {emp.employee_name}
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>{emp.office_id}</div>
                    </td>
                    <td style={{ padding: '9px 14px', color: '#374151' }}>{emp.department || '—'}</td>
                    <td style={{ padding: '9px 14px', color: '#374151' }}>{emp.designation || '—'}</td>
                    <td style={{ padding: '9px 14px' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {emp.skills.slice(0, 3).map(s => <LevelBadge key={s.id} level={s.proficiency_level} />)}
                        {emp.skills.length > 3 && <span style={{ fontSize: 11, color: '#6b7280' }}>+{emp.skills.length - 3}</span>}
                        {emp.skills.length === 0 && <span style={{ fontSize: 11, color: '#d1d5db' }}>None</span>}
                      </div>
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                        {emp.skills.map(s => s.skill_name).join(', ') || '—'}
                      </div>
                    </td>
                    <td style={{ padding: '9px 14px' }}>
                      {certSkills.length > 0
                        ? <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: '#dcfce7', color: '#16a34a' }}>{certSkills.length} certified</span>
                        : <span style={{ fontSize: 11, color: '#d1d5db' }}>—</span>
                      }
                    </td>
                    <td style={{ padding: '9px 14px' }}>
                      {expSkills.length > 0
                        ? <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: '#fef3c7', color: '#d97706' }}>{expSkills.length} expiring</span>
                        : <span style={{ fontSize: 11, color: '#d1d5db' }}>—</span>
                      }
                    </td>
                    <td style={{ padding: '9px 14px', textAlign: 'right' }}>
                      <button onClick={() => setModal({ employeeId: emp.employee_id, employeeName: emp.employee_name })}
                        style={{ padding: '4px 10px', borderRadius: 7, border: `1px solid ${BORDER}`, background: LIGHT, color: P, cursor: 'pointer', fontSize: 12 }}>
                        + Add
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Delete Skill Confirm */}
      <ConfirmDialog
        open={!!pendingDeleteSkill}
        title="Remove Skill"
        message="Remove this skill?"
        confirmLabel="Remove"
        variant="warning"
        onConfirm={deleteSkill}
        onCancel={() => setPendingDeleteSkill(null)}
      />

      {/* Skill Modal */}
      {modal && (
        <SkillModal
          employeeId={modal.employeeId}
          employeeName={modal.employeeName}
          skill={modal.skill}
          categories={categories}
          onSave={() => { setModal(null); load(); }}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
