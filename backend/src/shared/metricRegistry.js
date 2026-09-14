/**
 * metricRegistry.js — the semantic layer. What a metric IS, declared once.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two findings in the BI parity audit have the same root cause:
 *
 *   "Semantic model / measure language — ABSENT. Every metric is SQL hard-coded
 *    inside a route handler; changing a definition is a code change and a deploy."
 *
 *   "Dashboard builder — NOT WIRED. Four endpoints store a `query_config`
 *    payload that no code path ever reads or executes."
 *
 * The naive way to wire that builder up is to let `query_config` carry SQL and
 * run it. That is not a dashboard builder, it is an authenticated SQL console:
 * it defeats company scoping (a `WHERE` the user wrote does not include
 * `company_id`), defeats RBAC (payroll figures reachable from a procurement
 * dashboard), and hands every reader `pg_read_file` and friends.
 *
 * So `query_config` names a metric; it never describes one. The client sends
 * `{ metric, dimension, from, to, limit }`, every one of which is looked up in
 * a frozen table below and rejected if absent. NOTHING from the request is ever
 * interpolated into SQL — dimensions resolve through a fixed map to a fragment
 * written here, and dates and ids go through bind parameters.
 *
 * WHAT EACH METRIC OWES
 * ---------------------
 * id           stable key stored in query_config and in alert rules; renaming
 *              one orphans saved widgets, so treat it as an API
 * label/desc   user-facing copy, owned here so a widget cannot mislabel itself
 * unit         currency | count | percent | days — the UI formats from this
 *              rather than guessing from the value shape
 * permission   [module, action] the OWNING module would require. A metric is
 *              readable exactly when the module it comes from is. This is the
 *              same principle reportCatalog.js uses, and it is what stops the
 *              builder becoming a way around page-level gating.
 * dimensions   the only group-bys this metric accepts
 * time_column  what `from`/`to` filter on; null means the metric is a snapshot
 *              ("stock on hand today") and silently ignoring a date range on it
 *              would be a lie, so a date range against a snapshot is a 400
 * build()      returns { sql, params } producing exactly two output columns:
 *              `label` (text) and `value` (numeric). One shape, so the chart
 *              renderer never needs to know which metric it drew.
 *
 * ⚠ EVERY metric here is executed against the live database by
 * `metricRegistry.contract.test.js`. A metric naming a column that does not
 * exist fails that test rather than rendering an empty panel in production —
 * which is how `closed_won`, `WHERE … WHERE` and the 19 always-failing
 * statements in the Analyse module all survived to a release. A static
 * reference check cannot certify SQL; only running it can.
 */
import {
  notIn, isIn,
  sqlPoCommitted, sqlPoOpen, sqlTicketOpen, sqlEmployeeActive,
  sqlOpportunityOpen, sqlOpportunityWon, sqlInvoiceOutstanding,
  BILL_VOID,
} from './statusSets.js';

/** Rows a metric returns before truncation, and the ceiling a caller may ask for. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

/**
 * INR expressions, shared with the spend cube so a figure cannot drift between
 * a dashboard widget and the report it is supposed to summarise.
 *
 * `purchase_orders.total_amount` is denominated in the order's OWN currency;
 * summing it across a mixed-currency book adds dollars to rupees. That was a
 * live defect (19,000 reported where the truth was 173,000) and it is the
 * reason no metric below is allowed to reference `total_amount` directly.
 */
const poInr = (a = 'po') =>
  `COALESCE(${a}.total_amount_inr, ${a}.total_amount * COALESCE(NULLIF(${a}.exchange_rate, 0), 1), 0)`;
const billInr = (a = 'b') =>
  `COALESCE(${a}.total_amount, 0) * COALESCE(NULLIF(${a}.exchange_rate, 0), 1)`;
const invInr = (a = 'i') =>
  `COALESCE(${a}.total_amount, 0) * COALESCE(NULLIF(${a}.exchange_rate, 0), 1)`;

