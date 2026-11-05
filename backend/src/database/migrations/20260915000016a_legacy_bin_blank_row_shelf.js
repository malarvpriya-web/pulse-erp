/**
 * 20260915000016a — legacy bins with a blank row or shelf, made placeable by
 * 20260915000017 without inventing a location. See MODULE_FEATURE_CONNECTION_MANUAL.md §227.
 *
 * THE DEFECT. 20260915000017_location_hierarchy copies every legacy
 * bin_locations row into warehouse_bins with `NULLIF(bl.row_no::text, '')` and
 * `NULLIF(bl.shelf, '')`. bin_locations.row_no / shelf are nullable;
 * warehouse_bins.row_code / shelf_code are NOT NULL. A single legacy bin with no
 * row or shelf therefore failed the whole migration with 23502 — and because
 * server.js runs migrations before it listens, the server could not boot.
 *
 * WHY A NEW MIGRATION AND NOT AN EDIT OF 017. Where 017 already ran it is never
 * re-run, so an edit would change nothing there except its checksum: a
 * "modified after it was applied" warning on every such database, and a failed
 * pre-/post-deploy gate until someone restamps the ledger. This file sorts
 * between 20260915000016_ and 20260915000017_ ('_' < 'a' < '7'), so on a
 * database that still has to run 017 it runs first; everywhere else it is
 * applied late (the runner applies any file missing from schema_migrations) and
 * finds no bin_locations table, so it does nothing.
 *
 * THE POLICY. A row or shelf is blank when NULLIF(BTRIM(value), '') IS NULL —
 * NULL, '' or whitespace only. A blank value becomes '-', which is the
 * product's own "not recorded" value for these two fields: creating a bin
 * stores COALESCE(row, '-') and editing one stores row?.trim() || '-'
 * (modules/warehouse/warehouse.routes.js). It names no aisle or shelf. Only the
 * blank field is replaced; a populated row or shelf is left exactly as it is.
 * Placement is NOT decided here — 017 still decides it, unchanged, so a bin
 * whose zone names no warehouse is still skipped and 20260916000001's cutover still
 * refuses until a person resolves it.
 *
 * PRESERVATION. 20260916000001 drops bin_locations, so whatever is not saved
 * before then is gone. Each affected legacy row is archived WHOLE (to_jsonb)
 * into legacy_bin_location_archive, with the fields that were blank, BEFORE it
 * is changed. One archive row per legacy bin per migration (unique key), so a
 * re-run never archives twice and the stored row is always the original.
 *
 * TRANSACTION. Runs inside the per-migration transaction config/migrations.js
 * opens around up()/down(): the archive table, the archived rows and the
 * normalised values commit together or not at all.
 *
 * down() restores each originally blank field from the archive, independently,
 * and only while it still holds the '-' this migration wrote — a value someone
 * has since corrected is left alone. It never drops the archive.
 */
const MIGRATION = '20260915000016a_legacy_bin_blank_row_shelf';
const BLANK = (col) => `NULLIF(BTRIM(bl.${col}::text), '') IS NULL`;

export async function up(knex) {
  const { rows: [t] } = await knex.raw(`SELECT to_regclass('bin_locations') IS NOT NULL AS present`);
  if (!t.present) {
    console.log(`[${MIGRATION}] bin_locations is gone (cutover already applied) — nothing to do`);
    return;
  }

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS legacy_bin_location_archive (
      id               BIGSERIAL    PRIMARY KEY,
      bin_location_id  INTEGER      NOT NULL,
      row_data         JSONB        NOT NULL,
      blank_fields     TEXT[]       NOT NULL,
      reason           TEXT         NOT NULL,
      archived_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      migration        VARCHAR(80)  NOT NULL DEFAULT '${MIGRATION}',
      CONSTRAINT uq_legacy_bin_location_archive UNIQUE (bin_location_id, migration)
    )
  `);

  // Archive first, whole, and only once per legacy bin.
  const { rows: archived } = await knex.raw(`
    INSERT INTO legacy_bin_location_archive (bin_location_id, row_data, blank_fields, reason)
    SELECT bl.id,
           to_jsonb(bl),
           array_remove(ARRAY[CASE WHEN ${BLANK('row_no')} THEN 'row_no' END,
                              CASE WHEN ${BLANK('shelf')}  THEN 'shelf'  END], NULL),
           'blank row/shelf replaced with ''-'' (not recorded) so 20260915000017 can carry the bin into warehouse_bins'
      FROM bin_locations bl
     WHERE ${BLANK('row_no')} OR ${BLANK('shelf')}
    ON CONFLICT (bin_location_id, migration) DO NOTHING
    RETURNING bin_location_id
  `);

  // Then replace only the blank field(s).
  const { rows: changed } = await knex.raw(`
    UPDATE bin_locations bl
       SET row_no = CASE WHEN ${BLANK('row_no')} THEN '-' ELSE bl.row_no END,
           shelf  = CASE WHEN ${BLANK('shelf')}  THEN '-' ELSE bl.shelf  END
     WHERE ${BLANK('row_no')} OR ${BLANK('shelf')}
    RETURNING bl.id
  `);
  console.log(`[${MIGRATION}] archived ${archived.length} legacy bin(s); set a blank row/shelf to '-' on ${changed.length}`);
}

export async function down(knex) {
  const { rows: [t] } = await knex.raw(
    `SELECT to_regclass('bin_locations') IS NOT NULL AS bins, to_regclass('legacy_bin_location_archive') IS NOT NULL AS archive`);
  if (!t.bins || !t.archive) {
    console.log(`[${MIGRATION}] down: ${t.bins ? 'no archive' : 'bin_locations is gone'} — nothing to restore; the archive is kept`);
    return;
  }
  // Each field on its own: restore the original only if it was blank AND still
  // holds the '-' this migration wrote.
  for (const col of ['row_no', 'shelf']) {
    await knex.raw(`
      UPDATE bin_locations bl
         SET ${col} = a.row_data->>'${col}'
        FROM legacy_bin_location_archive a
       WHERE a.bin_location_id = bl.id
         AND a.migration = '${MIGRATION}'
         AND '${col}' = ANY (a.blank_fields)
         AND bl.${col} = '-'
    `);
  }
}
