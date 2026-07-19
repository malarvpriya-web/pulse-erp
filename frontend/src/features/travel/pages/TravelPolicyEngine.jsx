import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { useAuth } from '@/context/AuthContext';
import { Plus, X, Settings, CheckCircle, AlertCircle } from 'lucide-react';
import { fmt } from './travelUtils';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const RULE_TYPES = ['grade', 'role', 'department'];
const GRADES = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'];
const TRAIN_CLASSES = ['Sleeper', 'AC-3', 'AC-2', 'AC-1', 'Business'];

const EMPTY = {
  rule_name: '', rule_type: 'grade',
  grade: 'L1', role: '', department: '',
  hotel_limit_per_day: '', meal_limit_per_day: '',
  travel_daily_allowance: '', flight_eligible: false,
  train_class: 'Sleeper', local_conveyance_limit: '',
  miscellaneous_limit: '', max_advance_amount: '',
  effective_from: '', effective_to: '',
};

const inp = { width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box', background: '#fff' };
const lbl = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5 };

const RULE_TYPE_COLORS = {
  grade:      { bg: '#ede9fe', color: '#5b21b6' },
  role:       { bg: '#dbeafe', color: '#1e40af' },
  department: { bg: '#dcfce7', color: '#166534' },
};

export default function TravelPolicyEngine() {
  const toast  = useToast();
  const { hasAnyRole } = useAuth();
  const [rules,    setRules]    = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing,  setEditing]  = useState(null);
  const [form,     setForm]     = useState(EMPTY);
  const [saving,   setSaving]   = useState(false);
  const [tab,      setTab]      = useState('All');
  const [pendingHandleDelete, setPendingHandleDelete] = useState(null);
  const [deptList, setDeptList] = useState([]);

  // hasAnyRole, not user.role: `role` is only the PRIMARY role of a many-to-many
  // set, so gating on it alone made the policy editor read-only for anyone
  // holding hr as a secondary role. See AuthContext.
  const isAdmin = hasAnyRole('admin', 'super_admin', 'hr');

  const load = useCallback(() => {
    setLoading(true);
    api.get('/travel-policy')
      .then(r => setRules(Array.isArray(r.data) ? r.data : []))
      .catch(() => setRules([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/admin/config/departments')
      .then(r => setDeptList(Array.isArray(r.data) ? r.data.map(d => d.name || d) : []))
      .catch(() => setDeptList([]));
  }, []);

  const fld = (key, val) => setForm(p => ({ ...p, [key]: val }));

  const openAdd = () => { setEditing(null); setForm(EMPTY); setShowForm(true); };
  const openEdit = (rule) => {
    setEditing(rule.id);
    setForm({
      rule_name: rule.rule_name, rule_type: rule.rule_type,
      grade: rule.grade || 'L1', role: rule.role || '', department: rule.department || '',
      hotel_limit_per_day: rule.hotel_limit_per_day || '',
      meal_limit_per_day: rule.meal_limit_per_day || '',
      travel_daily_allowance: rule.travel_daily_allowance || '',
      flight_eligible: rule.flight_eligible || false,
      train_class: rule.train_class || 'Sleeper',
      local_conveyance_limit: rule.local_conveyance_limit || '',
      miscellaneous_limit: rule.miscellaneous_limit || '',
      max_advance_amount: rule.max_advance_amount || '',
      effective_from: rule.effective_from?.slice(0,10) || '',
      effective_to: rule.effective_to?.slice(0,10) || '',
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.rule_name) { toast.error('Rule name is required'); return; }
    setSaving(true);
    try {
      const payload = {
        ...form,
        hotel_limit_per_day:    Number(form.hotel_limit_per_day) || 0,
        meal_limit_per_day:     Number(form.meal_limit_per_day) || 0,
        travel_daily_allowance: Number(form.travel_daily_allowance) || 0,
        local_conveyance_limit: Number(form.local_conveyance_limit) || 0,
        miscellaneous_limit:    Number(form.miscellaneous_limit) || 0,
        max_advance_amount:     Number(form.max_advance_amount) || 0,
      };
      if (editing) {
        await api.put(`/travel-policy/${editing}`, payload);
        toast.success('Policy rule updated');
      } else {
        await api.post('/travel-policy', payload);
        toast.success('Policy rule created');
      }
      setShowForm(false); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!pendingHandleDelete) return;
    const id = pendingHandleDelete;
    setPendingHandleDelete(null);
    try {
      await api.delete(`/travel-policy/${id}`);
      toast.success('Deleted'); load();
    } catch { toast.error('Delete failed'); }
  };

  const filtered = rules.filter(r => tab === 'All' || r.rule_type === tab);

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>

      <ConfirmDialog
        open={!!pendingHandleDelete}
        title="Delete Policy Rule"
        message="Delete this policy rule?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingHandleDelete(null)}
      />
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Travel Policy Engine</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>
            Configure expense limits per Grade, Role, and Department
          </p>
        </div>
        {isAdmin && (
          <button onClick={openAdd}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            <Plus size={15} /> Add Policy Rule
          </button>
        )}
      </div>

      {/* KPI summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14, marginBottom: 20 }}>
        {RULE_TYPES.map(type => {
          const count = rules.filter(r => r.rule_type === type && r.is_active).length;
          const c = RULE_TYPE_COLORS[type];
          return (
            <div key={type} style={{ background: '#fff', borderRadius: 12, padding: '16px 20px', border: '1px solid #f0f0f4' }}>
              <div style={{ fontSize: 12, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', marginBottom: 6 }}>By {type}</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: c.color }}>{count}</div>
              <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>active rules</div>
            </div>
          );
        })}
      </div>

      {/* Tab filter */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {['All', ...RULE_TYPES].map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid', fontSize: 12, fontWeight: 500, cursor: 'pointer', textTransform: 'capitalize',
              borderColor: tab === t ? '#6B3FDB' : '#e5e7eb',
              background: tab === t ? '#6B3FDB' : '#fff',
              color: tab === t ? '#fff' : '#374151' }}>
            {t}
          </button>
        ))}
      </div>

      {/* Policy matrix table */}
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'auto' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: '#9ca3af' }}>
            <Settings size={36} color="#d1d5db" style={{ marginBottom: 10 }} />
            <p style={{ margin: 0 }}>No policy rules configured</p>
            {isAdmin && (
              <button onClick={openAdd}
                style={{ marginTop: 12, padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
                Add First Rule
              </button>
            )}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 900 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Rule Name', 'Type', 'Grade/Role/Dept', 'Hotel Limit/Day', 'Meal Limit/Day', 'Daily Allowance', 'Flight', 'Train Class', 'Conveyance', 'Misc Limit', 'Max Advance', 'Status', ...(isAdmin ? ['Actions'] : [])].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', fontSize: 11 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((rule, i) => {
                const tc = RULE_TYPE_COLORS[rule.rule_type] || { bg: '#f3f4f6', color: '#374151' };
                const appliesTo = rule.rule_type === 'grade' ? rule.grade
                  : rule.rule_type === 'role' ? rule.role
                  : rule.department;
                return (
                  <tr key={rule.id} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ padding: '10px 14px', fontWeight: 600, color: '#1f2937' }}>{rule.rule_name}</td>
                    <td style={{ padding: '10px 14px' }}>
                      <span style={{ background: tc.bg, color: tc.color, padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, textTransform: 'capitalize' }}>
                        {rule.rule_type}
                      </span>
                    </td>
                    <td style={{ padding: '10px 14px', fontWeight: 600, color: '#6B3FDB' }}>{appliesTo || '—'}</td>
                    <td style={{ padding: '10px 14px', color: '#374151' }}>
                      {Number(rule.hotel_limit_per_day) > 0 ? fmt(rule.hotel_limit_per_day) : <span style={{ color: '#d1d5db' }}>No limit</span>}
                    </td>
                    <td style={{ padding: '10px 14px', color: '#374151' }}>
                      {Number(rule.meal_limit_per_day) > 0 ? fmt(rule.meal_limit_per_day) : <span style={{ color: '#d1d5db' }}>No limit</span>}
                    </td>
                    <td style={{ padding: '10px 14px', color: '#374151' }}>
                      {Number(rule.travel_daily_allowance) > 0 ? fmt(rule.travel_daily_allowance) : '—'}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      {rule.flight_eligible
                        ? <CheckCircle size={14} color="#10b981" />
                        : <span style={{ color: '#d1d5db', fontSize: 12 }}>No</span>}
                    </td>
                    <td style={{ padding: '10px 14px', color: '#6b7280' }}>{rule.train_class}</td>
                    <td style={{ padding: '10px 14px', color: '#374151' }}>
                      {Number(rule.local_conveyance_limit) > 0 ? fmt(rule.local_conveyance_limit) : '—'}
                    </td>
                    <td style={{ padding: '10px 14px', color: '#374151' }}>
                      {Number(rule.miscellaneous_limit) > 0 ? fmt(rule.miscellaneous_limit) : '—'}
                    </td>
                    <td style={{ padding: '10px 14px', color: '#374151' }}>
                      {Number(rule.max_advance_amount) > 0 ? fmt(rule.max_advance_amount) : '—'}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <span style={{
                        background: rule.is_active ? '#d1fae5' : '#f3f4f6',
                        color: rule.is_active ? '#065f46' : '#6b7280',
                        padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                      }}>
                        {rule.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    {isAdmin && (
                      <td style={{ padding: '10px 14px' }}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={() => openEdit(rule)}
                            style={{ padding: '4px 10px', background: '#f5f3ff', color: '#6B3FDB', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                            Edit
                          </button>
                          <button onClick={() => setPendingHandleDelete(rule.id)}
                            style={{ padding: '4px 10px', background: '#fee2e2', color: '#991b1b', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                            Del
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Info block */}
      <div style={{ marginTop: 20, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 12, padding: 16 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <AlertCircle size={16} color="#d97706" style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: 12, color: '#92400e' }}>
            <strong>Policy Priority:</strong> Grade rules apply first, then Role, then Department.
            When an expense exceeds the policy limit, it is flagged as &quot;Over Policy&quot; and requires additional justification during submission.
            Directors and above with 0 limits have no restriction.
          </div>
        </div>
      </div>

      {/* Add / Edit Modal */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 32, width: 680, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1f2937', margin: 0 }}>
                {editing ? 'Edit Policy Rule' : 'New Policy Rule'}
              </h2>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={lbl}>Rule Name *</label>
                <input value={form.rule_name} onChange={e => fld('rule_name', e.target.value)} placeholder="e.g. Sales Engineer Policy" style={inp} />
              </div>

              <div>
                <label style={lbl}>Rule Type</label>
                <select value={form.rule_type} onChange={e => fld('rule_type', e.target.value)} style={inp}>
                  {RULE_TYPES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
                </select>
              </div>

              {form.rule_type === 'grade' && (
                <div>
                  <label style={lbl}>Grade</label>
                  <select value={form.grade} onChange={e => fld('grade', e.target.value)} style={inp}>
                    {GRADES.map(g => <option key={g}>{g}</option>)}
                  </select>
                </div>
              )}
              {form.rule_type === 'role' && (
                <div>
                  <label style={lbl}>Role / Designation</label>
                  <select value={form.role} onChange={e => fld('role', e.target.value)} style={inp}>
                    <option value="">-- Select Role --</option>
                    {['Sales Engineer','Sales Manager','Project Engineer','Project Manager','Service Engineer','HR Executive','Finance Executive','Senior Manager','Director','VP','Other'].map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
              )}
              {form.rule_type === 'department' && (
                <div>
                  <label style={lbl}>Department</label>
                  <select value={form.department} onChange={e => fld('department', e.target.value)} style={inp}>
                    <option value="">-- Select Department --</option>
                    {deptList.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
              )}

              <div style={{ gridColumn: '1/-1', borderTop: '1px solid #f0f0f4', paddingTop: 14, marginTop: 4 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#6B3FDB', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 14 }}>Expense Limits</div>
              </div>

              {[
                ['Hotel Limit / Day (₹)', 'hotel_limit_per_day', '0 = No limit'],
                ['Meal Limit / Day (₹)', 'meal_limit_per_day', '0 = No limit'],
                ['Daily Travel Allowance (₹)', 'travel_daily_allowance', '0 = None'],
                ['Local Conveyance Limit (₹)', 'local_conveyance_limit', '0 = No limit'],
                ['Miscellaneous Limit (₹)', 'miscellaneous_limit', '0 = No limit'],
                ['Max Advance Amount (₹)', 'max_advance_amount', '0 = No advance'],
              ].map(([label, key, ph]) => (
                <div key={key}>
                  <label style={lbl}>{label}</label>
                  <input type="number" value={form[key]} onChange={e => fld(key, e.target.value)} placeholder={ph} style={inp} />
                </div>
              ))}

              <div>
                <label style={lbl}>Train Class</label>
                <select value={form.train_class} onChange={e => fld('train_class', e.target.value)} style={inp}>
                  {TRAIN_CLASSES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.flight_eligible} onChange={e => fld('flight_eligible', e.target.checked)}
                    style={{ accentColor: '#6B3FDB', width: 15, height: 15 }} />
                  Flight Eligible
                </label>
              </div>

              <div>
                <label style={lbl}>Effective From</label>
                <input type="date" value={form.effective_from} onChange={e => fld('effective_from', e.target.value)} style={inp} />
              </div>
              <div>
                <label style={lbl}>Effective To</label>
                <input type="date" value={form.effective_to} onChange={e => fld('effective_to', e.target.value)} style={inp} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 24 }}>
              <button onClick={() => setShowForm(false)}
                style={{ padding: '9px 20px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, color: '#374151' }}>Cancel</button>
              <button onClick={handleSave} disabled={saving}
                style={{ padding: '9px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Saving...' : (editing ? 'Update Rule' : 'Create Rule')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
