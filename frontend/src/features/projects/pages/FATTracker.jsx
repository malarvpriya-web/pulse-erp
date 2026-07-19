import { useState, useEffect, useCallback, useRef } from 'react';
import { ClipboardCheck, Plus, X, RefreshCw, CheckCircle, XCircle, Clock, AlertCircle } from 'lucide-react';
import { getProjectFAT, createFATRecord, updateFATRecord, getProjects } from '../services/projectsService';

const STATUS_META = {
  scheduled:        { bg: '#dbeafe', color: '#1d4ed8', label: 'Scheduled' },
  in_progress:      { bg: '#fef3c7', color: '#92400e', label: 'In Progress' },
  passed:           { bg: '#dcfce7', color: '#15803d', label: 'PASSED' },
  failed:           { bg: '#fee2e2', color: '#dc2626', label: 'FAILED' },
  conditional_pass: { bg: '#fef9c3', color: '#a16207', label: 'Conditional Pass' },
};

const DEFAULT_PARAMS = [
  { parameter: 'Insulation Resistance Test', method: 'IEC 60076', result: '', limit: '>1000 MΩ', status: '' },
  { parameter: 'Transformer Ratio Test', method: 'IEEE C57.12.90', result: '', limit: '±0.5%', status: '' },
  { parameter: 'No-Load Loss Test', method: 'IEC 60076-1', result: '', limit: '', status: '' },
  { parameter: 'Load Loss Test', method: 'IEC 60076-1', result: '', limit: '', status: '' },
  { parameter: 'High Voltage Test (Applied/Induced)', method: 'IEC 60060', result: '', limit: '', status: '' },
  { parameter: 'Temperature Rise Test', method: 'IEC 60076-2', result: '', limit: '', status: '' },
];

const empty = () => ({
  serial_number: '', product_name: '', scheduled_date: '', actual_date: '',
  status: 'scheduled', test_location: '', client_witness: '', engineer_name: '',
  test_parameters: DEFAULT_PARAMS, punch_points: [], remarks: '',
  failure_description: '', retest_date: '', certificate_number: '', certificate_date: '',
  production_order_id: '',
});

