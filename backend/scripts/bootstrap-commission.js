// One-time script to ensure commission tables have company_id and all required columns.
// Run: node scripts/bootstrap-commission.js
import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : new Pool({
      user:     process.env.DB_USER     || 'postgres',
      host:     process.env.DB_HOST     || 'localhost',
      database: process.env.DB_NAME     || 'Pulse',
      password: process.env.DB_PASSWORD,
      port:     parseInt(process.env.DB_PORT || '5432'),
    });

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const safe = async (sql) => {
      const sp = `sp_bc_${Math.random().toString(36).slice(2, 7)}`;
      await client.query(`SAVEPOINT ${sp}`);
      try {
        await client.query(sql);
        await client.query(`RELEASE SAVEPOINT ${sp}`);
      } catch (err) {
        await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        if (!/already exists|does not exist|duplicate/.test(err.message || '')) {
          console.warn('  ⚠', err.message.split('\n')[0]);
        }
      }
    };

    // ── Ensure all three commission tables exist with full schema ─────────────

    console.log('Ensuring commission_plans exists…');
    await safe(`
      CREATE TABLE IF NOT EXISTS commission_plans (
        id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id           INTEGER NOT NULL DEFAULT 0,
        name                 VARCHAR(255) NOT NULL DEFAULT '',
        rep_id               INTEGER,
        rep_name             VARCHAR(255),
        plan_type            VARCHAR(30)  DEFAULT 'percentage',
        base_rate_pct        NUMERIC(10,2) DEFAULT 0,
        tiered_slabs         JSONB DEFAULT '[]',
        applies_to           VARCHAR(50)  DEFAULT 'all_products',
        product_ids          JSONB DEFAULT '[]',
        effective_from       DATE,
        effective_to         DATE,
        clawback_period_days INTEGER DEFAULT 30,
        is_active            BOOLEAN DEFAULT true,
        created_at           TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Add company_id if missing (table may have existed without it)
    await safe(`ALTER TABLE commission_plans ADD COLUMN IF NOT EXISTS company_id INTEGER NOT NULL DEFAULT 0`);
    await safe(`ALTER TABLE commission_plans ADD COLUMN IF NOT EXISTS rep_id INTEGER`);
    await safe(`ALTER TABLE commission_plans ADD COLUMN IF NOT EXISTS rep_name VARCHAR(255)`);
    await safe(`ALTER TABLE commission_plans ADD COLUMN IF NOT EXISTS plan_type VARCHAR(30) DEFAULT 'percentage'`);
    await safe(`ALTER TABLE commission_plans ADD COLUMN IF NOT EXISTS base_rate_pct NUMERIC(10,2) DEFAULT 0`);
    await safe(`ALTER TABLE commission_plans ADD COLUMN IF NOT EXISTS tiered_slabs JSONB DEFAULT '[]'`);
    await safe(`ALTER TABLE commission_plans ADD COLUMN IF NOT EXISTS applies_to VARCHAR(50) DEFAULT 'all_products'`);
    await safe(`ALTER TABLE commission_plans ADD COLUMN IF NOT EXISTS product_ids JSONB DEFAULT '[]'`);
    await safe(`ALTER TABLE commission_plans ADD COLUMN IF NOT EXISTS effective_from DATE`);
    await safe(`ALTER TABLE commission_plans ADD COLUMN IF NOT EXISTS effective_to DATE`);
    await safe(`ALTER TABLE commission_plans ADD COLUMN IF NOT EXISTS clawback_period_days INTEGER DEFAULT 30`);
    await safe(`ALTER TABLE commission_plans ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true`);
    await safe(`ALTER TABLE commission_plans ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);
    await safe(`CREATE INDEX IF NOT EXISTS idx_commission_plans_company ON commission_plans(company_id)`);
    await safe(`CREATE INDEX IF NOT EXISTS idx_commission_plans_rep    ON commission_plans(company_id, rep_id)`);

    console.log('Ensuring commission_entries exists…');
    await safe(`
      CREATE TABLE IF NOT EXISTS commission_entries (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id        INTEGER NOT NULL DEFAULT 0,
        plan_id           UUID,
        rep_id            INTEGER,
        rep_name          VARCHAR(255),
        order_id          INTEGER,
        order_ref         VARCHAR(100),
        customer_name     VARCHAR(255),
        sale_amount       NUMERIC(14,2) DEFAULT 0,
        commission_rate   NUMERIC(5,2)  DEFAULT 0,
        commission_amount NUMERIC(14,2) DEFAULT 0,
        earned_date       TIMESTAMPTZ   DEFAULT NOW(),
        status            VARCHAR(20)   DEFAULT 'pending',
        clawback_reason   TEXT,
        created_at        TIMESTAMPTZ   DEFAULT NOW()
      )
    `);
    await safe(`ALTER TABLE commission_entries ADD COLUMN IF NOT EXISTS company_id INTEGER NOT NULL DEFAULT 0`);
    await safe(`ALTER TABLE commission_entries ADD COLUMN IF NOT EXISTS plan_id UUID`);
    await safe(`ALTER TABLE commission_entries ADD COLUMN IF NOT EXISTS rep_id INTEGER`);
    await safe(`ALTER TABLE commission_entries ADD COLUMN IF NOT EXISTS rep_name VARCHAR(255)`);
    await safe(`ALTER TABLE commission_entries ADD COLUMN IF NOT EXISTS order_id INTEGER`);
    await safe(`ALTER TABLE commission_entries ADD COLUMN IF NOT EXISTS order_ref VARCHAR(100)`);
    await safe(`ALTER TABLE commission_entries ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255)`);
    await safe(`ALTER TABLE commission_entries ADD COLUMN IF NOT EXISTS sale_amount NUMERIC(14,2) DEFAULT 0`);
    await safe(`ALTER TABLE commission_entries ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,2) DEFAULT 0`);
    await safe(`ALTER TABLE commission_entries ADD COLUMN IF NOT EXISTS commission_amount NUMERIC(14,2) DEFAULT 0`);
    await safe(`ALTER TABLE commission_entries ADD COLUMN IF NOT EXISTS earned_date TIMESTAMPTZ DEFAULT NOW()`);
    await safe(`ALTER TABLE commission_entries ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending'`);
    await safe(`ALTER TABLE commission_entries ADD COLUMN IF NOT EXISTS clawback_reason TEXT`);
    await safe(`ALTER TABLE commission_entries ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);
    await safe(`CREATE INDEX IF NOT EXISTS idx_commission_entries_company ON commission_entries(company_id)`);
    await safe(`CREATE INDEX IF NOT EXISTS idx_commission_entries_rep    ON commission_entries(company_id, rep_id)`);
    await safe(`CREATE INDEX IF NOT EXISTS idx_commission_entries_status ON commission_entries(company_id, status)`);
    await safe(`CREATE INDEX IF NOT EXISTS idx_commission_entries_date   ON commission_entries(company_id, earned_date)`);

    console.log('Ensuring commission_payouts exists…');
    await safe(`
      CREATE TABLE IF NOT EXISTS commission_payouts (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id       INTEGER NOT NULL DEFAULT 0,
        rep_id           INTEGER,
        rep_name         VARCHAR(255),
        period_from      DATE,
        period_to        DATE,
        total_commission NUMERIC(14,2) DEFAULT 0,
        deductions       NUMERIC(14,2) DEFAULT 0,
        net_payout       NUMERIC(14,2) DEFAULT 0,
        status           VARCHAR(20)   DEFAULT 'draft',
        payment_date     DATE,
        remarks          TEXT,
        created_at       TIMESTAMPTZ   DEFAULT NOW()
      )
    `);
    await safe(`ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS company_id INTEGER NOT NULL DEFAULT 0`);
    await safe(`ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS rep_id INTEGER`);
    await safe(`ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS rep_name VARCHAR(255)`);
    await safe(`ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS period_from DATE`);
    await safe(`ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS period_to DATE`);
    await safe(`ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS total_commission NUMERIC(14,2) DEFAULT 0`);
    await safe(`ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS deductions NUMERIC(14,2) DEFAULT 0`);
    await safe(`ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS net_payout NUMERIC(14,2) DEFAULT 0`);
    await safe(`ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'draft'`);
    await safe(`ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS payment_date DATE`);
    await safe(`ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS remarks TEXT`);
    await safe(`ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);
    await safe(`CREATE INDEX IF NOT EXISTS idx_commission_payouts_company ON commission_payouts(company_id)`);

    // ── Seed default plan for each company ────────────────────────────────────
    console.log('Seeding default plan per company…');
    await safe(`
      INSERT INTO commission_plans (company_id, name, plan_type, base_rate_pct, applies_to, is_active)
      SELECT c.id, 'Standard Commission Plan', 'percentage', 5.00, 'all_products', true
      FROM companies c
      WHERE NOT EXISTS (
        SELECT 1 FROM commission_plans cp WHERE cp.company_id = c.id
      )
    `);

    // ── Record in schema_migrations ───────────────────────────────────────────
    console.log('Recording migration…');
    await safe(`
      INSERT INTO schema_migrations (name, checksum, applied_at)
      VALUES ('20260609000030_commission_schema.js', 'bootstrap', NOW())
      ON CONFLICT (name) DO NOTHING
    `);

    await client.query('COMMIT');
    console.log('✅  Commission tables ready.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌  Bootstrap failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
