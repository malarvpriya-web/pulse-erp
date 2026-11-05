// backend/src/modules/inventory/services/ledgerSemantics.js
//
// What a stock_ledger row MEANS for demand. The one definition every demand
// reader uses: ABC annual consumption value, XYZ monthly series, FSN last issue,
// inventory turnover, Store Cost Analysis EOQ, the slow-mover and obsolete
// lists, and procurement's what-if EOQ.
//
// WHY AN INCLUSION MAP, NOT AN EXCLUSION LIST
// The previous definition was "quantity_out > 0 and the type is not in
// ['transfer', 'bin_transfer', <seed filler>]". Everything else that left a
// warehouse counted as consumption: a return to the vendor, a cycle-count loss,
// a stock write-down, and any type added later by a module nobody told. Store
// Cost Analysis had a different list again (only 'transfer'), and the
// slow-mover / obsolete lists had none at all, so a bin move made a dormant
// part look issued. A type now counts as demand only if it is classified as an
// issue here; an unclassified type counts as nothing and is reported
// (unclassifiedTransactionTypes) instead of silently becoming consumption.
//
// HOW EACH TYPE WAS CLASSIFIED — from its WRITER, not its name. Every writer of
// stock_ledger in the codebase was read (2026-10-21); the side each posts on is
// noted.
//
//   ISSUE — genuine consumption or a customer issue (quantity_out)
//     consumption             rmIssue.service (material issue to production) + legacy data
//     issue                   POST /inventory/stock/movement (OUT), RM issue, IoT service part
//     production_issue        execution.routes — material issued to a work order
//     production_consumption  execution.routes — backflush on completion
//     rework_issue            execution.routes — material issued for rework
//     sc_issue                subcontracting.routes — material sent to a subcontractor
//     service_issue           servicedesk field visit — part used (OUT); a part
//                             removed from the visit posts quantity_IN under the
//                             same type, and is a reversal (below)
//     maintenance_issue       maintenance.routes — spare issued to a work order
//     dispatch                warehouse.routes — sales-order pick / ship
//     sales_dispatch          cogsJournal.service — stock-out written on invoice
//
//   ISSUE_REVERSAL — a return of something previously issued (quantity_in);
//   nets AGAINST demand in the month it is booked
//     sales_return            scmPlanning.routes — customer return
//     production_return       execution.routes — unused material back from a work order
//     rework_return           execution.routes — reusable part removed in rework
//     <any ISSUE type> with quantity_in > 0   (service_issue reductions)
//
//   Not demand — never counted, in either direction
//     RECEIPT        receipt, purchase (GRN), batch_receipt, inward, production_receipt,
//                    sc_receipt, maintenance_receipt, opening
//     TRANSFER       transfer, bin_transfer (in = out), put_away (0 / 0)
//     VENDOR_RETURN  return — grn.service return-to-vendor: stock leaves, nobody consumed it
//     ADJUSTMENT     adjustment (stock adjustments, ledger reconciliation),
//                    cycle_count (count variance), maintenance_adjustment —
//                    gains and losses are tracked as adjustments, not consumption
//     LEGACY_FILLER  standard, general, primary, routine — the seeding scripts' filler
//
// REVERSAL POLICY
// A reversal reduces demand in the month it is BOOKED, and a month's demand is
// floored at zero. Reversals are not traced back to the month of the original
// issue: the ledger carries no link from a return row to its issue row for most
// writers (sales_return, production_return reference the order, not the issue
// line), so tracing would succeed for some returns and not others — two
// policies at once. FSN is unaffected by reversals: it dates the last ISSUE.
//
// AMBIGUITIES AWAITING A BUSINESS DECISION are listed in AMBIGUOUS_TYPES.

