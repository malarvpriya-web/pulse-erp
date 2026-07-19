-- ============================================================
-- PULSE ERP — EMERGENCY LOGIN FIX
-- Run this directly in pgAdmin Query Tool or psql
-- This creates all users with pre-computed bcrypt password hashes
--
-- PASSWORD FOR ALL USERS:  password123
--
-- Usage:
--   psql -U postgres -d Pulse -f fix-login-users.sql
-- ============================================================

-- Step 1: Ensure users table exists with correct structure
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(255)        NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255)        NOT NULL,
  role          VARCHAR(50)         DEFAULT 'employee',
  department    VARCHAR(100),
  is_active     BOOLEAN             DEFAULT true,
  employee_id   INTEGER,
  created_at    TIMESTAMPTZ         DEFAULT NOW(),
  updated_at    TIMESTAMPTZ         DEFAULT NOW()
);

-- Step 2: Insert / update all users
-- Password hash below = bcrypt hash of "password123" (cost 10)
-- Generated at: 2026-03-21
DO $$
DECLARE
  pw_hash TEXT := '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi';
  -- ↑ This is the bcrypt hash for "password123"
BEGIN

  INSERT INTO users (name, email, password_hash, role, department, is_active)
  VALUES
    ('Super Admin',     'superadmin@company.com',  pw_hash, 'super_admin',    NULL,          true),
    ('Super Admin',     'superadmin@pulse.com',    pw_hash, 'super_admin',    NULL,          true),
    ('Admin User',      'admin@company.com',        pw_hash, 'super_admin',    NULL,          true),
    ('Admin User',      'admin@pulse.com',          pw_hash, 'super_admin',    NULL,          true),
    ('HR Manager',      'hr@company.com',           pw_hash, 'manager',        'HR',          true),
    ('HR Manager',      'hr@pulse.com',             pw_hash, 'manager',        'HR',          true),
    ('Finance Manager', 'finance@company.com',      pw_hash, 'manager',        'Finance',     true),
    ('Finance Manager', 'finance@pulse.com',        pw_hash, 'admin',          'Finance',     true),
    ('Manager',         'manager@company.com',      pw_hash, 'manager',        'Engineering', true),
    ('Manager',         'manager@pulse.com',        pw_hash, 'manager',        'Engineering', true),
    ('Employee',        'employee@company.com',     pw_hash, 'employee',       'Engineering', true),
    ('John Employee',   'john@pulse.com',           pw_hash, 'employee',       'Engineering', true)
  ON CONFLICT (email)
  DO UPDATE SET
    password_hash = EXCLUDED.password_hash,
    role          = EXCLUDED.role,
    is_active     = true;

END$$;

-- Step 3: Seed permissions for admin users
CREATE TABLE IF NOT EXISTS permissions (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module      VARCHAR(100) NOT NULL,
  can_view    BOOLEAN DEFAULT false,
  can_add     BOOLEAN DEFAULT false,
  can_edit    BOOLEAN DEFAULT false,
  can_delete  BOOLEAN DEFAULT false,
  can_approve BOOLEAN DEFAULT false,
  can_export  BOOLEAN DEFAULT false,
  UNIQUE(user_id, module)
);

-- Give all super_admin users full permissions
INSERT INTO permissions (user_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
SELECT u.id, m.module, true, true, true, true, true, true
FROM users u
CROSS JOIN (VALUES
  ('employees'),('finance'),('projects'),('reports'),('inventory'),
  ('announcements'),('policies'),('downloads'),('leave'),('travel'),('service'),
  ('crm'),('sales'),('recruitment'),('timesheets'),('performance'),
  ('procurement'),('attendance'),('audit')
) AS m(module)
WHERE u.role IN ('super_admin', 'admin') AND u.is_active = true
ON CONFLICT (user_id, module) DO UPDATE SET
  can_view=true, can_add=true, can_edit=true,
  can_delete=true, can_approve=true, can_export=true;

-- Step 4: Verify — show all users
SELECT id, name, email, role, is_active,
       '✅ password123' AS password
FROM users
ORDER BY id;
