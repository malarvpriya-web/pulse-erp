/**
 * 20260701000001_esign_fields_templates.js
 *
 * Zoho-Sign parity — Phase 52 (Core e-sign)
 *
 *   • Extends document_signings with source-document, signed-PDF,
 *     completion-certificate, tamper-hash and reminder columns.
 *   • signature_fields — drag-and-drop field placement (signature, initials,
 *     date, text, name, email, checkbox …) positioned by page + 0..1 ratios
 *     so stamping is resolution-independent.
 *   • signature_templates — reusable documents with a saved field layout and
 *     signer-role plan.
 *
 * Raw SQL only (migration runner exposes knex.raw()).
 */

export async function up(knex) {
  /* ── document_signings: new columns (all idempotent) ───────────────────── */
  await knex.raw(`
    ALTER TABLE document_signings
      ADD COLUMN IF NOT EXISTS source_file_path   TEXT,
      ADD COLUMN IF NOT EXISTS source_file_name   VARCHAR(500),
      ADD COLUMN IF NOT EXISTS source_mime        VARCHAR(120),
      ADD COLUMN IF NOT EXISTS page_count         INTEGER,
      ADD COLUMN IF NOT EXISTS signed_pdf_path    TEXT,
      ADD COLUMN IF NOT EXISTS certificate_path   TEXT,
      ADD COLUMN IF NOT EXISTS reminder_count     INTEGER     DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_reminder_at   TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS template_id        INTEGER,
      ADD COLUMN IF NOT EXISTS completed_at       TIMESTAMPTZ
  `);

  /* ── signature_fields ──────────────────────────────────────────────────── */
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS signature_fields (
      id            SERIAL PRIMARY KEY,
      signing_id    INTEGER NOT NULL REFERENCES document_signings(id) ON DELETE CASCADE,
      signer_id     INTEGER REFERENCES signature_signers(id) ON DELETE CASCADE,
      field_type    VARCHAR(20) NOT NULL DEFAULT 'signature'
                      CHECK (field_type IN ('signature','initials','date','text','name','email','company','title','checkbox')),
      page          INTEGER     NOT NULL DEFAULT 1,
      x_ratio       NUMERIC(8,6) NOT NULL,
      y_ratio       NUMERIC(8,6) NOT NULL,
      w_ratio       NUMERIC(8,6) NOT NULL DEFAULT 0.20,
      h_ratio       NUMERIC(8,6) NOT NULL DEFAULT 0.05,
      required      BOOLEAN     NOT NULL DEFAULT TRUE,
      label         VARCHAR(120),
      font_size     INTEGER     DEFAULT 12,
      value         TEXT,
      filled        BOOLEAN     NOT NULL DEFAULT FALSE,
      filled_at     TIMESTAMPTZ,
      company_id    INTEGER,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_sig_fields_signing ON signature_fields(signing_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_sig_fields_signer  ON signature_fields(signer_id)`);

  /* ── signature_templates ───────────────────────────────────────────────── */
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS signature_templates (
      id                 SERIAL PRIMARY KEY,
      name               VARCHAR(300) NOT NULL,
      description        TEXT,
      doc_type           VARCHAR(80) DEFAULT 'Other',
      source_file_path   TEXT,
      source_file_name   VARCHAR(500),
      source_mime        VARCHAR(120),
      page_count         INTEGER,
      fields_json        JSONB       DEFAULT '[]'::jsonb,
      roles_json         JSONB       DEFAULT '[]'::jsonb,
      message            TEXT,
      expiry_days        INTEGER     DEFAULT 14,
      require_otp        BOOLEAN     DEFAULT FALSE,
      created_by         INTEGER,
      created_by_name    VARCHAR(200),
      company_id         INTEGER,
      deleted_at         TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_sig_templates_company ON signature_templates(company_id)`);

  /* ── require_otp on document_signings (per-request toggle) ──────────────── */
  await knex.raw(`ALTER TABLE document_signings ADD COLUMN IF NOT EXISTS require_otp BOOLEAN DEFAULT FALSE`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS signature_fields CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS signature_templates CASCADE`);
  // Columns left in place on document_signings (non-destructive down).
}