export default function FATTracker({ setPage, urlParams }) {
  const [projects,    setProjects]    = useState([]);
  const [selectedPid, setSelectedPid] = useState('');
  const [records,     setRecords]     = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [drawer,      setDrawer]      = useState(false);
  const [editItem,    setEditItem]    = useState(null);
  const [form,        setForm]        = useState(empty());
  const [toast,       setToast]       = useState(null);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };

  useEffect(() => {
    const pid = urlParams?.id || sessionStorage.getItem('selectedProjectId');
    if (pid) setSelectedPid(String(pid));
    getProjects().then(p => { if (isMounted.current) setProjects(p); });
  }, [urlParams?.id]);

  const load = useCallback(async () => {
    if (!selectedPid) return;
    setLoading(true);
    try {
      const data = await getProjectFAT(selectedPid);
      if (isMounted.current) setRecords(Array.isArray(data) ? data : []);
    } catch { /* */ }
    if (isMounted.current) setLoading(false);
  }, [selectedPid]);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setEditItem(null); setForm(empty()); setDrawer(true); };
  const openEdit   = (r) => {
    setEditItem(r);
    setForm({
      ...r,
      test_parameters: r.test_parameters || DEFAULT_PARAMS,
      punch_points: r.punch_points || [],
    });
    setDrawer(true);
  };

  const handleSave = async () => {
    if (!form.serial_number && !form.product_name) return showToast('Serial number or product name required', 'error');
    try {
      if (editItem) {
        await updateFATRecord(editItem.id, form);
        showToast('FAT record updated');
      } else {
        await createFATRecord(selectedPid, form);
        showToast('FAT record created');
      }
      setDrawer(false);
      load();
    } catch (e) {
      showToast(e.response?.data?.error || 'Failed to save', 'error');
    }
  };

  const updateParam = (idx, field, val) => {
    const params = [...(form.test_parameters || [])];
    params[idx] = { ...params[idx], [field]: val };
    setForm(prev => ({ ...prev, test_parameters: params }));
  };

  const addPunchPoint = () => {
    setForm(prev => ({
      ...prev,
      punch_points: [...(prev.punch_points || []), { description: '', severity: 'minor', resolved: false }],
    }));
  };

  const passed = records.filter(r => r.status === 'passed').length;
  const failed = records.filter(r => r.status === 'failed').length;

  return (
    <div style={{ padding: '20px 24px' }}>
      {toast && (
        <div style={{ position: 'fixed', top: 16, right: 16, padding: '10px 16px', borderRadius: 8, zIndex: 9999, background: toast.type === 'error' ? '#fef2f2' : '#f0fdf4', color: toast.type === 'error' ? '#dc2626' : '#15803d', border: `1px solid ${toast.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>{toast.msg}</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>FAT Tracker — Factory Acceptance Tests</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Track and manage factory acceptance tests for HVDC, STATCOM, SST units</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={{ padding: '8px 12px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', cursor: 'pointer' }}><RefreshCw size={14} /></button>
          <button onClick={openCreate} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
            <Plus size={14} /> Schedule FAT
          </button>
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <select value={selectedPid} onChange={e => setSelectedPid(e.target.value)} style={{ padding: '8px 12px', border: '1px solid var(--color-border)', borderRadius: 6, minWidth: 280, background: 'var(--color-background)', color: 'var(--color-text-primary)' }}>
          <option value="">— Select Project —</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.project_code} — {p.project_name}</option>)}
        </select>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Total FATs', value: records.length, color: '#6366f1', bg: '#eef2ff' },
          { label: 'Passed', value: passed, color: '#15803d', bg: '#f0fdf4' },
          { label: 'Failed', value: failed, color: '#dc2626', bg: '#fef2f2' },
          { label: 'Pending', value: records.filter(r => r.status === 'scheduled').length, color: '#92400e', bg: '#fef3c7' },
        ].map(k => (
          <div key={k.label} style={{ background: k.bg, borderRadius: 8, padding: '14px 16px', border: `1px solid ${k.color}22` }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: k.color }}>{k.value}</div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{k.label}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 48, color: '#6b7280' }}>Loading FAT records…</div>
      ) : records.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <ClipboardCheck size={36} style={{ color: '#9ca3af', marginBottom: 8 }} />
          <p style={{ color: '#6b7280', margin: 0 }}>No FAT records {selectedPid ? '— schedule the first test' : '— select a project first'}</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {records.map(r => {
            const sm = STATUS_META[r.status] || STATUS_META.scheduled;
            const params = r.test_parameters || [];
            const passedParams = params.filter(p => p.status === 'pass').length;
            return (
              <div key={r.id} style={{ background: 'var(--color-background-secondary)', border: `1px solid var(--color-border-tertiary)`, borderRadius: 10, padding: '16px 18px', borderLeft: `4px solid ${sm.color}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#9ca3af' }}>{r.fat_number}</span>
                      <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 700, background: sm.bg, color: sm.color }}>{sm.label}</span>
                      {r.certificate_number && <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, background: '#dcfce7', color: '#15803d' }}>Cert: {r.certificate_number}</span>}
                    </div>
                    <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{r.product_name} {r.serial_number ? `(S/N: ${r.serial_number})` : ''}</div>
                    <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#9ca3af', flexWrap: 'wrap' }}>
                      {r.scheduled_date && <span>Scheduled: <b style={{ color: 'var(--color-text-secondary)' }}>{new Date(r.scheduled_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</b></span>}
                      {r.actual_date && <span>Tested: <b style={{ color: 'var(--color-text-secondary)' }}>{new Date(r.actual_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</b></span>}
                      {r.test_location && <span>Location: <b style={{ color: 'var(--color-text-secondary)' }}>{r.test_location}</b></span>}
                      {r.client_witness && <span>Client Witness: <b style={{ color: 'var(--color-text-secondary)' }}>{r.client_witness}</b></span>}
                      {r.engineer_name && <span>Engineer: <b style={{ color: 'var(--color-text-secondary)' }}>{r.engineer_name}</b></span>}
                    </div>
                    {params.length > 0 && (
                      <div style={{ marginTop: 8, fontSize: 12, color: '#6b7280' }}>
                        Test Parameters: {passedParams}/{params.length} passed
                        <div style={{ height: 4, background: '#f3f4f6', borderRadius: 2, marginTop: 4, width: 160 }}>
                          <div style={{ height: '100%', width: `${params.length ? (passedParams / params.length) * 100 : 0}%`, background: '#10b981', borderRadius: 2 }} />
                        </div>
                      </div>
                    )}
                    {(r.punch_points || []).filter(p => !p.resolved).length > 0 && (
                      <div style={{ marginTop: 6, fontSize: 12, color: '#dc2626' }}>
                        ⚠ {(r.punch_points || []).filter(p => !p.resolved).length} open punch point(s)
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button onClick={() => openEdit(r)} style={{ padding: '6px 12px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', cursor: 'pointer', fontSize: 12 }}>Edit / Results</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* FAT Form Drawer */}
      {drawer && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }} onClick={() => setDrawer(false)}>
          <div style={{ width: 640, background: 'var(--color-background)', height: '100%', overflowY: 'auto', padding: 24 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ margin: 0 }}>{editItem ? 'Update FAT Record' : 'Schedule FAT'}</h3>
              <button onClick={() => setDrawer(false)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><X size={20} /></button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
              {[
                { label: 'Serial Number', key: 'serial_number' },
                { label: 'Product Name', key: 'product_name' },
                { label: 'Test Location', key: 'test_location' },
                { label: 'Client Witness', key: 'client_witness' },
                { label: 'Engineer Name', key: 'engineer_name' },
                { label: 'Certificate No.', key: 'certificate_number' },
              ].map(f => (
                <div key={f.key}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>{f.label}</label>
                  <input value={form[f.key] || ''} onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))} style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)' }} />
                </div>
              ))}
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Scheduled Date</label>
                <input type="date" value={form.scheduled_date || ''} onChange={e => setForm(prev => ({ ...prev, scheduled_date: e.target.value }))} style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Actual Test Date</label>
                <input type="date" value={form.actual_date || ''} onChange={e => setForm(prev => ({ ...prev, actual_date: e.target.value }))} style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Certificate Date</label>
                <input type="date" value={form.certificate_date || ''} onChange={e => setForm(prev => ({ ...prev, certificate_date: e.target.value }))} style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Status</label>
                <select value={form.status || 'scheduled'} onChange={e => setForm(prev => ({ ...prev, status: e.target.value }))} style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)' }}>
                  {Object.entries(STATUS_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              </div>
            </div>

            {/* Test Parameters */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: 'var(--color-text-primary)' }}>Test Parameters</div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: 'var(--color-background-secondary)' }}>
                      {['Parameter', 'Method', 'Result', 'Limit', 'Pass/Fail'].map(h => (
                        <th key={h} style={{ padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid var(--color-border)', fontWeight: 600, color: '#6b7280', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(form.test_parameters || []).map((p, idx) => (
                      <tr key={idx}>
                        <td style={{ padding: '4px 6px', borderBottom: '1px solid var(--color-border-tertiary)' }}>
                          <input value={p.parameter || ''} onChange={e => updateParam(idx, 'parameter', e.target.value)} style={{ width: '100%', padding: '4px 6px', border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-background)', color: 'var(--color-text-primary)', fontSize: 12 }} />
                        </td>
                        <td style={{ padding: '4px 6px', borderBottom: '1px solid var(--color-border-tertiary)' }}>
                          <input value={p.method || ''} onChange={e => updateParam(idx, 'method', e.target.value)} style={{ width: '100%', padding: '4px 6px', border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-background)', color: 'var(--color-text-primary)', fontSize: 12 }} />
                        </td>
                        <td style={{ padding: '4px 6px', borderBottom: '1px solid var(--color-border-tertiary)' }}>
                          <input value={p.result || ''} onChange={e => updateParam(idx, 'result', e.target.value)} style={{ width: '100%', padding: '4px 6px', border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-background)', color: 'var(--color-text-primary)', fontSize: 12 }} />
                        </td>
                        <td style={{ padding: '4px 6px', borderBottom: '1px solid var(--color-border-tertiary)' }}>
                          <input value={p.limit || ''} onChange={e => updateParam(idx, 'limit', e.target.value)} style={{ width: '100%', padding: '4px 6px', border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-background)', color: 'var(--color-text-primary)', fontSize: 12 }} />
                        </td>
                        <td style={{ padding: '4px 6px', borderBottom: '1px solid var(--color-border-tertiary)' }}>
                          <select value={p.status || ''} onChange={e => updateParam(idx, 'status', e.target.value)} style={{ padding: '4px 6px', border: '1px solid var(--color-border)', borderRadius: 4, background: p.status === 'pass' ? '#dcfce7' : p.status === 'fail' ? '#fee2e2' : 'var(--color-background)', color: p.status === 'pass' ? '#15803d' : p.status === 'fail' ? '#dc2626' : 'var(--color-text-primary)', fontSize: 12, cursor: 'pointer' }}>
                            <option value="">—</option>
                            <option value="pass">PASS</option>
                            <option value="fail">FAIL</option>
                            <option value="waived">Waived</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button onClick={() => setForm(prev => ({ ...prev, test_parameters: [...(prev.test_parameters || []), { parameter: '', method: '', result: '', limit: '', status: '' }] }))} style={{ marginTop: 8, padding: '4px 10px', border: '1px dashed #9ca3af', borderRadius: 4, background: 'transparent', cursor: 'pointer', fontSize: 12, color: '#6b7280' }}>
                  + Add Test Parameter
                </button>
              </div>
            </div>

            {/* Punch Points */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>Punch Points</span>
                <button onClick={addPunchPoint} style={{ padding: '4px 8px', border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-background)', cursor: 'pointer', fontSize: 12 }}>+ Add</button>
              </div>
              {(form.punch_points || []).map((pp, idx) => (
                <div key={idx} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
                  <input value={pp.description || ''} onChange={e => {
                    const pts = [...(form.punch_points || [])];
                    pts[idx] = { ...pts[idx], description: e.target.value };
                    setForm(prev => ({ ...prev, punch_points: pts }));
                  }} placeholder="Punch point description…" style={{ flex: 1, padding: '6px 8px', border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-background)', color: 'var(--color-text-primary)', fontSize: 12 }} />
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
                    <input type="checkbox" checked={pp.resolved || false} onChange={e => {
                      const pts = [...(form.punch_points || [])];
                      pts[idx] = { ...pts[idx], resolved: e.target.checked };
                      setForm(prev => ({ ...prev, punch_points: pts }));
                    }} />
                    Resolved
                  </label>
                  <button onClick={() => setForm(prev => ({ ...prev, punch_points: prev.punch_points.filter((_, i) => i !== idx) }))} style={{ padding: '4px 6px', border: 'none', background: 'none', cursor: 'pointer', color: '#dc2626' }}><X size={14} /></button>
                </div>
              ))}
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Remarks</label>
              <textarea rows={2} value={form.remarks || ''} onChange={e => setForm(prev => ({ ...prev, remarks: e.target.value }))} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, resize: 'vertical', background: 'var(--color-background)', color: 'var(--color-text-primary)' }} />
            </div>
            {form.status === 'failed' && (
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: '#dc2626' }}>Failure Description *</label>
                <textarea rows={2} value={form.failure_description || ''} onChange={e => setForm(prev => ({ ...prev, failure_description: e.target.value }))} style={{ width: '100%', padding: '8px 10px', border: '1px solid #fecaca', borderRadius: 6, resize: 'vertical', background: 'var(--color-background)', color: 'var(--color-text-primary)' }} />
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setDrawer(false)} style={{ padding: '10px 20px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleSave} style={{ padding: '10px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer' }}>
                {editItem ? 'Update FAT' : 'Create FAT'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
