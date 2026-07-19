export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS gst_filings (
      id           SERIAL PRIMARY KEY,
      company_id   INTEGER NOT NULL,
      period       CHAR(6) NOT NULL,
      return_type  VARCHAR(10) NOT NULL CHECK (return_type IN ('gstr1', 'gstr3b')),
      status       VARCHAR(20) NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'submitted', 'filed', 'nil_filed')),
      reference_no VARCHAR(100),
      filed_at     TIMESTAMPTZ,
      notes        TEXT,
      created_by   INTEGER,
      updated_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(company_id, period, return_type)
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_gst_filings_co_period ON gst_filings(company_id, period)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS gst_filings`);
}
