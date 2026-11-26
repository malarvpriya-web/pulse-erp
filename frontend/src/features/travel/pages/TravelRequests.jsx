import { useState, useEffect, useCallback } from 'react';
import { Plus, Search, Plane } from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';
import VocabSelect from '@/components/core/VocabSelect';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { fmtDate, localDay } from '@/utils/dateFormatter';
import { fmt } from './travelUtils';
import {
  Dialog, Field, Facts, StatusBadge, ReasonDialog, LookupSelect, ErrorBox,
  inputStyle, sectionStyle, grid2, th, td, btn, apiError,
} from '../components/travelUi';

/**
 * Travel Requests — raise a trip, edit it while it waits, cancel it with a
 * reason, and see what happened to it (26 Nov 26 rebuild).
 *
 *  - Customer, project, opportunity and service ticket are pickers over the
 *    real records; they were free text, so no trip ever linked to anything.
 *  - Travel type is saved (it was dropped on save — every trip had none).
 *  - One approval step: the reporting manager (Travel Approvals). The detail
 *    used to draw a 3-level workflow the real approval never used.
 *  - The travel desk (admin) can raise a trip for an employee, chosen from
 *    the employee list rather than a typed name.
 */
const TRAVEL_MODES = ['Flight', 'Train', 'Bus', 'Car', 'Cab', 'Two-Wheeler', 'Other'];
const STATUSES = ['All', 'Pending', 'Approved', 'Rejected', 'Cancelled'];
const EMPTY = {
  employee_id: '', travel_type: '', destination: '', purpose: '', from_date: '', to_date: '',
  budget: '', mode: 'Train', hotel_required: false, advance_required: false, notes: '',
  customer_id: '', project_id: '', opportunity_id: '', service_ticket_id: '', site_name: '', po_number: '',
};
const toForm = (r) => Object.fromEntries(Object.keys(EMPTY).map(k => [k, r?.[k] == null ? EMPTY[k] : (k.endsWith('_date') ? String(r[k]).slice(0, 10) : r[k])]));

