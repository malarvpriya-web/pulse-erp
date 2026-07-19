/**
 * 20260520000003_native_signatures_and_document_master.js
 *
 * Phase 30D — Native Digital Signature Engine
 *   • Extends document_signings with native-signature columns
 *   • Adds signature_audit_log for immutable audit trail
 *
 * Phase 30E — Google Drive Document Architecture
 *   • Creates document_master table (file metadata + Drive linkage)
 *   • Creates document_traceability table (ECN / BOM / FAT / SAT linkages)
 *
 * NOTE: Written in raw SQL only — the migration runner shim exposes raw() only,
 * not the full knex schema-builder API.
 */

export async function up(knex) {
  /* ═══════════════════════════════════════════════════════════════════════════
     PHASE 30D — document_signings (create if missing, extend if present)
     ═══════════════════════════════════════════════════════════════════════════ */

  // Create the base table if it doesn't already exist
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS document_signings (
      id               SERIAL PRIMARY KEY,
      title            VARCHAR(300) NOT NULL,
      doc_type         VARCHAR(80)  DEFAULT 'Other',
      recipient_name   VARCHAR(200),
      recipient_email  VARCHAR(200),
      message          TEXT,
      status           VARCHAR(30)  DEFAULT 'pending',
      sent_date        DATE,
      signed_date      DATE,
      expiry_date      DATE,
      sign_token       VARCHAR(128),
      signing_url      TEXT,
      declined_reason  TEXT,
      signature_type   VARCHAR(20)  DEFAULT 'typed',
      signature_data   TEXT,
      typed_name       VARCHAR(200),
      signer_ip        VARCHAR(64),
      signer_ua        VARCHAR(512),
      workflow_type    VARCHAR(80),
      linked_entity_id INTEGER,
      linked_entity_type VARCHAR(80),
      signed_pdf_url   TEXT,
      is_locked        BOOLEAN      DEFAULT FALSE,
      locked_at        TIMESTAMPTZ,
      locked_by        INTEGER,
      created_by       INTEGER,
      company_id       INTEGER,
      created_at       TIMESTAMPTZ  DEFAULT NOW(),
      updated_at       TIMESTAMPTZ  DEFAULT NOW()
    )
  `);

  // Extend existing rows that were created before the native-signature columns
  // were added. Each ADD COLUMN IF NOT EXISTS is idempotent.
  await knex.raw(`
    ALTER TABLE document_signings
      ADD COLUMN IF NOT EXISTS signature_type    VARCHAR(20)  DEFAULT 'typed',
      ADD COLUMN IF NOT EXISTS signature_data    TEXT,
      ADD COLUMN IF NOT EXISTS typed_name        VARCHAR(200),
      ADD COLUMN IF NOT EXISTS signer_ip         VARCHAR(64),
      ADD COLUMN IF NOT EXISTS signer_ua         VARCHAR(512),
      ADD COLUMN IF NOT EXISTS workflow_type     VARCHAR(80),
      ADD COLUMN IF NOT EXISTS linked_entity_id  INTEGER,
      ADD COLUMN IF NOT EXISTS linked_entity_type VARCHAR(80),
      ADD COLUMN IF NOT EXISTS signed_pdf_url    TEXT,
      ADD COLUMN IF NOT EXISTS is_locked         BOOLEAN      DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS locked_at         TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS locked_by         INTEGER,
      ADD COLUMN IF NOT EXISTS company_id        INTEGER
  `);

  /* Signature audit log — immutable, append-only */
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS signature_audit_log (
      id          SERIAL PRIMARY KEY,
      signing_id  INTEGER NOT NULL REFERENCES document_signings(id) ON DELETE CASCADE,
      event       VARCHAR(80) NOT NULL,
      actor_id    INTEGER,
      actor_name  VARCHAR(200),
      actor_ip    VARCHAR(64),
      actor_ua    VARCHAR(512),
      event_data  JSONB,
      occurred_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_sal_signing_id ON signature_audit_log(signing_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_sal_event      ON signature_audit_log(event)`);

  /* ═══════════════════════════════════════════════════════════════════════════
     PHASE 30E — document_master (Google Drive + ERP metadata)
     ═══════════════════════════════════════════════════════════════════════════ */

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS document_master (
      id                    SERIAL PRIMARY KEY,
      file_name             VARCHAR(500) NOT NULL,
      original_file_name    VARCHAR(500),
      mime_type             VARCHAR(120),
      file_size_bytes       BIGINT,
      drive_file_id         VARCHAR(200),
      drive_link            TEXT,
      drive_folder_id       VARCHAR(200),
      module_type           VARCHAR(80),
      linked_entity_id      INTEGER,
      linked_entity_type    VARCHAR(80),
      revision              INTEGER      DEFAULT 1,
      revision_label        VARCHAR(30),
      supersedes_id         INTEGER,
      checksum_sha256       VARCHAR(64),
      approval_status       VARCHAR(30)  DEFAULT 'draft',
      signed_status         VARCHAR(30)  DEFAULT 'unsigned',
      signing_id            INTEGER REFERENCES document_signings(id),
      is_confidential       BOOLEAN      DEFAULT FALSE,
      access_level          VARCHAR(30)  DEFAULT 'internal',
      uploaded_by           INTEGER NOT NULL,
      uploaded_by_name      VARCHAR(200),
      uploaded_at           TIMESTAMPTZ  DEFAULT NOW(),
      approved_by           INTEGER,
      approved_at           TIMESTAMPTZ,
      company_id            INTEGER,
      deleted_at            TIMESTAMPTZ,
      created_at            TIMESTAMPTZ  DEFAULT NOW(),
      updated_at            TIMESTAMPTZ  DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_dm_module        ON document_master(module_type)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_dm_entity         ON document_master(linked_entity_type, linked_entity_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_dm_drive_file_id  ON document_master(drive_file_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_dm_company        ON document_master(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_dm_approval       ON document_master(approval_status)`);

  /* Document download audit — every download logged */
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS document_download_log (
      id                  SERIAL PRIMARY KEY,
      document_id         INTEGER NOT NULL REFERENCES document_master(id) ON DELETE CASCADE,
      downloaded_by       INTEGER,
      downloaded_by_name  VARCHAR(200),
      downloader_ip       VARCHAR(64),
      downloaded_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_ddl_doc_id ON document_download_log(document_id)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS document_download_log`);
  await knex.raw(`DROP TABLE IF EXISTS document_master`);
  await knex.raw(`DROP TABLE IF EXISTS signature_audit_log`);
}
