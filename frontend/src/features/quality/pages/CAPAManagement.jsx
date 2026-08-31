// frontend/src/features/quality/pages/CAPAManagement.jsx
import { useState, useEffect, useCallback } from 'react';
import {
  Repeat, Plus, Download, FolderOpen, PlayCircle, CheckCircle2,
  BadgeCheck, AlarmClock,
} from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { PageHero, PageShell, StatBand, Stat } from '@/components/pulse-ui';

// Ratings are stored unbounded, so clamp before rendering: '☆'.repeat(5 - r)
// throws RangeError on a negative count and blanks the page via the ErrorBoundary.
const stars = (rating) => {
  const r = Math.min(5, Math.max(0, Math.round(Number(rating) || 0)));
  return '★'.repeat(r) + '☆'.repeat(5 - r);
};

const STATUSES = ['open','in-progress','completed','verified'];

function Badge({ label }) {
  const map = { open:['#fee2e2','#dc2626'], 'in-progress':['#dbeafe','#2563eb'], completed:['#d1fae5','#16a34a'], verified:['#ede9fe','#6B3FDB'] };
  const [bg, color] = map[label] || ['#f3f4f6','#6b7280'];
  return <span style={{ background: bg, color, padding: '2px 9px', borderRadius: 10, fontSize: 11, fontWeight: 700 }}>{label}</span>;
}

