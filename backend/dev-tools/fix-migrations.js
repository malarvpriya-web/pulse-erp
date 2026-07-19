/**
 * fix-migrations.js
 * Run this ONCE to fix two startup errors:
 *   1. "relation leave_types does not exist"
 *   2. "foreign key constraint journal_lines_entry_id_fkey cannot be implemented"
 *
 * Usage (from your backend folder):
 *   node fix-migrations.js
 */

import pool from './src/config/db.js';

async function fix() {
  console.log('🔧 Fixing missing tables and constraints...\n');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── 1. Create leave_types table ───────────────────────────────────────────
    console.log('  Creating leave_types table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS leave_types (
        id            SERIAL PRIMARY KEY,
        leave_name    VARCHAR(100) NOT NULL,
        code          VARCHAR(20)  UNIQUE,
        days_allowed  INTEGER      DEFAULT 0,
        carry_forward BOOLEAN      DEFAULT false,
        is_paid       BOOLEAN      DEFAULT true,
        applicable_to VARCHAR(50)  DEFAULT 'all',
        is_active     BOOLEAN      DEFAULT true,
        deleted_at    TIMESTAMPTZ,
        created_at    TIMESTAMPTZ  DEFAULT NOW(),
        updated_at    TIMESTAMPTZ  DEFAULT NOW()
      )
    `);

    // Seed default leave types if empty
    const { rows } = await client.query('SELECT COUNT(*) AS cnt FROM leave_types');
    if (parseInt(rows[0].cnt) === 0) {
      console.log('  Seeding default leave types...');
      await client.query(`
        INSERT INTO leave_types (leave_name, code, days_allowed, carry_forward, is_paid, applicable_to)
        VALUES
          ('Annual Leave',      'AL',  18, true,  true,  'all'),
          ('Sick Leave',        'SL',  12, false, true,  'all'),
          ('Casual Leave',      'CL',   6, false, true,  'all'),
          ('Maternity Leave',   'ML', 180, false, true,  'female'),
          ('Paternity Leave',   'PL',   5, false, true,  'male'),
          ('Compensatory Leave','CO',   0, false, true,  'all'),
          ('Loss of Pay',       'LOP',  0, false, false, 'all'),
          ('Optional Holiday',  'OH',   2, false, true,  'all')
        ON CONFLICT (code) DO NOTHING
      `);
    }

    // ── 2. Create journal_entries table FIRST (needed for FK) ────────────────
    console.log('  Ensuring journal_entries table exists...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS journal_entries (
        id             SERIAL PRIMARY KEY,
        entry_number   VARCHAR(50) UNIQUE,
        entry_date     DATE        NOT NULL DEFAULT CURRENT_DATE,
        description    TEXT,
        reference      VARCHAR(100),
        status         VARCHAR(20) DEFAULT 'draft',
        total_debit    NUMERIC(15,2) DEFAULT 0,
        total_credit   NUMERIC(15,2) DEFAULT 0,
        financial_year VARCHAR(10),
        created_by     INTEGER,
        posted_by      INTEGER,
        posted_at      TIMESTAMPTZ,
        created_at     TIMESTAMPTZ  DEFAULT NOW(),
        updated_at     TIMESTAMPTZ  DEFAULT NOW()
      )
    `);

    // ── 3. Create journal_lines table (with proper FK) ───────────────────────
    console.log('  Ensuring journal_lines table exists...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS journal_lines (
        id           SERIAL PRIMARY KEY,
        entry_id     INTEGER     REFERENCES journal_entries(id) ON DELETE CASCADE,
        account_id   INTEGER,
        account_code VARCHAR(20),
        account_name VARCHAR(200),
        debit        NUMERIC(15,2) DEFAULT 0,
        credit       NUMERIC(15,2) DEFAULT 0,
        description  TEXT,
        cost_centre  VARCHAR(100),
        created_at   TIMESTAMPTZ  DEFAULT NOW()
      )
    `);

    // ── 4. Create leave_balances table (used by leaves module) ──────────────
    console.log('  Ensuring leave_balances table exists...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS leave_balances (
        id              SERIAL PRIMARY KEY,
        employee_id     INTEGER,
        employee_email  VARCHAR(255),
        leave_type_id   INTEGER REFERENCES leave_types(id),
        leave_year      INTEGER DEFAULT EXTRACT(YEAR FROM NOW()),
        total_days      NUMERIC(5,1) DEFAULT 0,
        used_days       NUMERIC(5,1) DEFAULT 0,
        pending_days    NUMERIC(5,1) DEFAULT 0,
        available_days  NUMERIC(5,1) DEFAULT 0,
        carry_forward   NUMERIC(5,1) DEFAULT 0,
        created_at      TIMESTAMPTZ  DEFAULT NOW(),
        updated_at      TIMESTAMPTZ  DEFAULT NOW(),
        UNIQUE(employee_id, leave_type_id, leave_year)
      )
    `);

    // ── 5. Create leave_applications table if missing ────────────────────────
    console.log('  Ensuring leave_applications table exists...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS leave_applications (
        id                 SERIAL PRIMARY KEY,
        application_number VARCHAR(50) UNIQUE,
        employee_id        INTEGER,
        employee_email     VARCHAR(255),
        employee_name      VARCHAR(200),
        leave_type_id      INTEGER REFERENCES leave_types(id),
        leave_type_name    VARCHAR(100),
        start_date         DATE NOT NULL,
        end_date           DATE NOT NULL,
        total_days         NUMERIC(5,1),
        reason             TEXT,
        status             VARCHAR(20) DEFAULT 'pending',
        approver_id        INTEGER,
        approver_email     VARCHAR(255),
        approved_at        TIMESTAMPTZ,
        rejection_reason   TEXT,
        created_at         TIMESTAMPTZ DEFAULT NOW(),
        updated_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 6. Add leave_type_id to leaves table if it exists ───────────────────
    const { rows: leavesCheck } = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'leaves'
      ) AS exists
    `);
    if (leavesCheck[0].exists) {
      await client.query(`
        ALTER TABLE leaves ADD COLUMN IF NOT EXISTS leave_type_id INTEGER
      `).catch(() => {});
      await client.query(`
        ALTER TABLE leaves ADD COLUMN IF NOT EXISTS leave_type VARCHAR(50) DEFAULT 'Annual'
      `).catch(() => {});
    }

    await client.query('COMMIT');
    console.log('\n✅ All fixes applied successfully!');
    console.log('\nNow restart your backend: node server.js');
    console.log('The errors should be gone.\n');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Fix failed:', err.message);
    console.error(err);
  } finally {
    client.release();
    await pool.end();
  }
}

fix();
