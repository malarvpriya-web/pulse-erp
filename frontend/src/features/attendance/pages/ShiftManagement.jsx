import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Clock, Plus, Edit2, Trash2, Copy, Users,
  X, Check, AlertCircle, Moon, Coffee, Zap,
} from 'lucide-react';

import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

const P = '#6B3FDB';
const CARD = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 24 };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SHIFT_COLORS = ['#6B3FDB','#0369a1','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316'];
const DEFAULT_ROLE_GRACE = { office: 15, field: 25, manager: 10 };

const EMPTY_SHIFT = {
  name: '', start_time: '09:00', end_time: '18:00', grace_minutes: 15,
  color: '#6B3FDB', departments: [], ot_eligible: true,
  weekly_off: ['Sun'], is_night_shift: false, break_duration: 30,
  half_day_hours: 4, role_grace_minutes: { ...DEFAULT_ROLE_GRACE }, capacity: 0,
};

function fmt12(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function parseArr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } }
  return [];
}

function parseObj(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } }
  return {};
}

// ── Shift create/edit modal ─────────────────────────────────────────────────
function ShiftFormModal({ shift, departments, onSave, onClose }) {
  const [form, setForm] = useState(() => {
    if (!shift) return { ...EMPTY_SHIFT };
    return {
      ...EMPTY_SHIFT,
      ...shift,
      start_time: shift.start_time || shift.start || '09:00',
      end_time:   shift.end_time   || shift.end   || '18:00',
      weekly_off: parseArr(shift.weekly_off || shift.weekly_off_days || ['Sun']),
      departments: parseArr(shift.departments || []),
      role_grace_minutes: parseObj(shift.role_grace_minutes) || { ...DEFAULT_ROLE_GRACE },
    };
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const toggleDay = day => set('weekly_off',
    form.weekly_off.includes(day)
      ? form.weekly_off.filter(d => d !== day)
      : [...form.weekly_off, day]);

  const toggleDept = d => set('departments',
    form.departments.includes(d)
      ? form.departments.filter(x => x !== d)
      : [...form.departments, d]);

  const handleSave = async () => {
    if (!form.name.trim()) { setErr('Shift name is required'); return; }
    if (!form.start_time || !form.end_time) { setErr('Start and end time required'); return; }
    setSaving(true); setErr('');
    const payload = {
      ...form,
      start: form.start_time,
      end:   form.end_time,
      weekly_off_days: form.weekly_off,
      departments: Array.isArray(form.departments) ? form.departments : [],
    };
    try {
      const res = form.id
        ? await api.put(`/hr/shifts/${form.id}`, payload)
        : await api.post('/hr/shifts', payload);
      onSave(res.data);
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to save shift');
    } finally {
      setSaving(false);
    }
  };

  const inp = {
    border: '1px solid #e9e4ff', borderRadius: 8, padding: '8px 12px',
    fontSize: 14, width: '100%', outline: 'none', boxSizing: 'border-box',
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 580, maxHeight: '90vh', overflow: 'auto', padding: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{form.id ? 'Edit Shift' : 'Create Shift'}</h2>
          <button onClick={onClose} style={{ border: 'none', background: '#f5f3ff', borderRadius: 8, padding: 6, cursor: 'pointer' }}><X size={16} /></button>
        </div>

        {err && (
          <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: 10, marginBottom: 14, color: '#dc2626', fontSize: 13 }}>
            {err}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div style={{ gridColumn: '1/-1' }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>SHIFT NAME *</label>
            <input style={inp} value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. General Shift" />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>START TIME *</label>
            <input style={inp} type="time" value={form.start_time} onChange={e => set('start_time', e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>END TIME *</label>
            <input style={inp} type="time" value={form.end_time} onChange={e => set('end_time', e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>GRACE PERIOD (min)</label>
            <input style={inp} type="number" value={form.grace_minutes} onChange={e => set('grace_minutes', parseInt(e.target.value) || 0)} min={0} max={120} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>BREAK DURATION (min)</label>
            <input style={inp} type="number" value={form.break_duration} onChange={e => set('break_duration', parseInt(e.target.value) || 0)} min={0} max={120} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>HALF DAY THRESHOLD (hrs)</label>
            <input style={inp} type="number" value={form.half_day_hours} onChange={e => set('half_day_hours', parseFloat(e.target.value) || 4)} min={1} max={8} step={0.5} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>SHIFT CAPACITY</label>
            <input style={inp} type="number" value={form.capacity} onChange={e => set('capacity', parseInt(e.target.value) || 0)} min={0} placeholder="0 = unlimited" />
          </div>

          <div style={{ gridColumn: '1/-1' }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 6 }}>ROLE-WISE GRACE (min)</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              {['office', 'field', 'manager'].map(role => (
                <div key={role}>
                  <label style={{ fontSize: 10, color: '#9ca3af', display: 'block', marginBottom: 2 }}>{role.toUpperCase()}</label>
                  <input style={inp} type="number" min={0} max={90}
                    value={form.role_grace_minutes?.[role] ?? DEFAULT_ROLE_GRACE[role]}
                    onChange={e => set('role_grace_minutes', { ...(form.role_grace_minutes || {}), [role]: +e.target.value })} />
                </div>
              ))}
            </div>
          </div>

          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>SHIFT COLOR</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {SHIFT_COLORS.map(c => (
                <button key={c} onClick={() => set('color', c)}
                  style={{ width: 28, height: 28, borderRadius: '50%', background: c, border: form.color === c ? '3px solid #1f2937' : '2px solid transparent', cursor: 'pointer' }} />
              ))}
            </div>
          </div>

          <div style={{ gridColumn: '1/-1' }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 6 }}>WEEKLY OFFS</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {DAYS.map(d => (
                <button key={d} onClick={() => toggleDay(d)}
                  style={{ padding: '4px 12px', borderRadius: 20, border: '1px solid', fontSize: 12, cursor: 'pointer', fontWeight: 500,
                    background: form.weekly_off.includes(d) ? P : '#f5f3ff',
                    borderColor: form.weekly_off.includes(d) ? P : '#e9e4ff',
                    color: form.weekly_off.includes(d) ? '#fff' : '#4b5563' }}>
                  {d}
                </button>
              ))}
            </div>
          </div>

          {departments.length > 0 && (
            <div style={{ gridColumn: '1/-1' }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 6 }}>DEPARTMENTS</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {departments.map(d => (
                  <button key={d} onClick={() => toggleDept(d)}
                    style={{ padding: '4px 12px', borderRadius: 20, border: '1px solid', fontSize: 12, cursor: 'pointer', fontWeight: 500,
                      background: form.departments.includes(d) ? P : '#f5f3ff',
                      borderColor: form.departments.includes(d) ? P : '#e9e4ff',
                      color: form.departments.includes(d) ? '#fff' : '#4b5563' }}>
                    {d}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input type="checkbox" id="ot" checked={!!form.ot_eligible} onChange={e => set('ot_eligible', e.target.checked)} style={{ accentColor: P }} />
            <label htmlFor="ot" style={{ fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>OT Eligible</label>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input type="checkbox" id="ns" checked={!!form.is_night_shift} onChange={e => set('is_night_shift', e.target.checked)} style={{ accentColor: P }} />
            <label htmlFor="ns" style={{ fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>Night Shift</label>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 22, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #e9e4ff', background: '#fff', fontSize: 14, cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleSave} disabled={saving}
            style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: P, color: '#fff', fontSize: 14, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving…' : form.id ? 'Update Shift' : 'Create Shift'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Per-shift bulk employee assignment panel ────────────────────────────────
function AssignPanel({ shift, onClose }) {
  const toast = useToast();
  const [assignments, setAssignments] = useState([]);
  const [allEmployees, setAllEmployees] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const [aRes, eRes] = await Promise.allSettled([
          api.get(`/attendance/shifts/${shift.id}/assignments`),
          api.get('/employees?limit=200'),
        ]);
        const EX = new Set(['left','terminated','resigned','ex-employee','notice_period','notice period','inactive']);
        setAssignments(aRes.status === 'fulfilled' ? aRes.value.data : []);
        const raw = eRes.status === 'fulfilled' ? (eRes.value.data.employees || eRes.value.data) : [];
        setAllEmployees((Array.isArray(raw) ? raw : []).filter(e => !EX.has((e.status || '').toLowerCase())));
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [shift.id]);

  const assignedIds = new Set(assignments.map(a => a.employee_id || a.id));

  const available = allEmployees.filter(e => {
    const name = (e.name || `${e.first_name} ${e.last_name}`).toLowerCase();
    return !assignedIds.has(e.id) && name.includes(search.toLowerCase());
  });

  const assign = async (empId) => {
    setAdding(true);
    try {
      await api.post(`/attendance/shifts/${shift.id}/assign`, { employee_ids: [empId] });
      const emp = allEmployees.find(e => e.id === empId);
      setAssignments(prev => [...prev, {
        id: Date.now(), employee_id: empId,
        employee_name: emp?.name || `${emp?.first_name} ${emp?.last_name}`,
        department: emp?.department, designation: emp?.designation,
      }]);
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed to assign employee'); } finally { setAdding(false); }
  };

  const unassign = async (assignmentId) => {
    try {
      await api.delete(`/attendance/shifts/assign/${assignmentId}`);
      setAssignments(prev => prev.filter(a => a.id !== assignmentId));
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed to remove assignment'); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 640, maxHeight: '90vh', overflow: 'auto', padding: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Assign Employees</h2>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
              {shift.name} · {fmt12(shift.start_time || shift.start)} – {fmt12(shift.end_time || shift.end)}
            </p>
          </div>
          <button onClick={onClose} style={{ border: 'none', background: '#f5f3ff', borderRadius: 8, padding: 6, cursor: 'pointer' }}><X size={16} /></button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <p style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>
              Assigned ({assignments.length})
            </p>
            {loading ? <p style={{ color: '#9ca3af', fontSize: 13 }}>Loading…</p> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 380, overflow: 'auto' }}>
                {assignments.map(a => (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', borderRadius: 8, background: '#f5f3ff', border: '1px solid #e9e4ff' }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{a.employee_name}</div>
                      <div style={{ fontSize: 11, color: '#6b7280' }}>{a.department} · {a.designation}</div>
                    </div>
                    <button onClick={() => unassign(a.id)} style={{ border: 'none', background: '#fef2f2', borderRadius: 6, padding: 4, cursor: 'pointer', color: '#dc2626' }}><X size={12} /></button>
                  </div>
                ))}
                {assignments.length === 0 && <p style={{ fontSize: 13, color: '#9ca3af' }}>No employees assigned yet</p>}
              </div>
            )}
          </div>

          <div>
            <p style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>Add Employees</p>
            <input
              style={{ border: '1px solid #e9e4ff', borderRadius: 8, padding: '7px 10px', fontSize: 13, width: '100%', marginBottom: 8, outline: 'none' }}
              placeholder="Search employees…" value={search} onChange={e => setSearch(e.target.value)}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 340, overflow: 'auto' }}>
              {available.slice(0, 30).map(e => (
                <div key={e.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 10px', borderRadius: 8, background: '#f9fafb', border: '1px solid #f0f0f4' }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{e.name || `${e.first_name} ${e.last_name}`}</div>
                    <div style={{ fontSize: 11, color: '#6b7280' }}>{e.department}</div>
                  </div>
                  <button onClick={() => assign(e.id)} disabled={adding}
                    style={{ border: 'none', background: '#f5f3ff', borderRadius: 6, padding: 4, cursor: 'pointer', color: P }}><Plus size={12} /></button>
                </div>
              ))}
              {available.length === 0 && <p style={{ fontSize: 13, color: '#9ca3af' }}>No matching employees</p>}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 16, textAlign: 'right' }}>
          <button onClick={onClose} style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: P, color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Done</button>
        </div>
      </div>
    </div>
  );
}

// ── Individual shift override section ───────────────────────────────────────
function IndividualOverride({ shifts, employees }) {
  const toast = useToast();
  const [assignments, setAssignments] = useState([]);
  const [form, setForm] = useState({ employee_id: '', shift_id: '', effective_from: '', note: '' });
  const isMounted = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  useEffect(() => {
    api.get('/hr/shift-assignments')
      .then(res => { if (isMounted.current) setAssignments(Array.isArray(res.data) ? res.data : (res.data?.results ?? [])); })
      .catch(() => { if (isMounted.current) setAssignments([]); });
  }, []);

  const findEmp   = id => employees.find(e => String(e.id) === String(id));
  const findShift = id => shifts.find(s => Number(s.id) === Number(id));

  const handleAssign = async () => {
    if (!form.employee_id || !form.shift_id || !form.effective_from) return;
    try {
      const res = await api.post('/hr/shift-assignments', {
        employee_id: Number(form.employee_id),
        shift_id: Number(form.shift_id),
        effective_from: form.effective_from,
        note: form.note || '',
      });
      if (isMounted.current) {
        setAssignments(prev => [res.data, ...prev]);
        setForm({ employee_id: '', shift_id: '', effective_from: '', note: '' });
      }
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed to create assignment'); }
  };

  const handleRemove = async (id) => {
    try {
      await api.delete(`/hr/shift-assignments/${id}`);
      if (isMounted.current) setAssignments(prev => prev.filter(a => a.id !== id));
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed to remove assignment'); }
  };

  const sel = { padding: '8px 10px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13, width: '100%' };

  return (
    <div style={{ ...CARD, marginTop: 24 }}>
      <h3 style={{ margin: '0 0 14px', fontSize: 16, fontWeight: 700 }}>Individual Employee Shift Override</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 12 }}>
        <select value={form.employee_id} onChange={e => setForm(f => ({ ...f, employee_id: e.target.value }))} style={sel}>
          <option value="">Select employee</option>
          {employees.map(e => (
            <option key={e.id} value={e.id}>{e.name || `${e.first_name} ${e.last_name}`}</option>
          ))}
        </select>
        <select value={form.shift_id} onChange={e => setForm(f => ({ ...f, shift_id: e.target.value }))} style={sel}>
          <option value="">Select shift</option>
          {shifts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input type="date" value={form.effective_from} onChange={e => setForm(f => ({ ...f, effective_from: e.target.value }))} style={sel} />
        <input value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} placeholder="Reason / note" style={sel} />
        <button onClick={handleAssign}
          style={{ padding: '9px 16px', borderRadius: 8, border: 'none', background: '#0f766e', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
          Assign Override
        </button>
      </div>
      {assignments.length > 0 && (
        <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 10 }}>
          <p style={{ margin: '0 0 8px', fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase' }}>
            Active Assignments ({assignments.length})
          </p>
          {assignments.slice(0, 8).map(a => {
            const emp = findEmp(a.employee_id);
            const sh  = findShift(a.shift_id);
            return (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #f8fafc', fontSize: 12 }}>
                <span>
                  <strong>{emp?.name || emp?.full_name || `Emp #${a.employee_id}`}</strong>
                  <span style={{ color: '#94a3b8', margin: '0 6px' }}>→</span>
                  <span style={{ color: '#0f766e', fontWeight: 600 }}>{sh?.name || `Shift #${a.shift_id}`}</span>
                  {a.effective_from && <span style={{ color: '#64748b', marginLeft: 6 }}>from {a.effective_from}</span>}
                  {a.note && <span style={{ color: '#94a3b8', marginLeft: 6, fontStyle: 'italic' }}>{a.note}</span>}
                </span>
                <button onClick={() => handleRemove(a.id)}
                  style={{ border: 'none', background: '#fee2e2', color: '#dc2626', borderRadius: 5, padding: '3px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}>
                  Remove
                </button>
              </div>
            );
          })}
          {assignments.length > 8 && <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>+{assignments.length - 8} more</p>}
        </div>
      )}
    </div>
  );
}

// ── Rotation schedule section ────────────────────────────────────────────────
function RotationSchedule({ shifts, departments }) {
  const toast = useToast();
  const [rotations, setRotations] = useState([]);
  const [form, setForm] = useState({
    team: '', week_1_shift_id: '', week_2_shift_id: '',
    week_3_shift_id: '', week_4_shift_id: '', effective_from: '',
  });
  const isMounted = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  useEffect(() => {
    api.get('/hr/shift-rotations')
      .then(res => { if (isMounted.current) setRotations(Array.isArray(res.data) ? res.data : (res.data?.results ?? [])); })
      .catch(() => { if (isMounted.current) setRotations([]); });
  }, []);

  const findShift = id => shifts.find(s => Number(s.id) === Number(id));
  const is4Week = !!(form.week_3_shift_id || form.week_4_shift_id);

  const handleAdd = async () => {
    if (!form.team || !form.week_1_shift_id || !form.week_2_shift_id || !form.effective_from) return;
    try {
      const payload = {
        team: form.team,
        week_1_shift_id: Number(form.week_1_shift_id),
        week_2_shift_id: Number(form.week_2_shift_id),
        effective_from: form.effective_from,
      };
      if (form.week_3_shift_id) payload.week_3_shift_id = Number(form.week_3_shift_id);
      if (form.week_4_shift_id) payload.week_4_shift_id = Number(form.week_4_shift_id);
      const res = await api.post('/hr/shift-rotations', payload);
      if (isMounted.current) {
        setRotations(prev => [res.data, ...prev]);
        setForm({ team: '', week_1_shift_id: '', week_2_shift_id: '', week_3_shift_id: '', week_4_shift_id: '', effective_from: '' });
      }
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed to add rotation'); }
  };

  const handleCancel = async (id) => {
    try {
      await api.delete(`/hr/shift-rotations/${id}`);
      if (isMounted.current) setRotations(prev => prev.filter(r => r.id !== id));
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed to cancel rotation'); }
  };

  const sel = { padding: '8px 10px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13, width: '100%' };

  return (
    <div style={{ ...CARD, marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Shift Rotation Schedule</h3>
        <span style={{ background: is4Week ? '#faf5ff' : '#f0f9ff', color: is4Week ? '#6B3FDB' : '#0369a1', borderRadius: 12, padding: '2px 10px', fontSize: 12, fontWeight: 600 }}>
          {is4Week ? '4-Week Cycle' : '2-Week Cycle'}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 12 }}>
        <select value={form.team} onChange={e => setForm(f => ({ ...f, team: e.target.value }))} style={sel}>
          <option value="">Select team / dept</option>
          {departments.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={form.week_1_shift_id} onChange={e => setForm(f => ({ ...f, week_1_shift_id: e.target.value }))} style={sel}>
          <option value="">Week 1 shift *</option>
          {shifts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={form.week_2_shift_id} onChange={e => setForm(f => ({ ...f, week_2_shift_id: e.target.value }))} style={sel}>
          <option value="">Week 2 shift *</option>
          {shifts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={form.week_3_shift_id} onChange={e => setForm(f => ({ ...f, week_3_shift_id: e.target.value }))} style={sel}>
          <option value="">Week 3 shift (optional)</option>
          {shifts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={form.week_4_shift_id} onChange={e => setForm(f => ({ ...f, week_4_shift_id: e.target.value }))} style={sel}>
          <option value="">Week 4 shift (optional)</option>
          {shifts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input type="date" value={form.effective_from} onChange={e => setForm(f => ({ ...f, effective_from: e.target.value }))} style={sel} />
        <button onClick={handleAdd}
          style={{ padding: '9px 16px', borderRadius: 8, border: 'none', background: '#6B3FDB', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
          Save Rotation
        </button>
      </div>
      <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: '8px 12px', fontSize: 12, color: '#0369a1', marginBottom: 10 }}>
        Fill Week 3 & 4 to enable 4-week cycle (A/B/C/D shift rotation for manufacturing). Leave blank for standard 2-week alternating rotation.
      </div>
      {rotations.length > 0 && (
        <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 10 }}>
          <p style={{ margin: '0 0 8px', fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase' }}>
            Active Rotations ({rotations.length})
          </p>
          {rotations.slice(0, 8).map(r => {
            const hasW34 = r.week_3_shift_id || r.week_4_shift_id;
            return (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #f8fafc', fontSize: 12 }}>
                <span>
                  <strong>{r.team}</strong>
                  <span style={{ marginLeft: 6, background: hasW34 ? '#faf5ff' : '#f0f9ff', color: hasW34 ? '#6B3FDB' : '#0369a1', borderRadius: 10, padding: '1px 6px', fontSize: 10, fontWeight: 600 }}>
                    {hasW34 ? '4W' : '2W'}
                  </span>
                  <span style={{ color: '#94a3b8', margin: '0 6px' }}>·</span>
                  W1: <span style={{ fontWeight: 600, color: '#1d4ed8' }}>{findShift(r.week_1_shift_id)?.name || `#${r.week_1_shift_id}`}</span>
                  <span style={{ color: '#94a3b8', margin: '0 6px' }}>·</span>
                  W2: <span style={{ fontWeight: 600, color: '#6B3FDB' }}>{findShift(r.week_2_shift_id)?.name || `#${r.week_2_shift_id}`}</span>
                  {r.week_3_shift_id && <><span style={{ color: '#94a3b8', margin: '0 6px' }}>·</span>W3: <span style={{ fontWeight: 600, color: '#0891b2' }}>{findShift(r.week_3_shift_id)?.name || `#${r.week_3_shift_id}`}</span></>}
                  {r.week_4_shift_id && <><span style={{ color: '#94a3b8', margin: '0 6px' }}>·</span>W4: <span style={{ fontWeight: 600, color: '#16a34a' }}>{findShift(r.week_4_shift_id)?.name || `#${r.week_4_shift_id}`}</span></>}
                  {r.effective_from && <span style={{ color: '#64748b', marginLeft: 6 }}>from {r.effective_from}</span>}
                </span>
                <button onClick={() => handleCancel(r.id)}
                  style={{ border: 'none', background: '#fee2e2', color: '#dc2626', borderRadius: 5, padding: '3px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}>
                  Cancel
                </button>
              </div>
            );
          })}
          {rotations.length > 8 && <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>+{rotations.length - 8} more</p>}
        </div>
      )}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────
export default function ShiftManagement() {
  const [shifts, setShifts]       = useState([]);
  const [loading, setLoading]     = useState(true);
  const [employees, setEmployees] = useState([]);
  const [departments, setDepts]   = useState([]);
  const [showForm, setShowForm]   = useState(false);
  const [editShift, setEditShift] = useState(null);
  const [assignShift, setAssignShift] = useState(null);
  const [deleteId, setDeleteId]   = useState(null);
  const [msg, setMsg]             = useState('');
  const isMounted = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const toast = (txt) => {
    setMsg(txt);
    setTimeout(() => { if (isMounted.current) setMsg(''); }, 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/hr/shifts');
      if (isMounted.current) setShifts(Array.isArray(res.data) ? res.data : (res.data?.results ?? []));
    } catch {
      if (isMounted.current) setShifts([]);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get('/employees?limit=500')
      .then(res => {
        if (!isMounted.current) return;
        const all = Array.isArray(res.data) ? res.data : (res.data?.employees || res.data?.results || []);
        setEmployees(all.filter(e => ['active', 'probation'].includes((e.status || '').toLowerCase())));
      })
      .catch(() => { if (isMounted.current) setEmployees([]); });

    api.get('/admin/config/departments')
      .then(res => {
        if (!isMounted.current) return;
        setDepts(Array.isArray(res.data) ? res.data.map(d => d.name || d) : []);
      })
      .catch(() => {
        if (isMounted.current) setDepts(['Engineering','HR','Finance','Sales','Operations','Support','Product','Marketing','Admin']);
      });
  }, []);

  const normaliseShift = (s) => ({
    ...s,
    start_time: s.start_time || s.start,
    end_time:   s.end_time   || s.end,
  });

  const handleSave = (saved) => {
    const ns = normaliseShift(saved);
    setShifts(prev => {
      const exists = prev.find(s => s.id === ns.id);
      return exists ? prev.map(s => s.id === ns.id ? ns : s) : [...prev, ns];
    });
    setShowForm(false); setEditShift(null);
    toast('Shift saved successfully');
  };

  const handleDuplicate = async (shift) => {
    try {
      const res = await api.post('/hr/shifts', {
        ...shift, name: `${shift.name} (Copy)`, id: undefined,
        start: shift.start_time || shift.start,
        end:   shift.end_time   || shift.end,
      });
      if (isMounted.current) setShifts(prev => [...prev, normaliseShift(res.data)]);
      toast('Shift duplicated');
    } catch (err) { toast(err?.response?.data?.error || 'Failed to duplicate shift'); }
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/hr/shifts/${id}`);
      if (isMounted.current) { setShifts(prev => prev.filter(s => s.id !== id)); setDeleteId(null); }
      toast('Shift deleted');
    } catch (e) {
      toast(e.response?.data?.error || 'Failed to delete shift');
      if (isMounted.current) setDeleteId(null);
    }
  };

  const totalEmployees = shifts.reduce((s, sh) => s + (parseInt(sh.employee_count || sh.employees_count) || 0), 0);

  return (
    <div style={{ padding: 24, fontFamily: 'Inter, sans-serif', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#1f2937' }}>Shift Management</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Configure work shifts, assign employees, manage rotations</p>
        </div>
        <button onClick={() => { setEditShift(null); setShowForm(true); }}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px', borderRadius: 10, border: 'none', background: P, color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
          <Plus size={16} /> Create Shift
        </button>
      </div>

      {msg && (
        <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '10px 14px', marginBottom: 16, color: '#15803d', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Check size={14} /> {msg}
        </div>
      )}

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16, marginBottom: 24 }}>
        {[
          { label: 'Total Shifts',       value: shifts.length,                                  icon: Clock,  color: P         },
          { label: 'Employees Assigned', value: totalEmployees,                                 icon: Users,  color: '#10b981' },
          { label: 'Night Shifts',       value: shifts.filter(s => s.is_night_shift).length,   icon: Moon,   color: '#0369a1' },
        ].map(k => (
          <div key={k.label} style={{ ...CARD, display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 44, height: 44, borderRadius: 10, background: `${k.color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <k.icon size={20} color={k.color} />
            </div>
            <div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#1f2937' }}>{k.value}</div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>{k.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Attendance color legend */}
      <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 14px', fontSize: 12, marginBottom: 20 }}>
        <strong>Attendance Color Legend:</strong> Each shift's color appears on the attendance calendar and in shift-wise late report filters.
        {shifts.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {shifts.map(s => (
              <span key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 20, padding: '3px 10px', fontSize: 11, fontWeight: 500 }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: s.color || P, display: 'inline-block', flexShrink: 0 }} />
                {s.name}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Shift cards */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Loading shifts…</div>
      ) : shifts.length === 0 ? (
        <div style={{ ...CARD, textAlign: 'center', padding: 60 }}>
          <Clock size={40} color="#d1d5db" style={{ marginBottom: 12 }} />
          <p style={{ color: '#9ca3af', margin: 0 }}>No shifts configured. Create your first shift.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
          {shifts.map(sh => (
            <div key={sh.id} style={{ ...CARD, borderLeft: `4px solid ${sh.color || P}`, position: 'relative' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: sh.color || P }} />
                  <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{sh.name}</h3>
                  {sh.is_night_shift && <Moon size={13} color="#0369a1" />}
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button title="Assign Employees" onClick={() => setAssignShift(sh)}
                    style={{ border: 'none', background: '#f5f3ff', borderRadius: 6, padding: 6, cursor: 'pointer', color: P }}><Users size={13} /></button>
                  <button title="Duplicate" onClick={() => handleDuplicate(sh)}
                    style={{ border: 'none', background: '#f0fdf4', borderRadius: 6, padding: 6, cursor: 'pointer', color: '#10b981' }}><Copy size={13} /></button>
                  <button title="Edit" onClick={() => { setEditShift(sh); setShowForm(true); }}
                    style={{ border: 'none', background: '#f0f9ff', borderRadius: 6, padding: 6, cursor: 'pointer', color: '#0369a1' }}><Edit2 size={13} /></button>
                  <button title="Delete" onClick={() => setDeleteId(sh.id)}
                    style={{ border: 'none', background: '#fef2f2', borderRadius: 6, padding: 6, cursor: 'pointer', color: '#dc2626' }}><Trash2 size={13} /></button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#1f2937' }}>{fmt12(sh.start_time || sh.start)}</div>
                  <div style={{ fontSize: 10, color: '#9ca3af' }}>START</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', color: '#d1d5db', fontSize: 18 }}>→</div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#1f2937' }}>{fmt12(sh.end_time || sh.end)}</div>
                  <div style={{ fontSize: 10, color: '#9ca3af' }}>END</div>
                </div>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                <span style={{ background: '#f5f3ff', color: P, borderRadius: 12, padding: '2px 8px', fontSize: 11, fontWeight: 500 }}>
                  <Clock size={10} style={{ verticalAlign: 'middle', marginRight: 3 }} />{sh.grace_minutes}min grace
                </span>
                <span style={{ background: '#f0fdf4', color: '#15803d', borderRadius: 12, padding: '2px 8px', fontSize: 11, fontWeight: 500 }}>
                  <Coffee size={10} style={{ verticalAlign: 'middle', marginRight: 3 }} />{sh.break_duration}min break
                </span>
                {sh.ot_eligible && (
                  <span style={{ background: '#fffbeb', color: '#d97706', borderRadius: 12, padding: '2px 8px', fontSize: 11, fontWeight: 500 }}>
                    <Zap size={10} style={{ verticalAlign: 'middle', marginRight: 3 }} />OT Eligible
                  </span>
                )}
                {sh.capacity > 0 && (
                  <span style={{ background: '#f0f9ff', color: '#0369a1', borderRadius: 12, padding: '2px 8px', fontSize: 11, fontWeight: 500 }}>
                    Cap: {sh.capacity}
                  </span>
                )}
              </div>

              {parseArr(sh.weekly_off || sh.weekly_off_days).length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <span style={{ fontSize: 11, color: '#9ca3af' }}>Weekly Off: </span>
                  {parseArr(sh.weekly_off || sh.weekly_off_days).map(d => (
                    <span key={d} style={{ marginRight: 4, fontSize: 11, color: '#6b7280', fontWeight: 500 }}>{d}</span>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #f0f0f4', paddingTop: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#6b7280' }}>
                  <Users size={12} /> {parseInt(sh.employee_count || sh.employees_count) || 0} employees assigned
                </div>
                <button onClick={() => setAssignShift(sh)}
                  style={{ border: 'none', background: '#f5f3ff', color: P, borderRadius: 6, padding: '4px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  Manage
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Individual override + rotation schedule */}
      <IndividualOverride shifts={shifts} employees={employees} />
      <RotationSchedule shifts={shifts} departments={departments} />

      {/* Delete confirm */}
      {deleteId && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: 28, maxWidth: 360, width: '100%', textAlign: 'center' }}>
            <AlertCircle size={36} color="#dc2626" style={{ marginBottom: 12 }} />
            <h3 style={{ margin: '0 0 8px', fontSize: 17 }}>Delete Shift?</h3>
            <p style={{ margin: '0 0 20px', color: '#6b7280', fontSize: 13 }}>Remove all employee assignments first. This action cannot be undone.</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button onClick={() => setDeleteId(null)} style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer' }}>Cancel</button>
              <button onClick={() => handleDelete(deleteId)} style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: '#dc2626', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {showForm && (
        <ShiftFormModal
          shift={editShift}
          departments={departments}
          onSave={handleSave}
          onClose={() => { setShowForm(false); setEditShift(null); }}
        />
      )}
      {assignShift && (
        <AssignPanel shift={assignShift} onClose={() => { setAssignShift(null); load(); }} />
      )}
    </div>
  );
}
