/**
 * 20260718000003_rd_plm.js
 *
 * R&D / PLM module (Manifest OS gap). The engineering module already has R&D
 * project tracking (eng_rd_projects, eng_design_phases, eng_prototypes,
 * eng_test_plans), IPD (eng_development) and ECN (engineering_changes). The
 * MISSING pieces this migration adds:
 *
 *   rd_artifacts             — versioned repository for PCB / firmware / software
 *                              / schematic / mechanical / document artifacts,
 *                              keyed to a product line. Versions of one artifact
 *                              share (product_line, type, name); releasing a new
 *                              version supersedes the prior released one.
 *   rd_patents               — patent / IP tracker (patent|trademark|design|
 *                              copyright) with filing/grant/expiry + status.
 *   product_lifecycle        — the PLM spine: one row per product line with its
 *                              current lifecycle stage. Distinct from
 *                              lifecycle_instances (that is the ORDER→commissioning
 *                              flow, tied to sales/production orders — not the
 *                              product-development lifecycle).
 *   product_lifecycle_events — stage-transition history.
 *
 * company_id NOT NULL DEFAULT 1 (nullable company_id is the documented scoping
 * bug). Taxonomies validated in the route layer, not DB CHECKs.
 */

export async function up(knex) {
  const safe = async (label, sql) => {
    const sp = `sp_rd_${label.replace(/\W/g, '_').slice(0, 40)}`;
    await knex.raw(`SAVEPOINT ${sp}`);
    try { await knex.raw(sql); await knex.raw(`RELEASE SAVEPOINT ${sp}`); }
    catch (e) { await knex.raw(`ROLLBACK TO SAVEPOINT ${sp}`); console.warn(`[rd_plm] skipped (${label}): ${e.message.split('\n')[0]}`); }
  };

  await safe('artifacts', `
    CREATE TABLE IF NOT EXISTS rd_artifacts (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id) ON DELETE SET NULL,
      product_line_id INTEGER REFERENCES product_lines(id) ON DELETE SET NULL,
      artifact_type   VARCHAR(30) NOT NULL DEFAULT 'document', -- pcb|firmware|software|schematic|mechanical|document
      name            VARCHAR(200) NOT NULL,
      version         VARCHAR(40)  NOT NULL DEFAULT 'v1',
      status          VARCHAR(30)  NOT NULL DEFAULT 'draft',   -- draft|in_review|released|superseded|obsolete
      file_url        TEXT,
      checksum        VARCHAR(80),
      description     TEXT,
      released_at     TIMESTAMPTZ,
      created_by      INTEGER,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW(),
      deleted_at      TIMESTAMPTZ
    )`);
  // One version string per artifact family. COALESCE keeps NULL product_line
  // families distinct-by-value without needing NULLS NOT DISTINCT.
  await safe('uq_artifact_ver', `CREATE UNIQUE INDEX IF NOT EXISTS uq_rd_artifact_version
    ON rd_artifacts (company_id, COALESCE(product_line_id, 0), artifact_type, name, version) WHERE deleted_at IS NULL`);
  await safe('idx_artifact_family', `CREATE INDEX IF NOT EXISTS idx_rd_artifacts_family ON rd_artifacts (company_id, artifact_type, name)`);

  await safe('patents', `
    CREATE TABLE IF NOT EXISTS rd_patents (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id) ON DELETE SET NULL,
      title           VARCHAR(255) NOT NULL,
      ip_type         VARCHAR(30) NOT NULL DEFAULT 'patent', -- patent|trademark|design|copyright
      application_no  VARCHAR(100),
      jurisdiction    VARCHAR(80),
      status          VARCHAR(30) NOT NULL DEFAULT 'idea',   -- idea|drafting|filed|published|granted|rejected|lapsed|abandoned
      filing_date     DATE,
      grant_date      DATE,
      expiry_date     DATE,
      inventors       TEXT,
      product_line_id INTEGER REFERENCES product_lines(id) ON DELETE SET NULL,
      notes           TEXT,
      created_by      INTEGER,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW(),
      deleted_at      TIMESTAMPTZ
    )`);
  await safe('idx_patent_status', `CREATE INDEX IF NOT EXISTS idx_rd_patents_status ON rd_patents (company_id, status)`);

  await safe('plm', `
    CREATE TABLE IF NOT EXISTS product_lifecycle (
      id               SERIAL PRIMARY KEY,
      company_id       INTEGER NOT NULL DEFAULT 1,
      product_line_id  INTEGER NOT NULL UNIQUE REFERENCES product_lines(id) ON DELETE CASCADE,
      current_stage    VARCHAR(30) NOT NULL DEFAULT 'concept', -- concept|design|prototype|validation|production|maintenance|eol
      stage_entered_at TIMESTAMPTZ DEFAULT NOW(),
      owner_name       VARCHAR(120),
      notes            TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safe('plm_events', `
    CREATE TABLE IF NOT EXISTS product_lifecycle_events (
      id                   SERIAL PRIMARY KEY,
      product_lifecycle_id INTEGER NOT NULL REFERENCES product_lifecycle(id) ON DELETE CASCADE,
      from_stage           VARCHAR(30),
      to_stage             VARCHAR(30) NOT NULL,
      changed_by           INTEGER,
      changed_by_name      VARCHAR(120),
      note                 TEXT,
      created_at           TIMESTAMPTZ DEFAULT NOW()
    )`);

  console.log('[migration 20260718000003] rd_plm applied.');
}

export async function down(knex) {
  const safe = async (sql) => { try { await knex.raw(sql); } catch { /* ignore */ } };
  await safe(`DROP TABLE IF EXISTS product_lifecycle_events CASCADE`);
  await safe(`DROP TABLE IF EXISTS product_lifecycle CASCADE`);
  await safe(`DROP TABLE IF EXISTS rd_patents CASCADE`);
  await safe(`DROP TABLE IF EXISTS rd_artifacts CASCADE`);
}
