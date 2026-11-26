import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, Search, FileText, MapPin, Navigation, Trash2 } from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';
import VocabSelect from '@/components/core/VocabSelect';
import { useToast } from '@/context/ToastContext';
import { fmtDate, localDay } from '@/utils/dateFormatter';
import { Dialog, Field, Facts, StatusBadge, ReasonDialog, LookupSelect, ErrorBox, inputStyle, sectionStyle, grid2, th, td, btn, apiError } from '../components/travelUi';

/**
 * Visit Reports — one report per customer / site visit (26 Nov 26 rebuild;
 * Customer Visits merged in, owner).
 *
 *   Draft ─submit─▶ Submitted ─manager─▶ Completed
 *     ▲                 └──────────────▶ Returned (with remarks) ─▶ edit, submit again
 *
 *  - The author edits everything while Draft / Returned; the reporting manager
 *    reviews (an author used to mark their own report Completed).
 *  - Trip, customer, project, opportunity and ticket are links; picking a trip
 *    fills its customer / project / ticket.
 *  - Sales, application, commissioning, service, AMC, survey and installation
 *    trips need their report submitted before the trip's expense claims can be
 *    — "Reports owed" lists those still missing.
 *  - Action items carry an owner and due date and can be ticked off later.
 */
const OUTCOMES = ['Positive', 'Neutral', 'Negative', 'Order Expected', 'Issue Resolved', 'Follow-up Needed'];
const TABS = ['All', 'Draft', 'Submitted', 'Returned', 'Completed'];
const EMPTY = {
  travel_request_id: '', visit_type: 'Sales Visit', visit_date: '', customer_id: '', project_id: '', opportunity_id: '',
  service_ticket_id: '', site_name: '', location: '', gps_lat: '', gps_lng: '', purpose: '', discussion_summary: '',
  outcome: '', next_followup: '', next_followup_notes: '', action_items: [],
};
const toForm = (r) => ({ ...Object.fromEntries(Object.keys(EMPTY).map(k => [k, r?.[k] == null ? EMPTY[k] : (['visit_date', 'next_followup'].includes(k) ? String(r[k]).slice(0, 10) : r[k])])),
  action_items: Array.isArray(r?.action_items) ? r.action_items : [] });

