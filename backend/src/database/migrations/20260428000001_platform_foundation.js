/**
 * 20260428000001_platform_foundation.js
 *
 * Phase 1 – Foundation layer
 * Creates: companies, branches, master_values, permissions (user-level),
 *          roles, role_permissions, field_permissions, user_scope
 * Seeds:   default roles + role_permissions for 5 built-in role codes
 *
 * BACKWARD COMPAT: uses IF NOT EXISTS / ON CONFLICT everywhere.
 * The existing checkPermission() middleware references the `permissions`
 * table — that table is created here so the middleware works correctly.
 */

export async function up(knex) {

  // ── 1. Companies ─────────────────────────────────────────────────────────────
  await knex.raw(`
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

  // ── 2. Branches ───────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS branches (
      id         SERIAL PRIMARY KEY,
      company_id INTEGER      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name       VARCHAR(255) NOT NULL,
      code       VARCHAR(50),
      city       VARCHAR(100),
      is_active  BOOLEAN      DEFAULT TRUE,
      created_at TIMESTAMPTZ  DEFAULT NOW(),
      UNIQUE(company_id, code)
    )
  `);

  // ── 3. Master values (generic lookup / dropdown seed table) ───────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS master_values (
      id         SERIAL PRIMARY KEY,
      type       VARCHAR(100) NOT NULL,
      value      VARCHAR(255) NOT NULL,
      code       VARCHAR(100),
      parent_id  INTEGER      REFERENCES master_values(id) ON DELETE SET NULL,
      sort_order INTEGER      DEFAULT 0,
      is_active  BOOLEAN      DEFAULT TRUE,
      company_id INTEGER      REFERENCES companies(id) ON DELETE SET NULL,
      branch_id  INTEGER      REFERENCES branches(id)  ON DELETE SET NULL,
      created_at TIMESTAMPTZ  DEFAULT NOW(),
      UNIQUE(type, code, company_id)
    );

    CREATE INDEX IF NOT EXISTS idx_master_values_type       ON master_values(type);
    CREATE INDEX IF NOT EXISTS idx_master_values_company    ON master_values(company_id);
  `);

  // ── 4. User-level permissions (already expected by existing middleware) ────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS permissions (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      module       VARCHAR(100) NOT NULL,
      can_view     BOOLEAN      DEFAULT FALSE,
      can_add      BOOLEAN      DEFAULT FALSE,
      can_edit     BOOLEAN      DEFAULT FALSE,
      can_delete   BOOLEAN      DEFAULT FALSE,
      can_approve  BOOLEAN      DEFAULT FALSE,
      can_export   BOOLEAN      DEFAULT FALSE,
      created_at   TIMESTAMPTZ  DEFAULT NOW(),
      updated_at   TIMESTAMPTZ  DEFAULT NOW(),
      UNIQUE(user_id, module)
    );

    CREATE INDEX IF NOT EXISTS idx_permissions_user   ON permissions(user_id);
    CREATE INDEX IF NOT EXISTS idx_permissions_module ON permissions(module);
  `);

  // ── 5. Roles (role registry — code matches users.role string) ─────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS roles (
      id         SERIAL PRIMARY KEY,
      role_name  VARCHAR(100) NOT NULL,
      code       VARCHAR(50)  UNIQUE NOT NULL,
      is_active  BOOLEAN      DEFAULT TRUE,
      company_id INTEGER      REFERENCES companies(id) ON DELETE SET NULL,
      branch_id  INTEGER      REFERENCES branches(id)  ON DELETE SET NULL,
      created_at TIMESTAMPTZ  DEFAULT NOW()
    )
  `);

  // ── 6. Role-level permissions ─────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      id           SERIAL PRIMARY KEY,
      role_id      INTEGER      NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      module       VARCHAR(100) NOT NULL,
      can_view     BOOLEAN      DEFAULT FALSE,
      can_add      BOOLEAN      DEFAULT FALSE,
      can_edit     BOOLEAN      DEFAULT FALSE,
      can_delete   BOOLEAN      DEFAULT FALSE,
      can_approve  BOOLEAN      DEFAULT FALSE,
      can_export   BOOLEAN      DEFAULT FALSE,
      UNIQUE(role_id, module)
    );

    CREATE INDEX IF NOT EXISTS idx_role_perms_role   ON role_permissions(role_id);
    CREATE INDEX IF NOT EXISTS idx_role_perms_module ON role_permissions(module);
  `);

  // ── 7. Field-level permissions (hide/lock specific response fields per role) ──
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS field_permissions (
      id          SERIAL PRIMARY KEY,
      role_id     INTEGER      NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      module      VARCHAR(100) NOT NULL,
      field_name  VARCHAR(100) NOT NULL,
      is_visible  BOOLEAN      DEFAULT TRUE,
      is_editable BOOLEAN      DEFAULT TRUE,
      UNIQUE(role_id, module, field_name)
    )
  `);

  // ── 8. User scope (multi-company / branch mapping) ────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS user_scope (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      company_id INTEGER      REFERENCES companies(id) ON DELETE CASCADE,
      branch_id  INTEGER      REFERENCES branches(id)  ON DELETE SET NULL,
      is_primary BOOLEAN      DEFAULT FALSE,
      created_at TIMESTAMPTZ  DEFAULT NOW(),
      UNIQUE(user_id, company_id, branch_id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_scope_user ON user_scope(user_id);
  `);

  // ── 9. Seed default roles ─────────────────────────────────────────────────────
  await knex.raw(`
    INSERT INTO roles (role_name, code, is_active) VALUES
      ('Super Administrator', 'super_admin', true),
      ('Administrator',       'admin',       true),
      ('Manager',             'manager',     true),
      ('HR Manager',          'hr',          true),
      ('Employee',            'employee',    true)
    ON CONFLICT (code) DO NOTHING
  `);

  // ── 10. Seed default role_permissions ────────────────────────────────────────
  // Module list that covers all current ERP areas
  const MODULES = [
    'leaves','employees','projects','finance','payroll',
    'inventory','procurement','sales','crm','hr',
    'reports','admin','dashboard','announcements','notifications',
    'attendance','timesheets','performance','recruitment',
    'approvals','documents','audit',
  ];
  const modList = MODULES.map(m => `('${m}')`).join(',');

  // super_admin — all true
  await knex.raw(`
    INSERT INTO role_permissions
      (role_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
    SELECT r.id, m.module, true, true, true, true, true, true
    FROM roles r
    CROSS JOIN (VALUES ${modList}) AS m(module)
    WHERE r.code = 'super_admin'
    ON CONFLICT (role_id, module) DO NOTHING
  `);

  // admin — all true except can_delete = false for sensitive modules
  await knex.raw(`
    INSERT INTO role_permissions
      (role_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
    SELECT r.id, m.module, true, true, true,
      CASE WHEN m.module IN ('employees','payroll','finance','audit') THEN false ELSE true END,
      true, true
    FROM roles r
    CROSS JOIN (VALUES ${modList}) AS m(module)
    WHERE r.code = 'admin'
    ON CONFLICT (role_id, module) DO NOTHING
  `);

  // manager — no delete; limited write on sensitive modules
  await knex.raw(`
    INSERT INTO role_permissions
      (role_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
    SELECT r.id, m.module,
      true,
      CASE WHEN m.module IN ('employees','payroll','finance','audit','admin') THEN false ELSE true END,
      CASE WHEN m.module IN ('employees','payroll','finance','audit','admin') THEN false ELSE true END,
      false,
      CASE WHEN m.module IN ('leaves','timesheets','projects','procurement','attendance','approvals') THEN true ELSE false END,
      CASE WHEN m.module IN ('reports','dashboard','projects','sales') THEN true ELSE false END
    FROM roles r
    CROSS JOIN (VALUES ${modList}) AS m(module)
    WHERE r.code = 'manager'
    ON CONFLICT (role_id, module) DO NOTHING
  `);

  // hr — full access to hr modules; view-only for others
  await knex.raw(`
    INSERT INTO role_permissions
      (role_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
    SELECT r.id, m.module,
      CASE WHEN m.module IN ('admin') THEN false ELSE true END,
      CASE WHEN m.module IN ('employees','leaves','hr','attendance','payroll','performance','recruitment','timesheets','approvals','documents','announcements') THEN true ELSE false END,
      CASE WHEN m.module IN ('employees','leaves','hr','attendance','payroll','performance','recruitment','timesheets','approvals','documents','announcements') THEN true ELSE false END,
      CASE WHEN m.module IN ('employees','leaves','hr','attendance','performance','recruitment') THEN true ELSE false END,
      CASE WHEN m.module IN ('leaves','timesheets','attendance','performance','approvals') THEN true ELSE false END,
      CASE WHEN m.module IN ('employees','payroll','leaves','attendance','performance','recruitment','reports') THEN true ELSE false END
    FROM roles r
    CROSS JOIN (VALUES ${modList}) AS m(module)
    WHERE r.code = 'hr'
    ON CONFLICT (role_id, module) DO NOTHING
  `);

  // employee — view only for most; add/edit own leave + timesheet records
  await knex.raw(`
    INSERT INTO role_permissions
      (role_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
    SELECT r.id, m.module,
      CASE WHEN m.module IN ('admin','audit','payroll','recruitment','finance') THEN false ELSE true END,
      CASE WHEN m.module IN ('leaves','timesheets','approvals','documents') THEN true ELSE false END,
      CASE WHEN m.module IN ('leaves','timesheets') THEN true ELSE false END,
      false,
      false,
      false
    FROM roles r
    CROSS JOIN (VALUES ${modList}) AS m(module)
    WHERE r.code = 'employee'
    ON CONFLICT (role_id, module) DO NOTHING
  `);

  // ── 11. Sensitive field restrictions for employee role ────────────────────────
  await knex.raw(`
    INSERT INTO field_permissions (role_id, module, field_name, is_visible, is_editable)
    SELECT r.id, f.module, f.field_name, false, false
    FROM roles r
    CROSS JOIN (VALUES
      ('employees', 'pan_number'),
      ('employees', 'aadhaar_number'),
      ('employees', 'bank_name'),
      ('employees', 'account_number'),
      ('employees', 'ifsc_code'),
      ('employees', 'pf_number'),
      ('employees', 'uan_number'),
      ('employees', 'basic_salary'),
      ('payroll',   'net_pay'),
      ('payroll',   'gross')
    ) AS f(module, field_name)
    WHERE r.code = 'employee'
    ON CONFLICT (role_id, module, field_name) DO NOTHING
  `);

  // ── 12. Seed default master values ───────────────────────────────────────────
  await knex.raw(`
    INSERT INTO master_values (type, value, code, sort_order) VALUES
      -- Leave types
      ('LEAVE_TYPE', 'Annual Leave',        'ANNUAL',    1),
      ('LEAVE_TYPE', 'Sick Leave',          'SICK',      2),
      ('LEAVE_TYPE', 'Casual Leave',        'CASUAL',    3),
      ('LEAVE_TYPE', 'Compensatory Leave',  'COMP',      4),
      ('LEAVE_TYPE', 'Maternity Leave',     'MATERNITY', 5),
      ('LEAVE_TYPE', 'Paternity Leave',     'PATERNITY', 6),
      -- Employment types
      ('EMPLOYMENT_TYPE', 'Full Time',   'FT',       1),
      ('EMPLOYMENT_TYPE', 'Part Time',   'PT',       2),
      ('EMPLOYMENT_TYPE', 'Contract',    'CONTRACT', 3),
      ('EMPLOYMENT_TYPE', 'Intern',      'INTERN',   4),
      -- Priority levels
      ('PRIORITY', 'Critical', 'CRITICAL', 1),
      ('PRIORITY', 'High',     'HIGH',     2),
      ('PRIORITY', 'Medium',   'MEDIUM',   3),
      ('PRIORITY', 'Low',      'LOW',      4),
      -- Approval statuses
      ('APPROVAL_STATUS', 'Pending',   'PENDING',   1),
      ('APPROVAL_STATUS', 'Approved',  'APPROVED',  2),
      ('APPROVAL_STATUS', 'Rejected',  'REJECTED',  3),
      ('APPROVAL_STATUS', 'Cancelled', 'CANCELLED', 4)
    ON CONFLICT (type, code, company_id) DO NOTHING
  `);
}

export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS user_scope       CASCADE;
    DROP TABLE IF EXISTS field_permissions CASCADE;
    DROP TABLE IF EXISTS role_permissions  CASCADE;
    DROP TABLE IF EXISTS roles             CASCADE;
    DROP TABLE IF EXISTS permissions       CASCADE;
    DROP TABLE IF EXISTS master_values     CASCADE;
    DROP TABLE IF EXISTS branches          CASCADE;
    DROP TABLE IF EXISTS companies         CASCADE;
  `);
}
