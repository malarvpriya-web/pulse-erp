/**
 * competitors.win_rate — constrain a percentage to being a percentage.
 *
 * WHY THIS EXISTS
 * ---------------
 * §146 wired the Sales Command Center's Top Competitors panel to live data and
 * carried the master's recorded win rate onto the card. Every seeded row held
 * **899**, which would have rendered as "899% win rate".
 *
 * The 899 was not arbitrary. `scripts/seed/lib-values.mjs` routes column names
 * by intent, and `win_rate` matched its money branch (`/(rate|unit_price|price)/`)
 * before anything percentage-shaped could claim it, producing 1250.5. The
 * column is `numeric(5,2)`, so the seeder's own width cap floored that to
 * `Math.floor((10^(5-2) - 1) * 0.9)` = 899. The seeder now classifies
 * proportion-style `_rate` names ahead of the money branch, but a generator
 * fix only governs future seeds — nothing stopped an API caller, an import, or
 * the next generator from writing 401 again.
 *
 * This is the same both-scales-at-once trap as §130 (`vendor_scorecards` scored
 * on 1-5 and 0-100 simultaneously) and §145 (a five-point review scale banded
 * as a percentage). In both, the column permitted the wrong scale and something
 * downstream believed it. A CHECK is what makes the scale a property of the
 * data rather than a convention each reader has to remember.
 *
 * WHY OUT-OF-RANGE ROWS BECOME NULL, NOT A NUMBER
 * -----------------------------------------------
 * 899 does not encode a recoverable win rate. It is a generator artefact, and
 * there is no defensible rescaling of it — 89.9% would be inventing a figure
 * that says this competitor beats us nine times in ten. NULL is the honest
 * value: this competitor's win rate has never been measured. The panel already
 * distinguishes the two, rendering the rate only when it is present and in
 * range, so a NULL simply shows the loss count and value on their own.
 *
 * That is the standing `unmeasured != zero` rule; zeroing these would have
 * asserted that every competitor loses every deal.
 */

export async function up(knex) {
  // Type is asserted, not assumed: a CHECK comparing a numeric to 0/100 would
  // still be created against a varchar column and then fail as 42883 on the
  // first write rather than here.
  const { rows: typeRows } = await knex.raw(
    `SELECT data_type FROM information_schema.columns
      WHERE table_name = 'competitors' AND column_name = 'win_rate'`
  );
  if (!typeRows.length) {
    console.log('[20260902000002] competitors.win_rate absent; nothing to constrain.');
    return;
  }
  if (typeRows[0].data_type !== 'numeric') {
    throw new Error(`competitors.win_rate must be numeric to be range-checked, got ${typeRows[0].data_type}`);
  }

  // Clear before constraining — ADD CONSTRAINT validates existing rows and
  // would abort the migration on the seeded 899s.
  const { rows: cleared } = await knex.raw(`
    UPDATE competitors
       SET win_rate = NULL
     WHERE win_rate IS NOT NULL
       AND (win_rate < 0 OR win_rate > 100)
    RETURNING id, name
  `);

  await knex.raw(`
    ALTER TABLE competitors DROP CONSTRAINT IF EXISTS competitors_win_rate_pct;
    ALTER TABLE competitors ADD CONSTRAINT competitors_win_rate_pct
      CHECK (win_rate IS NULL OR (win_rate >= 0 AND win_rate <= 100));
  `);

  console.log(
    `[20260902000002] competitors.win_rate constrained to 0-100; ` +
    `cleared ${cleared?.length ?? 0} out-of-range row(s) to NULL.`
  );
}

export async function down(knex) {
  // The cleared values are not restored: they were artefacts, and re-writing
  // 899 would immediately violate the constraint this rolls back to allowing.
  await knex.raw(`ALTER TABLE competitors DROP CONSTRAINT IF EXISTS competitors_win_rate_pct;`);
}
