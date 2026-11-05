/**
 * 20260915000011_production_bom_snapshot.js
 *
 * Inventory / traceability audit — findings 12 (BOM revision traceability) and
 * 26 (BOM vs actual consumption).
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 *
 * production_orders stores `bom_id` — a POINTER to a mutable row. bom_headers
 * carries version, ecn_id, frozen_at and change_reason, so the BOM side knows
 * how to be versioned; the production side never captured which version it
 * actually built against.
 *
 * The consequence is not that information is missing — it is that the system
 * gives a confidently WRONG answer. Revise a BOM in place and every panel ever
 * built silently starts reporting the new component list as what it was built
 * from. A panel shipped in January, examined in June after its BOM changed in
 * March, shows March's parts. The requirement states the inverse explicitly:
 * "if BOM changes later, historical panels must NOT show the new BOM".
 *
 * Live evidence of how real this is: only 2 of 9 bom_headers are frozen, and the
 * versions in use are the inconsistent set `1`, `1.0`, `11`, `v1.10` — so BOMs
 * are demonstrably being edited rather than superseded.
 *
 * Separately, nothing anywhere compared what a BOM required against what was
 * actually issued, consumed, returned or scrapped. There was no endpoint, no
 * service and no query — so no discrepancy could be flagged, which is the one
 * thing this comparison exists to do.
 *
 * ── WHY A SNAPSHOT TABLE RATHER THAN A VERSION STRING ───────────────────────
 * Recording `bom_version` alone on the order would say WHICH revision was used
 * but not WHAT it contained — and with BOMs being edited in place, the version
 * string is not a reliable key back to the content. It would also still break
 * the moment somebody edits the lines of a version without renaming it, which
 * is exactly the behaviour the live data shows.
 *
 * So the lines themselves are copied at freeze time. The snapshot is the
 * as-PLANNED BOM: immutable, owned by the order, and the correct counterpart to
 * the as-BUILT list that material_issue_logs already provides. Holding both is
 * what makes "planned vs actual" answerable at all.
 *
 * ── NO BACKFILL ─────────────────────────────────────────────────────────────
 * Existing orders get no snapshot. What their BOM contained at the time they
 * were built was never recorded, and copying today's BOM lines backwards would
 * manufacture exactly the false history this migration exists to prevent — and
 * would be indistinguishable from a real snapshot afterwards. An order without
 * a snapshot reports `planned_bom_available: false`, which is true and useful.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE production_orders
      ADD COLUMN IF NOT EXISTS bom_version      text,
      ADD COLUMN IF NOT EXISTS bom_snapshot_at  timestamptz,
      ADD COLUMN IF NOT EXISTS bom_snapshot_by  integer
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS production_order_bom_lines (
      id                  SERIAL PRIMARY KEY,
      company_id          integer,
      production_order_id integer NOT NULL,
      bom_id              integer,
      bom_version         text,
      line_no             integer,
      component_id        integer,
      component_code      text,
      component_name      text,
      qty_per_unit        numeric(18,4),
      qty_required        numeric(18,4),
      unit                text,
      unit_cost           numeric(18,4),
      level               integer,
      is_substitute_of    integer,
      snapshot_at         timestamptz NOT NULL DEFAULT NOW(),
      snapshot_by         integer,
      snapshot_by_name    text
    )
  `);

  const addFk = async (name, table, column, refTable) => {
    const { rows } = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name]);
    if (rows.length) return;
    await knex.raw(`
      ALTER TABLE ${table}
        ADD CONSTRAINT ${name} FOREIGN KEY (${column}) REFERENCES ${refTable}(id) ON DELETE CASCADE
    `);
  };
  await addFk('pobl_order_fkey', 'production_order_bom_lines', 'production_order_id', 'production_orders');

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_pobl_order ON production_order_bom_lines (production_order_id);
    CREATE INDEX IF NOT EXISTS idx_pobl_component ON production_order_bom_lines (component_id) WHERE component_id IS NOT NULL;
  `);

  // One snapshot line per component per order. A second freeze must replace the
  // snapshot, never silently double every required quantity — which would make
  // the variance report read as a 100% under-issue on every line.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_pobl_order_component
      ON production_order_bom_lines (production_order_id, component_id)
      WHERE component_id IS NOT NULL
  `);

  // ── Substitute traceability (finding 13) ──────────────────────────────────
  // A substitute used on the floor was indistinguishable from the BOM part:
  // nothing recorded that a swap happened, why, or who approved it. These sit
  // on the consumption record because that is where the substitution actually
  // occurs — the BOM says what was intended, the issue says what was fitted.
  await knex.raw(`
    ALTER TABLE material_issue_logs
      ADD COLUMN IF NOT EXISTS substitute_for_item_id integer,
      ADD COLUMN IF NOT EXISTS substitution_reason    text,
      ADD COLUMN IF NOT EXISTS substitution_approved_by      integer,
      ADD COLUMN IF NOT EXISTS substitution_approved_by_name text,
      ADD COLUMN IF NOT EXISTS substitution_approved_at      timestamptz,
      ADD COLUMN IF NOT EXISTS deviation_reference    text
  `);

  const addFkSet = async (name, table, column, refTable) => {
    const { rows } = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name]);
    if (rows.length) return;
    await knex.raw(`
      ALTER TABLE ${table}
        ADD CONSTRAINT ${name} FOREIGN KEY (${column}) REFERENCES ${refTable}(id) ON DELETE SET NULL
    `);
  };
  await addFkSet('mil_substitute_for_item_fkey', 'material_issue_logs', 'substitute_for_item_id', 'inventory_items');

  // An unapproved substitution is a deviation nobody signed off. Recording the
  // substitute without WHO allowed it is the half-record that makes an audit
  // unanswerable, so the approval is required whenever a substitution is named.
  const { rows: chk } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = 'mil_substitution_approved_chk'`);
  if (!chk.length) {
    await knex.raw(`
      ALTER TABLE material_issue_logs
        ADD CONSTRAINT mil_substitution_approved_chk
        CHECK (substitute_for_item_id IS NULL
               OR (substitution_approved_by IS NOT NULL AND substitution_reason IS NOT NULL))
        NOT VALID
    `);
    // NOT VALID then VALIDATE: governs every future write immediately, and the
    // validation passes because no existing row names a substitute.
    await knex.raw(`ALTER TABLE material_issue_logs VALIDATE CONSTRAINT mil_substitution_approved_chk`);
  }

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_mil_substitute
      ON material_issue_logs (substitute_for_item_id) WHERE substitute_for_item_id IS NOT NULL;
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS production_order_bom_lines`);
  await knex.raw(`
    ALTER TABLE production_orders
      DROP COLUMN IF EXISTS bom_version, DROP COLUMN IF EXISTS bom_snapshot_at,
      DROP COLUMN IF EXISTS bom_snapshot_by
  `);
  await knex.raw(`
    ALTER TABLE material_issue_logs
      DROP CONSTRAINT IF EXISTS mil_substitution_approved_chk,
      DROP COLUMN IF EXISTS substitute_for_item_id, DROP COLUMN IF EXISTS substitution_reason,
      DROP COLUMN IF EXISTS substitution_approved_by, DROP COLUMN IF EXISTS substitution_approved_by_name,
      DROP COLUMN IF EXISTS substitution_approved_at, DROP COLUMN IF EXISTS deviation_reference
  `);
}
