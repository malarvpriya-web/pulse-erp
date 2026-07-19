/**
 * Migration: customer_drive_folders + customer_drive_files
 * Caches Google Drive folder IDs per customer + doc type.
 * Avoids repeated Drive API list calls on every document upload.
 */
export async function up(knex) {
  // ── customer_drive_folders ───────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS customer_drive_folders (
      id               SERIAL PRIMARY KEY,
      company_id       INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      customer_id      INTEGER,
      customer_name    TEXT NOT NULL,
      doc_type         TEXT NOT NULL,
      drive_folder_id  TEXT NOT NULL,
      drive_folder_url TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, customer_name, doc_type)
    )
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_cdf_customer_id ON customer_drive_folders(customer_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_cdf_company_id  ON customer_drive_folders(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_cdf_doc_type    ON customer_drive_folders(doc_type)`);

  // ── customer_drive_files ─────────────────────────────────────────────────────
  // Tracks every file uploaded to a customer's Drive folder
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS customer_drive_files (
      id               SERIAL PRIMARY KEY,
      company_id       INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      customer_id      INTEGER,
      customer_name    TEXT NOT NULL,
      doc_type         TEXT NOT NULL,
      drive_file_id    TEXT NOT NULL UNIQUE,
      file_name        TEXT NOT NULL,
      drive_link       TEXT,
      mime_type        TEXT,
      file_size_bytes  BIGINT,
      checksum_sha256  TEXT,
      entity_type      TEXT,
      entity_id        TEXT,
      uploaded_by      INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_cdfiles_customer ON customer_drive_files(customer_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_cdfiles_company  ON customer_drive_files(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_cdfiles_doc_type ON customer_drive_files(doc_type)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_cdfiles_entity   ON customer_drive_files(entity_type, entity_id)`);

  console.log('✅ Migration 20260616000001_customer_drive_folders complete');
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS customer_drive_files CASCADE');
  await knex.raw('DROP TABLE IF EXISTS customer_drive_folders CASCADE');
}
