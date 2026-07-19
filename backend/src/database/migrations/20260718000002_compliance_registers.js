/**
 * 20260718000002_compliance_registers.js
 *
 * Compliance module (Manifest OS gap) — an organisational standards register +
 * audit calendar. Distinct from the existing HR tables (`certifications`,
 * `employee_certifications`, `employee_compliance_docs`) which track PEOPLE's
 * training/credentials, not the company's certification to a standard.
 *
 *   compliance_standards — one row per standard the company must hold/track
 *     (ISO 14001/45001, IEC 61000, IEEE 519, BIS, RoHS, CE, UL, …) with status,
 *     certifying body, certificate number, and issue/expiry dates.
 *   compliance_evidence  — documents attached to a standard (audit reports,
 *     certificates, test results).
 *   compliance_audits    — the audit calendar: internal/external/surveillance
 *     audits against a standard, scheduled/completed dates, result, next due.
 *
 * company_id is NOT NULL DEFAULT 1 everywhere (nullable company_id is the
 * documented scoping bug here). Taxonomies (status/category/audit_type/result)
 * are validated in the route layer, not DB CHECKs, matching the codebase norm.
 *
 * The standards catalogue is SEEDED as status 'not_started' — a list of what to
 * track, not a claim of being certified. The seed is idempotent (WHERE NOT
 * EXISTS on company_id+code).
 */

export async function up(knex) {
  const safe = async (label, sql) => {
    const sp = `sp_comp_${label.replace(/\W/g, '_').slice(0, 40)}`;
    await knex.raw(`SAVEPOINT ${sp}`);
    try { await knex.raw(sql); await knex.raw(`RELEASE SAVEPOINT ${sp}`); }
    catch (e) { await knex.raw(`ROLLBACK TO SAVEPOINT ${sp}`); console.warn(`[compliance] skipped (${label}): ${e.message.split('\n')[0]}`); }
  };

  await safe('standards', `
    CREATE TABLE IF NOT EXISTS compliance_standards (
      id                 SERIAL PRIMARY KEY,
      company_id         INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id) ON DELETE SET NULL,
      code               VARCHAR(40)  NOT NULL,
      title              VARCHAR(255) NOT NULL,
      category           VARCHAR(40)  DEFAULT 'management_system', -- management_system | product | regulatory
      scope              TEXT,
      certifying_body    VARCHAR(150),
      certificate_number VARCHAR(100),
      status             VARCHAR(30)  NOT NULL DEFAULT 'not_started', -- not_started | in_progress | certified | expired | lapsed
      issue_date         DATE,
      expiry_date        DATE,
      owner_name         VARCHAR(120),
      notes              TEXT,
      created_by         INTEGER,
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      updated_at         TIMESTAMPTZ DEFAULT NOW(),
      deleted_at         TIMESTAMPTZ
    )`);
  await safe('uq_standard', `CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_standard_code ON compliance_standards(company_id, code) WHERE deleted_at IS NULL`);
  await safe('idx_std_status', `CREATE INDEX IF NOT EXISTS idx_compliance_standards_status ON compliance_standards(company_id, status)`);
  await safe('idx_std_expiry', `CREATE INDEX IF NOT EXISTS idx_compliance_standards_expiry ON compliance_standards(expiry_date)`);

  await safe('evidence', `
    CREATE TABLE IF NOT EXISTS compliance_evidence (
      id          SERIAL PRIMARY KEY,
      standard_id INTEGER NOT NULL REFERENCES compliance_standards(id) ON DELETE CASCADE,
      company_id  INTEGER NOT NULL DEFAULT 1,
      title       VARCHAR(255) NOT NULL,
      doc_url     TEXT,
      uploaded_by INTEGER,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safe('idx_evidence', `CREATE INDEX IF NOT EXISTS idx_compliance_evidence_standard ON compliance_evidence(standard_id)`);

  await safe('audits', `
    CREATE TABLE IF NOT EXISTS compliance_audits (
      id             SERIAL PRIMARY KEY,
      company_id     INTEGER NOT NULL DEFAULT 1,
      standard_id    INTEGER REFERENCES compliance_standards(id) ON DELETE CASCADE,
      audit_type     VARCHAR(30) NOT NULL DEFAULT 'internal', -- internal | external | surveillance | recertification
      title          VARCHAR(255),
      scheduled_date DATE,
      completed_date DATE,
      auditor        VARCHAR(150),
      result         VARCHAR(30), -- pass | minor_nc | major_nc | pending
      findings_count INTEGER DEFAULT 0,
      next_due_date  DATE,
      status         VARCHAR(30) NOT NULL DEFAULT 'scheduled', -- scheduled | completed | overdue | cancelled
      notes          TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safe('idx_audits_std', `CREATE INDEX IF NOT EXISTS idx_compliance_audits_standard ON compliance_audits(standard_id)`);
  await safe('idx_audits_due', `CREATE INDEX IF NOT EXISTS idx_compliance_audits_due ON compliance_audits(company_id, status, scheduled_date)`);

  // ── seed the applicable standards catalogue (idempotent, status not_started) ──
  const catalogue = [
    ['ISO 9001',   'Quality Management System',                'management_system'],
    ['ISO 14001',  'Environmental Management System',          'management_system'],
    ['ISO 45001',  'Occupational Health & Safety Management',  'management_system'],
    ['IEC 61000',  'Electromagnetic Compatibility (EMC)',      'product'],
    ['IEEE 519',   'Harmonic Control in Power Systems',        'product'],
    ['BIS',        'Bureau of Indian Standards certification', 'regulatory'],
    ['RoHS',       'Restriction of Hazardous Substances',      'product'],
    ['CE',         'CE Marking (EU conformity)',               'product'],
    ['UL',         'Underwriters Laboratories safety',         'product'],
  ];
  for (const [code, title, category] of catalogue) {
    await safe(`seed_${code}`, `
      INSERT INTO compliance_standards (company_id, code, title, category, status)
      SELECT 1, '${code.replace(/'/g, "''")}', '${title.replace(/'/g, "''")}', '${category}', 'not_started'
      WHERE NOT EXISTS (SELECT 1 FROM compliance_standards WHERE company_id = 1 AND code = '${code.replace(/'/g, "''")}')`);
  }

  console.log('[migration 20260718000002] compliance_registers applied.');
}

export async function down(knex) {
  const safe = async (sql) => { try { await knex.raw(sql); } catch { /* ignore */ } };
  await safe(`DROP TABLE IF EXISTS compliance_audits CASCADE`);
  await safe(`DROP TABLE IF EXISTS compliance_evidence CASCADE`);
  await safe(`DROP TABLE IF EXISTS compliance_standards CASCADE`);
}
