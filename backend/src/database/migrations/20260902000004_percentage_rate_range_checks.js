/**
 * Range-check every `_rate` column that is a percentage.
 *
 * WHY THIS EXISTS
 * ---------------
 * §146.1 constrained `competitors.win_rate` after finding 899 in every seeded
 * row, and closed with a note that "three other `_rate`-style columns" were
 * unconstrained. That number was a guess and it was wrong. A sweep of the live
 * schema found 56 rate-shaped numeric columns, of which 35 are percentages —
 * and not one of them carried a CHECK.
 *
 * Nineteen held out-of-range values. The damage was not confined to a cosmetic
 * analytics card:
 *
 *   master_hsn_sac.gst_rate      899.00  <- the GST rate master itself
 *   rcm_self_invoices.gst_rate   899.00
 *   tds_entries.tds_rate         899.00
 *   tcs_transactions.tcs_rate    899.00
 *   bill_items.tax_rate          899.00
 *   invoice/quotation/sales_order line items, commission rates ... 899.00
 *
 * Any code path that read a rate from those masters and applied it would have
 * computed tax at 899% of the taxable value.
 *
 * WHERE 899 COMES FROM
 * --------------------
 * `scripts/seed/lib-values.mjs` classifies columns by name. Its money branch
 * matched the entire tax/statutory family before anything percentage-shaped
 * could, returning 1250.5; the seeder's own numeric(p,s) width cap then floored
 * that to Math.floor((10^3 - 1) * 0.9) = 899 for every numeric(5,2) column.
 *
 * A second, independent defect in the same file left the *numeric* percentage
 * branch uncapped (55 + i * 6.5, which passes 100 at i = 7) while its integer
 * twin one function above already did Math.min(100, ...). That one produced
 * commission_plans.base_rate_pct of 107, 113.5 and 120.
 *
 * Both generator defects are fixed. This migration exists because a generator
 * fix only governs future seeds: nothing stopped an API caller, a CSV import,
 * or the next generator from writing 899 again.
 *
 * WHAT HAPPENS TO THE BAD ROWS
 * ----------------------------
 * Out-of-range values are cleared to NULL — never rescaled. 899 does not encode
 * a recoverable rate, and 8.99% or 89.9% would be inventing a tax rate. NULL is
 * the honest value: never measured. This is the standing `unmeasured != zero`
 * rule; zeroing a GST rate asserts "exempt", which is a false statement about a
 * taxable supply.
 *
 * Two columns are NOT NULL and cannot take that treatment:
 *   master_hsn_sac.gst_rate     (NOT NULL DEFAULT 0)
 *   rcm_self_invoices.gst_rate  (NOT NULL DEFAULT 18)
 * They are set to their own column default. This is the one place the repair
 * asserts a value instead of admitting ignorance, and it is only defensible
 * because every affected row is a SEED-tagged fixture (fake HSN codes like
 * MHS-07907-SEED06907), not a real master record.
 *
 * Those fixture rows are still fake HSN codes sitting in a lookup master and
 * should be purged separately — that is a data decision, not a schema one, and
 * is deliberately left alone here.
 *
 * Every out-of-range row in the database at the time of writing was verified to
 * be seed debris from the 2026-08-20 run, including the 120 in commission_plans
 * that could plausibly have been a real above-quota accelerator: the one
 * genuine plan ("Standard Commission Plan") carries 5.00, and the three at
 * 107 / 113.5 / 120 are all named "SEED Commission Plans N".
 *
 * NOT IN SCOPE
 * ------------
 * The money-semantic rate columns (exchange_rate, rate_vs_inr, the line-item
 * `rate` columns, billing_rate, cost_rate, rate_per_day, labour_rate_per_hour)
 * are left alone. Several also hold seed garbage — forex_rates.rate_vs_inr is
 * 1250.5, which is not a plausible INR pair — but a price has no defensible
 * upper bound to check against, so a CHECK is the wrong instrument. That is bad
 * data, not a missing constraint.
 */

