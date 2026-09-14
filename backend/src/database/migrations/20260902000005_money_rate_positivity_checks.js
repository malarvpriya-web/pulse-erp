/**
 * Positivity checks for the money-semantic `_rate` columns.
 *
 * WHY THIS EXISTS
 * ---------------
 * §146.2 constrained the 35 percentage `_rate` columns to 0-100 and explicitly
 * left the 20 money-semantic ones alone, on the reasoning that "a price has no
 * defensible upper bound, so a CHECK is the wrong instrument".
 *
 * That reasoning is still right about the *upper* bound and wrong to have
 * stopped there. A price has no ceiling, but it does have a floor:
 *
 *   - a unit rate below zero is not a discount, it is a sign error — a negative
 *     line is expressed as a negative quantity or a credit note, never as a
 *     negative rate;
 *   - an exchange rate of zero or below is not merely wrong, it is unusable:
 *     converting through it either divides by zero or flips the sign of every
 *     converted amount.
 *
 * So the two families get different floors. Prices are `>= 0` (zero is a real
 * price — a free-issue item, a zero-value sample). FX is strictly `> 0`.
 *
 * ⚠ No upper bound is imposed on any of them, deliberately. `quotation_items.rate`
 * legitimately reaches 100000 in this database. Inventing a ceiling would
 * convert a data-quality question into a write failure on a valid transaction.
 *
 * All 20 columns were verified to hold zero out-of-range values before this ran,
 * so nothing is repaired here — this migration is purely preventive, unlike
 * §146.2 which had 19 columns of damage to clear first.
 */

// Unit prices and cost rates: zero is legitimate, negative is a sign error.
const NON_NEGATIVE = [
  ['commercial_proposal_items', 'rate'],
  ['grn_items',                 'rate'],
  ['inventory_allocations',     'rate'],
  ['inventory_batches',         'rate'],
  ['leave_encashments',         'rate_per_day'],
  ['project_members',           'billing_rate'],
  ['project_members',           'cost_rate'],
  ['purchase_order_items',      'rate'],
  ['quotation_items',           'rate'],
  ['rm_issue_items',            'rate'],
  ['rtv_items',                 'rate'],
  ['stock_ledger',              'rate'],
  ['subcontract_transactions',  'rate'],
  ['work_centres',              'labour_rate_per_hour'],
];

// Exchange rates: zero is unusable, not merely unlikely.
const STRICTLY_POSITIVE = [
  ['bills',              'exchange_rate'],
  ['invoices',           'exchange_rate'],
  ['purchase_orders',    'exchange_rate'],
  ['forex_rates',        'rate_vs_inr'],
  ['forex_rate_history', 'rate_vs_inr'],
];

// See §146.2: the runner's `knex` is a shim over node-postgres, so `??`
// identifier bindings do not exist. Identifiers are interpolated through this.
const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`unsafe identifier: ${s}`);
  return s;
};

async function guard(knex, table, column, floor, op) {
  const { rows: meta } = await knex.raw(
    `SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  if (!meta.length) return `${table}.${column} (absent)`;
  if (!['numeric', 'real', 'double precision'].includes(meta[0].data_type)) {
    return `${table}.${column} (${meta[0].data_type}, not a decimal)`;
  }
  const t = ident(table);
  const c = ident(column);
  const name = ident(`${table}_${column}_${floor}_chk`);
  await knex.raw(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${name}`);
  await knex.raw(
    `ALTER TABLE ${t} ADD CONSTRAINT ${name} CHECK (${c} IS NULL OR ${c} ${op} 0)`
  );
  return null;
}

export async function up(knex) {
  const skipped = [];
  let added = 0;

  for (const [table, column] of NON_NEGATIVE) {
    const skip = await guard(knex, table, column, 'nonneg', '>=');
    if (skip) skipped.push(skip); else added += 1;
  }
  for (const [table, column] of STRICTLY_POSITIVE) {
    const skip = await guard(knex, table, column, 'pos', '>');
    if (skip) skipped.push(skip); else added += 1;
  }

  console.log(`[20260902000005] money-rate positivity checks added on ${added} column(s).`);
  if (skipped.length) console.log(`[20260902000005] skipped:\n  ${skipped.join('\n  ')}`);
}

export async function down(knex) {
  for (const [table, column] of NON_NEGATIVE) {
    await knex.raw(`ALTER TABLE ${ident(table)} DROP CONSTRAINT IF EXISTS ${ident(`${table}_${column}_nonneg_chk`)}`);
  }
  for (const [table, column] of STRICTLY_POSITIVE) {
    await knex.raw(`ALTER TABLE ${ident(table)} DROP CONSTRAINT IF EXISTS ${ident(`${table}_${column}_pos_chk`)}`);
  }
}
