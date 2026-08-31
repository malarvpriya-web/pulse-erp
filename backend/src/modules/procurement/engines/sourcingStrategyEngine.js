/**
 * sourcingStrategyEngine.js — how a category should be sourced, and why.
 *
 * WHY THIS EXISTS
 * §128 gave a buyer the total cost of ONE purchase. Nothing in the app answers
 * the question one level up: *how should we be buying this category at all?*
 * Every sourcing decision in Pulse is currently made per-RFQ, per-PO, by a
 * buyer comparing quotes — the right tool for a transaction and the wrong one
 * for a category. A category where we are most of a fragmented market's revenue
 * and a category with one qualified sole source on a six-month lead time need
 * opposite behaviour, and price comparison cannot tell them apart.
 *
 * THE MODEL — two published frameworks, wired to data we actually hold.
 *
 *   PORTER'S FIVE FORCES  scores the structure of the SUPPLY market on 1-5
 *                         (5 = the force is intense). Adapted for purchasing:
 *                         Porter writes "buyer power" about the buyers of our
 *                         output; here it is OUR power as the buyer, which is
 *                         the standard sourcing adaptation and is named
 *                         `buyer_power_ours` so nobody has to guess.
 *
 *   PURCHASING CHESSBOARD positions the category on A.T. Kearney's two axes —
 *                         demand power (leverage we hold) against supply power
 *                         (leverage they hold) — into one of four quadrants,
 *                         each carrying 4 levers of 4 methods: 64 plays.
 *
 * PROVENANCE IS PART OF THE OUTPUT, exactly as in tcoEngine. Every force
 * carries `basis`:
 *   'observed'  — measured from our own PO / RFQ / AVL history
 *   'estimated' — modelled from master data (vendor flags, lead times, tooling)
 *   'assumed'   — nothing category-specific; a neutral prior was applied
 *   'unrated'   — NO input existed. The force is null, not 3, and it is
 *                 excluded from the composite rather than dragging it to the
 *                 middle. An unmeasured force must never read as "moderate".
 *
 * A quadrant computed from two of five forces is a guess wearing a suit, so
 * `coverage_pct` travels with the position and anything under MIN_COVERAGE_PCT
 * comes back `provisional: true`. The caller is expected to render that
 * difference — the failure mode this engine is written against is a confident
 * recommendation resting on nothing.
 *
 * ON THE TAXONOMY: the four quadrant names and the sixteen lever names follow
 * the published Purchasing Chessboard structure. The 64 methods below are the
 * practice-level plays stated in terms this system can evidence and act on —
 * each carries `requires`, what has to be true before it is worth proposing.
 * It is this app's implementation of the framework, not a transcription of it.
 *
 * Pure functions. No DB, no I/O — see services/sourcingStrategy.service.js.
 */

