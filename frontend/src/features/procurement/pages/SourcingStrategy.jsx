/**
 * Sourcing Strategy — the category board (§136, spec 1.7.4).
 *
 * Answers the question that sits one level above every RFQ in this app: how
 * should we be buying this category at all? Two published frameworks, both fed
 * from live purchase history rather than a workshop:
 *
 *   PORTER'S FIVE FORCES  — the structure of the supply market, 1-5, with the
 *                           driver behind every score visible on the card.
 *   PURCHASING CHESSBOARD — demand power against supply power, into one of four
 *                           quadrants carrying 64 methods between them.
 *
 * THE PAGE'S ONE RULE: never draw a category as positioned when it is not.
 * A category with no measurable forces is NOT plotted at the origin, and it is
 * not plotted at the centre either — it is listed separately under "not enough
 * evidence to place", with what is missing. A 2x2 that silently parks unmeasured
 * categories in a corner is how a sourcing review ends up arguing about an
 * artefact of the plotting code.
 *
 * Quadrant colours were validated for colour-vision deficiency (OKLab ΔE, all
 * six checks pass against the light surface); position in the plot is the
 * primary encoding and the quadrant labels are drawn in the corners, so colour
 * is redundant rather than load-bearing.
 */
import { useState, useEffect, useCallback } from 'react';
import { Compass, RefreshCw } from 'lucide-react';
import {
  ScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid,
  ReferenceLine, ReferenceArea, ResponsiveContainer, Tooltip as RTooltip,
} from 'recharts';
import api from '@/services/api/client';
import { PageHero, PageShell, StatBand, Stat } from '@/components/pulse-ui';
import './SourcingStrategy.css';

// Validated categorical palette — see the file header. Purple is the brand
// token; the other three are stepped away from it far enough to survive deutan
// and tritan simulation.
const QUADRANT_COLOR = {
  manage_spend:            '#0D9488',
  leverage_competition:    '#6B3FDB',
  seek_joint_advantage:    '#C2660A',
  change_nature_of_demand: '#BE185D',
};
// Not a fifth category — an absence. Neutral ink, hollow marker.
const UNPLACED_COLOR = '#94a3b8';

const QUADRANT_SHORT = {
  manage_spend:            'Manage Spend',
  leverage_competition:    'Leverage Competition',
  seek_joint_advantage:    'Seek Joint Advantage',
  change_nature_of_demand: 'Change Nature of Demand',
};

const BASIS_LABEL = {
  observed:  'measured from our own history',
  estimated: 'modelled from master data',
  assumed:   'company default applied',
  unrated:   'nothing to measure',
};

const FORCE_LABEL = {
  supplier_power:   'Supplier Power',
  buyer_power_ours: 'Buyer Power (ours)',
  rivalry:          'Competitive Rivalry',
  new_entrants:     'Threat of New Entrants',
  substitutes:      'Threat of Substitutes',
};

// pg sends NUMERIC as a string; `Number(null)` is 0 and would print ₹0 for
// "never measured", so every formatter below guards on null first.
const n = (v) => (v == null || v === '' ? null : Number(v));

function fmtINR(v) {
  const x = n(v);
  if (x == null) return '—';
  const neg = x < 0 ? '-' : '';
  const a = Math.abs(x);
  if (a >= 10000000) return `${neg}₹${(a / 10000000).toFixed(2)} Cr`;
  if (a >= 100000)   return `${neg}₹${(a / 100000).toFixed(2)} L`;
  return `${neg}₹${a.toLocaleString('en-IN')}`;
}

const fmtPct = (v, d = 1) => (n(v) == null ? '—' : `${n(v).toFixed(d)}%`);
const fmtNum = (v, d = 1) => (n(v) == null ? '—' : n(v).toFixed(d));

function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

// ── The 2x2 ───────────────────────────────────────────────────────────────────

