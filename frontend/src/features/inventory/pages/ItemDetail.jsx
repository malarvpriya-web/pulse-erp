// frontend/src/features/inventory/pages/ItemDetail.jsx
// Component 360 — reached by clicking any row in Item Master (/ItemDetail?id=<itemId>).
//
// Answers the question the Item Master grid could not: "which vendors can supply
// this component, at what price, with what lead time — and what have we actually
// paid before?" That comparison is the input to costing a BOM, so the page also
// shows which BOMs already consume the component and lets the whole vendor table
// be exported.
//
// The table ranks on TOTAL COST OF OWNERSHIP, not on unit price. The cheapest
// quote is routinely not the cheapest buy once lead time, reject rate, MOQ
// over-buy and payment terms are priced in, and "Best Price" alone hid that.
// Every TCO figure carries its provenance (quoted / observed / estimated /
// assumed) and the basis panel shows the rates it was computed at, because an
// award defended with an unauditable number is worse than one defended with a
// price.
//
// Data: GET /inventory/catalog/items/:itemId/sourcing?qty=<comparison quantity>
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, Package, Users, IndianRupee, Percent, Download, Boxes,
  ChevronUp, ChevronDown, Star, ExternalLink, Scale, Info, Lightbulb, X,
} from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import api from '@/services/api/client';
import { PageHero, PageShell, KPICardGrid, KPICard, ContentCard, TableContainer, EmptyState } from '@/components/pulse-ui';

const BRAND = '#6B3FDB';
const GREEN = '#16a34a';
const RED   = '#dc2626';

const fmtMoney = v => {
  const n = parseFloat(v);
  return v == null || isNaN(n) ? '—' : '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
};
const fmtNum = (v, dp = 2) => {
  const n = parseFloat(v);
  return v == null || isNaN(n) ? '—' : n.toLocaleString('en-IN', { maximumFractionDigits: dp });
};
// App-wide date format: DD Mon YY (utils/dateFormatter.js convention).
const fmtDate = d => {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
};

const SOURCE_META = {
  'Price Book': { bg: '#ede9fe', color: '#5b21b6' },
  'Last PO':    { bg: '#dcfce7', color: '#15803d' },
  'RFQ Quote':  { bg: '#dbeafe', color: '#1d4ed8' },
  'Price Log':  { bg: '#f3f4f6', color: '#4b5563' },
};