function CAPAForm({ ncr_id, onClose, onCreated }) {
  const toast = useToast();
  const [employees, setEmployees] = useState([]);
  const [form, setForm] = useState({ ncr_id: ncr_id || '', action_type: 'corrective', description: '', employee_id: '', verifier_id: '', due_date: '' });
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' };
  const lbl = { fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4, display: 'block' };

  useEffect(() => {
    api.get('/employees?limit=200').then(r => setEmployees(Array.isArray(r.data) ? r.data : r.data?.employees || r.data?.data || [])).catch(() => toast.error('Could not load employees'));
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.ncr_id || !form.description) { toast.error('NCR ID and description required'); return; }
    try {
      await api.post('/quality/capa', form);
      toast.success('CAPA created');
      onCreated();
    } catch (e2) { toast.error(e2?.response?.data?.error || 'Create failed'); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <form onSubmit={submit} style={{ background: '#fff', borderRadius: 12, padding: 28, width: 480, maxWidth: '95vw' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
          <h3 style={{ margin: 0 }}>New CAPA</h3>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div><label style={lbl}>NCR ID *</label><input style={inp} type="number" value={form.ncr_id} onChange={e => f('ncr_id', e.target.value)} required /></div>
          <div><label style={lbl}>Action Type</label>
            <select style={inp} value={form.action_type} onChange={e => f('action_type', e.target.value)}>
              {['corrective','preventive','improvement'].map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div><label style={lbl}>Description *</label><textarea rows={3} style={inp} value={form.description} onChange={e => f('description', e.target.value)} required /></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><label style={lbl}>Assigned To (Employee)</label>
              <select style={inp} value={form.employee_id} onChange={e => f('employee_id', e.target.value)}>
                <option value="">Select…</option>
                {employees.map(e => <option key={e.id} value={e.id}>{e.name || `${e.first_name} ${e.last_name}`}</option>)}
              </select>
            </div>
            <div><label style={lbl}>Verifier</label>
              <select style={inp} value={form.verifier_id} onChange={e => f('verifier_id', e.target.value)}>
                <option value="">Select…</option>
                {employees.map(e => <option key={e.id} value={e.id}>{e.name || `${e.first_name} ${e.last_name}`}</option>)}
              </select>
            </div>
          </div>
          <div><label style={lbl}>Due Date</label><input type="date" style={inp} value={form.due_date} onChange={e => f('due_date', e.target.value)} /></div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button type="button" onClick={onClose} style={{ flex: 1, background: '#f3f4f6', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer' }}>Cancel</button>
          <button type="submit" style={{ flex: 2, background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer', fontWeight: 600 }}>Create CAPA</button>
        </div>
      </form>
    </div>
  );
}

export default function CAPAManagement() {
  const toast = useToast();
  const [capas, setCapas]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [filter, setFilter]   = useState({ status: '', overdue: '' });
  const [editId, setEditId]   = useState(null);
  const [effectiveness, setEff] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (filter.status)  params.status  = filter.status;
      if (filter.overdue) params.overdue = 'true';
      const res = await api.get('/quality/capa', { params });
      setCapas(res.data?.data || res.data || []);
    } catch { toast.error('Failed to load CAPAs'); }
    finally { setLoading(false); }
  }, [filter, toast]);

  useEffect(() => { load(); }, [load]);

  const updateStatus = async (id, status) => {
    try {
      await api.put(`/quality/capa/${id}`, { status, completion_date: status === 'completed' ? new Date().toISOString().slice(0,10) : undefined });
      toast.success('CAPA updated');
      load();
    } catch (e) { toast.error(e?.response?.data?.error || 'Update failed'); }
  };

  const verify = async (id) => {
    try {
      await api.post(`/quality/capa/${id}/verify`, { effectiveness_rating: effectiveness[id] || 3 });
      toast.success('CAPA verified');
      load();
    } catch (e) { toast.error(e?.response?.data?.error || 'Verify failed'); }
  };

  const sel = { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff' };

  // Stat-band figures derived from the rows on screen, so they always agree
  // with the table underneath rather than needing a second round-trip.
  const openCount     = capas.filter(c => c.status === 'open').length;
  const progressCount = capas.filter(c => c.status === 'in-progress').length;
  const doneCount     = capas.filter(c => c.status === 'completed').length;
  const verifiedCount = capas.filter(c => c.status === 'verified').length;
  const overdueCount  = capas.filter(c => c.overdue).length;
  const rated         = capas.filter(c => c.effectiveness_rating);
  const avgEff        = rated.length
    ? (rated.reduce((s, c) => s + Number(c.effectiveness_rating), 0) / rated.length).toFixed(1)
    : '—';

  return (
    <PageShell dock={
        <PageHero
          icon={Repeat}
          eyebrow="Quality"
          title="CAPA Management"
          subtitle="Corrective & preventive actions raised against non-conformances"
          meta={[
            { value: capas.length, label: 'in view' },
            { value: overdueCount, label: 'overdue', tone: overdueCount ? 'bad' : 'good' },
            { value: avgEff, label: 'avg effectiveness', tone: 'good' },
          ]}
          actions={
            <>
              <a
                className="plh-cta plh-cta--ghost"
                href="/api/v1/quality/capa?export=csv"
                target="_blank"
                rel="noreferrer"
              >
                <Download size={14} /> Export CSV
              </a>
              <button className="plh-cta" onClick={() => setShowNew(true)}>
                <Plus size={14} /> New CAPA
              </button>
            </>
          }
        />
    }>

      <StatBand cols={5}>
        <Stat index={0} icon={FolderOpen}  tone="danger"  label="Open"        value={openCount}     sub="not started" />
        <Stat index={1} icon={PlayCircle}  tone="info"    label="In Progress" value={progressCount} sub="being actioned" />
        <Stat index={2} icon={CheckCircle2} tone="success" label="Completed"  value={doneCount}     sub="awaiting verification" />
        <Stat index={3} icon={BadgeCheck}  tone="primary" label="Verified"    value={verifiedCount} sub="closed out" />
        <Stat index={4} icon={AlarmClock}  tone={overdueCount ? 'danger' : 'success'} label="Overdue" value={overdueCount} sub="past due date" />
      </StatBand>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <select style={sel} value={filter.status} onChange={e => setFilter(p => ({ ...p, status: e.target.value }))}>
          <option value="">All Statuses</option>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={filter.overdue === 'true'} onChange={e => setFilter(p => ({ ...p, overdue: e.target.checked ? 'true' : '' }))} />
          Overdue only
        </label>
      </div>

      {loading ? <div style={{ color: '#6b7280', padding: 20 }}>Loading…</div> : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['NCR','Type','Description','Assigned To','Verifier','Due','Status','Effectiveness','Actions'].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: '#6b7280' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {capas.length === 0
                ? <tr><td colSpan={9} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>No CAPAs found</td></tr>
                : capas.map(c => (
                  <tr key={c.id} style={{ borderTop: '1px solid #f3f4f6', background: c.overdue ? '#fff5f5' : 'transparent' }}>
                    <td style={{ padding: '10px 14px', fontWeight: 600, color: '#6B3FDB' }}>{c.ncr_number || `#${c.ncr_id}`}</td>
                    <td style={{ padding: '10px 14px', textTransform: 'capitalize' }}>{c.action_type}</td>
                    <td style={{ padding: '10px 14px', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.description}</td>
                    <td style={{ padding: '10px 14px' }}>{c.employee_name || c.assigned_to || '—'}</td>
                    <td style={{ padding: '10px 14px', color: '#6b7280' }}>{c.verifier_name || '—'}</td>
                    <td style={{ padding: '10px 14px', color: c.overdue ? '#dc2626' : '#374151' }}>{c.due_date ? new Date(c.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                    <td style={{ padding: '10px 14px' }}><Badge label={c.status} /></td>
                    <td style={{ padding: '10px 14px' }}>
                      {c.status === 'completed' && !c.verified_at
                        ? <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            {[1,2,3,4,5].map(n => (
                              <span key={n} style={{ cursor: 'pointer', color: (effectiveness[c.id] || 0) >= n ? '#8b5cf6' : '#d1d5db', fontSize: 16 }} onClick={() => setEff(p => ({ ...p, [c.id]: n }))}>★</span>
                            ))}
                            <button onClick={() => verify(c.id)} style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, padding: '3px 8px', cursor: 'pointer', fontSize: 11 }}>Verify</button>
                          </div>
                        : c.effectiveness_rating
                          ? <span style={{ color: '#8b5cf6' }}>{stars(c.effectiveness_rating)}</span>
                          : '—'
                      }
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      {c.status === 'open' && <button onClick={() => updateStatus(c.id, 'in-progress')} style={{ background: '#dbeafe', color: '#2563eb', border: 'none', borderRadius: 6, padding: '3px 8px', cursor: 'pointer', fontSize: 11, marginRight: 4 }}>Start</button>}
                      {c.status === 'in-progress' && <button onClick={() => updateStatus(c.id, 'completed')} style={{ background: '#d1fae5', color: '#16a34a', border: 'none', borderRadius: 6, padding: '3px 8px', cursor: 'pointer', fontSize: 11 }}>Complete</button>}
                    </td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>
      )}

      {showNew && <CAPAForm onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load(); }} />}
    </PageShell>
  );
}
