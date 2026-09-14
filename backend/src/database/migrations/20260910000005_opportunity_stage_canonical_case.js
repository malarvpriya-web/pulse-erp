/**
 * 20260910000005_opportunity_stage_canonical_case.js
 *
 * Makes ONE state have ONE spelling in `opportunities.stage`,
 * `opportunity_stage_history.from_stage/to_stage` and `invoices.status`.
 *
 * WHY
 * ---
 * `opportunities.stage` had no CHECK constraint and four writers that each
 * chose their own casing:
 *
 *   POST /leads/:id/convert        stage = 'Qualification'
 *   PATCH /opportunities/:id/stage stage = <whatever the client sent, verbatim>
 *   quotation → won (sales)        stage = 'Won'
 *   tenders                        stage = 'Bidding'
 *   quotation attach (crm)         stage = 'negotiation'
 *
 * Every *filter* in the backend is already case-insensitive — statusSets.js
 * builds `LOWER(col) IN (...)` on purpose — so the totals were right. The
 * grouping keys were not. `getPipelineValue()`, `/dashboard/sales` and
 * `/sales/forecast` all `GROUP BY stage` on the RAW column, so the same state
 * stored two ways becomes two rows:
 *
 *   stage           count  total_value
 *   'Qualification'   1      500000.00     <- created through the CRM
 *   'qualification'   1      220000.00     <- created through another path
 *
 * One stage, drawn twice, with its value split across the two — reproduced
 * live by converting a single lead. This is the same shape as the GROUP BY
 * alias collision that printed "Not specified" twice in the HR gender chart.
 *
 * WHY LOWERCASE, AND WHY A TRIGGER
 * --------------------------------
 * `crm_pipeline_stages` already distinguishes the two concepts: `name` is the
 * display label ('Qualification') and `stage_key` is the stable key
 * ('qualification'). The key is what a row should store — it is rename-safe,
 * and it is character-for-character the vocabulary statusSets.js declares in
 * OPPORTUNITY_OPEN_STAGES / OPPORTUNITY_WON / OPPORTUNITY_LOST. It is also
 * already the majority of the live rows.
 *
 * A normalising trigger rather than a CHECK constraint, deliberately:
 *
 *   - A CHECK rejecting 'Qualification' would 500 the CRM's own create path
 *     until every writer is fixed, and would reject a stage nobody anticipated.
 *     statusSets.js treats an unknown stage as OPEN rather than failing, and a
 *     gate that blocks everyone is an outage dressed as a fix.
 *   - The trigger covers writers this migration cannot see: seeds, direct SQL,
 *     and whatever is written next. Fixing only the four call sites leaves the
 *     column exactly as unprotected as it was.
 *
 * `invoices.status` had the same drift ('sent' and 'Sent'). Receivables read
 * through sqlInvoiceOutstanding(), which is an exclusion and case-insensitive,
 * so no balance was wrong — but the same split would appear in any status
 * breakdown, so it is normalised here too.
 *
 * NOTE: the migration runner passes a THIN PG SHIM, not knex — .raw() only.
 */

/** Columns that must hold one spelling per state: [table, [columns…]]. */
const NORMALISED = [
  ['opportunities', ['stage']],
  ['opportunity_stage_history', ['from_stage', 'to_stage']],
  ['invoices', ['status']],
];

const tableExists = async (knex, table) => {
  const { rows } = await knex.raw(
    `SELECT to_regclass($1) IS NOT NULL AS present`, [`public.${table}`]
  );
  return rows[0]?.present === true;
};

export async function up(knex) {
  for (const [table, columns] of NORMALISED) {
    if (!await tableExists(knex, table)) {
      console.log(`[stage_canonical_case] ${table} absent — skipped`);
      continue;
    }

    // ── 1. Backfill ────────────────────────────────────────────────────────
    // TRIM as well as LOWER: getKanbanBoard() already defends against padded
    // values with .trim(), which means padded values have been seen.
    for (const col of columns) {
      const { rows } = await knex.raw(
        `UPDATE ${table}
            SET ${col} = LOWER(TRIM(${col}))
          WHERE ${col} IS NOT NULL
            AND ${col} <> LOWER(TRIM(${col}))
          RETURNING 1`
      );
      const n = rows?.length ?? 0;
      if (n) console.log(`[stage_canonical_case] ${table}.${col}: ${n} row(s) recased`);
    }

    // ── 2. The guard ───────────────────────────────────────────────────────
    // One function per table so the column list is baked in; a generic
    // function would need TG_ARGV and dynamic SQL for no benefit here.
    const fn = `${table}_canonical_state_case`;
    const assignments = columns
      .map(c => `      NEW.${c} := LOWER(TRIM(NEW.${c}));`)
      .join('\n');

    await knex.raw(`
      CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $fn$
      BEGIN
${assignments}
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql
    `);

    await knex.raw(`DROP TRIGGER IF EXISTS trg_${fn} ON ${table}`);
    await knex.raw(`
      CREATE TRIGGER trg_${fn}
        BEFORE INSERT OR UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION ${fn}()
    `);
    console.log(`[stage_canonical_case] ${table}: trigger installed on ${columns.join(', ')}`);
  }
}

export async function down(knex) {
  for (const [table] of NORMALISED) {
    if (!await tableExists(knex, table)) continue;
    const fn = `${table}_canonical_state_case`;
    await knex.raw(`DROP TRIGGER IF EXISTS trg_${fn} ON ${table}`);
    await knex.raw(`DROP FUNCTION IF EXISTS ${fn}()`);
  }
  // The recased values are left as they are. They are the canonical spelling
  // the whole read layer already lowercases to, and restoring the old mixed
  // casing would restore the split this migration exists to remove.
}