export const LEDGER_CLASS = Object.freeze({
  ISSUE:          'issue',
  ISSUE_REVERSAL: 'issue_reversal',
  RECEIPT:        'receipt',
  TRANSFER:       'transfer',
  VENDOR_RETURN:  'vendor_return',
  ADJUSTMENT:     'adjustment',
  LEGACY_FILLER:  'legacy_filler',
  UNKNOWN:        'unknown',
});

const C = LEDGER_CLASS;

/** transaction_type (lower case) -> class. Anything absent is UNKNOWN. */
export const TRANSACTION_TYPE_CLASS = Object.freeze({
  consumption: C.ISSUE, issue: C.ISSUE, production_issue: C.ISSUE,
  production_consumption: C.ISSUE, rework_issue: C.ISSUE, sc_issue: C.ISSUE,
  service_issue: C.ISSUE, maintenance_issue: C.ISSUE,
  dispatch: C.ISSUE, sales_dispatch: C.ISSUE,

  sales_return: C.ISSUE_REVERSAL, production_return: C.ISSUE_REVERSAL, rework_return: C.ISSUE_REVERSAL,

  receipt: C.RECEIPT, purchase: C.RECEIPT, batch_receipt: C.RECEIPT, inward: C.RECEIPT,
  production_receipt: C.RECEIPT, sc_receipt: C.RECEIPT, maintenance_receipt: C.RECEIPT,
  opening: C.RECEIPT,

  transfer: C.TRANSFER, bin_transfer: C.TRANSFER, put_away: C.TRANSFER,

  return: C.VENDOR_RETURN,

  adjustment: C.ADJUSTMENT, cycle_count: C.ADJUSTMENT, maintenance_adjustment: C.ADJUSTMENT,

  standard: C.LEGACY_FILLER, general: C.LEGACY_FILLER, primary: C.LEGACY_FILLER, routine: C.LEGACY_FILLER,
});

/**
 * Cases the classification takes a position on that the business should
 * confirm. Reported alongside unclassified types; nothing here is guessed
 * silently.
 */
export const AMBIGUOUS_TYPES = Object.freeze({
  dispatch: 'A sales order picked and shipped in the warehouse posts dispatch; invoicing the same goods can '
          + 'ALSO post sales_dispatch (cogsJournal.createForInvoice). If both happen for one sale, stock leaves '
          + 'twice and demand counts twice. Counted as issued until the two paths are reconciled.',
  sales_dispatch: 'See dispatch.',
  rework_return: 'Treated as a reversal of the original consumption (the part was recovered from an assembly '
               + 'and returned to stock as reusable). Confirm the recovered part should reduce demand.',
  issue: 'IoT service-part reversal (serviceParts.js) writes NO stock_ledger row although its comment says it '
       + 'does, so a reversed IoT issue still counts as demand and its stock is not restored.',
  adjustment: 'Covers both manual stock adjustments and the planning ledger reconciliation; neither is consumption. '
            + 'Confirm that write-offs of consumed-but-unrecorded material should not be treated as demand.',
});

const typesOf = (...classes) =>
  Object.entries(TRANSACTION_TYPE_CLASS).filter(([, c]) => classes.includes(c)).map(([t]) => t);

export const ISSUE_TYPES          = Object.freeze(typesOf(C.ISSUE));
export const ISSUE_REVERSAL_TYPES = Object.freeze(typesOf(C.ISSUE_REVERSAL));
export const KNOWN_TYPES          = Object.freeze(Object.keys(TRANSACTION_TYPE_CLASS));

/** The class of one row — for JS callers and tests. */
export function classifyLedgerRow(transactionType, quantityIn = 0, quantityOut = 0) {
  const cls = TRANSACTION_TYPE_CLASS[String(transactionType ?? '').trim().toLowerCase()] ?? C.UNKNOWN;
  if (cls === C.ISSUE && Number(quantityIn) > 0 && !(Number(quantityOut) > 0)) return C.ISSUE_REVERSAL;
  return cls;
}

/**
 * Signed demand quantity of one row: + for an issue, - for a reversal, 0 for
 * everything else. The JS twin of demandQtySql.
 */
