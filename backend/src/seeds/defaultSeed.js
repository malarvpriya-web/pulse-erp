/**
 * defaultSeed.js — seed all registry defaults for a company.
 *
 * Call once on first setup (triggered by wizard/complete) or manually via
 * POST /admin/seed-defaults.
 *
 * Every insert is guarded with NOT EXISTS / ON CONFLICT DO NOTHING so the whole
 * thing is safe to re-run. Each group is isolated: a schema drift in one group
 * is reported and skipped rather than aborting every group after it (an earlier
 * version inserted gen_random_uuid() into SERIAL ids and wrote to columns that
 * don't exist, so it threw on the first group and nothing was ever seeded).
 */

const results = [];

async function group(name, fn) {
  try {
    const n = await fn();
    results.push({ group: name, seeded: n });
  } catch (err) {
    results.push({ group: name, error: err.message });
    console.error(`[Seed] group "${name}" failed: ${err.message}`);
  }
}

export async function seedCompanyDefaults(companyId, db) {
  results.length = 0;

  // 1. DEPARTMENTS — master_departments(id SERIAL, name UNIQUE, is_active)
  await group('departments', async () => {
    const departments = [
      'Engineering', 'Finance', 'HR', 'Sales & Marketing', 'Operations',
      'Production', 'Procurement', 'Quality', 'IT', 'Management',
    ];
    let n = 0;
    for (const name of departments) {
      const r = await db.query(
        `INSERT INTO master_departments (name, is_active) VALUES ($1, true)
         ON CONFLICT (name) DO NOTHING`, [name]);
      n += r.rowCount;
    }
    return n;
  });

  // 2. DESIGNATIONS — master_designations(id SERIAL, name UNIQUE, is_active)
  await group('designations', async () => {
    const designations = [
      'Managing Director', 'General Manager', 'Senior Manager', 'Manager',
      'Assistant Manager', 'Senior Engineer', 'Engineer', 'Junior Engineer',
      'Executive', 'Analyst',
    ];
    let n = 0;
    for (const name of designations) {
      const r = await db.query(
        `INSERT INTO master_designations (name, is_active) VALUES ($1, true)
         ON CONFLICT (name) DO NOTHING`, [name]);
      n += r.rowCount;
    }
    return n;
  });

  // 3. LEAVE TYPES — leave_types(id SERIAL, leave_name, leave_code, annual_quota, company_id)
  await group('leave_types', async () => {
    const leaveTypes = [
      ['Casual Leave',     'CASUAL',   12],
      ['Sick Leave',       'SICK',     12],
      ['Earned Leave',     'ANNUAL',   15],
      ['Maternity Leave',  'MAT',     182],
      ['Paternity Leave',  'PAT',      15],
      ['Compensatory Off', 'COMPOFF',   0],
      ['Loss of Pay',      'LOP',       0],
    ];
    let n = 0;
    for (const [leave_name, leave_code, annual_quota] of leaveTypes) {
      const r = await db.query(
        `INSERT INTO leave_types (company_id, leave_name, leave_code, annual_quota, is_active)
         SELECT $1::int, $2::text, $3::text, $4::int, true
          WHERE NOT EXISTS (
            SELECT 1 FROM leave_types
             WHERE company_id = $1 AND deleted_at IS NULL
               AND (LOWER(leave_name) = LOWER($2) OR UPPER(leave_code) = UPPER($3))
          )`,
        [companyId, leave_name, leave_code, annual_quota]);
      n += r.rowCount;
    }
    return n;
  });

  // 4. BRANCHES — branches(company_id NOT NULL, name NOT NULL, code, city) UNIQUE(company_id, code)
  //    18 tables carry an FK to branches, so a company needs at least one.
  await group('branches', async () => {
    const r = await db.query(
      `INSERT INTO branches (company_id, name, code, city, is_active)
       SELECT $1, 'Head Office', 'HO', COALESCE((SELECT city FROM companies WHERE id = $1), NULL), true
        WHERE NOT EXISTS (SELECT 1 FROM branches WHERE company_id = $1)`,
      [companyId]);
    return r.rowCount;
  });

  // 5. DOCUMENT TYPES — document_types(doc_type, doc_name, max_size_mb)
  await group('document_types', async () => {
    const docTypes = [
      ['HR',          'Resume / CV',              5],
      ['HR',          'Aadhaar Card',            10],
      ['HR',          'PAN Card',                 5],
      ['HR',          'Offer Letter',             5],
      ['HR',          'Educational Certificate', 10],
      ['HR',          'Bank Account Proof',       5],
      ['HR',          'Profile Photo',            2],
      ['HR',          'Appointment Letter',       5],
      ['Finance',     'Invoice',                 10],
      ['Finance',     'GST Certificate',          5],
      ['Finance',     'Bank Statement',          10],
      ['Legal',       'Contract / Agreement',    20],
      ['Legal',       'NDA',                     10],
      ['Procurement', 'Purchase Order',          10],
      ['Procurement', 'Quotation',               10],
      ['Quality',     'Test Report',             10],
      ['Quality',     'Inspection Certificate',  10],
    ];
    let n = 0;
    for (const [doc_type, doc_name, max_size_mb] of docTypes) {
      const r = await db.query(
        `INSERT INTO document_types (doc_type, doc_name, max_size_mb)
         SELECT $1::text, $2::text, $3::int
          WHERE NOT EXISTS (
            SELECT 1 FROM document_types WHERE doc_type = $1 AND doc_name = $2
          )`,
        [doc_type, doc_name, max_size_mb]);
      n += r.rowCount;
    }
    return n;
  });

  // 6. EXPENSE CATEGORIES — expense_categories(name, description, is_active)
  await group('expense_categories', async () => {
    const cats = [
      ['Travel',                'Air / rail / road fare for business travel'],
      ['Accommodation',         'Hotel and lodging during business travel'],
      ['Meals',                 'Food and per-diem during business travel'],
      ['Local Conveyance',      'Taxi, cab and local transport'],
      ['Fuel',                  'Fuel and mileage reimbursement'],
      ['Office Supplies',       'Stationery and consumables'],
      ['Telephone & Internet',  'Mobile, broadband and data charges'],
      ['Client Entertainment',  'Customer meetings and hospitality'],
      ['Training',              'Courses, certifications and conferences'],
      ['Medical',               'Medical and health-related reimbursements'],
      ['Miscellaneous',        'Other approved business expenses'],
    ];
    let n = 0;
    for (const [name, description] of cats) {
      const r = await db.query(
        `INSERT INTO expense_categories (name, description, is_active)
         SELECT $1::text, $2::text, true
          WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE LOWER(name) = LOWER($1))`,
        [name, description]);
      n += r.rowCount;
    }
    return n;
  });

  // 7. TICKET CATEGORIES — ticket_categories(name, description, is_active)
  await group('ticket_categories', async () => {
    const cats = [
      ['Hardware',       'Desktop, laptop, peripherals and device faults'],
      ['Software',       'Application errors, installs and licensing'],
      ['Network',        'Connectivity, VPN, Wi-Fi and bandwidth'],
      ['Access Request', 'Account creation, permissions and password resets'],
      ['Email',          'Mailbox, distribution list and spam issues'],
      ['Printer',        'Printing, scanning and consumables'],
      ['ERP Support',    'Pulse ERP module issues and how-to questions'],
      ['Other',          'Anything not covered by the categories above'],
    ];
    let n = 0;
    for (const [name, description] of cats) {
      const r = await db.query(
        `INSERT INTO ticket_categories (name, description, is_active)
         SELECT $1::text, $2::text, true
          WHERE NOT EXISTS (SELECT 1 FROM ticket_categories WHERE LOWER(name) = LOWER($1))`,
        [name, description]);
      n += r.rowCount;
    }
    return n;
  });

  // 8. GRADES / BANDS — master_grades & master_bands(name UNIQUE, company_id, is_active)
  await group('grades_bands', async () => {
    const grades = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'];
    const bands  = ['Band A - Entry', 'Band B - Associate', 'Band C - Professional',
                    'Band D - Lead', 'Band E - Management', 'Band F - Executive'];
    let n = 0;
    for (const name of grades) {
      const r = await db.query(
        `INSERT INTO master_grades (name, company_id, is_active) VALUES ($1, $2, true)
         ON CONFLICT (company_id, name) DO NOTHING`, [name, companyId]);
      n += r.rowCount;
    }
    for (const name of bands) {
      const r = await db.query(
        `INSERT INTO master_bands (name, company_id, is_active) VALUES ($1, $2, true)
         ON CONFLICT (company_id, name) DO NOTHING`, [name, companyId]);
      n += r.rowCount;
    }
    return n;
  });

  // 9. SETTINGS SINGLETONS — one row per company; every other column has a DB default.
  await group('settings_singletons', async () => {
    const tables = ['payroll_settings', 'quality_settings', 'lnd_settings', 'succession_settings'];
    let n = 0;
    for (const t of tables) {
      const r = await db.query(
        `INSERT INTO ${t} (company_id) SELECT $1
          WHERE NOT EXISTS (SELECT 1 FROM ${t} WHERE company_id = $1)`,
        [companyId]);
      n += r.rowCount;
    }
    return n;
  });

  // 10. PRODUCT CATALOGUE (Manifest Technologies — Power Quality / SST / HVDC)
  //     Live products table is minimal: (product_name, description).
  await group('products', async () => {
    const products = [
      ['Automatic Power Factor Correction Panel', 'APFC panel · HSN 85044090 · GST 18%'],
      ['D-STATCOM Unit',                          'FACTS · HSN 85044090 · GST 18%'],
      ['Active Harmonic Filter',                  'AHF · HSN 85044090 · GST 18%'],
      ['Dynamic Voltage Restorer',                'DVR · HSN 85044090 · GST 18%'],
      ['Solid State Transformer 11kV/415V',       'SST · HSN 85043190 · GST 18%'],
      ['Solid State Transformer 33kV/11kV',       'SST · HSN 85043190 · GST 18%'],
      ['HVDC Converter Control Unit',             'HVDC · HSN 85437099 · GST 18%'],
      ['VSC-HVDC Converter Station',              'HVDC · HSN 85044090 · GST 18%'],
      ['Commissioning Services',                  'Services · SAC 998719 · GST 18%'],
      ['Annual Maintenance Contract',             'Services · SAC 998719 · GST 18%'],
      ['Training & Certification',                'Services · SAC 999293 · GST 18%'],
    ];
    let n = 0;
    for (const [product_name, description] of products) {
      const r = await db.query(
        `INSERT INTO products (product_name, description, is_active)
         SELECT $1::text, $2::text, true
          WHERE NOT EXISTS (SELECT 1 FROM products WHERE LOWER(product_name) = LOWER($1))`,
        [product_name, description]);
      n += r.rowCount;
    }
    return n;
  });

  // 11. NOTIFICATION RULES
  await group('notification_rules', async () => {
    const notifRules = [
      ['leave.applied',       'Leave Application Submitted',   'in_app,email', ['manager', 'hr']],
      ['leave.approved',      'Leave Approved',                'in_app,email', ['employee']],
      ['leave.rejected',      'Leave Rejected',                'in_app,email', ['employee']],
      ['attendance.absent',   'Absent Without Leave Alert',    'in_app,email', ['manager', 'hr']],
      ['recruitment.applied', 'New Job Application Received',  'in_app,email', ['hr', 'manager']],
      ['recruitment.hired',   'Candidate Hired',               'in_app,email', ['hr', 'admin']],
      ['approval.pending',    'Approval Request Waiting',      'in_app,email', ['approver']],
      ['approval.approved',   'Your Request Was Approved',     'in_app,email', ['employee']],
      ['approval.rejected',   'Your Request Was Rejected',     'in_app,email', ['employee']],
      ['invoice.due',         'Invoice Payment Due',           'in_app,email', ['finance', 'admin']],
      ['invoice.overdue',     'Invoice Overdue Alert',         'in_app,email', ['finance', 'admin']],
      ['expense.submitted',   'Expense Claim Submitted',       'in_app',       ['manager', 'finance']],
      ['crm.lead_assigned',   'New Lead Assigned to You',      'in_app,email', ['employee']],
      ['sales.order_created', 'New Sales Order Created',       'in_app',       ['manager', 'finance']],
      ['ticket.created',      'New Support Ticket Created',    'in_app,email', ['service_desk']],
      ['ticket.resolved',     'Support Ticket Resolved',       'in_app,email', ['employee']],
      ['user.created',        'New User Account Created',      'in_app,email', ['admin']],
      ['security.login_new',  'New Login from Unknown Device', 'in_app,email', ['self']],
    ];
    let n = 0;
    for (const [event_key, title, channel, recipient_roles] of notifRules) {
      const r = await db.query(
        `INSERT INTO notification_rules (company_id, event_key, title, channel, recipient_roles, enabled, is_system_default)
         SELECT $1::int, $2::text, $3::text, $4::text, $5::text[], true, true
          WHERE NOT EXISTS (
            SELECT 1 FROM notification_rules WHERE company_id = $1 AND event_key = $2
          )`,
        [companyId, event_key, title, channel, recipient_roles]);
      n += r.rowCount;
    }
    return n;
  });

  const failed = results.filter(r => r.error);
  console.log(`[Seed] Company ${companyId}:`, results.map(r =>
    r.error ? `${r.group}=ERROR` : `${r.group}=+${r.seeded}`).join(' '));
  return { companyId, groups: [...results], failed: failed.length };
}

export default seedCompanyDefaults;
