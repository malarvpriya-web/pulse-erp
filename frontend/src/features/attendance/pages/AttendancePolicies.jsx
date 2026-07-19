import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Shield, Plus, Edit2, Trash2, ChevronDown, ChevronUp, CheckCircle, X, AlertCircle, RefreshCw, Clock, Zap, Coffee } from 'lucide-react';
import api from '@/services/api/client';

const P = '#6B3FDB';
const CARD = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 24 };

const POLICY_TYPES = [
  { id: 'late',     label: 'Late Arrival Policy',  icon: Clock,   color: '#f59e0b', desc: 'Grace period, late marks, auto-deductions' },
  { id: 'overtime', label: 'Overtime Policy',       icon: Zap,    color: '#6B3FDB', desc: 'OT multipliers, approval requirements, max hours' },
  { id: 'break',    label: 'Break Policy',          icon: Coffee, color: '#0369a1', desc: 'Lunch/tea breaks, unauthorized break tracking' },
  { id: 'field',    label: 'Field Engineer Policy', icon: Shield, color: '#10b981', desc: 'Geo-attendance, mobile punch, travel attendance' },
  { id: 'factory',  label: 'Factory Policy',        icon: Shield, color: '#ef4444', desc: 'Biometric mandatory, shift lock, gate-pass integration' },
];

const DEFAULT_RULES = {
  late: {
    grace_minutes: 10,
    half_late_minutes: 30,
    late_mark_minutes: 60,
    auto_deduct: false,
    repeated_late_penalty: 3,
    penalty_type: 'half_day',
  },
  overtime: {
    min_ot_minutes: 30,
    weekday_multiplier: 1.5,
    weekend_multiplier: 2.0,
    holiday_multiplier: 2.0,
    night_shift_multiplier: 1.25,
    max_ot_hours: 4,
    requires_approval: true,
    auto_approve_below_hours: 0,
  },
  break: {
    lunch_minutes: 30,
    tea_minutes: 15,
    max_breaks: 2,
    track_unauthorized: true,
    unauthorized_deduct: false,
  },
  field: {
    geo_mandatory: false,
    selfie_required: false,
    offline_allowed: true,
    travel_allowance: true,
  },
  factory: {
    biometric_mandatory: true,
    shift_lock: true,
    gate_pass_required: false,
    safety_check_required: true,
  },
};

const RULE_LABELS = {
  grace_minutes:             'Grace Period (minutes)',
  half_late_minutes:         'Half-Late Threshold (minutes)',
  late_mark_minutes:         'Late Mark After (minutes)',
  auto_deduct:               'Auto-deduct for late',
  repeated_late_penalty:     'Penalty after N late marks',
  penalty_type:              'Penalty type',
  min_ot_minutes:            'Min OT threshold (minutes)',
  weekday_multiplier:        'Weekday OT multiplier',
  weekend_multiplier:        'Weekend OT multiplier',
  holiday_multiplier:        'Holiday OT multiplier',
  night_shift_multiplier:    'Night shift multiplier',
  max_ot_hours:              'Max OT per day (hours)',
  requires_approval:         'Requires manager approval',
  auto_approve_below_hours:  'Auto-approve OT below (hours)',
  lunch_minutes:             'Lunch break duration (minutes)',
  tea_minutes:               'Tea break duration (minutes)',
  max_breaks:                'Max breaks per day',
  track_unauthorized:        'Track unauthorized breaks',
  unauthorized_deduct:       'Deduct unauthorized break time',
  geo_mandatory:             'Geo-location mandatory',
  selfie_required:           'Selfie punch required',
  offline_allowed:           'Allow offline punch',
  travel_allowance:          'Track travel allowance',
  biometric_mandatory:       'Biometric punch mandatory',
  shift_lock:                'Shift lock (no early punch-out)',
  gate_pass_required:        'Gate pass required',
  safety_check_required:     'Safety compliance check',
};