// pg returns NUMERIC as a string and NULL as null. `null` must survive as null
// so a missing fact stays missing (project_pg_count_string_nan_bug).
export function num(v, fallback = null) {
  if (v == null || v === '') return fallback;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

const round1 = (n) => (n == null ? null : Math.round((n + Number.EPSILON) * 10) / 10);
const round2 = (n) => (n == null ? null : Math.round((n + Number.EPSILON) * 100) / 100);
const clamp  = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Below this, a quadrant is a hypothesis and is labelled as one. */
export const MIN_COVERAGE_PCT = 60;

/** The 1-5 scale, named. Bands are what the UI prints; the number is what sorts. */
export function band(score) {
  if (score == null) return 'Unrated';
  if (score >= 4.2) return 'Very High';
  if (score >= 3.4) return 'High';
  if (score >= 2.6) return 'Moderate';
  if (score >= 1.8) return 'Low';
  return 'Very Low';
}

// ── Porter's Five Forces ──────────────────────────────────────────────────────

export const FORCES = Object.freeze([
  {
    key: 'supplier_power',
    label: 'Supplier Power',
    question: 'How much leverage do the suppliers of this category hold over us?',
    high_means: 'Few suppliers, hard to switch — they set the terms.',
  },
  {
    key: 'buyer_power_ours',
    label: 'Buyer Power (ours)',
    question: 'How much leverage do WE hold in this category?',
    high_means: 'We are a large, attractive, hard-to-replace customer here.',
  },
  {
    key: 'rivalry',
    label: 'Competitive Rivalry',
    question: 'How hard do suppliers compete with each other for our business?',
    high_means: 'Many bidders, wide price spread — competition is live.',
  },
  {
    key: 'new_entrants',
    label: 'Threat of New Entrants',
    question: 'How easily can new suppliers enter and be qualified?',
    high_means: 'The bench is refreshing — incumbents are contestable.',
  },
  {
    key: 'substitutes',
    label: 'Threat of Substitutes',
    question: 'How readily can the requirement be met another way?',
    high_means: 'Alternate parts, specs or making it ourselves are real options.',
  },
]);

/**
 * Score one force to 1-5 from a list of weighted signals.
 *
 * A signal contributes ONLY when its input is non-null. `weight` is the pull it
 * has on the result; `score` is where it points on the 1-5 scale. When no
 * signal fires the force comes back `unrated` — not 3. Returning a neutral 3
 * for an unmeasured force is the exact defect this file guards against: it puts
 * a category with no data dead-centre of the chessboard, which is a position,
 * not an absence of one.
 */
function scoreForce(key, signals) {
  const live = signals.filter((s) => s && s.score != null && s.weight > 0);
  if (!live.length) {
    return {
      force: key,
      score: null,
      band: 'Unrated',
      basis: 'unrated',
      drivers: [],
      note: 'No data in this category supports a reading of this force.',
    };
  }
  const wsum  = live.reduce((a, s) => a + s.weight, 0);
  const score = live.reduce((a, s) => a + s.weight * clamp(s.score, 1, 5), 0) / wsum;

  // The weakest provenance present governs the whole force. A force that is
  // three-quarters assumption must not be reported as observed.
  const rank  = { observed: 3, estimated: 2, assumed: 1 };
  const basis = live.reduce((worst, s) => (rank[s.basis] < rank[worst] ? s.basis : worst), 'observed');

  return {
    force: key,
    score: round1(score),
    band: band(score),
    basis,
    drivers: live
      .slice()
      .sort((a, b) => b.weight - a.weight)
      .map((s) => ({
        signal: s.label,
        value: s.display ?? null,
        points: round1(clamp(s.score, 1, 5)),
        basis: s.basis,
      })),
    note: null,
  };
}

const sig = (label, score, weight, basis, display) => ({ label, score, weight, basis, display });

/**
 * `facts` is one category's measured profile — see the service for how each is
 * loaded. Every field is nullable, and null means "we never measured it".
 */
export function assessFiveForces(facts = {}) {
  const f = facts;
  const spend        = num(f.spend_12m);
  const hhi          = num(f.hhi);                     // 0-1, 1 = one supplier has everything
  const suppliers    = num(f.supplier_count);
  const topShare     = num(f.top_supplier_share_pct);  // 0-100
  const soleShare    = num(f.single_source_item_pct);  // 0-100
  const avlDepth     = num(f.avg_approved_vendors_per_item);
  const leadTime     = num(f.avg_lead_time_days);
  const toolingShare = num(f.tooled_item_pct);         // 0-100; custom parts don't move cheaply
  const quotesPerRfq = num(f.avg_quotes_per_rfq);
  const priceSpread  = num(f.price_spread_pct);        // 0-100 dispersion, same item, across vendors
  const newVendors   = num(f.new_qualified_vendors_12m);
  const spendShare   = num(f.share_of_total_spend_pct); // this category as % of all procurement
  const makeCapable  = num(f.make_option_item_pct);     // 0-100, items flagged make-or-buy = make
  const altVendors   = num(f.avg_priced_vendors_per_item);

  // ── Supplier power: concentration + captivity ───────────────────────────────
  const supplier_power = scoreForce('supplier_power', [
    hhi === null ? null : sig('Spend concentration (HHI)', 1 + 4 * clamp(hhi, 0, 1), 3, 'observed', round2(hhi)),
    suppliers === null ? null : sig('Suppliers used',
      suppliers <= 1 ? 5 : suppliers === 2 ? 4.2 : suppliers <= 4 ? 3.2 : suppliers <= 8 ? 2.2 : 1.5,
      2.5, 'observed', suppliers),
    topShare === null ? null : sig('Largest supplier share', 1 + 4 * clamp(topShare / 100, 0, 1), 2, 'observed', `${round1(topShare)}%`),
    soleShare === null ? null : sig('Sole-sourced items', 1 + 4 * clamp(soleShare / 100, 0, 1), 2, 'estimated', `${round1(soleShare)}%`),
    avlDepth === null ? null : sig('Approved vendors per item',
      avlDepth >= 3 ? 1.5 : avlDepth >= 2 ? 2.5 : avlDepth >= 1 ? 4 : 5,
      1.5, 'observed', round1(avlDepth)),
    toolingShare === null ? null : sig('Tooled / custom items', 1 + 4 * clamp(toolingShare / 100, 0, 1), 1.5, 'estimated', `${round1(toolingShare)}%`),
    leadTime === null ? null : sig('Average lead time',
      leadTime >= 90 ? 4.5 : leadTime >= 45 ? 3.5 : leadTime >= 21 ? 2.5 : 1.8,
      1, 'estimated', `${Math.round(leadTime)}d`),
  ]);

  // ── Our buyer power: size, alternatives, and being worth bidding for ────────
  const buyer_power_ours = scoreForce('buyer_power_ours', [
    spendShare === null ? null : sig('Share of our total spend',
      spendShare >= 25 ? 4.6 : spendShare >= 10 ? 3.8 : spendShare >= 3 ? 2.8 : spendShare >= 1 ? 2 : 1.4,
      2.5, 'observed', `${round1(spendShare)}%`),
    spend === null ? null : sig('Category spend (12m)',
      spend >= 10000000 ? 4.6 : spend >= 2500000 ? 3.8 : spend >= 500000 ? 3 : spend >= 50000 ? 2.2 : 1.4,
      2, 'observed', spend),
    altVendors === null ? null : sig('Priced alternatives per item',
      altVendors >= 3 ? 4.4 : altVendors >= 2 ? 3.4 : altVendors >= 1 ? 2.2 : 1.4,
      2, 'observed', round1(altVendors)),
    quotesPerRfq === null ? null : sig('Bidders we can convene',
      quotesPerRfq >= 4 ? 4.4 : quotesPerRfq >= 3 ? 3.6 : quotesPerRfq >= 2 ? 2.8 : 1.8,
      1.5, 'observed', round1(quotesPerRfq)),
    // Being able to walk away is buyer power, and it is the one lever a small
    // buyer still holds.
    makeCapable === null ? null : sig('Could be made in-house', 1 + 3 * clamp(makeCapable / 100, 0, 1), 1, 'estimated', `${round1(makeCapable)}%`),
  ]);

  // ── Rivalry among suppliers: do they actually fight for it? ─────────────────
  const rivalry = scoreForce('rivalry', [
    quotesPerRfq === null ? null : sig('Quotes per RFQ',
      quotesPerRfq >= 5 ? 4.8 : quotesPerRfq >= 4 ? 4.2 : quotesPerRfq >= 3 ? 3.4 : quotesPerRfq >= 2 ? 2.4 : 1.3,
      3, 'observed', round1(quotesPerRfq)),
    priceSpread === null ? null : sig('Price spread across vendors',
      priceSpread >= 25 ? 4.5 : priceSpread >= 12 ? 3.6 : priceSpread >= 5 ? 2.8 : 1.8,
      2.5, 'observed', `${round1(priceSpread)}%`),
    suppliers === null ? null : sig('Suppliers in play',
      suppliers >= 8 ? 4.5 : suppliers >= 5 ? 3.8 : suppliers >= 3 ? 3 : suppliers >= 2 ? 2.2 : 1.2,
      2, 'observed', suppliers),
    hhi === null ? null : sig('Concentration (inverse)', 5 - 4 * clamp(hhi, 0, 1), 1.5, 'observed', round2(hhi)),
  ]);

  // ── New entrants: is the bench refreshing? ──────────────────────────────────
  const new_entrants = scoreForce('new_entrants', [
    newVendors === null ? null : sig('Vendors qualified (12m)',
      newVendors >= 5 ? 4.5 : newVendors >= 3 ? 3.8 : newVendors >= 1 ? 2.8 : 1.5,
      3, 'observed', newVendors),
    toolingShare === null ? null : sig('Tooling barrier (inverse)', 5 - 4 * clamp(toolingShare / 100, 0, 1), 2, 'estimated', `${round1(toolingShare)}%`),
    avlDepth === null ? null : sig('AVL breadth',
      avlDepth >= 3 ? 4 : avlDepth >= 2 ? 3.2 : avlDepth >= 1 ? 2.2 : 1.5,
      1.5, 'observed', round1(avlDepth)),
  ]);

  // ── Substitutes: can the requirement be met another way? ────────────────────
  const substitutes = scoreForce('substitutes', [
    makeCapable === null ? null : sig('Make-in-house option', 1 + 4 * clamp(makeCapable / 100, 0, 1), 2.5, 'estimated', `${round1(makeCapable)}%`),
    altVendors === null ? null : sig('Interchangeable sources priced',
      altVendors >= 3 ? 4.2 : altVendors >= 2 ? 3.4 : altVendors >= 1 ? 2.2 : 1.4,
      2, 'observed', round1(altVendors)),
    toolingShare === null ? null : sig('Standard (untooled) items', 5 - 4 * clamp(toolingShare / 100, 0, 1), 2, 'estimated', `${round1(toolingShare)}%`),
  ]);

  const forces = [supplier_power, buyer_power_ours, rivalry, new_entrants, substitutes];
  const rated  = forces.filter((x) => x.score != null);

  return {
    forces,
    coverage_pct: Math.round((rated.length / forces.length) * 100),
    rated_count: rated.length,
  };
}

// ── The Purchasing Chessboard ─────────────────────────────────────────────────

/**
 * 4 quadrants x 4 levers x 4 methods = 64.
 *
 * `signal` on a method is the fact pattern that makes it worth proposing HERE
 * rather than in general; `requires` is what has to be true before it can be
 * executed at all. Both are surfaced, because a recommendation a buyer cannot
 * act on this quarter is noise.
 */
export const CHESSBOARD = Object.freeze({
  manage_spend: {
    key: 'manage_spend',
    quadrant: 'Manage Spend',
    axis: { demand: 'low', supply: 'low' },
    thesis:
      'Neither side has leverage. There is no big negotiation to win here — the money is in buying less, buying it the same way twice, and stopping spend leaking around the process.',
    levers: [
      { key: 'closed_loop_spend', label: 'Closed Loop Spend Management', methods: [
        { key: 'spend_transparency',     label: 'Spend transparency',             signal: 'uncategorised_spend', requires: 'Items classified to a category' },
        { key: 'maverick_elimination',   label: 'Maverick spend elimination',     signal: 'off_avl_spend',       requires: 'PR-to-PO linkage' },
        { key: 'catalogue_buying',       label: 'Catalogue / punch-out buying',   signal: 'many_small_pos',      requires: 'Price list per vendor' },
        { key: 'po_compliance_audit',    label: 'PO & invoice compliance audit',  signal: 'price_variance',      requires: '3-way match enabled' },
      ] },
      { key: 'volume_bundling', label: 'Volume Bundling', methods: [
        { key: 'bundle_sites',           label: 'Bundle across sites',            signal: 'multi_branch_spend',  requires: 'Branch-level spend' },
        { key: 'bundle_categories',      label: 'Bundle adjacent categories',     signal: 'shared_suppliers',    requires: 'Supplier overlap' },
        { key: 'bundle_periods',         label: 'Bundle into an annual contract', signal: 'many_small_pos',      requires: '12-month demand forecast' },
        { key: 'group_buying',           label: 'Group / consortium buying',      signal: 'low_spend_share',     requires: 'External buying group' },
      ] },
      { key: 'compliance_management', label: 'Compliance Management', methods: [
        { key: 'contract_rate_enforce',  label: 'Enforce contracted rates',       signal: 'price_variance',      requires: 'Agreed price list' },
        { key: 'avl_enforcement',        label: 'Enforce the approved vendor list', signal: 'off_avl_spend',     requires: 'AVL populated' },
        { key: 'preferred_substitution', label: 'Substitute to preferred items',  signal: 'fragmented_items',    requires: 'Item standardisation' },
        { key: 'terms_standardisation',  label: 'Standardise payment terms',      signal: 'terms_dispersion',    requires: 'Terms captured on PO' },
      ] },
      { key: 'demand_reduction', label: 'Demand Reduction', methods: [
        { key: 'consumption_audit',      label: 'Consumption audit',              signal: 'consumption_data',    requires: 'Issue / consumption history' },
        { key: 'reorder_tuning',         label: 'Reorder point tuning',           signal: 'many_small_pos',      requires: 'Reorder levels set' },
        { key: 'spec_standardisation',   label: 'Standardise specifications',     signal: 'fragmented_items',    requires: 'Item master hygiene' },
        { key: 'reuse_refurbish',        label: 'Reuse & refurbish',              signal: 'asset_category',      requires: 'Asset register' },
      ] },
    ],
  },

  leverage_competition: {
    key: 'leverage_competition',
    quadrant: 'Leverage Competition',
    axis: { demand: 'high', supply: 'low' },
    thesis:
      'A contested supply market and a buyer who matters. This is where a well-run tender beats any relationship — put the volume in play and let the market price it.',
    levers: [
      { key: 'global_sourcing', label: 'Global Sourcing', methods: [
        { key: 'lcc_sourcing',           label: 'Low-cost-country sourcing',      signal: 'domestic_only',       requires: 'Import capability' },
        { key: 'direct_from_maker',      label: 'Buy direct from the manufacturer', signal: 'high_spend',        requires: 'Volume above maker MOQ' },
        { key: 'duty_optimisation',      label: 'Duty & incoterm optimisation',   signal: 'import_spend',        requires: 'Landed cost captured' },
        { key: 'multi_region_dual',      label: 'Multi-region dual source',       signal: 'concentrated_supply', requires: 'Two qualified regions' },
      ] },
      { key: 'tendering', label: 'Tendering Optimisation', methods: [
        { key: 'open_rfq',               label: 'Open competitive RFQ',           signal: 'thin_bidding',        requires: '3+ qualified vendors' },
        { key: 'sealed_bid',             label: 'Sealed-bid round',               signal: 'price_spread',        requires: 'RFQ workflow' },
        { key: 'reverse_auction',        label: 'Reverse auction',                signal: 'fragmented_items',    requires: 'Standard specification' },
        { key: 'bid_repackaging',        label: 'Restructure the bid package',    signal: 'many_small_pos',      requires: 'Demand aggregation' },
      ] },
      { key: 'target_pricing', label: 'Target Pricing', methods: [
        { key: 'should_cost',            label: 'Should-cost model',              signal: 'price_variance',      requires: 'Cost drivers known' },
        { key: 'open_book_request',      label: 'Cost breakdown request',         signal: 'high_spend',          requires: 'Supplier willingness' },
        { key: 'benchmark_index',        label: 'Benchmark price index',          signal: 'price_history',       requires: 'Price history depth' },
        { key: 'tco_award',              label: 'Award on total cost, not price', signal: 'tco_available',       requires: 'TCO enabled (§128)' },
      ] },
      { key: 'pricing_restrictions', label: 'Supplier Pricing Restrictions', methods: [
        { key: 'escalation_cap',         label: 'Cap price escalation',           signal: 'price_variance',      requires: 'Contract in place' },
        { key: 'index_linked',           label: 'Index-linked pricing',           signal: 'price_history',       requires: 'Public index' },
        { key: 'volume_rebate',          label: 'Volume rebate tiers',            signal: 'high_spend',          requires: 'Forecast volume' },
        { key: 'validity_extension',     label: 'Extend price validity',          signal: 'short_validity',      requires: 'Quote validity captured' },
      ] },
    ],
  },

  seek_joint_advantage: {
    key: 'seek_joint_advantage',
    quadrant: 'Seek Joint Advantage',
    axis: { demand: 'high', supply: 'high' },
    thesis:
      'Both sides hold power, so squeezing gets squeezed back. The value here is created jointly — in the design, the process and the flow — and then shared.',
    levers: [
      { key: 'value_partnership', label: 'Value Partnership', methods: [
        { key: 'long_term_agreement',    label: 'Long-term agreement',            signal: 'concentrated_supply', requires: 'Multi-year demand view' },
        { key: 'joint_roadmap',          label: 'Joint product roadmap',          signal: 'critical_supplier',   requires: 'Engineering engagement' },
        { key: 'design_to_cost',         label: 'Design-to-cost workshop',        signal: 'high_spend',          requires: 'Design authority' },
        { key: 'value_engineering',      label: 'Value engineering (VA/VE)',      signal: 'tooled_items',        requires: 'Spec change possible' },
      ] },
      { key: 'cost_partnership', label: 'Cost Partnership', methods: [
        { key: 'open_book_costing',      label: 'Open-book costing',              signal: 'concentrated_supply', requires: 'Trusted relationship' },
        { key: 'cost_regression',        label: 'Cost regression analysis',       signal: 'price_history',       requires: 'Price + driver history' },
        { key: 'shared_savings',         label: 'Shared productivity savings',    signal: 'high_spend',          requires: 'Baseline agreed' },
        { key: 'process_benchmark',      label: 'Process benchmarking',           signal: 'quality_issues',      requires: 'Supplier process access' },
      ] },
      { key: 'supplier_development', label: 'Supplier Development', methods: [
        { key: 'capability_build',       label: 'Capability build programme',     signal: 'thin_bench',          requires: 'Development budget' },
        { key: 'quality_programme',      label: 'Quality improvement programme',  signal: 'quality_issues',      requires: 'NCR / CAPA history' },
        { key: 'lead_time_project',      label: 'Lead time reduction project',    signal: 'long_lead_time',      requires: 'Lead time measured' },
        { key: 'capacity_reservation',   label: 'Capacity reservation',           signal: 'long_lead_time',      requires: 'Forecast commitment' },
      ] },
      { key: 'value_chain_management', label: 'Value Chain Management', methods: [
        { key: 'vmi',                    label: 'Vendor-managed inventory',       signal: 'many_small_pos',      requires: 'Stock visibility sharing' },
        { key: 'consignment',            label: 'Consignment stock',              signal: 'long_lead_time',      requires: 'Consignment accounting' },
        { key: 'supplier_kanban',        label: 'Supplier kanban / JIT',          signal: 'many_small_pos',      requires: 'Stable takt' },
        { key: 'integrated_logistics',   label: 'Integrated logistics',           signal: 'freight_spend',       requires: 'Freight captured' },
      ] },
    ],
  },

  change_nature_of_demand: {
    key: 'change_nature_of_demand',
    quadrant: 'Change Nature of Demand',
    axis: { demand: 'low', supply: 'high' },
    thesis:
      'They hold the power and we are too small to change that by negotiating. The only real moves change what we are asking for — the specification, the technology, or the risk we are carrying.',
    levers: [
      { key: 'spec_redefinition', label: 'Specification Redefinition', methods: [
        { key: 'technical_data_mining',  label: 'Technical data mining',          signal: 'tooled_items',        requires: 'Drawings / specs available' },
        { key: 'function_spec',          label: 'Function-based specification',   signal: 'sole_source',         requires: 'Engineering sign-off' },
        { key: 'despec_to_standard',     label: 'De-spec to a standard part',     signal: 'tooled_items',        requires: 'Standard equivalent exists' },
        { key: 'alt_material',           label: 'Qualify an alternate material',  signal: 'sole_source',         requires: 'Qualification capacity' },
      ] },
      { key: 'innovation_breakthrough', label: 'Innovation Breakthrough', methods: [
        { key: 'tech_scouting',          label: 'Alternate technology scouting',  signal: 'sole_source',         requires: 'Market research' },
        { key: 'new_entrant_qual',       label: 'Qualify a new entrant',          signal: 'thin_bench',          requires: 'Qualification process' },
        { key: 'substitute_trial',       label: 'Substitute product trial',       signal: 'substitutes_exist',   requires: 'Trial capacity' },
        { key: 'challenger_codev',       label: 'Co-develop with a challenger',   signal: 'concentrated_supply', requires: 'Development budget' },
      ] },
      { key: 'risk_management', label: 'Risk Management', methods: [
        { key: 'dual_source_qual',       label: 'Qualify a second source',        signal: 'sole_source',         requires: 'Qualification capacity' },
        { key: 'buffer_build',           label: 'Build a buffer / safety stock',  signal: 'long_lead_time',      requires: 'Working capital' },
        { key: 'long_term_supply',       label: 'Lock a long-term supply contract', signal: 'concentrated_supply', requires: 'Multi-year demand view' },
        { key: 'risk_monitoring',        label: 'Continuous supplier risk monitoring', signal: 'critical_supplier', requires: 'Vendor health engine (§49G)' },
      ] },
      { key: 'demand_restructuring', label: 'Demand Restructuring', methods: [
        { key: 'make_vs_buy',            label: 'Re-run make-vs-buy',             signal: 'make_option',         requires: 'Internal capacity data' },
        { key: 'insource_critical',      label: 'Insource critical content',      signal: 'sole_source',         requires: 'Capex appetite' },
        { key: 'consolidate_to_one',     label: 'Consolidate volume to one source', signal: 'fragmented_small',  requires: 'Acceptance of dependency' },
        { key: 'demand_pooling',         label: 'Pool demand with peers',         signal: 'low_spend_share',     requires: 'External buying group' },
      ] },
    ],
  },
});

/** Flat list of all 64 — used by the UI's method picker and by the tests. */
export function allMethods() {
  const out = [];
  for (const q of Object.values(CHESSBOARD)) {
    for (const lever of q.levers) {
      for (const m of lever.methods) {
        out.push({ ...m, lever_key: lever.key, lever: lever.label, quadrant_key: q.key, quadrant: q.quadrant });
      }
    }
  }
  return out;
}

/** One method by key, with its lever and quadrant — for validating a save. */
export function findMethod(methodKey) {
  return allMethods().find((m) => m.key === methodKey) || null;
}

// ── Positioning ───────────────────────────────────────────────────────────────

/**
 * Collapse the five forces onto the chessboard's two axes.
 *
 * SUPPLY POWER is supplier power *net of* the three forces that erode it:
 * rivalry, new entrants and substitutes each make a supplier's position weaker,
 * so each is inverted before it is averaged in. That inversion is the whole
 * reason the five forces are worth scoring separately rather than eyeballing a
 * 2x2 — a category can have one dominant incumbent (supplier power 5) and still
 * be contestable because five others are qualified and quoting.
 *
 * DEMAND POWER is our own leverage, lifted where a genuine substitute exists,
 * because the ability to not buy at all is leverage.
 *
 * Forces that are `unrated` are skipped, never defaulted. An axis is null when
 * nothing under it was measured.
 */
export function positionOnChessboard(assessment = {}) {
  const by  = Object.fromEntries((assessment.forces || []).map((f) => [f.force, f]));
  const v   = (k) => (by[k] && by[k].score != null ? by[k].score : null);
  const inv = (x) => (x == null ? null : 6 - x);

  const supplyParts = [
    { s: v('supplier_power'),    w: 3 },
    { s: inv(v('rivalry')),      w: 1.5 },
    { s: inv(v('new_entrants')), w: 1 },
    { s: inv(v('substitutes')),  w: 1 },
  ].filter((p) => p.s != null);

  const demandParts = [
    { s: v('buyer_power_ours'), w: 3 },
    { s: v('substitutes'),      w: 1 },
  ].filter((p) => p.s != null);

  const wavg = (parts) =>
    parts.length ? parts.reduce((a, p) => a + p.s * p.w, 0) / parts.reduce((a, p) => a + p.w, 0) : null;

  const supply_power = round1(wavg(supplyParts));
  const demand_power = round1(wavg(demandParts));
  const coverage     = assessment.coverage_pct ?? 0;

  // Both axes must exist before a quadrant means anything. One axis alone puts
  // the category on a line, not in a box, and naming a quadrant off it would be
  // an invention.
  if (supply_power == null || demand_power == null) {
    return {
      supply_power, demand_power,
      supply_band: band(supply_power), demand_band: band(demand_power),
      quadrant_key: null, quadrant: null, thesis: null,
      margin: null, borderline: false,
      provisional: true,
      coverage_pct: coverage,
      reason: 'Not enough of the five forces could be measured to place this category on the board.',
    };
  }

  const hiDemand = demand_power >= 3;
  const hiSupply = supply_power >= 3;
  const key = hiDemand
    ? (hiSupply ? 'seek_joint_advantage' : 'leverage_competition')
    : (hiSupply ? 'change_nature_of_demand' : 'manage_spend');

  const q = CHESSBOARD[key];

  // Distance from the centre lines. A category at 3.05 / 2.95 sits on the
  // border and should read as such rather than as a clean verdict.
  const margin = round1(Math.min(Math.abs(demand_power - 3), Math.abs(supply_power - 3)));

  return {
    supply_power, demand_power,
    supply_band: band(supply_power), demand_band: band(demand_power),
    quadrant_key: key,
    quadrant: q.quadrant,
    thesis: q.thesis,
    margin,
    borderline: margin < 0.35,
    provisional: coverage < MIN_COVERAGE_PCT,
    coverage_pct: coverage,
    reason: coverage < MIN_COVERAGE_PCT
      ? `Only ${coverage}% of the five forces could be measured — treat this position as a hypothesis to confirm, not a conclusion.`
      : null,
  };
}

// ── Recommendation ────────────────────────────────────────────────────────────

/**
 * Which fact patterns are live in this category.
 *
 * Absent (null) facts simply do not fire. They never fire negatively, because
 * "we did not measure it" is not evidence against a play.
 */
function liveSignals(f = {}) {
  const n = (v) => num(v);
  const gt = (v, x) => n(v) != null && n(v) > x;
  const lt = (v, x) => n(v) != null && n(v) < x;

  return {
    uncategorised_spend: gt(f.uncategorised_spend_pct, 20),
    many_small_pos:      lt(f.avg_po_value, 50000) && gt(f.po_count, 3),
    price_variance:      gt(f.price_spread_pct, 10),
    price_spread:        gt(f.price_spread_pct, 10),
    off_avl_spend:       gt(f.off_avl_spend_pct, 10),
    low_spend_share:     lt(f.share_of_total_spend_pct, 3),
    high_spend:          n(f.spend_12m) != null && n(f.spend_12m) >= 1000000,
    thin_bidding:        lt(f.avg_quotes_per_rfq, 3),
    thin_bench:          lt(f.avg_approved_vendors_per_item, 2),
    sole_source:         gt(f.single_source_item_pct, 0),
    concentrated_supply: n(f.hhi) != null && n(f.hhi) >= 0.4,
    fragmented_small:    lt(f.hhi, 0.2) && lt(f.spend_12m, 500000),
    fragmented_items:    gt(f.item_count, 20),
    long_lead_time:      n(f.avg_lead_time_days) != null && n(f.avg_lead_time_days) >= 45,
    tooled_items:        gt(f.tooled_item_pct, 0),
    make_option:         gt(f.make_option_item_pct, 0),
    critical_supplier:   f.has_critical_supplier === true,
    quality_issues:      gt(f.open_ncr_count, 0),
    price_history:       n(f.price_points) != null && n(f.price_points) >= 6,
    tco_available:       f.tco_enabled === true,
    import_spend:        gt(f.import_spend_pct, 0),
    domestic_only:       n(f.import_spend_pct) != null && n(f.import_spend_pct) === 0,
    freight_spend:       gt(f.freight_spend_pct, 2),
    multi_branch_spend:  gt(f.branch_count, 1),
    shared_suppliers:    gt(f.shared_supplier_count, 0),
    short_validity:      gt(f.expiring_price_count, 0),
    terms_dispersion:    gt(f.distinct_payment_terms, 1),
    consumption_data:    gt(f.consumption_points, 0),
    asset_category:      f.is_asset_category === true,
    substitutes_exist:   n(f.substitutes_score) != null && n(f.substitutes_score) >= 3.4,
  };
}

const inr = (v) => Math.round(num(v, 0)).toLocaleString('en-IN');

const WHY = {
  uncategorised_spend: (f) => `${round1(f.uncategorised_spend_pct)}% of this spend is not classified to an item category`,
  many_small_pos:      (f) => `${f.po_count} POs averaging ₹${inr(f.avg_po_value)} — order cost is a real share of the total`,
  price_variance:      (f) => `${round1(f.price_spread_pct)}% price spread across vendors on the same item`,
  price_spread:        (f) => `${round1(f.price_spread_pct)}% price spread across vendors on the same item`,
  off_avl_spend:       (f) => `${round1(f.off_avl_spend_pct)}% of spend went to vendors not approved for the item`,
  low_spend_share:     (f) => `this category is only ${round1(f.share_of_total_spend_pct)}% of our procurement — alone we are not a priority customer`,
  high_spend:          (f) => `₹${inr(f.spend_12m)} of 12-month spend justifies the effort`,
  thin_bidding:        (f) => `RFQs here draw ${round1(f.avg_quotes_per_rfq)} quotes on average`,
  thin_bench:          (f) => `${round1(f.avg_approved_vendors_per_item)} approved vendors per item — there is no bench to fall back on`,
  sole_source:         (f) => `${round1(f.single_source_item_pct)}% of items have a single source`,
  concentrated_supply: (f) => `HHI ${round2(f.hhi)} — spend sits in very few hands`,
  fragmented_small:    (f) => `spend is spread thin (HHI ${round2(f.hhi)}) with no volume behind it`,
  fragmented_items:    (f) => `${f.item_count} distinct items in one category`,
  long_lead_time:      (f) => `${Math.round(num(f.avg_lead_time_days, 0))}-day average lead time`,
  tooled_items:        (f) => `${round1(f.tooled_item_pct)}% of items carry tooling — switching is not free`,
  make_option:         (f) => `${round1(f.make_option_item_pct)}% of items are already flagged make-capable`,
  critical_supplier:   ()  => `a supplier here is flagged business-critical`,
  quality_issues:      (f) => `${f.open_ncr_count} open NCR(s) against suppliers in this category`,
  price_history:       (f) => `${f.price_points} price points on record to regress against`,
  tco_available:       ()  => `total cost of ownership is switched on, so award can be made on it`,
  import_spend:        (f) => `${round1(f.import_spend_pct)}% of spend is already imported`,
  domestic_only:       ()  => `nothing in this category is sourced outside the country yet`,
  freight_spend:       (f) => `freight is ${round1(f.freight_spend_pct)}% of category spend`,
  multi_branch_spend:  (f) => `the same category is bought at ${f.branch_count} sites`,
  shared_suppliers:    (f) => `${f.shared_supplier_count} of these suppliers also serve other categories`,
  short_validity:      (f) => `${f.expiring_price_count} quoted price(s) expire inside the horizon`,
  terms_dispersion:    (f) => `${f.distinct_payment_terms} different payment terms in one category`,
  consumption_data:    ()  => `consumption history exists to audit against`,
  asset_category:      ()  => `these are assets, so reuse and refurbishment are on the table`,
  substitutes_exist:   ()  => `substitutes score as a live option`,
};

/**
 * Rank the quadrant's 16 methods for THIS category.
 *
 * Base fit comes from the quadrant (every method in the right quadrant starts
 * at 50). A signal observed in the category pushes a method up and states why.
 * The output is a shortlist a category manager argues with — not an answer.
 */
export function recommendMethods(position, facts = {}, assessment = {}) {
  if (!position || !position.quadrant_key) return [];

  const byForce = Object.fromEntries((assessment.forces || []).map((x) => [x.force, x]));
  const f = {
    ...facts,
    substitutes_score: byForce.substitutes ? byForce.substitutes.score : null,
  };
  const signals = liveSignals(f);
  const q = CHESSBOARD[position.quadrant_key];
  const out = [];

  for (const lever of q.levers) {
    for (const m of lever.methods) {
      const fired = signals[m.signal] === true;
      let fit = 50 + (fired ? 30 : 0);

      // A borderline or thinly-evidenced position must not hand out confident
      // plays; the discount is visible in the number the UI sorts on.
      if (position.borderline)  fit -= 8;
      if (position.provisional) fit -= 12;

      out.push({
        quadrant_key: q.key,
        quadrant: q.quadrant,
        lever_key: lever.key,
        lever: lever.label,
        method_key: m.key,
        method: m.label,
        requires: m.requires,
        fit: clamp(Math.round(fit), 0, 100),
        evidenced: fired,
        why: fired && WHY[m.signal] ? WHY[m.signal](f) : null,
      });
    }
  }

  return out.sort((a, b) => (Number(b.evidenced) - Number(a.evidenced)) || (b.fit - a.fit));
}

/**
 * The shortlist, spread across levers.
 *
 * Taking the top N by fit alone returns four variations of the same lever,
 * because the four methods under one lever share the signal that fired it. A
 * category manager needs to see the range of moves available, so the best
 * evidenced method from each lever comes first and only then does the list
 * backfill with second choices.
 */
export function topPlays(methods, limit = 5) {
  const evidenced = methods.filter((m) => m.evidenced);
  const seen = new Set();
  const firstPerLever = [];
  for (const m of evidenced) {
    if (seen.has(m.lever_key)) continue;
    seen.add(m.lever_key);
    firstPerLever.push(m);
  }
  const rest = evidenced.filter((m) => !firstPerLever.includes(m));
  return [...firstPerLever, ...rest].slice(0, limit);
}

/** One call: facts in, a positioned and recommended category out. */
export function analyseCategory(facts = {}) {
  const assessment = assessFiveForces(facts);
  const position   = positionOnChessboard(assessment);
  const methods    = recommendMethods(position, facts, assessment);
  return {
    forces: assessment.forces,
    coverage_pct: assessment.coverage_pct,
    position,
    recommendations: methods,
    top_plays: topPlays(methods, 5),
  };
}

export default {
  FORCES, CHESSBOARD, MIN_COVERAGE_PCT,
  assessFiveForces, positionOnChessboard, recommendMethods, analyseCategory,
  allMethods, findMethod, topPlays, band, num,
};