export default function VisitReports() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [stats, setStats] = useState({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('All');
  const [search, setSearch] = useState('');
  const [form, setForm] = useState(null);
  const [formErr, setFormErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [trips, setTrips] = useState([]);
  const [detail, setDetail] = useState(null);
  const [returning, setReturning] = useState(null);

  const load = useCallback(() => {
    setLoading(true); setErr('');
    Promise.all([api.get('/visit-reports').then(r => r.data), api.get('/visit-reports/summary/stats').then(r => r.data).catch(() => ({}))])
      .then(([r, s]) => { setRows(Array.isArray(r) ? r : []); setStats(s || {}); })
      .catch(e => { setRows([]); setErr(apiError(e, 'Could not load visit reports')); })
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const open = async (id) => {
    try { setDetail((await api.get(`/visit-reports/${id}`)).data); } catch (e) { toast.error(apiError(e)); }
  };
  const fld = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const pickTrip = (id) => {
    const t = trips.find(x => String(x.id) === String(id));
    setForm(p => ({ ...p, travel_request_id: id, ...(t ? {
      customer_id: t.customer_id || p.customer_id, project_id: t.project_id || p.project_id, opportunity_id: t.opportunity_id || p.opportunity_id,
      site_name: t.site_name || p.site_name, visit_type: t.travel_type || p.visit_type,
      visit_date: p.visit_date || String(t.from_date || '').slice(0, 10) } : {}) }));
  };
  const setItem = (i, k, v) => setForm(p => ({ ...p, action_items: p.action_items.map((a, j) => j === i ? { ...a, [k]: v } : a) }));
  const gps = () => {
    if (!navigator.geolocation) { toast.error('Location is not available on this device'); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => setForm(p => ({ ...p, gps_lat: pos.coords.latitude.toFixed(6), gps_lng: pos.coords.longitude.toFixed(6) })),
      () => toast.error('Could not read your location'));
  };

  const save = async (submit) => {
    const f = form;
    if (!f.visit_type || !f.visit_date || !String(f.purpose).trim()) { setFormErr('Visit type, date and purpose are required.'); return; }
    if (f.visit_date > localDay()) { setFormErr('The visit date cannot be in the future.'); return; }
    if (submit && !String(f.discussion_summary || '').trim()) { setFormErr('Write the discussion summary before submitting.'); return; }
    setSaving(true); setFormErr('');
    try {
      const body = { ...f, action_items: f.action_items.filter(a => String(a.action || '').trim()) };
      let id = f.id;
      if (id) await api.put(`/visit-reports/${id}`, body);
      else id = (await api.post('/visit-reports', body)).data.id;
      if (submit) await api.post(`/visit-reports/${id}/submit`);
      toast.success(submit ? 'Report submitted to your manager' : 'Report saved as draft');
      setForm(null); setDetail(null); load();
    } catch (e) { setFormErr(apiError(e, 'Could not save the report')); }
    finally { setSaving(false); }
  };

  const review = async (decision, remarks = '') => {
    await api.post(`/visit-reports/${detail.id}/review`, { decision, remarks });
    toast.success(decision === 'Completed' ? 'Report accepted' : 'Report sent back');
    setDetail(null); setReturning(null); load();
  };
  const toggleItem = async (i) => {
    const items = detail.action_items.map((a, j) => j === i ? { ...a, status: a.status === 'Done' ? 'Open' : 'Done' } : a);
    try { const r = await api.put(`/visit-reports/${detail.id}/action-items`, { action_items: items }); setDetail(d => ({ ...d, action_items: r.data.action_items })); load(); }
    catch (e) { toast.error(apiError(e)); }
  };

  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => rows.filter(r => (tab === 'All' || r.status === tab) && (!q || [r.report_number, r.customer_name, r.visited_by_name, r.purpose, r.visit_type, r.project_number, r.trip_number]
    .some(v => String(v || '').toLowerCase().includes(q)))), [rows, tab, q]);

  return (
    <PageShell dock={<PageHero icon={FileText} eyebrow="Travel" title="Visit Reports" subtitle="Write up each customer or site visit; your manager reviews it"
      actions={<button className="plh-cta" onClick={() => { setFormErr(''); setForm({ ...EMPTY, visit_date: localDay() }); }}><Plus size={15} /> New Report</button>} />}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 18 }}>
        {[['Reports', stats.total ?? 0], ['This month', stats.this_month ?? 0], ['Drafts / returned', stats.pending_reports ?? 0], ['Awaiting review', stats.awaiting_review ?? 0],
          ['Open action items', stats.open_actions ?? 0], ['Follow-ups in 7 days', stats.upcoming_followups ?? 0]].map(([l, v]) => (
          <div key={l} style={{ background: '#fff', borderRadius: 12, padding: '14px 18px', border: '1px solid #f0f0f4' }}>
            <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase' }}>{l}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', marginTop: 4 }}>{v}</div>
          </div>
        ))}
      </div>

      {stats.owed?.length > 0 && (
        <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 12, padding: '12px 16px', marginBottom: 16, fontSize: 13 }}>
          <b style={{ color: '#92400e' }}>Reports owed ({stats.owed.length})</b> — these trips need a visit report before their expense claims can be submitted:
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{stats.owed.slice(0, 8).map(t => (
            <li key={t.id}>{t.request_number} · {t.travel_type} · {t.destination} · {t.employee_name} (ended {fmtDate(t.to_date)})</li>))}</ul>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search report #, customer, visitor, purpose…" aria-label="Search reports" style={{ ...inputStyle, paddingLeft: 32 }} />
        </div>
        {TABS.map(t => <button key={t} onClick={() => setTab(t)} style={{ ...btn(), padding: '6px 12px', fontSize: 12, ...(tab === t ? { background: '#6B3FDB', color: '#fff', borderColor: '#6B3FDB' } : {}) }}>{t}</button>)}
      </div>
      <ErrorBox>{err}</ErrorBox>
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflowX: 'auto' }}>
        {loading ? <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
          : filtered.length === 0 ? <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No visit reports.</div>
          : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ background: '#f9fafb' }}>{['Report #', 'Visit', 'Customer / Project', 'Visited by', 'Date', 'Outcome', 'Actions open', 'Status'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>{filtered.map(r => {
                const open_ = (r.action_items || []).filter(a => a.status !== 'Done').length;
                return (
                  <tr key={r.id} onClick={() => open(r.id)} style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }}>
                    <td style={{ ...td, fontWeight: 600, color: '#6B3FDB', whiteSpace: 'nowrap' }}>{r.report_number}{r.trip_number && <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>{r.trip_number}</div>}</td>
                    <td style={td}><div>{r.visit_type}</div><div style={{ fontSize: 11, color: '#6b7280', maxWidth: 220 }}>{r.purpose}</div></td>
                    <td style={td}>{r.customer_name || '—'}{r.project_number && <div style={{ fontSize: 11, color: '#6b7280' }}>{r.project_number}</div>}</td>
                    <td style={td}>{r.visited_by_name}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(r.visit_date)}</td>
                    <td style={td}>{r.outcome || '—'}</td>
                    <td style={td}>{open_ || '—'}</td>
                    <td style={td}><StatusBadge status={r.status} /></td>
                  </tr>);
              })}</tbody>
            </table>
          )}
      </div>

      {detail && (
        <Dialog title={`${detail.report_number} — ${detail.customer_name || detail.visit_type}`} subtitle={`${detail.visited_by_name || ''} · ${fmtDate(detail.visit_date)}`} width={720}
          onClose={() => setDetail(null)} footer={<>
            {detail.can_delete && <button style={btn('danger')} onClick={async () => { try { await api.delete(`/visit-reports/${detail.id}`); toast.success('Report deleted'); setDetail(null); load(); } catch (e) { toast.error(apiError(e)); } }}>Delete</button>}
            {detail.can_edit && <button style={btn()} onClick={() => { setFormErr(''); setForm({ ...toForm(detail), id: detail.id }); }}>Edit</button>}
            {detail.can_review && <button style={btn('danger')} onClick={() => setReturning(detail)}>Send back</button>}
            {detail.can_review && <button style={btn('success')} onClick={() => review('Completed').catch(e => toast.error(apiError(e)))}>Accept</button>}
            <button style={btn('primary')} onClick={() => setDetail(null)}>Close</button>
          </>}>
          <StatusBadge status={detail.status} />
          {detail.status === 'Returned' && detail.review_remarks && <div style={{ margin: '10px 0', padding: 10, background: '#fef3c7', borderRadius: 8, fontSize: 13 }}><b>Sent back:</b> {detail.review_remarks}</div>}
          <div style={{ marginTop: 12 }}><Facts items={[
            ['Visit type', detail.visit_type], ['Trip', detail.trip_number], ['Customer', detail.customer_name], ['Project', detail.project_number],
            ['Opportunity', detail.opportunity_ref], ['Site', detail.site_name], ['Location', detail.location],
            ['GPS', detail.gps_lat && detail.gps_lng ? <a href={`https://maps.google.com/?q=${detail.gps_lat},${detail.gps_lng}`} target="_blank" rel="noopener noreferrer">{Number(detail.gps_lat).toFixed(4)}, {Number(detail.gps_lng).toFixed(4)}</a> : null],
            ['Purpose', detail.purpose], ['Outcome', detail.outcome],
            ['Next follow-up', detail.next_followup ? `${fmtDate(detail.next_followup)}${detail.next_followup_notes ? ' — ' + detail.next_followup_notes : ''}` : null],
            ['Reviewed', detail.reviewed_at ? `${detail.reviewed_by_name || ''} · ${fmtDate(detail.reviewed_at)}${detail.status === 'Completed' && detail.review_remarks ? ' — ' + detail.review_remarks : ''}` : null],
          ]} /></div>
          {detail.discussion_summary && (<><div style={{ ...sectionStyle, marginTop: 16 }}>Discussion</div><div style={{ fontSize: 13, whiteSpace: 'pre-wrap', color: '#374151' }}>{detail.discussion_summary}</div></>)}
          {detail.action_items?.length > 0 && (<>
            <div style={{ ...sectionStyle, marginTop: 16 }}>Action items</div>
            {detail.action_items.map((a, i) => (
              <label key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, marginBottom: 8 }}>
                <input type="checkbox" checked={a.status === 'Done'} onChange={() => toggleItem(i)} style={{ accentColor: '#6B3FDB', marginTop: 2 }} />
                <span style={{ textDecoration: a.status === 'Done' ? 'line-through' : 'none' }}>{a.action}{a.owner && <span style={{ color: '#6b7280' }}> · {a.owner}</span>}{a.due_date && <span style={{ color: '#6b7280' }}> · due {fmtDate(a.due_date)}</span>}</span>
              </label>
            ))}
          </>)}
        </Dialog>
      )}
      {returning && <ReasonDialog title="Send this report back?" label="What needs fixing" confirmLabel="Send back" onCancel={() => setReturning(null)} onConfirm={(r) => review('Returned', r)} />}

      {form && (
        <Dialog title={form.id ? 'Edit visit report' : 'New visit report'} width={760} onClose={() => setForm(null)} footer={<>
          <button style={btn()} onClick={() => setForm(null)} disabled={saving}>Cancel</button>
          <button style={btn()} onClick={() => save(false)} disabled={saving}>Save draft</button>
          <button style={btn('primary')} onClick={() => save(true)} disabled={saving}>{saving ? 'Saving…' : 'Submit to manager'}</button>
        </>}>
          <ErrorBox>{formErr}</ErrorBox>
          <div style={sectionStyle}>Visit</div>
          <div style={grid2}>
            <Field label="Trip" hint="Picking it fills the customer, project and type"><LookupSelect kind="trips" forWhat="visit" value={form.travel_request_id} onChange={pickTrip} onRows={setTrips} ariaLabel="Trip" /></Field>
            <Field label="Visit type" required><VocabSelect vocab="travel-types" value={form.visit_type} onChange={v => fld('visit_type', v)} selectStyle={inputStyle} /></Field>
            <Field label="Visit date" required><input type="date" max={localDay()} value={form.visit_date} onChange={e => fld('visit_date', e.target.value)} style={inputStyle} aria-label="Visit date" /></Field>
            <Field label="Outcome"><select value={form.outcome || ''} onChange={e => fld('outcome', e.target.value)} style={inputStyle} aria-label="Outcome"><option value="">— Choose —</option>{OUTCOMES.map(o => <option key={o}>{o}</option>)}</select></Field>
            <Field label="Customer"><LookupSelect kind="customers" value={form.customer_id} onChange={v => fld('customer_id', v)} ariaLabel="Customer" /></Field>
            <Field label="Project"><LookupSelect kind="projects" value={form.project_id} onChange={v => fld('project_id', v)} ariaLabel="Project" /></Field>
            <Field label="Opportunity"><LookupSelect kind="opportunities" value={form.opportunity_id} onChange={v => fld('opportunity_id', v)} ariaLabel="Opportunity" /></Field>
            <Field label="Service ticket"><LookupSelect kind="tickets" value={form.service_ticket_id} onChange={v => fld('service_ticket_id', v)} ariaLabel="Service ticket" /></Field>
            <Field label="Site"><input value={form.site_name || ''} onChange={e => fld('site_name', e.target.value)} style={inputStyle} aria-label="Site" /></Field>
            <Field label="Location"><div style={{ display: 'flex', gap: 6 }}>
              <input value={form.location || ''} onChange={e => fld('location', e.target.value)} style={inputStyle} aria-label="Location" />
              <button type="button" title="Use my location" onClick={gps} style={{ ...btn(), padding: '0 10px' }}><Navigation size={14} /></button></div>
              {form.gps_lat && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}><MapPin size={11} /> {form.gps_lat}, {form.gps_lng}</div>}</Field>
            <Field label="Purpose" required full><input value={form.purpose} onChange={e => fld('purpose', e.target.value)} style={inputStyle} aria-label="Purpose" /></Field>
            <Field label="Discussion summary" full hint="Required to submit"><textarea rows={4} value={form.discussion_summary || ''} onChange={e => fld('discussion_summary', e.target.value)} style={{ ...inputStyle, resize: 'vertical' }} aria-label="Discussion summary" /></Field>
            <Field label="Next follow-up"><input type="date" min={form.visit_date || undefined} value={form.next_followup || ''} onChange={e => fld('next_followup', e.target.value)} style={inputStyle} aria-label="Next follow-up" /></Field>
            <Field label="Follow-up notes"><input value={form.next_followup_notes || ''} onChange={e => fld('next_followup_notes', e.target.value)} style={inputStyle} aria-label="Follow-up notes" /></Field>
          </div>
          <div style={sectionStyle}>Action items</div>
          {form.action_items.map((a, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 140px 32px', gap: 8, marginBottom: 8 }}>
              <input value={a.action} onChange={e => setItem(i, 'action', e.target.value)} placeholder="Action" style={inputStyle} aria-label={`Action ${i + 1}`} />
              <input value={a.owner || ''} onChange={e => setItem(i, 'owner', e.target.value)} placeholder="Owner" style={inputStyle} aria-label={`Owner ${i + 1}`} />
              <input type="date" value={a.due_date || ''} onChange={e => setItem(i, 'due_date', e.target.value)} style={inputStyle} aria-label={`Due ${i + 1}`} />
              <button type="button" aria-label="Remove action" onClick={() => setForm(p => ({ ...p, action_items: p.action_items.filter((_, j) => j !== i) }))} style={{ ...btn(), padding: 0 }}><Trash2 size={13} /></button>
            </div>
          ))}
          <button type="button" style={btn('small')} onClick={() => setForm(p => ({ ...p, action_items: [...p.action_items, { action: '', owner: '', due_date: '', status: 'Open' }] }))}>+ Add action</button>
        </Dialog>
      )}
    </PageShell>
  );
}
