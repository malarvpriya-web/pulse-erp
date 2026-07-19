/**
 * Phase 49C — Employee Documents consolidation.
 *
 * Enriches employee_documents to be the single source of truth for HR
 * supplemental document records:
 *   - status (replaces bare `verified` boolean)
 *   - drive_url for Google Drive links
 *   - company_id for multi-tenant scoping
 *   - expiry_date for visa/permit/cert expiry tracking
 *   - uploaded_by to track who added the record
 *   - notes for HR context
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE employee_documents
      ADD COLUMN IF NOT EXISTS status       VARCHAR(30) DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS drive_url    TEXT,
      ADD COLUMN IF NOT EXISTS company_id   INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS expiry_date  DATE,
      ADD COLUMN IF NOT EXISTS uploaded_by  INTEGER,
      ADD COLUMN IF NOT EXISTS notes        TEXT
  `);

  // Backfill status from the legacy verified boolean
  await knex.raw(`
    UPDATE employee_documents
    SET status = CASE WHEN verified = true THEN 'verified' ELSE 'pending' END
    WHERE status = 'pending'
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_emp_docs_company ON employee_documents(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_emp_docs_status  ON employee_documents(employee_id, status)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_emp_docs_expiry  ON employee_documents(expiry_date) WHERE expiry_date IS NOT NULL`);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE employee_documents
      DROP COLUMN IF EXISTS status,
      DROP COLUMN IF EXISTS drive_url,
      DROP COLUMN IF EXISTS company_id,
      DROP COLUMN IF EXISTS expiry_date,
      DROP COLUMN IF EXISTS uploaded_by,
      DROP COLUMN IF EXISTS notes
  `);
}