export default function TravelRequests() {
  const toast = useToast();
  const { hasAnyRole } = useAuth();
  const isDesk = hasAnyRole('admin', 'super_admin');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('All');
  const [mineOnly, setMineOnly] = useState(false);
  const [form, setForm] = useState(null);      // { ...fields, id? }
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState('');
  const [detail, setDetail] = useState(null);
  const [cancelFor, setCancelFor] = useState(null);

  const load = useCallback(() => {
    setLoading(true); setLoadErr('');
    api.get('/travel/requests', { params: { limit: 500, mine: mineOnly ? 1 : undefined } })
      .then(r => setRows(Array.isArray(r.data) ? r.data : []))
      .catch(e => { setRows([]); setLoadErr(apiError(e, 'Could not load trips')); })
      .finally(() => setLoading(false));
  }, [mineOnly]);
  useEffect(() => { load(); }, [load]);

  const openDetail = async (id) => {
    try { setDetail((await api.get(`/travel/requests/${id}`)).data); }
    catch (e) { toast.error(apiError(e, 'Could not open the trip')); }
  };

  const fld = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const save = async () => {
    const f = form;
    if (!f.travel_type || !f.destination.trim() || !f.purpose.trim() || !f.from_date || !f.to_date) {
      setFormErr('Travel type, destination, purpose and both dates are required.'); return;
    }
    if (f.to_date < f.from_date) { setFormErr('The end date cannot be before the start date.'); return; }
    if (f.budget !== '' && Number(f.budget) < 0) { setFormErr('Estimated cost cannot be negative.'); return; }
    setSaving(true); setFormErr('');
    try {
      const body = { ...f, budget: f.budget === '' ? 0 : Number(f.budget) };
      if (f.id) await api.put(`/travel/requests/${f.id}`, body);
      else await api.post('/travel/requests', body);
      toast.success(f.id ? 'Trip updated' : 'Trip submitted for approval');
      setForm(null); load();
      if (f.id && detail?.id === f.id) openDetail(f.id);
    } catch (e) { setFormErr(apiError(e, 'Could not save the trip')); }
    finally { setSaving(false); }
  };

  const cancelTrip = async (reason) => {
    await api.post(`/travel/requests/${cancelFor.id}/cancel`, { reason });
    toast.success('Trip cancelled');
    setCancelFor(null); setDetail(null); load();
  };

  const q = search.trim().toLowerCase();
  const filtered = rows.filter(r => (status === 'All' || r.status === status) &&
    (!q || [r.request_number, r.destination, r.purpose, r.employee_name, r.customer_name, r.project_number, r.po_number, r.travel_type]
      .some(v => String(v || '').toLowerCase().includes(q))));

  return (
    <PageShell dock={
      <PageHero icon={Plane} eyebrow="Travel" title="Travel Requests"
        subtitle="Raise a trip; your reporting manager approves it in Travel Approvals"
        actions={<button className="plh-cta" onClick={() => { setFormErr(''); setForm({ ...EMPTY }); }}><Plus size={15} /> New Request</button>} />
    }>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search trip #, destination, customer, project, PO…"
            aria-label="Search trips" style={{ ...inputStyle, paddingLeft: 32 }} />
        </div>
        {STATUSES.map(s => (
          <button key={s} onClick={() => setStatus(s)}
            style={{ ...btn(), padding: '7px 14px', fontSize: 12, ...(status === s ? { background: '#6B3FDB', color: '#fff', borderColor: '#6B3FDB' } : {}) }}>{s}</button>
        ))}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#374151' }}>
          <input type="checkbox" checked={mineOnly} onChange={e => setMineOnly(e.target.checked)} style={{ accentColor: '#6B3FDB' }} /> Only my trips
        </label>
      </div>

      <ErrorBox>{loadErr}</ErrorBox>
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflowX: 'auto' }}>
        {loading ? <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
          : filtered.length === 0 ? <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No trips found.</div>
          : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ background: '#f9fafb' }}>
                {['Trip #', 'Employee', 'Type', 'Destination', 'Customer / Project', 'Dates', 'Estimate', 'Status'].map(h => <th key={h} style={th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {filtered.map(r => (
                  <tr key={r.id} onClick={() => openDetail(r.id)} style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }}>
                    <td style={{ ...td, fontWeight: 600, color: '#6B3FDB', whiteSpace: 'nowrap' }}>{r.request_number}</td>
                    <td style={td}><div style={{ fontWeight: 500 }}>{r.employee_name || '—'}</div><div style={{ fontSize: 11, color: '#9ca3af' }}>{r.department}</div></td>
                    <td style={td}>{r.travel_type || '—'}</td>
                    <td style={td}>{r.destination}</td>
                    <td style={td}>{r.customer_name && <div>{r.customer_name}</div>}{r.project_number && <div style={{ fontSize: 11, color: '#6b7280' }}>{r.project_number}</div>}{!r.customer_name && !r.project_number && '—'}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(r.from_date)} → {fmtDate(r.to_date)}</td>
                    <td style={td}>{fmt(r.budget)}</td>
                    <td style={td}><StatusBadge status={r.status} />
                      {r.status === 'Pending' && <div style={{ fontSize: 10, color: '#6b7280', marginTop: 3 }}>{r.delegate_name ? `With ${r.delegate_name}` : 'With reporting manager'}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      {detail && (
        <Dialog title={`${detail.request_number} — ${detail.destination}`} subtitle={`${detail.employee_name || ''}${detail.department ? ' · ' + detail.department : ''}`}
          onClose={() => setDetail(null)} width={720}
          footer={<>
            {detail.can_cancel && <button style={btn('danger')} onClick={() => setCancelFor(detail)}>Cancel trip</button>}
            {detail.can_edit && <button style={btn()} onClick={() => { setFormErr(''); setForm({ ...toForm(detail), id: detail.id }); }}>Edit</button>}
            <button style={btn('primary')} onClick={() => setDetail(null)}>Close</button>
          </>}>
          <div style={{ marginBottom: 14 }}><StatusBadge status={detail.status} /></div>
          <Facts items={[
            ['Travel type', detail.travel_type], ['Dates', `${fmtDate(detail.from_date)} → ${fmtDate(detail.to_date)}`],
            ['Mode', detail.mode], ['Estimated cost', fmt(detail.budget)], ['Purpose', detail.purpose],
            ['Customer', detail.customer_name], ['Project', detail.project_number], ['Opportunity', detail.opportunity_ref],
            ['Service ticket', detail.service_ticket_number], ['Site', detail.site_name], ['PO number', detail.po_number],
            ['Hotel needed', detail.hotel_required ? 'Yes' : 'No'], ['Advance needed', detail.advance_required ? 'Yes' : 'No'],
          ]} />
          {detail.notes && <div style={{ marginTop: 14, padding: 12, background: '#f9fafb', borderRadius: 8, fontSize: 13 }}>{detail.notes}</div>}

          <div style={{ ...sectionStyle, marginTop: 20 }}>Decision</div>
          <div style={{ fontSize: 13, color: '#374151' }}>
            {detail.status === 'Pending' && (detail.delegate_name ? `Waiting for ${detail.delegate_name} (delegated)` : 'Waiting for the reporting manager')}
            {['Approved', 'Rejected'].includes(detail.status) && <>{detail.status} by {detail.decided_by_name || '—'}{detail.decided_at && ` on ${fmtDate(detail.decided_at)}`}{detail.decision_comments && <> — “{detail.decision_comments}”</>}</>}
            {detail.status === 'Cancelled' && <>Cancelled{detail.cancelled_at && ` on ${fmtDate(detail.cancelled_at)}`} — “{detail.cancel_reason}”</>}
          </div>

          {(detail.advances?.length || detail.bookings?.length || detail.claims?.length || detail.visit_report) ? (
            <>
              <div style={{ ...sectionStyle, marginTop: 20 }}>Linked records</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: '#374151', lineHeight: 1.8 }}>
                {detail.bookings?.map(b => <li key={`b${b.id}`}>Booking — {b.booking_type} {b.airline_train || ''} {b.booking_ref ? `(${b.booking_ref})` : ''} · {fmt(b.amount)} · {b.status}</li>)}
                {detail.advances?.map(a => <li key={`a${a.id}`}>Advance — {fmt(a.amount)} · {a.status}</li>)}
                {detail.claims?.map(c => <li key={`c${c.id}`}>Claim {c.claim_number} — {c.expense_type} · {fmt(c.total_amount)} · {c.status}{c.borne_by === 'personal' ? ' · personal' : ''}</li>)}
                {detail.visit_report && <li>Visit report {detail.visit_report.report_number} · {detail.visit_report.status}</li>}
              </ul>
            </>
          ) : null}
        </Dialog>
      )}

      {cancelFor && <ReasonDialog title={`Cancel ${cancelFor.request_number}?`} label="Why is this trip cancelled?" confirmLabel="Cancel trip"
        onCancel={() => setCancelFor(null)} onConfirm={cancelTrip} />}

      {form && (
        <Dialog title={form.id ? 'Edit travel request' : 'New travel request'} width={720} onClose={() => setForm(null)}
          footer={<>
            <button style={btn()} onClick={() => setForm(null)} disabled={saving}>Cancel</button>
            <button style={btn('primary')} onClick={save} disabled={saving}>{saving ? 'Saving…' : form.id ? 'Save changes' : 'Submit request'}</button>
          </>}>
          <ErrorBox>{formErr}</ErrorBox>
          {isDesk && !form.id && (<>
            <div style={sectionStyle}>Traveller</div>
            <div style={grid2}>
              <Field label="Employee" hint="Leave empty to raise the trip for yourself. Name and department come from the employee record.">
                <LookupSelect kind="employees" value={form.employee_id} onChange={v => fld('employee_id', v)} placeholder="— Myself —" ariaLabel="Employee" />
              </Field>
            </div>
          </>)}

          <div style={sectionStyle}>Trip</div>
          <div style={grid2}>
            <Field label="Travel type" required>
              <VocabSelect vocab="travel-types" value={form.travel_type} onChange={v => fld('travel_type', v)} selectStyle={inputStyle} />
            </Field>
            <Field label="Travel mode">
              <select value={form.mode} onChange={e => fld('mode', e.target.value)} style={inputStyle} aria-label="Travel mode">
                {TRAVEL_MODES.map(m => <option key={m}>{m}</option>)}
              </select>
            </Field>
            <Field label="Destination" required full>
              <input value={form.destination} onChange={e => fld('destination', e.target.value)} placeholder="City — customer / site" style={inputStyle} aria-label="Destination" />
            </Field>
            <Field label="Purpose" required full>
              <input value={form.purpose} onChange={e => fld('purpose', e.target.value)} placeholder="What will this trip achieve?" style={inputStyle} aria-label="Purpose" />
            </Field>
            <Field label="Start date" required>
              <input type="date" value={form.from_date} onChange={e => fld('from_date', e.target.value)} style={inputStyle} aria-label="Start date" />
            </Field>
            <Field label="End date" required>
              <input type="date" value={form.to_date} min={form.from_date || undefined} onChange={e => fld('to_date', e.target.value)} style={inputStyle} aria-label="End date" />
            </Field>
            <Field label="Estimated cost (₹)" hint="Advances on this trip cannot exceed it">
              <input type="number" min="0" value={form.budget} onChange={e => fld('budget', e.target.value)} placeholder="0" style={inputStyle} aria-label="Estimated cost" />
            </Field>
            <Field label="Needs">
              <div style={{ display: 'flex', gap: 16, paddingTop: 8 }}>
                {[['hotel_required', 'Hotel'], ['advance_required', 'Cash advance']].map(([k, l]) => (
                  <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                    <input type="checkbox" checked={!!form[k]} onChange={e => fld(k, e.target.checked)} style={{ accentColor: '#6B3FDB' }} /> {l}
                  </label>
                ))}
              </div>
            </Field>
          </div>

          <div style={sectionStyle}>Linked to</div>
          <div style={grid2}>
            <Field label="Customer"><LookupSelect kind="customers" value={form.customer_id} onChange={v => fld('customer_id', v)} ariaLabel="Customer" /></Field>
            <Field label="Project" hint="Its spend posts to this project's cost"><LookupSelect kind="projects" value={form.project_id} onChange={v => fld('project_id', v)} ariaLabel="Project" /></Field>
            <Field label="Opportunity"><LookupSelect kind="opportunities" value={form.opportunity_id} onChange={v => fld('opportunity_id', v)} ariaLabel="Opportunity" /></Field>
            <Field label="Service ticket"><LookupSelect kind="tickets" value={form.service_ticket_id} onChange={v => fld('service_ticket_id', v)} ariaLabel="Service ticket" /></Field>
            <Field label="Site"><input value={form.site_name} onChange={e => fld('site_name', e.target.value)} placeholder="Site / plant" style={inputStyle} aria-label="Site" /></Field>
            <Field label="Customer PO number"><input value={form.po_number} onChange={e => fld('po_number', e.target.value)} style={inputStyle} aria-label="PO number" /></Field>
            <Field label="Notes" full>
              <textarea rows={3} value={form.notes} onChange={e => fld('notes', e.target.value)} placeholder="Itinerary, special needs…" style={{ ...inputStyle, resize: 'vertical' }} aria-label="Notes" />
            </Field>
          </div>
          {!form.id && form.from_date && form.from_date < localDay() && (
            <div style={{ fontSize: 12, color: '#92400e', background: '#fef3c7', padding: '8px 12px', borderRadius: 8 }}>
              This trip starts in the past — your manager will see it as a trip already taken.
            </div>
          )}
        </Dialog>
      )}
    </PageShell>
  );
}
