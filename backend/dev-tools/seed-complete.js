/**
 * seed-complete.js  —  Run once to set up all users and master data
 * Usage:  node seed-complete.js
 */
import pool from './src/config/db.js';
import bcrypt from 'bcryptjs';

async function run() {
  console.log('🌱 Pulse ERP — Complete Seed Script');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Ensure users table has right shape ─────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        name          VARCHAR(255)        NOT NULL,
        email         VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255)        NOT NULL,
        role          VARCHAR(50)         DEFAULT 'employee',
        department    VARCHAR(100),
        is_active     BOOLEAN             DEFAULT true,
        employee_id   INTEGER,
        created_at    TIMESTAMPTZ         DEFAULT NOW()
      )
    `);

    // ── 2. Hash password (all demo users: Pulse@123) ──────────────────
    const pw = await bcrypt.hash('Pulse@123', 10);

    // ── 3. Insert demo users ──────────────────────────────────────────
    const users = [
      ['Super Admin',       'superadmin@pulse.com',  'super_admin',    'IT'],
      ['Admin User',        'admin@pulse.com',        'admin',          'HR'],
      ['HR Manager',        'hr@pulse.com',           'manager',        'HR'],
      ['Finance Manager',   'finance@pulse.com',      'manager',        'Finance'],
      ['Department Head',   'depthead@pulse.com',     'department_head','Engineering'],
      ['John Employee',     'john@pulse.com',         'employee',       'Engineering'],
      ['Jane Employee',     'jane@pulse.com',         'employee',       'Design'],
    ];

    for (const [name, email, role, dept] of users) {
      await client.query(
        `INSERT INTO users (name, email, password_hash, role, department, is_active)
         VALUES ($1,$2,$3,$4,$5,true)
         ON CONFLICT (email) DO UPDATE SET password_hash=$3, role=$4, is_active=true`,
        [name, email, pw, role, dept]
      );
    }
    console.log('✅ Users seeded — password for all: Pulse@123');

    // ── 4. Permissions table ──────────────────────────────────────────
    await client.query(`
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
      )
    `);

    // Give admin full permissions on all modules
    const modules = [
      'employees','finance','projects','reports','inventory',
      'announcements','policies','downloads','leave','travel',
      'service','crm','sales','recruitment','timesheets',
      'performance','procurement','attendance','audit',
    ];
    const adminUser = await client.query("SELECT id FROM users WHERE email='admin@pulse.com'");
    if (adminUser.rows.length) {
      const adminId = adminUser.rows[0].id;
      for (const mod of modules) {
        await client.query(
          `INSERT INTO permissions (user_id,module,can_view,can_add,can_edit,can_delete,can_approve,can_export)
           VALUES ($1,$2,true,true,true,true,true,true)
           ON CONFLICT (user_id,module) DO UPDATE
           SET can_view=true,can_add=true,can_edit=true,can_delete=true,can_approve=true,can_export=true`,
          [adminId, mod]
        );
      }
    }

    await client.query('COMMIT');
    console.log('✅ Permissions seeded for admin');
    console.log('\n🎉 LOGIN CREDENTIALS:');
    console.log('   superadmin@pulse.com  /  Pulse@123  (super_admin)');
    console.log('   admin@pulse.com       /  Pulse@123  (admin)');
    console.log('   hr@pulse.com          /  Pulse@123  (manager)');
    console.log('   john@pulse.com        /  Pulse@123  (employee)');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', err.message);
    throw err;
  } finally {
    client.release();
    process.exit(0);
  }
}

run();
