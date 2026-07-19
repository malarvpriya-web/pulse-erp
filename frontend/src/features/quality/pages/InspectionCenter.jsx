// frontend/src/features/quality/pages/InspectionCenter.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

const STAGE_LABELS = { IQC: 'Incoming QC', IPQC: 'In-Process QC', FQC: 'Final QC' };

function Badge({ label, colorMap }) {
  const [bg, color] = colorMap?.[label] || ['#f3f4f6', '#6b7280'];
  return <span style={{ background: bg, color, padding: '2px 9px', borderRadius: 10, fontSize: 11, fontWeight: 700 }}>{label?.toUpperCase()}</span>;
}

const RESULT_COLORS = { pass: ['#d1fae5', '#16a34a'], fail: ['#fee2e2', '#dc2626'], conditional: ['#fef3c7', '#d97706'] };
const STATUS_COLORS  = { pending: ['#f3f4f6', '#6b7280'], 'in-progress': ['#dbeafe', '#2563eb'], completed: ['#d1fae5', '#16a34a'] };

function InspectionForm({ stage, onClose, onCreated }) {
  const toast = useToast();
  const [checklists, setChecklists] = useState([]);
  const [form, setForm] = useState({ checklist_id: '', stage, inspector_name: '', notes: '', grn_id: '', production_order_id: '', reference_number: '' });
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' };
  const lbl = { fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4, display: 'block' };

  useEffect(() => {
    api.get(`/quality/checklists?type=${stage}`).then(r => setChecklists(r.data?.data || r.data || [])).catch(() => toast.error('Could not load checklists'));
  }, [stage]);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.checklist_id) { toast.error('Select a checklist'); return; }
    try {
      await api.post('/quality/inspect', form);
      toast.success('Inspection started');
      onCreated();
    } catch (e2) { toast.error(e2?.response?.data?.error || 'Failed'); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <form onSubmit={submit} style={{ background: '#fff', borderRadius: 12, padding: 28, width: 460, maxWidth: '95vw' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 18 }}>
          <h3 style={{ margin: 0 }}>New {STAGE_LABELS[stage]} Inspection</h3>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div><label style={lbl}>Checklist *</label>
            <select style={inp} value={form.checklist_id} onChange={e => f('checklist_id', e.target.value)} required>
              <option value="">Select checklist…</option>
              {checklists.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          {stage === 'IQC' && <div><label style={lbl}>GRN ID (optional)</label><input style={inp} type="number" value={form.grn_id} onChange={e => f('grn_id', e.target.value)} /></div>}
          {(stage === 'IPQC' || stage === 'FQC') && <div><label style={lbl}>Production Order ID</label><input style={inp} type="number" value={form.production_order_id} onChange={e => f('production_order_id', e.target.value)} /></div>}
          <div><label style={lbl}>Reference # (Batch/Lot)</label><input style={inp} value={form.reference_number} onChange={e => f('reference_number', e.target.value)} /></div>
          <div><label style={lbl}>Inspector Name</label><input style={inp} value={form.inspector_name} onChange={e => f('inspector_name', e.target.value)} /></div>
          <div><label style={lbl}>Notes</label><textarea rows={2} style={inp} value={form.notes} onChange={e => f('notes', e.target.value)} /></div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button type="button" onClick={onClose} style={{ flex: 1, background: '#f3f4f6', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer' }}>Cancel</button>
          <button type="submit" style={{ flex: 2, background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer', fontWeight: 600 }}>Start Inspection</button>
        </div>
      </form>
    </div>
  );
}

function InspectionDetail({ id, onClose, onRefresh }) {
  const toast = useToast();
  const [detail, setDetail] = useState(null);
  const [items, setItems] = useState({});

  useEffect(() => {
    api.get(`/quality/inspect/${id}`).then(r => {
      const d = r.data?.data || r.data;
      setDetail(d);
      const init = {};
      (d?.items || []).forEach(i => { init[i.id] = { result: i.result || '', actual_value: i.actual_value || '', notes: i.notes || '' }; });
      setItems(init);
    }).catch(() => toast.error('Load failed'));
  }, [id, toast]);

  const setItem = (iid, k, v) => setItems(p => ({ ...p, [iid]: { ...p[iid], [k]: v } }));

  const save = async (finalResult) => {
    try {
      const item_results = Object.entries(items).map(([item_id, vals]) => ({ item_id, ...vals }));
      await api.put(`/quality/inspect/${id}`, { item_results, overall_result: finalResult || undefined, status: finalResult ? 'completed' : 'in-progress' });
      toast.success(finalResult ? `Inspection ${finalResult}` : 'Progress saved');
      onRefresh();
      if (finalResult) onClose();
    } catch (e) { toast.error(e?.response?.data?.error || 'Save failed'); }
  };

  if (!detail) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end' }}>
      <div style={{ background: '#fff', width: 580, height: '100vh', overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3 style={{ margin: 0 }}>{detail.checklist_name || 'Inspection'}</h3>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{detail.stage} · {detail.inspector_name || 'N/A'} · {detail.reference_number || ''}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer' }}>×</button>
        </div>

        {(detail.items || []).map(item => (
          <div key={item.id} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 14 }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>{item.description}</div>
            {item.specification && <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>Spec: {item.specification}</div>}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {['pass','fail','na'].map(r => (
                <button key={r} onClick={() => setItem(item.id, 'result', r)}
                  style={{ padding: '5px 14px', borderRadius: 6, border: `2px solid ${items[item.id]?.result === r ? '#6B3FDB' : '#e5e7eb'}`, background: items[item.id]?.result === r ? '#dbeafe' : '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, textTransform: 'uppercase' }}>{r}</button>
              ))}
              <input placeholder="Actual value" value={items[item.id]?.actual_value || ''} onChange={e => setItem(item.id, 'actual_value', e.target.value)}
                style={{ flex: 1, minWidth: 100, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12 }} />
            </div>
            <input placeholder="Notes" value={items[item.id]?.notes || ''} onChange={e => setItem(item.id, 'notes', e.target.value)}
              style={{ marginTop: 8, width: '100%', padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, boxSizing: 'border-box' }} />
          </div>
        ))}

        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button onClick={() => save(null)} style={{ flex: 1, background: '#f3f4f6', border: 'none', borderRadius: 8, padding: '10px 0', cursor: 'pointer' }}>Save Progress</button>
          <button onClick={() => save('pass')} style={{ flex: 1, background: '#16a34a', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 0', cursor: 'pointer', fontWeight: 600 }}>✓ PASS</button>
          <button onClick={() => save('fail')} style={{ flex: 1, background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 0', cursor: 'pointer', fontWeight: 600 }}>✗ FAIL</button>
        </div>
      </div>
    </div>
  );
}

export default function InspectionCenter() {
  const toast = useToast();
  const [activeTab, setActiveTab] = useState('IQC');
  const [inspections, setInspections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [detailId, setDetailId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/quality/inspect', { params: { stage: activeTab, limit: 50 } });
      setInspections(res.data?.data || res.data || []);
    } catch { toast.error('Failed to load inspections'); }
    finally { setLoading(false); }
  }, [activeTab, toast]);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Inspection Center</h2>
        <button onClick={() => setShowNew(true)} style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', cursor: 'pointer', fontWeight: 600 }}>+ New Inspection</button>
      </div>

      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '2px solid #e5e7eb' }}>
        {['IQC','IPQC','FQC'].map(t => (
          <button key={t} onClick={() => setActiveTab(t)} style={{ padding: '10px 24px', border: 'none', background: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13, color: activeTab === t ? '#6B3FDB' : '#6b7280', borderBottom: activeTab === t ? '2px solid #6B3FDB' : '2px solid transparent', marginBottom: -2 }}>{STAGE_LABELS[t]}</button>
        ))}
      </div>

      {loading ? <div style={{ color: '#6b7280', padding: 20 }}>Loading…</div> : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['ID','Checklist','Reference','Inspector','Status','Result','Date','Action'].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: '#6b7280' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {inspections.length === 0
                ? <tr><td colSpan={8} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>No {STAGE_LABELS[activeTab]} inspections yet</td></tr>
                : inspections.map(i => (
                  <tr key={i.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '10px 14px', color: '#6b7280' }}>#{i.id}</td>
                    <td style={{ padding: '10px 14px', fontWeight: 500 }}>{i.checklist_name || `Checklist ${i.checklist_id}`}</td>
                    <td style={{ padding: '10px 14px' }}>{i.reference_number || '—'}</td>
                    <td style={{ padding: '10px 14px' }}>{i.inspector_name || '—'}</td>
                    <td style={{ padding: '10px 14px' }}><Badge label={i.status || 'pending'} colorMap={STATUS_COLORS} /></td>
                    <td style={{ padding: '10px 14px' }}>{i.overall_result ? <Badge label={i.overall_result} colorMap={RESULT_COLORS} /> : '—'}</td>
                    <td style={{ padding: '10px 14px', color: '#9ca3af', fontSize: 12 }}>{i.created_at ? new Date(i.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                    <td style={{ padding: '10px 14px' }}>
                      <button onClick={() => setDetailId(i.id)} style={{ background: '#dbeafe', color: '#2563eb', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12 }}>
                        {i.status === 'completed' ? 'View' : 'Execute'}
                      </button>
                    </td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>
      )}

      {showNew && <InspectionForm stage={activeTab} onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load(); }} />}
      {detailId && <InspectionDetail id={detailId} onClose={() => setDetailId(null)} onRefresh={load} />}
    </div>
  );
}
