/**
 * 20260915000009_inventory_classification_config.js
 *
 * Inventory audit — findings 4 and 29 (stock classification).
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 *
 * 1. THE ABC BANDS WERE HARD-CODED.
 *    classifyABCPareto() carried `aPct = 70, bPct = 90` as function defaults and
 *    nothing could change them. inventory_planning_settings governs ordering
 *    cost, holding rate, service level, lookback and minimum periods — every
 *    other planning parameter — but not the one every business argues about.
 *    A company that runs 80/95 had no way to say so.
 *
 * 2. THE PERCENTAGES WERE COMPUTED AND THROWN AWAY.
 *    The Pareto walk necessarily knows each item's share of total consumption
 *    value and the running cumulative — it decides the band on exactly that —
 *    and then discarded both. So the classification could be displayed but not
 *    justified: nothing could show WHY an item was B, or how close it sat to
 *    the A boundary, which is the question a planner reviewing a classification
 *    actually asks. Rank was likewise recomputed by every reader that wanted it.
 *
 * 3. XYZ WAS ONE COLUMN AWAY AND MISSING.
 *    `demand_cv` — the coefficient of variation of demand — is already computed
 *    and persisted per item by the planning service. XYZ classification IS the
 *    banding of that number, so the expensive half was already done and the
 *    result unused. ABC answers "what is it worth"; XYZ answers "can we predict
 *    it", and stocking policy needs both: an AX part and an AZ part are worth
 *    the same and must be managed completely differently.
 *
 * 4. FSN HAD NO HOME.
 *    Non-moving and obsolete stock is a required output of the ageing
 *    requirement and there was nowhere to record the verdict.
 *
 * ── DELIBERATELY NOT INCLUDED ───────────────────────────────────────────────
 * VED, HML and SDE. VED is a criticality judgement that engineering must
 * curate — derived automatically it would be noise wearing a classification's
 * name, and an uncurated VED class is worse than none because people trust it.
 * HML is trivially derivable from standard_cost at query time and a stored copy
 * is just another column to drift. SDE needs supplier-count and lead-time
 * variance data this database does not yet hold honestly. Each is a column away
 * once there is an owner for the data; none should be added before then.
 *
 * ── DEFAULTS PRESERVE CURRENT BEHAVIOUR ─────────────────────────────────────
 * The ABC thresholds default to 70/90, so every existing classification stays
 * exactly as it is until somebody deliberately changes the policy. The XYZ
 * defaults (CV 0.5 / 1.0) are the conventional bands and are equally settable.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE inventory_planning_settings
      ADD COLUMN IF NOT EXISTS abc_a_threshold_pct numeric(5,2)  NOT NULL DEFAULT 70,
      ADD COLUMN IF NOT EXISTS abc_b_threshold_pct numeric(5,2)  NOT NULL DEFAULT 90,
      ADD COLUMN IF NOT EXISTS xyz_x_max_cv        numeric(6,3)  NOT NULL DEFAULT 0.5,
      ADD COLUMN IF NOT EXISTS xyz_y_max_cv        numeric(6,3)  NOT NULL DEFAULT 1.0,
      ADD COLUMN IF NOT EXISTS fsn_slow_days       integer       NOT NULL DEFAULT 90,
      ADD COLUMN IF NOT EXISTS fsn_nonmoving_days  integer       NOT NULL DEFAULT 180
  `);

  // A threshold set the wrong way round (B below A) would silently invert the
  // whole classification, so the ordering is a database rule rather than a
  // hope about the UI.
  const addChk = async (name, expr) => {
    const { rows } = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name]);
    if (rows.length) return;
    await knex.raw(`ALTER TABLE inventory_planning_settings ADD CONSTRAINT ${name} CHECK (${expr})`);
  };
  await addChk('ips_abc_thresholds_ordered',
    'abc_a_threshold_pct > 0 AND abc_a_threshold_pct < abc_b_threshold_pct AND abc_b_threshold_pct <= 100');
  await addChk('ips_xyz_thresholds_ordered',
    'xyz_x_max_cv > 0 AND xyz_x_max_cv < xyz_y_max_cv');

  // The justification for each classification, kept alongside it.
  await knex.raw(`
    ALTER TABLE inventory_items
      ADD COLUMN IF NOT EXISTS abc_value_pct       numeric(9,4),
      ADD COLUMN IF NOT EXISTS abc_cumulative_pct  numeric(9,4),
      ADD COLUMN IF NOT EXISTS abc_rank            integer,
      ADD COLUMN IF NOT EXISTS xyz_class           text,
      ADD COLUMN IF NOT EXISTS fsn_class           text,
      ADD COLUMN IF NOT EXISTS last_movement_date  date
  `);

  await knex.raw(`
    ALTER TABLE inventory_planning_run_items
      ADD COLUMN IF NOT EXISTS abc_value_pct      numeric(9,4),
      ADD COLUMN IF NOT EXISTS abc_cumulative_pct numeric(9,4),
      ADD COLUMN IF NOT EXISTS abc_rank           integer,
      ADD COLUMN IF NOT EXISTS xyz_class          text,
      ADD COLUMN IF NOT EXISTS fsn_class          text,
      ADD COLUMN IF NOT EXISTS demand_cv          numeric(12,4)
  `);

  // Vocabulary constrained at the database, as it already is for batch and GRN
  // status — a stray 'a' or 'Fast' splits every GROUP BY that reads these.
  const addClassChk = async (name, table, col, vals) => {
    const { rows } = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name]);
    if (rows.length) return;
    await knex.raw(
      `ALTER TABLE ${table} ADD CONSTRAINT ${name}
       CHECK (${col} IS NULL OR ${col} = ANY (ARRAY[${vals.map(v => `'${v}'`).join(',')}]))`);
  };
  await addClassChk('inventory_items_xyz_class_chk', 'inventory_items', 'xyz_class', ['X', 'Y', 'Z']);
  await addClassChk('inventory_items_fsn_class_chk', 'inventory_items', 'fsn_class', ['F', 'S', 'N']);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_items_abc_xyz
      ON inventory_items (company_id, abc_class, xyz_class)
      WHERE abc_class IS NOT NULL;
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE inventory_planning_settings
      DROP CONSTRAINT IF EXISTS ips_abc_thresholds_ordered,
      DROP CONSTRAINT IF EXISTS ips_xyz_thresholds_ordered,
      DROP COLUMN IF EXISTS abc_a_threshold_pct, DROP COLUMN IF EXISTS abc_b_threshold_pct,
      DROP COLUMN IF EXISTS xyz_x_max_cv, DROP COLUMN IF EXISTS xyz_y_max_cv,
      DROP COLUMN IF EXISTS fsn_slow_days, DROP COLUMN IF EXISTS fsn_nonmoving_days
  `);
  await knex.raw(`
    ALTER TABLE inventory_items
      DROP CONSTRAINT IF EXISTS inventory_items_xyz_class_chk,
      DROP CONSTRAINT IF EXISTS inventory_items_fsn_class_chk,
      DROP COLUMN IF EXISTS abc_value_pct, DROP COLUMN IF EXISTS abc_cumulative_pct,
      DROP COLUMN IF EXISTS abc_rank, DROP COLUMN IF EXISTS xyz_class,
      DROP COLUMN IF EXISTS fsn_class, DROP COLUMN IF EXISTS last_movement_date
  `);
  await knex.raw(`
    ALTER TABLE inventory_planning_run_items
      DROP COLUMN IF EXISTS abc_value_pct, DROP COLUMN IF EXISTS abc_cumulative_pct,
      DROP COLUMN IF EXISTS abc_rank, DROP COLUMN IF EXISTS xyz_class,
      DROP COLUMN IF EXISTS fsn_class, DROP COLUMN IF EXISTS demand_cv
  `);
}