function SourceBadge({ source }) {
  if (!source) return <span style={{ color: '#9ca3af' }}>—</span>;
  const m = SOURCE_META[source] || SOURCE_META['Price Log'];
  return (
    <span
      title="Where this price came from — the negotiated price book, the last PO we actually paid, an RFQ quote, or the manual price log"
      style={{ background: m.bg, color: m.color, padding: '2px 8px', borderRadius: 8, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}
    >
      {source}
    </span>
  );
}

// ContentCard exposes only `title`; a one-line explainer goes in the body.
function Caption({ children }) {
  return <p style={{ margin: '0 0 12px', fontSize: 12.5, color: '#6b7280', lineHeight: 1.5 }}>{children}</p>;
}

function Rating({ value }) {
  if (value == null) return <span style={{ color: '#9ca3af' }}>—</span>;
  // Clamp before repeat(): a rating above 5 (or a NaN) would make the star
  // maths negative and RangeError the entire page.
  const filled = Math.max(0, Math.min(5, Math.round(value)));
  return (
    <span title={`${fmtNum(value, 1)} / 5`} style={{ color: '#a78bfa', letterSpacing: 1, fontSize: 12 }}>
      {'★'.repeat(filled)}{'☆'.repeat(5 - filled)}
    </span>
  );
}

// Where a TCO line's number came from. A breakdown without this is a guess
// wearing a suit — the buyer has to know which figures a vendor committed to
// and which the model invented.
const BASIS_META = {
  quoted:    { label: 'Quoted',    bg: '#dcfce7', color: '#15803d', title: 'The vendor gave us this number' },
  observed:  { label: 'Observed',  bg: '#dbeafe', color: '#1d4ed8', title: 'Measured from our own receipt / purchase history with this vendor' },
  estimated: { label: 'Estimated', bg: '#fef3c7', color: '#a16207', title: 'Modelled from company rates and vendor master data' },
  assumed:   { label: 'Assumed',   bg: '#f3f4f6', color: '#6b7280', title: 'Nothing on record — the company default rate was applied' },
};

function BasisBadge({ basis }) {
  const m = BASIS_META[basis] || BASIS_META.assumed;
  return (
    <span title={m.title} style={{ background: m.bg, color: m.color, padding: '1px 7px', borderRadius: 7, fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap' }}>
      {m.label}
    </span>
  );
}

// Confidence is the share of the TCO that rests on quoted or observed figures
// rather than on the rate card.
function ConfidenceDot({ value }) {
  if (value == null) return null;
  const color = value >= 75 ? GREEN : value >= 45 ? '#d97706' : '#9ca3af';
  return (
    <span title={`${value}% of this figure comes from quoted or observed data rather than company default rates`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />{value}%
    </span>
  );
}

const GROUP_META = {
  acquisition: { label: 'Acquisition', hint: 'What the vendor invoices' },
  landed:      { label: 'Landed',      hint: 'Freight, duty, insurance, packaging and any tax we cannot reclaim' },
  ownership:   { label: 'Ownership',   hint: 'Carrying, ordering, inspection, rejects — less the benefit of credit terms' },
  risk:        { label: 'Risk',        hint: 'Expediting on late deliveries and single-source exposure' },
};

const VENDOR_COLS = [
  { key: 'vendor_name',      label: 'Vendor',        align: 'left'  },
  { key: 'price_source',     label: 'Source',        align: 'left'  },
  { key: 'best_price',       label: 'Unit Price',    align: 'right', title: 'What the vendor charges per unit — the acquisition price only' },
  { key: 'vs_best_pct',      label: 'vs Cheapest',   align: 'right', title: 'How this unit price compares with the cheapest quote' },
  { key: 'tco_per_unit',     label: 'TCO / unit',    align: 'right', title: 'Total cost of ownership per unit: acquisition + landed + ownership + risk' },
  { key: 'tco_premium_pct',  label: 'TCO Premium',   align: 'right', title: 'How much more than the sticker price this vendor actually costs' },
  { key: 'tco_vs_best_pct',  label: 'vs Best TCO',   align: 'right', title: 'How this total cost compares with the lowest-TCO vendor' },
  { key: 'tco_confidence',   label: 'Confidence',    align: 'right', title: 'Share of the TCO based on quoted or observed data rather than default rates' },
  { key: 'moq',              label: 'MOQ',           align: 'right' },
  { key: 'lead_time_days',   label: 'Lead (d)',      align: 'right' },
  { key: 'on_time_pct',      label: 'OTD %',         align: 'right' },
  { key: 'quality_rating',   label: 'Quality',       align: 'left'  },
];

// Exports exactly the columns on screen, so a shared CSV and the page a
// colleague opens agree on what was compared.
function exportCSV(item, vendors, cols = VENDOR_COLS) {
  const header = cols.map(c => c.label).join(',');
  const body = vendors.map(v => cols.map(c => {
    const raw = v[c.key];
    const s = raw == null ? '' : String(raw);
    return s.includes(',') ? `"${s}"` : s;
  }).join(',')).join('\n');
  const blob = new Blob([`${item.item_code} — ${item.item_name}\n${header}\n${body}`], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sourcing-${item.item_code || item.id}-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ItemDetail() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const itemId = params.get('id');

  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  // Default sort is TCO, not price. The column a table sorts by is the one a
  // buyer treats as the answer.
  const [sortKey, setSortKey] = useState('tco_per_unit');   // reset to price if TCO is switched off
  const [sortDir, setSortDir] = useState('asc');
  const [breakdown, setBreakdown] = useState(null);   // vendor whose TCO drawer is open
  const [showBasis, setShowBasis] = useState(false);
  // `qtyInput` is what the buyer typed; `qty` is what has been sent to the
  // server. Keeping them apart stops a refetch firing on every keystroke.
  const [qtyInput, setQtyInput] = useState('');
  const [qty, setQty] = useState('');
  const abortRef = useRef(null);

  const load = useCallback(async () => {
    if (!itemId) { setLoading(false); setError('No component selected.'); return; }
    abortRef.current?.abort?.();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const res = await api.get(`/inventory/catalog/items/${itemId}/sourcing`, {
        params: qty ? { qty } : undefined,
        signal: controller.signal,
      });
      setData(res.data);
    } catch (e) {
      if (e.name === 'CanceledError' || e.code === 'ERR_CANCELED') return;
      setError(e?.response?.data?.error || e.message || 'Failed to load sourcing data');
    } finally {
      // A superseded request must not clear the spinner — otherwise the empty
      // state flashes mid-load (see project_abort_race_loading_flash).
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [itemId, qty]);

  useEffect(() => { load(); return () => abortRef.current?.abort?.(); }, [load]);

  const item    = data?.item || {};
  const s       = data?.summary || {};
  const rawVendors = data?.vendors || [];
  const basis   = data?.tco_basis || null;
  // A company can switch TCO off in Procurement Settings. When it is off there
  // is nothing to rank on, so the columns come out entirely rather than
  // rendering as a wall of dashes that looks like missing data.
  const tcoOn   = basis ? basis.tco_enabled !== false : true;
  const rec     = tcoOn ? (s.tco_recommendation || null) : null;
  const cols    = useMemo(
    () => (tcoOn ? VENDOR_COLS : VENDOR_COLS.filter(c => !c.key.startsWith('tco_'))),
    [tcoOn]
  );

  // The server picks a comparison quantity when the buyer has not — show it, so
  // the box is never blank next to numbers that depend on it.
  useEffect(() => {
    if (!qty && basis?.quantity != null) setQtyInput(String(basis.quantity));
  }, [basis?.quantity, qty]);

  // "vs cheapest" is derived here rather than server-side so it stays correct
  // if the table is ever filtered client-side.
  const vendors = useMemo(() => {
    const best = s.best_price;
    const withDelta = rawVendors.map(v => ({
      ...v,
      vs_best_pct: (best && v.best_price != null && best > 0)
        ? +(((v.best_price - best) / best) * 100).toFixed(1)
        : null,
    }));
    const dir = sortDir === 'asc' ? 1 : -1;
    return withDelta.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;   // nulls always sink, regardless of direction
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [rawVendors, s.best_price, sortKey, sortDir]);

  // Without this the table would sort on a column that is no longer rendered.
  useEffect(() => {
    if (!tcoOn && sortKey.startsWith('tco_')) { setSortKey('best_price'); setSortDir('asc'); }
  }, [tcoOn, sortKey]);

  const toggleSort = key => {
    if (key === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };

  // Price trend: one series per vendor so competing quotes are comparable at a glance.
  const { trendRows, trendVendors } = useMemo(() => {
    const pts = data?.price_trend || [];
    const names = [...new Set(pts.map(p => p.vendor_name).filter(Boolean))].slice(0, 6);
    const byDate = new Map();
    for (const p of pts) {
      if (!p.vendor_name || !names.includes(p.vendor_name)) continue;
      const key = fmtDate(p.price_date);
      const row = byDate.get(key) || { date: key };
      row[p.vendor_name] = p.unit_price;
      byDate.set(key, row);
    }
    return { trendRows: [...byDate.values()], trendVendors: names };
  }, [data]);

  const TREND_COLORS = ['#6B3FDB', '#2563eb', '#16a34a', '#7c3aed', '#0891b2', '#9333ea'];

  const th = (c) => (
    <th
      key={c.key}
      onClick={() => toggleSort(c.key)}
      style={{
        padding: '9px 12px', textAlign: c.align, fontWeight: 600, color: '#374151',
        borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none',
      }}
    >
      <span title={c.title || undefined} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        {c.label}
        {sortKey === c.key && (sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
      </span>
    </th>
  );

  const td = { padding: '8px 12px' };

  return (
    <PageShell dock={
      <PageHero
        icon={Package}
        eyebrow="Inventory · Component 360"
        title={item.item_name || (loading ? 'Loading…' : 'Component')}
        subtitle={[item.item_code, item.category_name, item.unit_of_measure && `UOM ${item.unit_of_measure}`, item.manufacturer]
          .filter(Boolean).join('  ·  ') || 'Vendor comparison, purchase history and where-used'}
        actions={<>
          <button className="plh-cta plh-cta--ghost" onClick={() => navigate('/ItemMaster')}>
            <ArrowLeft size={14} /> Item Master
          </button>
          {vendors.length > 0 && (
            <button className="plh-cta" onClick={() => exportCSV(item, vendors, cols)}>
              <Download size={14} /> Export Comparison
            </button>
          )}
        </>}
      />
    }>

      {error && (
        <div style={{ background: '#fee2e2', color: RED, borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 13, fontWeight: 600 }}>
          {error}
        </div>
      )}
      {loading && <div style={{ textAlign: 'center', padding: 48, color: '#9ca3af', fontSize: 14 }}>Loading sourcing data…</div>}

      {!loading && !error && data && (
        <>
          <KPICardGrid>
            <KPICard
              icon={Users} label="Vendors Available" value={fmtNum(s.vendor_count, 0)}
              sub={`${fmtNum(s.priced_vendor_count, 0)} with a price`}
              tone={s.vendor_count > 1 ? 'success' : 'warning'}
            />
            <KPICard
              icon={IndianRupee} label="Best Price" value={fmtMoney(s.best_price)}
              sub={s.best_vendor ? `from ${s.best_vendor}` : 'no priced vendor yet'} tone="success"
            />
            <KPICard
              icon={Scale} label="Lowest Total Cost" value={fmtMoney(s.best_tco_per_unit)}
              sub={s.best_tco_vendor ? `from ${s.best_tco_vendor}` : 'no vendor costed yet'}
              tone={rec?.differs ? 'warning' : 'success'}
            />
            <KPICard
              icon={Percent} label="TCO Spread" value={s.tco_spread_pct ? `${fmtNum(s.tco_spread_pct, 1)}%` : '—'}
              sub={`price spread ${s.spread_pct ? fmtNum(s.spread_pct, 1) + '%' : '—'} — what the choice is worth`}
              tone={s.tco_spread_pct > 20 ? 'warning' : 'default'}
            />
            <KPICard
              icon={Boxes} label="On Hand" value={`${fmtNum(item.current_stock)} ${item.unit_of_measure || ''}`.trim()}
              sub={item.standard_cost != null ? `std cost ${fmtMoney(item.standard_cost)}` : 'no standard cost set'}
            />
          </KPICardGrid>

          {/* ── The headline: cheapest quote vs cheapest buy ──────────────── */}
          {rec && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16, padding: '14px 18px',
              borderRadius: 12, fontSize: 13.5, lineHeight: 1.55,
              background: rec.differs ? '#fffbeb' : '#f0fdf4',
              border: `1px solid ${rec.differs ? '#fde68a' : '#bbf7d0'}`,
              color: rec.differs ? '#92400e' : '#166534',
            }}>
              <Lightbulb size={18} style={{ flexShrink: 0, marginTop: 1 }} />
              <div>
                {rec.differs ? (
                  <>
                    <strong>The cheapest quote is not the cheapest buy.</strong>{' '}
                    <strong>{rec.lowest_price_label}</strong> has the lowest unit price, but{' '}
                    <strong>{rec.lowest_tco_label}</strong> costs less to own
                    {rec.price_gap_pct != null && rec.price_gap_pct > 0 && (
                      <> — despite quoting {fmtNum(rec.price_gap_pct, 1)}% more per unit</>
                    )}
                    {rec.tco_saving > 0 && (
                      <>, saving <strong>{fmtMoney(rec.tco_saving)}</strong> on {fmtNum(basis?.quantity)} {item.unit_of_measure || 'units'}</>
                    )}.
                  </>
                ) : (
                  <><strong>{rec.lowest_tco_label}</strong> is both the cheapest quote and the lowest total cost of ownership.</>
                )}
              </div>
            </div>
          )}

          {/* ── Vendor comparison — the BOM-costing table ─────────────────── */}
          <ContentCard title="Vendor Comparison">
            <Caption>
              Ranked by <strong>total cost of ownership</strong>, not unit price: acquisition + landed cost +
              carrying, ordering, inspection and rejects, less credit terms, plus delivery risk. Click any TCO
              figure to see what makes it up.
            </Caption>

            {/* Per-order costs and MOQ over-buy only separate vendors at a stated
                quantity, so the quantity is a control, not a hidden constant. */}
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 14, fontSize: 12.5, color: '#4b5563' }}>
              <label htmlFor="tco-qty" style={{ fontWeight: 600 }}>Compare at quantity</label>
              <input
                id="tco-qty" type="number" min="0" step="any" value={qtyInput}
                onChange={e => setQtyInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') setQty(qtyInput); }}
                style={{ width: 110, padding: '5px 9px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13 }}
              />
              <span>{item.unit_of_measure || 'units'}</span>
              <button className="pulse-btn-secondary" style={{ padding: '5px 12px', fontSize: 12.5 }}
                onClick={() => setQty(qtyInput)}>Apply</button>
              {qty && (
                <button onClick={() => setQty('')}
                  style={{ background: 'none', border: 'none', color: BRAND, fontSize: 12.5, cursor: 'pointer', textDecoration: 'underline' }}>
                  reset
                </button>
              )}
              {basis?.quantity_basis && (
                <span style={{ color: '#9ca3af' }}>· quantity taken from: {basis.quantity_basis}</span>
              )}
              <button
                onClick={() => setShowBasis(v => !v)}
                style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none',
                         border: 'none', color: BRAND, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
              >
                <Info size={13} />{showBasis ? 'Hide' : 'Show'} costing basis
              </button>
            </div>

            {/* An award defended with a number nobody can reproduce is not
                defended. These are the rates every figure above was built on. */}
            {showBasis && basis && (
              <div style={{ marginBottom: 16, padding: '12px 16px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 10, fontSize: 12.5, color: '#4b5563' }}>
                <div style={{ fontWeight: 700, color: '#374151', marginBottom: 8 }}>
                  Costing basis — set in Procurement Settings → Total Cost of Ownership
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '6px 20px' }}>
                  {[
                    ['Evaluation horizon', `${basis.horizon_months} months`],
                    ['Cost of capital', `${fmtNum(basis.cost_of_capital_pct, 2)}% / yr`],
                    ['Inventory carrying', `${fmtNum(basis.inventory_carrying_pct, 2)}% / yr`],
                    ['Ordering cost', `${fmtMoney(basis.ordering_cost_per_po)} per PO`],
                    ['Incoming inspection', `${fmtMoney(basis.inspection_cost_per_receipt)} per receipt`],
                    ['Expediting', `${fmtMoney(basis.expedite_cost_per_late_order)} per late order`],
                    ['Rework on a reject', `${fmtNum(basis.rework_cost_pct, 1)}% of unit cost`],
                    ['Freight when unquoted', `${fmtNum(basis.default_freight_pct, 2)}% of value`],
                    ['GST recoverable', `${fmtNum(basis.gst_input_credit_pct, 1)}%`],
                    ['Annual demand', basis.annual_demand_qty != null ? `${fmtNum(basis.annual_demand_qty)} (${basis.demand_source})` : 'not measured'],
                    ['Vendors with measured quality', `${basis.vendors_with_observed_quality ?? 0} of ${s.priced_vendor_count ?? 0}`],
                    ['Vendors with measured OTD', `${basis.vendors_with_observed_otd ?? 0} of ${s.priced_vendor_count ?? 0}`],
                  ].map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <span>{k}</span><strong style={{ color: '#374151' }}>{v}</strong>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid #e5e7eb', color: '#6b7280' }}>
                  GST is excluded while it is fully recoverable as input credit — only the non-creditable share is a real cost.
                </div>
              </div>
            )}
            <TableContainer
              isEmpty={vendors.length === 0}
              emptyState={<EmptyState title="No vendor has been priced for this component yet." subtitle="Add a vendor price from Item Master → edit this component → Vendor Prices, or raise an RFQ." />}
              rowCount={vendors.length}
            >
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr style={{ background: '#f9fafb' }}>{cols.map(th)}</tr></thead>
                <tbody>
                  {vendors.map((v, i) => {
                    // The highlighted row is the lowest TOTAL COST, not the
                    // cheapest quote — highlighting the quote is what made
                    // buyers award on price in the first place.
                    const isBest = v.is_lowest_tco === true;
                    return (
                      <tr key={v.vendor_id} style={{ borderBottom: '1px solid #f3f4f6', background: isBest ? '#f0fdf4' : (i % 2 ? '#fafafa' : '#fff') }}>
                        <td style={{ ...td, whiteSpace: 'nowrap' }}>
                          <button
                            onClick={() => navigate(`/Vendor360?vendor=${v.vendor_id}`)}
                            title="Open this vendor's 360° view"
                            style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: BRAND, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                          >
                            {v.vendor_name}<ExternalLink size={11} />
                          </button>
                          {v.is_preferred && <Star size={12} fill="#f59e0b" color="#f59e0b" style={{ marginLeft: 6, verticalAlign: 'middle' }} title="Preferred vendor" />}
                          {v.vendor_sku && <div style={{ fontSize: 11, color: '#9ca3af' }}>SKU {v.vendor_sku}</div>}
                        </td>
                        <td style={td}><SourceBadge source={v.price_source} /></td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: v.is_lowest_price ? GREEN : '#1f2937' }}>
                          {fmtMoney(v.best_price)}
                          {v.is_lowest_price && <div style={{ fontSize: 10, color: GREEN, fontWeight: 700 }}>cheapest quote</div>}
                        </td>
                        <td style={{ ...td, textAlign: 'right', color: v.vs_best_pct > 0 ? RED : '#9ca3af' }}>
                          {v.vs_best_pct == null ? '—' : v.vs_best_pct === 0 ? 'cheapest' : `+${fmtNum(v.vs_best_pct, 1)}%`}
                        </td>
                        {/* TCO is the decision column — it opens the breakdown, because
                            a total nobody can take apart does not get trusted. */}
                        <td style={{ ...td, textAlign: 'right' }}>
                          {v.tco_per_unit == null ? <span style={{ color: '#9ca3af' }}>—</span> : (
                            <button
                              onClick={() => setBreakdown(v)}
                              title="Show what makes up this total cost"
                              style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', cursor: 'pointer',
                                       fontWeight: 800, color: v.is_lowest_tco ? GREEN : '#1f2937', textDecoration: 'underline dotted' }}
                            >
                              {fmtMoney(v.tco_per_unit)}
                            </button>
                          )}
                          {v.is_lowest_tco && <div style={{ fontSize: 10, color: GREEN, fontWeight: 700 }}>lowest total cost</div>}
                        </td>
                        <td style={{ ...td, textAlign: 'right', color: v.tco_premium_pct > 25 ? RED : '#6b7280' }}>
                          {v.tco_premium_pct == null ? '—' : `+${fmtNum(v.tco_premium_pct, 1)}%`}
                        </td>
                        <td style={{ ...td, textAlign: 'right', color: v.tco_vs_best_pct > 0 ? RED : '#9ca3af', fontWeight: v.tco_vs_best_pct > 0 ? 600 : 400 }}>
                          {v.tco_vs_best_pct == null ? '—' : v.tco_vs_best_pct === 0 ? 'best' : `+${fmtNum(v.tco_vs_best_pct, 1)}%`}
                        </td>
                        <td style={{ ...td, textAlign: 'right' }}><ConfidenceDot value={v.tco_confidence} /></td>
                        <td style={{ ...td, textAlign: 'right', color: '#6b7280' }}>{fmtNum(v.moq, 0)}</td>
                        <td style={{ ...td, textAlign: 'right', color: '#6b7280' }}>{v.lead_time_days ?? '—'}</td>
                        <td style={{ ...td, textAlign: 'right', color: v.on_time_pct >= 90 ? GREEN : '#6b7280' }}>{v.on_time_pct == null ? '—' : `${fmtNum(v.on_time_pct, 0)}%`}</td>
                        <td style={td}><Rating value={v.quality_rating} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableContainer>
          </ContentCard>

          {/* ── Price trend ──────────────────────────────────────────────── */}
          {trendRows.length > 1 && (
            <ContentCard title="Price History">
              <Caption>Every dated price point we hold — purchase orders, price-book quotes and the manual price log.</Caption>
              <div style={{ height: 260 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trendRows} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#6b7280' }} />
                    <YAxis tick={{ fontSize: 11, fill: '#6b7280' }} tickFormatter={v => `₹${v}`} />
                    <Tooltip formatter={v => fmtMoney(v)} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    {trendVendors.map((name, i) => (
                      <Line key={name} type="monotone" dataKey={name} stroke={TREND_COLORS[i % TREND_COLORS.length]} strokeWidth={2} dot={{ r: 3 }} connectNulls />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </ContentCard>
          )}

          {/* ── What we actually paid ────────────────────────────────────── */}
          <ContentCard title="Purchase History">
            <Caption>{`${fmtNum(s.total_purchased_qty)} ${item.unit_of_measure || 'units'} bought for ${fmtMoney(s.total_purchased_value)} across all vendors`}</Caption>
            <TableContainer
              isEmpty={(data.purchase_lines || []).length === 0}
              emptyState={<EmptyState title="This component has never been purchased." />}
              rowCount={(data.purchase_lines || []).length}
            >
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    {['PO Number', 'Order Date', 'Vendor', 'Qty', 'Rate', 'Amount', 'Received', 'Received On', 'Status'].map((h, i) => (
                      <th key={h} style={{ padding: '9px 12px', textAlign: i >= 3 && i <= 6 ? 'right' : 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(data.purchase_lines || []).map((l, i) => (
                    <tr key={l.line_id} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 ? '#fafafa' : '#fff' }}>
                      <td style={{ ...td, fontFamily: 'monospace', color: BRAND, fontWeight: 600 }}>{l.po_number || `PO #${l.po_id}`}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(l.order_date)}</td>
                      <td style={td}>
                        <button
                          onClick={() => navigate(`/Vendor360?vendor=${l.vendor_id}`)}
                          style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: BRAND, cursor: 'pointer' }}
                        >
                          {l.vendor_name || `Vendor #${l.vendor_id}`}
                        </button>
                      </td>
                      <td style={{ ...td, textAlign: 'right' }}>{fmtNum(l.quantity)}</td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{fmtMoney(l.rate)}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{fmtMoney(l.amount)}</td>
                      <td style={{ ...td, textAlign: 'right', color: (l.received_qty || 0) >= (l.quantity || 0) ? GREEN : '#6b7280' }}>{fmtNum(l.received_qty)}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap', color: '#6b7280' }}>{fmtDate(l.received_date)}</td>
                      <td style={{ ...td, textTransform: 'capitalize', color: '#6b7280' }}>{l.status || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableContainer>
          </ContentCard>

          {/* ── Where used ───────────────────────────────────────────────── */}
          {(data.used_in_boms || []).length > 0 && (
            <ContentCard title="Used In">
              <Caption>{`${s.bom_count} bill${s.bom_count === 1 ? '' : 's'} of material consume this component`}</Caption>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    {['BOM', 'Product', 'Version', 'Qty / Unit', 'Unit Cost', 'Extended at Best Price', 'Status'].map((h, i) => (
                      <th key={h} style={{ padding: '9px 12px', textAlign: i >= 3 && i <= 5 ? 'right' : 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.used_in_boms.map((b, i) => (
                    <tr key={`${b.bom_id}-${i}`} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 ? '#fafafa' : '#fff' }}>
                      <td style={{ ...td, fontFamily: 'monospace', color: BRAND }}>{b.bom_number || `BOM #${b.bom_id}`}</td>
                      <td style={td}>{b.product_name || b.product_code || '—'}</td>
                      <td style={td}>{b.version || '—'}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{fmtNum(b.qty_per)} {b.unit || ''}</td>
                      <td style={{ ...td, textAlign: 'right', color: '#6b7280' }}>{fmtMoney(b.unit_cost)}</td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: GREEN }}>
                        {s.best_price != null && b.qty_per != null ? fmtMoney(s.best_price * b.qty_per) : '—'}
                      </td>
                      <td style={{ ...td, textTransform: 'capitalize', color: '#6b7280' }}>{b.status || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ContentCard>
          )}

          {/* ── TCO breakdown drawer ──────────────────────────────────────
              A total nobody can take apart does not get trusted, and should
              not be: every line names its amount AND where the amount came
              from, so a buyer can throw out the ones they disagree with. */}
          {breakdown?.tco && (
            <div
              onClick={() => setBreakdown(null)}
              style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.45)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }}
            >
              <div
                onClick={e => e.stopPropagation()}
                style={{ background: '#fff', width: 'min(560px, 100%)', height: '100%', overflowY: 'auto', padding: 24, boxShadow: '-8px 0 32px rgba(0,0,0,0.15)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 4 }}>
                  <div>
                    <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, color: '#9ca3af', fontWeight: 700 }}>
                      Total cost of ownership
                    </div>
                    <h2 style={{ margin: '2px 0 0', fontSize: 19, fontWeight: 700, color: '#1f2937' }}>{breakdown.vendor_name}</h2>
                  </div>
                  <button onClick={() => setBreakdown(null)} aria-label="Close breakdown"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 4 }}>
                    <X size={18} />
                  </button>
                </div>

                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', margin: '16px 0 18px', padding: '14px 16px', background: '#f9fafb', borderRadius: 10 }}>
                  {[
                    ['Unit price', fmtMoney(breakdown.tco.unit_price), '#6b7280'],
                    ['TCO / unit', fmtMoney(breakdown.tco.tco_per_unit), breakdown.is_lowest_tco ? GREEN : '#1f2937'],
                    ['Premium', breakdown.tco.premium_pct == null ? '—' : `+${fmtNum(breakdown.tco.premium_pct, 1)}%`, breakdown.tco.premium_pct > 25 ? RED : '#6b7280'],
                  ].map(([k, v, c]) => (
                    <div key={k}>
                      <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600 }}>{k}</div>
                      <div style={{ fontSize: 17, fontWeight: 800, color: c }}>{v}</div>
                    </div>
                  ))}
                  <div style={{ marginLeft: 'auto', alignSelf: 'center' }}>
                    <ConfidenceDot value={breakdown.tco.confidence} />
                  </div>
                </div>

                <p style={{ margin: '0 0 14px', fontSize: 12.5, color: '#6b7280', lineHeight: 1.55 }}>
                  Costed for <strong>{fmtNum(breakdown.tco.quantity)} {item.unit_of_measure || 'units'}</strong>
                  {breakdown.tco.excess_qty > 0 && (
                    <> — the vendor&apos;s minimum forces an order of {fmtNum(breakdown.tco.order_qty)}, so {fmtNum(breakdown.tco.excess_qty)} are bought early and carried</>
                  )}
                  {breakdown.tco.orders_in_horizon > 1 && (
                    <>, across ~{fmtNum(breakdown.tco.orders_in_horizon, 1)} orders in a {breakdown.tco.horizon_months}-month horizon</>
                  )}.
                </p>

                {/* Lines grouped the way a buyer reads a cost sheet. */}
                {['acquisition', 'landed', 'ownership', 'risk'].map(group => {
                  const lines = breakdown.tco.lines.filter(l => l.group === group);
                  if (!lines.length) return null;
                  const meta = GROUP_META[group];
                  return (
                    <div key={group} style={{ marginBottom: 16 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, paddingBottom: 5, borderBottom: '2px solid #f3f4f6' }}>
                        <div>
                          <span style={{ fontSize: 13, fontWeight: 800, color: '#374151' }}>{meta.label}</span>
                          <span style={{ fontSize: 11.5, color: '#9ca3af', marginLeft: 8 }}>{meta.hint}</span>
                        </div>
                        <span style={{ fontSize: 13, fontWeight: 800, color: breakdown.tco.groups[group] < 0 ? GREEN : '#374151' }}>
                          {fmtMoney(breakdown.tco.groups[group])}
                        </span>
                      </div>
                      {lines.map((l, i) => (
                        <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid #f9fafb' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: '#374151' }}>
                              {l.label}<BasisBadge basis={l.basis} />
                            </span>
                            <span style={{ fontSize: 12.5, fontWeight: 700, color: l.amount < 0 ? GREEN : '#1f2937', whiteSpace: 'nowrap' }}>
                              {l.amount < 0 ? `− ${fmtMoney(Math.abs(l.amount))}` : fmtMoney(l.amount)}
                            </span>
                          </div>
                          {l.note && <div style={{ fontSize: 11.5, color: '#9ca3af', marginTop: 2 }}>{l.note}</div>}
                        </div>
                      ))}
                    </div>
                  );
                })}

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', background: '#f5f3ff', borderRadius: 10, marginBottom: 16 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 800, color: '#5b21b6' }}>
                    Total for {fmtNum(breakdown.tco.quantity)} {item.unit_of_measure || 'units'}
                  </span>
                  <span style={{ fontSize: 16, fontWeight: 800, color: '#5b21b6' }}>{fmtMoney(breakdown.tco.tco_total)}</span>
                </div>

                {/* What the model had to invent. Surfacing this is the difference
                    between a costing and a guess presented as a costing. */}
                {breakdown.tco.assumptions?.length > 0 && (
                  <div style={{ padding: '12px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 800, color: '#92400e', marginBottom: 6 }}>
                      What this figure had to assume
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#92400e', lineHeight: 1.6 }}>
                      {breakdown.tco.assumptions.map((a, i) => <li key={i}>{a}</li>)}
                    </ul>
                    <div style={{ marginTop: 8, fontSize: 11.5, color: '#a16207' }}>
                      Fix these by recording freight, lead time and payment terms on the vendor&apos;s price book entry, or by
                      receiving against a PO so quality and delivery become measured rather than assumed.
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </PageShell>
  );
}
