/**
 * 20260717000002_customer_complaints_ipcs.js
 *
 * Phase 1 of the Customer Complaints (IPCS) build — see SERVICE_MASTER_IPCS_PLAN.md.
 *
 * `complaints` is a generic complaint tracker: free-text customer_name, a status
 * machine, SLA derived from priority. The IPCS reference grid needs the same
 * lifecycle plus the product-service dimensions it has never had — 1 of the 7
 * reference columns exists today. This adds the missing four as structure only;
 * the reads, the writers and the grid are Phases 2-3.
 *
 * Rather than fork a `customer_complaints` twin, this extends the table in place.
 * The reasoning mirrors 20260716000002 (one support_tickets, discriminated):
 * `complaints` already carries the FK backbone the build depends on — notably
 * support_tickets.complaint_id (20260715000001) and complaints.ncr_id — and a
 * twin would orphan all of it. The existing status machine, complaint_history,
 * soft-delete and company scoping are sound and are kept as-is.
 *
 * NUMBERING — CMP-YYYY-#### becomes IPCS-#####, and the 5 existing rows are
 * BACKFILLED (owner decision, 2026-07-17: they are seed data, so renumbering is
 * free and two coexisting ID formats in one grid is not). `complaint_number`
 * keeps its name; only the value format changes. One identifier per complaint —
 * a second `ipcs_number` column was rejected for the same reason 20260716000002
 * rejected `ips_number`: it would give every row two identities and make
 * search/export ambiguous.
 *
 * seq_cmp is deliberately left in place (unused after this) rather than dropped
 * in the same migration that stops using it — dropping it here would make `down`
 * unable to restore the old numbering.
 *
 * COLUMN NOTES
 *   project_id       the IPP link. Source of the reference's "Site" column via
 *                    projects.site_city — `complaints` gets no site column of its
 *                    own, so the two grids resolve a site name identically
 *                    (ips.routes.js:37) and can never disagree.
 *   product_line_id  FK to the master, NOT free text. The catalogue is
 *                    authoritative (owner decision): the reference checklist's
 *                    "Modular AHF" / "Modular SVG" do not exist — the real lines
 *                    are MBheem AHF and MV-VAJRA. No catalogue change here.
 *   serial_number    free text, no FK. serial_numbers is EMPTY (0 rows) because
 *                    production never registers serials, so an FK would be
 *                    unsatisfiable for every row. Traceability back to the
 *                    manufacturing batch is explicitly deferred.
 *   customer_mobile  NEW column, deliberately not a rename of customer_phone.
 *                    customer_phone is VARCHAR(50) free text holding legacy
 *                    format-free values; imposing the 10-digit rule on it would
 *                    reject existing rows on their next edit. Reads COALESCE the
 *                    two so legacy data still displays. Sized 15 to hold bare
 *                    10 digits with headroom, never a formatted string.
 *
 * NOT DONE HERE: no CHECK on customer_mobile. The 10-digit Indian rule is
 * enforced in the app (Phase 2c) where it can return a field-level 400; a CHECK
 * would also have to pass for the legacy rows it does not apply to.
 *
 * No NULL company_id backfill is needed — all 5 rows are already company_id = 1
 * (verified 2026-07-17), unlike the support_tickets case in 20260716000002.
 *
 * The migration runner's `knex` is a thin pg shim: bindings are $n, never `?`.
 */

