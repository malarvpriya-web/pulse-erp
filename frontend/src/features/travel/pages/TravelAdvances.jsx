import { useState, useEffect, useMemo, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { Plus, Search, Wallet, Download } from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { useToast } from '@/context/ToastContext';
import { fmtDate, localDay } from '@/utils/dateFormatter';
import { fmt } from './travelUtils';
import { Dialog, Field, Facts, StatusBadge, ReasonDialog, DelegateDialog, LookupSelect, ErrorBox, inputStyle, grid2, th, td, btn, apiError } from '../components/travelUi';

/**
 * Advances — cash drawn against an approved trip (26 Nov 26 rebuild).
 *
 *   Pending Manager → (reporting manager) Pending Finance → (Finance) Approved
 *     → (Finance pays — posted to the ledger) Disbursed
 *     → (claims paid / unspent cash returned) Partially Settled | Settled
 *
 * Manager first, then Finance (owner). Only on an APPROVED trip, capped by the
 * trip's estimated cost and the travel policy's maximum. Every button follows
 * a flag the server worked out for this person and this advance (can_* fields),
 * so nobody is offered a step that will be refused.
 */
const EMPTY = { travel_request_id: '', amount: '', purpose: '', required_by: '', document_link: '' };

export default function TravelAdvances() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [statuses, setStatuses] = useState([]);
  const [years, setYears] = useState([]);
  const [filters, setFilters] = useState({ status: 'All', year: 'All' });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [search, setSearch] = useState('');
  const [form, setForm] = useState(null);       // new or resubmit ({ id })
  const [formErr, setFormErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [trips, setTrips] = useState([]);
  const [review, setReview] = useState(null);   // { a, step: 'manager'|'finance' }
  const [comments, setComments] = useState('');
  const [rejecting, setRejecting] = useState(null);
  const [pay, setPay] = useState(null);         // { a, kind: 'disburse'|'refund', ref, date, amount }
  const [delegateFor, setDelegateFor] = useState(null);
  const [view, setView] = useState(null);

  const load = useCallback(() => {
    setLoading(true); setErr('');
    api.get('/travel/advances', { params: { status: filters.status === 'All' ? undefined : filters.status, year: filters.year === 'All' ? undefined : filters.year } })
      .then(r => setRows(Array.isArray(r.data) ? r.data : []))
      .catch(e => { setRows([]); setErr(apiError(e, 'Could not load advances')); })
      .finally(() => setLoading(false));
  }, [filters]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/travel/advances/statuses').then(r => setStatuses(r.data || [])).catch(() => {});
    api.get('/travel/advances/years').then(r => setYears(r.data || [])).catch(() => {});
  }, []);

  const trip = trips.find(t => String(t.id) === String(form?.travel_request_id));
  const save = async () => {
    const f = form;
    if (!f.id && !f.travel_request_id) { setFormErr('Choose the approved trip this advance is for.'); return; }
    if (!(Number(f.amount) > 0)) { setFormErr('Enter an amount greater than 0.'); return; }
    if (!f.purpose.trim()) { setFormErr('Say what the advance is for.'); return; }
    setSaving(true); setFormErr('');
    try {
      const body = { ...f, amount: Number(f.amount) };
      if (f.id) await api.put(`/travel/advances/${f.id}/resubmit`, body); else await api.post('/travel/advances', body);
      toast.success(f.id ? 'Advance sent again to your manager' : 'Advance requested — your manager reviews it first');
      setForm(null); load();
    } catch (e) { setFormErr(apiError(e, 'Could not save the advance')); }
    finally { setSaving(false); }
  };

  const decide = async (a, step, status, text = '') => {
    await api.put(`/travel/advances/${a.id}/${step}-review`, { status, comments: text });
    toast.success(status === 'Approved' ? (step === 'manager' ? 'Approved — now with Finance' : 'Approved — ready to pay') : 'Advance rejected');
    setReview(null); setComments(''); load();
  };

  const doPay = async () => {
    const p = pay;
    try {
      if (p.kind === 'disburse') {
        await api.put(`/travel/advances/${p.a.id}/disburse`, { payment_ref: p.ref, payment_date: p.date });
        toast.success('Advance paid and posted to the ledger');
      } else {
        await api.put(`/travel/advances/${p.a.id}/refund`, { amount: Number(p.amount), refund_ref: p.ref, refund_date: p.date });
        toast.success('Refund recorded');
      }
      setPay(null); load();
    } catch (e) { setPay(prev => ({ ...prev, err: apiError(e, 'Could not record it') })); }
  };

  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => rows.filter(a => !q || [a.purpose, a.employee_name, a.request_number, a.destination]
    .some(v => String(v || '').toLowerCase().includes(q))), [rows, q]);
  const waiting = rows.filter(a => a.can_manager_review || a.can_finance_review || a.can_disburse).length;
  const outstanding = rows.filter(a => ['Disbursed', 'Partially Settled'].includes(a.status)).reduce((s, a) => s + Number(a.outstanding || 0), 0);

  const exportExcel = () => {
    if (!filtered.length) { toast.error('Nothing to export'); return; }
    const ws = XLSX.utils.json_to_sheet(filtered.map(a => ({
      Trip: a.request_number || '', Employee: a.employee_name || '', Destination: a.destination || '',
      Start: fmtDate(a.travel_from), End: fmtDate(a.travel_to), Status: a.status, Purpose: a.purpose,
      Requested: Number(a.amount || 0), 'Paid on': fmtDate(a.payment_date), 'Payment ref': a.payment_ref || '',
      Settled: Number(a.settled_amount || 0), Refunded: Number(a.refund_amount || 0), Outstanding: Number(a.outstanding || 0),
      'Trip claims (company)': Number(a.company_expense || 0), 'Trip claims (personal)': Number(a.personal_expense || 0),
      'Manager remarks': a.manager_comments || '', 'Finance remarks': a.finance_comments || '',
    })));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Advances');
    XLSX.writeFile(wb, `travel_advances_${localDay()}.xlsx`);
  };

  return (
    <PageShell dock={<PageHero icon={Wallet} eyebrow="Travel" title="Travel Advances"
      subtitle={`${waiting ? `${waiting} waiting for you · ` : ''}${fmt(outstanding)} paid out and not yet settled`}
      actions={<button className="plh-cta" onClick={() => { setFormErr(''); setForm({ ...EMPTY }); }}><Plus size={15} /> Request Advance</button>} />}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search employee, trip, purpose…" aria-label="Search advances" style={{ ...inputStyle, paddingLeft: 32 }} />
        </div>
        <select value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))} style={{ ...inputStyle, width: 190 }} aria-label="Status">
          <option value="All">All statuses</option>{statuses.map(s => <option key={s}>{s}</option>)}
        </select>
        <select value={filters.year} onChange={e => setFilters(f => ({ ...f, year: e.target.value }))} style={{ ...inputStyle, width: 120 }} aria-label="Year">
          <option value="All">All years</option>{years.map(y => <option key={y}>{y}</option>)}
        </select>
        <button style={{ ...btn(), display: 'flex', alignItems: 'center', gap: 6 }} onClick={exportExcel}><Download size={14} /> Excel</button>
      </div>
      <ErrorBox>{err}</ErrorBox>
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflowX: 'auto' }}>
        {loading ? <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
          : filtered.length === 0 ? <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No advances.</div>
          : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ background: '#f9fafb' }}>{['Trip', 'Employee', 'Purpose', 'Requested', 'Paid', 'Outstanding', 'Trip claims', 'Status', ''].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>{filtered.map(a => (
                <tr key={a.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ ...td, whiteSpace: 'nowrap', cursor: 'pointer' }} onClick={() => setView(a)}>
                    <div style={{ fontWeight: 600, color: '#6B3FDB' }}>{a.request_number || '—'}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>{a.destination} · {fmtDate(a.travel_from)}</div></td>
                  <td style={td}>{a.employee_name || '—'}</td>
                  <td style={{ ...td, maxWidth: 220 }}>{a.purpose}</td>
                  <td style={td}>{fmt(a.amount)}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{a.payment_date ? <>{fmtDate(a.payment_date)}<div style={{ fontSize: 11, color: '#9ca3af' }}>{a.payment_ref}</div></> : '—'}</td>
                  <td style={td}>{['Disbursed', 'Partially Settled'].includes(a.status) ? fmt(a.outstanding) : '—'}</td>
                  <td style={td}>{Number(a.total_expense) > 0 ? fmt(a.company_expense) : '—'}</td>
                  <td style={td}><StatusBadge status={a.status} /></td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {a.can_manager_review && <button style={btn('small')} onClick={() => setReview({ a, step: 'manager' })}>Manager review</button>}
                    {a.can_manager_review && <button style={btn('small')} onClick={() => setDelegateFor(a)}>Delegate</button>}
                    {a.can_finance_review && <button style={btn('small')} onClick={() => setReview({ a, step: 'finance' })}>Finance review</button>}
                    {a.can_disburse && <button style={btn('small')} onClick={() => setPay({ a, kind: 'disburse', ref: '', date: localDay() })}>Pay out</button>}
                    {a.can_refund && <button style={btn('small')} onClick={() => setPay({ a, kind: 'refund', ref: '', date: localDay(), amount: a.outstanding })}>Record refund</button>}
                    {a.can_resubmit && <button style={btn('small')} onClick={() => { setFormErr(''); setForm({ id: a.id, travel_request_id: a.travel_request_id, amount: a.amount, purpose: a.purpose || '', required_by: String(a.required_by || '').slice(0, 10), document_link: a.document_link || '' }); }}>Fix & resend</button>}
                    {a.can_withdraw && <button style={{ ...btn('small'), color: '#b91c1c', background: '#fef2f2' }} onClick={async () => {
                      try { await api.post(`/travel/advances/${a.id}/withdraw`); toast.success('Advance withdrawn'); load(); } catch (e) { toast.error(apiError(e)); }
                    }}>Withdraw</button>}
                  </div></td>
                </tr>))}
              </tbody>
            </table>
          )}
      </div>

      {view && (
        <Dialog title={`Advance — ${view.request_number || ''}`} subtitle={view.employee_name} onClose={() => setView(null)} footer={<button style={btn('primary')} onClick={() => setView(null)}>Close</button>}>
          <div style={{ marginBottom: 12 }}><StatusBadge status={view.status} /></div>
          <Facts items={[
            ['Trip', `${view.destination || ''} · ${fmtDate(view.travel_from)} → ${fmtDate(view.travel_to)}`], ['Trip estimate', fmt(view.trip_budget)],
            ['Requested', fmt(view.amount)], ['Needed by', view.required_by ? fmtDate(view.required_by) : null], ['Purpose', view.purpose],
            ['Manager', view.manager_at ? `${fmtDate(view.manager_at)}${view.manager_comments ? ' — ' + view.manager_comments : ''}` : null],
            ['Finance', view.finance_at ? `${fmtDate(view.finance_at)}${view.finance_comments ? ' — ' + view.finance_comments : ''}` : null],
            ['Paid', view.payment_date ? `${fmtDate(view.payment_date)} · ${view.payment_ref || ''}` : null],
            ['Settled against claims / refund', Number(view.settled_amount) ? fmt(view.settled_amount) : null],
            ['Refunded', Number(view.refund_amount) ? `${fmt(view.refund_amount)} · ${view.refund_ref || ''}` : null],
            ['Document', view.document_link ? <a href={view.document_link} target="_blank" rel="noopener noreferrer">Open</a> : null],
          ]} />
        </Dialog>
      )}

      {form && (
        <Dialog title={form.id ? 'Fix and resend advance' : 'Request an advance'} onClose={() => setForm(null)} width={560}
          footer={<><button style={btn()} onClick={() => setForm(null)} disabled={saving}>Cancel</button>
            <button style={btn('primary')} onClick={save} disabled={saving}>{saving ? 'Saving…' : form.id ? 'Send again' : 'Request'}</button></>}>
          <ErrorBox>{formErr}</ErrorBox>
          <div style={grid2}>
            {!form.id && <Field label="Approved trip" required full hint="Only your approved trips are listed">
              <LookupSelect kind="trips" forWhat="advance" value={form.travel_request_id} onChange={v => setForm(p => ({ ...p, travel_request_id: v }))} onRows={setTrips} placeholder="— Choose a trip —" ariaLabel="Trip" />
            </Field>}
            <Field label="Amount (₹)" required hint={trip?.budget ? `Trip estimate ${fmt(trip.budget)}` : undefined}>
              <input type="number" min="1" value={form.amount} onChange={e => setForm(p => ({ ...p, amount: e.target.value }))} style={inputStyle} aria-label="Amount" />
            </Field>
            <Field label="Needed by"><input type="date" value={form.required_by} onChange={e => setForm(p => ({ ...p, required_by: e.target.value }))} style={inputStyle} aria-label="Needed by" /></Field>
            <Field label="What is it for?" required full><input value={form.purpose} onChange={e => setForm(p => ({ ...p, purpose: e.target.value }))} placeholder="Hotel, local travel, site expenses…" style={inputStyle} aria-label="Purpose" /></Field>
            <Field label="Supporting document link" full><input value={form.document_link} onChange={e => setForm(p => ({ ...p, document_link: e.target.value }))} placeholder="https://drive.google.com/…" style={inputStyle} aria-label="Document link" /></Field>
          </div>
        </Dialog>
      )}

      {review && (
        <Dialog title={`${review.step === 'manager' ? 'Manager' : 'Finance'} review — ${fmt(review.a.amount)}`} subtitle={`${review.a.employee_name} · ${review.a.request_number || ''}`}
          width={500} onClose={() => setReview(null)} footer={<>
            <button style={btn('danger')} onClick={() => { setRejecting(review); setReview(null); }}>Reject</button>
            <button style={btn('success')} onClick={() => decide(review.a, review.step, 'Approved', comments).catch(e => toast.error(apiError(e)))}>Approve</button>
          </>}>
          <Facts items={[['Purpose', review.a.purpose], ['Trip', `${review.a.destination} · ${fmtDate(review.a.travel_from)} → ${fmtDate(review.a.travel_to)}`],
            ['Trip estimate', fmt(review.a.trip_budget)], ['Manager remarks', review.step === 'finance' ? review.a.manager_comments : null]]} />
          <div style={{ marginTop: 14 }}><Field label="Comments (optional)"><textarea rows={2} value={comments} onChange={e => setComments(e.target.value)} style={{ ...inputStyle, resize: 'vertical' }} aria-label="Comments" /></Field></div>
        </Dialog>
      )}
      {rejecting && <ReasonDialog title="Reject this advance?" label="Reason (the employee sees this and can fix and resend)" confirmLabel="Reject"
        onCancel={() => setRejecting(null)} onConfirm={async (r) => { await decide(rejecting.a, rejecting.step, 'Rejected', r); setRejecting(null); }} />}
      {delegateFor && <DelegateDialog title="Delegate the manager review" onCancel={() => setDelegateFor(null)}
        onPick={async (id, name) => { await api.post(`/travel/advances/${delegateFor.id}/delegate`, { delegate_employee_id: id }); toast.success(`Delegated to ${name}`); setDelegateFor(null); load(); }} />}

      {pay && (
        <Dialog title={pay.kind === 'disburse' ? `Pay out ${fmt(pay.a.amount)}` : 'Record unspent advance returned'} subtitle={`${pay.a.employee_name} · ${pay.a.request_number || ''}`}
          width={480} onClose={() => setPay(null)} footer={<>
            <button style={btn()} onClick={() => setPay(null)}>Cancel</button>
            <button style={btn('primary')} onClick={doPay} disabled={!pay.ref?.trim() || !pay.date}>{pay.kind === 'disburse' ? 'Record payment' : 'Record refund'}</button>
          </>}>
          <ErrorBox>{pay.err}</ErrorBox>
          <div style={grid2}>
            {pay.kind === 'refund' && <Field label="Amount returned (₹)" required hint={`Outstanding ${fmt(pay.a.outstanding)}`}>
              <input type="number" min="1" max={pay.a.outstanding} value={pay.amount} onChange={e => setPay(p => ({ ...p, amount: e.target.value }))} style={inputStyle} aria-label="Amount returned" /></Field>}
            <Field label={pay.kind === 'disburse' ? 'Payment reference (UTR / cheque)' : 'Receipt reference'} required>
              <input value={pay.ref} onChange={e => setPay(p => ({ ...p, ref: e.target.value }))} style={inputStyle} aria-label="Reference" /></Field>
            <Field label="Date" required><input type="date" value={pay.date} max={localDay()} onChange={e => setPay(p => ({ ...p, date: e.target.value }))} style={inputStyle} aria-label="Date" /></Field>
          </div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>This posts to the ledger ({pay.kind === 'disburse' ? 'Employee advances ↑, bank ↓' : 'bank ↑, Employee advances ↓'}). Finance must have chosen the travel ledger accounts in Insights & Policy → Travel Audit.</div>
        </Dialog>
      )}
    </PageShell>
  );
}
