import React, { useState, useEffect, useCallback } from 'react';
import {
  Layers, Plus, Clock, Package, RefreshCw, X, Check,
  Pencil, Trash2, Settings, ChevronDown, ChevronUp, AlertTriangle, Moon,
  BarChart2, TrendingUp, Award, Activity, Users,
} from 'lucide-react';
import api from '@/services/api/client';

const P = '#6B3FDB';
const CARD = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 24 };

function timeToMins(t) {
  if (!t) return -1;
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
}

function hoursPreview(checkIn, checkOut) {
  if (!checkIn || !checkOut) return null;
  const diff = timeToMins(checkOut) - timeToMins(checkIn);
  const mins = diff < 0 ? diff + 1440 : diff;
  return (mins / 60).toFixed(1);
}

const EMPTY_FORM = {
  employee_id: '', work_centre_id: '', work_centre_name: '', shift_id: '',
  date: new Date().toISOString().split('T')[0],
  check_in: '', check_out: '', units_produced: 0, remarks: '',
};

// ─── Record modal (add + edit) ───────────────────────────────────────────────
function RecordModal({ editRecord, workCentres, onSave, onClose }) {
  const isEdit = !!editRecord;

  const [form, setForm] = useState(() => {
    if (isEdit) {
      return {
        employee_id:      editRecord.employee_id      || '',
        work_centre_id:   editRecord.work_centre_id   || '',
        work_centre_name: editRecord.work_centre_name || '',
        shift_id:         editRecord.shift_id         || '',
        date:             editRecord.attendance_date  || new Date().toISOString().split('T')[0],
        check_in:         editRecord.check_in         || '',
        check_out:        editRecord.check_out        || '',
        units_produced:   editRecord.units_produced   ?? 0,
        remarks:          editRecord.remarks           || '',
      };
    }
    return EMPTY_FORM;
  });

  const [employees, setEmployees] = useState([]);
  const [shifts, setShifts]       = useState([]);
  const [saving, setSaving]       = useState(false);
  const [err, setErr]             = useState('');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  useEffect(() => {
    Promise.allSettled([
      api.get('/employees?status=active&limit=500'),
      api.get('/attendance/shifts'),
    ]).then(([eRes, sRes]) => {
      if (eRes.status === 'fulfilled') {
        const d = eRes.value.data;
        setEmployees(d?.employees || d || []);
      }
      if (sRes.status === 'fulfilled') setShifts(sRes.value.data || []);
    });
  }, []);

  const validate = () => {
    if (!isEdit && !form.employee_id)  return 'Employee is required';
    if (!form.work_centre_id && !form.work_centre_name) return 'Work centre is required';
    if (!form.date) return 'Date is required';
    if (form.check_in && form.check_out) {
      const diff = timeToMins(form.check_out) - timeToMins(form.check_in);
      if (diff < 0 && Math.abs(diff) < 720) {
        return 'Check-out must be after check-in (night-shift spans midnight — gap must exceed 12 h)';
      }
    }
    if (form.units_produced !== '' && Number(form.units_produced) < 0) {
      return 'Units produced cannot be negative';
    }
    return null;
  };

  const handleSave = async () => {
    const ve = validate();
    if (ve) { setErr(ve); return; }
    setSaving(true); setErr('');
    try {
      const payload = {
        work_centre_id:   form.work_centre_id   || null,
        work_centre_name: form.work_centre_name || null,
        shift_id:         form.shift_id         || null,
        check_in:         form.check_in         || null,
        check_out:        form.check_out        || null,
        units_produced:   parseInt(form.units_produced) || 0,
        remarks:          form.remarks          || null,
      };
      let res;
      if (isEdit) {
        res = await api.put(`/attendance/work-centre/${editRecord.id}`, payload);
      } else {
        res = await api.post('/attendance/work-centre', {
          ...payload,
          employee_id: form.employee_id,
          date:        form.date,
        });
      }
      onSave(res.data, isEdit);
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to save');
    } finally { setSaving(false); }
  };

  const inp = {
    border: '1px solid #e9e4ff', borderRadius: 8, padding: '8px 12px',
    fontSize: 13, width: '100%', outline: 'none', boxSizing: 'border-box',
  };

  const preview     = hoursPreview(form.check_in, form.check_out);
  const isOvernight = form.check_in && form.check_out && timeToMins(form.check_out) < timeToMins(form.check_in);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 520, maxHeight: '90vh', overflow: 'auto', padding: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
            {isEdit ? 'Edit Record' : 'Log Work Centre Attendance'}
          </h2>
          <button onClick={onClose} style={{ border: 'none', background: '#f5f3ff', borderRadius: 8, padding: 6, cursor: 'pointer' }}>
            <X size={16} />
          </button>
        </div>

        {err && (
          <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 12px', marginBottom: 14, color: '#dc2626', fontSize: 13, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <AlertTriangle size={14} style={{ marginTop: 1, flexShrink: 0 }} />
            <span>{err}</span>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {/* Employee — shown only for new records */}
          {!isEdit && (
            <div style={{ gridColumn: '1/-1' }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>EMPLOYEE *</label>
              <select style={inp} value={form.employee_id} onChange={e => set('employee_id', e.target.value)}>
                <option value="">Select employee…</option>
                {employees.map(e => (
                  <option key={e.id} value={e.id}>
                    {e.name || `${e.first_name || ''} ${e.last_name || ''}`.trim()} – {e.department}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Work Centre */}
          <div style={{ gridColumn: '1/-1' }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>WORK CENTRE *</label>
            <select
              style={inp}
              value={form.work_centre_id}
              onChange={e => {
                const id = e.target.value;
                const wc = workCentres.find(w => String(w.id) === String(id));
                set('work_centre_id', id);
                set('work_centre_name', wc?.name || '');
              }}
            >
              <option value="">Select work centre…</option>
              {workCentres.map(wc => (
                <option key={wc.id} value={wc.id}>
                  {wc.name}{wc.department ? ` — ${wc.department}` : ''}
                </option>
              ))}
            </select>
            {workCentres.length === 0 && (
              <p style={{ fontSize: 11, color: '#f59e0b', margin: '4px 0 0' }}>
                No work centres configured — use "Manage Work Centres" to add them first.
              </p>
            )}
          </div>

          {/* Date — shown only for new records */}
          {!isEdit && (
            <div style={{ gridColumn: '1/-1' }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>DATE *</label>
              <input type="date" style={inp} value={form.date} onChange={e => set('date', e.target.value)} />
            </div>
          )}

          {/* Shift */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>SHIFT</label>
            <select style={inp} value={form.shift_id} onChange={e => set('shift_id', e.target.value)}>
              <option value="">Select shift…</option>
              {shifts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>

          {/* Units Produced */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>UNITS PRODUCED</label>
            <input
              type="number" min="0" style={inp}
              value={form.units_produced}
              onChange={e => set('units_produced', e.target.value)}
            />
          </div>

          {/* Check In */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>CHECK IN</label>
            <input type="time" style={inp} value={form.check_in} onChange={e => set('check_in', e.target.value)} />
          </div>

          {/* Check Out */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>
              CHECK OUT
              {preview && (
                <span style={{ fontWeight: 400, color: '#10b981', marginLeft: 8 }}>{preview}h</span>
              )}
            </label>
            <input type="time" style={inp} value={form.check_out} onChange={e => set('check_out', e.target.value)} />
            {isOvernight && (
              <p style={{ fontSize: 11, color: '#6366f1', margin: '4px 0 0', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Moon size={11} /> Night shift — spans midnight
              </p>
            )}
          </div>

          {/* Remarks */}
          <div style={{ gridColumn: '1/-1' }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>REMARKS</label>
            <input style={inp} value={form.remarks} onChange={e => set('remarks', e.target.value)} placeholder="Optional notes" />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 22, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #e9e4ff', background: '#fff', fontSize: 14, cursor: 'pointer' }}>
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: P, color: '#fff', fontSize: 14, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}
          >
            {saving ? 'Saving…' : isEdit ? 'Update Record' : 'Log Attendance'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Analytics Tab ───────────────────────────────────────────────────────────
function AnalyticsTab() {
  const today    = new Date().toISOString().slice(0, 10);
  const sevenAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);

  const [fromDate, setFromDate] = useState(sevenAgo);
  const [toDate, setToDate]     = useState(today);
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await api.get(`/attendance/work-centre/analytics?from_date=${fromDate}&to_date=${toDate}`);
      setData(res.data);
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to load analytics');
    } finally { setLoading(false); }
  }, [fromDate, toDate]);

  useEffect(() => { load(); }, [load]);

  const utilBar = (pct) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 8, background: '#f0f0f4', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: pct >= 80 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#ef4444', borderRadius: 4, transition: 'width 0.4s' }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, color: '#374151', minWidth: 36 }}>{pct}%</span>
    </div>
  );

  return (
    <div>
      {/* Date range filter */}
      <div style={{ ...CARD, marginBottom: 20, display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>From Date</label>
          <input type="date" value={fromDate} max={toDate}
            onChange={e => setFromDate(e.target.value)}
            style={{ border: '1px solid #e9e4ff', borderRadius: 8, padding: '7px 10px', fontSize: 13, outline: 'none' }} />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>To Date</label>
          <input type="date" value={toDate} min={fromDate} max={today}
            onChange={e => setToDate(e.target.value)}
            style={{ border: '1px solid #e9e4ff', borderRadius: 8, padding: '7px 10px', fontSize: 13, outline: 'none' }} />
        </div>
        <button onClick={load} disabled={loading}
          style={{ padding: '7px 18px', borderRadius: 8, border: 'none', background: P, color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, opacity: loading ? 0.7 : 1 }}>
          <RefreshCw size={13} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          {loading ? 'Loading…' : 'Apply'}
        </button>
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', marginBottom: 16, color: '#dc2626', fontSize: 13 }}>
          {error}
        </div>
      )}

      {data && (
        <>
          {/* Summary KPIs */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 20 }}>
            {[
              { label: 'Total Units Produced', value: data.summary.total_units.toLocaleString(), icon: Package, color: '#f59e0b' },
              { label: 'Total Hours Worked', value: `${parseFloat(data.summary.total_hours).toFixed(1)}h`, icon: Clock, color: '#10b981' },
              { label: 'Avg Utilization', value: `${data.summary.avg_utilization}%`, icon: Activity, color: '#6366f1' },
              { label: 'Active Work Centres', value: data.summary.active_work_centres, icon: Layers, color: P },
            ].map(k => (
              <div key={k.label} style={{ ...CARD, padding: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: `${k.color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <k.icon size={18} color={k.color} />
                </div>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#1f2937' }}>{k.value}</div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>{k.label}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Per work centre table */}
          <div style={{ ...CARD, padding: 0, overflow: 'hidden', marginBottom: 20 }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid #f0f0f4', display: 'flex', alignItems: 'center', gap: 8 }}>
              <BarChart2 size={16} color={P} />
              <span style={{ fontWeight: 700, fontSize: 14, color: '#1f2937' }}>Work Centre Performance</span>
            </div>
            {data.work_centres.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No data for the selected date range.</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #f0f0f4', background: '#fafafa' }}>
                      {['Work Centre', 'Active Days', 'Employees', 'Total Hours', 'Total Units', 'Units / Hour', 'Utilization', 'Labor Cost / Unit'].map(h => (
                        <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#6b7280', fontSize: 11, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.work_centres.map((wc, i) => (
                      <tr key={wc.work_centre_id || i} style={{ borderBottom: '1px solid #f5f5f7' }}>
                        <td style={{ padding: '11px 14px', fontWeight: 600, color: '#1f2937' }}>{wc.work_centre_name || '—'}</td>
                        <td style={{ padding: '11px 14px', color: '#6b7280', textAlign: 'center' }}>{wc.active_days}</td>
                        <td style={{ padding: '11px 14px', color: '#6b7280', textAlign: 'center' }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'center' }}>
                            <Users size={12} /> {wc.unique_employees}
                          </span>
                        </td>
                        <td style={{ padding: '11px 14px', color: '#374151', fontVariantNumeric: 'tabular-nums' }}>{wc.total_hours}h</td>
                        <td style={{ padding: '11px 14px', fontWeight: 700, color: '#059669', fontVariantNumeric: 'tabular-nums' }}>{parseInt(wc.total_units).toLocaleString()}</td>
                        <td style={{ padding: '11px 14px', color: '#374151', fontVariantNumeric: 'tabular-nums' }}>
                          {parseFloat(wc.units_per_hour) > 0 ? `${parseFloat(wc.units_per_hour).toFixed(2)}/h` : '—'}
                        </td>
                        <td style={{ padding: '11px 14px', minWidth: 140 }}>{utilBar(wc.utilization_pct)}</td>
                        <td style={{ padding: '11px 14px', color: wc.labor_cost_per_unit ? '#374151' : '#d1d5db', fontVariantNumeric: 'tabular-nums' }}>
                          {wc.labor_cost_per_unit ? `₹${wc.labor_cost_per_unit.toLocaleString('en-IN')}` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Shift breakdown + Top performers */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {/* Shift breakdown */}
            <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid #f0f0f4', display: 'flex', alignItems: 'center', gap: 8 }}>
                <TrendingUp size={16} color='#6366f1' />
                <span style={{ fontWeight: 700, fontSize: 14, color: '#1f2937' }}>Shift-wise Breakdown</span>
              </div>
              {data.shifts.length === 0 ? (
                <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No shift data.</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #f0f0f4', background: '#fafafa' }}>
                      {['Shift', 'Employees', 'Hours', 'Units'].map(h => (
                        <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600, color: '#6b7280', fontSize: 11, textTransform: 'uppercase' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.shifts.map((s, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #f5f5f7' }}>
                        <td style={{ padding: '10px 14px', fontWeight: 500, color: '#1f2937' }}>{s.shift_name}</td>
                        <td style={{ padding: '10px 14px', color: '#6b7280', textAlign: 'center' }}>{s.unique_employees}</td>
                        <td style={{ padding: '10px 14px', color: '#374151', fontVariantNumeric: 'tabular-nums' }}>{s.total_hours}h</td>
                        <td style={{ padding: '10px 14px', fontWeight: 700, color: '#059669', fontVariantNumeric: 'tabular-nums' }}>{parseInt(s.total_units).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Top performers */}
            <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid #f0f0f4', display: 'flex', alignItems: 'center', gap: 8 }}>
                <Award size={16} color='#f59e0b' />
                <span style={{ fontWeight: 700, fontSize: 14, color: '#1f2937' }}>Top Performers</span>
                <span style={{ fontSize: 11, color: '#9ca3af' }}>by units produced</span>
              </div>
              {data.top_performers.length === 0 ? (
                <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No production data.</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #f0f0f4', background: '#fafafa' }}>
                      {['#', 'Employee', 'Hours', 'Units'].map(h => (
                        <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600, color: '#6b7280', fontSize: 11, textTransform: 'uppercase' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.top_performers.map((p, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #f5f5f7' }}>
                        <td style={{ padding: '10px 14px', color: i === 0 ? '#f59e0b' : '#9ca3af', fontWeight: 700, fontSize: i === 0 ? 16 : 13 }}>
                          {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}
                        </td>
                        <td style={{ padding: '10px 14px' }}>
                          <div style={{ fontWeight: 600, color: '#1f2937' }}>{p.employee_name}</div>
                          {p.designation && <div style={{ fontSize: 11, color: '#9ca3af' }}>{p.designation}</div>}
                        </td>
                        <td style={{ padding: '10px 14px', color: '#6b7280', fontVariantNumeric: 'tabular-nums' }}>{p.total_hours}h</td>
                        <td style={{ padding: '10px 14px', fontWeight: 700, color: '#059669', fontVariantNumeric: 'tabular-nums' }}>{parseInt(p.total_units).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
      <style>{`@keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }`}</style>
    </div>
  );
}

// ─── Work Centre management panel ────────────────────────────────────────────
function WorkCentrePanel({ workCentres, onAdd, onRemove }) {
  const [form, setForm]   = useState({ name: '', department: '', capacity_hours_per_day: 8 });
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState('');
  const [removingId, setRemovingId] = useState(null);

  const inp = { border: '1px solid #e9e4ff', borderRadius: 8, padding: '7px 10px', fontSize: 13, outline: 'none' };

  const handleAdd = async () => {
    if (!form.name.trim()) { setErr('Name is required'); return; }
    setSaving(true); setErr('');
    try {
      const res = await api.post('/attendance/work-centres', form);
      onAdd(res.data);
      setForm({ name: '', department: '', capacity_hours_per_day: 8 });
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to add work centre');
    } finally { setSaving(false); }
  };

  const handleRemove = async (id) => {
    setRemovingId(id);
    try {
      await api.delete(`/attendance/work-centres/${id}`);
      onRemove(id);
    } catch { /* silent */ } finally { setRemovingId(null); }
  };

  return (
    <div style={{ ...CARD, marginBottom: 16, padding: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 12 }}>
        Configured Work Centres
      </div>

      {workCentres.length === 0 ? (
        <p style={{ fontSize: 13, color: '#9ca3af', margin: '0 0 14px' }}>
          No work centres yet. Add one below.
        </p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
          {workCentres.map(wc => (
            <div key={wc.id} style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#f5f3ff', border: '1px solid #e9e4ff', borderRadius: 8, padding: '5px 10px', fontSize: 13 }}>
              <span style={{ fontWeight: 600, color: P }}>{wc.name}</span>
              {wc.department && <span style={{ color: '#9ca3af', fontSize: 11 }}>· {wc.department}</span>}
              <span style={{ color: '#c4b5fd', fontSize: 11 }}>· {wc.capacity_hours_per_day}h/day</span>
              <button
                onClick={() => handleRemove(wc.id)}
                disabled={removingId === wc.id}
                title="Remove work centre"
                style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#ef4444', padding: '0 0 0 4px', display: 'flex', alignItems: 'center', opacity: removingId === wc.id ? 0.4 : 1 }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {err && <p style={{ fontSize: 12, color: '#dc2626', margin: '0 0 10px' }}>{err}</p>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          placeholder="Name *"
          value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
          style={{ ...inp, minWidth: 160 }}
        />
        <input
          placeholder="Department"
          value={form.department}
          onChange={e => setForm(f => ({ ...f, department: e.target.value }))}
          style={{ ...inp, minWidth: 120 }}
        />
        <input
          type="number"
          placeholder="Hrs/day"
          value={form.capacity_hours_per_day}
          onChange={e => setForm(f => ({ ...f, capacity_hours_per_day: e.target.value }))}
          style={{ ...inp, width: 80 }}
        />
        <button
          onClick={handleAdd}
          disabled={saving}
          style={{ padding: '7px 14px', borderRadius: 8, border: 'none', background: P, color: '#fff', fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 6, opacity: saving ? 0.7 : 1 }}
        >
          <Plus size={13} /> Add
        </button>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function WorkCentres() {
  const [activeTab, setActiveTab]     = useState('records');
  const [records, setRecords]         = useState([]);
  const [workCentres, setWorkCentres] = useState([]);
  const [loading, setLoading]         = useState(true);
  const [showForm, setShowForm]       = useState(false);
  const [editRecord, setEditRecord]   = useState(null);
  const [showPanel, setShowPanel]     = useState(false);
  const [filterDate, setFilterDate]   = useState(new Date().toISOString().split('T')[0]);
  const [filterWC, setFilterWC]       = useState('');
  const [msg, setMsg]                 = useState({ text: '', ok: true });
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  const flash = (text, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg({ text: '', ok: true }), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/attendance/work-centre?date=${filterDate}`);
      setRecords(Array.isArray(res.data) ? res.data : []);
    } catch {
      setRecords([]);
    } finally { setLoading(false); }
  }, [filterDate]);

  const loadWorkCentres = useCallback(async () => {
    try {
      const res = await api.get('/attendance/work-centres');
      setWorkCentres(Array.isArray(res.data) ? res.data : []);
    } catch { setWorkCentres([]); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadWorkCentres(); }, [loadWorkCentres]);

  const handleSave = (rec, isEdit) => {
    if (isEdit) {
      setRecords(prev => prev.map(r => r.id === rec.id ? { ...r, ...rec } : r));
      flash('Record updated');
    } else {
      setRecords(prev => [rec, ...prev]);
      flash('Work centre attendance logged and synced to main attendance');
    }
    setShowForm(false);
    setEditRecord(null);
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/attendance/work-centre/${id}`);
      setRecords(prev => prev.filter(r => r.id !== id));
      setDeleteConfirm(null);
      flash('Record deleted');
    } catch {
      flash('Failed to delete record', false);
    }
  };

  const filtered = records.filter(r => {
    if (!filterWC) return true;
    return String(r.work_centre_id) === filterWC || r.work_centre_name === filterWC;
  });

  const totalUnits  = filtered.reduce((s, r) => s + (parseInt(r.units_produced) || 0), 0);
  const totalHours  = filtered.reduce((s, r) => s + (parseFloat(r.hours_worked) || 0), 0);
  const uniqueWCCnt = new Set(records.map(r => r.work_centre_name).filter(Boolean)).size;

  const today = new Date().toISOString().split('T')[0];

  return (
    <div style={{ padding: 24, fontFamily: 'Inter, sans-serif', margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#1f2937' }}>Work Centres</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
            Manufacturing work centre attendance and production tracking
          </p>
        </div>
        {activeTab === 'records' && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              onClick={load}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 10, border: '1px solid #e9e4ff', background: '#fff', fontSize: 13, cursor: 'pointer' }}
            >
              <RefreshCw size={13} /> Refresh
            </button>
            <button
              onClick={() => setShowPanel(p => !p)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 10, border: `1px solid ${showPanel ? P : '#e9e4ff'}`, background: showPanel ? '#f5f3ff' : '#fff', color: showPanel ? P : '#374151', fontSize: 13, cursor: 'pointer', fontWeight: showPanel ? 600 : 400 }}
            >
              <Settings size={13} /> Manage Work Centres
              {showPanel ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
            <button
              onClick={() => { setEditRecord(null); setShowForm(true); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 18px', borderRadius: 10, border: 'none', background: P, color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}
            >
              <Plus size={16} /> Log Attendance
            </button>
          </div>
        )}
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '2px solid #f0f0f4', paddingBottom: 0 }}>
        {[
          { id: 'records',   label: 'Attendance Records', icon: Layers },
          { id: 'analytics', label: 'Analytics',          icon: BarChart2 },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '9px 18px', border: 'none', cursor: 'pointer',
              fontWeight: activeTab === t.id ? 700 : 400, fontSize: 13,
              color: activeTab === t.id ? P : '#6b7280',
              background: 'none',
              borderBottom: activeTab === t.id ? `2px solid ${P}` : '2px solid transparent',
              marginBottom: -2,
            }}
          >
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'analytics' && <AnalyticsTab />}

      {activeTab === 'records' && (<>

      {/* Flash message */}
      {msg.text && (
        <div style={{
          background: msg.ok ? '#f0fdf4' : '#fef2f2',
          border: `1px solid ${msg.ok ? '#86efac' : '#fca5a5'}`,
          borderRadius: 8, padding: '10px 14px', marginBottom: 16,
          color: msg.ok ? '#15803d' : '#dc2626',
          fontSize: 13, display: 'flex', alignItems: 'center', gap: 8,
        }}>
          {msg.ok ? <Check size={13} /> : <AlertTriangle size={13} />}
          {msg.text}
        </div>
      )}

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 20 }}>
        {[
          { label: 'Records Today',   value: filtered.length,              color: P,         icon: Layers },
          { label: 'Work Centres',    value: uniqueWCCnt,                  color: '#0369a1', icon: Package },
          { label: 'Total Hours',     value: `${totalHours.toFixed(1)}h`,  color: '#10b981', icon: Clock },
          { label: 'Units Produced',  value: totalUnits,                    color: '#f59e0b', icon: Package },
        ].map(k => (
          <div key={k.label} style={{ ...CARD, padding: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: `${k.color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <k.icon size={18} color={k.color} />
            </div>
            <div>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#1f2937' }}>{k.value}</div>
              <div style={{ fontSize: 11, color: '#6b7280' }}>{k.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Work Centre management panel */}
      {showPanel && (
        <WorkCentrePanel
          workCentres={workCentres}
          onAdd={wc => setWorkCentres(prev => [...prev, wc])}
          onRemove={id => setWorkCentres(prev => prev.filter(w => w.id !== id))}
        />
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="date"
          value={filterDate}
          onChange={e => setFilterDate(e.target.value)}
          style={{ border: '1px solid #e9e4ff', borderRadius: 8, padding: '7px 12px', fontSize: 13, outline: 'none' }}
        />
        <select
          value={filterWC}
          onChange={e => setFilterWC(e.target.value)}
          style={{ border: '1px solid #e9e4ff', borderRadius: 8, padding: '7px 12px', fontSize: 13, outline: 'none', minWidth: 180 }}
        >
          <option value="">All Work Centres</option>
          {workCentres.map(wc => <option key={wc.id} value={String(wc.id)}>{wc.name}</option>)}
        </select>
        {(filterWC || filterDate !== today) && (
          <button
            onClick={() => { setFilterWC(''); setFilterDate(today); }}
            style={{ fontSize: 12, color: P, border: 'none', background: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af', fontSize: 14 }}>Loading records…</div>
      ) : filtered.length === 0 ? (
        <div style={{ ...CARD, textAlign: 'center', padding: 60 }}>
          <Layers size={40} color="#d1d5db" style={{ marginBottom: 12 }} />
          <p style={{ color: '#9ca3af', margin: 0, fontSize: 14 }}>No records for the selected date and filters</p>
          <p style={{ color: '#d1d5db', margin: '6px 0 0', fontSize: 12 }}>Use "Log Attendance" to add the first record</p>
        </div>
      ) : (
        <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #f0f0f4', background: '#fafafa' }}>
                  {['Employee', 'Work Centre', 'Shift', 'Check In', 'Check Out', 'Hours', 'Units', 'Remarks', 'Status', ''].map(h => (
                    <th key={h} style={{ padding: '11px 14px', textAlign: 'left', fontWeight: 600, color: '#6b7280', fontSize: 11, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => {
                  const isActive  = r.check_in && !r.check_out;
                  const isNight   = r.check_in && r.check_out && r.check_out < r.check_in;
                  const isDeleting = deleteConfirm === r.id;
                  return (
                    <tr key={r.id} style={{ borderBottom: '1px solid #f5f5f7' }}>
                      <td style={{ padding: '11px 14px' }}>
                        <div style={{ fontWeight: 600, color: '#1f2937' }}>{r.employee_name}</div>
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>{r.department}</div>
                      </td>
                      <td style={{ padding: '11px 14px' }}>
                        <span style={{ background: '#f5f3ff', color: P, borderRadius: 8, padding: '3px 9px', fontSize: 12, fontWeight: 600 }}>
                          {r.work_centre_name || '—'}
                        </span>
                      </td>
                      <td style={{ padding: '11px 14px', color: '#6b7280' }}>{r.shift_name || '—'}</td>
                      <td style={{ padding: '11px 14px', fontVariantNumeric: 'tabular-nums' }}>{r.check_in || '—'}</td>
                      <td style={{ padding: '11px 14px', fontVariantNumeric: 'tabular-nums' }}>
                        {r.check_out
                          ? <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                              {r.check_out}
                              {isNight && <Moon size={11} color="#6366f1" title="Night shift" />}
                            </span>
                          : isActive
                            ? <span style={{ color: '#10b981', fontWeight: 600, fontSize: 12 }}>On Duty</span>
                            : '—'}
                      </td>
                      <td style={{ padding: '11px 14px', fontWeight: 600, color: '#374151', fontVariantNumeric: 'tabular-nums' }}>
                        {r.hours_worked ? `${parseFloat(r.hours_worked).toFixed(1)}h` : '—'}
                      </td>
                      <td style={{ padding: '11px 14px', color: r.units_produced > 0 ? '#059669' : '#9ca3af', fontWeight: r.units_produced > 0 ? 700 : 400, fontVariantNumeric: 'tabular-nums' }}>
                        {r.units_produced ?? 0}
                      </td>
                      <td style={{ padding: '11px 14px', color: '#6b7280', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.remarks || ''}>
                        {r.remarks || '—'}
                      </td>
                      <td style={{ padding: '11px 14px' }}>
                        <span style={{
                          background: isActive ? '#f0fdf4' : '#f5f3ff',
                          color: isActive ? '#15803d' : P,
                          borderRadius: 10, padding: '3px 9px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
                        }}>
                          {isActive ? 'On Duty' : 'Completed'}
                        </span>
                      </td>
                      <td style={{ padding: '11px 14px', whiteSpace: 'nowrap' }}>
                        {isDeleting ? (
                          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <span style={{ fontSize: 11, color: '#dc2626', fontWeight: 500 }}>Delete?</span>
                            <button
                              onClick={() => handleDelete(r.id)}
                              style={{ border: 'none', background: '#fee2e2', color: '#dc2626', borderRadius: 6, padding: '3px 8px', fontSize: 11, cursor: 'pointer', fontWeight: 600 }}
                            >Yes</button>
                            <button
                              onClick={() => setDeleteConfirm(null)}
                              style={{ border: 'none', background: '#f3f4f6', color: '#374151', borderRadius: 6, padding: '3px 8px', fontSize: 11, cursor: 'pointer' }}
                            >No</button>
                          </span>
                        ) : (
                          <span style={{ display: 'flex', gap: 6 }}>
                            <button
                              onClick={() => { setEditRecord(r); setShowForm(true); }}
                              title="Edit record"
                              style={{ border: 'none', background: '#f5f3ff', color: P, borderRadius: 6, padding: '5px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                            >
                              <Pencil size={12} />
                            </button>
                            <button
                              onClick={() => setDeleteConfirm(r.id)}
                              title="Delete record"
                              style={{ border: 'none', background: '#fef2f2', color: '#ef4444', borderRadius: 6, padding: '5px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                            >
                              <Trash2 size={12} />
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal */}
      {(showForm || editRecord) && (
        <RecordModal
          editRecord={editRecord}
          workCentres={workCentres}
          onSave={handleSave}
          onClose={() => { setShowForm(false); setEditRecord(null); }}
        />
      )}
      </>)}
    </div>
  );
}
