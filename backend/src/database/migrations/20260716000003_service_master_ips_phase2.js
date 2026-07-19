/**
 * 20260716000003_service_master_ips_phase2.js
 *
 * Phase 2 of the Service Master (IPS) build — implements the Phase 0 owner
 * decisions recorded in SERVICE_MASTER_IPS_AUDIT.md. Phase 1 (20260716000002)
 * built the ticket data layer against guesses; this migration replaces the
 * guesses with the settled model.
 *
 *  1. product_lines master (decision 1) — "ASTRA" is a product line, "415V" its
 *     voltage; the grid renders "ASTRA - 415V". Finer-grained than the LV/MV/HV
 *     class Project Master shows today, which it rolls up into (415V => LV).
 *
 *  2. projects.product_line_id (decision 6) — `projects` OWNS product line; IPS
 *     inherits it through support_tickets.project_id, the same path it inherits
 *     site by. One source of truth, so Project Master and IPS cannot disagree.
 *
 *  3. support_tickets.product_type DROPPED — Phase 1 added it as a per-ticket
 *     column before decision 6 existed. Never populated outside a verification
 *     probe, so no data is lost.
 *
 *  4. projects.site_state (decision 5) — `zone` now means a compass region
 *     (North/South/East/West/Central), matching leads.zone, which already holds
 *     exactly those five values. projects.zone was the lone dissenter, holding a
 *     STATE ("Tamil Nadu") because there was no state column to put it in. The
 *     Installation Dashboard filters/charts on projects.zone
 *     (projects.routes.js:1136), so without site_state the state dimension would
 *     silently vanish from a shipped page. Backfilled, then zone is corrected.
 *
 * NOT DONE HERE, deliberately:
 *   - `service_sites` is NOT retired (decision 4) — owner asked to leave it
 *     standing until the IPS grid is working. Drop of the table + ReviewSites.jsx
 *     + /servicedesk/sites + support_tickets.site_id is a later migration.
 *   - No CHECK on service_type. PROJECT_TYPES has already widened once (7 -> 10);
 *     a CHECK would make every future addition a migration. It is validated in
 *     the route layer against shared/projectTypes.js instead.
 *   - No trigger to keep projects.product_type in sync with product_lines.class:
 *     this codebase contains zero triggers, and a generated column cannot read
 *     another table. The rollup is derived at READ time via LEFT JOIN
 *     (COALESCE(pl.voltage_class, p.product_type)), so product_line_id is
 *     authoritative where set and legacy product_type still answers where not.
 *
 * product_lines is seeded with ONLY the one evidenced row (ASTRA / 415V / LV) —
 * the real Manifest product catalogue is not known here, and inventing one would
 * put fiction in a master table. Remaining lines are authored through the UI.
 *
 * The migration runner's `knex` is a thin pg shim: bindings are $n, never `?`.
 */

export async function up(knex) {
  let sp = 0;
  const safe = async (sql, params) => {
    const name = `sp_ips2_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql, params);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate object/i.test(err.message || '')) throw err;
    }
  };

  // ── 1. product-line master ───────────────────────────────────────────────────
  // display_name is a STORED generated column: it only reads same-table columns,
  // which Postgres allows, and it keeps "ASTRA - 415V" from being re-derived in
  // every route and page that shows it.
  await safe(`
    CREATE TABLE IF NOT EXISTS product_lines (
      id            SERIAL PRIMARY KEY,
      line_name     VARCHAR(60) NOT NULL,
      voltage       VARCHAR(20) NOT NULL,
      voltage_class VARCHAR(2)  NOT NULL,
      display_name  VARCHAR(90) GENERATED ALWAYS AS (line_name || ' - ' || voltage) STORED,
      description   TEXT,
      company_id    INTEGER,
      is_active     BOOLEAN NOT NULL DEFAULT TRUE,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW(),
      deleted_at    TIMESTAMPTZ
    )
  `);
  await safe(`ALTER TABLE product_lines ADD CONSTRAINT chk_product_lines_class CHECK (voltage_class IN ('LV','MV','HV'))`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_product_lines_company ON product_lines(company_id)`);
  await safe(`CREATE UNIQUE INDEX IF NOT EXISTS uq_product_lines_line_voltage ON product_lines(company_id, line_name, voltage) WHERE deleted_at IS NULL`);

  // Seeded per company, never with a NULL company_id: NULL-scoped rows are
  // invisible to scoped users and would make the grid's product filter read empty.
  await safe(`
    INSERT INTO product_lines (line_name, voltage, voltage_class, description, company_id)
    SELECT 'ASTRA', '415V', 'LV', 'Seeded from the IPS reference. Remaining product lines are authored in the UI.', c.id
      FROM companies c
     WHERE NOT EXISTS (
       SELECT 1 FROM product_lines pl
        WHERE pl.company_id = c.id AND pl.line_name = 'ASTRA' AND pl.voltage = '415V'
     )
  `);

  // ── 2. projects owns product line ────────────────────────────────────────────
  await safe(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS product_line_id INTEGER`);
  await safe(`
    ALTER TABLE projects
      ADD CONSTRAINT fk_projects_product_line
      FOREIGN KEY (product_line_id) REFERENCES product_lines(id) ON DELETE SET NULL
  `);
  await safe(`CREATE INDEX IF NOT EXISTS idx_projects_product_line ON projects(product_line_id)`);

  // ── 3. retire Phase 1's per-ticket guess ─────────────────────────────────────
  await safe(`ALTER TABLE support_tickets DROP COLUMN IF EXISTS product_type`);

  // ── 4. zone becomes compass; state gets its own home ─────────────────────────
  await safe(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS site_state VARCHAR(80)`);

  // Order matters: rescue the state value out of zone BEFORE overwriting zone.
  // Guarded by the compass list so re-running can never move 'South' into
  // site_state. Only IPP-000014 ('Tamil Nadu') is affected today.
  await safe(`
    UPDATE projects
       SET site_state = zone
     WHERE zone IS NOT NULL
       AND TRIM(zone) <> ''
       AND zone NOT IN ('North','South','East','West','Central')
       AND site_state IS NULL
  `);

  // Tamil Nadu (Coimbatore) => South. Kept as an explicit mapping rather than a
  // blanket default: any other non-compass zone is left alone and surfaces as an
  // exception rather than being silently bucketed into the wrong region.
  await safe(`UPDATE projects SET zone = 'South' WHERE zone = 'Tamil Nadu'`);

  await safe(`CREATE INDEX IF NOT EXISTS idx_projects_site_state ON projects(site_state)`);
}

export async function down(knex) {
  const safe = async (sql) => { try { await knex.raw(sql); } catch { /* ignore */ } };
  await safe(`DROP INDEX IF EXISTS idx_projects_site_state`);
  // zone/site_state values are NOT restored: the pre-migration zone was a state
  // held in the wrong column, and putting it back would reintroduce the very
  // ambiguity Phase 0 decision 5 settled.
  await safe(`ALTER TABLE projects DROP COLUMN IF EXISTS site_state`);
  await safe(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS product_type VARCHAR(80)`);
  await safe(`DROP INDEX IF EXISTS idx_projects_product_line`);
  await safe(`ALTER TABLE projects DROP CONSTRAINT IF EXISTS fk_projects_product_line`);
  await safe(`ALTER TABLE projects DROP COLUMN IF EXISTS product_line_id`);
  await safe(`DROP INDEX IF EXISTS uq_product_lines_line_voltage`);
  await safe(`DROP INDEX IF EXISTS idx_product_lines_company`);
  await safe(`DROP TABLE IF EXISTS product_lines`);
}
