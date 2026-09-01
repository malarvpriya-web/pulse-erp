/**
 * RFx Evaluation — scoring bids and selecting a preferred vendor (§136, 1.7.5).
 *
 * The RFQ screen raises an event and collects quotes. This one evaluates it:
 * a weighted scorecard per RFx type (RFI qualifies, RFP compares approaches,
 * RFQ prices a defined spec), with cost and delivery benchmarked across the
 * field and the vendor-record criteria taken from the §49G health engine.
 *
 * TWO THINGS THIS PAGE REFUSES TO DO, both deliberate:
 *
 *   It does not show a blank criterion as a zero. An unscored criterion is
 *   drawn as outstanding, and the bid's coverage figure says how much of the
 *   model is actually filled in. A vendor nobody has assessed yet must not look
 *   like a vendor who was assessed and failed.
 *
 *   It does not offer a one-click "select" when the engine will not recommend.
 *   Where the leader's margin sits inside the uncertainty created by unscored
 *   criteria, the button asks for an explicit override and the reason is shown
 *   next to it. A scorecard that always produces a winner is a machine for
 *   turning a coin flip into a decision with a number attached.
 */
import { useState, useEffect, useCallback } from 'react';
import { ClipboardCheck, RefreshCw } from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell, StatBand, Stat } from '@/components/pulse-ui';
import './RfxEvaluation.css';

const TYPE_TONE = {
  RFI: { color: '#0D9488', label: 'RFI' },
  RFP: { color: '#C2660A', label: 'RFP' },
  RFQ: { color: '#6B3FDB', label: 'RFQ' },
};

const BASIS_LABEL = {
  benchmarked: 'Benchmarked across the bids',
  observed:    'From our own record of this vendor',
  assessed:    'Assessed by a person',
  unscored:    'Not scored yet',
};

const DECISION_TONE = {
  recommended:           { cls: 'ok',   title: 'Clear leader' },
  too_close_to_call:     { cls: 'warn', title: 'Too close to call' },
  insufficient_evidence: { cls: 'warn', title: 'Not enough of the model is scored' },
  insufficient_bids:     { cls: 'warn', title: 'Not a comparison yet' },
};

const n = (v) => (v == null || v === '' ? null : Number(v));
const fmtNum = (v, d = 1) => (n(v) == null ? '—' : n(v).toFixed(d));

function fmtINR(v) {
  const x = n(v);
  if (x == null) return '—';
  const a = Math.abs(x);
  const s = x < 0 ? '-' : '';
  if (a >= 10000000) return `${s}₹${(a / 10000000).toFixed(2)} Cr`;
  if (a >= 100000)   return `${s}₹${(a / 100000).toFixed(2)} L`;
  return `${s}₹${a.toLocaleString('en-IN')}`;
}

/** A bid's score column, one cell per criterion. */
function ScoreCell({ line, onEdit }) {
  if (line.score == null) {
    return (
      <td className="rfx-cell rfx-cell--unscored">
        <button type="button" className="rfx-score-btn is-empty" onClick={onEdit} title={BASIS_LABEL.unscored}>
          Score
        </button>
      </td>
    );
  }
  return (
    <td className="rfx-cell">
      <button type="button" className={`rfx-score-btn is-${line.basis}`} onClick={onEdit} title={`${BASIS_LABEL[line.basis]}${line.note ? ` — ${line.note}` : ''}`}>
        <span className="rfx-score-val">{fmtNum(line.score, 0)}</span>
        <span className="rfx-score-basis">{line.basis === 'assessed' ? 'assessed' : line.basis === 'observed' ? 'observed' : 'bench'}</span>
      </button>
    </td>
  );
}

