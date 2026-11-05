/**
 * FreightSettingsPanel — freight lanes and maker-checker rate cards (§216).
 *
 * Lives in Procurement Settings → Freight, under the settings form. Lanes and
 * rate cards save through their own endpoints (/procurement/freight/*), not
 * through "Save Settings".
 *
 *   Lanes      vendor → receiving warehouse, distance in km and WHERE IT CAME
 *              FROM. "Suggest" asks for a straight-line estimate and only fills
 *              the form; the person still picks the source and saves.
 *   Rate cards rate per tonne-km by mode / service level / freight category.
 *              A new card is a draft; a DIFFERENT approver approves it. There
 *              is no edit — a changed rate is a new card with its own date.
 */
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import VocabSelect from '@/components/core/VocabSelect';

const MODES = ['road', 'rail', 'air', 'ship'];
const SERVICE_LEVELS = ['FTL', 'LTL', 'FCL', 'LCL'];
const DISTANCE_SOURCES = [
  { value: 'observed',  label: 'Observed — e-way bill / trip log' },
  { value: 'quoted',    label: 'Quoted — transporter or vendor' },
  { value: 'estimated', label: 'Estimated — e.g. straight-line' },
  { value: 'manual',    label: 'Manual entry' },
];
const STATUS = {
  draft:    { bg: '#fef3c7', fg: '#92400e', label: 'Awaiting approval' },
  approved: { bg: '#d1fae5', fg: '#065f46', label: 'Approved' },
  rejected: { bg: '#fee2e2', fg: '#991b1b', label: 'Rejected' },
  retired:  { bg: '#f3f4f6', fg: '#6b7280', label: 'Retired' },
};
const localToday = () => {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const asList = (d, ...keys) => {
  if (Array.isArray(d)) return d;
  for (const k of keys) if (Array.isArray(d?.[k])) return d[k];
  return [];
};

const box = { border: '1px solid #f0f0f4', borderRadius: 10, padding: 16, marginTop: 20, background: '#fff' };
const th = { textAlign: 'left', fontSize: 11, color: '#6b7280', fontWeight: 600, padding: '8px 10px', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap' };
const td = { fontSize: 12.5, padding: '8px 10px', borderBottom: '1px solid #f8f8fc', verticalAlign: 'top' };
const inp = { padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12.5, width: '100%', boxSizing: 'border-box' };
const btn = (kind = 'primary') => ({
  padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
  border: kind === 'primary' ? 'none' : '1px solid #e5e7eb',
  background: kind === 'primary' ? '#0d9488' : kind === 'danger' ? '#fff' : '#fff',
  color: kind === 'primary' ? '#fff' : kind === 'danger' ? '#991b1b' : '#374151',
});
const Msg = ({ m }) => m && (
  <div role={m.ok ? 'status' : 'alert'} style={{ margin: '8px 0', padding: '8px 12px', borderRadius: 6, fontSize: 12.5,
    background: m.ok ? '#f0fdf4' : '#fef2f2', color: m.ok ? '#166534' : '#991b1b' }}>{m.text}</div>
);

export default function FreightSettingsPanel({ warehouses = [], mainWarehouseId = null }) {
  const { hasPermission, user } = useAuth();
  const canEdit = hasPermission('procurement', 'edit');
  const canApprove = hasPermission('procurement', 'approve');
  const myId = user?.id ?? user?.userId ?? null;

  const [vendors, setVendors] = useState([]);
  const [lanes, setLanes] = useState([]);
  const [cards, setCards] = useState([]);
  const [cardFilter, setCardFilter] = useState('');
  const [laneForm, setLaneForm] = useState(null);
  const [suggestion, setSuggestion] = useState(null);
  const [cardForm, setCardForm] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    const [v, l, c] = await Promise.allSettled([
      api.get('/procurement/vendors'),
      api.get('/procurement/freight/lanes'),
      api.get('/procurement/freight/rate-cards', { params: cardFilter ? { status: cardFilter } : {} }),
    ]);
    if (v.status === 'fulfilled') setVendors(asList(v.value.data, 'vendors', 'suppliers', 'data'));
    setLanes(l.status === 'fulfilled' ? asList(l.value.data, 'data') : []);
    setCards(c.status === 'fulfilled' ? asList(c.value.data, 'data') : []);
    const failed = [l, c].find(r => r.status === 'rejected');
    if (failed) setMsg({ ok: false, text: failed.reason?.response?.data?.error || 'Could not load freight lanes or rate cards.' });
  }, [cardFilter]);

  useEffect(() => { load(); }, [load]);

  // ── Lanes ──
  const newLane = () => {
    setSuggestion(null);
    setLaneForm({ vendor_id: '', warehouse_id: mainWarehouseId ?? '', distance_km: '', distance_source: '',
                  default_transport_mode: 'road', default_service_level: '', distance_note: '' });
  };
  const suggest = async () => {
    setSuggestion(null);
    try {
      const r = await api.get('/procurement/freight/lanes/suggest-distance',
        { params: { vendor_id: laneForm.vendor_id, warehouse_id: laneForm.warehouse_id } });
      setSuggestion(r.data?.suggestion ? { ...r.data.suggestion } : { none: r.data?.reason || 'No suggestion available.' });
    } catch (e) {
      setSuggestion({ none: e.response?.data?.error || 'No suggestion available.' });
    }
  };
  const saveLane = async () => {
    setMsg(null);
    try {
      await api.put('/procurement/freight/lanes', {
        ...laneForm,
        default_service_level: laneForm.default_service_level || null,
      });
      setLaneForm(null); setSuggestion(null);
      setMsg({ ok: true, text: 'Lane saved.' });
      load();
    } catch (e) { setMsg({ ok: false, text: e.response?.data?.error || 'The lane could not be saved.' }); }
  };
  const removeLane = async (lane) => {
    if (!window.confirm(`Remove the lane ${lane.vendor_name} → ${lane.warehouse_name}?`)) return;
    try { await api.delete(`/procurement/freight/lanes/${lane.id}`); load(); }
    catch (e) { setMsg({ ok: false, text: e.response?.data?.error || 'The lane could not be removed.' }); }
  };

  // ── Rate cards ──
  const newCard = () => setCardForm({ transport_mode: 'road', service_level: '', freight_category: '', rate_per_tonne_km: '',
    currency: 'INR', effective_from: localToday(), source: '', notes: '' });
  const saveCard = async () => {
    setMsg(null);
    try {
      const r = await api.post('/procurement/freight/rate-cards', {
        ...cardForm, service_level: cardForm.service_level || null, freight_category: cardForm.freight_category || null,
      });
      setCardForm(null);
      setMsg({ ok: true, text: r.data?.message || 'Rate card saved as a draft.' });
      load();
    } catch (e) { setMsg({ ok: false, text: e.response?.data?.error || 'The rate card could not be saved.' }); }
  };
  const review = async (card, action) => {
    setMsg(null);
    let note;
    if (action === 'reject') {
      note = window.prompt('Why is this rate card rejected?');
      if (note == null) return;
    }
    if (action === 'retire' && !window.confirm('Retire this rate card? Comparisons stop using it; past awards keep the rate they were decided on.')) return;
    try {
      await api.post(`/procurement/freight/rate-cards/${card.id}/${action}`, note ? { note } : {});
      setMsg({ ok: true, text: `Rate card #${card.id} ${action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'retired'}.` });
      load();
    } catch (e) { setMsg({ ok: false, text: e.response?.data?.error || 'That did not go through.' }); }
  };

  return (
    <div>
      <Msg m={msg} />

      {/* ── Lanes ─────────────────────────────────────────────── */}
      <section style={box} aria-labelledby="freight-lanes-h">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 id="freight-lanes-h" style={{ margin: 0, fontSize: 14 }}>Freight lanes</h3>
          {canEdit && !laneForm && <button style={btn()} onClick={newLane}>+ Add lane</button>}
        </div>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '6px 0 10px' }}>
          Distance from each vendor to a receiving warehouse. RFQs and POs carry no receiving location, so comparisons use the lane to the main receiving point above.
        </p>

        {laneForm && (
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, marginBottom: 12, background: '#fafafa' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
              <label style={{ fontSize: 12 }}>Vendor
                <select aria-label="Lane vendor" style={inp} value={laneForm.vendor_id}
                  onChange={e => { setSuggestion(null); setLaneForm(f => ({ ...f, vendor_id: e.target.value })); }}>
                  <option value="">-- Select vendor --</option>
                  {vendors.map(v => <option key={v.id} value={v.id}>{v.vendor_name || v.name}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 12 }}>Receiving warehouse
                <select aria-label="Lane warehouse" style={inp} value={laneForm.warehouse_id}
                  onChange={e => { setSuggestion(null); setLaneForm(f => ({ ...f, warehouse_id: e.target.value })); }}>
                  <option value="">-- Select warehouse --</option>
                  {warehouses.map(w => <option key={w.id} value={w.id}>{w.warehouse_name || w.name}{Number(w.id) === Number(mainWarehouseId) ? ' (main receiving point)' : ''}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 12 }}>Distance (km)
                <input aria-label="Lane distance km" type="number" min="0" step="any" style={inp} value={laneForm.distance_km}
                  onChange={e => setLaneForm(f => ({ ...f, distance_km: e.target.value }))} />
              </label>
              <label style={{ fontSize: 12 }}>Distance source
                <select aria-label="Lane distance source" style={inp} value={laneForm.distance_source}
                  onChange={e => setLaneForm(f => ({ ...f, distance_source: e.target.value }))}>
                  <option value="">-- Where is this distance from? --</option>
                  {DISTANCE_SOURCES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 12 }}>Default mode
                <select aria-label="Lane mode" style={inp} value={laneForm.default_transport_mode}
                  onChange={e => setLaneForm(f => ({ ...f, default_transport_mode: e.target.value }))}>
                  {MODES.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 12 }}>Default service level
                <select aria-label="Lane service level" style={inp} value={laneForm.default_service_level}
                  onChange={e => setLaneForm(f => ({ ...f, default_service_level: e.target.value }))}>
                  <option value="">Any</option>
                  {SERVICE_LEVELS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
            </div>
            <label style={{ fontSize: 12, display: 'block', marginTop: 8 }}>Note
              <input aria-label="Lane note" style={inp} value={laneForm.distance_note}
                placeholder="e.g. e-way bill 3412 9876 5432, or route via NH44"
                onChange={e => setLaneForm(f => ({ ...f, distance_note: e.target.value }))} />
            </label>
            <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button style={btn('ghost')} disabled={!laneForm.vendor_id || !laneForm.warehouse_id} onClick={suggest}>
                Suggest straight-line distance
              </button>
              {suggestion && !suggestion.none && (
                <span style={{ fontSize: 12, color: '#92400e', background: '#fffbeb', padding: '4px 8px', borderRadius: 6 }}>
                  Estimate: {suggestion.distance_km} km — {suggestion.note}{' '}
                  <button style={{ ...btn('ghost'), padding: '2px 8px' }}
                    onClick={() => setLaneForm(f => ({ ...f, distance_km: String(suggestion.distance_km), distance_source: 'estimated',
                      distance_note: f.distance_note || 'Straight-line estimate, not a road distance' }))}>
                    Use as estimate
                  </button>
                </span>
              )}
              {suggestion?.none && <span style={{ fontSize: 12, color: '#6b7280' }}>{suggestion.none}</span>}
              <span style={{ flex: 1 }} />
              <button style={btn('ghost')} onClick={() => { setLaneForm(null); setSuggestion(null); }}>Cancel</button>
              <button style={btn()} onClick={saveLane}
                disabled={!laneForm.vendor_id || !laneForm.warehouse_id || !laneForm.distance_km || !laneForm.distance_source}>
                Confirm &amp; save lane
              </button>
            </div>
          </div>
        )}

        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['Vendor', 'Receiving warehouse', 'Distance', 'Source', 'Mode', 'Confirmed by', ''].map(h => <th key={h || 'a'} style={th}>{h}</th>)}</tr></thead>
          <tbody>
            {lanes.length === 0 ? (
              <tr><td colSpan={7} style={{ ...td, color: '#9ca3af', textAlign: 'center' }}>No lanes yet. Without one, a vendor's freight cannot be modelled.</td></tr>
            ) : lanes.map(l => (
              <tr key={l.id}>
                <td style={td}>{l.vendor_name}</td>
                <td style={td}>{l.warehouse_name}</td>
                <td style={td}>{Number(l.distance_km).toLocaleString('en-IN')} km</td>
                <td style={td}>{DISTANCE_SOURCES.find(s => s.value === l.distance_source)?.label || l.distance_source}
                  {l.distance_note && <div style={{ fontSize: 11, color: '#9ca3af' }}>{l.distance_note}</div>}</td>
                <td style={td}>{l.default_transport_mode || '—'}{l.default_service_level ? ` · ${l.default_service_level}` : ''}</td>
                <td style={td}>{l.confirmed_by_name || `User #${l.confirmed_by_user_id}`}</td>
                <td style={td}>{canEdit && (
                  <>
                    <button style={{ ...btn('ghost'), padding: '3px 8px', marginRight: 4 }}
                      onClick={() => { setSuggestion(null); setLaneForm({ vendor_id: l.vendor_id, warehouse_id: l.warehouse_id, distance_km: l.distance_km,
                        distance_source: l.distance_source, default_transport_mode: l.default_transport_mode || 'road',
                        default_service_level: l.default_service_level || '', distance_note: l.distance_note || '' }); }}>Edit</button>
                    <button style={{ ...btn('danger'), padding: '3px 8px' }} onClick={() => removeLane(l)}>Remove</button>
                  </>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* ── Rate cards ────────────────────────────────────────── */}
      <section style={box} aria-labelledby="freight-cards-h">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 id="freight-cards-h" style={{ margin: 0, fontSize: 14 }}>Freight rate cards (per tonne-km)</h3>
          {canEdit && !cardForm && <button style={btn()} onClick={newCard}>+ New rate card</button>}
        </div>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '6px 0 10px' }}>
          Freight = weight (kg) / 1000 × distance (km) × rate. A new card is a draft until a different approver approves it. Approved rates are never edited — enter a new card with a later effective date.
          Foreign-currency rates are converted with approved Finance exchange rates.
        </p>

        {cardForm && (
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, marginBottom: 12, background: '#fafafa' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
              <label style={{ fontSize: 12 }}>Mode
                <select aria-label="Card mode" style={inp} value={cardForm.transport_mode} onChange={e => setCardForm(f => ({ ...f, transport_mode: e.target.value }))}>
                  {MODES.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 12 }}>Service level
                <select aria-label="Card service level" style={inp} value={cardForm.service_level} onChange={e => setCardForm(f => ({ ...f, service_level: e.target.value }))}>
                  <option value="">Any</option>
                  {SERVICE_LEVELS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 12 }}>Freight category
                <VocabSelect vocab="freight-categories" allowAdd={false} value={cardForm.freight_category}
                  onChange={v => setCardForm(f => ({ ...f, freight_category: v || '' }))} />
              </label>
              <label style={{ fontSize: 12 }}>Rate per tonne-km
                <input aria-label="Card rate" type="number" min="0" step="any" style={inp} value={cardForm.rate_per_tonne_km}
                  onChange={e => setCardForm(f => ({ ...f, rate_per_tonne_km: e.target.value }))} />
              </label>
              <label style={{ fontSize: 12 }}>Currency
                <input aria-label="Card currency" maxLength={3} style={inp} value={cardForm.currency}
                  onChange={e => setCardForm(f => ({ ...f, currency: e.target.value.toUpperCase() }))} />
              </label>
              <label style={{ fontSize: 12 }}>Effective from
                <input aria-label="Card effective from" type="date" style={inp} value={cardForm.effective_from}
                  onChange={e => setCardForm(f => ({ ...f, effective_from: e.target.value }))} />
              </label>
              <label style={{ fontSize: 12, gridColumn: 'span 2' }}>Source
                <input aria-label="Card source" style={inp} value={cardForm.source} placeholder="e.g. Transporter contract TC-2026-04"
                  onChange={e => setCardForm(f => ({ ...f, source: e.target.value }))} />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
              <button style={btn('ghost')} onClick={() => setCardForm(null)}>Cancel</button>
              <button style={btn()} onClick={saveCard} disabled={!cardForm.rate_per_tonne_km || !cardForm.effective_from}>Save as draft</button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          {[['', 'All'], ['draft', 'Awaiting approval'], ['approved', 'Approved'], ['retired', 'Retired'], ['rejected', 'Rejected']].map(([s, label]) => (
            <button key={label} onClick={() => setCardFilter(s)} aria-pressed={cardFilter === s}
              style={{ ...btn(cardFilter === s ? 'primary' : 'ghost'), padding: '4px 10px' }}>{label}</button>
          ))}
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['Mode', 'Service', 'Category', 'Rate / tonne-km', 'Effective from', 'Source', 'Status', 'Entered by', 'Reviewed by', ''].map(h => <th key={h || 'a'} style={th}>{h}</th>)}</tr></thead>
          <tbody>
            {cards.length === 0 ? (
              <tr><td colSpan={10} style={{ ...td, color: '#9ca3af', textAlign: 'center' }}>No rate cards in this list.</td></tr>
            ) : cards.map(c => {
              const st = STATUS[c.status] || STATUS.draft;
              const mine = myId != null && Number(c.entered_by_user_id) === Number(myId);
              return (
                <tr key={c.id}>
                  <td style={td}>{c.transport_mode}</td>
                  <td style={td}>{c.service_level || 'Any'}</td>
                  <td style={td}>{c.freight_category || 'All categories'}</td>
                  <td style={{ ...td, fontWeight: 600 }}>{c.currency} {Number(c.rate_per_tonne_km).toLocaleString('en-IN', { maximumFractionDigits: 6 })}</td>
                  <td style={td}>{c.effective_from}</td>
                  <td style={td}>{c.source || '—'}</td>
                  <td style={td}><span title={c.review_note || undefined}
                    style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: st.bg, color: st.fg }}>{st.label}</span></td>
                  <td style={td}>{c.entered_by_name || `User #${c.entered_by_user_id}`}</td>
                  <td style={td}>{c.approved_by_name || (c.approved_by_user_id ? `User #${c.approved_by_user_id}` : '—')}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    {canApprove && c.status === 'draft' && (mine
                      ? <span style={{ fontSize: 11, color: '#9ca3af' }}>You created this — another approver must review it</span>
                      : (<>
                          <button style={{ ...btn(), padding: '3px 8px', marginRight: 4 }} onClick={() => review(c, 'approve')}>Approve</button>
                          <button style={{ ...btn('danger'), padding: '3px 8px' }} onClick={() => review(c, 'reject')}>Reject</button>
                        </>))}
                    {canApprove && c.status === 'approved' && (
                      <button style={{ ...btn('ghost'), padding: '3px 8px' }} onClick={() => review(c, 'retire')}>Retire</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
