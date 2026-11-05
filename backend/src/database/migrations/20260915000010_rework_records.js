/**
 * 20260915000010_rework_records.js
 *
 * Inventory / traceability audit — finding 17 (rework traceability).
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 * There is no rework table. Genealogy's `reworkHistory` was derived by sniffing
 * free text and sign:
 *
 *     (mil.notes IS NOT NULL AND mil.notes ILIKE 'REWORK%')   -- as-built
 *     qty_issued < 0                                          -- elsewhere
 *
 * Both match ZERO rows in the live database, and nothing in the application
 * writes either pattern — so the field is not "usually empty", it is
 * structurally always empty. The code comment admits as much. A screen showing
 * an empty Rework tab is indistinguishable from a panel that has genuinely
 * never been reworked, which is the worst version of this failure: the absence
 * of evidence reads as evidence of absence.
 *
 * Meanwhile the requirement is explicit and unusually strict — when a component
 * is removed and replaced after assembly, record the original component, the
 * defect, who removed it, when, the replacement's serial/batch, who fitted it,
 * the retest and its result — and above all: *never overwrite the original
 * assembly history*.
 *
 * ── WHY A TABLE AND NOT A FLAG ──────────────────────────────────────────────
 * The obvious cheap fix is a `superseded` boolean on material_issue_logs. It
 * cannot carry the defect, the removing technician, the removal time distinct
 * from the fitting time, or the retest — and a rework is precisely the event
 * where those differ and matter. It also cannot express a removal that has no
 * replacement yet, which is the state a panel actually sits in between the two.
 *
 * So the removal and the replacement are two nullable sides of one record:
 *  - removal recorded, replacement still NULL  -> part is out, panel is open
 *  - both recorded                             -> part swapped
 *  - retest columns filled                     -> the swap has been proven
 *
 * The 20260915000008 migration already added material_issue_logs.reversed_at,
 * which frees the removed serial for re-fitting without deleting the row that
 * records where it used to be. This table is the WHY behind that stamp; the two
 * are linked by removed_issue_log_id.
 *
 * ── NO BACKFILL ─────────────────────────────────────────────────────────────
 * Nothing is invented for historical panels. No rework was ever recorded, so
 * the table starts empty and an empty Rework tab now honestly means "none
 * recorded since this existed" rather than "none possible".
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS rework_records (
      id                            SERIAL PRIMARY KEY,
      company_id                    integer,
      production_order_id           integer,
      serial_id                     integer,          -- the panel being reworked
      -- ── the part that came OUT ──────────────────────────────────────────
      removed_issue_log_id          integer,          -- the original installation
      removed_item_id               integer,
      removed_batch_id              integer,
      removed_component_serial_id   integer,
      defect_code                   text,
      reason                        text NOT NULL,
      removed_by                    integer,
      removed_by_name               text,
      removed_at                    timestamptz NOT NULL DEFAULT NOW(),
      disposition                   text,             -- scrap | return_to_vendor | requarantine | reuse
      -- ── the part that went IN (nullable: a removal may stand alone) ─────
      replacement_issue_log_id      integer,
      replacement_item_id           integer,
      replacement_batch_id          integer,
      replacement_component_serial_id integer,
      replaced_by                   integer,
      replaced_by_name              text,
      replaced_at                   timestamptz,
      -- ── proof it worked ─────────────────────────────────────────────────
      retest_result                 text,             -- pass | fail | pending
      retested_by                   integer,
      retested_by_name              text,
      retested_at                   timestamptz,
      retest_reference              text,
      status                        text NOT NULL DEFAULT 'removed',
      notes                         text,
      created_at                    timestamptz NOT NULL DEFAULT NOW(),
      updated_at                    timestamptz NOT NULL DEFAULT NOW()
    )
  `);

  const addFk = async (name, column, refTable) => {
    const { rows } = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name]);
    if (rows.length) return;
    await knex.raw(`
      ALTER TABLE rework_records
        ADD CONSTRAINT ${name} FOREIGN KEY (${column}) REFERENCES ${refTable}(id) ON DELETE SET NULL
    `);
  };
  await addFk('rework_company_fkey',        'company_id',                      'companies');
  await addFk('rework_order_fkey',          'production_order_id',             'production_orders');
  await addFk('rework_serial_fkey',         'serial_id',                       'serial_numbers');
  await addFk('rework_removed_log_fkey',    'removed_issue_log_id',            'material_issue_logs');
  await addFk('rework_removed_item_fkey',   'removed_item_id',                 'inventory_items');
  await addFk('rework_removed_batch_fkey',  'removed_batch_id',                'inventory_batches');
  await addFk('rework_removed_cser_fkey',   'removed_component_serial_id',     'serial_numbers');
  await addFk('rework_repl_log_fkey',       'replacement_issue_log_id',        'material_issue_logs');
  await addFk('rework_repl_item_fkey',      'replacement_item_id',             'inventory_items');
  await addFk('rework_repl_batch_fkey',     'replacement_batch_id',            'inventory_batches');
  await addFk('rework_repl_cser_fkey',      'replacement_component_serial_id', 'serial_numbers');

  // Vocabulary constrained at the database, as it is for batch and GRN status.
  const addChk = async (name, expr) => {
    const { rows } = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name]);
    if (rows.length) return;
    await knex.raw(`ALTER TABLE rework_records ADD CONSTRAINT ${name} CHECK (${expr})`);
  };
  await addChk('rework_status_chk',
    `status = ANY (ARRAY['removed','replaced','retested','closed','cancelled'])`);
  await addChk('rework_retest_chk',
    `retest_result IS NULL OR retest_result = ANY (ARRAY['pass','fail','pending'])`);
  await addChk('rework_disposition_chk',
    `disposition IS NULL OR disposition = ANY (ARRAY['scrap','return_to_vendor','requarantine','reuse'])`);
  // A replacement without the person or the time that fitted it is a half-record
  // that reads as complete. Either the whole replacement side is filled or none
  // of it is.
  await addChk('rework_replacement_complete_chk',
    `(replacement_issue_log_id IS NULL AND replaced_at IS NULL)
     OR (replaced_at IS NOT NULL)`);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_rework_company   ON rework_records (company_id);
    CREATE INDEX IF NOT EXISTS idx_rework_serial    ON rework_records (serial_id)  WHERE serial_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_rework_order     ON rework_records (production_order_id);
    CREATE INDEX IF NOT EXISTS idx_rework_batch     ON rework_records (removed_batch_id) WHERE removed_batch_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_rework_removed_log ON rework_records (removed_issue_log_id) WHERE removed_issue_log_id IS NOT NULL;
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS rework_records`);
}
