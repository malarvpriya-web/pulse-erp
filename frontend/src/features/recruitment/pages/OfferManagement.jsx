import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '@/services/api/client';
import { candidateRows } from '../shared/constants';
import { useToast } from '@/context/ToastContext';
import { Plus, FileText, X, Search, CheckCircle, XCircle, Send, UserPlus, Pencil, Download, CalendarPlus, AlertTriangle, RefreshCw } from 'lucide-react';
import { matchesSearch } from '../shared/search';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { fmtDate, localDay } from '@/utils/dateFormatter';
import Dialog from '../shared/components/Dialog';
import EmailSetupWarning from '../shared/components/EmailSetupWarning';

/**
 * Offer Management (Recruitment → Offer & Onboarding → Offer Management).
 *
 * Life of an offer: draft → submitted for approval → approved = sent to the
 * candidate (Approval Center; the letter PDF goes with the e-mail) → the
 * candidate's answer is recorded here: accepted (hires them and creates the
 * employee) or declined (with the reason). Withdrawing needs a reason too.
 * A sent offer past its valid-until date shows as expired; it can be extended,
 * or accepted late on purpose.
 *
 * Review 2026-11-17: stat cards and status buttons were two copies of one
 * filter; Approve/Reject showed to everyone (and Reject sent no comment, which
 * the Approval Center requires); declines had no reason; a second offer could
 * be drafted for a candidate who already had one; the page drew its own hero
 * inside the Offer & Onboarding hub.
 */

const inr = n => `₹${Math.round(Number(n || 0)).toLocaleString('en-IN')}`;
const fmtCtc = n => (Number(n) >= 100000 ? `₹${(Number(n) / 100000).toFixed(2).replace(/\.?0+$/, '')}L` : inr(n));

// "Awaiting answer" = the My Recruitment Work "offers pending" tile: made, not
// yet accepted, declined or withdrawn. Keep in step with UNANSWERED_OFFER_STATUSES.
const UNANSWERED = ['draft', 'pending_approval', 'sent'];
const STATUSES = ['draft', 'pending_approval', 'sent', 'accepted', 'declined', 'withdrawn'];
const STATUS_TABS = ['All', 'unanswered', ...STATUSES];
const STATUS_LABEL = {
  All: 'All', unanswered: 'Awaiting answer', draft: 'Draft', pending_approval: 'Pending approval',
  sent: 'Sent', accepted: 'Accepted', declined: 'Declined', withdrawn: 'Withdrawn',
};
const STATUS_COLOR = {
  draft:            { bg: '#f3f4f6', color: '#374151' },
  pending_approval: { bg: '#fef3c7', color: '#92400e' },
  sent:             { bg: '#ede9fe', color: '#5b21b6' },
  accepted:         { bg: '#d1fae5', color: '#065f46' },
  declined:         { bg: '#fee2e2', color: '#991b1b' },
  withdrawn:        { bg: '#e5e7eb', color: '#6b7280' },
};

const day = (v) => (v ? String(v).slice(0, 10) : '');
const errMsg = (err, fallback) => err?.response?.data?.error || err?.response?.data?.message || fallback;

