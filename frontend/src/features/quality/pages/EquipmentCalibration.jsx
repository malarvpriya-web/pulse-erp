// frontend/src/features/quality/pages/EquipmentCalibration.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

const STATUS_COLORS = { calibrated: ['#d1fae5','#16a34a'], due: ['#fef3c7','#d97706'], overdue: ['#fee2e2','#dc2626'], 'not-calibrated': ['#f3f4f6','#6b7280'] };

function Badge({ label }) {
  const [bg, color] = STATUS_COLORS[label] || ['#f3f4f6','#6b7280'];
  return <span style={{ background: bg, color, padding: '2px 9px', borderRadius: 10, fontSize: 11, fontWeight: 700 }}>{label}</span>;
}

function EquipmentForm({ item, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(item || { name: '', equipment_id: '', category: '', location: '', make: '', model: '', serial_number: '', calibration_frequency_days: 365, next_calibration_date: '', notes: '' });
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' };
  const lbl = { fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4, display: 'block' };

  const submit = async (e) => {
    e.preventDefault();
    try {
      if (item?.id) await api.put(`/quality/calibration/equipment/${item.id}`, form);
      else await api.post('/quality/calibration/equipment', form);
      toast.success(item?.id ? 'Updated' : 'Equipment added');
      onSaved();
    } catch (e2) { toast.error(e2?.response?.data?.error || 'Save failed'); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', overflowY: 'auto' }}>
      <form onSubmit={submit} style={{ background: '#fff', borderRadius: 12, padding: 28, width: 540, maxWidth: '95vw', margin: '20px auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 18 }}>
          <h3 style={{ margin: 0 }}>{item?.id ? 'Edit Equipment' : 'Add Equipment'}</h3>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><label style={lbl}>Name *</label><input style={inp} required value={form.name} onChange={e => f('name', e.target.value)} /></div>
          <div><label style={lbl}>Equipment ID *</label><input style={inp} required value={form.equipment_id} onChange={e => f('equipment_id', e.target.value)} /></div>
          <div><label style={lbl}>Category</label>
            <select style={inp} value={form.category} onChange={e => f('category', e.target.value)}>
              {['','Electrical','Mechanical','Thermal','Pressure','Dimensional','Optical','RF','Other'].map(c => <option key={c} value={c}>{c || 'Select…'}</option>)}
            </select>
          </div>
          <div><label style={lbl}>Location</label><input style={inp} value={form.location} onChange={e => f('location', e.target.value)} /></div>
          <div><label style={lbl}>Make / Manufacturer</label><input style={inp} value={form.make} onChange={e => f('make', e.target.value)} /></div>
          <div><label style={lbl}>Model</label><input style={inp} value={form.model} onChange={e => f('model', e.target.value)} /></div>
          <div><label style={lbl}>Serial Number</label><input style={inp} value={form.serial_number} onChange={e => f('serial_number', e.target.value)} /></div>
          <div><label style={lbl}>Calibration Frequency (days)</label><input type="number" style={inp} value={form.calibration_frequency_days} onChange={e => f('calibration_frequency_days', e.target.value)} /></div>
          <div><label style={lbl}>Next Calibration Date</label><input type="date" style={inp} value={form.next_calibration_date?.slice(0,10) || ''} onChange={e => f('next_calibration_date', e.target.value)} /></div>
          <div style={{ gridColumn: 'span 2' }}><label style={lbl}>Notes / Acceptance Criteria</label><textarea rows={2} style={inp} value={form.notes} onChange={e => f('notes', e.target.value)} /></div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button type="button" onClick={onClose} style={{ flex: 1, background: '#f3f4f6', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer' }}>Cancel</button>
          <button type="submit" style={{ flex: 2, background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer', fontWeight: 600 }}>Save</button>
        </div>
      </form>
    </div>
  );
}

function RecordForm({ equipmentId, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ calibration_date: new Date().toISOString().slice(0,10), next_due_date: '', performed_by: '', certificate_number: '', result: 'pass', calibrating_lab: '', remarks: '' });
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' };
  const lbl = { fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4, display: 'block' };

  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.post('/quality/calibration/records', { ...form, equipment_id: equipmentId });
      toast.success('Calibration record added');
      onSaved();
    } catch (e2) { toast.error(e2?.response?.data?.error || 'Save failed'); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1001, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <form onSubmit={submit} style={{ background: '#fff', borderRadius: 12, padding: 28, width: 480, maxWidth: '95vw' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 18 }}>
          <h3 style={{ margin: 0 }}>Add Calibration Record</h3>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><label style={lbl}>Calibration Date *</label><input type="date" style={inp} required value={form.calibration_date} onChange={e => f('calibration_date', e.target.value)} /></div>
          <div><label style={lbl}>Next Due Date *</label><input type="date" style={inp} required value={form.next_due_date} onChange={e => f('next_due_date', e.target.value)} /></div>
          <div><label style={lbl}>Performed By</label><input style={inp} value={form.performed_by} onChange={e => f('performed_by', e.target.value)} /></div>
          <div><label style={lbl}>Calibrating Lab / Agency</label><input style={inp} value={form.calibrating_lab} onChange={e => f('calibrating_lab', e.target.value)} /></div>
          <div><label style={lbl}>Certificate No.</label><input style={inp} value={form.certificate_number} onChange={e => f('certificate_number', e.target.value)} /></div>
          <div><label style={lbl}>Result</label>
            <select style={inp} value={form.result} onChange={e => f('result', e.target.value)}>
              {['pass','fail','conditional'].map(r => <option key={r} value={r}>{r.toUpperCase()}</option>)}
            </select>
          </div>
          <div style={{ gridColumn: 'span 2' }}><label style={lbl}>Remarks</label><textarea rows={2} style={inp} value={form.remarks} onChange={e => f('remarks', e.target.value)} /></div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button type="button" onClick={onClose} style={{ flex: 1, background: '#f3f4f6', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer' }}>Cancel</button>
          <button type="submit" style={{ flex: 2, background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer', fontWeight: 600 }}>Save Record</button>
        </div>
      </form>
    </div>
  );
}

export default function EquipmentCalibration() {
  const toast = useToast();
  const [equipment, setEquipment] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [recordFor, setRecordFor] = useState(null);
  const [tab, setTab] = useState('register');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [eqRes, alRes] = await Promise.allSettled([
        api.get('/quality/calibration/equipment'),
        api.get('/quality/calibration/due-alerts?days=60'),
      ]);
      if (eqRes.status === 'fulfilled') setEquipment(eqRes.value.data?.data || eqRes.value.data || []);
      if (alRes.status === 'fulfilled') setAlerts(alRes.value.data?.data || alRes.value.data || []);
    } catch { toast.error('Failed to load calibration data'); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const deleteEq = async (id) => {
    if (!confirm('Delete this equipment?')) return;
    try { await api.delete(`/quality/calibration/equipment/${id}`); toast.success('Deleted'); load(); }
    catch (e) { toast.error('Delete failed'); }
  };

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Equipment Calibration</h2>
        <button onClick={() => { setEditItem(null); setShowForm(true); }} style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', cursor: 'pointer', fontWeight: 600 }}>+ Add Equipment</button>
      </div>

      {alerts.length > 0 && (
        <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 10, padding: 14, marginBottom: 20 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: '#92400e', marginBottom: 8 }}>⚠ {alerts.length} instruments due for calibration (next 60 days)</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {alerts.slice(0,6).map((a, i) => (
              <span key={i} style={{ background: '#fff', border: '1px solid #fcd34d', borderRadius: 6, padding: '3px 10px', fontSize: 11 }}>
                <strong>{a.name}</strong> ({a.equipment_id}) — Due {a.next_calibration_date ? new Date(a.next_calibration_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : 'N/A'}
              </span>
            ))}
            {alerts.length > 6 && <span style={{ fontSize: 11, color: '#d97706', alignSelf: 'center' }}>+{alerts.length - 6} more</span>}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '2px solid #e5e7eb' }}>
        {['register','due-alerts'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ padding: '10px 24px', border: 'none', background: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13, color: tab === t ? '#6B3FDB' : '#6b7280', borderBottom: tab === t ? '2px solid #6B3FDB' : '2px solid transparent', marginBottom: -2, textTransform: 'capitalize' }}>{t.replace('-',' ')}</button>
        ))}
      </div>

      {loading ? <div style={{ color: '#6b7280', padding: 20 }}>Loading…</div> : tab === 'register' ? (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Equip ID','Name','Category','Location','Frequency','Last Cal','Next Cal','Status','Actions'].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: '#6b7280' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {equipment.length === 0
                ? <tr><td colSpan={9} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>No equipment registered yet</td></tr>
                : equipment.map(e => (
                  <tr key={e.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '10px 14px', fontWeight: 600 }}>{e.equipment_id}</td>
                    <td style={{ padding: '10px 14px' }}>{e.name}</td>
                    <td style={{ padding: '10px 14px', color: '#6b7280' }}>{e.category || '—'}</td>
                    <td style={{ padding: '10px 14px', color: '#6b7280' }}>{e.location || '—'}</td>
                    <td style={{ padding: '10px 14px' }}>{e.calibration_frequency_days}d</td>
                    <td style={{ padding: '10px 14px', fontSize: 12 }}>{e.last_calibration_date ? new Date(e.last_calibration_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                    <td style={{ padding: '10px 14px', fontSize: 12 }}>{e.next_calibration_date ? new Date(e.next_calibration_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                    <td style={{ padding: '10px 14px' }}><Badge label={e.calibration_status || 'not-calibrated'} /></td>
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => setRecordFor(e.id)} style={{ background: '#d1fae5', color: '#16a34a', border: 'none', borderRadius: 6, padding: '3px 8px', cursor: 'pointer', fontSize: 11 }}>+ Record</button>
                        <button onClick={() => { setEditItem(e); setShowForm(true); }} style={{ background: '#dbeafe', color: '#2563eb', border: 'none', borderRadius: 6, padding: '3px 8px', cursor: 'pointer', fontSize: 11 }}>Edit</button>
                        <button onClick={() => deleteEq(e.id)} style={{ background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 6, padding: '3px 8px', cursor: 'pointer', fontSize: 11 }}>Del</button>
                      </div>
                    </td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Equipment ID','Name','Location','Next Calibration','Days Remaining','Status'].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: '#6b7280' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {alerts.length === 0
                ? <tr><td colSpan={6} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>No calibrations due in next 60 days</td></tr>
                : alerts.map(a => {
                  const days = a.next_calibration_date ? Math.ceil((new Date(a.next_calibration_date) - new Date()) / 86400000) : 999;
                  return (
                    <tr key={a.id} style={{ borderTop: '1px solid #f3f4f6', background: days < 0 ? '#fff5f5' : days < 14 ? '#fffbeb' : 'transparent' }}>
                      <td style={{ padding: '10px 14px', fontWeight: 600 }}>{a.equipment_id}</td>
                      <td style={{ padding: '10px 14px' }}>{a.name}</td>
                      <td style={{ padding: '10px 14px', color: '#6b7280' }}>{a.location || '—'}</td>
                      <td style={{ padding: '10px 14px' }}>{a.next_calibration_date ? new Date(a.next_calibration_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                      <td style={{ padding: '10px 14px', fontWeight: 700, color: days < 0 ? '#dc2626' : days < 14 ? '#d97706' : '#16a34a' }}>{days < 0 ? `${Math.abs(days)}d overdue` : `${days}d`}</td>
                      <td style={{ padding: '10px 14px' }}><Badge label={a.calibration_status || 'not-calibrated'} /></td>
                    </tr>
                  );
                })
              }
            </tbody>
          </table>
        </div>
      )}

      {showForm && <EquipmentForm item={editItem} onClose={() => { setShowForm(false); setEditItem(null); }} onSaved={() => { setShowForm(false); setEditItem(null); load(); }} />}
      {recordFor && <RecordForm equipmentId={recordFor} onClose={() => setRecordFor(null)} onSaved={() => { setRecordFor(null); load(); }} />}
    </div>
  );
}
