import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { UserPlus, CheckCircle, RefreshCw, X, Users, Circle, ChevronDown, ChevronRight } from 'lucide-react';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { fmtDate } from '@/utils/dateFormatter';
import { PageHero, PageShell } from '@/components/pulse-ui';
import Dialog from '../shared/components/Dialog';

/**
 * Employee Creation (Recruitment → Offer & Onboarding).
 *
 * The employee record is created AUTOMATICALLY when an offer is accepted (or a
 * candidate is moved to Hired). This tab is the safety net: hires whose record
 * was not created (it failed, or they were hired another way) wait under
 * "Waiting", with a button to create it; "History" shows every creation and
 * what was / was not set up, from the log the server keeps.
 *
 * Review 2026-11-17: the page used to advertise nine things "auto-created"
 * (official e-mail, attendance, leave, document folder, org chart…) that the
 * server does not do — its own log marks them not done — and a pipeline of
 * stages ("L1 Interview", "Management") that do not exist. Both removed; the
 * real checklist from the log is shown instead.
 */

const CARD = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 0, marginBottom: 16, overflow: 'auto' };
const TH = { padding: '10px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', whiteSpace: 'nowrap' };
const TD = { padding: '10px 12px', color: '#374151', verticalAlign: 'top' };
const STATUS_PILL = {
  completed:   { bg: '#d1fae5', color: '#065f46', label: 'Created' },
  failed:      { bg: '#fee2e2', color: '#991b1b', label: 'Failed' },
  in_progress: { bg: '#dbeafe', color: '#1e40af', label: 'Creating…' },
  pending:     { bg: '#ede9fe', color: '#5b21b6', label: 'Waiting' },
};
const Pill = ({ status }) => {
  const p = STATUS_PILL[status] || STATUS_PILL.pending;
  return <span style={{ background: p.bg, color: p.color, padding: '2px 8px', borderRadius: 9999, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>{p.label}</span>;
};

const checklistOf = (row) => {
  const v = row?.checklist_items ?? row?.checklist;
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const j = JSON.parse(v); return Array.isArray(j) ? j : []; } catch { return []; } }
  return [];
};

function Checklist({ items }) {
  if (!items.length) return <div style={{ fontSize: 12, color: '#9ca3af' }}>No checklist recorded.</div>;
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
      {items.map((it, i) => (
        <li key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: it.done ? '#065f46' : '#374151' }}>
          {it.done ? <CheckCircle size={14} color="#059669" style={{ flexShrink: 0, marginTop: 1 }} /> : <Circle size={14} color="#9ca3af" style={{ flexShrink: 0, marginTop: 1 }} />}
          <span>{it.task}{it.note ? <span style={{ color: '#6b7280' }}> — {it.note}</span> : null}{!it.done ? <span style={{ color: '#b45309' }}> (to do)</span> : null}</span>
        </li>
      ))}
    </ul>
  );
}