export function demandQtyOf(transactionType, quantityIn = 0, quantityOut = 0) {
  const cls = TRANSACTION_TYPE_CLASS[String(transactionType ?? '').trim().toLowerCase()] ?? C.UNKNOWN;
  const qin = Number(quantityIn) || 0, qout = Number(quantityOut) || 0;
  if (cls === C.ISSUE) return qout - qin;
  if (cls === C.ISSUE_REVERSAL) return -qin;
  return 0;
}

// ── SQL ──────────────────────────────────────────────────────────────────────
// The type lists are fixed literals from this file, never user input, so they
// are inlined rather than threaded through every caller as bind parameters.

const list = (types) => types.map(t => `'${t}'`).join(', ');
const typeCol = (alias) => `LOWER(COALESCE(${alias ? `${alias}.` : ''}transaction_type, ''))`;
const col = (alias, c) => `COALESCE(${alias ? `${alias}.` : ''}${c}, 0)`;

/** Predicate: this row is a genuine ISSUE (FSN's "last qualifying issue"). */
export function issueRowSql(alias = '') {
  return `(${typeCol(alias)} IN (${list(ISSUE_TYPES)}) AND ${col(alias, 'quantity_out')} > 0)`;
}

/** Predicate: this row moves demand at all (an issue or a reversal). */
export function demandRowSql(alias = '') {
  return `(${typeCol(alias)} IN (${list([...ISSUE_TYPES, ...ISSUE_REVERSAL_TYPES])}))`;
}

/** Signed demand quantity of a row (see demandQtyOf). Sum it; floor the period at 0. */
export function demandQtySql(alias = '') {
  return `(CASE WHEN ${typeCol(alias)} IN (${list(ISSUE_TYPES)})
                  THEN ${col(alias, 'quantity_out')} - ${col(alias, 'quantity_in')}
                WHEN ${typeCol(alias)} IN (${list(ISSUE_REVERSAL_TYPES)})
                  THEN -${col(alias, 'quantity_in')}
                ELSE 0 END)`;
}

/** Signed demand VALUE of a row, at the row's own rate. */
export function demandValueSql(alias = '') {
  return `(${demandQtySql(alias)} * ${col(alias, 'rate')})`;
}

/** Predicate: this row's type is not classified at all. */
export function unknownTypeSql(alias = '') {
  return `(${typeCol(alias)} NOT IN (${list(KNOWN_TYPES)}))`;
}

/**
 * Transaction types in a company's ledger that this file does not classify,
 * with how much they moved — so they are reviewed rather than silently
 * counted (or silently dropped). `sinceDays` limits it to a window.
 */
export async function unclassifiedTransactionTypes(client, companyId, sinceDays = null) {
  const { rows } = await client.query(`
    SELECT ${typeCol('sl')} AS transaction_type,
           COUNT(*)::int AS rows,
           COALESCE(SUM(sl.quantity_out), 0)::numeric AS quantity_out,
           COALESCE(SUM(sl.quantity_in), 0)::numeric  AS quantity_in,
           MAX(sl.transaction_date) AS last_seen
      FROM stock_ledger sl
     WHERE ($1::int IS NULL OR sl.company_id = $1)
       AND ($2::int IS NULL OR sl.transaction_date >= CURRENT_DATE - $2::int)
       AND ${unknownTypeSql('sl')}
     GROUP BY 1 ORDER BY 2 DESC`, [companyId, sinceDays]);
  return rows;
}

export default {
  LEDGER_CLASS, TRANSACTION_TYPE_CLASS, AMBIGUOUS_TYPES, ISSUE_TYPES, ISSUE_REVERSAL_TYPES, KNOWN_TYPES,
  classifyLedgerRow, demandQtyOf, issueRowSql, demandRowSql, demandQtySql, demandValueSql,
  unknownTypeSql, unclassifiedTransactionTypes,
};
