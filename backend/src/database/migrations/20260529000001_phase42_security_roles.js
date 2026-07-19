/**
 * Phase 42 — Security, Authorization & Organizational Hardening
 *
 * 1. Inserts all 20 granular roles into the `roles` table
 * 2. Populates `role_permissions` with the complete permission matrix
 *    (module × role × can_view/add/edit/delete/approve/export)
 * 3. Adds `deleted_at` column to branches if missing (soft-delete support)
 *
 * Idempotent: uses INSERT … ON CONFLICT DO NOTHING / IF NOT EXISTS everywhere.
 */

export async function up(knex) {
  const db = knex.raw ? { query: (sql, b) => knex.raw(sql, b) } : knex;

  // ── 1. Ensure roles table exists and has required columns ────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS roles (
      id          SERIAL PRIMARY KEY,
      code        VARCHAR(50)  NOT NULL UNIQUE,
      label       VARCHAR(100) NOT NULL,
      description TEXT,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  // Existing installs have role_name (NOT NULL) instead of label.
  // Add missing columns and relax role_name's NOT NULL so the new-style INSERT works.
  await db.query(`
    ALTER TABLE roles
      ADD COLUMN IF NOT EXISTS label       VARCHAR(100),
      ADD COLUMN IF NOT EXISTS description TEXT
  `);
  await db.query(`ALTER TABLE roles ALTER COLUMN role_name DROP NOT NULL`);

  // ── 2. Insert all 20 granular roles ──────────────────────────────────────────
  const roles = [
    ['super_admin',          'Super Administrator',   'Full system access — cross-company'],
    ['admin',                'Administrator',          'Company-level admin — all modules'],
    ['hr_manager',           'HR Manager',             'Full HR access: employees, payroll, leaves, attendance'],
    ['hr_exec',              'HR Executive',           'HR operations: employees, leaves, attendance — no payroll'],
    ['finance_manager',      'Finance Manager',        'Full finance: invoices, GL, GST, TDS, payroll reports'],
    ['accounts_exec',        'Accounts Executive',     'Finance operations: invoices, bills, payments — no GL/TDS'],
    ['payroll_admin',        'Payroll Administrator',  'Payroll run, salary structures, Form 16, Form 24Q'],
    ['procurement_manager',  'Procurement Manager',    'Full procurement: PO, vendors, RFQ, GRN'],
    ['procurement_exec',     'Procurement Executive',  'Procurement operations: PO creation, GRN — no approval'],
    ['store_keeper',         'Store Keeper',           'Inventory: GRN receipt, stock transactions, warehouse'],
    ['production_manager',   'Production Manager',     'Full production: BOM, work orders, scheduling'],
    ['production_engineer',  'Production Engineer',    'Production execution: work orders, time logs'],
    ['qc_manager',           'QC Manager',             'Quality: inspection plans, test results, NCR approval'],
    ['qc_engineer',          'QC Engineer',            'Quality: test execution, inspection records'],
    ['design_engineer',      'Design Engineer',        'Engineering: BOM creation, ECN, drawings'],
    ['project_manager',      'Project Manager',        'Projects: full CRUD, Gantt, resources'],
    ['sales_manager',        'Sales Manager',          'CRM + Sales: full access including pricing approval'],
    ['sales_exec',           'Sales Executive',        'CRM: leads, quotes, orders — no pricing approval'],
    ['service_manager',      'Service Manager',        'Service desk: full access, AMC, warranty'],
    ['service_engineer',     'Service Engineer',       'Service desk: ticket operations only'],
    ['employee',             'Employee',               'Self-service: own profile, payslips, leaves, timesheets'],
  ];

  for (const [code, label, description] of roles) {
    await db.query(
      `INSERT INTO roles (code, label, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description`,
      [code, label, description]
    );
  }

  // ── 3. Ensure role_permissions table exists ───────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      id          SERIAL PRIMARY KEY,
      role_id     INT  NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      module      VARCHAR(50) NOT NULL,
      can_view    BOOLEAN NOT NULL DEFAULT false,
      can_add     BOOLEAN NOT NULL DEFAULT false,
      can_edit    BOOLEAN NOT NULL DEFAULT false,
      can_delete  BOOLEAN NOT NULL DEFAULT false,
      can_approve BOOLEAN NOT NULL DEFAULT false,
      can_export  BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (role_id, module)
    )
  `);

  // Helper: upsert one permission row
  async function perm(roleCode, module, v, a, e, d, ap, ex) {
    await db.query(
      `INSERT INTO role_permissions (role_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
       SELECT r.id, $2, $3, $4, $5, $6, $7, $8
         FROM roles r WHERE r.code = $1
       ON CONFLICT (role_id, module)
       DO UPDATE SET can_view=$3, can_add=$4, can_edit=$5, can_delete=$6, can_approve=$7, can_export=$8`,
      [roleCode, module, v, a, e, d, ap, ex]
    );
  }

  // ── 4. Full permission matrix ──────────────────────────────────────────────
  // Columns: module, view, add, edit, delete, approve, export
  // Super admin and admin: full access seeded below
  const FULL   = [true,  true,  true,  true,  true,  true ];
  const VONLY  = [true,  false, false, false, false, false];
  const VEXP   = [true,  false, false, false, false, true ];
  const VAE    = [true,  true,  true,  false, false, false];
  const VAED   = [true,  true,  true,  true,  false, false];
  const VAEAP  = [true,  true,  true,  false, true,  false];
  const VAEDAP = [true,  true,  true,  true,  true,  false];
  const NONE   = [false, false, false, false, false, false];

  const modules = [
    'hr', 'payroll', 'attendance', 'leaves', 'finance', 'accounting',
    'gst', 'tds', 'procurement', 'inventory', 'warehouse', 'production',
    'bom', 'engineering', 'quality', 'projects', 'crm', 'sales', 'servicedesk',
    'documents', 'reports', 'admin', 'master', 'company_profile', 'branches',
    'recruitment', 'training', 'timesheets', 'analytics', 'settings',
  ];

  // super_admin and admin: FULL on everything
  for (const mod of modules) {
    await perm('super_admin', mod, ...FULL);
    await perm('admin',       mod, ...FULL);
  }

  // ── hr_manager ───────────────────────────────────────────────────────────────
  await perm('hr_manager', 'hr',             ...FULL);
  await perm('hr_manager', 'payroll',        ...FULL);
  await perm('hr_manager', 'attendance',     ...FULL);
  await perm('hr_manager', 'leaves',         ...FULL);
  await perm('hr_manager', 'recruitment',    ...FULL);
  await perm('hr_manager', 'training',       ...FULL);
  await perm('hr_manager', 'timesheets',     true, true, true, false, true, true);
  await perm('hr_manager', 'documents',      true, true, true, false, false, true);
  await perm('hr_manager', 'reports',        true, false, false, false, false, true);
  await perm('hr_manager', 'master',         ...VONLY);
  await perm('hr_manager', 'company_profile',...VONLY);
  await perm('hr_manager', 'branches',       ...VONLY);
  await perm('hr_manager', 'settings',       ...VONLY);
  await perm('hr_manager', 'analytics',      ...VONLY);
  // No access to finance/procurement/production/crm
  for (const mod of ['finance','accounting','gst','tds','procurement','inventory',
                     'warehouse','production','bom','engineering','quality',
                     'projects','crm','sales','servicedesk','admin']) {
    await perm('hr_manager', mod, ...NONE);
  }

  // ── hr_exec ──────────────────────────────────────────────────────────────────
  await perm('hr_exec', 'hr',          ...VAE);
  await perm('hr_exec', 'attendance',  ...VAE);
  await perm('hr_exec', 'leaves',      true, true, false, false, true, false);
  await perm('hr_exec', 'recruitment', ...VAE);
  await perm('hr_exec', 'training',    ...VAE);
  await perm('hr_exec', 'timesheets',  ...VONLY);
  await perm('hr_exec', 'documents',   ...VAE);
  await perm('hr_exec', 'reports',     ...VONLY);
  await perm('hr_exec', 'master',      ...VONLY);
  for (const mod of ['payroll','finance','accounting','gst','tds','procurement','inventory',
                     'warehouse','production','bom','engineering','quality','projects',
                     'crm','sales','servicedesk','admin','company_profile','branches',
                     'settings','analytics']) {
    await perm('hr_exec', mod, ...NONE);
  }

  // ── finance_manager ───────────────────────────────────────────────────────────
  await perm('finance_manager', 'finance',        ...FULL);
  await perm('finance_manager', 'accounting',     ...FULL);
  await perm('finance_manager', 'gst',            ...FULL);
  await perm('finance_manager', 'tds',            ...FULL);
  await perm('finance_manager', 'payroll',        ...VEXP);    // view/export only
  await perm('finance_manager', 'reports',        true, false, false, false, false, true);
  await perm('finance_manager', 'documents',      ...VONLY);
  await perm('finance_manager', 'company_profile',...VONLY);
  await perm('finance_manager', 'branches',       ...VONLY);
  await perm('finance_manager', 'master',         ...VONLY);
  await perm('finance_manager', 'analytics',      ...VONLY);
  await perm('finance_manager', 'settings',       ...VONLY);
  for (const mod of ['hr','attendance','leaves','procurement','inventory','warehouse',
                     'production','bom','engineering','quality','projects','crm',
                     'sales','servicedesk','admin','recruitment','training','timesheets']) {
    await perm('finance_manager', mod, ...NONE);
  }

  // ── accounts_exec ─────────────────────────────────────────────────────────────
  await perm('accounts_exec', 'finance',    ...VAE);
  await perm('accounts_exec', 'accounting', true, true, false, false, false, false);
  await perm('accounts_exec', 'gst',        ...VONLY);
  await perm('accounts_exec', 'tds',        ...VONLY);
  await perm('accounts_exec', 'reports',    ...VONLY);
  await perm('accounts_exec', 'documents',  ...VONLY);
  await perm('accounts_exec', 'master',     ...VONLY);
  for (const mod of ['payroll','hr','attendance','leaves','procurement','inventory',
                     'warehouse','production','bom','engineering','quality','projects',
                     'crm','sales','servicedesk','admin','company_profile','branches',
                     'settings','analytics','recruitment','training','timesheets']) {
    await perm('accounts_exec', mod, ...NONE);
  }

  // ── payroll_admin ─────────────────────────────────────────────────────────────
  await perm('payroll_admin', 'payroll',   ...FULL);
  await perm('payroll_admin', 'hr',        ...VONLY);
  await perm('payroll_admin', 'attendance',...VONLY);
  await perm('payroll_admin', 'leaves',    ...VONLY);
  await perm('payroll_admin', 'reports',   true, false, false, false, false, true);
  await perm('payroll_admin', 'documents', ...VONLY);
  await perm('payroll_admin', 'master',    ...VONLY);
  for (const mod of ['finance','accounting','gst','tds','procurement','inventory',
                     'warehouse','production','bom','engineering','quality','projects',
                     'crm','sales','servicedesk','admin','company_profile','branches',
                     'settings','analytics','recruitment','training','timesheets']) {
    await perm('payroll_admin', mod, ...NONE);
  }

  // ── procurement_manager ───────────────────────────────────────────────────────
  await perm('procurement_manager', 'procurement', ...FULL);
  await perm('procurement_manager', 'inventory',   ...VAEDAP);
  await perm('procurement_manager', 'warehouse',   ...VAED);
  await perm('procurement_manager', 'reports',     ...VEXP);
  await perm('procurement_manager', 'documents',   ...VAE);
  await perm('procurement_manager', 'master',      ...VONLY);
  await perm('procurement_manager', 'analytics',   ...VONLY);
  for (const mod of ['hr','payroll','attendance','leaves','finance','accounting','gst',
                     'tds','production','bom','engineering','quality','projects','crm',
                     'sales','servicedesk','admin','company_profile','branches',
                     'settings','recruitment','training','timesheets']) {
    await perm('procurement_manager', mod, ...NONE);
  }

  // ── procurement_exec ──────────────────────────────────────────────────────────
  await perm('procurement_exec', 'procurement', ...VAE);
  await perm('procurement_exec', 'inventory',   ...VONLY);
  await perm('procurement_exec', 'warehouse',   ...VONLY);
  await perm('procurement_exec', 'documents',   ...VAE);
  await perm('procurement_exec', 'master',      ...VONLY);
  for (const mod of ['hr','payroll','attendance','leaves','finance','accounting','gst',
                     'tds','production','bom','engineering','quality','projects','crm',
                     'sales','servicedesk','admin','company_profile','branches',
                     'settings','analytics','reports','recruitment','training','timesheets']) {
    await perm('procurement_exec', mod, ...NONE);
  }

  // ── store_keeper ──────────────────────────────────────────────────────────────
  await perm('store_keeper', 'inventory', true, true, true, false, false, true);
  await perm('store_keeper', 'warehouse', true, true, true, false, false, false);
  await perm('store_keeper', 'procurement', true, false, false, false, false, false); // GRN receipt
  await perm('store_keeper', 'reports',   ...VONLY);
  await perm('store_keeper', 'master',    ...VONLY);
  for (const mod of ['hr','payroll','attendance','leaves','finance','accounting','gst',
                     'tds','production','bom','engineering','quality','projects','crm',
                     'sales','servicedesk','admin','company_profile','branches',
                     'settings','analytics','documents','recruitment','training','timesheets']) {
    await perm('store_keeper', mod, ...NONE);
  }

  // ── production_manager ────────────────────────────────────────────────────────
  await perm('production_manager', 'production',  ...FULL);
  await perm('production_manager', 'bom',         ...FULL);
  await perm('production_manager', 'engineering',  true, true, true, false, true, true);
  await perm('production_manager', 'quality',     ...VAEDAP);
  await perm('production_manager', 'inventory',   ...VONLY);
  await perm('production_manager', 'warehouse',   ...VONLY);
  await perm('production_manager', 'reports',     ...VEXP);
  await perm('production_manager', 'documents',   ...VAE);
  await perm('production_manager', 'master',      ...VONLY);
  await perm('production_manager', 'timesheets',  ...VONLY);
  await perm('production_manager', 'analytics',   ...VONLY);
  for (const mod of ['hr','payroll','attendance','leaves','finance','accounting','gst',
                     'tds','procurement','projects','crm','sales','servicedesk',
                     'admin','company_profile','branches','settings','recruitment','training']) {
    await perm('production_manager', mod, ...NONE);
  }

  // ── production_engineer ───────────────────────────────────────────────────────
  await perm('production_engineer', 'production',  ...VAE);
  await perm('production_engineer', 'bom',         ...VONLY);
  await perm('production_engineer', 'engineering', ...VONLY);
  await perm('production_engineer', 'quality',     ...VONLY);
  await perm('production_engineer', 'inventory',   ...VONLY);
  await perm('production_engineer', 'timesheets',  ...VAE);
  await perm('production_engineer', 'documents',   ...VONLY);
  await perm('production_engineer', 'master',      ...VONLY);
  for (const mod of ['hr','payroll','attendance','leaves','finance','accounting','gst',
                     'tds','procurement','warehouse','projects','crm','sales','servicedesk',
                     'admin','company_profile','branches','settings','analytics','reports',
                     'recruitment','training']) {
    await perm('production_engineer', mod, ...NONE);
  }

  // ── qc_manager ────────────────────────────────────────────────────────────────
  await perm('qc_manager', 'quality',      ...FULL);
  await perm('qc_manager', 'engineering',  ...VONLY);
  await perm('qc_manager', 'production',   ...VONLY);
  await perm('qc_manager', 'inventory',    ...VONLY);
  await perm('qc_manager', 'reports',      ...VEXP);
  await perm('qc_manager', 'documents',    ...VAE);
  await perm('qc_manager', 'master',       ...VONLY);
  await perm('qc_manager', 'analytics',    ...VONLY);
  for (const mod of ['hr','payroll','attendance','leaves','finance','accounting','gst',
                     'tds','procurement','warehouse','bom','projects','crm','sales',
                     'servicedesk','admin','company_profile','branches','settings',
                     'recruitment','training','timesheets']) {
    await perm('qc_manager', mod, ...NONE);
  }

  // ── qc_engineer ───────────────────────────────────────────────────────────────
  await perm('qc_engineer', 'quality',     ...VAE);
  await perm('qc_engineer', 'production',  ...VONLY);
  await perm('qc_engineer', 'inventory',   ...VONLY);
  await perm('qc_engineer', 'documents',   ...VONLY);
  await perm('qc_engineer', 'master',      ...VONLY);
  for (const mod of ['hr','payroll','attendance','leaves','finance','accounting','gst',
                     'tds','procurement','warehouse','bom','engineering','projects','crm',
                     'sales','servicedesk','admin','company_profile','branches','settings',
                     'analytics','reports','recruitment','training','timesheets']) {
    await perm('qc_engineer', mod, ...NONE);
  }

  // ── design_engineer ───────────────────────────────────────────────────────────
  await perm('design_engineer', 'engineering', ...VAED);
  await perm('design_engineer', 'bom',         ...VAE);
  await perm('design_engineer', 'quality',     ...VONLY);
  await perm('design_engineer', 'production',  ...VONLY);
  await perm('design_engineer', 'documents',   ...VAE);
  await perm('design_engineer', 'master',      ...VONLY);
  for (const mod of ['hr','payroll','attendance','leaves','finance','accounting','gst',
                     'tds','procurement','inventory','warehouse','projects','crm','sales',
                     'servicedesk','admin','company_profile','branches','settings',
                     'analytics','reports','recruitment','training','timesheets']) {
    await perm('design_engineer', mod, ...NONE);
  }

  // ── project_manager ───────────────────────────────────────────────────────────
  await perm('project_manager', 'projects',   ...FULL);
  await perm('project_manager', 'timesheets', true, false, false, false, true, true);
  await perm('project_manager', 'documents',  ...VAE);
  await perm('project_manager', 'reports',    ...VEXP);
  await perm('project_manager', 'master',     ...VONLY);
  await perm('project_manager', 'analytics',  ...VONLY);
  for (const mod of ['hr','payroll','attendance','leaves','finance','accounting','gst',
                     'tds','procurement','inventory','warehouse','production','bom',
                     'engineering','quality','crm','sales','servicedesk','admin',
                     'company_profile','branches','settings','recruitment','training']) {
    await perm('project_manager', mod, ...NONE);
  }

  // ── sales_manager ─────────────────────────────────────────────────────────────
  await perm('sales_manager', 'crm',       ...FULL);
  await perm('sales_manager', 'sales',     ...FULL);
  await perm('sales_manager', 'documents', ...VAE);
  await perm('sales_manager', 'reports',   ...VEXP);
  await perm('sales_manager', 'master',    ...VONLY);
  await perm('sales_manager', 'analytics', ...VONLY);
  for (const mod of ['hr','payroll','attendance','leaves','finance','accounting','gst',
                     'tds','procurement','inventory','warehouse','production','bom',
                     'engineering','quality','projects','servicedesk','admin',
                     'company_profile','branches','settings','recruitment','training','timesheets']) {
    await perm('sales_manager', mod, ...NONE);
  }

  // ── sales_exec ────────────────────────────────────────────────────────────────
  await perm('sales_exec', 'crm',       ...VAE);
  await perm('sales_exec', 'sales',     true, true, true, false, false, false);
  await perm('sales_exec', 'documents', ...VONLY);
  await perm('sales_exec', 'master',    ...VONLY);
  for (const mod of ['hr','payroll','attendance','leaves','finance','accounting','gst',
                     'tds','procurement','inventory','warehouse','production','bom',
                     'engineering','quality','projects','servicedesk','admin',
                     'company_profile','branches','settings','analytics','reports',
                     'recruitment','training','timesheets']) {
    await perm('sales_exec', mod, ...NONE);
  }

  // ── service_manager ───────────────────────────────────────────────────────────
  await perm('service_manager', 'servicedesk', ...FULL);
  await perm('service_manager', 'documents',   ...VAE);
  await perm('service_manager', 'reports',     ...VEXP);
  await perm('service_manager', 'master',      ...VONLY);
  await perm('service_manager', 'analytics',   ...VONLY);
  for (const mod of ['hr','payroll','attendance','leaves','finance','accounting','gst',
                     'tds','procurement','inventory','warehouse','production','bom',
                     'engineering','quality','projects','crm','sales','admin',
                     'company_profile','branches','settings','recruitment','training','timesheets']) {
    await perm('service_manager', mod, ...NONE);
  }

  // ── service_engineer ──────────────────────────────────────────────────────────
  await perm('service_engineer', 'servicedesk', ...VAE);
  await perm('service_engineer', 'documents',   ...VONLY);
  await perm('service_engineer', 'master',      ...VONLY);
  for (const mod of ['hr','payroll','attendance','leaves','finance','accounting','gst',
                     'tds','procurement','inventory','warehouse','production','bom',
                     'engineering','quality','projects','crm','sales','admin',
                     'company_profile','branches','settings','analytics','reports',
                     'recruitment','training','timesheets']) {
    await perm('service_engineer', mod, ...NONE);
  }

  // ── employee (self-service only) ──────────────────────────────────────────────
  // The employee role sees only their own data — enforced at the controller level.
  // Permission table grants VIEW so requirePermission passes; row-level isolation
  // is done by the controller checking req.user.employeeId === requested id.
  await perm('employee', 'leaves',     true, true, false, false, false, false);
  await perm('employee', 'attendance', true, false, false, false, false, false);
  await perm('employee', 'timesheets', true, true, true, false, false, false);
  await perm('employee', 'documents',  true, false, false, false, false, false);
  await perm('employee', 'master',     true, false, false, false, false, false); // dropdowns
  // No access to anything else
  for (const mod of ['hr','payroll','finance','accounting','gst','tds','procurement',
                     'inventory','warehouse','production','bom','engineering','quality',
                     'projects','crm','sales','servicedesk','admin','company_profile',
                     'branches','settings','analytics','reports','recruitment','training']) {
    await perm('employee', mod, ...NONE);
  }

  // ── 5. Soft-delete column on branches ────────────────────────────────────────
  await db.query(`
    ALTER TABLE branches
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL
  `);

  console.log('[migration 20260529000001] Phase 42 roles & permission matrix seeded.');
}

export async function down(knex) {
  const db = knex.raw ? { query: (sql, b) => knex.raw(sql, b) } : knex;
  await db.query(`DELETE FROM role_permissions`);
  await db.query(`DELETE FROM roles WHERE code NOT IN ('super_admin','admin','manager','employee','hr')`);
}