/**
 * A dimension is a (label expression, join, group-by) triple chosen from a
 * fixed map — never a column name taken from the request.
 *
 * `month` is emitted as YYYY-MM and ordered by the underlying date, not by the
 * formatted string, and never by the output alias: in Postgres `GROUP BY` binds
 * an alias to the RAW column of the same name when one exists, which is how a
 * gender breakdown in this codebase came to print "Not specified" twice.
 */
const DIMENSIONS = Object.freeze({
  month:         { label: 'Month' },
  quarter:       { label: 'Quarter' },
  vendor:        { label: 'Vendor' },
  commodity:     { label: 'Commodity category' },
  cost_centre:   { label: 'Cost centre' },
  project:       { label: 'Project' },
  supplier_type: { label: 'Supplier type' },
  status:        { label: 'Status' },
  department:    { label: 'Department' },
  category:      { label: 'Category' },
  priority:      { label: 'Priority' },
  stage:         { label: 'Stage' },
  customer:      { label: 'Customer' },
  team:          { label: 'Team' },
  none:          { label: 'Total' },
});

export const DIMENSION_LABELS = DIMENSIONS;

/** `TO_CHAR` on a date column, with the raw expression kept for ORDER BY. */
const monthOf = (col) => ({
  select: `TO_CHAR(DATE_TRUNC('month', ${col}), 'YYYY-MM')`,
  order: `DATE_TRUNC('month', ${col})`,
  asc: true,
});
const quarterOf = (col) => ({
  select: `TO_CHAR(DATE_TRUNC('quarter', ${col}), 'YYYY-"Q"Q')`,
  order: `DATE_TRUNC('quarter', ${col})`,
  asc: true,
});
/** A plain grouping column: label and ordering are the same expression. */
const plain = (expr, fallback = 'Unspecified') => ({
  select: `COALESCE(NULLIF(${expr}::text, ''), '${fallback}')`,
  order: null, // ordered by value DESC — biggest bar first
  asc: false,
});
/**
 * The single-row "grand total" dimension behind every KPI tile.
 *
 * `aggregate: true` means NO GROUP BY at all, rather than grouping on the
 * literal — `GROUP BY 'Committed spend'` is a "non-integer constant in GROUP BY"
 * error in Postgres, which is what this took on the first run against the live
 * database. Every metric here offers a `none` dimension, so that error was
 * twelve broken KPI tiles, one per metric, and none of them would have thrown
 * anywhere a user could see: the widget would simply have rendered empty.
 */
const constant = (text) => ({ select: `'${text}'`, order: null, asc: false, aggregate: true });

/**
 * Assemble a grouped aggregate from parts this file controls.
 *
 * Every caller passes `dims` as a literal object, so the only thing the request
 * chooses is WHICH key is read out of it. That is the whole safety property.
 */
