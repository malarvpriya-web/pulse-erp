/**
 * QR Share Module — document / link / text / visiting-card QR codes
 *
 * Distinct from qr_attendance_* (site clock-in QRs). These QRs are created by
 * staff to share files, links, or contact cards with customers/consultants
 * WITHOUT sending the file itself. Each QR encodes a public tokenized URL
 * (/api/v1/q/:token) so every scan is tracked.
 *
 * qr_share_codes: one row per generated QR (owner, type, payload, style opts).
 * qr_share_scans: one row per public scan (for admin analytics).
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS qr_share_codes (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER,
      created_by      INTEGER NOT NULL,                -- users.id
      title           VARCHAR(255) NOT NULL,
      qr_type         VARCHAR(20) NOT NULL DEFAULT 'file'
                      CHECK (qr_type IN ('file','url','text','vcard')),
      share_token     VARCHAR(64) UNIQUE NOT NULL,
      -- file payload
      file_path       TEXT,
      file_name       VARCHAR(255),
      file_mime       VARCHAR(150),
      file_size_bytes BIGINT,
      -- url / text / vcard payloads
      target_url      TEXT,
      content_text    TEXT,
      vcard           JSONB,
      -- who it was created for
      recipient_name  VARCHAR(255),
      recipient_type  VARCHAR(30) DEFAULT 'customer'
                      CHECK (recipient_type IN ('customer','consultant','vendor','partner','internal','other')),
      -- QR styling options (rendered client-side)
      fg_color        VARCHAR(9)  DEFAULT '#000000',
      bg_color        VARCHAR(9)  DEFAULT '#FFFFFF',
      with_logo       BOOLEAN     DEFAULT FALSE,
      -- lifecycle + analytics
      scan_count      INTEGER     DEFAULT 0,
      last_scanned_at TIMESTAMPTZ,
      is_active       BOOLEAN     DEFAULT TRUE,
      expires_at      TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS qr_share_scans (
      id          SERIAL PRIMARY KEY,
      qr_id       INTEGER NOT NULL REFERENCES qr_share_codes(id) ON DELETE CASCADE,
      scanned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip          VARCHAR(64),
      user_agent  TEXT
    )
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_qr_share_owner ON qr_share_codes(created_by, created_at DESC)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_qr_share_cid   ON qr_share_codes(company_id, created_at DESC)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_qr_share_scans ON qr_share_scans(qr_id, scanned_at DESC)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS qr_share_scans CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS qr_share_codes CASCADE`);
}