/** Opens or downloads the offer letter PDF (authenticated, so fetched as a blob). */
async function openOfferLetter(o, download = false) {
  const res = await api.get(`/recruitment/offers/${o.id}/letter.pdf`, { responseType: 'blob', params: download ? { download: 1 } : {} });
  const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
  if (download) {
    const a = document.createElement('a');
    a.href = url; a.download = `${o.offer_no || 'offer-letter'}.pdf`; a.click();
  } else {
    window.open(url, '_blank', 'noopener');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const inp = { width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box', background: '#fff' };
const lbl = { display: 'block', marginBottom: 5, fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '.04em' };
const hint = { fontSize: 11, color: '#6b7280', marginTop: 4 };
const actBtn = (bg, color) => ({ padding: '4px 8px', background: bg, color, border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' });

function DialogHead({ title, sub, onClose }) {
  return (
    <div style={{ padding: '18px 22px', borderBottom: '1px solid #f0f0f8', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
      <div>
        <div style={{ fontSize: 16, fontWeight: 800, color: '#111827' }}>{title}</div>
        {sub && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{sub}</div>}
      </div>
      <button type="button" aria-label="Close" onClick={onClose} style={{ background: '#f3f4f6', border: 'none', borderRadius: 8, padding: 8, cursor: 'pointer', display: 'flex' }}><X size={15} color="#6b7280" /></button>
    </div>
  );
}

function DialogFoot({ onClose, onSave, saving, label, danger }) {
  return (
    <div style={{ padding: '14px 22px', borderTop: '1px solid #f0f0f8', display: 'flex', justifyContent: 'flex-end', gap: 10, background: '#fafafa' }}>
      <button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button>
      <button type="button" className="pulse-btn-primary" onClick={onSave} disabled={saving}
        style={danger ? { background: 'var(--color-danger, #dc2626)', borderColor: 'var(--color-danger, #dc2626)' } : undefined}>
        {saving ? 'Saving…' : label}
      </button>
    </div>
  );
}

// Draft a new offer, or edit a draft (`offer` given). Terms change only on a
// draft — the API refuses otherwise.
function OfferFormDialog({ candidates, openings, jobRequired = false, offer = null, initialCandidateId = '', onClose, onSaved, showToast }) {
  const [form, setForm] = useState(() => offer ? {
    candidate_id: String(offer.candidate_id), job_opening_id: offer.job_opening_id ? String(offer.job_opening_id) : '',
    designation: offer.designation || '', offered_salary: offer.offered_salary != null ? String(Number(offer.offered_salary)) : '',
    joining_date: day(offer.joining_date), offer_expiry_date: day(offer.offer_expiry_date), notes: offer.notes || '',
  } : { candidate_id: initialCandidateId ? String(initialCandidateId) : '', job_opening_id: '', designation: '', offered_salary: '', joining_date: '', offer_expiry_date: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const job = openings.find(o => String(o.id) === String(form.job_opening_id));
  // Approved budget: the requisition's range (what was approved), else the job's.
  const budgetMax = job ? Number(job.req_salary_max ?? job.salary_max ?? 0) || null : (offer?.budget_max ? Number(offer.budget_max) : null);
  const budgetMin = job ? Number(job.req_salary_min ?? job.salary_min ?? 0) || null : (offer?.budget_min ? Number(offer.budget_min) : null);
  const salary = Number(form.offered_salary);
  const overBudget = budgetMax && salary > budgetMax;

  // Picking a candidate fills their job; picking a job fills the designation.
  useEffect(() => {
    if (offer || !form.candidate_id) return;
    const c = candidates.find(x => String(x.id) === String(form.candidate_id));
    if (c?.applied_job_id && !form.job_opening_id && openings.some(o => String(o.id) === String(c.applied_job_id))) set('job_opening_id', String(c.applied_job_id));
  }, [form.candidate_id, candidates, openings]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (form.designation || !job) return;
    set('designation', job.job_title || '');
  }, [form.job_opening_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    if (!form.candidate_id) return showToast('Select a candidate', 'error');
    if (jobRequired && !form.job_opening_id) return showToast('Choose the job', 'error');
    if (!form.job_opening_id && !form.designation.trim()) return showToast('Choose the job, or type the designation for the letter', 'error');
    if (!(salary > 0)) return showToast('Enter the annual CTC', 'error');
    if (form.joining_date && form.offer_expiry_date && form.offer_expiry_date > form.joining_date)
      return showToast('The offer should expire before the joining date', 'error');
    if (!offer && form.offer_expiry_date && form.offer_expiry_date < localDay())
      return showToast('"Valid until" cannot be in the past', 'error');
    setSaving(true);
    try {
      if (offer) {
        const { candidate_id: _c, ...terms } = form;
        await api.put(`/recruitment/offers/${offer.id}`, terms);
        showToast('Offer updated');
      } else {
        await api.post('/recruitment/offers', form);
        showToast('Offer drafted');
      }
      onSaved();
    } catch (err) {
      showToast(errMsg(err, 'Could not save the offer'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const jobOptions = offer?.job_opening_id && !openings.some(o => String(o.id) === String(offer.job_opening_id))
    ? [{ id: offer.job_opening_id, job_title: offer.job_title || 'Current job', department: offer.department }, ...openings] : openings;

  return (
    <Dialog width={540}>
      <DialogHead title={offer ? `Edit draft offer ${offer.offer_no || ''}` : 'Draft an offer'}
        sub="Terms can be changed until the offer is submitted for approval." onClose={onClose} />
      <div style={{ flex: 1, overflowY: 'auto', padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={lbl} htmlFor="of-cand">Candidate *</label>
          <select id="of-cand" style={inp} value={form.candidate_id} onChange={e => set('candidate_id', e.target.value)} disabled={!!offer}>
            <option value="">Select candidate…</option>
            {offer && <option value={form.candidate_id}>{offer.candidate_name}</option>}
            {!offer && candidates.map(c => <option key={c.id} value={c.id}>{c.full_name}{c.email ? ` (${c.email})` : ''}</option>)}
          </select>
          {!offer && <div style={hint}>Active candidates without an open offer.</div>}
        </div>
        <div>
          <label style={lbl} htmlFor="of-job">Job{jobRequired ? ' *' : ''}</label>
          <select id="of-job" style={inp} value={form.job_opening_id} onChange={e => set('job_opening_id', e.target.value)}>
            <option value="">{jobRequired ? 'Select job…' : 'No job (type the designation below)'}</option>
            {jobOptions.map(o => <option key={o.id} value={o.id}>{o.job_title}{o.department ? ` — ${o.department}` : ''}</option>)}
          </select>
        </div>
        <div>
          <label style={lbl} htmlFor="of-desig">Designation on the letter{form.job_opening_id ? '' : ' *'}</label>
          <input id="of-desig" style={inp} value={form.designation} onChange={e => set('designation', e.target.value)} placeholder="Defaults to the job title" />
        </div>
        <div>
          <label style={lbl} htmlFor="of-ctc">Annual CTC (₹) *</label>
          <input id="of-ctc" style={{ ...inp, borderColor: overBudget ? '#f59e0b' : '#e5e7eb' }} type="number" min="0" step="1000" placeholder="e.g. 600000"
            value={form.offered_salary} onChange={e => set('offered_salary', e.target.value)} />
          {(budgetMin || budgetMax) && (
            <div style={{ ...hint, color: overBudget ? '#b45309' : '#6b7280' }}>
              Approved budget: {budgetMin ? inr(budgetMin) : '—'} to {budgetMax ? inr(budgetMax) : '—'} a year.
              {overBudget && ' This offer is above it — the approver will see that.'}
            </div>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
          <div>
            <label style={lbl} htmlFor="of-join">Joining date</label>
            <input id="of-join" style={inp} type="date" value={form.joining_date} onChange={e => set('joining_date', e.target.value)} />
            <div style={hint}>Needed before the offer can be submitted.</div>
          </div>
          <div>
            <label style={lbl} htmlFor="of-exp">Valid until</label>
            <input id="of-exp" style={inp} type="date" value={form.offer_expiry_date} min={localDay()} onChange={e => set('offer_expiry_date', e.target.value)} />
            <div style={hint}>Blank = the default from Reports &amp; Setup → Settings, counted from the day it is sent.</div>
          </div>
        </div>
        <div>
          <label style={lbl} htmlFor="of-notes">Notes for the approver</label>
          <textarea id="of-notes" style={{ ...inp, minHeight: 70, resize: 'vertical' }} value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Why this CTC, anything special agreed…" />
        </div>
      </div>
      <DialogFoot onClose={onClose} onSave={handleSave} saving={saving} label={offer ? 'Save changes' : 'Save draft'} />
    </Dialog>
  );
}

// Decline / withdraw / send back — each needs a reason the API stores.
const REASON_COPY = {
  declined:  { title: 'Candidate declined', label: 'Why did they decline?', button: 'Record decline', danger: true,
               chips: ['Accepted another offer', 'CTC too low', 'Location / relocation', 'Counter-offer from current employer', 'Personal reasons'] },
  withdrawn: { title: 'Withdraw offer', label: 'Why is it being withdrawn?', button: 'Withdraw offer', danger: true,
               chips: ['Position put on hold', 'Background check failed', 'Candidate did not respond', 'Terms changed — new offer to follow'] },
  sendback:  { title: 'Send back to draft', label: 'What should be changed?', button: 'Send back', danger: false, chips: [] },
};

function ReasonDialog({ kind, offer, onClose, onDone, showToast }) {
  const copy = REASON_COPY[kind];
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!text.trim()) return showToast('Give a reason', 'error');
    setSaving(true);
    try {
      if (kind === 'sendback') {
        await api.post(`/approvals/offer:${offer.id}/reject`, { comment: text.trim() });
        showToast('Offer sent back to draft');
      } else {
        await api.put(`/recruitment/offers/${offer.id}`, { offer_status: kind, close_reason: text.trim() });
        showToast(kind === 'declined' ? 'Decline recorded' : 'Offer withdrawn');
      }
      onDone();
    } catch (err) {
      showToast(errMsg(err, 'Could not save'), 'error');
    } finally { setSaving(false); }
  };
  return (
    <Dialog width={460}>
      <DialogHead title={copy.title} sub={`${offer.candidate_name} · ${offer.offer_no || ''}`} onClose={onClose} />
      <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label style={lbl} htmlFor="reason-text">{copy.label} *</label>
        {copy.chips.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {copy.chips.map(c => (
              <button key={c} type="button" onClick={() => setText(c)} style={{ ...actBtn(text === c ? '#6B3FDB' : '#f3f4f6', text === c ? '#fff' : '#374151'), padding: '5px 10px', borderRadius: 14 }}>{c}</button>
            ))}
          </div>
        )}
        <textarea id="reason-text" style={{ ...inp, minHeight: 80, resize: 'vertical' }} value={text} onChange={e => setText(e.target.value)} />
      </div>
      <DialogFoot onClose={onClose} onSave={save} saving={saving} label={copy.button} danger={copy.danger} />
    </Dialog>
  );
}

function ExtendDialog({ offer, onClose, onDone, showToast }) {
  const [date, setDate] = useState('');
  const [saving, setSaving] = useState(false);
  const min = [localDay(), day(offer.offer_expiry_date)].filter(Boolean).sort().pop();
  const save = async () => {
    if (!date) return showToast('Pick the new date', 'error');
    setSaving(true);
    try {
      await api.put(`/recruitment/offers/${offer.id}`, { offer_expiry_date: date });
      showToast('Validity extended');
      onDone();
    } catch (err) {
      showToast(errMsg(err, 'Could not extend'), 'error');
    } finally { setSaving(false); }
  };
  return (
    <Dialog width={400}>
      <DialogHead title="Extend validity" sub={`Now valid until ${offer.offer_expiry_date ? fmtDate(offer.offer_expiry_date) : '—'}`} onClose={onClose} />
      <div style={{ padding: 22 }}>
        <label style={lbl} htmlFor="ext-date">New valid-until date *</label>
        <input id="ext-date" type="date" style={inp} min={min} value={date} onChange={e => setDate(e.target.value)} />
        <div style={hint}>Only the date changes; the terms stay as approved.</div>
      </div>
      <DialogFoot onClose={onClose} onSave={save} saving={saving} label="Extend" />
    </Dialog>
  );
}

export default function OfferManagement({ embedded = false, setPage }) {
  const toast = useToast();
  const showToast = useCallback((msg, type = 'success') => toast({ message: msg, type }), [toast]);

  const [offers, setOffers] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [openings, setOpenings] = useState([]);
  const [canApprove, setCanApprove] = useState(() => new Set());
  const [setup, setSetup] = useState({ email_configured: true, ctc_mode: false, dept_scope: null });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [sp, setSp] = useSearchParams();
  // ?status=<tab> — the work queue's "offers pending" tile opens ?status=unanswered.
  const [status, setStatus] = useState(() => (STATUS_TABS.includes(sp.get('status')) ? sp.get('status') : 'All'));
  // ?dept=<department> — the Dashboard's department filter carried over.
  const [dept, setDept] = useState(() => sp.get('dept') || '');
  const [form, setForm] = useState(null); // { offer?, candidateId? }
  const [reason, setReason] = useState(null); // { kind, offer }
  const [extend, setExtend] = useState(null);
  const [busy, setBusy] = useState(null);

  // Arriving from Candidate Detail → "Offer" with ?candidate=<id>.
  useEffect(() => {
    const c = sp.get('candidate');
    if (!c) return;
    setForm({ candidateId: c });
    setSp(prev => { const n = new URLSearchParams(prev); n.delete('candidate'); return n; }, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(() => {
    setLoading(true);
    Promise.allSettled([
      api.get('/recruitment/offers'),
      api.get('/recruitment/candidates', { params: { overall_status: 'active', limit: 500 } }),
      api.get('/recruitment/openings'),
      api.get('/approvals/pending'),
      api.get('/recruitment/setup-status'),
    ]).then(([offersRes, candsRes, openingsRes, apprRes, setupRes]) => {
      if (setupRes.status === 'fulfilled' && setupRes.value.data) setSetup(setupRes.value.data);
      if (offersRes.status === 'fulfilled' && Array.isArray(offersRes.value.data)) {
        setOffers(offersRes.value.data); setLoadError('');
      } else {
        setOffers([]); setLoadError(errMsg(offersRes.reason, 'Could not load offers'));
      }
      setCandidates(candsRes.status === 'fulfilled' ? candidateRows(candsRes.value.data) : []);
      // A department head offers only for their own department's jobs.
      const scope = setupRes.status === 'fulfilled' ? setupRes.value.data?.dept_scope : null;
      setOpenings(openingsRes.status === 'fulfilled' && Array.isArray(openingsRes.value.data)
        ? openingsRes.value.data.filter(o => ['open', 'on_hold'].includes(o.status) && (!Array.isArray(scope) || scope.includes(o.department))) : []);
      const items = apprRes.status === 'fulfilled' ? (Array.isArray(apprRes.value.data) ? apprRes.value.data : apprRes.value.data?.items || []) : [];
      setCanApprove(new Set(items.filter(i => i.type === 'offer' && i.can_act).map(i => String(i.id).replace(/^offer:/, ''))));
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // One live offer per candidate (the API refuses a second) — so offer the rest.
  const offerable = useMemo(() => {
    const live = new Set(offers.filter(o => UNANSWERED.includes(o.offer_status)).map(o => String(o.candidate_id)));
    return candidates.filter(c => !live.has(String(c.id)));
  }, [offers, candidates]);

  const departments = [...new Set([...offers.map(o => o.department).filter(Boolean), ...(dept ? [dept] : [])])].sort();
  const inDept = dept ? offers.filter(o => o.department === dept) : offers;
  const pickDept = (v) => {
    setDept(v);
    setSp(prev => { const n = new URLSearchParams(prev); if (v) n.set('dept', v); else n.delete('dept'); return n; }, { replace: true });
  };
  const pickStatus = (s) => {
    setStatus(s);
    setSp(prev => { const n = new URLSearchParams(prev); if (s !== 'All') n.set('status', s); else n.delete('status'); return n; }, { replace: true });
  };
  const countOf = (s) => (s === 'All' ? inDept.length
    : s === 'unanswered' ? inDept.filter(o => UNANSWERED.includes(o.offer_status)).length
    : inDept.filter(o => o.offer_status === s).length);

  const filtered = inDept.filter(o => {
    const matchStatus = status === 'All' || (status === 'unanswered' ? UNANSWERED.includes(o.offer_status) : o.offer_status === status);
    return matchStatus && matchesSearch(o, ['candidate_name', 'job_title', 'designation', 'candidate_email', 'offer_no'], search);
  });

  const run = async (key, fn, ok) => {
    setBusy(key);
    try { await fn(); if (ok) showToast(ok); load(); }
    catch (err) { showToast(errMsg(err, 'Something went wrong'), 'error'); }
    finally { setBusy(null); }
  };

  const submitForApproval = (o) => run(`s${o.id}`, () => api.put(`/recruitment/offers/${o.id}`, { offer_status: 'pending_approval' }), 'Submitted for approval');
  const approveOffer = (o) => run(`a${o.id}`, () => api.post(`/approvals/offer:${o.id}/approve`), 'Offer approved and sent to the candidate');
  const acceptOffer = async (o) => {
    const late = o.is_expired;
    const msg = late
      ? `This offer expired on ${fmtDate(o.offer_expiry_date)}. Accept it anyway? This hires ${o.candidate_name} and creates the employee record.`
      : `Record that ${o.candidate_name} accepted? This hires them and creates the employee record.`;
    if (!window.confirm(msg)) return;
    run(`c${o.id}`, () => api.post(`/recruitment/offers/${o.id}/accept`, late ? { accept_late: true } : {}), 'Accepted — candidate hired');
  };
  // Accepted offer → DRAFT salary proposal for the new employee (approved in
  // Payroll → Salary Structure).
  const prepareSalary = (o) => run(`p${o.id}`, () => api.post(`/recruitment/offers/${o.id}/salary-proposal`, {}),
    'Salary proposal prepared — approve it in Payroll → Salary Structure');

  const newButton = (
    <button type="button" className={embedded ? 'pulse-btn-primary' : 'plh-cta'} onClick={() => setForm({})}>
      <Plus size={14} /> New offer
    </button>
  );

  const body = (
    <>
      <EmailSetupWarning show={!setup.email_configured} />
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 180 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search candidate, position, offer no…" aria-label="Search offers"
            style={{ ...inp, paddingLeft: 32 }} />
        </div>
        <select aria-label="Department" value={dept} onChange={e => pickDept(e.target.value)} style={{ ...inp, width: 'auto', borderColor: dept ? '#6B3FDB' : '#e5e7eb' }}>
          <option value="">All departments</option>
          {departments.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <button type="button" className="pulse-btn-secondary" onClick={load} title="Refresh"><RefreshCw size={14} /></button>
        {embedded && newButton}
      </div>

      <div role="tablist" aria-label="Offer status" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
        {STATUS_TABS.map(s => {
          const on = status === s;
          return (
            <button key={s} type="button" role="tab" aria-selected={on} onClick={() => pickStatus(s)}
              style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                borderColor: on ? '#6B3FDB' : '#e5e7eb', background: on ? '#6B3FDB' : '#fff', color: on ? '#fff' : '#374151' }}>
              {STATUS_LABEL[s]} <span style={{ opacity: 0.75, marginLeft: 2 }}>{countOf(s)}</span>
            </button>
          );
        })}
      </div>

      {/* Owner decisions 2026-11-18 — the three fixed offer rules, said where they apply. */}
      <p data-testid="offer-rules" style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px', lineHeight: 1.5 }}>
        Once an offer is sent, only its valid-until date can change; to change the terms, withdraw it and make a new offer.
        An expired offer can still be accepted, after a confirmation. An accepted offer cannot be withdrawn; if the person
        does not join, that is handled in Exit Management.
      </p>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'auto' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
        ) : loadError ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#b91c1c' }}>{loadError}</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
            <FileText size={32} color="#d1d5db" style={{ display: 'block', margin: '0 auto 8px' }} />
            <p style={{ margin: 0 }}>{offers.length ? 'No offers match these filters.' : 'No offers yet. An offer is drafted automatically when a candidate reaches the Offer stage, or use New offer.'}</p>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Candidate', 'Position', 'Annual CTC', 'Valid until', 'Joining', 'Status', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(o => {
                const sc = STATUS_COLOR[o.offer_status] || STATUS_COLOR.draft;
                const over = o.budget_max && Number(o.offered_salary) > Number(o.budget_max);
                const sentBack = o.offer_status === 'draft' && o.last_decision_status === 'Rejected' && o.last_decision_comment;
                const approver = canApprove.has(String(o.id));
                return (
                  <tr key={o.id} style={{ borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' }}>
                    <td style={{ padding: '10px 14px', fontWeight: 600, color: '#1f2937' }}>
                      {o.candidate_name || '—'}
                      <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>{o.offer_no || ''}{o.department ? ` · ${o.department}` : ''}</div>
                    </td>
                    <td style={{ padding: '10px 14px', color: '#374151' }}>{o.designation || o.job_title || '—'}</td>
                    <td style={{ padding: '10px 14px', fontWeight: 600, color: '#1f2937', whiteSpace: 'nowrap' }} title={inr(o.offered_salary)}>
                      {fmtCtc(o.offered_salary)}
                      {over && <div style={{ fontSize: 11, color: '#b45309', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 3 }}><AlertTriangle size={11} /> Above budget ({fmtCtc(o.budget_max)})</div>}
                    </td>
                    <td style={{ padding: '10px 14px', color: o.is_expired ? '#b91c1c' : '#374151', whiteSpace: 'nowrap' }}>
                      {o.offer_expiry_date ? fmtDate(o.offer_expiry_date) : (UNANSWERED.includes(o.offer_status) && o.offer_status !== 'sent' ? <span style={{ color: '#9ca3af' }}>Set on sending</span> : '—')}
                      {o.is_expired && <div style={{ fontSize: 11, fontWeight: 700 }}>Expired</div>}
                    </td>
                    <td style={{ padding: '10px 14px', color: '#374151', whiteSpace: 'nowrap' }}>{o.joining_date ? fmtDate(o.joining_date) : '—'}</td>
                    <td style={{ padding: '10px 14px', maxWidth: 220 }}>
                      <span style={{ background: sc.bg, color: sc.color, padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>{STATUS_LABEL[o.offer_status] || o.offer_status}</span>
                      {o.offer_sent_date && o.offer_status === 'sent' && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>Sent {fmtDate(o.offer_sent_date)}</div>}
                      {sentBack && <div style={{ fontSize: 11, color: '#92400e', marginTop: 4 }}>Sent back: {o.last_decision_comment}</div>}
                      {o.close_reason && ['declined', 'withdrawn'].includes(o.offer_status) && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>{o.close_reason}</div>}
                      {o.offer_status === 'accepted' && o.employee_code && <div style={{ fontSize: 11, color: '#065f46', marginTop: 4 }}>Employee {o.employee_code}</div>}
                      {o.offer_status === 'accepted' && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>Final. A no-show goes to Exit Management.</div>}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {o.offer_status === 'draft' && (<>
                          <button type="button" onClick={() => setForm({ offer: o })} style={actBtn('#f3f4f6', '#374151')}><Pencil size={11} /> Edit</button>
                          <button type="button" disabled={busy === `s${o.id}`} onClick={() => submitForApproval(o)} title="The approver sends it to the candidate"
                            style={actBtn('#ede9fe', '#5b21b6')}><Send size={11} /> Submit for approval</button>
                        </>)}
                        <button type="button" onClick={() => openOfferLetter(o).catch(() => showToast('Could not open the letter', 'error'))} title="Offer letter PDF"
                          style={actBtn('#f3f4f6', '#374151')}><Download size={11} /> Letter</button>
                        {o.offer_status === 'pending_approval' && approver && (<>
                          <button type="button" disabled={busy === `a${o.id}`} onClick={() => approveOffer(o)} style={actBtn('#d1fae5', '#065f46')}><CheckCircle size={11} /> Approve &amp; send</button>
                          <button type="button" onClick={() => setReason({ kind: 'sendback', offer: o })} style={actBtn('#fef3c7', '#92400e')}><XCircle size={11} /> Send back</button>
                        </>)}
                        {o.offer_status === 'pending_approval' && !approver && <span style={{ fontSize: 11, color: '#6b7280', alignSelf: 'center' }}>With the approver</span>}
                        {o.offer_status === 'sent' && (<>
                          <button type="button" disabled={busy === `c${o.id}`} onClick={() => acceptOffer(o)} style={actBtn('#d1fae5', '#065f46')}><CheckCircle size={11} /> Accepted</button>
                          <button type="button" onClick={() => setReason({ kind: 'declined', offer: o })} style={actBtn('#fee2e2', '#991b1b')}><XCircle size={11} /> Declined</button>
                          <button type="button" onClick={() => setExtend(o)} title="Only the valid-until date can change after sending. To change the terms, withdraw and make a new offer."
                            style={actBtn('#f3f4f6', '#374151')}><CalendarPlus size={11} /> Extend</button>
                        </>)}
                        {o.offer_status === 'accepted' && (o.salary_proposal_status
                          ? <span style={{ fontSize: 11, color: '#5b21b6', alignSelf: 'center' }}>Salary proposal: {o.salary_proposal_status}</span>
                          : !setup.ctc_mode
                          ? <span style={{ fontSize: 11, color: '#6b7280', alignSelf: 'center' }} title="CTC-driven salary entry is off in Payroll Settings">Set the salary in Payroll → Salary Structure</span>
                          : <button type="button" disabled={busy === `p${o.id}`} onClick={() => prepareSalary(o)} title="Turn this offer's annual CTC into a salary proposal for approval"
                              style={actBtn('#ede9fe', '#5b21b6')}>Prepare salary proposal</button>)}
                        {o.offer_status === 'accepted' && o.employee_id && setPage && (
                          <button type="button" onClick={() => setPage('EmployeeProfile', { id: o.employee_id })} style={actBtn('#f3f4f6', '#374151')}><UserPlus size={11} /> Employee</button>
                        )}
                        {UNANSWERED.includes(o.offer_status) && (
                          <button type="button" onClick={() => setReason({ kind: 'withdrawn', offer: o })} style={actBtn('#f3f4f6', '#6b7280')}>Withdraw</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {form && (
        <OfferFormDialog
          key={form.offer?.id || 'new'}
          candidates={offerable}
          openings={openings}
          jobRequired={Array.isArray(setup.dept_scope)}
          offer={form.offer || null}
          initialCandidateId={form.candidateId || ''}
          onClose={() => setForm(null)}
          onSaved={() => { setForm(null); load(); }}
          showToast={showToast}
        />
      )}
      {reason && <ReasonDialog kind={reason.kind} offer={reason.offer} onClose={() => setReason(null)} onDone={() => { setReason(null); load(); }} showToast={showToast} />}
      {extend && <ExtendDialog offer={extend} onClose={() => setExtend(null)} onDone={() => { setExtend(null); load(); }} showToast={showToast} />}
    </>
  );

  if (embedded) return body;
  return (
    <PageShell dock={<PageHero icon={FileText} eyebrow="Recruitment" title="Offer Management" actions={newButton} />}>
      {body}
    </PageShell>
  );
}