function grouped({ select, from, where = [], dims, dimension, params, limit }) {
  const d = dims[dimension];
  if (!d) return null;

  // A grand total is one aggregate row over the whole filtered set: no GROUP BY,
  // and therefore no ORDER BY or LIMIT either.
  if (d.aggregate) {
    return {
      sql: `
    SELECT ${d.select} AS label,
           ${select}   AS value
    FROM ${from}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
      params,
    };
  }

  const orderBy = d.order
    ? `${d.order} ${d.asc ? 'ASC' : 'DESC'}`
    : `2 DESC NULLS LAST`;
  // Group on the RAW expression, never on the output alias: in Postgres a
  // GROUP BY naming an alias binds to a real column of that name when one
  // exists, which silently splits one bucket into two.
  const groupBy = d.order ? `${d.order}, ${d.select}` : d.select;
  const sql = `
    SELECT ${d.select} AS label,
           ${select}   AS value
    FROM ${from}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    GROUP BY ${groupBy}
    ORDER BY ${orderBy}
    LIMIT ${limit}`;
  return { sql, params };
}

/**
 * The scoping predicate every metric must carry.
 *
 * `companyOf(req)` yields null for a genuinely global (super-admin) scope, and
 * null in this predicate means "no filter" — which is correct there and ONLY
 * there. Every metric takes the company id from the resolved scope, never from
 * `req.user.company_id`, which is absent on older tokens and so fails OPEN
 * across tenants.
 */
function scope(params, companyId, col) {
  params.push(companyId ?? null);
  return `($${params.length}::INTEGER IS NULL OR ${col} = $${params.length}::INTEGER)`;
}

/** `from`/`to` as bind parameters against the metric's declared time column. */
function window(params, from, to, col) {
  const out = [];
  if (from) { params.push(from); out.push(`${col} >= $${params.length}::date`); }
  if (to)   { params.push(to);   out.push(`${col} <= $${params.length}::date`); }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// The metrics
// ───────────────────────────────────────────────────────────────────────────

export const METRICS = Object.freeze([
  // ── Procurement ──────────────────────────────────────────────────────────
  {
    id: 'procurement.committed_spend',
    label: 'Committed spend',
    desc: 'Value of purchase orders that represent a real commitment, in INR. Drafts, rejected and cancelled orders are excluded — a draft is not yet a commitment.',
    category: 'Procurement', unit: 'currency', permission: ['procurement', 'view'],
    time_column: 'po.order_date',
    dimensions: ['month', 'quarter', 'vendor', 'cost_centre', 'project', 'supplier_type', 'status', 'none'],
    default_dimension: 'month',
    build({ companyId, dimension, from, to, limit }) {
      const params = [];
      const where = [
        'po.deleted_at IS NULL',
        sqlPoCommitted('po.status'),
        scope(params, companyId, 'po.company_id'),
        ...window(params, from, to, 'po.order_date'),
      ];
      return grouped({
        select: `COALESCE(SUM(${poInr('po')}), 0)`,
        from: `purchase_orders po
               LEFT JOIN vendors v      ON v.id  = po.supplier_id
               LEFT JOIN cost_centers cc ON cc.id = po.cost_center_id
               LEFT JOIN projects pr    ON pr.id = po.project_id AND pr.deleted_at IS NULL`,
        where, params, limit, dimension,
        dims: {
          month:         monthOf('po.order_date'),
          quarter:       quarterOf('po.order_date'),
          vendor:        plain('v.vendor_name', 'Unknown'),
          cost_centre:   plain('cc.name', 'Unallocated'),
          project:       plain('pr.project_name', 'Unallocated'),
          supplier_type: plain('v.category', 'Uncategorised'),
          status:        plain('po.status'),
          none:          constant('Committed spend'),
        },
      });
    },
  },
  {
    id: 'procurement.po_count',
    label: 'Purchase orders raised',
    desc: 'Count of committed purchase orders. Same status rule as committed spend, so the two always agree on what an order is.',
    category: 'Procurement', unit: 'count', permission: ['procurement', 'view'],
    time_column: 'po.order_date',
    dimensions: ['month', 'quarter', 'vendor', 'cost_centre', 'status', 'none'],
    default_dimension: 'month',
    build({ companyId, dimension, from, to, limit }) {
      const params = [];
      const where = [
        'po.deleted_at IS NULL',
        sqlPoCommitted('po.status'),
        scope(params, companyId, 'po.company_id'),
        ...window(params, from, to, 'po.order_date'),
      ];
      return grouped({
        select: 'COUNT(*)::INT',
        from: `purchase_orders po
               LEFT JOIN vendors v       ON v.id  = po.supplier_id
               LEFT JOIN cost_centers cc ON cc.id = po.cost_center_id`,
        where, params, limit, dimension,
        dims: {
          month:       monthOf('po.order_date'),
          quarter:     quarterOf('po.order_date'),
          vendor:      plain('v.vendor_name', 'Unknown'),
          cost_centre: plain('cc.name', 'Unallocated'),
          status:      plain('po.status'),
          none:        constant('Purchase orders'),
        },
      });
    },
  },
  {
    id: 'procurement.open_po_value',
    label: 'Open PO value',
    desc: 'Value of purchase orders raised and not yet completed, received, closed or cancelled — the outstanding order book.',
    category: 'Procurement', unit: 'currency', permission: ['procurement', 'view'],
    time_column: 'po.order_date',
    dimensions: ['month', 'vendor', 'cost_centre', 'project', 'none'],
    default_dimension: 'vendor',
    build({ companyId, dimension, from, to, limit }) {
      const params = [];
      const where = [
        'po.deleted_at IS NULL',
        sqlPoCommitted('po.status'),
        sqlPoOpen('po.status'),
        scope(params, companyId, 'po.company_id'),
        ...window(params, from, to, 'po.order_date'),
      ];
      return grouped({
        select: `COALESCE(SUM(${poInr('po')}), 0)`,
        from: `purchase_orders po
               LEFT JOIN vendors v       ON v.id  = po.supplier_id
               LEFT JOIN cost_centers cc ON cc.id = po.cost_center_id
               LEFT JOIN projects pr     ON pr.id = po.project_id AND pr.deleted_at IS NULL`,
        where, params, limit, dimension,
        dims: {
          month:       monthOf('po.order_date'),
          vendor:      plain('v.vendor_name', 'Unknown'),
          cost_centre: plain('cc.name', 'Unallocated'),
          project:     plain('pr.project_name', 'Unallocated'),
          none:        constant('Open PO value'),
        },
      });
    },
  },
  {
    id: 'procurement.invoiced_spend',
    label: 'Invoiced spend',
    desc: 'Supplier bills in INR, excluding drafts, cancelled and void. What was actually billed, as opposed to what was ordered.',
    category: 'Procurement', unit: 'currency', permission: ['finance', 'view'],
    time_column: 'b.bill_date',
    dimensions: ['month', 'quarter', 'vendor', 'status', 'none'],
    default_dimension: 'month',
    build({ companyId, dimension, from, to, limit }) {
      const params = [];
      const where = [
        'b.deleted_at IS NULL',
        notIn('b.status', BILL_VOID),
        scope(params, companyId, 'b.company_id'),
        ...window(params, from, to, 'b.bill_date'),
      ];
      return grouped({
        select: `COALESCE(SUM(${billInr('b')}), 0)`,
        from: 'bills b',
        where, params, limit, dimension,
        dims: {
          month:   monthOf('b.bill_date'),
          quarter: quarterOf('b.bill_date'),
          vendor:  plain('b.party_name', 'Unknown'),
          status:  plain('b.status'),
          none:    constant('Invoiced spend'),
        },
      });
    },
  },

  // ── Sales ────────────────────────────────────────────────────────────────
  {
    id: 'sales.open_pipeline',
    label: 'Open pipeline',
    desc: 'Expected value of opportunities not yet won or lost. Stages are `won`/`lost` in this schema — matching on `closed_won` returns zero rows and silently counts every closed deal as still open.',
    category: 'Sales', unit: 'currency', permission: ['crm', 'view'],
    time_column: 'o.created_at',
    dimensions: ['month', 'quarter', 'stage', 'none'],
    default_dimension: 'stage',
    build({ companyId, dimension, from, to, limit }) {
      const params = [];
      const where = [
        'o.deleted_at IS NULL',
        sqlOpportunityOpen('o.stage'),
        scope(params, companyId, 'o.company_id'),
        ...window(params, from, to, 'o.created_at::date'),
      ];
      return grouped({
        select: 'COALESCE(SUM(COALESCE(o.expected_value, 0)), 0)',
        from: 'opportunities o',
        where, params, limit, dimension,
        dims: {
          month:   monthOf('o.created_at'),
          quarter: quarterOf('o.created_at'),
          stage:   plain('o.stage'),
          none:    constant('Open pipeline'),
        },
      });
    },
  },
  {
    id: 'sales.won_value',
    label: 'Won deal value',
    desc: 'Expected value of opportunities in a won stage.',
    category: 'Sales', unit: 'currency', permission: ['crm', 'view'],
    time_column: 'o.created_at',
    dimensions: ['month', 'quarter', 'none'],
    default_dimension: 'month',
    build({ companyId, dimension, from, to, limit }) {
      const params = [];
      const where = [
        'o.deleted_at IS NULL',
        sqlOpportunityWon('o.stage'),
        scope(params, companyId, 'o.company_id'),
        ...window(params, from, to, 'o.created_at::date'),
      ];
      return grouped({
        select: 'COALESCE(SUM(COALESCE(o.expected_value, 0)), 0)',
        from: 'opportunities o',
        where, params, limit, dimension,
        dims: {
          month:   monthOf('o.created_at'),
          quarter: quarterOf('o.created_at'),
          none:    constant('Won value'),
        },
      });
    },
  },

  // ── Finance ──────────────────────────────────────────────────────────────
  {
    id: 'finance.receivables',
    label: 'Outstanding receivables',
    desc: 'Unpaid customer invoice balance in INR. Excludes drafts, cancelled and void.',
    category: 'Finance', unit: 'currency', permission: ['finance', 'view'],
    time_column: 'i.invoice_date',
    dimensions: ['month', 'customer', 'status', 'none'],
    default_dimension: 'month',
    build({ companyId, dimension, from, to, limit }) {
      const params = [];
      const where = [
        'i.deleted_at IS NULL',
        sqlInvoiceOutstanding('i.status'),
        scope(params, companyId, 'i.company_id'),
        ...window(params, from, to, 'i.invoice_date'),
      ];
      return grouped({
        // `balance` is the outstanding figure; where it was never populated the
        // total less what has been paid is the same number.
        select: `COALESCE(SUM(COALESCE(i.balance, ${invInr('i')} - COALESCE(i.paid_amount, 0))), 0)`,
        from: 'invoices i',
        where, params, limit, dimension,
        dims: {
          month:    monthOf('i.invoice_date'),
          customer: plain('i.party_name', 'Unknown'),
          status:   plain('i.status'),
          none:     constant('Receivables'),
        },
      });
    },
  },
  {
    id: 'finance.revenue',
    label: 'Invoiced revenue',
    desc: 'Customer invoices raised, in INR, excluding drafts, cancelled and void.',
    category: 'Finance', unit: 'currency', permission: ['finance', 'view'],
    time_column: 'i.invoice_date',
    dimensions: ['month', 'quarter', 'customer', 'none'],
    default_dimension: 'month',
    build({ companyId, dimension, from, to, limit }) {
      const params = [];
      const where = [
        'i.deleted_at IS NULL',
        notIn('i.status', ['cancelled', 'void', 'draft']),
        scope(params, companyId, 'i.company_id'),
        ...window(params, from, to, 'i.invoice_date'),
      ];
      return grouped({
        select: `COALESCE(SUM(${invInr('i')}), 0)`,
        from: 'invoices i',
        where, params, limit, dimension,
        dims: {
          month:    monthOf('i.invoice_date'),
          quarter:  quarterOf('i.invoice_date'),
          customer: plain('i.party_name', 'Unknown'),
          none:     constant('Revenue'),
        },
      });
    },
  },

  // ── Service ──────────────────────────────────────────────────────────────
  {
    id: 'service.open_tickets',
    label: 'Open tickets',
    desc: 'Support tickets not resolved, closed or cancelled.',
    category: 'Service', unit: 'count', permission: ['service', 'view'],
    time_column: 'ti.created_at',
    dimensions: ['month', 'priority', 'category', 'status', 'department', 'none'],
    default_dimension: 'priority',
    build({ companyId, dimension, from, to, limit }) {
      const params = [];
      const where = [
        'ti.deleted_at IS NULL',
        sqlTicketOpen('ti.status'),
        scope(params, companyId, 'ti.company_id'),
        ...window(params, from, to, 'ti.created_at::date'),
      ];
      return grouped({
        select: 'COUNT(*)::INT',
        from: 'support_tickets ti',
        where, params, limit, dimension,
        dims: {
          month:      monthOf('ti.created_at'),
          priority:   plain('ti.priority'),
          category:   plain('ti.category'),
          status:     plain('ti.status'),
          department: plain('ti.department'),
          none:       constant('Open tickets'),
        },
      });
    },
  },
  {
    id: 'service.sla_breaches',
    label: 'SLA breaches',
    desc: 'Tickets flagged as having breached their service level.',
    category: 'Service', unit: 'count', permission: ['service', 'view'],
    time_column: 'ti.created_at',
    dimensions: ['month', 'priority', 'team', 'none'],
    default_dimension: 'month',
    build({ companyId, dimension, from, to, limit }) {
      const params = [];
      const where = [
        'ti.deleted_at IS NULL',
        'ti.sla_breached IS TRUE',
        scope(params, companyId, 'ti.company_id'),
        ...window(params, from, to, 'ti.created_at::date'),
      ];
      return grouped({
        select: 'COUNT(*)::INT',
        from: 'support_tickets ti',
        where, params, limit, dimension,
        dims: {
          month:    monthOf('ti.created_at'),
          priority: plain('ti.priority'),
          team:     plain('ti.team'),
          none:     constant('SLA breaches'),
        },
      });
    },
  },

  // ── People ───────────────────────────────────────────────────────────────
  // Gated on `hr:view`, NOT on a self-service permission. Every employee holds
  // `attendance:view` and `leave:view` so they can open their own record —
  // gating a company-wide roster on one of those leaves it open to everyone.
  {
    id: 'hr.headcount',
    label: 'Headcount',
    desc: 'Employees in an active status (including probation, notice and confirmed).',
    category: 'People', unit: 'count', permission: ['hr', 'view'],
    time_column: null, // a snapshot: "how many people are employed", asked of today
    dimensions: ['department', 'status', 'none'],
    default_dimension: 'department',
    build({ companyId, dimension, limit }) {
      const params = [];
      const where = [
        'e.deleted_at IS NULL',
        sqlEmployeeActive('e.status'),
        scope(params, companyId, 'e.company_id'),
      ];
      return grouped({
        select: 'COUNT(*)::INT',
        from: 'employees e',
        where, params, limit, dimension,
        dims: {
          department: plain('e.department'),
          status:     plain('e.status'),
          none:       constant('Headcount'),
        },
      });
    },
  },

  // ── Inventory ────────────────────────────────────────────────────────────
  {
    id: 'inventory.stock_value',
    label: 'Stock on hand value',
    desc: 'Current stock valued at standard cost. A snapshot of today, so it takes no date range.',
    category: 'Inventory', unit: 'currency', permission: ['inventory', 'view'],
    time_column: null,
    dimensions: ['commodity', 'category', 'none'],
    default_dimension: 'commodity',
    build({ companyId, dimension, limit }) {
      const params = [];
      const where = [
        'ii.deleted_at IS NULL',
        scope(params, companyId, 'ii.company_id'),
      ];
      return grouped({
        select: 'COALESCE(SUM(COALESCE(ii.current_stock, 0) * COALESCE(ii.standard_cost, 0)), 0)',
        from: `inventory_items ii
               LEFT JOIN item_categories ic ON ic.id = ii.category_id AND ic.deleted_at IS NULL`,
        where, params, limit, dimension,
        dims: {
          commodity: plain('ic.name', 'Unclassified'),
          category:  plain('ii.abc_class', 'Unclassified'),
          none:      constant('Stock value'),
        },
      });
    },
  },
]);

/** id → metric, built once. */
const BY_ID = new Map(METRICS.map((m) => [m.id, m]));

export const getMetric = (id) => BY_ID.get(id) ?? null;

/**
 * The catalog a picker renders. Never ships `build` — that is server-side only,
 * and shipping it would invite a client to think it can supply one.
 */
export function listMetrics() {
  return METRICS.map(({ build, ...rest }) => ({
    ...rest,
    dimensions: rest.dimensions.map((d) => ({
      id: d,
      label: DIMENSIONS[d]?.label ?? d,
    })),
    accepts_date_range: rest.time_column !== null,
  }));
}

export function resolveLimit(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/** A YYYY-MM-DD the caller supplied, or null. Anything else is rejected. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate a stored or submitted `query_config` against this registry.
 *
 * Returns `{ ok: true, config }` or `{ ok: false, error }`. Every rejection is
 * explicit: a widget pointing at a metric that no longer exists must say so,
 * not render an empty chart. A silently-dropped filter is the defect
 * reportCatalog.js was written to prevent, and the same rule holds here.
 */
export function validateQueryConfig(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'query_config must be an object' };
  }

  const metric = getMetric(raw.metric);
  if (!metric) {
    return {
      ok: false,
      error: `Unknown metric '${raw.metric}'. See GET /intelligence/metrics for the catalog.`,
    };
  }

  const dimension = raw.dimension ?? metric.default_dimension;
  if (!metric.dimensions.includes(dimension)) {
    return {
      ok: false,
      error: `Metric '${metric.id}' cannot be grouped by '${dimension}'. Allowed: ${metric.dimensions.join(', ')}.`,
    };
  }

  for (const key of ['from', 'to']) {
    const v = raw[key];
    if (v == null || v === '') continue;
    if (!DATE_RE.test(String(v))) {
      return { ok: false, error: `'${key}' must be a YYYY-MM-DD date` };
    }
    // A snapshot metric has no time column. Accepting a range and ignoring it
    // would hand back today's number under a historical heading.
    if (metric.time_column === null) {
      return {
        ok: false,
        error: `Metric '${metric.id}' is a snapshot of the present and does not accept a date range.`,
      };
    }
  }

  if (raw.chart_type != null && !CHART_TYPES.includes(raw.chart_type)) {
    return {
      ok: false,
      error: `Unknown chart_type '${raw.chart_type}'. Allowed: ${CHART_TYPES.join(', ')}.`,
    };
  }

  return {
    ok: true,
    config: {
      metric: metric.id,
      dimension,
      from: raw.from || null,
      to: raw.to || null,
      limit: resolveLimit(raw.limit),
      chart_type: raw.chart_type ?? defaultChartFor(metric, dimension),
    },
  };
}

/**
 * Chart types the renderer implements. Declared here rather than in the React
 * page so a widget cannot be saved asking for a chart that cannot be drawn.
 */
export const CHART_TYPES = Object.freeze([
  'bar', 'column', 'line', 'area', 'pie', 'donut', 'treemap', 'waterfall',
  'scatter', 'funnel', 'kpi', 'table',
]);

/** A sensible default so a widget saved without one still renders correctly. */
function defaultChartFor(metric, dimension) {
  if (dimension === 'none') return 'kpi';
  if (dimension === 'month' || dimension === 'quarter') return 'line';
  return 'bar';
}

/**
 * Build the SQL for a validated config. Takes the ALREADY-VALIDATED shape —
 * callers must run `validateQueryConfig` first, and the executor does.
 */
export function buildMetricQuery(config, { companyId }) {
  const metric = getMetric(config.metric);
  if (!metric) throw new Error(`Unknown metric '${config.metric}'`);
  const built = metric.build({
    companyId,
    dimension: config.dimension,
    from: config.from,
    to: config.to,
    limit: config.limit,
  });
  if (!built) {
    throw new Error(`Metric '${metric.id}' does not support dimension '${config.dimension}'`);
  }
  return built;
}

export default {
  METRICS, CHART_TYPES, DIMENSION_LABELS,
  getMetric, listMetrics, validateQueryConfig, buildMetricQuery, resolveLimit,
  DEFAULT_LIMIT, MAX_LIMIT,
};