const BOOLEAN_FIELDS = new Set([
  'auto_deduct','requires_approval','track_unauthorized','unauthorized_deduct',
  'geo_mandatory','selfie_required','offline_allowed','travel_allowance',
  'biometric_mandatory','shift_lock','gate_pass_required','safety_check_required',
]);

const DROPDOWN_FIELDS = {
  penalty_type: ['half_day', 'full_day', 'salary_deduct'],
};

function PolicyCard({ policy, onEdit, onDelete, onToggleActive }) {
  const [expanded, setExpanded] = useState(false);
  const [toggling, setToggling] = useState(false);
  const typeInfo = POLICY_TYPES.find(t => t.id === policy.policy_type) || POLICY_TYPES[0];
  const Icon = typeInfo.icon;
  const rules = typeof policy.rules === 'string' ? JSON.parse(policy.rules) : (policy.rules || {});

  const handleToggle = async (e) => {
    e.stopPropagation();
    setToggling(true);
    try { await onToggleActive(policy); } finally { setToggling(false); }
  };

  return (
    <div style={{ ...CARD, marginBottom: 12, padding: 0, overflow: 'hidden' }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px',
          cursor: 'pointer',
        }}
        onClick={() => setExpanded(e => !e)}
      >
        <div style={{
          width: 40, height: 40, borderRadius: 10,
          background: typeInfo.color + '20',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <Icon size={18} color={typeInfo.color} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, color: '#111827', fontSize: 15 }}>{policy.name}</div>
          <div style={{ fontSize: 12, color: '#9ca3af' }}>{typeInfo.label}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Quick active/inactive toggle */}
          <button
            onClick={handleToggle}
            disabled={toggling}
            title={policy.is_active ? 'Click to deactivate' : 'Click to activate'}
            style={{
              padding: '2px 10px', borderRadius: 99, fontSize: 11, fontWeight: 600,
              background: policy.is_active ? '#dcfce7' : '#f3f4f6',
              color: policy.is_active ? '#166534' : '#6b7280',
              border: 'none', cursor: toggling ? 'not-allowed' : 'pointer',
              opacity: toggling ? 0.6 : 1, transition: 'opacity 0.15s',
            }}
          >
            {policy.is_active ? 'Active' : 'Inactive'}
          </button>
          <button
            onClick={e => { e.stopPropagation(); onEdit(policy); }}
            style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 6, borderRadius: 6 }}
          >
            <Edit2 size={14} color="#6b7280" />
          </button>
          <button
            onClick={e => { e.stopPropagation(); onDelete(policy.id); }}
            style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 6, borderRadius: 6 }}
          >
            <Trash2 size={14} color="#ef4444" />
          </button>
          {expanded ? <ChevronUp size={16} color="#9ca3af" /> : <ChevronDown size={16} color="#9ca3af" />}
        </div>
      </div>

      {expanded && (
        <div style={{ borderTop: '1px solid #f0f0f4', padding: '16px 20px', background: '#fafafa' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
            {Object.entries(rules).map(([key, val]) => (
              <div key={key} style={{ fontSize: 13 }}>
                <span style={{ color: '#6b7280' }}>{RULE_LABELS[key] || key}:</span>{' '}
                <span style={{ fontWeight: 600, color: '#111827' }}>
                  {typeof val === 'boolean' ? (val ? 'Yes' : 'No') : String(val)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PolicyForm({ initial, onSave, onCancel }) {
  const isEdit = !!initial?.id;
  const [form, setForm] = useState({
    policy_type: initial?.policy_type || 'late',
    name:        initial?.name        || '',
    is_active:   initial?.is_active   !== false,
    rules:       typeof initial?.rules === 'string'
      ? JSON.parse(initial.rules)
      : (initial?.rules || { ...DEFAULT_RULES.late }),
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState('');

  const updateRules = (key, val) => setForm(f => ({ ...f, rules: { ...f.rules, [key]: val } }));

  const handleTypeChange = (t) => {
    setForm(f => ({ ...f, policy_type: t, rules: { ...(DEFAULT_RULES[t] || {}) } }));
  };

  const handleSave = async () => {
    if (!form.name.trim()) { setErr('Policy name is required'); return; }
    setSaving(true);
    setErr('');
    try {
      await onSave(form);
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to save policy');
    } finally {
      setSaving(false);
    }
  };

  const currentRules = DEFAULT_RULES[form.policy_type] || {};

  return (
    <div style={{ ...CARD, marginBottom: 20 }}>
      <div style={{ fontWeight: 600, color: '#111827', fontSize: 16, marginBottom: 20 }}>
        {isEdit ? 'Edit Policy' : 'New Attendance Policy'}
      </div>

      {err && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 14px', background: '#fff1f2', borderRadius: 8, marginBottom: 16, border: '1px solid #fecdd3', color: '#991b1b', fontSize: 13 }}>
          <AlertCircle size={14} /> {err}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
        <div>
          <label style={{ fontSize: 13, color: '#374151', fontWeight: 500, display: 'block', marginBottom: 6 }}>
            Policy Type
          </label>
          <select
            value={form.policy_type}
            onChange={e => handleTypeChange(e.target.value)}
            disabled={isEdit}
            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 14 }}
          >
            {POLICY_TYPES.map(t => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 13, color: '#374151', fontWeight: 500, display: 'block', marginBottom: 6 }}>
            Policy Name *
          </label>
          <input
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="e.g. Standard Late Policy"
            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 14, boxSizing: 'border-box' }}
          />
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 14 }}>Policy Rules</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
          {Object.keys(currentRules).map(key => {
            const val = form.rules[key] !== undefined ? form.rules[key] : currentRules[key];
            if (BOOLEAN_FIELDS.has(key)) {
              return (
                <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: '#f9fafb', borderRadius: 8 }}>
                  <span style={{ fontSize: 13, color: '#374151' }}>{RULE_LABELS[key] || key}</span>
                  <button
                    onClick={() => updateRules(key, !val)}
                    style={{
                      width: 40, height: 22, borderRadius: 99, border: 'none', cursor: 'pointer',
                      background: val ? P : '#d1d5db', position: 'relative', transition: 'background 0.2s',
                    }}
                  >
                    <div style={{
                      width: 18, height: 18, borderRadius: '50%', background: '#fff',
                      position: 'absolute', top: 2,
                      left: val ? 20 : 2, transition: 'left 0.2s',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                    }} />
                  </button>
                </div>
              );
            }
            if (DROPDOWN_FIELDS[key]) {
              return (
                <div key={key}>
                  <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>{RULE_LABELS[key] || key}</label>
                  <select
                    value={val}
                    onChange={e => updateRules(key, e.target.value)}
                    style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13 }}
                  >
                    {DROPDOWN_FIELDS[key].map(o => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}
                  </select>
                </div>
              );
            }
            return (
              <div key={key}>
                <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>{RULE_LABELS[key] || key}</label>
                <input
                  type="number"
                  value={val}
                  onChange={e => updateRules(key, parseFloat(e.target.value) || 0)}
                  step={key.includes('multiplier') ? 0.25 : 1}
                  min={0}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13, boxSizing: 'border-box' }}
                />
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: '9px 22px', borderRadius: 8, border: 'none',
            background: P, color: '#fff', fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', fontSize: 14,
          }}
        >
          {saving ? 'Saving…' : (isEdit ? 'Save Changes' : 'Create Policy')}
        </button>
        <button
          onClick={onCancel}
          style={{ padding: '9px 22px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 14 }}
        >
          Cancel
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 8, cursor: 'pointer', fontSize: 13, color: '#374151' }}>
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))}
          />
          Active
        </label>
      </div>
    </div>
  );
}

