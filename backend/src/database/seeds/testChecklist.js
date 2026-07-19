/**
 * testChecklist.js — Post-Seed Verification Script
 * Run: node src/database/seeds/testChecklist.js
 *
 * Checks every table for record counts and generates SEED_REPORT.md
 * in the Pulse project root.
 */

import pool from '../../../config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Path to project root (5 levels up from backend/src/database/seeds/)
const projectRoot = path.resolve(__dirname, '../../../../../');

// ─── Tables to verify ───────────────────────────────────────────────────────

const TABLE_CHECKS = [
  // Core
  { table: 'users',                    minExpected: 8,   module: 'Auth/Users' },
  { table: 'employees',                minExpected: 50,  module: 'Employees' },
  { table: 'attendance',               minExpected: 800, module: 'Attendance' },
  { table: 'leaves',                   minExpected: 15,  module: 'Leaves' },
  { table: 'leave_balances',           minExpected: 50,  module: 'Leaves' },
  { table: 'holidays',                 minExpected: 10,  module: 'Holidays' },
  // Finance
  { table: 'chart_of_accounts',        minExpected: 40,  module: 'Finance' },
  { table: 'parties',                  minExpected: 18,  module: 'Finance' },
  { table: 'invoices',                 minExpected: 24,  module: 'Finance - Invoices' },
  { table: 'invoice_items',            minExpected: 0,   module: 'Finance - Invoices' },
  { table: 'bills',                    minExpected: 12,  module: 'Finance - Bills' },
  { table: 'bill_items',               minExpected: 0,   module: 'Finance - Bills' },
  { table: 'payments',                 minExpected: 0,   module: 'Finance - Payments' },
  { table: 'receipts',                 minExpected: 0,   module: 'Finance - Receipts' },
  { table: 'journal_entries',          minExpected: 20,  module: 'Finance - Journal' },
  { table: 'journal_lines',            minExpected: 40,  module: 'Finance - Journal' },
  { table: 'accounting_periods',       minExpected: 0,   module: 'Finance' },
  { table: 'bank_accounts',            minExpected: 0,   module: 'Finance' },
  { table: 'payment_batches',          minExpected: 0,   module: 'Finance' },
  { table: 'payment_batch_items',      minExpected: 0,   module: 'Finance' },
  // Payroll
  { table: 'payroll_runs',             minExpected: 2,   module: 'Payroll' },
  { table: 'payslips',                 minExpected: 100, module: 'Payroll' },
  { table: 'salary_structures',        minExpected: 0,   module: 'Payroll' },
  { table: 'employee_salary_assignments', minExpected: 0, module: 'Payroll' },
  { table: 'loan_advances',            minExpected: 0,   module: 'Payroll' },
  // Projects
  { table: 'projects',                 minExpected: 8,   module: 'Projects' },
  { table: 'tasks',                    minExpected: 30,  module: 'Projects' },
  { table: 'task_comments',            minExpected: 0,   module: 'Projects' },
  { table: 'project_costs',            minExpected: 0,   module: 'Projects' },
  { table: 'project_resources',        minExpected: 0,   module: 'Projects' },
  { table: 'project_milestones',       minExpected: 0,   module: 'Projects' },
  // Timesheets
  { table: 'timesheets',               minExpected: 80,  module: 'Timesheets' },
  { table: 'timesheet_entries',        minExpected: 400, module: 'Timesheets' },
  // CRM
  { table: 'accounts',                 minExpected: 8,   module: 'CRM' },
  { table: 'leads',                    minExpected: 12,  module: 'CRM' },
  { table: 'contacts',                 minExpected: 0,   module: 'CRM' },
  { table: 'opportunities',            minExpected: 6,   module: 'CRM' },
  { table: 'crm_activities',           minExpected: 0,   module: 'CRM' },
  { table: 'crm_emails',               minExpected: 0,   module: 'CRM' },
  { table: 'crm_email_accounts',       minExpected: 0,   module: 'CRM' },
  { table: 'crm_email_templates',      minExpected: 0,   module: 'CRM' },
  { table: 'crm_email_sequences',      minExpected: 0,   module: 'CRM' },
  // Sales
  { table: 'quotations',               minExpected: 0,   module: 'Sales' },
  { table: 'quotation_items',          minExpected: 0,   module: 'Sales' },
  { table: 'sales_orders',             minExpected: 0,   module: 'Sales' },
  { table: 'order_items',              minExpected: 0,   module: 'Sales' },
  { table: 'sales_targets',            minExpected: 0,   module: 'Sales' },
  { table: 'sales_forecasts',          minExpected: 0,   module: 'Sales' },
  { table: 'competitors',              minExpected: 0,   module: 'Sales' },
  { table: 'territories',              minExpected: 0,   module: 'Sales' },
  { table: 'sales_partners',           minExpected: 0,   module: 'Sales' },
  { table: 'sales_playbooks',          minExpected: 0,   module: 'Sales' },
  { table: 'sales_documents',          minExpected: 0,   module: 'Sales' },
  { table: 'subscriptions',            minExpected: 0,   module: 'Sales' },
  { table: 'price_lists',              minExpected: 0,   module: 'Sales' },
  { table: 'price_list_items',         minExpected: 0,   module: 'Sales' },
  { table: 'discount_rules',           minExpected: 0,   module: 'Sales' },
  { table: 'commission_plans',         minExpected: 0,   module: 'Sales' },
  { table: 'commissions',              minExpected: 0,   module: 'Sales' },
  { table: 'commission_entries',       minExpected: 0,   module: 'Sales' },
  // Procurement
  { table: 'purchase_requests',        minExpected: 8,   module: 'Procurement' },
  { table: 'purchase_request_items',   minExpected: 0,   module: 'Procurement' },
  { table: 'purchase_orders',          minExpected: 5,   module: 'Procurement' },
  { table: 'po_items',                 minExpected: 0,   module: 'Procurement' },
  { table: 'goods_receipts',           minExpected: 3,   module: 'Procurement' },
  { table: 'grn_items',                minExpected: 0,   module: 'Procurement' },
  { table: 'vendors',                  minExpected: 0,   module: 'Procurement' },
  { table: 'vendor_documents',         minExpected: 0,   module: 'Procurement' },
  { table: 'vendor_scorecards',        minExpected: 0,   module: 'Procurement' },
  { table: 'rfq_headers',              minExpected: 0,   module: 'Procurement' },
  { table: 'rfq_items',                minExpected: 0,   module: 'Procurement' },
  { table: 'rfq_vendors',              minExpected: 0,   module: 'Procurement' },
  { table: 'vendor_quotes',            minExpected: 0,   module: 'Procurement' },
  { table: 'three_way_match',          minExpected: 0,   module: 'Procurement' },
  // Inventory
  { table: 'inventory_items',          minExpected: 20,  module: 'Inventory' },
  { table: 'stock_ledger',             minExpected: 0,   module: 'Inventory' },
  { table: 'warehouses',               minExpected: 0,   module: 'Inventory' },
  { table: 'warehouse_zones',          minExpected: 0,   module: 'Inventory' },
  { table: 'bin_locations',            minExpected: 0,   module: 'Inventory' },
  { table: 'stock_transfers',          minExpected: 0,   module: 'Inventory' },
  { table: 'stock_adjustments',        minExpected: 0,   module: 'Inventory' },
  { table: 'reorder_rules',            minExpected: 0,   module: 'Inventory' },
  { table: 'landed_costs',             minExpected: 0,   module: 'Inventory' },
  { table: 'abc_analysis',             minExpected: 0,   module: 'Inventory' },
  // HR Extras
  { table: 'announcements',            minExpected: 5,   module: 'HR - Announcements' },
  { table: 'probation_records',        minExpected: 0,   module: 'HR' },
  { table: 'offboarding',              minExpected: 0,   module: 'HR' },
  { table: 'exit_interviews',          minExpected: 0,   module: 'HR' },
  { table: 'fnf_settlements',          minExpected: 0,   module: 'HR' },
  { table: 'training_programs',        minExpected: 0,   module: 'HR' },
  { table: 'training_enrollments',     minExpected: 0,   module: 'HR' },
  { table: 'skill_matrix',             minExpected: 0,   module: 'HR' },
  { table: 'succession_assessments',   minExpected: 0,   module: 'HR - Talent' },
  { table: 'critical_roles',           minExpected: 0,   module: 'HR - Talent' },
  { table: 'talent_assessments',       minExpected: 0,   module: 'HR - Talent' },
  { table: 'biometric_devices',        minExpected: 0,   module: 'HR - Attendance' },
  { table: 'biometric_logs',           minExpected: 0,   module: 'HR - Attendance' },
  { table: 'gate_passes',              minExpected: 0,   module: 'HR - Security' },
  { table: 'visitors',                 minExpected: 0,   module: 'HR - Security' },
  // Service Desk
  { table: 'tickets',                  minExpected: 15,  module: 'Service Desk' },
  { table: 'ticket_comments',          minExpected: 0,   module: 'Service Desk' },
  { table: 'ticket_attachments',       minExpected: 0,   module: 'Service Desk' },
  { table: 'sla_policies',             minExpected: 0,   module: 'Service Desk' },
  { table: 'ticket_sla_tracking',      minExpected: 0,   module: 'Service Desk' },
  { table: 'knowledge_base_articles',  minExpected: 0,   module: 'Service Desk' },
  { table: 'service_contracts',        minExpected: 0,   module: 'Service Desk' },
  { table: 'field_visits',             minExpected: 0,   module: 'Service Desk' },
  { table: 'service_engineers',        minExpected: 0,   module: 'Service Desk' },
  { table: 'csat_surveys',             minExpected: 0,   module: 'Service Desk' },
  // Travel
  { table: 'travel_requests',          minExpected: 10,  module: 'Travel' },
  { table: 'travel_bookings',          minExpected: 0,   module: 'Travel' },
  { table: 'travel_expenses',          minExpected: 0,   module: 'Travel' },
  { table: 'travel_advances',          minExpected: 0,   module: 'Travel' },
  // Performance
  { table: 'performance_reviews',      minExpected: 30,  module: 'Performance' },
  { table: 'review_ratings',           minExpected: 0,   module: 'Performance' },
  { table: 'goals',                    minExpected: 20,  module: 'Performance' },
  // Recruitment
  { table: 'job_openings',             minExpected: 5,   module: 'Recruitment' },
  { table: 'candidates',               minExpected: 12,  module: 'Recruitment' },
  { table: 'interviews',               minExpected: 3,   module: 'Recruitment' },
  { table: 'job_offers',               minExpected: 0,   module: 'Recruitment' },
  { table: 'onboarding_checklists',    minExpected: 0,   module: 'Recruitment' },
  { table: 'email_templates',          minExpected: 0,   module: 'Recruitment' },
  // Notifications & Audit
  { table: 'notifications',            minExpected: 20,  module: 'Notifications' },
  { table: 'audit_logs',               minExpected: 0,   module: 'Audit' },
  { table: 'saved_reports',            minExpected: 0,   module: 'Reports' },
  // Marketing
  { table: 'campaigns',                minExpected: 0,   module: 'Marketing' },
  { table: 'campaign_leads',           minExpected: 0,   module: 'Marketing' },
  // Operations
  { table: 'workflow_rules',           minExpected: 0,   module: 'Operations' },
  { table: 'workflow_executions',      minExpected: 0,   module: 'Operations' },
  // Admin
  { table: 'integration_settings',     minExpected: 0,   module: 'Admin' },
  { table: 'security_events',          minExpected: 0,   module: 'Admin' },
  { table: 'ip_whitelist',             minExpected: 0,   module: 'Admin' },
  { table: 'revoked_tokens',           minExpected: 0,   module: 'Admin' },
  // Complaints
  { table: 'complaints',               minExpected: 0,   module: 'Service Desk' },
];

