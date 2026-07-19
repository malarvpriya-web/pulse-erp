/**
 * Phase 46 Fix — Multi-signer support for native signature engine
 *
 * Adds:
 *  - signature_signers: per-signer records (sequential/parallel/witness)
 *  - OTP fields on signature_signers for email-based identity verification
 *  - signing_mode column on document_signings (single | sequential | parallel)
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS signature_signers (
      id             SERIAL PRIMARY KEY,
      signing_id     INTEGER NOT NULL REFERENCES document_signings(id) ON DELETE CASCADE,
      signer_name    VARCHAR(255) NOT NULL,
      signer_email   VARCHAR(255) NOT NULL,
      signing_order  INTEGER      NOT NULL DEFAULT 1,
      role           VARCHAR(30)  NOT NULL DEFAULT 'signer'
                       CHECK (role IN ('signer','witness','cc')),
      sign_token     VARCHAR(64)  UNIQUE,
      otp_code       VARCHAR(6),
      otp_expires_at TIMESTAMPTZ,
      otp_attempts   INTEGER      NOT NULL DEFAULT 0,
      status         VARCHAR(20)  NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','otp_sent','signed','declined')),
      signed_at      TIMESTAMPTZ,
      signer_ip      VARCHAR(100),
      signer_ua      TEXT,
      signature_type VARCHAR(20),
      signature_data TEXT,
      typed_name     VARCHAR(255),
      decline_reason TEXT,
      company_id     INTEGER,
      created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_sig_signers_signing_id ON signature_signers(signing_id);
    CREATE INDEX IF NOT EXISTS idx_sig_signers_token      ON signature_signers(sign_token);
    CREATE INDEX IF NOT EXISTS idx_sig_signers_email      ON signature_signers(signer_email);
  `);

  // Add signing_mode to document_signings
  let sp = 0;
  const tryAlter = async (sql) => {
    const name = `sp_sig_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      console.warn(`[multi-signer] Skipped — ${err.message.split('\n')[0]}`);
    }
  };

  await tryAlter(`ALTER TABLE document_signings ADD COLUMN IF NOT EXISTS signing_mode VARCHAR(20) DEFAULT 'single' CHECK (signing_mode IN ('single','sequential','parallel'))`);
  await tryAlter(`ALTER TABLE document_signings ADD COLUMN IF NOT EXISTS total_signers INTEGER DEFAULT 1`);
  await tryAlter(`ALTER TABLE document_signings ADD COLUMN IF NOT EXISTS signed_count  INTEGER DEFAULT 0`);
  await tryAlter(`ALTER TABLE document_signings ADD COLUMN IF NOT EXISTS document_hash VARCHAR(128)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS signature_signers CASCADE`);
  await knex.schema.table('document_signings', t => {
    t.dropColumn('signing_mode').catch(() => {});
    t.dropColumn('total_signers').catch(() => {});
    t.dropColumn('signed_count').catch(() => {});
    t.dropColumn('document_hash').catch(() => {});
  }).catch(() => {});
}