// Every `_rate`-family column whose value is a percentage of some base.
const PCT_COLUMNS = [
  ['bill_items',             'tax_rate'],
  ['bills',                  'tds_rate'],
  ['commission_entries',     'commission_rate'],
  ['commission_plans',       'base_rate_pct'],
  ['credit_note_items',      'gst_rate'],
  ['debit_note_items',       'gst_rate'],
  ['fixed_assets',           'wdv_rate'],
  ['inventory_items',        'default_gst_rate'],
  ['inventory_items',        'gst_rate'],
  ['invoice_items',          'cgst_rate'],
  ['invoice_items',          'gst_rate'],
  ['invoice_items',          'igst_rate'],
  ['invoice_items',          'sgst_rate'],
  ['invoice_items',          'tax_rate'],
  ['invoices',               'gst_rate'],
  ['item_vendor_prices',     'scrap_rate_pct'],
  ['master_hsn_sac',         'gst_rate'],
  ['products',               'gst_rate'],
  ['purchase_order_items',   'tax_rate'],
  ['quotation_items',        'tax_rate'],
  ['rcm_self_invoices',      'gst_rate'],
  ['sales_commission_rules', 'rate_pct'],
  ['sales_order_items',      'tax_rate'],
  ['sales_settings',         'default_tax_rate'],
  ['sales_targets',          'commission_rate'],
  ['tcs_collectees',         'rate_with_pan'],
  ['tcs_collectees',         'rate_without_pan'],
  ['tcs_transactions',       'tcs_rate'],
  ['tds_deductees',          'lower_deduction_rate'],
  ['tds_deductees',          'rate_with_pan'],
  ['tds_deductees',          'rate_without_pan'],
  ['tds_entries',            'tds_rate'],
  ['tds_transactions',       'tds_rate'],
  ['vendor_health_scores',   'pass_rate_pct'],
  ['vendors',                'defect_rate'],
];

const constraintName = (table, column) => `${table}_${column}_pct_chk`;

// The migration runner's `knex` is a thin shim over node-postgres
// (`raw: (sql, bindings) => client.query(sql, bindings)`), so `?` value
// placeholders and `??` identifier bindings — both knex-only — do not exist
// here. Values use $n; identifiers have to be interpolated, and are gated
// through this so a typo in PCT_COLUMNS cannot become injected SQL.
const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`unsafe identifier: ${s}`);
  return s;
};

export async function up(knex) {
  const repaired = [];
  const skipped = [];
  let constrained = 0;

  for (const [table, column] of PCT_COLUMNS) {
    // Schema drift is the norm here, not the exception — a column named in this
    // list may not exist on every deployment. Skip rather than abort the run.
    const t = ident(table);
    const c = ident(column);
    const { rows: meta } = await knex.raw(
      `SELECT data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column]
    );
    if (!meta.length) { skipped.push(`${table}.${column} (absent)`); continue; }
    if (!['numeric', 'real', 'double precision'].includes(meta[0].data_type)) {
      skipped.push(`${table}.${column} (${meta[0].data_type}, not a decimal)`);
      continue;
    }

    // Repair before constraining: ADD CONSTRAINT validates existing rows and
    // would abort the whole migration on the first 899 it met.
    const nullable = meta[0].is_nullable === 'YES';
    // DEFAULT is the column's own declared default; there is no honest NULL
    // available on a NOT NULL column.
    const { rows: fixed } = await knex.raw(
      `UPDATE ${t} SET ${c} = ${nullable ? 'NULL' : 'DEFAULT'}
        WHERE ${c} IS NOT NULL AND (${c} < 0 OR ${c} > 100)
    RETURNING 1 AS touched`
    );
    if (fixed?.length) {
      repaired.push(`${table}.${column}: ${fixed.length} row(s) -> ${nullable ? 'NULL' : 'DEFAULT'}`);
    }

    const name = ident(constraintName(table, column));
    await knex.raw(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${name}`);
    await knex.raw(
      `ALTER TABLE ${t} ADD CONSTRAINT ${name}
         CHECK (${c} IS NULL OR (${c} >= 0 AND ${c} <= 100))`
    );
    constrained += 1;
  }

  console.log(`[20260902000003] percentage range checks added on ${constrained} column(s).`);
  if (repaired.length) console.log(`[20260902000003] repaired:\n  ${repaired.join('\n  ')}`);
  if (skipped.length) console.log(`[20260902000003] skipped:\n  ${skipped.join('\n  ')}`);
}

export async function down(knex) {
  // Cleared values are not restored — they were generator artefacts, and
  // re-writing 899 would violate the constraint this rolls back to allowing.
  for (const [table, column] of PCT_COLUMNS) {
    await knex.raw(
      `ALTER TABLE ${ident(table)} DROP CONSTRAINT IF EXISTS ${ident(constraintName(table, column))}`
    );
  }
}