function ChessboardPlot({ categories, selectedKey, onSelect }) {
  const placed = categories.filter((c) => c.position?.quadrant_key);

  // Spend sizes the marker, so the eye goes to the money. A category with no
  // spend still plots — at the floor size, not invisibly.
  const maxSpend = Math.max(1, ...placed.map((c) => n(c.facts.spend_12m) || 0));

  const points = placed.map((c) => ({
    x: c.position.demand_power,
    y: c.position.supply_power,
    z: Math.max(60, ((n(c.facts.spend_12m) || 0) / maxSpend) * 520),
    key: c.category_key,
    name: c.category_name,
    quadrant: c.position.quadrant,
    quadrant_key: c.position.quadrant_key,
    provisional: c.position.provisional,
    coverage: c.coverage_pct,
    spend: c.facts.spend_12m,
  }));

  const CustomDot = (props) => {
    const { cx, cy, payload } = props;
    if (cx == null || cy == null) return null;
    const r = Math.max(7, Math.sqrt(payload.z / Math.PI) * 1.5);
    const color = QUADRANT_COLOR[payload.quadrant_key] || UNPLACED_COLOR;
    const isSel = payload.key === selectedKey;
    return (
      <g
        className="ss-dot"
        onClick={() => onSelect(payload.key)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(payload.key); } }}
      >
        {/* 2px surface ring so overlapping categories stay separable */}
        <circle cx={cx} cy={cy} r={r + 2} fill="#ffffff" opacity={0.95} />
        <circle
          cx={cx} cy={cy} r={r}
          fill={payload.provisional ? 'transparent' : color}
          stroke={color}
          strokeWidth={payload.provisional ? 2 : isSel ? 3 : 1.5}
          strokeDasharray={payload.provisional ? '4 3' : undefined}
          opacity={payload.provisional ? 1 : 0.88}
        />
        {isSel && <circle cx={cx} cy={cy} r={r + 5} fill="none" stroke={color} strokeWidth={1} opacity={0.5} />}
      </g>
    );
  };

  const TooltipBody = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const p = payload[0].payload;
    return (
      <div className="ss-tip">
        <div className="ss-tip-title">{p.name}</div>
        <div className="ss-tip-row"><span>Quadrant</span><b>{p.quadrant}</b></div>
        <div className="ss-tip-row"><span>Demand power</span><b>{fmtNum(p.x)}</b></div>
        <div className="ss-tip-row"><span>Supply power</span><b>{fmtNum(p.y)}</b></div>
        <div className="ss-tip-row"><span>12-month spend</span><b>{fmtINR(p.spend)}</b></div>
        <div className="ss-tip-row"><span>Evidence</span><b>{p.coverage}% of forces</b></div>
        {p.provisional && <div className="ss-tip-warn">Provisional — thin evidence</div>}
      </div>
    );
  };

  return (
    <div className="ss-plot">
      <ResponsiveContainer width="100%" height={420}>
        <ScatterChart margin={{ top: 16, right: 24, bottom: 34, left: 8 }}>
          {/* Quadrant washes, drawn first so marks sit above them. */}
          <ReferenceArea x1={1} x2={3} y1={1} y2={3} fill={QUADRANT_COLOR.manage_spend} fillOpacity={0.05} />
          <ReferenceArea x1={3} x2={5} y1={1} y2={3} fill={QUADRANT_COLOR.leverage_competition} fillOpacity={0.05} />
          <ReferenceArea x1={3} x2={5} y1={3} y2={5} fill={QUADRANT_COLOR.seek_joint_advantage} fillOpacity={0.05} />
          <ReferenceArea x1={1} x2={3} y1={3} y2={5} fill={QUADRANT_COLOR.change_nature_of_demand} fillOpacity={0.05} />

          <CartesianGrid stroke="#e8eaf1" strokeDasharray="2 4" />
          <XAxis
            type="number" dataKey="x" domain={[1, 5]} ticks={[1, 2, 3, 4, 5]}
            tick={{ fontSize: 11, fill: '#6b7280' }} axisLine={{ stroke: '#d5d8e2' }} tickLine={false}
            label={{ value: 'Demand power (our leverage) →', position: 'insideBottom', offset: -18, fontSize: 11, fill: '#6b7280' }}
          />
          <YAxis
            type="number" dataKey="y" domain={[1, 5]} ticks={[1, 2, 3, 4, 5]}
            tick={{ fontSize: 11, fill: '#6b7280' }} axisLine={{ stroke: '#d5d8e2' }} tickLine={false}
            label={{ value: 'Supply power (theirs) →', angle: -90, position: 'insideLeft', offset: 14, fontSize: 11, fill: '#6b7280' }}
          />
          <ZAxis type="number" dataKey="z" range={[60, 520]} />
          <ReferenceLine x={3} stroke="#9aa1b1" strokeWidth={1} />
          <ReferenceLine y={3} stroke="#9aa1b1" strokeWidth={1} />
          <RTooltip content={<TooltipBody />} cursor={{ strokeDasharray: '3 3' }} />
          <Scatter data={points} shape={<CustomDot />} isAnimationActive={false} />
        </ScatterChart>
      </ResponsiveContainer>

      {/* The quadrants are direct-labelled in their own corners — the classic
          form, and it means identity never rests on colour alone. */}
      <div className="ss-quad-labels" aria-hidden="true">
        <span className="ss-ql tl" style={{ color: QUADRANT_COLOR.change_nature_of_demand }}>Change Nature of Demand</span>
        <span className="ss-ql tr" style={{ color: QUADRANT_COLOR.seek_joint_advantage }}>Seek Joint Advantage</span>
        <span className="ss-ql bl" style={{ color: QUADRANT_COLOR.manage_spend }}>Manage Spend</span>
        <span className="ss-ql br" style={{ color: QUADRANT_COLOR.leverage_competition }}>Leverage Competition</span>
      </div>
    </div>
  );
}

