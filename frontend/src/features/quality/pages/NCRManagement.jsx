// frontend/src/features/quality/pages/NCRManagement.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

const SEVERITIES = ['critical','major','minor'];
const SOURCES    = ['quality','procurement','production','service'];
const STATUSES   = ['open','under-review','closed'];

function Badge({ label, map }) {
  const [bg, color] = map[label] || ['#f3f4f6','#6b7280'];
  return <span style={{ background: bg, color, padding: '2px 9px', borderRadius: 10, fontSize: 11, fontWeight: 700, textTransform: 'capitalize' }}>{label}</span>;
}

const SEV_MAP = { critical:['#fee2e2','#dc2626'], major:['#fef3c7','#d97706'], minor:['#d1fae5','#16a34a'] };
const ST_MAP  = { open:['#fee2e2','#dc2626'], 'under-review':['#fef3c7','#d97706'], closed:['#d1fae5','#16a34a'] };

function NCRDrawer({ ncr, onClose, onRefresh }) {
  const toast = useToast();
  const [form, setForm] = useState({ status: ncr.status, root_cause: ncr.root_cause || '', disposition: ncr.disposition || '', containment_action: ncr.containment_action || '' });
  const [submitting, setSubmitting] = useState(false);

  const save = async () => {
    setSubmitting(true);
    try {
      await api.put(`/quality/ncr/${ncr.id}`, form);
      toast.success('NCR updated');
      onRefresh(); onClose();
    } catch (e) { toast.error(e?.response?.data?.error || 'Update failed'); }
    finally { setSubmitting(false); }
  };

  const approve = async () => {
    setSubmitting(true);
    try {
      await api.post(`/quality/ncr/${ncr.id}/approve`, { remarks: form.root_cause });
      toast.success('NCR approved for review');
      onRefresh(); onClose();
    } catch (e) { toast.error(e?.response?.data?.error || 'Approve failed'); }
    finally { setSubmitting(false); }
  };

  const close = async () => {
    if (!form.disposition) { toast.error('Disposition is required to close NCR'); return; }
    setSubmitting(true);
    try {
      await api.post(`/quality/ncr/${ncr.id}/close`, { disposition: form.disposition, root_cause: form.root_cause });
      toast.success('NCR closed');
      onRefresh(); onClose();
    } catch (e) { toast.error(e?.response?.data?.error || 'Close failed'); }
    finally { setSubmitting(false); }
  };

  const downloadCSV = () => {
    window.open(`/api/v1/quality/ncr?export=csv`, '_blank');
  };

  const f = (key, val) => setForm(p => ({ ...p, [key]: val }));
  const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' };
  const lbl = { fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4, display: 'block' };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 999, display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ width: 480, background: '#fff', height: '100%', overflowY: 'auto', padding: 28, boxShadow: '-4px 0 24px rgba(0,0,0,0.15)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{ncr.ncr_number}</div>
            <div style={{ fontSize: 17, fontWeight: 700, marginTop: 2 }}>{ncr.title}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#6b7280' }}>×</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16, fontSize: 13 }}>
          <div><span style={{ color: '#6b7280' }}>Severity: </span><Badge label={ncr.severity} map={SEV_MAP} /></div>
          <div><span style={{ color: '#6b7280' }}>Status: </span><Badge label={ncr.status} map={ST_MAP} /></div>
          <div><span style={{ color: '#6b7280' }}>Source: </span><span style={{ textTransform: 'capitalize' }}>{ncr.source}</span></div>
          <div><span style={{ color: '#6b7280' }}>Vendor: </span>{ncr.vendor_name || '—'}</div>
          {ncr.days_open != null && <div><span style={{ color: '#6b7280' }}>Open: </span>{ncr.days_open} days</div>}
          <div><span style={{ color: '#6b7280' }}>CAPAs: </span>{ncr.capa_count} ({ncr.capa_closed} closed)</div>
        </div>

        <div style={{ background: '#f9fafb', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 13, color: '#374151' }}>
          <strong>Description:</strong><br />{ncr.description}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div><label style={lbl}>Containment Action</label><textarea rows={2} style={inp} value={form.containment_action} onChange={e => f('containment_action', e.target.value)} placeholder="Immediate actions taken to contain the defect…" /></div>
          <div><label style={lbl}>Root Cause</label><textarea rows={3} style={inp} value={form.root_cause} onChange={e => f('root_cause', e.target.value)} placeholder="5-Why / Fishbone analysis…" /></div>
          <div><label style={lbl}>Disposition</label>
            <select style={inp} value={form.disposition} onChange={e => f('disposition', e.target.value)}>
              <option value="">Select disposition…</option>
              {['use-as-is','rework','return-to-vendor','scrap','re-inspect'].map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button onClick={save} disabled={submitting} style={{ flex: 1, background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer', fontWeight: 600 }}>Save</button>
          {ncr.status === 'open' && <button onClick={approve} disabled={submitting} style={{ flex: 1, background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer', fontWeight: 600 }}>Approve for Review</button>}
          {ncr.status !== 'closed' && <button onClick={close} disabled={submitting} style={{ flex: 1, background: '#16a34a', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer', fontWeight: 600 }}>Close NCR</button>}
        </div>
        <button onClick={downloadCSV} style={{ width: '100%', background: '#f3f4f6', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer', marginTop: 8, fontSize: 13 }}>⬇ Export All NCRs (CSV)</button>
      </div>
    </div>
  );
}

function NewNCRForm({ onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({ title: '', description: '', detected_by: '', severity: 'major', source: 'quality', containment_action: '' });
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' };
  const lbl = { fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4, display: 'block' };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.title) { toast.error('Title is required'); return; }
    try {
      await api.post('/quality/ncr', form);
      toast.success('NCR created');
      onCreated();
    } catch (e2) { toast.error(e2?.response?.data?.error || 'Create failed'); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <form onSubmit={submit} style={{ background: '#fff', borderRadius: 12, padding: 28, width: 480, maxWidth: '95vw' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
          <h3 style={{ margin: 0 }}>New NCR</h3>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div><label style={lbl}>Title *</label><input style={inp} value={form.title} onChange={e => f('title', e.target.value)} required /></div>
          <div><label style={lbl}>Description</label><textarea rows={3} style={inp} value={form.description} onChange={e => f('description', e.target.value)} /></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><label style={lbl}>Severity</label>
              <select style={inp} value={form.severity} onChange={e => f('severity', e.target.value)}>
                {SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div><label style={lbl}>Source</label>
              <select style={inp} value={form.source} onChange={e => f('source', e.target.value)}>
                {SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div><label style={lbl}>Detected By</label><input style={inp} value={form.detected_by} onChange={e => f('detected_by', e.target.value)} /></div>
          <div><label style={lbl}>Containment Action</label><textarea rows={2} style={inp} value={form.containment_action} onChange={e => f('containment_action', e.target.value)} /></div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button type="button" onClick={onClose} style={{ flex: 1, background: '#f3f4f6', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer' }}>Cancel</button>
          <button type="submit" style={{ flex: 2, background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer', fontWeight: 600 }}>Raise NCR</button>
        </div>
      </form>
    </div>
  );
}

export default function NCRManagement() {
  const toast = useToast();
  const [ncrs, setNcrs]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [filter, setFilter]   = useState({ status: '', severity: '', source: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (filter.status)   params.status   = filter.status;
      if (filter.severity) params.severity = filter.severity;
      if (filter.source)   params.source   = filter.source;
      const res = await api.get('/quality/ncr', { params });
      setNcrs(res.data?.data || res.data || []);
    } catch { toast.error('Failed to load NCRs'); }
    finally { setLoading(false); }
  }, [filter, toast]);

  useEffect(() => { load(); }, [load]);

  const sel = { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff', cursor: 'pointer' };

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>NCR Management</h2>
        <button onClick={() => setShowNew(true)} style={{ background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', cursor: 'pointer', fontWeight: 600 }}>+ Raise NCR</button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <select style={sel} value={filter.status} onChange={e => setFilter(p => ({ ...p, status: e.target.value }))}>
          <option value="">All Statuses</option>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select style={sel} value={filter.severity} onChange={e => setFilter(p => ({ ...p, severity: e.target.value }))}>
          <option value="">All Severities</option>
          {SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select style={sel} value={filter.source} onChange={e => setFilter(p => ({ ...p, source: e.target.value }))}>
          <option value="">All Sources</option>
          {SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <a href="/api/v1/quality/ncr?export=csv" target="_blank" style={{ padding: '8px 14px', background: '#f3f4f6', borderRadius: 6, fontSize: 13, textDecoration: 'none', color: '#374151', display: 'flex', alignItems: 'center' }}>⬇ CSV</a>
      </div>

      {/* Table */}
      {loading ? <div style={{ color: '#6b7280', padding: 20 }}>Loading…</div> : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['NCR #','Title','Severity','Source','Vendor','Status','Days Open','CAPAs',''].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: '#6b7280', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ncrs.length === 0
                ? <tr><td colSpan={9} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>No NCRs found</td></tr>
                : ncrs.map(n => (
                  <tr key={n.id} style={{ borderTop: '1px solid #f3f4f6', cursor: 'pointer' }} onClick={() => setSelected(n)}>
                    <td style={{ padding: '10px 14px', fontWeight: 700, color: '#6B3FDB' }}>{n.ncr_number}</td>
                    <td style={{ padding: '10px 14px', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.title}</td>
                    <td style={{ padding: '10px 14px' }}><Badge label={n.severity} map={SEV_MAP} /></td>
                    <td style={{ padding: '10px 14px', textTransform: 'capitalize' }}>{n.source}</td>
                    <td style={{ padding: '10px 14px', color: '#6b7280' }}>{n.vendor_name || '—'}</td>
                    <td style={{ padding: '10px 14px' }}><Badge label={n.status} map={ST_MAP} /></td>
                    <td style={{ padding: '10px 14px', color: n.days_open > 30 ? '#dc2626' : '#374151' }}>{n.days_open ?? '—'}</td>
                    <td style={{ padding: '10px 14px' }}>{n.capa_count} / {n.capa_closed} ✓</td>
                    <td style={{ padding: '10px 14px' }}><button onClick={e => { e.stopPropagation(); setSelected(n); }} style={{ background: '#f3f4f6', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12 }}>Open →</button></td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>
      )}

      {selected && <NCRDrawer ncr={selected} onClose={() => setSelected(null)} onRefresh={load} />}
      {showNew && <NewNCRForm onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load(); }} />}
    </div>
  );
}
