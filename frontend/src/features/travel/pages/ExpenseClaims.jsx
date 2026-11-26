import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, Search, Receipt, Link as LinkIcon, ChevronRight, AlertCircle, CheckCircle, IndianRupee } from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';
import VocabSelect from '@/components/core/VocabSelect';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { fmtDate, localDay } from '@/utils/dateFormatter';
import { fmt } from './travelUtils';
import { Dialog, Field, Facts, StatusBadge, ReasonDialog, DelegateDialog, LookupSelect, ErrorBox, inputStyle, sectionStyle, grid2, th, td, btn, apiError } from '../components/travelUi';

/**
 * Expense Claims — THE claim record (§202), rebuilt 26 Nov 26.
 *
 *   Draft → Submitted → Manager Approved → Accounts Verified → Mgmt Approved → Paid
 *   (a personal-borne line closes at management approval — it is never paid)
 *   Any rejection → the claimant edits it (back to Draft) and submits again.
 *
 *  - The trip, customer and project are pickers; picking a trip fills its
 *    customer / project, so a paid claim reaches the project's cost.
 *  - The decision buttons appear only on the claims waiting on THIS person
 *    (GET /reimbursement/pending-for-approval) — reporting manager / delegate,
 *    accounts (expense_claims:edit), management (expense_claims:approve).
 *  - Every rejection asks for a reason (Management Reject used to send none
 *    and always failed); Accounts ticks its own checks.
 *  - Drafts can be edited and deleted; over-policy claims ask for a reason.
 *  - Payment is Finance's Payment tab.
 *  Trip Expenses (a second, unapproved claim table) was merged into here.
 */
const STEPS = ['Draft', 'Submitted', 'Manager Approved', 'Accounts Verified', 'Mgmt Approved', 'Paid'];
const REJECTED = ['Manager Rejected', 'Accounts Rejected', 'Mgmt Rejected'];
const TABS = ['All', 'Draft', 'Waiting', 'Approved', 'Paid / Closed', 'Rejected'];
const inTab = (c, t) => t === 'All' || (t === 'Draft' && c.status === 'Draft')
  || (t === 'Waiting' && ['Submitted', 'Manager Approved', 'Accounts Verified'].includes(c.status))
  || (t === 'Approved' && c.status === 'Mgmt Approved') || (t === 'Paid / Closed' && ['Paid', 'Closed'].includes(c.status))
  || (t === 'Rejected' && REJECTED.includes(c.status));
const EMPTY = {
  travel_request_id: '', customer_id: '', project_id: '', site_name: '', po_number: '',
  expense_date: '', expense_type: 'Travel', expense_category: '', vendor_name: '',
  amount: '', gst_amount: '', borne_by: 'company', bill_number: '', google_drive_link: '', remarks: '', over_policy_reason: '',
};
const toForm = (c) => Object.fromEntries(Object.keys(EMPTY).map(k => [k, c?.[k] == null ? EMPTY[k] : (k === 'expense_date' ? String(c[k]).slice(0, 10) : c[k])]));

function Stepper({ status }) {
  const rejected = REJECTED.includes(status);
  const at = rejected ? STEPS.indexOf({ 'Manager Rejected': 'Submitted', 'Accounts Rejected': 'Manager Approved', 'Mgmt Rejected': 'Accounts Verified' }[status]) + 1
    : status === 'Closed' ? STEPS.length - 1 : STEPS.indexOf(status);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', margin: '6px 0 16px' }}>
      {STEPS.map((s, i) => {
        const label = status === 'Closed' && s === 'Paid' ? 'Closed (personal)' : s;
        const color = rejected && i === at ? '#ef4444' : i <= at ? '#10b981' : '#d1d5db';
        return (
          <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
            <span style={{ fontSize: 11, color: i === at ? '#1f2937' : '#6b7280', fontWeight: i === at ? 600 : 400 }}>{rejected && i === at ? status : label}</span>
            {i < STEPS.length - 1 && <ChevronRight size={10} color="#d1d5db" />}
          </div>
        );
      })}
    </div>
  );
}

