/**
 * 20260702000001_esign_advanced.js
 *
 * Zoho-Sign parity — Phase 53 (Advanced)
 *   • Auto-reminder scheduling config on document_signings
 *   • Bulk-send batch grouping
 *   • Payment-on-sign fields
 *   • Signer phone / in-person / delegation / OTP channel on signature_signers
 *   • signature_attachments — files uploaded by signers
 *   • esign_webhooks + esign_webhook_deliveries — outbound event webhooks
 *
 * Raw SQL only (migration runner exposes knex.raw()).
 */

export async function up(knex) {
  /* ── document_signings: reminders, bulk, payment ───────────────────────── */
  await knex.raw(`
    ALTER TABLE document_signings
      ADD COLUMN IF NOT EXISTS auto_reminder          BOOLEAN     DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS reminder_interval_days INTEGER     DEFAULT 3,
      ADD COLUMN IF NOT EXISTS max_reminders          INTEGER     DEFAULT 3,
      ADD COLUMN IF NOT EXISTS bulk_batch_id          VARCHAR(64),
      ADD COLUMN IF NOT EXISTS payment_required       BOOLEAN     DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS payment_amount         NUMERIC(14,2),
      ADD COLUMN IF NOT EXISTS payment_currency       VARCHAR(8)  DEFAULT 'INR',
      ADD COLUMN IF NOT EXISTS payment_status         VARCHAR(20) DEFAULT 'none',
      ADD COLUMN IF NOT EXISTS payment_ref            VARCHAR(128),
      ADD COLUMN IF NOT EXISTS payment_order_id       VARCHAR(128),
      ADD COLUMN IF NOT EXISTS payment_note           VARCHAR(300),
      ADD COLUMN IF NOT EXISTS recipient_phone        VARCHAR(32)
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_ds_bulk_batch ON document_signings(bulk_batch_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_ds_auto_reminder ON document_signings(auto_reminder) WHERE auto_reminder = TRUE`);

  /* ── signature_signers: phone, in-person, delegation, otp channel ──────── */
  await knex.raw(`
    ALTER TABLE signature_signers
      ADD COLUMN IF NOT EXISTS signer_phone         VARCHAR(32),
      ADD COLUMN IF NOT EXISTS in_person            BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS otp_channel          VARCHAR(10) DEFAULT 'email',
      ADD COLUMN IF NOT EXISTS delegated_from_email VARCHAR(255),
      ADD COLUMN IF NOT EXISTS delegated_from_name  VARCHAR(255),
      ADD COLUMN IF NOT EXISTS delegate_reason      TEXT,
      ADD COLUMN IF NOT EXISTS delegated_at         TIMESTAMPTZ
  `);

  /* ── signature_attachments ─────────────────────────────────────────────── */
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS signature_attachments (
      id                SERIAL PRIMARY KEY,
      signing_id        INTEGER NOT NULL REFERENCES document_signings(id) ON DELETE CASCADE,
      signer_id         INTEGER REFERENCES signature_signers(id) ON DELETE SET NULL,
      file_path         TEXT    NOT NULL,
      file_name         VARCHAR(500),
      mime              VARCHAR(120),
      size_bytes        BIGINT,
      uploaded_by_name  VARCHAR(255),
      uploader_ip       VARCHAR(64),
      company_id        INTEGER,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_sig_attach_signing ON signature_attachments(signing_id)`);

  /* ── esign_webhooks ────────────────────────────────────────────────────── */
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS esign_webhooks (
      id               SERIAL PRIMARY KEY,
      company_id       INTEGER,
      url              TEXT    NOT NULL,
      secret           VARCHAR(128),
      events           JSONB   DEFAULT '["all"]'::jsonb,
      active           BOOLEAN DEFAULT TRUE,
      description      VARCHAR(300),
      created_by       INTEGER,
      last_status      INTEGER,
      last_delivered_at TIMESTAMPTZ,
      failure_count    INTEGER DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_esign_wh_company ON esign_webhooks(company_id)`);

  /* ── esign_webhook_deliveries ──────────────────────────────────────────── */
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS esign_webhook_deliveries (
      id               SERIAL PRIMARY KEY,
      webhook_id       INTEGER REFERENCES esign_webhooks(id) ON DELETE CASCADE,
      event            VARCHAR(60),
      signing_id       INTEGER,
      response_status  INTEGER,
      success          BOOLEAN,
      error            TEXT,
      attempted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_esign_whd_webhook ON esign_webhook_deliveries(webhook_id)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS esign_webhook_deliveries CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS esign_webhooks CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS signature_attachments CASCADE`);
  // Columns left in place (non-destructive down).
}