export async function up(knex) {
  let sp = 0;
  const safe = async (sql, params) => {
    const name = `sp_ipcs_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql, params);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate object/i.test(err.message || '')) throw err;
    }
  };

  // ── 1. product-service dimensions ────────────────────────────────────────────
  // Columns and constraints are added in separate statements: ADD COLUMN IF NOT
  // EXISTS silently skips an inline REFERENCES when the column already exists
  // from earlier drift, leaving an unconstrained column behind (the trap
  // documented in 20260715000001).
  await safe(`ALTER TABLE complaints ADD COLUMN IF NOT EXISTS project_id      INTEGER`);
  await safe(`ALTER TABLE complaints ADD COLUMN IF NOT EXISTS product_line_id INTEGER`);
  await safe(`ALTER TABLE complaints ADD COLUMN IF NOT EXISTS serial_number   TEXT`);
  await safe(`ALTER TABLE complaints ADD COLUMN IF NOT EXISTS customer_mobile VARCHAR(15)`);

  // Null any pre-existing orphans before constraining, or ADD CONSTRAINT fails
  // validating them. No-ops on a fresh column; cheap insurance if one drifted in.
  await knex.raw(`
    UPDATE complaints SET project_id = NULL
     WHERE project_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = complaints.project_id)
  `);
  await knex.raw(`
    UPDATE complaints SET product_line_id = NULL
     WHERE product_line_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM product_lines pl WHERE pl.id = complaints.product_line_id)
  `);

  // SET NULL, not CASCADE: deleting a project or retiring a product line must
  // never delete the customer complaint raised against it.
  await safe(`
    ALTER TABLE complaints
      ADD CONSTRAINT fk_complaints_project
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
  `);
  await safe(`
    ALTER TABLE complaints
      ADD CONSTRAINT fk_complaints_product_line
      FOREIGN KEY (product_line_id) REFERENCES product_lines(id) ON DELETE SET NULL
  `);

  // ── 2. IPCS numbering ────────────────────────────────────────────────────────
  await safe(`CREATE SEQUENCE IF NOT EXISTS seq_ipcs START WITH 1 INCREMENT BY 1 NO CYCLE`);

  // Backfill CMP-YYYY-#### -> IPCS-#####. ROW_NUMBER over id, not a bare
  // nextval() in the SET: an UPDATE has no row order, so nextval would assign
  // numbers arbitrarily. Ordering by id (insertion order, which is what the CMP
  // counter followed) makes IPCS-0000n land on the row that was CMP-YYYY-000n —
  // note created_at is NOT monotonic with id here, so ordering by date would
  // silently permute the mapping. Only touches 'CMP-%' rows, so a re-run is a
  // no-op and rows already renumbered by a partial run are left alone.
  await knex.raw(`
    WITH ordered AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn
        FROM complaints
       WHERE complaint_number LIKE 'CMP-%'
    )
    UPDATE complaints c
       SET complaint_number = 'IPCS-' || LPAD(o.rn::text, 5, '0')
      FROM ordered o
     WHERE c.id = o.id
  `);

  // Park the sequence past the highest number actually present, derived from the
  // data rather than from a row count — a count would collide if a row were ever
  // hard-deleted. is_called=false means the next nextval() returns exactly this
  // value, so an empty table correctly yields IPCS-00001.
  await knex.raw(`
    SELECT setval(
      'seq_ipcs',
      COALESCE(
        (SELECT MAX(SUBSTRING(complaint_number FROM 6)::int)
           FROM complaints
          WHERE complaint_number ~ '^IPCS-[0-9]+$'),
        0
      ) + 1,
      false
    )
  `);

  // ── 3. indexes for the IPCS grid ─────────────────────────────────────────────
  // Partial on deleted_at IS NULL, matching the grid's own WHERE.
  await safe(`CREATE INDEX IF NOT EXISTS idx_complaints_project      ON complaints(project_id)      WHERE deleted_at IS NULL`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_complaints_product_line ON complaints(product_line_id) WHERE deleted_at IS NULL`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_complaints_serial       ON complaints(serial_number)   WHERE deleted_at IS NULL`);
}

export async function down(knex) {
  const safe = async (sql) => { try { await knex.raw(sql); } catch { /* ignore */ } };

  // Restore CMP-YYYY-#### before dropping anything, so the rows are recoverable.
  // The original per-year counters are not, so this reissues them off seq_cmp
  // (still present and untouched) using the created_at year each row was raised
  // in. Numbers will differ from the pre-migration values; the format will not.
  await safe(`
    WITH ordered AS (
      SELECT id, created_at, ROW_NUMBER() OVER (ORDER BY id) AS rn
        FROM complaints
       WHERE complaint_number ~ '^IPCS-[0-9]+$'
    )
    UPDATE complaints c
       SET complaint_number = 'CMP-' || to_char(o.created_at, 'YYYY') || '-' || LPAD(o.rn::text, 4, '0')
      FROM ordered o
     WHERE c.id = o.id
  `);
  await safe(`SELECT setval('seq_cmp', GREATEST((SELECT COUNT(*) FROM complaints), 1), true)`);

  await safe(`DROP INDEX IF EXISTS idx_complaints_serial`);
  await safe(`DROP INDEX IF EXISTS idx_complaints_product_line`);
  await safe(`DROP INDEX IF EXISTS idx_complaints_project`);
  await safe(`DROP SEQUENCE IF EXISTS seq_ipcs`);
  await safe(`ALTER TABLE complaints DROP CONSTRAINT IF EXISTS fk_complaints_product_line`);
  await safe(`ALTER TABLE complaints DROP CONSTRAINT IF EXISTS fk_complaints_project`);
  await safe(`ALTER TABLE complaints DROP COLUMN IF EXISTS customer_mobile`);
  await safe(`ALTER TABLE complaints DROP COLUMN IF EXISTS serial_number`);
  await safe(`ALTER TABLE complaints DROP COLUMN IF EXISTS product_line_id`);
  await safe(`ALTER TABLE complaints DROP COLUMN IF EXISTS project_id`);
}