function ScoreEditor({ open, criterion, bid, onClose, onSave }) {
  const existing = bid?.lines?.find((l) => l.key === criterion?.key);
  const [score, setScore] = useState(existing?.score ?? '');
  const [note, setNote] = useState(existing?.note ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    setScore(existing?.score ?? '');
    setNote(existing?.basis === 'assessed' ? (existing?.note ?? '') : '');
    setErr(null);
  }, [criterion?.key, bid?.vendor_id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      await onSave({ criterion_key: criterion.key, score: Number(score), note: note || null });
      onClose();
    } catch (e2) {
      setErr(e2?.response?.data?.error || e2.message || 'Could not save the score');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rfx-modal-back" onClick={onClose}>
      <form className="rfx-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>{criterion.label}</h3>
        <p className="rfx-modal-sub">{bid.vendor_name} · weight {criterion.weight}%</p>
        {criterion.help && <p className="rfx-modal-help">{criterion.help}</p>}

        {existing && existing.basis !== 'assessed' && existing.score != null && (
          <p className="rfx-note">
            Currently {fmtNum(existing.score, 0)} — {BASIS_LABEL[existing.basis].toLowerCase()}
            {existing.note ? ` (${existing.note})` : ''}. Saving a score here replaces it with your assessment.
          </p>
        )}

        <label className="rfx-field">
          <span>Score (0–100)</span>
          <input type="number" min="0" max="100" step="1" value={score}
                 onChange={(e) => setScore(e.target.value)} required autoFocus />
        </label>
        <label className="rfx-field">
          <span>Note</span>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)}
                    placeholder="What did you see that supports this score?" />
        </label>

        {err && <p className="rfx-note rfx-note--error">{err}</p>}

        <div className="rfx-modal-actions">
          <button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="pulse-btn-primary" disabled={saving || score === ''}>
            {saving ? 'Saving…' : 'Save score'}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Raise a new RFI, RFP or RFQ.
 *
 * The three stages have always shared one table; until now only the RFQ stage
 * could be created, so qualification (RFI) and proposal (RFP) happened in email
 * and never reached a scorecard. The type is chosen first because it decides
 * which weighted model the event will be scored against, and the model's
 * criteria are shown as soon as it is picked — a buyer should know what the
 * event will be judged on before they send it, not after the bids arrive.
 */
