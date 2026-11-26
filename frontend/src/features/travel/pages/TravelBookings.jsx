import { useState, useEffect, useCallback } from 'react';
import { Plus, Search, Ticket } from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import { fmt } from './travelUtils';
import { Dialog, Field, StatusBadge, ReasonDialog, LookupSelect, ErrorBox, inputStyle, sectionStyle, grid2, th, td, btn, apiError } from '../components/travelUi';

/**
 * Bookings — tickets and hotels, booked by the TRAVEL DESK (admin) against an
 * approved trip (owner, 26 Nov 26). Everyone else sees their own (and their
 * team's) bookings read-only.
 *
 * Before: any user could book against any trip (or none — the form had no
 * trip picker), and approving a trip wrote a "pending_booking" placeholder row
 * nobody could edit or replace. The desk now works from the To-book queue.
 */
const TYPES = ['Flight', 'Train', 'Bus', 'Cab', 'Hotel', 'Other'];
const EMPTY = { travel_request_id: '', booking_type: 'Train', airline_train: '', booking_ref: '', amount: '', from_date: '', to_date: '', notes: '' };

export default function TravelBookings() {
  const toast = useToast();
  const { hasAnyRole } = useAuth();
  const isDesk = hasAnyRole('admin', 'super_admin');
  const [rows, setRows] = useState([]);
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [search, setSearch] = useState('');
  const [form, setForm] = useState(null);
  const [trips, setTrips] = useState([]);
  const [formErr, setFormErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [cancelFor, setCancelFor] = useState(null);

  const load = useCallback(() => {
    setLoading(true); setErr('');
    Promise.all([
      api.get('/travel/bookings').then(r => r.data),
      isDesk ? api.get('/travel/bookings/queue').then(r => r.data) : Promise.resolve([]),
    ]).then(([b, q]) => { setRows(Array.isArray(b) ? b : []); setQueue(Array.isArray(q) ? q : []); })
      .catch(e => setErr(apiError(e, 'Could not load bookings')))
      .finally(() => setLoading(false));
  }, [isDesk]);
  useEffect(() => { load(); }, [load]);

  const fld = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const startFor = (trip) => {
    setFormErr('');
    const type = trip?.hotel_required && !['Flight', 'Train', 'Bus', 'Cab'].includes(trip?.mode) ? 'Hotel' : (TYPES.includes(trip?.mode) ? trip.mode : 'Train');
    setForm({ ...EMPTY, travel_request_id: trip?.id ?? '', booking_type: type,
      from_date: trip?.from_date ? String(trip.from_date).slice(0, 10) : '', to_date: trip?.to_date ? String(trip.to_date).slice(0, 10) : '' });
  };
  const pickTrip = (id) => {
    const t = trips.find(x => String(x.id) === String(id));
    setForm(p => ({ ...p, travel_request_id: id,
      from_date: t?.from_date ? String(t.from_date).slice(0, 10) : p.from_date, to_date: t?.to_date ? String(t.to_date).slice(0, 10) : p.to_date }));
  };

  const save = async () => {
    const f = form;
    if (!f.id && !f.travel_request_id) { setFormErr('Choose the approved trip this booking is for.'); return; }
    if (f.from_date && f.to_date && f.to_date < f.from_date) { setFormErr('The end date cannot be before the start date.'); return; }
    if (f.amount !== '' && Number(f.amount) < 0) { setFormErr('Cost cannot be negative.'); return; }
    setSaving(true); setFormErr('');
    try {
      const body = { ...f, amount: f.amount === '' ? 0 : Number(f.amount) };
      if (f.id) await api.put(`/travel/bookings/${f.id}`, body); else await api.post('/travel/bookings', body);
      toast.success(f.id ? 'Booking updated' : 'Booked');
      setForm(null); load();
    } catch (e) { setFormErr(apiError(e, 'Could not save the booking')); }
    finally { setSaving(false); }
  };

  const q = search.trim().toLowerCase();
  const filtered = rows.filter(b => !q || [b.request_number, b.destination, b.employee_name, b.booking_ref, b.airline_train, b.booking_type]
    .some(v => String(v || '').toLowerCase().includes(q)));

  return (
    <PageShell dock={<PageHero icon={Ticket} eyebrow="Travel" title="Bookings"
      subtitle={isDesk ? 'Book tickets and hotels for approved trips' : 'Tickets and hotels the travel desk booked for your trips'}
      actions={isDesk ? <button className="plh-cta" onClick={() => startFor(null)}><Plus size={15} /> New Booking</button> : null} />}>
      <ErrorBox>{err}</ErrorBox>

      {isDesk && queue.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #ede9fe', marginBottom: 18, overflowX: 'auto' }}>
          <div style={{ ...sectionStyle, padding: '14px 16px 0' }}>To book — {queue.length} approved trip{queue.length === 1 ? '' : 's'} with nothing booked</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr>{['Trip #', 'Traveller', 'Destination', 'Dates', 'Mode', 'Hotel', ''].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>{queue.map(t => (
              <tr key={t.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                <td style={{ ...td, fontWeight: 600, color: '#6B3FDB' }}>{t.request_number}</td>
                <td style={td}>{t.employee_name}</td><td style={td}>{t.destination}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(t.from_date)} → {fmtDate(t.to_date)}</td>
                <td style={td}>{t.mode || '—'}</td><td style={td}>{t.hotel_required ? 'Needed' : '—'}</td>
                <td style={td}><button style={btn('small')} onClick={() => startFor(t)}>Book</button></td>
              </tr>))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ position: 'relative', marginBottom: 14, maxWidth: 420 }}>
        <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search trip, traveller, reference…" aria-label="Search bookings" style={{ ...inputStyle, paddingLeft: 32 }} />
      </div>
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflowX: 'auto' }}>
        {loading ? <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
          : filtered.length === 0 ? <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No bookings yet.</div>
          : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ background: '#f9fafb' }}>{['Trip #', 'Traveller', 'What', 'Carrier / Hotel', 'Reference', 'Dates', 'Cost', 'Status', ''].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>{filtered.map(b => (
                <tr key={b.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ ...td, fontWeight: 600, color: '#6B3FDB', whiteSpace: 'nowrap' }}>{b.request_number || '—'}</td>
                  <td style={td}>{b.employee_name || '—'}</td>
                  <td style={td}>{b.booking_type || b.mode || '—'}</td>
                  <td style={td}>{b.airline_train || '—'}</td>
                  <td style={td}>{b.booking_ref || '—'}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(b.from_date)}{b.to_date && b.to_date !== b.from_date ? ` → ${fmtDate(b.to_date)}` : ''}</td>
                  <td style={td}>{fmt(b.amount)}</td>
                  <td style={td}><StatusBadge status={b.status} />{b.cancel_reason && <div style={{ fontSize: 10, color: '#6b7280', marginTop: 3, maxWidth: 160 }}>{b.cancel_reason}</div>}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{b.can_edit && <div style={{ display: 'flex', gap: 6 }}>
                    <button style={btn('small')} onClick={() => { setFormErr(''); setForm({ ...EMPTY, ...b, from_date: String(b.from_date || '').slice(0, 10), to_date: String(b.to_date || '').slice(0, 10), amount: b.amount ?? '' }); }}>Edit</button>
                    <button style={{ ...btn('small'), color: '#b91c1c', background: '#fef2f2' }} onClick={() => setCancelFor(b)}>Cancel</button>
                  </div>}</td>
                </tr>))}
              </tbody>
            </table>
          )}
      </div>

      {form && (
        <Dialog title={form.id ? `Edit booking — ${form.request_number || ''}` : 'New booking'} onClose={() => setForm(null)}
          footer={<><button style={btn()} onClick={() => setForm(null)} disabled={saving}>Cancel</button>
            <button style={btn('primary')} onClick={save} disabled={saving}>{saving ? 'Saving…' : form.id ? 'Save changes' : 'Confirm booking'}</button></>}>
          <ErrorBox>{formErr}</ErrorBox>
          <div style={grid2}>
            {!form.id && (
              <Field label="Approved trip" required full>
                <LookupSelect kind="trips" forWhat="booking" value={form.travel_request_id} onChange={pickTrip} onRows={setTrips} placeholder="— Choose a trip —" ariaLabel="Trip" />
              </Field>
            )}
            <Field label="What was booked" required>
              <select value={form.booking_type} onChange={e => fld('booking_type', e.target.value)} style={inputStyle} aria-label="Booking type">
                {TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
            </Field>
            <Field label={form.booking_type === 'Hotel' ? 'Hotel' : 'Airline / train / operator'}>
              <input value={form.airline_train || ''} onChange={e => fld('airline_train', e.target.value)} style={inputStyle} aria-label="Carrier or hotel" />
            </Field>
            <Field label="PNR / booking reference"><input value={form.booking_ref || ''} onChange={e => fld('booking_ref', e.target.value)} style={inputStyle} aria-label="Booking reference" /></Field>
            <Field label="Cost (₹)" hint="Counts as actual trip spend in Insights"><input type="number" min="0" value={form.amount} onChange={e => fld('amount', e.target.value)} style={inputStyle} aria-label="Cost" /></Field>
            <Field label={form.booking_type === 'Hotel' ? 'Check-in' : 'Travel date'}><input type="date" value={form.from_date || ''} onChange={e => fld('from_date', e.target.value)} style={inputStyle} aria-label="From date" /></Field>
            <Field label={form.booking_type === 'Hotel' ? 'Check-out' : 'Return date'}><input type="date" value={form.to_date || ''} min={form.from_date || undefined} onChange={e => fld('to_date', e.target.value)} style={inputStyle} aria-label="To date" /></Field>
            <Field label="Notes" full><textarea rows={2} value={form.notes || ''} onChange={e => fld('notes', e.target.value)} style={{ ...inputStyle, resize: 'vertical' }} aria-label="Notes" /></Field>
          </div>
        </Dialog>
      )}
      {cancelFor && <ReasonDialog title={`Cancel booking ${cancelFor.booking_ref || ''}?`} confirmLabel="Cancel booking"
        onCancel={() => setCancelFor(null)} onConfirm={async (reason) => {
          await api.post(`/travel/bookings/${cancelFor.id}/cancel`, { reason }); toast.success('Booking cancelled'); setCancelFor(null); load();
        }} />}
    </PageShell>
  );
}