export default function ExpenseClaims() {
  const toast = useToast();
  const { user } = useAuth();
  const [claims, setClaims] = useState([]);
  const [mine, setMine] = useState(new Set());   // ids waiting on me
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('All');
  const [search, setSearch] = useState('');
  const [form, setForm] = useState(null);
  const [formErr, setFormErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [trips, setTrips] = useState([]);
  const [policy, setPolicy] = useState(null);
  const [detail, setDetail] = useState(null);
  const [reject, setReject] = useState(null);    // { claim, step }
  const [verify, setVerify] = useState(null);    // accounts checklist
  const [delegateFor, setDelegateFor] = useState(null);

  const load = useCallback(() => {
    setLoading(true); setErr('');
    Promise.all([
      api.get('/reimbursement/claims', { params: { limit: 500 } }).then(r => r.data),
      api.get('/reimbursement/pending-for-approval').then(r => r.data).catch(() => []),
    ]).then(([c, p]) => { setClaims(Array.isArray(c) ? c : []); setMine(new Set((Array.isArray(p) ? p : []).map(x => x.id))); })
      .catch(e => { setClaims([]); setErr(apiError(e, 'Could not load claims')); })
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  // Policy preview — the same rule the server applies on save.
  useEffect(() => {
    if (!form || !form.amount || !form.expense_type) { setPolicy(null); return undefined; }
    const t = setTimeout(() => {
      api.post('/travel-policy/check', { expense_type: form.expense_type, amount: form.amount, expense_date: form.expense_date || undefined })
        .then(r => setPolicy(r.data)).catch(() => setPolicy(null));
    }, 500);
    return () => clearTimeout(t);
  }, [form?.amount, form?.expense_type, form?.expense_date]); // eslint-disable-line react-hooks/exhaustive-deps

  const fld = (k, v) => setForm(p => ({ ...p, [k]: v, ...(k === 'expense_type' ? { expense_category: '' } : {}) }));
  const pickTrip = (id) => {
    const t = trips.find(x => String(x.id) === String(id));
    setForm(p => ({ ...p, travel_request_id: id, ...(t ? { customer_id: t.customer_id || p.customer_id, project_id: t.project_id || p.project_id, site_name: t.site_name || p.site_name, po_number: t.po_number || p.po_number } : {}) }));
  };
  const overPolicy = policy && policy.within_policy === false;
  const total = (Number(form?.amount) || 0) + (Number(form?.gst_amount) || 0);

  const save = async () => {
    const f = form;
    if (!f.expense_date || !f.expense_type || !f.expense_category || !(Number(f.amount) > 0)) { setFormErr('Date, expense type, category and an amount above 0 are required.'); return; }
    if (f.expense_date > localDay()) { setFormErr('The expense date cannot be in the future.'); return; }
    if (overPolicy && !String(f.over_policy_reason || '').trim()) { setFormErr('This is over your policy limit — say why.'); return; }
    setSaving(true); setFormErr('');
    try {
      const body = { ...f, amount: Number(f.amount), gst_amount: Number(f.gst_amount) || 0 };
      if (f.id) await api.put(`/reimbursement/claims/${f.id}`, body); else await api.post('/reimbursement/claims', body);
      toast.success(f.id ? 'Claim saved as draft' : 'Claim saved as draft — submit it when ready');
      setForm(null); setDetail(null); load();
    } catch (e) { setFormErr(apiError(e, 'Could not save the claim')); }
    finally { setSaving(false); }
  };

  const act = async (fn, okMsg) => {
    try { await fn(); toast.success(okMsg); setDetail(null); load(); }
    catch (e) { toast.error(apiError(e, 'Action failed')); }
  };
  const openDetail = async (c) => {
    try { setDetail((await api.get(`/reimbursement/claims/${c.id}`)).data); }
    catch (e) { toast.error(apiError(e, 'Could not open the claim')); }
  };
  const isOwn = (c) => user?.employee_id != null && String(c.employee_id) === String(user.employee_id);

  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => claims.filter(c => inTab(c, tab) && (!q || [c.claim_number, c.employee_full_name, c.employee_name, c.customer_name, c.project_number, c.expense_type, c.expense_category, c.trip_number, c.vendor_name]
    .some(v => String(v || '').toLowerCase().includes(q)))), [claims, tab, q]);
  const pendingAmt = claims.filter(c => ['Submitted', 'Manager Approved', 'Accounts Verified', 'Mgmt Approved'].includes(c.status) && c.borne_by === 'company').reduce((s, c) => s + Number(c.total_amount || 0), 0);
  const paidAmt = claims.filter(c => c.status === 'Paid').reduce((s, c) => s + Number(c.total_amount || 0), 0);

  const stepOf = (c) => ({ Submitted: 'manager', 'Manager Approved': 'accounts', 'Accounts Verified': 'mgmt' }[c.status]);
  const decide = (c, step, status, remarks, extra = {}) => {
    const url = { manager: 'manager-approve', accounts: 'accounts-verify', mgmt: 'mgmt-approve' }[step];
    return api.put(`/reimbursement/claims/${c.id}/${url}`, { status, remarks, ...extra });
  };

  return (
    <PageShell dock={<PageHero icon={IndianRupee} eyebrow="Travel" title="Expense Claims"
      subtitle={mine.size ? `${mine.size} claim${mine.size === 1 ? '' : 's'} waiting for your decision` : 'File trip and other expenses for reimbursement'}
      actions={<button className="plh-cta" onClick={() => { setFormErr(''); setPolicy(null); setForm({ ...EMPTY, expense_date: localDay() }); }}><Plus size={15} /> New Claim</button>} />}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 18 }}>
        {[['Claims', claims.length], ['Waiting on you', mine.size], ['Awaiting payment / approval', fmt(pendingAmt)], ['Paid', fmt(paidAmt)], ['Over policy', claims.filter(c => c.over_policy).length]].map(([l, v]) => (
          <div key={l} style={{ background: '#fff', borderRadius: 12, padding: '14px 18px', border: '1px solid #f0f0f4' }}>
            <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase' }}>{l}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', marginTop: 4 }}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search claim #, employee, trip, customer, project…" aria-label="Search claims" style={{ ...inputStyle, paddingLeft: 32 }} />
        </div>
        {TABS.map(t => <button key={t} onClick={() => setTab(t)} style={{ ...btn(), padding: '6px 12px', fontSize: 12, ...(tab === t ? { background: '#6B3FDB', color: '#fff', borderColor: '#6B3FDB' } : {}) }}>{t}</button>)}
      </div>
      <ErrorBox>{err}</ErrorBox>
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflowX: 'auto' }}>
        {loading ? <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
          : filtered.length === 0 ? <div style={{ padding: 48, textAlign: 'center', color: '#9ca3af' }}><Receipt size={34} color="#d1d5db" /><p>No expense claims here.</p></div>
          : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ background: '#f9fafb' }}>{['Claim #', 'Employee', 'Expense', 'Trip / Project', 'Date', 'Total', 'Bill', 'Status', ''].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>{filtered.map(c => (
                <tr key={c.id} style={{ borderBottom: '1px solid #f3f4f6', background: mine.has(c.id) ? '#faf8ff' : undefined }}>
                  <td style={{ ...td, fontWeight: 600, color: '#6B3FDB', whiteSpace: 'nowrap', cursor: 'pointer' }} onClick={() => openDetail(c)}>{c.claim_number}</td>
                  <td style={td}><div style={{ fontWeight: 500 }}>{c.employee_full_name || c.employee_name}</div><div style={{ fontSize: 11, color: '#9ca3af' }}>{c.department}</div></td>
                  <td style={td}><div>{c.expense_type}</div><div style={{ fontSize: 11, color: '#9ca3af' }}>{c.expense_category}{c.borne_by === 'personal' ? ' · personal' : ''}</div></td>
                  <td style={td}>{c.trip_number && <div>{c.trip_number}</div>}{c.project_number && <div style={{ fontSize: 11, color: '#6b7280' }}>{c.project_number}</div>}{!c.trip_number && !c.project_number && '—'}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(c.expense_date)}</td>
                  <td style={{ ...td, fontWeight: 600 }}>{fmt(c.total_amount)}{Number(c.gst_amount) > 0 && <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>incl. GST {fmt(c.gst_amount)}</div>}</td>
                  <td style={td}>{c.google_drive_link ? <a href={c.google_drive_link} target="_blank" rel="noopener noreferrer" style={{ color: '#6B3FDB', fontSize: 12 }}><LinkIcon size={12} /> View</a> : (c.bill_number || '—')}</td>
                  <td style={td}><StatusBadge status={c.status} />{c.over_policy && <div style={{ fontSize: 10, color: '#ef4444', marginTop: 3 }}><AlertCircle size={10} /> Over policy</div>}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}><div style={{ display: 'flex', gap: 6 }}>
                    {mine.has(c.id) && <button style={btn('small')} onClick={() => openDetail(c)}>Review</button>}
                    {isOwn(c) && c.status === 'Draft' && <>
                      <button style={btn('small')} onClick={() => { setFormErr(''); setForm({ ...toForm(c), id: c.id }); }}>Edit</button>
                      <button style={{ ...btn('small'), background: '#6B3FDB', color: '#fff' }} onClick={() => act(() => api.post(`/reimbursement/claims/${c.id}/submit`), 'Submitted to your manager')}>Submit</button>
                    </>}
                    {isOwn(c) && REJECTED.includes(c.status) && <button style={btn('small')} onClick={() => { setFormErr(''); setForm({ ...toForm(c), id: c.id }); }}>Fix & resend</button>}
                  </div></td>
                </tr>))}
              </tbody>
            </table>
          )}
      </div>

      {detail && (
        <Dialog title={detail.claim_number} subtitle={`${detail.employee_full_name || detail.employee_name} · ${detail.emp_department || detail.department || ''}`} width={720}
          onClose={() => setDetail(null)} footer={<>
            {isOwn(detail) && detail.status === 'Draft' && <button style={btn('danger')} onClick={() => act(() => api.delete(`/reimbursement/claims/${detail.id}`), 'Draft deleted')}>Delete draft</button>}
            {mine.has(detail.id) && stepOf(detail) === 'manager' && <button style={btn()} onClick={() => setDelegateFor(detail)}>Delegate</button>}
            {mine.has(detail.id) && stepOf(detail) && <button style={btn('danger')} onClick={() => setReject({ claim: detail, step: stepOf(detail) })}>Reject</button>}
            {mine.has(detail.id) && stepOf(detail) === 'accounts' && <button style={btn('success')} onClick={() => setVerify({ claim: detail, gst_verified: false, bill_match_verified: false, duplicate_checked: false, remarks: '' })}>Verify…</button>}
            {mine.has(detail.id) && ['manager', 'mgmt'].includes(stepOf(detail)) && <button style={btn('success')} onClick={() => act(() => decide(detail, stepOf(detail), 'Approved'), 'Approved')}>Approve</button>}
            <button style={btn()} onClick={() => setDetail(null)}>Close</button>
          </>}>
          <StatusBadge status={detail.status} />
          <Stepper status={detail.status} />
          <Facts items={[
            ['Expense', `${detail.expense_type} · ${detail.expense_category || ''}`], ['Date', fmtDate(detail.expense_date)],
            ['Base', fmt(detail.amount)], ['GST', fmt(detail.gst_amount)], ['Total', fmt(detail.total_amount)],
            ['Borne by', detail.borne_by === 'personal' ? 'Personal — not reimbursed' : 'Company'],
            ['Vendor', detail.vendor_name], ['Bill #', detail.bill_number],
            ['Customer', detail.customer_name], ['Project', detail.project_number], ['Site', detail.site_name], ['PO', detail.po_number],
            ['Cost type', detail.cost_type], ['Policy limit', detail.policy_limit ? fmt(detail.policy_limit) : null],
            ['Over policy because', detail.over_policy ? (detail.over_policy_reason || '—') : null],
            ['Advance adjusted', Number(detail.advance_adjusted) ? fmt(detail.advance_adjusted) : null],
            ['Paid', detail.payment_date ? `${fmtDate(detail.payment_date)} · ${detail.payment_mode || ''} ${detail.payment_ref || ''} · net ${fmt(detail.net_payable)}` : null],
          ]} />
          {detail.remarks && <div style={{ marginTop: 14, padding: 12, background: '#f9fafb', borderRadius: 8, fontSize: 13 }}>{detail.remarks}</div>}
          {detail.google_drive_link && <a href={detail.google_drive_link} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', gap: 6, marginTop: 12, color: '#6B3FDB', fontSize: 13, fontWeight: 600 }}><LinkIcon size={14} /> Open the bill</a>}
          {detail.approvals?.length > 0 && (<>
            <div style={{ ...sectionStyle, marginTop: 18 }}>Approval trail</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.8 }}>
              {detail.approvals.map(a => <li key={a.id}><b>{a.level_name}</b> — {a.status}{a.approver_name ? ` by ${a.approver_name}` : ''}{a.actioned_at ? ` on ${fmtDate(a.actioned_at)}` : ''}{a.remarks ? ` — “${a.remarks}”` : ''}</li>)}
            </ul>
          </>)}
          {stepOf(detail) === 'accounts' && mine.has(detail.id) && (
            <div style={{ marginTop: 14, fontSize: 12, color: '#6b7280' }}>Accounts checks: {detail.gst_verified ? 'GST ✓' : 'GST –'} · {detail.bill_match_verified ? 'Bill ✓' : 'Bill –'} · {detail.duplicate_checked ? 'Duplicate ✓' : 'Duplicate –'}</div>
          )}
        </Dialog>
      )}

      {verify && (
        <Dialog title={`Verify ${verify.claim.claim_number}`} width={480} onClose={() => setVerify(null)} footer={<>
          <button style={btn()} onClick={() => setVerify(null)}>Back</button>
          <button style={btn('success')} disabled={!verify.bill_match_verified || !verify.duplicate_checked}
            onClick={() => act(() => decide(verify.claim, 'accounts', 'Approved', verify.remarks, { gst_verified: verify.gst_verified, bill_match_verified: true, duplicate_checked: true }), 'Verified').then(() => setVerify(null))}>Verify</button>
        </>}>
          {[['bill_match_verified', 'The bill matches the claim (amount, date, vendor)'], ['duplicate_checked', 'Checked it has not been claimed before'],
            ['gst_verified', Number(verify.claim.gst_amount) > 0 ? `GST of ${fmt(verify.claim.gst_amount)} is on a valid tax invoice (input credit)` : 'No GST on this bill']].map(([k, l]) => (
            <label key={k} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, marginBottom: 10 }}>
              <input type="checkbox" checked={!!verify[k]} disabled={k === 'gst_verified' && !(Number(verify.claim.gst_amount) > 0)}
                onChange={e => setVerify(v => ({ ...v, [k]: e.target.checked }))} style={{ accentColor: '#6B3FDB', marginTop: 2 }} /> {l}
            </label>
          ))}
          <Field label="Remarks (optional)"><textarea rows={2} value={verify.remarks} onChange={e => setVerify(v => ({ ...v, remarks: e.target.value }))} style={{ ...inputStyle, resize: 'vertical' }} aria-label="Remarks" /></Field>
        </Dialog>
      )}
      {reject && <ReasonDialog title={`Reject ${reject.claim.claim_number}?`} label="Reason (the employee sees this and can fix and resend)" confirmLabel="Reject"
        onCancel={() => setReject(null)} onConfirm={async (r) => { await decide(reject.claim, reject.step, 'Rejected', r); toast.success('Claim rejected'); setReject(null); setDetail(null); load(); }} />}
      {delegateFor && <DelegateDialog title={`Delegate ${delegateFor.claim_number}`} onCancel={() => setDelegateFor(null)}
        onPick={async (id, name) => { await api.post(`/reimbursement/claims/${delegateFor.id}/delegate`, { delegate_employee_id: id }); toast.success(`Delegated to ${name}`); setDelegateFor(null); setDetail(null); load(); }} />}

      {form && (
        <Dialog title={form.id ? 'Edit claim' : 'New expense claim'} subtitle={`Filed as ${user?.name || 'you'} — name and department come from your employee record`} width={740}
          onClose={() => setForm(null)} footer={<>
            <button style={btn()} onClick={() => setForm(null)} disabled={saving}>Cancel</button>
            <button style={btn('primary')} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save as draft'}</button>
          </>}>
          <ErrorBox>{formErr}</ErrorBox>
          <div style={sectionStyle}>Trip and links</div>
          <div style={grid2}>
            <Field label="Approved trip" hint="Leave empty for a non-travel expense"><LookupSelect kind="trips" forWhat="claim" value={form.travel_request_id} onChange={pickTrip} onRows={setTrips} ariaLabel="Trip" /></Field>
            <Field label="Customer"><LookupSelect kind="customers" value={form.customer_id} onChange={v => fld('customer_id', v)} ariaLabel="Customer" /></Field>
            <Field label="Project" hint="A paid claim posts to this project's cost"><LookupSelect kind="projects" value={form.project_id} onChange={v => fld('project_id', v)} ariaLabel="Project" /></Field>
            <Field label="Site"><input value={form.site_name || ''} onChange={e => fld('site_name', e.target.value)} style={inputStyle} aria-label="Site" /></Field>
          </div>
          <div style={sectionStyle}>Expense</div>
          <div style={grid2}>
            <Field label="Expense type" required><VocabSelect vocab="expense-types" value={form.expense_type} onChange={v => fld('expense_type', v)} selectStyle={inputStyle} /></Field>
            <Field label="Category" required><VocabSelect vocab="expense-categories" parent={form.expense_type} value={form.expense_category} onChange={v => fld('expense_category', v)} selectStyle={inputStyle} /></Field>
            <Field label="Expense date" required><input type="date" max={localDay()} value={form.expense_date} onChange={e => fld('expense_date', e.target.value)} style={inputStyle} aria-label="Expense date" /></Field>
            <Field label="Vendor / payee"><input value={form.vendor_name || ''} onChange={e => fld('vendor_name', e.target.value)} placeholder="Hotel, airline, cab…" style={inputStyle} aria-label="Vendor" /></Field>
            <Field label="Base amount (₹)" required><input type="number" min="0" value={form.amount} onChange={e => fld('amount', e.target.value)} style={inputStyle} aria-label="Base amount" /></Field>
            <Field label="GST (₹)"><input type="number" min="0" value={form.gst_amount} onChange={e => fld('gst_amount', e.target.value)} style={inputStyle} aria-label="GST" /></Field>
            <Field label="Borne by" required hint={form.borne_by === 'personal' ? 'Counts toward the trip total; never paid out' : 'Paid to you once approved'}>
              <select value={form.borne_by} onChange={e => fld('borne_by', e.target.value)} style={inputStyle} aria-label="Borne by">
                <option value="company">Company — reimbursable</option><option value="personal">Personal — not reimbursable</option>
              </select>
            </Field>
            <Field label="Total"><div style={{ ...inputStyle, background: '#f9fafb', fontWeight: 700 }}>{fmt(total)}</div></Field>
          </div>
          {policy && policy.policy_limit && (overPolicy
            ? <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 12 }}>
                <b style={{ color: '#9a3412' }}><AlertCircle size={13} /> Over your policy limit of {fmt(policy.policy_limit)}</b> ({policy.rule?.rule_name})
                <div style={{ marginTop: 8 }}><Field label="Why is it over the limit?" required><input value={form.over_policy_reason || ''} onChange={e => fld('over_policy_reason', e.target.value)} style={inputStyle} aria-label="Over policy reason" /></Field></div>
              </div>
            : <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '8px 14px', marginBottom: 14, fontSize: 12, color: '#166534' }}><CheckCircle size={13} /> Within your policy limit of {fmt(policy.policy_limit)}</div>)}
          {policy && !policy.rule && policy.no_rule_reason && <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 14 }}>{policy.no_rule_reason}.</div>}
          <div style={grid2}>
            <Field label="Bill / receipt number"><input value={form.bill_number || ''} onChange={e => fld('bill_number', e.target.value)} style={inputStyle} aria-label="Bill number" /></Field>
            <Field label="Bill link (Google Drive)"><input value={form.google_drive_link || ''} onChange={e => fld('google_drive_link', e.target.value)} placeholder="https://drive.google.com/…" style={inputStyle} aria-label="Bill link" /></Field>
            <Field label="Remarks" full><textarea rows={2} value={form.remarks || ''} onChange={e => fld('remarks', e.target.value)} style={{ ...inputStyle, resize: 'vertical' }} aria-label="Remarks" /></Field>
          </div>
          {form.id && REJECTED.includes(claims.find(c => c.id === form.id)?.status) && <div style={{ fontSize: 12, color: '#92400e' }}>Saving returns this claim to Draft; submit it again for a fresh approval.</div>}
        </Dialog>
      )}
    </PageShell>
  );
}