// ── Five Forces card ──────────────────────────────────────────────────────────

function ForceCard({ force }) {
  const rated = force.score != null;
  const width = rated ? ((force.score - 1) / 4) * 100 : 0;
  return (
    <div className={`ss-force${rated ? '' : ' is-unrated'}`}>
      <div className="ss-force-head">
        <span className="ss-force-name">{FORCE_LABEL[force.force] || force.force}</span>
        <span className="ss-force-score">{rated ? force.score.toFixed(1) : '—'}</span>
      </div>
      <div className="ss-force-bar">
        <div className="ss-force-fill" style={{ width: `${width}%` }} />
      </div>
      <div className="ss-force-meta">
        <span className={`ss-chip ss-chip--${force.basis}`}>{force.band}</span>
        <span className="ss-force-basis">{BASIS_LABEL[force.basis] || force.basis}</span>
      </div>
      {rated ? (
        <ul className="ss-drivers">
          {force.drivers.slice(0, 4).map((d, i) => (
            <li key={i}>
              <span className="ss-driver-sig">{d.signal}</span>
              <span className="ss-driver-val">{d.value ?? '—'}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ss-force-note">{force.note}</p>
      )}
    </div>
  );
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function StrategyForm({ detail, methods, onSaved }) {
  const existing = detail.strategy;
  const [methodKey, setMethodKey] = useState(existing?.method_key || detail.top_plays?.[0]?.method_key || '');
  const [rationale, setRationale] = useState(existing?.rationale || '');
  const [target, setTarget] = useState(existing?.target_saving_pct ?? '');
  const [review, setReview] = useState(existing?.review_date ? String(existing.review_date).slice(0, 10) : '');
  const [segment, setSegment] = useState(existing?.supplier_segment || '');
  const [status, setStatus] = useState(existing?.status || 'draft');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const chosen = methods.find((m) => m.method_key === methodKey);
  const offBoard = chosen && detail.position?.quadrant_key && chosen.quadrant_key !== detail.position.quadrant_key;

  const submit = async (e) => {
    e.preventDefault();
    if (!methodKey) return;
    setSaving(true);
    setErr(null);
    try {
      await api.post(`/sourcing-strategy/categories/${detail.category_key}/strategy`, {
        method_key: methodKey,
        rationale: rationale || null,
        target_saving_pct: target === '' ? null : Number(target),
        review_date: review || null,
        supplier_segment: segment || null,
        status,
      });
      onSaved();
    } catch (e2) {
      setErr(e2?.response?.data?.error || e2.message || 'Could not save the strategy');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="ss-form" onSubmit={submit}>
      <div className="ss-form-grid">
        <label className="ss-field ss-field--wide">
          <span>Approach</span>
          <select value={methodKey} onChange={(e) => setMethodKey(e.target.value)} required>
            <option value="">Choose a method…</option>
            {methods.map((m) => (
              <option key={m.method_key} value={m.method_key}>
                {m.lever} › {m.method}{m.evidenced ? ' ✦' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="ss-field">
          <span>Supplier segment</span>
          <input value={segment} onChange={(e) => setSegment(e.target.value)} placeholder="All suppliers" />
        </label>
        <label className="ss-field">
          <span>Target saving %</span>
          <input type="number" step="0.1" min="0" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="—" />
        </label>
        <label className="ss-field">
          <span>Review by</span>
          <input type="date" value={review} onChange={(e) => setReview(e.target.value)} />
        </label>
        <label className="ss-field">
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="draft">Draft</option>
            <option value="active">Active</option>
            <option value="retired">Retired</option>
          </select>
        </label>
        <label className="ss-field ss-field--full">
          <span>Rationale</span>
          <textarea
            rows={2} value={rationale} onChange={(e) => setRationale(e.target.value)}
            placeholder="Why this approach for this category — the reason has to outlive whoever had it."
          />
        </label>
      </div>

      {offBoard && (
        <p className="ss-note ss-note--warn">
          This method sits in <b>{QUADRANT_SHORT[chosen.quadrant_key]}</b>, not the quadrant this
          category currently occupies. That is allowed and will be recorded as a deliberate
          departure — say why in the rationale.
        </p>
      )}
      {err && <p className="ss-note ss-note--error">{err}</p>}

      <div className="ss-form-actions">
        <button type="submit" className="pulse-btn-primary" disabled={saving || !methodKey}>
          {saving ? 'Saving…' : existing ? 'Update strategy' : 'Record strategy'}
        </button>
        {existing && (
          <span className="ss-form-hint">
            Last set by {existing.decided_by_name || 'unknown'} · {fmtDate(existing.updated_at)}
          </span>
        )}
      </div>
    </form>
  );
}

/** Group the quadrant's methods under their levers. Sixteen rows — no memo needed. */
function groupByLever(recommendations = []) {
  const m = new Map();
  for (const r of recommendations) {
    if (!m.has(r.lever_key)) m.set(r.lever_key, { lever: r.lever, methods: [] });
    m.get(r.lever_key).methods.push(r);
  }
  return [...m.values()];
}

function DetailPanel({ detail, loading, onSaved }) {
  if (loading) return <div className="ss-panel ss-panel--loading">Loading category…</div>;
  if (!detail) return null;

  const pos = detail.position || {};
  const byLever = groupByLever(detail.recommendations);
  const color = QUADRANT_COLOR[pos.quadrant_key] || UNPLACED_COLOR;

  return (
    <div className="ss-panel">
      <header className="ss-panel-head">
        <div>
          <h2>{detail.category_name}</h2>
          <p className="ss-panel-sub">
            {fmtINR(detail.facts.spend_12m)} over {detail.basis.window.months} months ·{' '}
            {detail.facts.supplier_count ?? '—'} supplier(s) ·{' '}
            {detail.facts.item_count ?? '—'} item(s)
          </p>
        </div>
        {pos.quadrant ? (
          <span className="ss-quadrant-badge" style={{ background: `${color}14`, color, borderColor: `${color}44` }}>
            {pos.quadrant}
          </span>
        ) : (
          <span className="ss-quadrant-badge ss-quadrant-badge--none">Not placed</span>
        )}
      </header>

      {pos.thesis && <p className="ss-thesis">{pos.thesis}</p>}

      {pos.reason && <p className="ss-note ss-note--warn">{pos.reason}</p>}
      {pos.borderline && !pos.reason && (
        <p className="ss-note">
          This category sits close to the centre lines ({fmtNum(pos.demand_power)} demand /{' '}
          {fmtNum(pos.supply_power)} supply). Read the quadrant as a lean, not a verdict.
        </p>
      )}

      <h3 className="ss-h3">Five Forces <span className="ss-h3-sub">{detail.coverage_pct}% measurable</span></h3>
      <div className="ss-forces">
        {(detail.forces || []).map((f) => <ForceCard key={f.force} force={f} />)}
      </div>

      <h3 className="ss-h3">
        Suppliers in this category
        <span className="ss-h3-sub">{detail.suppliers?.length || 0} with spend in the window</span>
      </h3>
      {detail.suppliers?.length ? (
        <div className="ss-table-wrap">
          <table className="ss-table">
            <thead>
              <tr>
                <th>Supplier</th><th className="num">Spend</th><th className="num">Share</th>
                <th className="num">POs</th><th className="num">Health</th><th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {detail.suppliers.map((s) => (
                <tr key={s.vendor_id}>
                  <td>{s.vendor_name}</td>
                  <td className="num">{fmtINR(s.spend)}</td>
                  <td className="num">{fmtPct(s.share_pct)}</td>
                  <td className="num">{s.po_count}</td>
                  <td className="num">
                    {s.health_score == null
                      ? <span className="ss-muted">Unrated</span>
                      : `${s.health_score.toFixed(0)} · ${s.health_status}`}
                  </td>
                  <td>
                    {s.is_critical_supplier && <span className="ss-flag">Critical</span>}
                    {s.is_single_source && <span className="ss-flag">Single source</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="ss-empty">No purchase orders in this window, so there is no supplier segment to read yet.</p>
      )}

      <h3 className="ss-h3">
        Purchasing Chessboard
        <span className="ss-h3-sub">
          {pos.quadrant ? `16 methods under ${pos.quadrant}` : 'available once the category can be placed'}
        </span>
      </h3>
      {byLever.length ? (
        <div className="ss-levers">
          {byLever.map((l) => (
            <div className="ss-lever" key={l.lever}>
              <h4>{l.lever}</h4>
              {l.methods.map((m) => (
                <div className={`ss-method${m.evidenced ? ' is-evidenced' : ''}`} key={m.method_key}>
                  <div className="ss-method-top">
                    <span className="ss-method-name">{m.method}</span>
                    <span className="ss-method-fit">{m.fit}</span>
                  </div>
                  {m.why
                    ? <p className="ss-method-why">{m.why}</p>
                    : <p className="ss-method-req">Needs: {m.requires}</p>}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <p className="ss-empty">
          Nothing can be recommended until at least one of the five forces can be measured here.
          Classify items into this category, or record an approved vendor or a quoted price against one.
        </p>
      )}

      <h3 className="ss-h3">Strategy of record</h3>
      {detail.strategy?.drifted && (
        <p className="ss-note ss-note--warn">
          The recorded strategy was chosen under <b>{QUADRANT_SHORT[detail.strategy.quadrant_key]}</b>,
          but the category now reads as <b>{pos.quadrant}</b>. Worth re-testing.
        </p>
      )}
      <StrategyForm detail={detail} methods={detail.recommendations || []} onSaved={onSaved} />
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SourcingStrategy() {
  const [portfolio, setPortfolio] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [months, setMonths] = useState(12);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadPortfolio = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get('/sourcing-strategy/portfolio', { params: { months } });
      setPortfolio(data);
      setSelected((prev) => prev || data.categories?.[0]?.category_key || null);
    } catch (e) {
      // axios reports a cancelled request as CanceledError / ERR_CANCELED, never
      // AbortError — guarding on the wrong name paints a failure over good data.
      if (e.code === 'ERR_CANCELED' || e.name === 'CanceledError') return;
      setError(e?.response?.data?.error || e.message || 'Could not load the sourcing board');
    } finally {
      setLoading(false);
    }
  }, [months]);

  const loadDetail = useCallback(async (key) => {
    if (!key) return;
    setDetailLoading(true);
    try {
      const { data } = await api.get(`/sourcing-strategy/categories/${key}`, { params: { months } });
      setDetail(data);
    } catch (e) {
      if (e.code === 'ERR_CANCELED' || e.name === 'CanceledError') return;
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, [months]);

  useEffect(() => { loadPortfolio(); }, [loadPortfolio]);
  useEffect(() => { loadDetail(selected); }, [selected, loadDetail]);

  const cats = portfolio?.categories || [];
  const placed = cats.filter((c) => c.position?.quadrant_key);
  const unplaced = cats.filter((c) => !c.position?.quadrant_key);
  const withStrategy = cats.filter((c) => c.strategy);
  const basis = portfolio?.basis;

  const refreshAll = () => { loadPortfolio(); loadDetail(selected); };

  return (
    <PageShell
      className="sourcing-strategy"
      dock={
        <PageHero
          icon={Compass}
          eyebrow="Procurement · Strategic Sourcing"
          title="Sourcing Strategy"
          subtitle="Porter's Five Forces and the Purchasing Chessboard, scored from live purchase history"
          meta={[
            { label: 'categories on the board', value: cats.length },
            { label: 'positioned', value: placed.length },
            { label: 'strategy recorded', value: withStrategy.length },
          ]}
          actions={
            <div className="ss-hero-actions">
              <select
                className="ss-window" value={months}
                onChange={(e) => setMonths(Number(e.target.value))}
                aria-label="Spend window"
              >
                <option value={6}>Last 6 months</option>
                <option value={12}>Last 12 months</option>
                <option value={24}>Last 24 months</option>
              </select>
              <button type="button" className="plh-cta" onClick={refreshAll} disabled={loading}>
                <RefreshCw size={14} /> Refresh
              </button>
            </div>
          }
        />
      }
    >
      {error && <div className="ss-error">{error}</div>}

      {basis && (
        <>
          <StatBand cols={4}>
            <Stat label="Attributed spend" value={fmtINR(basis.total_attributed_spend)}
                  sub={`${basis.window.from} → ${basis.window.to}`} tone="primary" index={0} />
            <Stat label="Unattributed PO value" value={fmtINR(basis.unattributed_po_value)}
                  sub={`${fmtPct(basis.unattributed_pct)} of PO value has no line`}
                  tone={n(basis.unattributed_po_value) > 0 ? 'warning' : 'neutral'}
                  warn={n(basis.unattributed_po_value) > 0} index={1} />
            <Stat label="Categories positioned" value={`${placed.length} of ${cats.length}`}
                  sub={unplaced.length ? `${unplaced.length} lack measurable forces` : 'all measurable'}
                  tone="info" index={2} />
            <Stat label="Award basis" value={basis.tco_enabled ? 'Total cost' : 'Unit price'}
                  sub={basis.tco_enabled ? 'TCO is switched on' : 'TCO is off in settings'}
                  tone={basis.tco_enabled ? 'success' : 'warning'} index={3} />
          </StatBand>

          {/* The honesty line. A board built on line-level attribution has to say
              out loud how much of the spend it could not attribute. */}
          <p className="ss-basis">
            Spend is attributed through purchase order lines to
            <code> inventory_items.category_id</code>; PO statuses{' '}
            {basis.excluded_po_statuses.join(', ')} are excluded.
            {n(basis.unattributed_po_value) > 0 && (
              <> {fmtINR(basis.unattributed_po_value)} of PO value has no line and is not on this board.</>
            )}
            {basis.pos_without_lines > 0 && <> {basis.pos_without_lines} PO(s) carry no lines at all.</>}
          </p>
        </>
      )}

      <div className="ss-grid">
        <section className="ss-card ss-card--board">
          <header className="ss-card-head">
            <h2>The board</h2>
            <span className="ss-card-sub">Marker size is 12-month spend · a dashed outline means the position is provisional</span>
          </header>
          {loading ? (
            <div className="ss-loading">Scoring categories…</div>
          ) : placed.length ? (
            <ChessboardPlot categories={cats} selectedKey={selected} onSelect={setSelected} />
          ) : (
            <p className="ss-empty">
              No category has enough measurable forces to be placed yet. The board needs spend,
              an approved vendor list or quoted prices behind at least one category.
            </p>
          )}

          {unplaced.length > 0 && (
            <div className="ss-unplaced">
              <h3 className="ss-h3">
                Not enough evidence to place
                <span className="ss-h3-sub">{unplaced.length} categories</span>
              </h3>
              <p className="ss-unplaced-why">
                These are not at the centre of the board — they are off it. Nothing has been bought,
                priced or approved against them in this window, so no force can be scored.
              </p>
              <div className="ss-unplaced-list">
                {unplaced.map((c) => (
                  <button
                    key={c.category_key} type="button"
                    className={`ss-pill${selected === c.category_key ? ' is-sel' : ''}`}
                    onClick={() => setSelected(c.category_key)}
                  >
                    {c.category_name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="ss-card ss-card--list">
          <header className="ss-card-head">
            <h2>Categories</h2>
            <span className="ss-card-sub">Sorted by 12-month spend</span>
          </header>
          <div className="ss-table-wrap">
            <table className="ss-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="num">Spend</th>
                  <th className="num">Sup.</th>
                  <th className="num">HHI</th>
                  <th className="num">Evid.</th>
                  <th>Quadrant</th>
                  <th>Strategy</th>
                </tr>
              </thead>
              <tbody>
                {cats.map((c) => {
                  const q = c.position?.quadrant_key;
                  const color = QUADRANT_COLOR[q] || UNPLACED_COLOR;
                  return (
                    <tr
                      key={c.category_key}
                      className={selected === c.category_key ? 'is-sel' : ''}
                      onClick={() => setSelected(c.category_key)}
                    >
                      <td>
                        {c.category_name}
                        {c.is_uncategorised && <span className="ss-flag ss-flag--warn">unclassified</span>}
                      </td>
                      <td className="num">{fmtINR(c.facts.spend_12m)}</td>
                      <td className="num">{c.facts.supplier_count ?? '—'}</td>
                      <td className="num">{fmtNum(c.facts.hhi, 2)}</td>
                      <td className="num">{c.coverage_pct}%</td>
                      <td>
                        {q ? (
                          <span className="ss-quad-cell">
                            <i style={{ background: color }} />
                            {QUADRANT_SHORT[q]}
                            {c.position.provisional && <em>prov.</em>}
                          </span>
                        ) : <span className="ss-muted">not placed</span>}
                      </td>
                      <td>
                        {c.strategy
                          ? <span className={`ss-strat${c.strategy.drifted ? ' is-drift' : ''}`}>{c.strategy.method_label}</span>
                          : <span className="ss-muted">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <DetailPanel detail={detail} loading={detailLoading} onSaved={refreshAll} />
    </PageShell>
  );
}
