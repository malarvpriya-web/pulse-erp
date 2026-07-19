import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, X, Clock, Edit2 } from 'lucide-react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DEFAULT_ROLE_GRACE = { office: 15, field: 25, manager: 10 };

const emptyForm = () => ({
  name: '',
  start: '09:00',
  end: '18:00',
  grace_minutes: 15,
  color: '#6366f1',
  break_duration: 30,
  half_day_hours: 4,
  departments: [],
  weekly_off_days: ['Sat', 'Sun'],
  role_grace_minutes: DEFAULT_ROLE_GRACE,
  night_shift_allowance: false,
});

/**
 * @param {Function} setPage - navigate to another page key
 */
export default function Shifts({ setPage: _setPage }) {
  const [shifts, setShifts]           = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState(null);
  const [drawer, setDrawer]           = useState(null); // null | 'create' | shift-obj
  const [form, setForm]               = useState(emptyForm());
  const [toast, setToast]             = useState(null);
  const [employees, setEmployees]     = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [rotations, setRotations]     = useState([]);
  const [overrides, setOverrides]     = useState([]);
  const [pendingCancelAssignment, setPendingCancelAssignment] = useState(null);
  const [pendingCancelRotation,   setPendingCancelRotation]   = useState(null);
  const [pendingCancelOverride,   setPendingCancelOverride]   = useState(null);
  const [pendingDeleteShift,      setPendingDeleteShift]      = useState(null);
  const [assignForm, setAssignForm]   = useState({ employee_id: '', shift_id: '', effective_from: '', note: '' });
  const [rotationForm, setRotationForm] = useState({ team: '', week_1_shift_id: '', week_2_shift_id: '', effective_from: '' });
  const [overrideForm, setOverrideForm] = useState({ employee_id: '', shift_id: '', override_date: '', reason: '' });

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };

  const apiError = err =>
    err.response?.data?.error ||
    err.response?.data?.message ||
    err.message ||
    'An unexpected error occurred';

  const fetchShifts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/hr/shifts');
      if (!isMounted.current) return;
      setShifts(Array.isArray(res.data) ? res.data : (res.data?.results ?? []));
    } catch (err) {
      if (!isMounted.current) return;
      setError(apiError(err) || 'Failed to load shifts');
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => { fetchShifts(); }, [fetchShifts]);

  useEffect(() => {
    api.get('/admin/config/departments')
      .then(res => { if (!isMounted.current) return; setDepartments(Array.isArray(res.data) ? res.data.map(d => d.name || d) : []); })
      .catch(() => { if (!isMounted.current) return; setDepartments(['Engineering', 'HR', 'Finance', 'Sales', 'Operations', 'Support', 'Product', 'Marketing', 'Admin']); });
  }, []);

  useEffect(() => {
    api.get('/employees', { params: { limit: 500, status: 'active,probation' } })
      .then(res => {
        if (!isMounted.current) return;
        const all = Array.isArray(res.data) ? res.data : (res.data?.results || []);
        const active = all.filter(e => ['active', 'probation'].includes((e.status || '').toLowerCase()));
        setEmployees(active);
      })
      .catch(() => { if (!isMounted.current) return; setEmployees([]); });
  }, []);

  useEffect(() => {
    api.get('/hr/shift-assignments')
      .then(res => { if (!isMounted.current) return; setAssignments(Array.isArray(res.data) ? res.data : (res.data?.results ?? [])); })
      .catch(() => { if (!isMounted.current) return; setAssignments([]); });
    api.get('/hr/shift-rotations')
      .then(res => { if (!isMounted.current) return; setRotations(Array.isArray(res.data) ? res.data : (res.data?.results ?? [])); })
      .catch(() => { if (!isMounted.current) return; setRotations([]); });
    api.get('/hr/shift-overrides')
      .then(res => { if (!isMounted.current) return; setOverrides(Array.isArray(res.data) ? res.data : (res.data?.results ?? [])); })
      .catch(() => { if (!isMounted.current) return; setOverrides([]); });
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') setDrawer(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const openCreate = () => { setForm(emptyForm()); setDrawer('create'); };
  const openEdit   = s   => { setForm({ ...emptyForm(), ...s, departments: [...(s.departments || [])] }); setDrawer(s); };

  const toggleDept = d => setForm(f => ({
    ...f,
    departments: f.departments.includes(d) ? f.departments.filter(x => x !== d) : [...f.departments, d],
  }));

  const toggleOffDay = day => setForm(f => ({
    ...f,
    weekly_off_days: f.weekly_off_days?.includes(day)
      ? f.weekly_off_days.filter(x => x !== day)
      : [...(f.weekly_off_days || []), day],
  }));

  const handleSave = async () => {
    if (!form.name.trim()) return showToast('Shift name required', 'error');
    try {
      if (drawer === 'create') {
        const res = await api.post('/hr/shifts', { ...form, employees_count: 0 });
        if (!isMounted.current) return;
        setShifts(s => [...s, res.data ?? { id: Date.now(), ...form, employees_count: 0 }]);
        showToast('Shift created');
      } else {
        const updated = await api.put(`/hr/shifts/${drawer.id}`, form);
        if (!isMounted.current) return;
        setShifts(s => s.map(x => x.id === drawer.id ? { ...x, ...form, ...(updated.data || {}) } : x));
        showToast('Shift updated');
      }
    } catch (err) {
      showToast(apiError(err) || 'Failed to save shift', 'error');
    }
    if (!isMounted.current) return;
    setDrawer(null);
  };

  const handleAssignEmployee = async () => {
    if (!assignForm.employee_id || !assignForm.shift_id) return showToast('Employee and shift are required', 'error');
    try {
      const res = await api.post('/hr/shift-assignments', {
        employee_id: String(assignForm.employee_id),
        shift_id: Number(assignForm.shift_id),
        effective_from: assignForm.effective_from || null,
        note: assignForm.note || '',
      });
      if (!isMounted.current) return;
      setAssignments(prev => [res.data, ...prev]);
      setAssignForm({ employee_id: '', shift_id: '', effective_from: '', note: '' });
      showToast('Individual shift assignment saved');
    } catch (err) {
      if (!isMounted.current) return;
      showToast(apiError(err) || 'Failed to save shift assignment', 'error');
    }
  };

  const handleAddRotation = async () => {
    if (!rotationForm.team || !rotationForm.week_1_shift_id || !rotationForm.week_2_shift_id) return showToast('Team and both week shifts are required', 'error');
    try {
      const res = await api.post('/hr/shift-rotations', {
        team: rotationForm.team,
        week_1_shift_id: Number(rotationForm.week_1_shift_id),
        week_2_shift_id: Number(rotationForm.week_2_shift_id),
        effective_from: rotationForm.effective_from || null,
      });
      if (!isMounted.current) return;
      setRotations(prev => [res.data, ...prev]);
      setRotationForm({ team: '', week_1_shift_id: '', week_2_shift_id: '', effective_from: '' });
      showToast('Shift rotation pattern saved');
    } catch (err) {
      if (!isMounted.current) return;
      showToast(apiError(err) || 'Failed to save rotation pattern', 'error');
    }
  };

  const findShift = id => shifts.find(s => Number(s.id) === Number(id));
  const findEmp = id => employees.find(e => String(e.id || e.employee_id) === String(id));

  const handleCancelAssignment = async () => {
    if (!pendingCancelAssignment) return;
    const id = pendingCancelAssignment;
    setPendingCancelAssignment(null);
    try {
      await api.delete(`/hr/shift-assignments/${id}`);
      if (!isMounted.current) return;
      setAssignments(prev => prev.filter(a => a.id !== id));
      showToast('Assignment removed');
    } catch (err) {
      if (!isMounted.current) return;
      showToast(apiError(err) || 'Failed to remove assignment', 'error');
    }
  };

  const handleCancelRotation = async () => {
    if (!pendingCancelRotation) return;
    const id = pendingCancelRotation;
    setPendingCancelRotation(null);
    try {
      await api.delete(`/hr/shift-rotations/${id}`);
      if (!isMounted.current) return;
      setRotations(prev => prev.filter(r => r.id !== id));
      showToast('Rotation cancelled');
    } catch (err) {
      if (!isMounted.current) return;
      showToast(apiError(err) || 'Failed to cancel rotation', 'error');
    }
  };

  const handleAddOverride = async () => {
    const { employee_id, shift_id, override_date, reason } = overrideForm;
    if (!employee_id || !shift_id || !override_date) return showToast('Employee, shift and date are required', 'error');
    try {
      const res = await api.post('/hr/shift-overrides', {
        employee_id: Number(employee_id),
        shift_id: Number(shift_id),
        override_date,
        reason: reason || '',
      });
      if (!isMounted.current) return;
      setOverrides(prev => [res.data, ...prev]);
      setOverrideForm({ employee_id: '', shift_id: '', override_date: '', reason: '' });
      showToast('Date override saved');
    } catch (err) {
      if (!isMounted.current) return;
      showToast(apiError(err) || 'Failed to save override', 'error');
    }
  };

  const handleCancelOverride = async () => {
    if (!pendingCancelOverride) return;
    const id = pendingCancelOverride;
    setPendingCancelOverride(null);
    try {
      await api.delete(`/hr/shift-overrides/${id}`);
      if (!isMounted.current) return;
      setOverrides(prev => prev.filter(o => o.id !== id));
      showToast('Override cancelled');
    } catch (err) {
      if (!isMounted.current) return;
      showToast(apiError(err) || 'Failed to cancel override', 'error');
    }
  };

  const handleDelete = async () => {
    if (!pendingDeleteShift) return;
    const { id, name } = pendingDeleteShift;
    setPendingDeleteShift(null);
    try {
      await api.delete(`/hr/shifts/${id}`);
      if (!isMounted.current) return;
      setShifts(s => s.filter(x => x.id !== id));
      showToast('Shift deleted');
    } catch (err) {
      if (!isMounted.current) return;
      showToast(apiError(err) || 'Failed to delete shift', 'error');
    }
  };

  return (
    <div style={{ padding: '24px' }}>
      <ConfirmDialog
        open={!!pendingCancelAssignment}
        title="Remove Assignment"
        message="Remove this shift assignment?"
        confirmLabel="Remove"
        variant="warning"
        onConfirm={handleCancelAssignment}
        onCancel={() => setPendingCancelAssignment(null)}
      />
      <ConfirmDialog
        open={!!pendingCancelRotation}
        title="Cancel Rotation"
        message="Cancel this rotation schedule?"
        confirmLabel="Cancel Rotation"
        variant="warning"
        onConfirm={handleCancelRotation}
        onCancel={() => setPendingCancelRotation(null)}
      />
      <ConfirmDialog
        open={!!pendingCancelOverride}
        title="Cancel Override"
        message="Cancel this date override?"
        confirmLabel="Cancel Override"
        variant="warning"
        onConfirm={handleCancelOverride}
        onCancel={() => setPendingCancelOverride(null)}
      />
      <ConfirmDialog
        open={!!pendingDeleteShift}
        title="Delete Shift"
        message={pendingDeleteShift ? `Delete shift "${pendingDeleteShift.name}"? This cannot be undone. Employees must be unassigned first.` : ''}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingDeleteShift(null)}
      />
      {toast && (
        <div style={{ position: 'fixed', top: '20px', right: '20px', padding: '12px 20px', borderRadius: '8px', zIndex: 9999, fontWeight: 600, fontSize: '13px',
          background: toast.type === 'error' ? '#fee2e2' : '#dcfce7',
          color: toast.type === 'error' ? '#dc2626' : '#15803d' }}>{toast.msg}</div>
      )}

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#fee2e2', color: '#dc2626', borderRadius: '8px', padding: '10px 14px', marginBottom: '16px', fontSize: '13px' }}>
          <span>{error}</span>
          <button onClick={fetchShifts} style={{ marginLeft: '12px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: '6px', padding: '4px 12px', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>Retry</button>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 700 }}>Shift Management</h2>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: '13px' }}>{loading ? 'Loading…' : `${shifts.length} shifts configured`}</p>
        </div>
        <button onClick={openCreate} style={{ display: 'flex', alignItems: 'center', gap: '6px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: '8px', padding: '8px 16px', fontWeight: 600, fontSize: '13px', cursor: 'pointer' }}>
          <Plus size={14} /> Add Shift
        </button>
      </div>

      {!loading && !error && shifts.length === 0 && (
        <div style={{ color: '#9ca3af', fontSize: 13, padding: 32, textAlign: 'center', background: '#f9fafb', borderRadius: 8 }}>No shifts configured yet</div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
        {shifts.map(s => (
          <div key={s.id} style={{ background: '#fff', borderRadius: '12px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
            <div style={{ height: '5px', background: s.color }} />
            <div style={{ padding: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '15px' }}>{s.name}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#6b7280', fontSize: '13px', marginTop: '4px' }}>
                    <Clock size={13} />{s.start} – {s.end}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button onClick={() => openEdit(s)} aria-label={`Edit ${s.name}`} style={{ border: 'none', background: '#f3f4f6', borderRadius: '6px', padding: '5px', cursor: 'pointer' }}><Edit2 size={12} /></button>
                  <button onClick={() => setPendingDeleteShift({ id: s.id, name: s.name })} aria-label={`Delete ${s.name}`} style={{ border: 'none', background: '#fee2e2', borderRadius: '6px', padding: '5px', cursor: 'pointer' }}><X size={12} color="#dc2626" /></button>
                </div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '12px' }}>
                {(s.departments || []).map(d => (
                  <span key={d} style={{ fontSize: '11px', background: s.color + '18', color: s.color, padding: '2px 8px', borderRadius: '20px', fontWeight: 600 }}>{d}</span>
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#6b7280' }}>
                <span>Grace: {s.grace_minutes} min</span>
                <span style={{ fontWeight: 600, color: '#111827' }}>{s.employees_count} employees</span>
              </div>
              <div style={{ marginTop: 8, fontSize: 11, color: '#6b7280' }}>
                Weekly Off: {(s.weekly_off_days || ['Sat', 'Sun']).join(', ')} | Night Allowance: {s.night_shift_allowance ? 'Enabled' : 'No'}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 16, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 12px', fontSize: 12 }}>
        <strong>Attendance Color Legend:</strong> Shift color band is used as the attendance calendar tag for that shift and in shift-wise late report filters.
      </div>

      <div style={{ marginTop: 22, border: '1px solid #e5e7eb', borderRadius: 12, padding: 14 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 16 }}>Individual Employee Shift Override</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          <select value={assignForm.employee_id} onChange={e => setAssignForm(f => ({ ...f, employee_id: e.target.value }))} style={{ padding: 8, borderRadius: 8, border: '1px solid #d1d5db' }}>
            <option value="">Select employee</option>
            {employees.map(e => <option key={String(e.id || e.employee_id)} value={String(e.id || e.employee_id)}>{e.name || e.full_name || e.employee_name || e.employee_id}</option>)}
          </select>
          <select value={assignForm.shift_id} onChange={e => setAssignForm(f => ({ ...f, shift_id: e.target.value }))} style={{ padding: 8, borderRadius: 8, border: '1px solid #d1d5db' }}>
            <option value="">Select shift</option>
            {shifts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input type="date" value={assignForm.effective_from} onChange={e => setAssignForm(f => ({ ...f, effective_from: e.target.value }))} style={{ padding: 8, borderRadius: 8, border: '1px solid #d1d5db' }} />
          <input value={assignForm.note} onChange={e => setAssignForm(f => ({ ...f, note: e.target.value }))} placeholder="Reason/note" style={{ padding: 8, borderRadius: 8, border: '1px solid #d1d5db' }} />
          <button onClick={handleAssignEmployee} style={{ border: 'none', borderRadius: 8, background: '#0f766e', color: '#fff', fontWeight: 600 }}>Assign Override</button>
        </div>
        {assignments.length > 0 && (
          <div style={{ marginTop: 12, borderTop: '1px solid #f1f5f9', paddingTop: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Active Assignments ({assignments.length})</div>
            {assignments.slice(0, 8).map(a => {
              const emp = findEmp(a.employee_id);
              const sh  = findShift(a.shift_id);
              return (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid #f8fafc', fontSize: 12 }}>
                  <span style={{ color: '#1e293b' }}>
                    <strong>{emp?.name || emp?.full_name || a.employee_id}</strong>
                    <span style={{ color: '#94a3b8', margin: '0 6px' }}>→</span>
                    <span style={{ color: '#0f766e', fontWeight: 600 }}>{sh?.name || `Shift #${a.shift_id}`}</span>
                    {a.effective_from && <span style={{ color: '#64748b', marginLeft: 6 }}>from {a.effective_from}</span>}
                    {a.note && <span style={{ color: '#94a3b8', marginLeft: 6, fontStyle: 'italic' }}>{a.note}</span>}
                  </span>
                  <button onClick={() => setPendingCancelAssignment(a.id)}
                    style={{ border: 'none', background: '#fee2e2', color: '#dc2626', borderRadius: 5, padding: '3px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}>
                    Remove
                  </button>
                </div>
              );
            })}
            {assignments.length > 8 && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>+{assignments.length - 8} more</div>}
          </div>
        )}
      </div>

      <div style={{ marginTop: 16, border: '1px solid #e5e7eb', borderRadius: 12, padding: 14 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 16 }}>Shift Rotation Schedule (Week 1 / Week 2)</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          <select value={rotationForm.team} onChange={e => setRotationForm(f => ({ ...f, team: e.target.value }))} style={{ padding: 8, borderRadius: 8, border: '1px solid #d1d5db' }}>
            <option value="">Select team/department</option>
            {departments.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <select value={rotationForm.week_1_shift_id} onChange={e => setRotationForm(f => ({ ...f, week_1_shift_id: e.target.value }))} style={{ padding: 8, borderRadius: 8, border: '1px solid #d1d5db' }}>
            <option value="">Week 1 shift</option>
            {shifts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select value={rotationForm.week_2_shift_id} onChange={e => setRotationForm(f => ({ ...f, week_2_shift_id: e.target.value }))} style={{ padding: 8, borderRadius: 8, border: '1px solid #d1d5db' }}>
            <option value="">Week 2 shift</option>
            {shifts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input type="date" value={rotationForm.effective_from} onChange={e => setRotationForm(f => ({ ...f, effective_from: e.target.value }))} style={{ padding: 8, borderRadius: 8, border: '1px solid #d1d5db' }} />
          <button onClick={handleAddRotation} style={{ border: 'none', borderRadius: 8, background: '#6B3FDB', color: '#fff', fontWeight: 600 }}>Save Rotation</button>
        </div>
        {rotations.length > 0 && (
          <div style={{ marginTop: 12, borderTop: '1px solid #f1f5f9', paddingTop: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Active Rotations ({rotations.length})</div>
            {rotations.slice(0, 8).map(r => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid #f8fafc', fontSize: 12 }}>
                <span style={{ color: '#1e293b' }}>
                  <strong>{r.team}</strong>
                  <span style={{ color: '#94a3b8', margin: '0 6px' }}>·</span>
                  <span>W1: <span style={{ fontWeight: 600, color: '#1d4ed8' }}>{findShift(r.week_1_shift_id)?.name || `#${r.week_1_shift_id}`}</span></span>
                  <span style={{ color: '#94a3b8', margin: '0 6px' }}>·</span>
                  <span>W2: <span style={{ fontWeight: 600, color: '#6B3FDB' }}>{findShift(r.week_2_shift_id)?.name || `#${r.week_2_shift_id}`}</span></span>
                  {r.effective_from && <span style={{ color: '#64748b', marginLeft: 6 }}>from {r.effective_from}</span>}
                </span>
                <button onClick={() => setPendingCancelRotation(r.id)}
                  style={{ border: 'none', background: '#fee2e2', color: '#dc2626', borderRadius: 5, padding: '3px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}>
                  Cancel
                </button>
              </div>
            ))}
            {rotations.length > 8 && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>+{rotations.length - 8} more</div>}
          </div>
        )}
      </div>

      {/* ── Single-Date Override ─────────────────────────────────────────── */}
      <div style={{ marginTop: 16, border: '1px solid #e5e7eb', borderRadius: 12, padding: 14 }}>
        <div style={{ marginBottom: 10 }}>
          <h3 style={{ margin: '0 0 2px', fontSize: 16 }}>Single-Date Shift Override</h3>
          <p style={{ margin: 0, fontSize: 12, color: '#64748b' }}>
            Override the shift for one specific date — highest priority, overrides permanent assignment and rotation.
          </p>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          <select value={overrideForm.employee_id} onChange={e => setOverrideForm(f => ({ ...f, employee_id: e.target.value }))}
            style={{ padding: 8, borderRadius: 8, border: '1px solid #d1d5db' }}>
            <option value="">Select employee</option>
            {employees.map(e => <option key={String(e.id || e.employee_id)} value={String(e.id || e.employee_id)}>{e.name || e.full_name || e.employee_name || e.employee_id}</option>)}
          </select>
          <select value={overrideForm.shift_id} onChange={e => setOverrideForm(f => ({ ...f, shift_id: e.target.value }))}
            style={{ padding: 8, borderRadius: 8, border: '1px solid #d1d5db' }}>
            <option value="">Select shift for that day</option>
            {shifts.map(s => <option key={s.id} value={s.id}>{s.name} ({s.start} – {s.end})</option>)}
          </select>
          <input type="date" value={overrideForm.override_date}
            onChange={e => setOverrideForm(f => ({ ...f, override_date: e.target.value }))}
            style={{ padding: 8, borderRadius: 8, border: '1px solid #d1d5db' }} />
          <input value={overrideForm.reason} onChange={e => setOverrideForm(f => ({ ...f, reason: e.target.value }))}
            placeholder="Reason (e.g. training day, client visit)"
            style={{ padding: 8, borderRadius: 8, border: '1px solid #d1d5db' }} />
          <button onClick={handleAddOverride}
            style={{ border: 'none', borderRadius: 8, background: '#6B3FDB', color: '#fff', fontWeight: 600, padding: '8px 12px' }}>
            Add Override
          </button>
        </div>
        {overrides.length > 0 && (
          <div style={{ marginTop: 12, borderTop: '1px solid #f1f5f9', paddingTop: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Active Date Overrides ({overrides.length})
            </div>
            {overrides.slice(0, 10).map(o => {
              const emp = findEmp(o.employee_id);
              const sh  = findShift(o.shift_id);
              return (
                <div key={o.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid #f8fafc', fontSize: 12 }}>
                  <span style={{ color: '#1e293b' }}>
                    <strong>{o.employee_name || emp?.name || o.employee_id}</strong>
                    <span style={{ color: '#94a3b8', margin: '0 6px' }}>→</span>
                    <span style={{ color: '#6B3FDB', fontWeight: 600 }}>{o.shift_name || sh?.name || `Shift #${o.shift_id}`}</span>
                    <span style={{ background: '#f3e8ff', color: '#6B3FDB', borderRadius: 4, padding: '1px 6px', marginLeft: 8, fontSize: 11, fontWeight: 700 }}>
                      {o.override_date}
                    </span>
                    {o.reason && <span style={{ color: '#94a3b8', marginLeft: 6, fontStyle: 'italic' }}>{o.reason}</span>}
                  </span>
                  <button onClick={() => setPendingCancelOverride(o.id)}
                    style={{ border: 'none', background: '#fee2e2', color: '#dc2626', borderRadius: 5, padding: '3px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}>
                    Cancel
                  </button>
                </div>
              );
            })}
            {overrides.length > 10 && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>+{overrides.length - 10} more</div>}
          </div>
        )}
      </div>

      {drawer !== null && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setDrawer(null)}>
          <div style={{ background: '#fff', borderRadius: '12px', padding: '24px', width: '460px', maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 style={{ margin: 0 }}>{drawer === 'create' ? 'Create Shift' : 'Edit Shift'}</h3>
              <button onClick={() => setDrawer(null)} style={{ border: 'none', background: 'none', cursor: 'pointer' }}><X size={18} /></button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '6px' }}>Shift Name *</label>
                <input style={{ width: '100%', padding: '8px 12px', borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: '13px', boxSizing: 'border-box' }}
                  value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Morning Shift" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '6px' }}>Start Time</label>
                  <input type="time" style={{ width: '100%', padding: '8px 12px', borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: '13px', boxSizing: 'border-box' }}
                    value={form.start} onChange={e => setForm(f => ({ ...f, start: e.target.value }))} />
                </div>
                <div>
                  <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '6px' }}>End Time</label>
                  <input type="time" style={{ width: '100%', padding: '8px 12px', borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: '13px', boxSizing: 'border-box' }}
                    value={form.end} onChange={e => setForm(f => ({ ...f, end: e.target.value }))} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '6px' }}>Grace Period (min)</label>
                  <input type="number" min="0" max="120" style={{ width: '100%', padding: '8px 12px', borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: '13px', boxSizing: 'border-box' }}
                    value={form.grace_minutes} onChange={e => setForm(f => ({ ...f, grace_minutes: +e.target.value }))} />
                </div>
                <div>
                  <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '6px' }}>Break Duration (min)</label>
                  <input type="number" min="0" max="120" style={{ width: '100%', padding: '8px 12px', borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: '13px', boxSizing: 'border-box' }}
                    value={form.break_duration} onChange={e => setForm(f => ({ ...f, break_duration: +e.target.value }))} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '6px' }}>Half Day Threshold (hrs)</label>
                  <input type="number" min="1" max="8" step="0.5" style={{ width: '100%', padding: '8px 12px', borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: '13px', boxSizing: 'border-box' }}
                    value={form.half_day_hours} onChange={e => setForm(f => ({ ...f, half_day_hours: +e.target.value }))} />
                </div>
                <div>
                  <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '6px' }}>Color Band</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input type="color" value={form.color} onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
                      style={{ width: '40px', height: '36px', padding: '2px', borderRadius: '6px', border: '1px solid #e5e7eb', cursor: 'pointer' }} />
                    <input value={form.color} onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
                      style={{ flex: 1, padding: '8px 10px', borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: '12px', fontFamily: 'monospace' }}
                      placeholder="#6366f1" maxLength={7} />
                  </div>
                </div>
              </div>
              <div>
                <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '6px' }}>Role-wise Grace (minutes)</label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                  <input type="number" min="0" max="90" value={form.role_grace_minutes?.office ?? 15} onChange={e => setForm(f => ({ ...f, role_grace_minutes: { ...(f.role_grace_minutes || {}), office: +e.target.value } }))} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #e5e7eb' }} placeholder="Office" />
                  <input type="number" min="0" max="90" value={form.role_grace_minutes?.field ?? 25} onChange={e => setForm(f => ({ ...f, role_grace_minutes: { ...(f.role_grace_minutes || {}), field: +e.target.value } }))} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #e5e7eb' }} placeholder="Field" />
                  <input type="number" min="0" max="90" value={form.role_grace_minutes?.manager ?? 10} onChange={e => setForm(f => ({ ...f, role_grace_minutes: { ...(f.role_grace_minutes || {}), manager: +e.target.value } }))} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #e5e7eb' }} placeholder="Manager" />
                </div>
              </div>
              <div>
                <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '8px' }}>Weekly Off Days</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {DAYS.map(day => (
                    <button key={day} onClick={() => toggleOffDay(day)}
                      style={{ padding: '4px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: 600, cursor: 'pointer', border: '1px solid',
                        background: form.weekly_off_days?.includes(day) ? '#334155' : '#f3f4f6',
                        color: form.weekly_off_days?.includes(day) ? '#fff' : '#374151',
                        borderColor: form.weekly_off_days?.includes(day) ? '#334155' : '#e5e7eb' }}>
                      {day}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600 }}>
                  <input type="checkbox" checked={!!form.night_shift_allowance} onChange={e => setForm(f => ({ ...f, night_shift_allowance: e.target.checked }))} />
                  Enable night shift allowance
                </label>
              </div>
              <div>
                <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '8px' }}>Departments</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {departments.map(d => (
                    <button key={d} onClick={() => toggleDept(d)}
                      style={{ padding: '4px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 600, cursor: 'pointer', border: '1px solid',
                        background: form.departments.includes(d) ? '#6366f1' : '#f3f4f6',
                        color: form.departments.includes(d) ? '#fff' : '#374151',
                        borderColor: form.departments.includes(d) ? '#6366f1' : '#e5e7eb' }}>
                      {d}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '10px', marginTop: '20px', justifyContent: 'flex-end' }}>
              <button onClick={() => setDrawer(null)} style={{ padding: '8px 16px', borderRadius: '8px', border: '1px solid #e5e7eb', background: '#fff', fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleSave} style={{ padding: '8px 16px', borderRadius: '8px', border: 'none', background: '#6366f1', color: '#fff', fontWeight: 600, fontSize: '13px', cursor: 'pointer' }}>
                {drawer === 'create' ? 'Create Shift' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