export default function EmployeeAutoCreation({ embedded = false, setPage }) {
  const toast = useToast();
  const [pending, setPending] = useState([]);
  const [log, setLog] = useState([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(null);
  const [tab, setTab] = useState('pending');
  const [result, setResult] = useState(null);
  const [confirmFor, setConfirmFor] = useState(null);
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, l] = await Promise.allSettled([
        api.get('/recruitment/auto-creation/pending'),
        api.get('/recruitment/auto-creation/log'),
      ]);
      setPending(p.status === 'fulfilled' && Array.isArray(p.value.data) ? p.value.data : []);
      setLog(l.status === 'fulfilled' && Array.isArray(l.value.data) ? l.value.data : []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const createEmployee = async () => {
    if (!confirmFor) return;
    const { id, full_name } = confirmFor;
    setConfirmFor(null);
    setCreating(id);
    try {
      const { data } = await api.post(`/recruitment/auto-creation/${id}/trigger`);
      setResult({ ...data, candidate_name: data.candidate_name || full_name });
      toast.success(`Employee ${data.employee_code} created for ${data.candidate_name || full_name}`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Employee creation failed');
      load();
    } finally { setCreating(null); }
  };

  const created = log.filter(l => l.status === 'completed').length;
  const failed = pending.filter(p => p.creation_status === 'failed').length;

  const body = (
    <>
      <ConfirmDialog
        open={!!confirmFor}
        title="Create employee record"
        message={confirmFor ? `Create the employee record for ${confirmFor.full_name}? Name, contact details, job, department and joining date come from the candidate and the accepted offer.` : ''}
        confirmLabel="Create"
        variant="info"
        onConfirm={createEmployee}
        onCancel={() => setConfirmFor(null)}
      />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <p style={{ fontSize: 13, color: '#6b7280', margin: 0, maxWidth: 760 }}>
          The employee record is created by itself when an offer is accepted. Anyone hired whose record was not created waits here.
          After creation, HR completes the rest (reporting manager, shift, leave, official e-mail) on the employee record.
        </p>
        {embedded && <button type="button" className="pulse-btn-secondary" onClick={load}><RefreshCw size={14} /> Refresh</button>}
      </div>

      <div role="tablist" style={{ display: 'flex', gap: 4, marginBottom: 12, borderBottom: '2px solid #f0f0f4' }}>
        {[['pending', 'Waiting', pending.length], ['log', 'History', created]].map(([t, l, n]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            style={{ padding: '9px 18px', border: 'none', cursor: 'pointer', background: 'none', fontSize: 13, fontWeight: tab === t ? 700 : 500, color: tab === t ? '#6B3FDB' : '#6b7280', borderBottom: tab === t ? '2px solid #6B3FDB' : '2px solid transparent', marginBottom: -2 }}>
            {l} <span style={{ background: tab === t ? '#6B3FDB' : '#e5e7eb', color: tab === t ? '#fff' : '#374151', borderRadius: 9999, padding: '1px 7px', fontSize: 11, marginLeft: 4 }}>{n}</span>
            {t === 'pending' && failed > 0 && <span style={{ color: '#b91c1c', fontSize: 11, marginLeft: 6 }}>{failed} failed</span>}
          </button>
        ))}
      </div>

      {loading ? <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div> : tab === 'pending' ? (
        <div style={CARD}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ background: '#f9fafb' }}>
              {['Candidate', 'Job', 'Department', 'Joining', 'Annual CTC', 'Status', ''].map(h => <th key={h} style={TH}>{h}</th>)}
            </tr></thead>
            <tbody>
              {pending.map(c => (
                <tr key={c.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                  <td style={{ ...TD, fontWeight: 700, color: '#111' }}>{c.full_name}<div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>{c.email}</div></td>
                  <td style={TD}>{c.designation || c.job_title || '—'}{c.offer_no && <div style={{ fontSize: 11, color: '#9ca3af' }}>{c.offer_no}</div>}</td>
                  <td style={TD}>{c.department || '—'}</td>
                  <td style={TD}>{c.joining_date ? fmtDate(c.joining_date) : '—'}</td>
                  <td style={{ ...TD, whiteSpace: 'nowrap' }}>{c.offered_salary ? `₹${Number(c.offered_salary).toLocaleString('en-IN')}` : <span style={{ color: '#9ca3af' }}>No accepted offer</span>}</td>
                  <td style={TD}>
                    <Pill status={c.creation_status || 'pending'} />
                    {c.creation_status === 'failed' && c.error_log && <div style={{ fontSize: 11, color: '#b91c1c', marginTop: 4, maxWidth: 260 }}>{c.error_log}</div>}
                  </td>
                  <td style={TD}>
                    <button type="button" className="pulse-btn-primary" onClick={() => setConfirmFor(c)} disabled={creating === c.id}
                      style={{ fontSize: 12, padding: '6px 12px', whiteSpace: 'nowrap' }}>
                      <UserPlus size={12} /> {creating === c.id ? 'Creating…' : c.creation_status === 'failed' ? 'Try again' : 'Create employee'}
                    </button>
                  </td>
                </tr>
              ))}
              {!pending.length && (
                <tr><td colSpan={7} style={{ textAlign: 'center', padding: 48, color: '#9ca3af' }}>
                  <CheckCircle size={36} style={{ marginBottom: 10, opacity: 0.35, color: '#059669' }} />
                  <p style={{ margin: 0 }}>Nobody is waiting — every hire has an employee record.</p>
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={CARD}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ background: '#f9fafb' }}>
              {['', 'Candidate', 'Job', 'Employee code', 'Status', 'Started', 'Finished', ''].map((h, i) => <th key={i} style={TH}>{h}</th>)}
            </tr></thead>
            <tbody>
              {log.map(l => {
                const items = checklistOf(l);
                const todo = items.filter(i => !i.done).length;
                const isOpen = open === l.id;
                return [
                  <tr key={l.id} style={{ borderTop: '1px solid #f3f4f6', cursor: items.length ? 'pointer' : 'default' }} onClick={() => items.length && setOpen(isOpen ? null : l.id)}>
                    <td style={{ ...TD, width: 24 }}>{items.length ? (isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}</td>
                    <td style={{ ...TD, fontWeight: 600, color: '#111' }}>{l.candidate_name}</td>
                    <td style={TD}>{l.job_title || '—'}</td>
                    <td style={{ ...TD, fontWeight: 700, color: '#6B3FDB', fontFamily: 'monospace' }}>{l.employee_code || '—'}</td>
                    <td style={TD}><Pill status={l.status} />{l.status === 'completed' && todo > 0 && <div style={{ fontSize: 11, color: '#b45309', marginTop: 4 }}>{todo} item{todo > 1 ? 's' : ''} for HR</div>}</td>
                    <td style={TD}>{l.triggered_at ? fmtDate(l.triggered_at) : '—'}</td>
                    <td style={TD}>{l.completed_at ? fmtDate(l.completed_at) : l.error_log ? <span style={{ color: '#dc2626', fontSize: 11 }}>{l.error_log.slice(0, 80)}</span> : '—'}</td>
                    <td style={TD}>
                      {l.employee_id && setPage && (
                        <button type="button" className="pulse-btn-secondary" style={{ fontSize: 12, padding: '4px 10px' }}
                          onClick={(e) => { e.stopPropagation(); setPage('EmployeeProfile', { id: l.employee_id }); }}>Open employee</button>
                      )}
                    </td>
                  </tr>,
                  isOpen && (
                    <tr key={`${l.id}-c`}><td />
                      <td colSpan={7} style={{ ...TD, paddingTop: 0, paddingBottom: 14 }}><Checklist items={items} /></td>
                    </tr>
                  ),
                ];
              })}
              {!log.length && <tr><td colSpan={8} style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>No employee has been created from a candidate yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {result && (
        <Dialog width={460}>
          <div style={{ padding: 28, textAlign: 'center', position: 'relative' }}>
            <button type="button" aria-label="Close" onClick={() => setResult(null)} style={{ position: 'absolute', right: 14, top: 14, background: '#f3f4f6', border: 'none', borderRadius: 8, padding: 6, cursor: 'pointer', display: 'flex' }}><X size={14} /></button>
            <CheckCircle size={40} color="#059669" style={{ marginBottom: 8 }} />
            <h2 style={{ fontSize: 18, fontWeight: 800, margin: '0 0 4px', color: '#111' }}>Employee created</h2>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 14px' }}><strong>{result.candidate_name}</strong> · {result.employee_code}</p>
            <div style={{ textAlign: 'left', marginBottom: 18 }}><Checklist items={checklistOf(result)} /></div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              {result.employee_id && setPage && <button type="button" className="pulse-btn-primary" onClick={() => setPage('EmployeeProfile', { id: result.employee_id })}>Open employee</button>}
              <button type="button" className="pulse-btn-secondary" onClick={() => setResult(null)}>Done</button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );

  if (embedded) return body;
  return (
    <PageShell dock={
      <PageHero icon={Users} eyebrow="Recruitment" title="Employee Creation"
        subtitle="Hires waiting for their employee record, and every record created from a candidate"
        actions={<button type="button" className="plh-cta" onClick={load}><RefreshCw size={14} /> Refresh</button>} />
    }>
      {body}
    </PageShell>
  );
}
