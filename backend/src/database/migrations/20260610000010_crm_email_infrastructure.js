export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_crm_email_infra_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column/.test(err.message || '')) throw err;
    }
  };

  // ── crm_email_accounts (new schema) ────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS crm_email_accounts (
      id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id              INTEGER REFERENCES companies(id),
      user_id                 INTEGER REFERENCES employees(id),
      provider                VARCHAR(50)  DEFAULT 'smtp',
      display_name            VARCHAR(255),
      email_address           VARCHAR(255),
      smtp_host               VARCHAR(255),
      smtp_port               INTEGER      DEFAULT 587,
      smtp_secure             BOOLEAN      DEFAULT true,
      smtp_username           VARCHAR(255),
      smtp_password_encrypted TEXT,
      imap_host               VARCHAR(255),
      imap_port               INTEGER      DEFAULT 993,
      imap_username           VARCHAR(255),
      access_token_encrypted  TEXT,
      refresh_token_encrypted TEXT,
      token_expiry            TIMESTAMPTZ,
      is_active               BOOLEAN      DEFAULT true,
      last_sync_at            TIMESTAMPTZ,
      sync_status             VARCHAR(30)  DEFAULT 'pending',
      sync_error              TEXT,
      created_at              TIMESTAMPTZ  DEFAULT NOW()
    )
  `);

  // If table already existed with old schema, add the new columns
  await safe(`ALTER TABLE crm_email_accounts ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id)`);
  await safe(`ALTER TABLE crm_email_accounts ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES employees(id)`);
  await safe(`ALTER TABLE crm_email_accounts ADD COLUMN IF NOT EXISTS display_name VARCHAR(255)`);
  await safe(`ALTER TABLE crm_email_accounts ADD COLUMN IF NOT EXISTS email_address VARCHAR(255)`);
  await safe(`ALTER TABLE crm_email_accounts ADD COLUMN IF NOT EXISTS smtp_username VARCHAR(255)`);
  await safe(`ALTER TABLE crm_email_accounts ADD COLUMN IF NOT EXISTS smtp_password_encrypted TEXT`);
  await safe(`ALTER TABLE crm_email_accounts ADD COLUMN IF NOT EXISTS imap_username VARCHAR(255)`);
  await safe(`ALTER TABLE crm_email_accounts ADD COLUMN IF NOT EXISTS sync_status VARCHAR(30) DEFAULT 'pending'`);
  await safe(`ALTER TABLE crm_email_accounts ADD COLUMN IF NOT EXISTS sync_error TEXT`);
  await safe(`ALTER TABLE crm_email_accounts ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMPTZ`);

  // ── crm_emails additions ───────────────────────────────────────────────────
  await safe(`ALTER TABLE crm_emails ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id)`);
  await safe(`ALTER TABLE crm_emails ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT false`);
  await safe(`ALTER TABLE crm_emails ADD COLUMN IF NOT EXISTS is_draft BOOLEAN DEFAULT false`);
  await safe(`ALTER TABLE crm_emails ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ`);

  // ── crm_email_sequence_steps ───────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS crm_email_sequence_steps (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      sequence_id INTEGER NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
      step_order  INTEGER NOT NULL,
      delay_days  INTEGER DEFAULT 1,
      subject     VARCHAR(500),
      body_html   TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Indexes ────────────────────────────────────────────────────────────────
  await safe(`CREATE INDEX IF NOT EXISTS idx_crm_email_accounts_company ON crm_email_accounts(company_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_crm_email_accounts_user ON crm_email_accounts(user_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_crm_emails_company ON crm_emails(company_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_crm_emails_account ON crm_emails(account_id)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS crm_email_sequence_steps`);
  await knex.raw(`DROP TABLE IF EXISTS crm_email_accounts CASCADE`);
}
