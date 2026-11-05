/**
 * 20260915000006_as_built_serial_attribution.js
 *
 * Traceability audit finding 02.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 * `material_issue_logs` records what was issued to a production ORDER. It has
 * no column naming the unit the material went into, and no column naming the
 * specific component unit consumed. For an order that builds one panel that is
 * the same thing. For an order that builds five, it is not.
 *
 * TRC-PO-CP-001 built 5 panels and consumed 4 component lots. Asked which
 * components are in panel TRC-SN-CP-003, genealogy walked serial -> order ->
 * every issue against that order and returned all 4 lots. It returned the same
 * 4 lots for all five serials.
 *
 * That is not a missing answer, which a caller could see. It is a confident
 * wrong one: the as-built list of every panel is inflated to the whole order,
 * and a recall keyed on a component lot takes all five panels when the lot may
 * be in one. The error scales with order quantity.
 *
 * ── WHAT THIS MIGRATION DOES ────────────────────────────────────────────────
 * Adds the two attributions that were missing, both NULLABLE:
 *
 *   serial_id            the unit BUILT that this material went into
 *   component_serial_id  the serialised unit CONSUMED, where the component
 *                        itself carries a serial
 *
 * Nullable is the point, not a concession. Some material genuinely is issued to
 * the order and not to a unit — 125 m of cable across five panels cannot be
 * split after the fact. NULL means "issued to the order, not attributable to a
 * unit", which is true and useful. The read side reports attributed and shared
 * consumption separately rather than merging them, so a caller can tell a
 * certainty from a possibility.
 *
 * ── WHAT THIS MIGRATION DELIBERATELY DOES NOT DO ────────────────────────────
 * It does not backfill. Existing rows have no record of which unit they went
 * into; that information was never captured and cannot be recovered. Splitting
 * a 5-unit issue evenly across 5 serials, or attaching it to the order's first
 * serial, would manufacture a genealogy that no one observed — and it would be
 * indistinguishable from a real one afterwards. Existing rows stay NULL and are
 * reported below as shared, which is exactly what they are.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE material_issue_logs
      ADD COLUMN IF NOT EXISTS serial_id           integer,
      ADD COLUMN IF NOT EXISTS component_serial_id integer
  `);

  // FKs added separately and guarded: ADD CONSTRAINT has no IF NOT EXISTS.
  // The runner's `raw` is a straight pg passthrough, so bindings are $n — a `?`
  // placeholder reaches Postgres verbatim and is a syntax error.
  const addFk = async (name, column) => {
    const { rows } = await knex.raw(
      `SELECT 1 FROM pg_constraint WHERE conname = $1`, [name]
    );
    if (rows.length) return;
    await knex.raw(`
      ALTER TABLE material_issue_logs
        ADD CONSTRAINT ${name} FOREIGN KEY (${column})
        REFERENCES serial_numbers(id) ON DELETE SET NULL
    `);
  };
  await addFk('material_issue_logs_serial_id_fkey', 'serial_id');
  await addFk('material_issue_logs_component_serial_id_fkey', 'component_serial_id');

  // Partial indexes: the overwhelming majority of rows are order-level and
  // indexing their NULLs would only make the index bigger, not faster.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_mil_serial_id
      ON material_issue_logs (serial_id) WHERE serial_id IS NOT NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_mil_component_serial_id
      ON material_issue_logs (component_serial_id) WHERE component_serial_id IS NOT NULL
  `);
  // Drives the per-panel as-built read.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_mil_order_serial
      ON material_issue_logs (production_order_id, serial_id)
  `);

  // Report the exposure this leaves behind: orders that build more than one
  // serialised unit and have consumption no one can attribute to a unit. These
  // are precisely the orders whose as-built lists are still order-wide.
  const { rows } = await knex.raw(`
    SELECT po.production_order_no,
           po.quantity_planned,
           COUNT(DISTINCT sn.id)::int  AS serials,
           COUNT(DISTINCT mil.id)::int AS unattributed_issues
      FROM production_orders po
      JOIN serial_numbers sn       ON sn.production_order_id = po.id AND sn.deleted_at IS NULL
      JOIN material_issue_logs mil ON mil.production_order_id = po.id AND mil.serial_id IS NULL
     GROUP BY po.id, po.production_order_no, po.quantity_planned
    HAVING COUNT(DISTINCT sn.id) > 1
     ORDER BY po.production_order_no
  `);

  console.log('[migration 20260915000006] added serial_id + component_serial_id to material_issue_logs (nullable, no backfill).');
  if (rows.length) {
    console.warn(
      `[migration 20260915000006] ${rows.length} multi-unit order(s) carry consumption that predates ` +
      `attribution. Their per-panel as-built stays order-wide and is reported as SHARED, not attributed:`
    );
    for (const r of rows) {
      console.warn(
        `  ${r.production_order_no}  planned=${r.quantity_planned}  serials=${r.serials}  ` +
        `unattributed issues=${r.unattributed_issues}`
      );
    }
  }
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_mil_order_serial`);
  await knex.raw(`DROP INDEX IF EXISTS idx_mil_component_serial_id`);
  await knex.raw(`DROP INDEX IF EXISTS idx_mil_serial_id`);
  // Dropping the columns cascade-drops the FK constraints naming them.
  await knex.raw(`
    ALTER TABLE material_issue_logs
      DROP COLUMN IF EXISTS component_serial_id,
      DROP COLUMN IF EXISTS serial_id
  `);
}
