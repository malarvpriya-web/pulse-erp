export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS payment_gateway_orders (
      id                   SERIAL PRIMARY KEY,
      invoice_id           UUID UNIQUE,
      company_id           INTEGER,
      razorpay_order_id    VARCHAR(100),
      razorpay_payment_id  VARCHAR(100),
      payment_link_id      VARCHAR(100),
      payment_link_url     TEXT,
      payment_link_status  VARCHAR(30) DEFAULT 'not_sent',
      amount               NUMERIC(15,2),
      currency             VARCHAR(10) DEFAULT 'INR',
      status               VARCHAR(30) DEFAULT 'created',
      link_sent            BOOLEAN DEFAULT FALSE,
      link_sent_at         TIMESTAMPTZ,
      description          TEXT,
      gateway_response     JSONB,
      paid_at              TIMESTAMPTZ,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at           TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pgo_invoice   ON payment_gateway_orders(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_pgo_company   ON payment_gateway_orders(company_id);
    CREATE INDEX IF NOT EXISTS idx_pgo_order_id  ON payment_gateway_orders(razorpay_order_id);
    CREATE INDEX IF NOT EXISTS idx_pgo_link_id   ON payment_gateway_orders(payment_link_id);

    CREATE TABLE IF NOT EXISTS payment_transactions (
      id                   SERIAL PRIMARY KEY,
      invoice_id           UUID,
      company_id           INTEGER,
      pgo_id               INTEGER REFERENCES payment_gateway_orders(id),
      amount               NUMERIC(15,2),
      payment_mode         VARCHAR(50),
      transaction_id       VARCHAR(100),
      razorpay_payment_id  VARCHAR(100),
      paid_at              TIMESTAMPTZ,
      status               VARCHAR(30) DEFAULT 'captured',
      notes                TEXT,
      created_at           TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pt_invoice    ON payment_transactions(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_pt_company    ON payment_transactions(company_id);
    CREATE INDEX IF NOT EXISTS idx_pt_paid_at    ON payment_transactions(paid_at);
  `);
}

export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS payment_transactions;
    DROP TABLE IF EXISTS payment_gateway_orders;
  `);
}
