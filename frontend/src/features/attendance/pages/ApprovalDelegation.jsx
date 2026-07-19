import React, { useState, useEffect, useCallback } from 'react';
import {
  UserCheck, Plus, Trash2, RefreshCw, Check, AlertTriangle,
  Calendar, ArrowRight, Shield,
} from 'lucide-react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const P    = '#6B3FDB';
const CARD = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 24 };
const INP  = { border: '1px solid #e9e4ff', borderRadius: 8, padding: '8px 12px', fontSize: 13, width: '100%', outline: 'none', boxSizing: 'border-box' };

const DELEGATION_TYPES = [
  { value: 'all',             label: 'All Approvals'           },
  { value: 'overtime',        label: 'Overtime Only'           },
  { value: 'regularization',  label: 'Regularization Only'     },
  { value: 'leave',           label: 'Leave Only'              },
];

const EMPTY = { delegator_id: '', delegate_id: '', from_date: '', to_date: '', delegation_type: 'all', reason: '' };

export default function ApprovalDelegation() {
  const today = new Date().toISOString().slice(0, 10);

  const [delegations, setDelegations] = useState([]);
  const [employees,   setEmployees]   = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [form,        setForm]        = useState({ ...EMPTY, from_date: today, to_date: today });
  const [saving,      setSaving]      = useState(false);
  const [msg,         setMsg]         = useState({ text: '', ok: true });
  const [removeId,    setRemoveId]    = useState(null);

  const flash = (text, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg({ text: '', ok: true }), 3500);
  };

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [dRes, eRes] = await Promise.allSettled([
        api.get('/attendance/approval-delegations'),
        api.get('/employees?status=active&limit=500'),
      ]);
      if (dRes.status === 'fulfilled') setDelegations(Array.isArray(dRes.value.data) ? dRes.value.data : []);
      if (eRes.status === 'fulfilled') {
        const d = eRes.value.data;
        setEmployees(d?.employees || d || []);
      }
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    const { delegator_id, delegate_id, from_date, to_date } = form;
    if (!delegator_id || !delegate_id || !from_date || !to_date) {
      flash('Delegator, delegate, and date range are required', false); return;
    }
    if (from_date > to_date) { flash('From date must be before to date', false); return; }
    if (String(delegator_id) === String(delegate_id)) {
      flash('Delegator and delegate must be different people', false); return;
    }
    setSaving(true);
    try {
      const res = await api.post('/attendance/approval-delegations', form);
      setDelegations(prev => {
        const exists = prev.find(d => d.id === res.data.id);
        return exists ? prev.map(d => d.id === res.data.id ? res.data : d) : [res.data, ...prev];
      });
      setForm({ ...EMPTY, from_date: today, to_date: today });
      flash('Delegation created');
    } catch (e) {
      flash(e?.response?.data?.error || 'Failed to save', false);
    } finally { setSaving(false); }
  };

  const handleRemove = async (id) => {
    try {
      await api.delete(`/attendance/approval-delegations/${id}`);
      setDelegations(prev => prev.filter(d => d.id !== id));
      setRemoveId(null);
      flash('Delegation deactivated');
    } catch { flash('Failed to remove', false); }
  };

  const isActive = (d) => d.is_active && d.to_date >= today;
  const active   = delegations.filter(isActive);
  const past     = delegations.filter(d => !isActive(d));

  const empName = (id) => {
    const e = employees.find(emp => String(emp.id) === String(id));
    if (!e) return `#${id}`;
    return e.name || `${e.first_name || ''} ${e.last_name || ''}`.trim();
  };

  return (
    <div style={{ padding: 24, fontFamily: 'Inter, sans-serif' }}>
      <ConfirmDialog
        open={removeId !== null}
        title="Deactivate Delegation"
        message="Deactivate this approval delegation? The delegated approvals will stop immediately."
        confirmLabel="Deactivate"
        variant="warning"
        onConfirm={() => handleRemove(removeId)}
        onCancel={() => setRemoveId(null)}
      />

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: '#f5f3ff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <UserCheck size={18} color={P} />
            </div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#1f2937' }}>Approval Delegation</h2>
          </div>
          <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
            Temporarily delegate approval authority when a manager is unavailable
          </p>
        </div>
        <button onClick={load}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', fontSize: 13, cursor: 'pointer' }}>
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {msg.text && (
        <div style={{ background: msg.ok ? '#f0fdf4' : '#fef2f2', border: `1px solid ${msg.ok ? '#86efac' : '#fca5a5'}`, borderRadius: 8, padding: '10px 14px', marginBottom: 16, color: msg.ok ? '#15803d' : '#dc2626', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          {msg.ok ? <Check size={13} /> : <AlertTriangle size={13} />} {msg.text}
        </div>
      )}

      {/* Add delegation form */}
      <div style={{ ...CARD, marginBottom: 24 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Plus size={14} color={P} /> New Delegation
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14, marginBottom: 14 }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', display: 'block', marginBottom: 4 }}>DELEGATOR (away manager) *</label>
            <select style={INP} value={form.delegator_id} onChange={e => set('delegator_id', e.target.value)}>
              <option value="">Select manager…</option>
              {employees.map(e => (
                <option key={e.id} value={e.id}>
                  {e.name || `${e.first_name || ''} ${e.last_name || ''}`.trim()} — {e.department || ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', display: 'block', marginBottom: 4 }}>DELEGATE (acting approver) *</label>
            <select style={INP} value={form.delegate_id} onChange={e => set('delegate_id', e.target.value)}>
              <option value="">Select delegate…</option>
              {employees.filter(e => String(e.id) !== String(form.delegator_id)).map(e => (
                <option key={e.id} value={e.id}>
                  {e.name || `${e.first_name || ''} ${e.last_name || ''}`.trim()} — {e.department || ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', display: 'block', marginBottom: 4 }}>DELEGATION TYPE</label>
            <select style={INP} value={form.delegation_type} onChange={e => set('delegation_type', e.target.value)}>
              {DELEGATION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', display: 'block', marginBottom: 4 }}>FROM DATE *</label>
            <input type="date" style={INP} value={form.from_date} onChange={e => set('from_date', e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', display: 'block', marginBottom: 4 }}>TO DATE *</label>
            <input type="date" style={INP} value={form.to_date} min={form.from_date} onChange={e => set('to_date', e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', display: 'block', marginBottom: 4 }}>REASON</label>
            <input style={INP} placeholder="e.g. On leave, Training…" value={form.reason} onChange={e => set('reason', e.target.value)} />
          </div>
        </div>
        <button onClick={handleSave} disabled={saving}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', borderRadius: 9, border: 'none', background: P, color: '#fff', fontWeight: 700, fontSize: 13, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
          <UserCheck size={14} /> {saving ? 'Creating…' : 'Create Delegation'}
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af', fontSize: 14 }}>Loading delegations…</div>
      ) : (
        <>
          {/* Active delegations */}
          <div style={{ ...CARD, padding: 0, overflow: 'hidden', marginBottom: 20 }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid #f0f0f4', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Shield size={15} color="#10b981" />
              <span style={{ fontWeight: 700, fontSize: 14, color: '#1f2937' }}>Active Delegations</span>
              <span style={{ fontSize: 12, color: '#9ca3af' }}>({active.length})</span>
            </div>
            {active.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
                No active delegations. Create one above to delegate approval authority.
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#fafafa', borderBottom: '2px solid #f0f0f4' }}>
                    {['Delegator', 'Arrow', 'Delegate', 'Type', 'Period', 'Reason', ''].map((h, i) => (
                      <th key={i} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600, color: '#6b7280', fontSize: 11, textTransform: 'uppercase' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {active.map(d => (
                    <tr key={d.id} style={{ borderBottom: '1px solid #f5f5f7' }}>
                      <td style={{ padding: '11px 14px', fontWeight: 600, color: '#1f2937' }}>
                        {d.delegator_name || empName(d.delegator_id)}
                        {d.delegator_designation && <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>{d.delegator_designation}</div>}
                      </td>
                      <td style={{ padding: '11px 8px', textAlign: 'center' }}>
                        <ArrowRight size={14} color={P} />
                      </td>
                      <td style={{ padding: '11px 14px', fontWeight: 600, color: '#059669' }}>
                        {d.delegate_name || empName(d.delegate_id)}
                        {d.delegate_designation && <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>{d.delegate_designation}</div>}
                      </td>
                      <td style={{ padding: '11px 14px' }}>
                        <span style={{ background: '#f5f3ff', color: P, borderRadius: 8, padding: '2px 9px', fontSize: 12, fontWeight: 600 }}>
                          {DELEGATION_TYPES.find(t => t.value === d.delegation_type)?.label || d.delegation_type}
                        </span>
                      </td>
                      <td style={{ padding: '11px 14px', fontSize: 12, color: '#374151', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <Calendar size={11} color="#9ca3af" />
                          {new Date(d.from_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                          {' → '}
                          {new Date(d.to_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                        </div>
                      </td>
                      <td style={{ padding: '11px 14px', color: '#6b7280', fontSize: 12, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {d.reason || '—'}
                      </td>
                      <td style={{ padding: '11px 14px' }}>
                        <button onClick={() => setRemoveId(d.id)}
                          style={{ border: 'none', background: '#fef2f2', color: '#ef4444', borderRadius: 6, padding: '5px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                          title="Deactivate">
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Past delegations */}
          {past.length > 0 && (
            <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid #f0f0f4' }}>
                <span style={{ fontWeight: 600, fontSize: 13, color: '#6b7280' }}>Past / Expired Delegations ({past.length})</span>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <tbody>
                  {past.slice(0, 10).map(d => (
                    <tr key={d.id} style={{ borderBottom: '1px solid #f5f5f7', opacity: 0.6 }}>
                      <td style={{ padding: '9px 14px', fontWeight: 500, color: '#374151' }}>{d.delegator_name || empName(d.delegator_id)}</td>
                      <td style={{ padding: '9px 8px', textAlign: 'center' }}><ArrowRight size={13} color="#9ca3af" /></td>
                      <td style={{ padding: '9px 14px', color: '#374151' }}>{d.delegate_name || empName(d.delegate_id)}</td>
                      <td style={{ padding: '9px 14px', fontSize: 12, color: '#6b7280' }}>
                        {new Date(d.from_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                        {' → '}
                        {new Date(d.to_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                      </td>
                      <td style={{ padding: '9px 14px' }}>
                        <span style={{ background: '#f3f4f6', color: '#6b7280', borderRadius: 8, padding: '2px 8px', fontSize: 11 }}>Expired</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