// ─── API Endpoints that should now return data ───────────────────────────────

const API_ENDPOINTS = [
  { method: 'GET', url: '/api/employees',            expectedData: '50 employees',                  module: 'Employees' },
  { method: 'GET', url: '/api/attendance',           expectedData: '800+ attendance records',        module: 'Attendance' },
  { method: 'GET', url: '/api/leaves',               expectedData: '15 leave requests',             module: 'Leaves' },
  { method: 'GET', url: '/api/payroll',              expectedData: '2 payroll runs',                module: 'Payroll' },
  { method: 'GET', url: '/api/payroll/:id/payslips', expectedData: '50 payslips per run',           module: 'Payroll' },
  { method: 'GET', url: '/api/invoices',             expectedData: '24 invoices',                   module: 'Finance' },
  { method: 'GET', url: '/api/bills',                expectedData: '12 bills',                      module: 'Finance' },
  { method: 'GET', url: '/api/journal-entries',      expectedData: '20 journal entries',            module: 'Finance' },
  { method: 'GET', url: '/api/chart-of-accounts',    expectedData: '44 accounts',                   module: 'Finance' },
  { method: 'GET', url: '/api/parties',              expectedData: '18 parties',                    module: 'Finance' },
  { method: 'GET', url: '/api/projects',             expectedData: '8 projects',                    module: 'Projects' },
  { method: 'GET', url: '/api/tasks',                expectedData: '32+ tasks',                     module: 'Projects' },
  { method: 'GET', url: '/api/timesheets',           expectedData: '80+ timesheet records',         module: 'Timesheets' },
  { method: 'GET', url: '/api/crm/leads',            expectedData: '12 leads',                      module: 'CRM' },
  { method: 'GET', url: '/api/crm/accounts',         expectedData: '8 accounts',                    module: 'CRM' },
  { method: 'GET', url: '/api/crm/opportunities',    expectedData: '6 opportunities',               module: 'CRM' },
  { method: 'GET', url: '/api/purchase-requests',    expectedData: '8 PRs',                         module: 'Procurement' },
  { method: 'GET', url: '/api/purchase-orders',      expectedData: '5 POs',                         module: 'Procurement' },
  { method: 'GET', url: '/api/goods-receipts',       expectedData: '3 GRNs',                        module: 'Procurement' },
  { method: 'GET', url: '/api/inventory',            expectedData: '20 items, 3 below reorder',     module: 'Inventory' },
  { method: 'GET', url: '/api/tickets',              expectedData: '15 tickets',                    module: 'Service Desk' },
  { method: 'GET', url: '/api/travel-requests',      expectedData: '10 travel requests',            module: 'Travel' },
  { method: 'GET', url: '/api/performance-reviews',  expectedData: '30 reviews',                    module: 'Performance' },
  { method: 'GET', url: '/api/goals',                expectedData: '20 goals',                      module: 'Performance' },
  { method: 'GET', url: '/api/recruitment/jobs',     expectedData: '5 open positions',              module: 'Recruitment' },
  { method: 'GET', url: '/api/recruitment/candidates','expectedData': '12 candidates',              module: 'Recruitment' },
  { method: 'GET', url: '/api/announcements',        expectedData: '5 announcements',               module: 'HR' },
  { method: 'GET', url: '/api/notifications',        expectedData: '20 notifications for admin',   module: 'Notifications' },
  { method: 'GET', url: '/api/holidays',             expectedData: '13 holidays for 2026',         module: 'HR' },
];

