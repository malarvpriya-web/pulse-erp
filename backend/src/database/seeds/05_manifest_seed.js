/**
 * 05_manifest_seed.js — Step 5 Essential Reference Data
 *
 * Idempotent seed for Manifest Technologies.
 * Run: node src/database/seeds/05_manifest_seed.js
 *
 * Seeds data that migrations only insert for companies that existed
 * at migration time.  If the company was created via the Setup Wizard
 * after migrations ran these would all be empty.
 *
 * Seeds handled here:
 *   1. Chart of Accounts (company-scoped, in addition to global nulls)
 *   2. CRM Pipeline Stages
 *   3. Main Warehouse (Bangalore)
 *   4. Standard Price List
 *   5. Standard Commission Plan
 *   6. CRM Win/Loss Reasons
 *   7. Settings rows: procurement_settings, marketing_settings, crm_settings
 *   8. Onboarding checklist template items (company-scoped)
 *
 * ⚠ DEV/STAGING ONLY — never run on production without review.
 */

import pool from '../../config/db.js';

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('\n🌱 Step 5 seed — Manifest Technologies\n');

    // ── Ensure companies table exists (safety guard) ─────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id         SERIAL PRIMARY KEY,
        name       VARCHAR(255) NOT NULL,
        code       VARCHAR(50)  UNIQUE NOT NULL,
        gstin      VARCHAR(20),
        address    TEXT,
        city       VARCHAR(100),
        state      VARCHAR(100),
        country    VARCHAR(100) DEFAULT 'India',
        is_active  BOOLEAN      DEFAULT TRUE,
        created_at TIMESTAMPTZ  DEFAULT NOW(),
        updated_at TIMESTAMPTZ  DEFAULT NOW()
      )
    `);

    // ── Upsert company record ─────────────────────────────────────────────────
    await client.query(`
      INSERT INTO companies
        (name, code, gstin, address, city, state, country, is_active)
      VALUES
        ('Manifest Technologies', 'MANIFEST', '29AABCM1234A1Z5',
         '123 MG Road, Bangalore, Karnataka 560001',
         'Bangalore', 'Karnataka', 'India', true)
      ON CONFLICT (code) DO UPDATE SET
        name       = EXCLUDED.name,
        gstin      = EXCLUDED.gstin,
        address    = EXCLUDED.address,
        city       = EXCLUDED.city,
        state      = EXCLUDED.state,
        updated_at = NOW()
    `);

    const { rows: [co] } = await client.query(
      `SELECT id FROM companies WHERE code = 'MANIFEST' LIMIT 1`
    );
    const cid = co.id;
    console.log(`✅ companies: Manifest Technologies (id=${cid})\n`);

    // ════════════════════════════════════════════════════════════════════════
    // 1. CHART OF ACCOUNTS
    //    The `code` column is globally unique across all companies.
    //    Migration 20260603000001 already inserted 60+ accounts with
    //    company_id = NULL (visible to every tenant).  Finance queries use
    //    WHERE company_id = $cid OR company_id IS NULL.
    //    No company-scoped duplicates needed — just confirm counts.
    // ════════════════════════════════════════════════════════════════════════
    const { rows: [coaGlobal] } = await client.query(
      `SELECT COUNT(*) AS n FROM chart_of_accounts WHERE company_id IS NULL`
    );
    if (parseInt(coaGlobal.n) === 0) {
      // No global accounts at all — insert the standard set without company_id
      await client.query(`
        INSERT INTO chart_of_accounts (code, name, account_type, sub_type)
        VALUES
          ('1001','Cash in Hand',                   'Asset',     'cash'),
          ('1002','Bank — Current Account',          'Asset',     'bank'),
          ('1003','Bank — Savings Account',          'Asset',     'bank'),
          ('1010','Accounts Receivable',             'Asset',     'receivable'),
          ('1020','Input CGST Receivable',           'Asset',     'gst_itc'),
          ('1021','Input SGST Receivable',           'Asset',     'gst_itc'),
          ('1022','Input IGST Receivable',           'Asset',     'gst_itc'),
          ('1030','Raw Material Inventory',          'Asset',     'inventory'),
          ('1032','Finished Goods Inventory',        'Asset',     'inventory'),
          ('1041','Advance Tax Paid',                'Asset',     'tax'),
          ('1100','Fixed Assets — Plant & Machinery','Asset',     'fixed_asset'),
          ('1102','Fixed Assets — Computers & IT',   'Asset',     'fixed_asset'),
          ('1110','Accumulated Depreciation — P&M',  'Asset',     'contra_asset'),
          ('2001','Accounts Payable',                'Liability', 'payable'),
          ('2010','CGST Payable',                    'Liability', 'gst_payable'),
          ('2011','SGST Payable',                    'Liability', 'gst_payable'),
          ('2012','IGST Payable',                    'Liability', 'gst_payable'),
          ('2030','PF Payable',                      'Liability', 'statutory'),
          ('2031','ESI Payable',                     'Liability', 'statutory'),
          ('2040','Salary & Wages Payable',          'Liability', 'accrual'),
          ('3001','Share Capital — Equity',          'Equity',    'capital'),
          ('3002','Retained Earnings',               'Equity',    'retained'),
          ('3004','Current Year Profit / (Loss)',    'Equity',    'retained'),
          ('4001','Sales — Finished Goods',          'Revenue',   'sales'),
          ('4003','Service Revenue',                 'Revenue',   'service'),
          ('4005','Other Income',                    'Revenue',   'other'),
          ('5010','Salaries & Wages',                'Expense',   'staff'),
          ('5011','Employer PF Contribution',        'Expense',   'staff'),
          ('5020','Rent',                            'Expense',   'operating'),
          ('5029','Marketing & Advertising',         'Expense',   'operating'),
          ('5030','Bank Charges',                    'Expense',   'finance'),
          ('5040','Depreciation',                    'Expense',   'depreciation')
        ON CONFLICT (code) DO NOTHING
      `);
      console.log('✅ chart_of_accounts: 32 global accounts seeded');
    } else {
      console.log(`⏭  chart_of_accounts: ${coaGlobal.n} global accounts already exist (visible to all tenants)`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // 2. CRM PIPELINE STAGES
    // ════════════════════════════════════════════════════════════════════════
    await client.query(`
      INSERT INTO crm_pipeline_stages
        (company_id, name, stage_key, sort_order, color, probability, is_won, is_lost)
      VALUES
        ($1, 'Prospecting',   'prospecting',   1, '#5B6CF6', 10,  false, false),
        ($1, 'Qualification', 'qualification', 2, '#2563EB', 25,  false, false),
        ($1, 'Proposal',      'proposal',      3, '#D97706', 50,  false, false),
        ($1, 'Negotiation',   'negotiation',   4, '#DC2626', 75,  false, false),
        ($1, 'Won',           'won',           5, '#059669', 100, true,  false),
        ($1, 'Lost',          'lost',          6, '#6B7280', 0,   false, true)
      ON CONFLICT (company_id, stage_key) DO NOTHING
    `, [cid]);
    console.log('✅ crm_pipeline_stages: 6 stages ensured');

    // ════════════════════════════════════════════════════════════════════════
    // 3. MAIN WAREHOUSE (Bangalore)
    //    Warehouse table has two possible schemas across deployments:
    //      - older: (name, address, type)
    //      - newer: (warehouse_name, warehouse_code, location, status)
    //    We detect which schema is live and insert accordingly.
    // ════════════════════════════════════════════════════════════════════════
    const { rows: [whRow] } = await client.query(`SELECT COUNT(*) AS n FROM warehouses`);
    if (parseInt(whRow.n) === 0) {
      const { rows: cols } = await client.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'warehouses'
          AND column_name IN ('name','warehouse_name','warehouse_code','location','address','type','status')
      `);
      const colSet = new Set(cols.map(c => c.column_name));

      if (colSet.has('warehouse_name')) {
        await client.query(`
          INSERT INTO warehouses (warehouse_name, warehouse_code, location, status)
          VALUES ('Main Warehouse', 'WH-001', 'Bangalore, Karnataka', 'active')
        `);
      } else {
        await client.query(`
          INSERT INTO warehouses (name, address, type)
          VALUES ('Main Warehouse — Bangalore', '123 MG Road, Bangalore, Karnataka 560001', 'main')
        `);
      }
      console.log('✅ warehouses: Main Warehouse seeded');
    } else {
      console.log(`⏭  warehouses: ${whRow.n} warehouse(s) already exist`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // 4. STANDARD PRICE LIST
    // ════════════════════════════════════════════════════════════════════════
    await client.query(`
      INSERT INTO price_lists (company_id, name, currency, applicable_to, is_default, is_active)
      SELECT $1, 'Standard Price List', 'INR', 'all', true, true
      WHERE NOT EXISTS (
        SELECT 1 FROM price_lists WHERE company_id = $1 AND is_default = true
      )
    `, [cid]);
    console.log('✅ price_lists: Standard Price List ensured');

    // ════════════════════════════════════════════════════════════════════════
    // 5. STANDARD COMMISSION PLAN (5%)
    //    Actual columns: plan_type, base_rate_pct (not type/base_rate/frequency)
    // ════════════════════════════════════════════════════════════════════════
    const { rows: [cpCount] } = await client.query(
      `SELECT COUNT(*) AS n FROM commission_plans WHERE company_id = $1`, [cid]
    );
    if (parseInt(cpCount.n) === 0) {
      await client.query(`
        INSERT INTO commission_plans
          (company_id, name, plan_type, base_rate_pct, applies_to, is_active)
        VALUES ($1, 'Standard Commission Plan', 'percentage', 5.00, 'all_products', true)
      `, [cid]);
      console.log('✅ commission_plans: Standard 5% plan seeded');
    } else {
      console.log(`⏭  commission_plans: ${cpCount.n} plan(s) already exist`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // 6. CRM WIN/LOSS REASONS
    // ════════════════════════════════════════════════════════════════════════
    await client.query(`
      INSERT INTO crm_win_loss_reasons (company_id, type, reason)
      VALUES
        ($1,'win',  'Best Price'),
        ($1,'win',  'Feature Set'),
        ($1,'win',  'Strong Relationship'),
        ($1,'win',  'Better Support'),
        ($1,'win',  'Brand Trust'),
        ($1,'loss', 'Budget Constraints'),
        ($1,'loss', 'Chose Competitor'),
        ($1,'loss', 'No Decision'),
        ($1,'loss', 'Poor Timing'),
        ($1,'loss', 'Feature Gap')
      ON CONFLICT (company_id, type, reason) DO NOTHING
    `, [cid]);
    console.log('✅ crm_win_loss_reasons: 10 reasons ensured');

    // ════════════════════════════════════════════════════════════════════════
    // 7. SETTINGS DEFAULT ROWS
    // ════════════════════════════════════════════════════════════════════════

    // crm_settings — company_id INTEGER UNIQUE (from 20260609000020)
    await client.query(`
      INSERT INTO crm_settings (company_id)
      VALUES ($1)
      ON CONFLICT (company_id) DO NOTHING
    `, [cid]);
    console.log('✅ crm_settings: default row ensured');

    // procurement_settings — company_id INTEGER UNIQUE
    await client.query(`
      INSERT INTO procurement_settings (company_id)
      VALUES ($1)
      ON CONFLICT (company_id) DO NOTHING
    `, [cid]);
    console.log('✅ procurement_settings: default row ensured');

    // marketing_settings — company_id INTEGER UNIQUE
    await client.query(`
      INSERT INTO marketing_settings (company_id)
      VALUES ($1)
      ON CONFLICT (company_id) DO NOTHING
    `, [cid]);
    console.log('✅ marketing_settings: default row ensured');

    // sales_settings — created inline in sales.routes.js with UUID company_id.
    // Type mismatch with companies.id (INTEGER), so skipped here.
    // The GET /sales/settings endpoint returns sensible defaults when no row exists.
    console.log('⏭  sales_settings: managed by routes (returns defaults if absent)');

    // ════════════════════════════════════════════════════════════════════════
    // 8. ONBOARDING CHECKLIST TEMPLATE (company-scoped)
    //    Global items are seeded by 20260609000004_onboarding_checklist.js.
    //    Add company-scoped copy only if none exist yet.
    // ════════════════════════════════════════════════════════════════════════
    const { rows: [obCount] } = await client.query(
      `SELECT COUNT(*) AS n FROM hr_onboarding_checklist_templates WHERE company_id = $1`, [cid]
    );
    if (parseInt(obCount.n) === 0) {
      await client.query(`
        INSERT INTO hr_onboarding_checklist_templates
          (company_id, category, item_label, default_assignee, default_offset_days, sort_order)
        VALUES
          ($1,'HR',           'Send Welcome Email with Employee ID',      'HR',      1,  1),
          ($1,'HR',           'Collect signed offer letter',              'HR',      1,  2),
          ($1,'HR',           'Collect Aadhar, PAN, Passport',            'HR',      1,  3),
          ($1,'HR',           'Collect educational certificates',         'HR',      3,  4),
          ($1,'HR',           'Collect relieving letter',                 'HR',      3,  5),
          ($1,'HR',           'Create employee record in HRMS',           'HR',      1,  6),
          ($1,'HR',           'Enroll in payroll',                        'HR',      3,  7),
          ($1,'HR',           'Add to org chart',                         'HR',      1,  8),
          ($1,'HR',           'Assign leave policy',                      'HR',      1,  9),
          ($1,'IT',           'Create company email account',             'IT',      1, 10),
          ($1,'IT',           'Set up laptop / workstation',              'IT',      1, 11),
          ($1,'IT',           'Grant system access (ERP, Slack)',          'IT',      1, 12),
          ($1,'IT',           'Set up biometric device',                  'IT',      2, 13),
          ($1,'Admin',        'Issue ID card / access card',              'Admin',   2, 14),
          ($1,'Admin',        'Assign desk / seating',                    'Admin',   1, 15),
          ($1,'Admin',        'Add to office WhatsApp / Slack',            'Admin',   1, 16),
          ($1,'Manager',      'Introduce to team',                        'Manager', 1, 17),
          ($1,'Manager',      'Share team goals and KPIs',                'Manager', 3, 18),
          ($1,'Manager',      'Schedule 1-on-1 for first week',           'Manager', 1, 19),
          ($1,'Manager',      'Assign buddy / mentor',                    'Manager', 1, 20),
          ($1,'Finance',      'Collect bank account details',             'HR',      3, 21),
          ($1,'Finance',      'Collect PF nomination form',               'HR',      7, 22),
          ($1,'Finance',      'Collect Form 12BB (tax declaration)',       'HR',      7, 23)
        ON CONFLICT (company_id, category, item_label) DO NOTHING
      `, [cid]);
      console.log('✅ hr_onboarding_checklist_templates: 23 tasks seeded');
    } else {
      console.log(`⏭  hr_onboarding_checklist_templates: ${obCount.n} company items already exist`);
    }

    await client.query('COMMIT');
    console.log('\n🎉 Step 5 seed completed successfully!\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Seed failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
