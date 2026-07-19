// frontend/src/features/quality/pages/FATManagement.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

function Badge({ label }) {
  const map = { passed: ['#d1fae5','#16a34a'], failed: ['#fee2e2','#dc2626'], 'in-progress': ['#dbeafe','#2563eb'], pending: ['#f3f4f6','#6b7280'], 'customer-accepted': ['#ede9fe','#6B3FDB'] };
  const [bg, color] = map[label] || ['#f3f4f6','#6b7280'];
  return <span style={{ background: bg, color, padding: '2px 9px', borderRadius: 10, fontSize: 11, fontWeight: 700 }}>{label}</span>;
}

function NewTestRunForm({ onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({ test_type: 'FAT', title: '', production_order_id: '', customer_witness: '', customer_witness_date: '', site_location: '', notes: '' });
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' };
  const lbl = { fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4, display: 'block' };

  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.post('/quality/test-runs', form);
      toast.success('Test run created');
      onCreated();
    } catch (e2) { toast.error(e2?.response?.data?.error || 'Failed'); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <form onSubmit={submit} style={{ background: '#fff', borderRadius: 12, padding: 28, width: 480, maxWidth: '95vw' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 18 }}>
          <h3 style={{ margin: 0 }}>New FAT / SAT Run</h3>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div><label style={lbl}>Type</label>
              <select style={inp} value={form.test_type} onChange={e => f('test_type', e.target.value)}>
                {['FAT','SAT','Type Test','Routine Test'].map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div><label style={lbl}>Production Order ID</label><input style={inp} type="number" value={form.production_order_id} onChange={e => f('production_order_id', e.target.value)} /></div>
          </div>
          <div><label style={lbl}>Title *</label><input style={inp} required value={form.title} onChange={e => f('title', e.target.value)} /></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div><label style={lbl}>Customer Witness</label><input style={inp} value={form.customer_witness} onChange={e => f('customer_witness', e.target.value)} /></div>
            <div><label style={lbl}>Witness Date</label><input type="date" style={inp} value={form.customer_witness_date} onChange={e => f('customer_witness_date', e.target.value)} /></div>
          </div>
          <div><label style={lbl}>Site Location (SAT)</label><input style={inp} value={form.site_location} onChange={e => f('site_location', e.target.value)} /></div>
          <div><label style={lbl}>Notes</label><textarea rows={2} style={inp} value={form.notes} onChange={e => f('notes', e.target.value)} /></div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button type="button" onClick={onClose} style={{ flex: 1, background: '#f3f4f6', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer' }}>Cancel</button>
          <button type="submit" style={{ flex: 2, background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer', fontWeight: 600 }}>Create</button>
        </div>
      </form>
    </div>
  );
}

function TestRunDetail({ run, onClose, onRefresh }) {
  const toast = useToast();
  const [measurements, setMeasurements] = useState(run.measurements || []);
  const [punchPoints, setPunchPoints] = useState(run.punch_points || []);
  const [newPunch, setNewPunch] = useState({ description: '', severity: 'minor', due_date: '' });
  const [tab, setTab] = useState('measurements');

  const addMeasurement = () => setMeasurements(p => [...p, { parameter: '', specified: '', actual: '', unit: '', result: 'pass' }]);
  const setM = (i, k, v) => setMeasurements(p => p.map((m, idx) => idx === i ? { ...m, [k]: v } : m));

  const saveResult = async (result) => {
    try {
      await api.put(`/quality/test-runs/${run.id}`, { result, measurements, status: result === 'passed' ? 'passed' : result === 'failed' ? 'failed' : 'in-progress' });
      toast.success('Test run updated');
      onRefresh();
      onClose();
    } catch (e) { toast.error(e?.response?.data?.error || 'Save failed'); }
  };

  const addPunch = async () => {
    if (!newPunch.description) return;
    try {
      await api.post('/quality/punch-points', { ...newPunch, test_run_id: run.id });
      toast.success('Punch point added');
      setNewPunch({ description: '', severity: 'minor', due_date: '' });
      onRefresh();
    } catch (e) { toast.error('Failed to add punch point'); }
  };

  const closePunch = async (ppId) => {
    try {
      await api.put(`/quality/punch-points/${ppId}`, { status: 'closed' });
      toast.success('Closed');
      onRefresh();
    } catch { toast.error('Failed'); }
  };

  const acceptCustomer = async () => {
    try {
      await api.put(`/quality/test-runs/${run.id}`, { customer_accepted: true, customer_accepted_at: new Date().toISOString() });
      toast.success('Customer acceptance recorded');
      onRefresh(); onClose();
    } catch (e) { toast.error('Failed'); }
  };

  const inp = { padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, boxSizing: 'border-box' };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ background: '#fff', width: 620, height: '100vh', overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ margin: 0 }}>{run.test_type} — {run.title}</h3>
            <div style={{ fontSize: 12, color: '#6b7280' }}>PO: {run.production_order_id || 'N/A'} · Witness: {run.customer_witness || 'None'}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid #e5e7eb' }}>
          {['measurements','punch-points'].map(t => (
            <button key={t} onClick={() => setTab(t)} style={{ padding: '8px 18px', border: 'none', background: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 12, color: tab === t ? '#6B3FDB' : '#6b7280', borderBottom: tab === t ? '2px solid #6B3FDB' : '2px solid transparent', marginBottom: -2, textTransform: 'capitalize' }}>{t.replace('-',' ')}</button>
          ))}
        </div>

        {tab === 'measurements' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={addMeasurement} style={{ background: '#f3f4f6', border: 'none', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontSize: 12 }}>+ Add Row</button>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead><tr style={{ background: '#f9fafb' }}>{['Parameter','Specified','Actual','Unit','Result'].map(h => <th key={h} style={{ padding: '7px 10px', textAlign: 'left', color: '#6b7280' }}>{h}</th>)}</tr></thead>
              <tbody>
                {measurements.map((m, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '6px 4px' }}><input style={{ ...inp, width: '100%' }} value={m.parameter} onChange={e => setM(i,'parameter',e.target.value)} placeholder="e.g. Voltage" /></td>
                    <td style={{ padding: '6px 4px' }}><input style={{ ...inp, width: '100%' }} value={m.specified} onChange={e => setM(i,'specified',e.target.value)} placeholder="±5%" /></td>
                    <td style={{ padding: '6px 4px' }}><input style={{ ...inp, width: '100%' }} value={m.actual} onChange={e => setM(i,'actual',e.target.value)} /></td>
                    <td style={{ padding: '6px 4px' }}><input style={{ ...inp, width: 60 }} value={m.unit} onChange={e => setM(i,'unit',e.target.value)} placeholder="V" /></td>
                    <td style={{ padding: '6px 4px' }}>
                      <select style={{ ...inp }} value={m.result} onChange={e => setM(i,'result',e.target.value)}>
                        {['pass','fail','na'].map(r => <option key={r} value={r}>{r.toUpperCase()}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button onClick={() => saveResult('in-progress')} style={{ flex: 1, background: '#f3f4f6', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer' }}>Save</button>
              <button onClick={() => saveResult('passed')} style={{ flex: 1, background: '#16a34a', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer', fontWeight: 600 }}>FAT PASS</button>
              <button onClick={() => saveResult('failed')} style={{ flex: 1, background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer', fontWeight: 600 }}>FAT FAIL</button>
            </div>
            {run.result === 'passed' && !run.customer_accepted && (
              <button onClick={acceptCustomer} style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer', fontWeight: 600, width: '100%' }}>Record Customer Acceptance</button>
            )}
          </>
        )}

        {tab === 'punch-points' && (
          <>
            <div style={{ display: 'flex', gap: 8 }}>
              <input style={{ ...inp, flex: 2 }} placeholder="Punch point description" value={newPunch.description} onChange={e => setNewPunch(p => ({ ...p, description: e.target.value }))} />
              <select style={inp} value={newPunch.severity} onChange={e => setNewPunch(p => ({ ...p, severity: e.target.value }))}>
                {['minor','major','critical'].map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <input type="date" style={inp} value={newPunch.due_date} onChange={e => setNewPunch(p => ({ ...p, due_date: e.target.value }))} />
              <button onClick={addPunch} style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 12 }}>Add</button>
            </div>
            {(run.punch_points || []).length === 0
              ? <div style={{ color: '#9ca3af', fontSize: 13, padding: 16 }}>No punch points</div>
              : (run.punch_points || []).map(pp => (
                <div key={pp.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #f3f4f6' }}>
                  <div>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>{pp.description}</div>
                    <div style={{ fontSize: 11, color: '#6b7280' }}>Due: {pp.due_date ? new Date(pp.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : 'N/A'} · <span style={{ textTransform: 'capitalize', color: pp.severity === 'critical' ? '#dc2626' : pp.severity === 'major' ? '#d97706' : '#6b7280' }}>{pp.severity}</span></div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Badge label={pp.status} />
                    {pp.status !== 'closed' && pp.status !== 'waived' && <button onClick={() => closePunch(pp.id)} style={{ background: '#d1fae5', color: '#16a34a', border: 'none', borderRadius: 6, padding: '3px 8px', cursor: 'pointer', fontSize: 11 }}>Close</button>}
                  </div>
                </div>
              ))
            }
          </>
        )}
      </div>
    </div>
  );
}

export default function FATManagement() {
  const toast = useToast();
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [selectedRun, setSelectedRun] = useState(null);
  const [typeFilter, setTypeFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { limit: 50 };
      if (typeFilter) params.test_type = typeFilter;
      const res = await api.get('/quality/test-runs', { params });
      setRuns(res.data?.data || res.data || []);
    } catch { toast.error('Failed to load test runs'); }
    finally { setLoading(false); }
  }, [typeFilter, toast]);

  useEffect(() => { load(); }, [load]);

  const sel = { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff' };

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>FAT / SAT Management</h2>
        <button onClick={() => setShowNew(true)} style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', cursor: 'pointer', fontWeight: 600 }}>+ New Test Run</button>
      </div>

      <div style={{ marginBottom: 16 }}>
        <select style={sel} value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
          <option value="">All Types</option>
          {['FAT','SAT','Type Test','Routine Test'].map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      {loading ? <div style={{ color: '#6b7280', padding: 20 }}>Loading…</div> : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Type','Title','PO','Customer Witness','Status','Result','Dispatch Block','Date','Action'].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: '#6b7280' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {runs.length === 0
                ? <tr><td colSpan={9} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>No test runs found</td></tr>
                : runs.map(r => (
                  <tr key={r.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '10px 14px' }}><span style={{ background: '#ede9fe', color: '#6B3FDB', padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700 }}>{r.test_type}</span></td>
                    <td style={{ padding: '10px 14px', fontWeight: 500 }}>{r.title}</td>
                    <td style={{ padding: '10px 14px', color: '#6b7280' }}>{r.production_order_id || '—'}</td>
                    <td style={{ padding: '10px 14px' }}>{r.customer_witness || '—'}</td>
                    <td style={{ padding: '10px 14px' }}><Badge label={r.status || 'pending'} /></td>
                    <td style={{ padding: '10px 14px' }}>{r.result ? <Badge label={r.result} /> : '—'}</td>
                    <td style={{ padding: '10px 14px' }}>{r.dispatch_blocked ? <span style={{ color: '#dc2626', fontWeight: 700 }}>BLOCKED</span> : <span style={{ color: '#16a34a' }}>OK</span>}</td>
                    <td style={{ padding: '10px 14px', fontSize: 12, color: '#9ca3af' }}>{r.created_at ? new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                    <td style={{ padding: '10px 14px' }}>
                      <button onClick={() => setSelectedRun(r)} style={{ background: '#dbeafe', color: '#2563eb', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12 }}>Open</button>
                    </td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>
      )}

      {showNew && <NewTestRunForm onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load(); }} />}
      {selectedRun && <TestRunDetail run={selectedRun} onClose={() => setSelectedRun(null)} onRefresh={load} />}
    </div>
  );
}
