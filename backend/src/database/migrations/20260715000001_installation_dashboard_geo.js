/**
 * 20260715000001_installation_dashboard_geo.js
 *
 * Backing store for the Installation Dashboard (where Manifest's SST / HVDC /
 * STATCOM / EPC installations are physically deployed). The dashboard queries
 * `projects`, but that table carried no geography at all — no zone, no
 * coordinates, no site address — so "installations by zone" had nothing to
 * group on and the map had nothing to plot.
 *
 * On `projects`:
 *   1. `zone`         — the grouping key for the by-zone bar/pie charts. Per the
 *      product decision this is STATE-WISE, so the column holds the Indian state
 *      name (e.g. "Tamil Nadu"), not a N/S/E/W region. VARCHAR so no enum
 *      migration is ever needed; new projects pick a state in the UI.
 *   2. `site_address` — free-text install site. Best-effort backfilled below from
 *      the project's SAT / commissioning records, which already capture it.
 *   3. `site_city`    — city, for map hover / secondary grouping.
 *   4. `latitude` / `longitude` — the map pin. NUMERIC(10,7) to match the
 *      precision already used by customer_equipment.gps_lat/lng and the
 *      attendance geo-fence columns. Left NULL here (no offline geocoder); filled
 *      going forward via the project form's manual entry / Nominatim "Locate".
 *
 * NOT re-done here: the projects.company_id NULL->1 backfill — 20260714000002
 * already applied it. Legacy rows with NULL/blank zone are kept (the dashboard
 * buckets them as "Unassigned") rather than guessed at from address text.
 */

export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_instgeo_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate/i.test(err.message || '')) throw err;
    }
  };

  // ── columns ─────────────────────────────────────────────────────────────────
  await safe(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS zone         VARCHAR(100)`);
  await safe(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS site_address TEXT`);
  await safe(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS site_city    VARCHAR(120)`);
  await safe(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS latitude     NUMERIC(10,7)`);
  await safe(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS longitude    NUMERIC(10,7)`);

  // ── best-effort site_address backfill ───────────────────────────────────────
  // Only fills NULLs. sat_trackers.project_id is a hard FK; take the newest
  // non-blank address per project. Wrapped in safe() so a missing table/column
  // on a partially-migrated DB is swallowed rather than aborting the migration.
  await safe(`
    UPDATE projects p
       SET site_address = sub.site_address
      FROM (
        SELECT DISTINCT ON (project_id) project_id, site_address
          FROM sat_trackers
         WHERE site_address IS NOT NULL AND TRIM(site_address) <> ''
         ORDER BY project_id, id DESC
      ) sub
     WHERE p.site_address IS NULL
       AND sub.project_id = p.id
  `);

  // Fall back to commissioning_reports for projects SAT didn't cover.
  await safe(`
    UPDATE projects p
       SET site_address = sub.site_address
      FROM (
        SELECT DISTINCT ON (project_id) project_id, site_address
          FROM commissioning_reports
         WHERE site_address IS NOT NULL AND TRIM(site_address) <> ''
         ORDER BY project_id, id DESC
      ) sub
     WHERE p.site_address IS NULL
       AND sub.project_id = p.id
  `);

  // ── indexes ─────────────────────────────────────────────────────────────────
  await safe(`CREATE INDEX IF NOT EXISTS idx_projects_company_zone
    ON projects(company_id, zone)
    WHERE deleted_at IS NULL`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_projects_company_zone`);
  await knex.raw(`ALTER TABLE projects DROP COLUMN IF EXISTS longitude`);
  await knex.raw(`ALTER TABLE projects DROP COLUMN IF EXISTS latitude`);
  await knex.raw(`ALTER TABLE projects DROP COLUMN IF EXISTS site_city`);
  await knex.raw(`ALTER TABLE projects DROP COLUMN IF EXISTS site_address`);
  await knex.raw(`ALTER TABLE projects DROP COLUMN IF EXISTS zone`);
}
