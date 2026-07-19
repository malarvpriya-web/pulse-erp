/**
 * Phase 49B — Employee compliance documents tracker.
 *
 * Tracks time-sensitive identity and regulatory documents per employee
 * (visas, work permits, professional certifications, licences) so HR
 * can get advance alerts before expiry.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS employee_compliance_docs (
      id            SERIAL PRIMARY KEY,
      employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      company_id    INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      doc_type      VARCHAR(100) NOT NULL,
      doc_number    VARCHAR(100),
      issued_by     VARCHAR(200),
      issue_date    DATE,
      expiry_date   DATE NOT NULL,
      status        VARCHAR(30) NOT NULL DEFAULT 'valid',
      notes         TEXT,
      created_by    INTEGER,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_compliance_docs_employee
      ON employee_compliance_docs(employee_id);
    CREATE INDEX IF NOT EXISTS idx_compliance_docs_expiry
      ON employee_compliance_docs(expiry_date)
      WHERE status = 'valid';
    CREATE INDEX IF NOT EXISTS idx_compliance_docs_company
      ON employee_compliance_docs(company_id, expiry_date);
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS employee_compliance_docs CASCADE`);
}