export default function AttendancePolicies() {
  const [policies, setPolicies] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [toast, setToast]       = useState(null);
  const [filter, setFilter]     = useState('all');
  const isMounted = useRef(true);

  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/attendance/policies');
      if (isMounted.current) setPolicies(res.data || []);
    } catch {
      if (isMounted.current) setPolicies([]);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const showMsg = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => { if (isMounted.current) setToast(null); }, 3500);
  };

  const handleSave = async (form) => {
    if (editItem?.id) {
      await api.put(`/attendance/policies/${editItem.id}`, form);
      showMsg('Policy updated successfully');
    } else {
      await api.post('/attendance/policies', form);
      showMsg('Policy created successfully');
    }
    setShowForm(false);
    setEditItem(null);
    load();
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this policy?')) return;
    await api.delete(`/attendance/policies/${id}`);
    showMsg('Policy deleted', 'info');
    load();
  };

  const handleEdit = (policy) => {
    setEditItem(policy);
    setShowForm(true);
  };

  const handleToggleActive = async (policy) => {
    const rules = typeof policy.rules === 'string' ? JSON.parse(policy.rules) : (policy.rules || {});
    await api.put(`/attendance/policies/${policy.id}`, {
      name: policy.name,
      rules,
      is_active: !policy.is_active,
    });
    showMsg(`Policy ${!policy.is_active ? 'activated' : 'deactivated'}`);
    load();
  };

  const filtered = filter === 'all' ? policies : policies.filter(p => p.policy_type === filter);

  return (
    <div style={{ padding: 24, margin: '0 auto' }}>
      {toast && (
        <div style={{
          position: 'fixed', top: 20, right: 20, zIndex: 9999,
          padding: '12px 18px', borderRadius: 10,
          background: toast.type === 'error' ? '#fee2e2' : '#dcfce7',
          border: `1px solid ${toast.type === 'error' ? '#fca5a5' : '#86efac'}`,
          color: toast.type === 'error' ? '#991b1b' : '#166534',
          display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 500,
          boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
        }}>
          {toast.type === 'error' ? <AlertCircle size={15} /> : <CheckCircle size={15} />}
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111827', margin: 0 }}>Attendance Policy Engine</h1>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>
            Configure late, overtime, break, and compliance policies for your workforce
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={load} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#374151' }}>
            <RefreshCw size={13} /> Refresh
          </button>
          {!showForm && (
            <button
              onClick={() => { setEditItem(null); setShowForm(true); }}
              style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: P, color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', gap: 7 }}
            >
              <Plus size={15} /> New Policy
            </button>
          )}
        </div>
      </div>

      {/* Policy type overview cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 24 }}>
        {POLICY_TYPES.map(t => {
          const count = policies.filter(p => p.policy_type === t.id && p.is_active).length;
          const Icon  = t.icon;
          return (
            <div
              key={t.id}
              onClick={() => setFilter(filter === t.id ? 'all' : t.id)}
              style={{
                ...CARD, padding: 16, cursor: 'pointer',
                border: filter === t.id ? `1.5px solid ${t.color}` : '1px solid #f0f0f4',
                background: filter === t.id ? t.color + '08' : '#fff',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <Icon size={18} color={t.color} />
                <span style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{t.label}</span>
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: t.color }}>{count}</div>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>active {count === 1 ? 'policy' : 'policies'}</div>
            </div>
          );
        })}
      </div>

      {showForm && (
        <PolicyForm
          initial={editItem}
          onSave={handleSave}
          onCancel={() => { setShowForm(false); setEditItem(null); }}
        />
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Loading policies…</div>
      ) : filtered.length === 0 ? (
        <div style={{ ...CARD, textAlign: 'center', padding: 60, color: '#9ca3af' }}>
          <Shield size={36} color="#e5e7eb" style={{ marginBottom: 12 }} />
          <div>No policies configured yet.</div>
          <div style={{ fontSize: 13, marginTop: 6 }}>Create your first attendance policy to get started.</div>
        </div>
      ) : (
        filtered.map(p => (
          <PolicyCard key={p.id} policy={p} onEdit={handleEdit} onDelete={handleDelete} onToggleActive={handleToggleActive} />
        ))
      )}
    </div>
  );
}