function CreateDialog({ open, models, categories, onClose, onCreated }) {
  const [rfxType, setRfxType] = useState('RFQ');
  const [objective, setObjective] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [requiredBy, setRequiredBy] = useState('');
  const [items, setItems] = useState([{ item_id: null, item_name: '', quantity: 1, unit: 'Nos' }]);
  const [vendorIds, setVendorIds] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [itemQuery, setItemQuery] = useState('');
  const [itemHits, setItemHits] = useState([]);
  const [activeRow, setActiveRow] = useState(0);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!open) return;
    api.get('/vendors', { params: { status: 'active' } })
      .then((r) => setVendors(Array.isArray(r.data) ? r.data : (r.data?.vendors || [])))
      .catch(() => setVendors([]));
  }, [open]);

  useEffect(() => {
    if (!open || !itemQuery.trim()) { setItemHits([]); return; }
    const t = setTimeout(() => {
      api.get('/procurement/price-history/items', { params: { q: itemQuery } })
        .then((r) => setItemHits(Array.isArray(r.data) ? r.data.slice(0, 8) : []))
        .catch(() => setItemHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [itemQuery, open]);

  if (!open) return null;

  const model = models?.[rfxType];

  const setRow = (i, patch) => setItems((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setItems((rows) => [...rows, { item_id: null, item_name: '', quantity: 1, unit: 'Nos' }]);
  const dropRow = (i) => setItems((rows) => (rows.length === 1 ? rows : rows.filter((_, j) => j !== i)));

  const pickItem = (i, hit) => {
    setRow(i, { item_id: hit.id, item_name: hit.item_name, unit: hit.uom || 'Nos' });
    setItemQuery('');
    setItemHits([]);
  };

  const toggleVendor = (id) =>
    setVendorIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const valid = items.every((r) => r.item_name.trim() && Number(r.quantity) > 0);

  const submit = async (e) => {
    e.preventDefault();
    if (!valid) return;
    setSaving(true);
    setErr(null);
    try {
      await onCreated({
        rfx_type: rfxType,
        objective: objective || null,
        category_id: categoryId ? Number(categoryId) : null,
        required_by: requiredBy || null,
        items: items.map((r) => ({
          item_id: r.item_id, item_name: r.item_name,
          quantity: Number(r.quantity), unit: r.unit || 'Nos',
        })),
        vendor_ids: vendorIds,
      });
      onClose();
    } catch (e2) {
      setErr(e2?.response?.data?.error || e2.message || 'Could not create the event');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rfx-modal-back" onClick={onClose}>
      <form className="rfx-modal rfx-modal--wide" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>New RFx event</h3>
        <p className="rfx-modal-sub">The type decides which weighted model scores the responses.</p>

        <div className="rfx-type-picker">
          {['RFI', 'RFP', 'RFQ'].map((t) => (
            <button key={t} type="button"
                    className={`rfx-type-opt${rfxType === t ? ' is-sel' : ''}`}
                    style={rfxType === t ? { borderColor: TYPE_TONE[t].color, color: TYPE_TONE[t].color } : undefined}
                    onClick={() => setRfxType(t)}>
              <b>{t}</b>
              <span>{models?.[t]?.label || ''}</span>
            </button>
          ))}
        </div>

        {model && (
          <p className="rfx-modal-help">
            <b>{model.purpose}</b><br />
            Scored on: {model.criteria.map((c) => `${c.label} ${c.weight}%`).join(' · ')}
          </p>
        )}

        <div className="rfx-form-grid">
          <label className="rfx-field">
            <span>Sourcing category</span>
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Not linked</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="rfx-field">
            <span>Required by</span>
            <input type="date" value={requiredBy} onChange={(e) => setRequiredBy(e.target.value)} />
          </label>
        </div>

        <label className="rfx-field">
          <span>Objective</span>
          <textarea rows={2} value={objective} onChange={(e) => setObjective(e.target.value)}
                    placeholder="What this event is meant to settle." />
        </label>

        <div className="rfx-sub">Items</div>
        {items.map((row, i) => (
          <div className="rfx-item-row" key={i}>
            <div className="rfx-item-search">
              <input
                value={activeRow === i && itemQuery ? itemQuery : row.item_name}
                onChange={(e) => { setActiveRow(i); setItemQuery(e.target.value); setRow(i, { item_name: e.target.value, item_id: null }); }}
                placeholder="Search or type an item" required
              />
              {activeRow === i && itemHits.length > 0 && (
                <ul className="rfx-item-drop">
                  {itemHits.map((h) => (
                    <li key={h.id}>
                      <button type="button" onClick={() => pickItem(i, h)}>
                        {h.item_name} <em>{h.item_code}</em>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <input className="rfx-qty" type="number" min="0.01" step="0.01" value={row.quantity}
                   onChange={(e) => setRow(i, { quantity: e.target.value })} required />
            <input className="rfx-unit" value={row.unit}
                   onChange={(e) => setRow(i, { unit: e.target.value })} />
            <button type="button" className="rfx-row-x" onClick={() => dropRow(i)}
                    disabled={items.length === 1} aria-label="Remove item">×</button>
          </div>
        ))}
        <button type="button" className="rfx-add-row" onClick={addRow}>+ Add item</button>

        <p className="rfx-note">
          Linking a row to an item from the catalogue is what lets the scorecard cost it on
          total cost of ownership and write the preferred vendor back to the approved list.
          A free-typed item still works, but the event stays commercial-only.
        </p>

        <div className="rfx-sub">Invite vendors <em>{vendorIds.length} selected</em></div>
        <div className="rfx-vendor-pick">
          {vendors.length === 0 && <span className="rfx-muted">No active vendors found.</span>}
          {vendors.map((v) => (
            <button key={v.id} type="button"
                    className={`rfx-vendor-chip${vendorIds.includes(v.id) ? ' is-sel' : ''}`}
                    onClick={() => toggleVendor(v.id)}>
              {v.vendor_name}
              {!v.email && <em title="No email on file — they will not be notified"> no email</em>}
            </button>
          ))}
        </div>
        {vendorIds.length > 0 && (
          <p className="rfx-note rfx-note--warn">
            Creating this event will email the {vendorIds.length} selected vendor(s) who have an
            address on file. Leave the selection empty to raise it as a draft and invite later.
          </p>
        )}

        {err && <p className="rfx-note rfx-note--error">{err}</p>}

        <div className="rfx-modal-actions">
          <button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="pulse-btn-primary" disabled={saving || !valid}>
            {saving ? 'Creating…' : vendorIds.length ? `Create and invite ${vendorIds.length}` : 'Create as draft'}
          </button>
        </div>
      </form>
    </div>
  );
}

function SelectDialog({ open, bid, ranking, onClose, onConfirm }) {
  const [rationale, setRationale] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  if (!open || !bid) return null;

  const needsOverride = ranking.decision !== 'recommended';
  const notRecommended = ranking.recommended_vendor_id != null
    && String(ranking.recommended_vendor_id) !== String(bid.vendor_id);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      await onConfirm({ vendor_id: bid.vendor_id, rationale, acknowledge_override: needsOverride });
      onClose();
    } catch (e2) {
      setErr(e2?.response?.data?.error || e2.message || 'Could not record the selection');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rfx-modal-back" onClick={onClose}>
      <form className="rfx-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Make {bid.vendor_name} the preferred vendor</h3>
        <p className="rfx-modal-sub">
          Scored {fmtNum(bid.total, 0)} on {fmtNum(bid.coverage_pct, 0)}% of the model
        </p>

        <p className="rfx-note">
          This approves them on the vendor list for every item in the event, marks their price
          preferred, and sets them as the default source for reordering. Other vendors stay
          approved — they only lose preferred standing.
        </p>

        {needsOverride && (
          <p className="rfx-note rfx-note--warn">
            <b>{DECISION_TONE[ranking.decision]?.title}.</b> {ranking.reason} Recording the
            selection anyway will be stored as a deliberate override.
          </p>
        )}
        {!needsOverride && notRecommended && (
          <p className="rfx-note rfx-note--warn">
            The scorecard puts a different vendor first. That can be the right call — say why below.
          </p>
        )}

        <label className="rfx-field">
          <span>Rationale</span>
          <textarea rows={3} value={rationale} onChange={(e) => setRationale(e.target.value)}
                    placeholder="Why this vendor — the reason is stored with the frozen scorecard." />
        </label>

        {err && <p className="rfx-note rfx-note--error">{err}</p>}

        <div className="rfx-modal-actions">
          <button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="pulse-btn-primary" disabled={saving}>
            {saving ? 'Recording…' : needsOverride ? 'Override and select' : 'Select as preferred'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function RfxEvaluation() {
  const [events, setEvents] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [card, setCard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [cardLoading, setCardLoading] = useState(false);
  const [error, setError] = useState(null);
  const [typeFilter, setTypeFilter] = useState('');
  const [editing, setEditing] = useState(null);   // { criterion, bid }
  const [selecting, setSelecting] = useState(null);
  const [creating, setCreating] = useState(false);
  const [models, setModels] = useState(null);
  const [categories, setCategories] = useState([]);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get('/rfx/events', { params: typeFilter ? { type: typeFilter } : {} });
      setEvents(data);
      setSelectedId((prev) => (prev && data.some((e) => e.id === prev) ? prev : data[0]?.id ?? null));
    } catch (e) {
      // axios cancels are CanceledError / ERR_CANCELED — never AbortError.
      if (e.code === 'ERR_CANCELED' || e.name === 'CanceledError') return;
      setError(e?.response?.data?.error || e.message || 'Could not load RFx events');
    } finally {
      setLoading(false);
    }
  }, [typeFilter]);

  const loadCard = useCallback(async (id) => {
    if (!id) { setCard(null); return; }
    setCardLoading(true);
    try {
      const { data } = await api.get(`/rfx/${id}/scorecard`);
      setCard(data);
    } catch (e) {
      if (e.code === 'ERR_CANCELED' || e.name === 'CanceledError') return;
      setCard(null);
      setError(e?.response?.data?.error || e.message || 'Could not load the scorecard');
    } finally {
      setCardLoading(false);
    }
  }, []);

  useEffect(() => { loadEvents(); }, [loadEvents]);
  useEffect(() => { loadCard(selectedId); }, [selectedId, loadCard]);

  // The scoring models and the category list are static for the session — one
  // fetch each, not one per open of the create dialog.
  useEffect(() => {
    api.get('/rfx/models').then((r) => setModels(r.data?.models || null)).catch(() => setModels(null));
    api.get('/sourcing-strategy/categories')
      .then((r) => setCategories(Array.isArray(r.data) ? r.data : []))
      .catch(() => setCategories([]));
  }, []);

  /**
   * Create the event, then invite the chosen vendors.
   *
   * Two calls because they are two different commitments: the event is ours,
   * the invitation goes out to other companies. If the invite fails the event
   * still exists as a draft and can be sent again, which is the right way round
   * — the reverse would lose the buyer's work to a mail server.
   */
  const createEvent = async (payload) => {
    const { vendor_ids, ...event } = payload;
    const { data: created } = await api.post('/procurement/rfqs', { ...event, vendor_ids });
    if (vendor_ids?.length) {
      await api.post(`/procurement/rfqs/${created.id}/send-to-vendors`, { vendor_ids });
    }
    await loadEvents();
    setSelectedId(created.id);
  };

  const saveScore = async ({ criterion_key, score, note }) => {
    await api.post(`/rfx/${selectedId}/vendors/${editing.bid.vendor_id}/scores`, {
      scores: [{ criterion_key, score, note }],
    });
    await loadCard(selectedId);
  };

  const confirmSelection = async (payload) => {
    await api.post(`/rfx/${selectedId}/preferred-vendor`, payload);
    await Promise.all([loadCard(selectedId), loadEvents()]);
  };

  const ranking = card?.ranking;
  const model = card?.model;
  const bids = ranking?.bids || [];
  const decision = ranking ? DECISION_TONE[ranking.decision] : null;

  return (
    <PageShell
      className="rfx-evaluation"
      dock={
        <PageHero
          icon={ClipboardCheck}
          eyebrow="Procurement · Strategic Sourcing"
          title="RFx Evaluation"
          subtitle="Score RFIs, RFPs and RFQs against a weighted model, then record the preferred vendor"
          meta={[
            { label: 'events', value: events.length },
            { label: 'awaiting evaluation', value: events.filter((e) => !e.selected_vendor).length },
          ]}
          actions={
            <div className="rfx-hero-actions">
              <select className="rfx-window" value={typeFilter}
                      onChange={(e) => setTypeFilter(e.target.value)} aria-label="RFx type">
                <option value="">All types</option>
                <option value="RFI">RFI only</option>
                <option value="RFP">RFP only</option>
                <option value="RFQ">RFQ only</option>
              </select>
              <button type="button" className="plh-cta" onClick={() => setCreating(true)}>
                + New RFx
              </button>
              <button type="button" className="plh-cta" onClick={() => { loadEvents(); loadCard(selectedId); }} disabled={loading}>
                <RefreshCw size={14} /> Refresh
              </button>
            </div>
          }
        />
      }
    >
      {error && <div className="rfx-error">{error}</div>}

      <div className="rfx-layout">
        <aside className="rfx-list">
          <header className="rfx-card-head"><h2>Events</h2></header>
          {loading ? (
            <p className="rfx-empty">Loading…</p>
          ) : events.length === 0 ? (
            <p className="rfx-empty">
              No RFx events yet. Use <b>+ New RFx</b> to raise an RFI, RFP or RFQ and invite vendors to it.
            </p>
          ) : (
            <ul>
              {events.map((e) => {
                const tone = TYPE_TONE[e.rfx_type] || TYPE_TONE.RFQ;
                return (
                  <li key={e.id}>
                    <button type="button" className={`rfx-evt${selectedId === e.id ? ' is-sel' : ''}`}
                            onClick={() => setSelectedId(e.id)}>
                      <span className="rfx-evt-top">
                        <span className="rfx-type" style={{ background: `${tone.color}18`, color: tone.color }}>
                          {tone.label}
                        </span>
                        <span className="rfx-evt-num">{e.rfq_number}</span>
                      </span>
                      <span className="rfx-evt-desc">{e.item_description || 'No description'}</span>
                      <span className="rfx-evt-meta">
                        {e.responded} of {e.invited} responded
                        {e.selected_vendor && <em> · {e.selected_vendor} preferred</em>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <section className="rfx-main">
          {cardLoading && <p className="rfx-empty">Loading scorecard…</p>}

          {!cardLoading && card && (
            <>
              <StatBand cols={4}>
                <Stat label="Event" value={card.event.rfq_number}
                      sub={card.event.rfx_label} tone="primary" index={0} />
                <Stat label="Responded" value={`${card.basis.responded} of ${card.basis.invited}`}
                      sub="vendors invited to bid" tone="info" index={1} />
                <Stat label="Leader" value={ranking.leader?.vendor_name || '—'}
                      sub={ranking.leader ? `${fmtNum(ranking.leader.total, 0)} points` : 'nothing scored yet'}
                      tone="success" index={2} />
                <Stat label="Verdict" value={decision?.title || '—'}
                      sub={ranking.gap != null ? `${fmtNum(ranking.gap, 0)}-point gap, ±${fmtNum(ranking.uncertainty_band, 0)} unscored` : 'no comparison yet'}
                      tone={ranking.decision === 'recommended' ? 'success' : 'warning'}
                      warn={ranking.decision !== 'recommended'} index={3} />
              </StatBand>

              <p className="rfx-basis">
                {card.basis.cost_basis_key === 'not_scored' ? (
                  <><b>{card.basis.cost_basis}.</b> </>
                ) : (
                  <>Cost is scored on <b>{card.basis.cost_basis}</b> over a compared quantity of{' '}
                  {card.basis.compared_quantity}. </>
                )}
                {card.basis.health_note}
              </p>

              {ranking.reason && (
                <p className={`rfx-note rfx-note--${decision?.cls || 'warn'}`}>
                  <b>{decision?.title}.</b> {ranking.reason}
                </p>
              )}

              <div className="rfx-card">
                <header className="rfx-card-head">
                  <h2>{model.label} scorecard</h2>
                  <span className="rfx-card-sub">
                    {model.purpose}
                    {model.renormalised && ' · weights renormalised to 100'}
                  </span>
                </header>

                <div className="rfx-table-wrap">
                  <table className="rfx-table">
                    <thead>
                      <tr>
                        <th className="rfx-crit-col">Criterion</th>
                        <th className="num">Wt</th>
                        {bids.map((b) => (
                          <th key={b.vendor_id} className="rfx-vendor-col">
                            <span className="rfx-vendor-name">{b.vendor_name}</span>
                            <span className="rfx-vendor-sub">
                              {b.responded ? fmtINR(b.unit_price) + '/unit' : 'no response'}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {model.criteria.map((c) => (
                        <tr key={c.key}>
                          <td className="rfx-crit">
                            <span className="rfx-crit-label">{c.label}</span>
                            <span className="rfx-crit-help">{c.help}</span>
                          </td>
                          <td className="num">{c.weight}</td>
                          {bids.map((b) => {
                            const line = b.lines.find((l) => l.key === c.key) || { key: c.key, score: null, basis: 'unscored' };
                            return (
                              <ScoreCell key={b.vendor_id} line={line}
                                         onEdit={() => setEditing({ criterion: c, bid: b })} />
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="rfx-total-row">
                        <td colSpan={2}>Weighted total</td>
                        {bids.map((b) => (
                          <td key={b.vendor_id} className="rfx-cell">
                            <span className="rfx-total">{b.total == null ? '—' : fmtNum(b.total, 0)}</span>
                            {b.rank === 1 && b.total != null && <span className="rfx-rank">leader</span>}
                          </td>
                        ))}
                      </tr>
                      <tr className="rfx-cov-row">
                        <td colSpan={2}>Model completed</td>
                        {bids.map((b) => (
                          <td key={b.vendor_id} className="rfx-cell">
                            <span className={n(b.coverage_pct) < 60 ? 'rfx-cov is-thin' : 'rfx-cov'}>
                              {fmtNum(b.coverage_pct, 0)}%
                            </span>
                          </td>
                        ))}
                      </tr>
                      <tr className="rfx-act-row">
                        <td colSpan={2} />
                        {bids.map((b) => (
                          <td key={b.vendor_id} className="rfx-cell">
                            <button type="button" className="rfx-select-btn"
                                    disabled={!b.responded}
                                    onClick={() => setSelecting(b)}>
                              Select
                            </button>
                          </td>
                        ))}
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>

              {card.selections?.length > 0 && (
                <div className="rfx-card">
                  <header className="rfx-card-head"><h2>Selection history</h2></header>
                  <ul className="rfx-history">
                    {card.selections.map((s) => (
                      <li key={s.id}>
                        <b>{s.vendor_name}</b> selected by {s.selected_by_name || 'unknown'}
                        {' · '}scored {fmtNum(s.total_score, 0)} on {fmtNum(s.coverage_pct, 0)}% of the model
                        {s.followed_recommendation === false && <em className="rfx-override"> · against the scorecard</em>}
                        {s.engine_recommendation !== 'recommended' && (
                          <em className="rfx-override"> · overridden ({s.engine_recommendation.replace(/_/g, ' ')})</em>
                        )}
                        {s.rationale && <span className="rfx-history-why">“{s.rationale}”</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {!cardLoading && !card && !loading && (
            <p className="rfx-empty">Select an event to score it.</p>
          )}
        </section>
      </div>

      <ScoreEditor
        open={!!editing} criterion={editing?.criterion} bid={editing?.bid}
        onClose={() => setEditing(null)} onSave={saveScore}
      />
      <SelectDialog
        open={!!selecting} bid={selecting} ranking={ranking || {}}
        onClose={() => setSelecting(null)} onConfirm={confirmSelection}
      />
      <CreateDialog
        open={creating} models={models} categories={categories}
        onClose={() => setCreating(false)} onCreated={createEvent}
      />
    </PageShell>
  );
}
