/**
 * 20260915000016_component_installations.js
 *
 * Inventory / traceability audit — findings 15, 8, 9, 14, 21 and 10.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 *
 * There is no record anywhere that a component was FITTED into a panel.
 *
 * The as-built list is reconstructed from `material_issue_logs` — which records
 * material LEAVING THE STORE for an order. Those are different events, and the
 * difference is exactly what the requirement asks for:
 *
 *   issue        stores gave 4 relays to work order WO-118, at 09:12, by Ravi
 *   installation relay SN-4471 went into panel P-1007, at station ASSY-2,
 *                at 14:40, by Meera, under operation 30
 *
 * From the issue alone you cannot answer who assembled the panel, at which
 * station, when, against which BOM line, or under what work instruction. So
 * finding 15 was MISSING, and findings 8, 9 and 14 were each capped at PARTIAL
 * by the same absence — "who assembled this" was the one question the whole
 * genealogy module could not answer.
 *
 * `production_operations` exists but is per ORDER, not per unit: a five-panel
 * order records one set of operations and one `assigned_to` for all five. So it
 * cannot say which panel a given operator actually worked on either.
 *
 * ── WHAT THIS MIGRATION DOES ────────────────────────────────────────────────
 *
 * `component_installations` is the assembly event. One row per component fitted
 * into one unit, carrying every field the requirement lists: panel, component,
 * serial/batch, quantity, operation, workstation, operator, start/end time, work
 * instruction, BOM line, deviation and status.
 *
 * It does NOT replace material_issue_logs and does not duplicate it. The two
 * record different facts and are linked by `issue_log_id`:
 *
 *   material_issue_logs   what left the store, from which lot, for which order
 *   component_installations  what was fitted, into which unit, by whom, where
 *
 * Keeping them separate is what lets the system show a genuine discrepancy —
 * material issued but never installed is the normal signature of shrinkage or of
 * an unrecorded rework, and collapsing the two into one table would define that
 * gap out of existence.
 *
 * ── THE UNIQUENESS RULE, AGAIN SCOPED TO LIVE STATE ─────────────────────────
 * A serialised unit is fitted in at most one panel AT A TIME, so the unique
 * index is scoped `WHERE removed_at IS NULL`, exactly as
 * uq_mil_component_serial_live is scoped to `reversed_at IS NULL`. A bare unique
 * index would forbid a part removed during rework from ever being re-fitted, and
 * would push the floor into deleting the original row — destroying the history
 * the constraint exists to protect.
 *
 * ── ALSO HERE ───────────────────────────────────────────────────────────────
 *
 * finding 21 — `wip_transactions` and `production_operations` gain a nullable
 * `serial_id`, so a stage can be recorded against one panel instead of only
 * against the order. Nullable because an operation genuinely can cover the whole
 * order (a batch bake, a shared setup) and forcing a unit onto it would be a
 * fiction.
 *
 * finding 10 — `inventory_batches` gains `quantity_in_wip`, `quantity_rejected`
 * and `quantity_returned`, so the forward question ("this lot of 100: where did
 * it all go?") can be answered quantitatively instead of only for the part that
 * reached a panel.
 *
 * ── NO BACKFILL ─────────────────────────────────────────────────────────────
 * No installation rows are invented for existing panels. Who fitted what, where
 * and when was never recorded and cannot be recovered; deriving it from the
 * issue log would produce a confident assembly history that no one observed,
 * indistinguishable afterwards from a real one. Panels built before today
 * report `as_built_source: 'issue'` and say so.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS component_installations (
      id                     SERIAL PRIMARY KEY,
      company_id             integer,
      production_order_id    integer NOT NULL,
      serial_id              integer,            -- the PANEL this went into
      -- ── what was fitted ────────────────────────────────────────────────
      item_id                integer NOT NULL,
      component_serial_id    integer,            -- serialised component, where it has one
      batch_id               integer,            -- the lot it came from
      quantity               numeric(18,4) NOT NULL,
      unit                   text,
      issue_log_id           integer,            -- the material issue it was drawn from
      -- ── where and by whom ──────────────────────────────────────────────
      operation_id           integer,
      work_centre_id         integer,            -- the workstation
      station_code           text,
      installed_by           integer,
      installed_by_name      text,
      started_at             timestamptz,
      completed_at           timestamptz,
      installed_at           timestamptz NOT NULL DEFAULT NOW(),
      -- ── against what instruction ───────────────────────────────────────
      bom_line_id            integer,
      work_instruction_ref   text,
      deviation_reference    text,
      -- ── removal (rework), never a delete ───────────────────────────────
      removed_at             timestamptz,
      removed_by             integer,
      removal_reason         text,
      rework_record_id       integer,
      status                 text NOT NULL DEFAULT 'installed',
      notes                  text,
      created_at             timestamptz NOT NULL DEFAULT NOW(),
      updated_at             timestamptz NOT NULL DEFAULT NOW()
    )
  `);

  const addFk = async (name, table, column, refTable, onDelete = 'SET NULL') => {
    const { rows } = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name]);
    if (rows.length) return;
    await knex.raw(`
      ALTER TABLE ${table}
        ADD CONSTRAINT ${name} FOREIGN KEY (${column}) REFERENCES ${refTable}(id) ON DELETE ${onDelete}
    `);
  };

  await addFk('ci_company_fkey',   'component_installations', 'company_id',          'companies');
  await addFk('ci_order_fkey',     'component_installations', 'production_order_id', 'production_orders', 'CASCADE');
  await addFk('ci_serial_fkey',    'component_installations', 'serial_id',           'serial_numbers');
  await addFk('ci_item_fkey',      'component_installations', 'item_id',             'inventory_items');
  await addFk('ci_cserial_fkey',   'component_installations', 'component_serial_id', 'serial_numbers');
  await addFk('ci_batch_fkey',     'component_installations', 'batch_id',            'inventory_batches');
  await addFk('ci_issue_fkey',     'component_installations', 'issue_log_id',        'material_issue_logs');
  await addFk('ci_operation_fkey', 'component_installations', 'operation_id',        'production_operations');
  await addFk('ci_wc_fkey',        'component_installations', 'work_centre_id',      'work_centres');
  await addFk('ci_rework_fkey',    'component_installations', 'rework_record_id',    'rework_records');

  const addChk = async (name, expr) => {
    const { rows } = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name]);
    if (rows.length) return;
    await knex.raw(`ALTER TABLE component_installations ADD CONSTRAINT ${name} CHECK (${expr})`);
  };
  await addChk('ci_status_chk',
    `status = ANY (ARRAY['installed','removed','replaced','scrapped'])`);
  await addChk('ci_qty_positive_chk', `quantity > 0`);
  // A removal must say why. An unexplained disappearance from a panel is the
  // thing this table exists to make impossible.
  await addChk('ci_removal_reason_chk',
    `removed_at IS NULL OR removal_reason IS NOT NULL`);

  // One serialised unit is fitted in at most one panel at a time. Scoped to
  // live installations so rework can legitimately move it (see header).
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ci_component_serial_live
      ON component_installations (component_serial_id)
      WHERE component_serial_id IS NOT NULL AND removed_at IS NULL
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_ci_order      ON component_installations (production_order_id);
    CREATE INDEX IF NOT EXISTS idx_ci_serial     ON component_installations (serial_id) WHERE serial_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_ci_item       ON component_installations (item_id);
    CREATE INDEX IF NOT EXISTS idx_ci_batch      ON component_installations (batch_id) WHERE batch_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_ci_company    ON component_installations (company_id);
    CREATE INDEX IF NOT EXISTS idx_ci_installer  ON component_installations (installed_by) WHERE installed_by IS NOT NULL;
  `);

  // ── finding 21: a stage can name the unit it was performed on ────────────
  await knex.raw(`
    ALTER TABLE wip_transactions
      ADD COLUMN IF NOT EXISTS serial_id integer,
      ADD COLUMN IF NOT EXISTS batch_id  integer
  `);
  await knex.raw(`
    ALTER TABLE production_operations
      ADD COLUMN IF NOT EXISTS serial_id integer
  `);
  await addFk('wip_serial_fkey', 'wip_transactions',      'serial_id', 'serial_numbers');
  await addFk('wip_batch_fkey',  'wip_transactions',      'batch_id',  'inventory_batches');
  await addFk('po_op_serial_fkey', 'production_operations', 'serial_id', 'serial_numbers');
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_wip_serial ON wip_transactions (serial_id) WHERE serial_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_prod_op_serial ON production_operations (serial_id) WHERE serial_id IS NOT NULL;
  `);

  // ── finding 10: where did the rest of the lot go? ────────────────────────
  // Received is already recorded, as are available, reserved and consumed.
  // These three complete the disposition so the forward question balances.
  await knex.raw(`
    ALTER TABLE inventory_batches
      ADD COLUMN IF NOT EXISTS quantity_in_wip    numeric(18,4) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS quantity_rejected  numeric(18,4) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS quantity_returned  numeric(18,4) NOT NULL DEFAULT 0
  `);
  const addBatchChk = async (name, expr) => {
    const { rows } = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name]);
    if (rows.length) return;
    await knex.raw(`ALTER TABLE inventory_batches ADD CONSTRAINT ${name} CHECK (${expr}) NOT VALID`);
    await knex.raw(`ALTER TABLE inventory_batches VALIDATE CONSTRAINT ${name}`);
  };
  await addBatchChk('inv_batches_wip_nonneg_chk',      'quantity_in_wip >= 0');
  await addBatchChk('inv_batches_rejected_nonneg_chk', 'quantity_rejected >= 0');
  await addBatchChk('inv_batches_returned_nonneg_chk', 'quantity_returned >= 0');
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS component_installations`);
  await knex.raw(`
    ALTER TABLE wip_transactions
      DROP COLUMN IF EXISTS serial_id, DROP COLUMN IF EXISTS batch_id
  `);
  await knex.raw(`ALTER TABLE production_operations DROP COLUMN IF EXISTS serial_id`);
  await knex.raw(`
    ALTER TABLE inventory_batches
      DROP CONSTRAINT IF EXISTS inv_batches_wip_nonneg_chk,
      DROP CONSTRAINT IF EXISTS inv_batches_rejected_nonneg_chk,
      DROP CONSTRAINT IF EXISTS inv_batches_returned_nonneg_chk,
      DROP COLUMN IF EXISTS quantity_in_wip,
      DROP COLUMN IF EXISTS quantity_rejected,
      DROP COLUMN IF EXISTS quantity_returned
  `);
}