// ─── Main ────────────────────────────────────────────────────────────────────

async function runChecklist() {
  console.log('\n🔍 Pulse ERP — Post-Seed Verification\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const results = [];
  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;

  for (const check of TABLE_CHECKS) {
    let count = 0;
    let tableExists = true;

    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM ${check.table}`
      );
      count = parseInt(rows[0].cnt);
    } catch (err) {
      if (err.message.includes('does not exist')) {
        tableExists = false;
      } else {
        tableExists = false;
      }
    }

    if (!tableExists) {
      const msg = `❌ ${check.table}: TABLE MISSING`;
      console.log(msg);
      results.push({ table: check.table, count: 'MISSING', status: 'error', minExpected: check.minExpected, module: check.module });
      failCount++;
    } else if (check.minExpected === 0) {
      const msg = `ℹ️  ${check.table}: ${count} records (no seed data required)`;
      console.log(msg);
      results.push({ table: check.table, count, status: 'empty', minExpected: 0, module: check.module });
      warnCount++;
    } else if (count >= check.minExpected) {
      const msg = `✅ ${check.table}: ${count} records`;
      console.log(msg);
      results.push({ table: check.table, count, status: 'pass', minExpected: check.minExpected, module: check.module });
      passCount++;
    } else {
      const msg = `❌ ${check.table}: ${count} records — expected at least ${check.minExpected}`;
      console.log(msg);
      results.push({ table: check.table, count, status: 'fail', minExpected: check.minExpected, module: check.module });
      failCount++;
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`\n📊 Summary: ${passCount} passed | ${warnCount} empty (ok) | ${failCount} failed\n`);

  // ─── Generate SEED_REPORT.md ─────────────────────────────────────────────

  const seedReportPath = path.join(projectRoot, 'Pulse', 'SEED_REPORT.md');

  const passList = results.filter(r => r.status === 'pass');
  const emptyList = results.filter(r => r.status === 'empty');
  const failList = results.filter(r => r.status === 'fail' || r.status === 'error');

  // Group empty tables by module
  const emptyByModule = {};
  emptyList.forEach(r => {
    if (!emptyByModule[r.module]) emptyByModule[r.module] = [];
    emptyByModule[r.module].push(r.table);
  });

  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  const report = `# Pulse ERP — Seed Report
Generated: ${now} IST

## Summary
| Status | Count |
|--------|-------|
| ✅ Tables with data | ${passCount} |
| ℹ️  Empty (no seed required) | ${warnCount} |
| ❌ Failed / Missing | ${failCount} |

---

## ✅ Seeded Tables (with record counts)

| Table | Records | Module |
|-------|---------|--------|
${passList.map(r => `| \`${r.table}\` | ${r.count} | ${r.module} |`).join('\n')}

---

## ℹ️  Empty Tables (no seed data — populated via UI)

${Object.entries(emptyByModule).map(([mod, tables]) => `### ${mod}\n${tables.map(t => `- \`${t}\``).join('\n')}`).join('\n\n')}

---

## ❌ Failed / Missing Tables

${failList.length === 0
  ? '> All expected tables have data. 🎉'
  : failList.map(r => `- \`${r.table}\` — ${r.count === 'MISSING' ? '**TABLE MISSING** — run runMigrations.js' : `only ${r.count} records (expected ${r.minExpected})`} [${r.module}]`).join('\n')
}

---

## 🌐 API Endpoints (should now return data)

| Method | URL | Expected | Module |
|--------|-----|----------|--------|
${API_ENDPOINTS.map(e => `| \`${e.method}\` | \`${e.url}\` | ${e.expectedData} | ${e.module} |`).join('\n')}

---

## 🚀 Quick Test Guide (by role)

### Login Credentials
| Role | Email | Password |
|------|-------|----------|
| Super Admin | admin@manifest.in | Manifest@123 |
| HR Manager | hr@manifest.in | Manifest@123 |
| Finance | accounts@manifest.in | Manifest@123 |
| Manager | manager@manifest.in | Manifest@123 |
| Employee | dev1@manifest.in | Manifest@123 |
| Sales | sales@manifest.in | Manifest@123 |

---

### Module Quick Tests

#### Payroll
- Login as **hr@manifest.in**
- Navigate to: HR → Payroll
- Select **February 2026** — should show 50 employees
- Total gross salary ≈ ₹32–35 Lakhs
- 5 employees will show "pending" status (EMP046–EMP050)
- Click any payslip → verify PF = 12% of basic (capped at ₹15,000 basic)

#### Finance — Invoices
- Login as **accounts@manifest.in**
- Navigate to: Finance → Invoices
- Should see 24 invoices (INV-2025-001 to INV-2025-024)
- 4 invoices are overdue (INV-2025-021 to INV-2025-024) — check red badges
- Click any invoice → verify GST = 18% (9% CGST + 9% SGST)

#### Projects
- Login as **manager@manifest.in**
- Navigate to: Projects
- Should see 8 projects
- 2 projects should show "at_risk" status (red) — HDFC Analytics & Chatbot
- 2 projects should show "completed" — Apollo Cloud Migration & Security Audit

#### CRM
- Login as **sales@manifest.in**
- Navigate to: CRM → Leads
- Should see 12 leads in various pipeline stages
- Check Pipeline view — leads across Prospecting → Closed Won/Lost
- Navigate to Opportunities — 6 opportunities, total pipeline ~₹1.2 Cr

#### Attendance
- Login as any user
- Navigate to: HR → Attendance
- Select today's date — should show present/absent/late status
- 30 days of data for all 45 active employees (~1,200+ records)

#### Service Desk
- Login as **admin@manifest.in**
- Navigate to: Service Desk → Tickets
- Should see 15 tickets across IT Support, HR, Finance, Operations
- 2 Critical tickets (TKT-001, TKT-015) should be highlighted
- 5 tickets are resolved, 4 in-progress, 6 open

#### Inventory
- Navigate to: Inventory
- Should see 20 items (10 software licenses, 5 hardware, 5 office)
- 3 items below reorder point: Postman Business (4), DataGrip IDE (3), Webcam (2)
- These should show a reorder alert/badge

---

## 🏢 Company Reference Data

| Field | Value |
|-------|-------|
| Company | Manifest Technologies Pvt Ltd |
| Location | Chennai, Tamil Nadu |
| GSTIN | 33AABCM1234A1Z5 |
| PAN | AABCM1234A |
| Total Employees | 50 |
| Active | 45 |
| On Leave | 3 |
| Inactive | 2 |
| Departments | Engineering (18), Sales (8), HR (4), Finance (4), Operations (5), Marketing (4), QA (4), Management (3) |

---

*Generated by testChecklist.js — Pulse ERP Seed System*
`;

  fs.writeFileSync(seedReportPath, report, 'utf8');
  console.log(`📄 SEED_REPORT.md written to: ${seedReportPath}`);

  if (failCount > 0) {
    console.log('\n⚠️  Some tables are missing or have insufficient data.');
    console.log('    Run: node src/database/seeds/runMigrations.js\n');
  } else {
    console.log('\n🎉 All seed checks passed! Your ERP is ready to test.\n');
  }

  await pool.end();
}

runChecklist().catch(err => {
  console.error('❌ Checklist failed:', err.message);
  process.exit(1);
});
