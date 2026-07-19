import pool from './src/config/db.js';
import bcrypt from 'bcryptjs';

async function createAdmins() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255),
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255),
      role VARCHAR(50) DEFAULT 'employee',
      department VARCHAR(255),
      is_active BOOLEAN DEFAULT true,
      employee_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const hash = await bcrypt.hash('password123', 10);

  const users = [
    ['Super Admin',      'superadmin@company.com', 'super_admin'],
    ['Admin',            'admin@company.com',      'super_admin'],
    ['HR Manager',       'hr@company.com',         'manager'],
    ['Finance Manager',  'finance@company.com',    'manager'],
    ['Manager',          'manager@company.com',    'manager'],
    ['Employee',         'employee@company.com',   'employee'],
    ['Pulse Admin',      'admin@pulse.com',        'super_admin'],
    ['John Employee',    'john@pulse.com',         'employee'],
  ];

  for (const [name, email, role] of users) {
    await pool.query(
      `INSERT INTO users (name, email, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (email) DO UPDATE
         SET password_hash = $3, role = $4, is_active = true`,
      [name, email, hash, role]
    );
    console.log(`✅ ${email} (${role})`);
  }

  console.log('\nLogin with: superadmin@company.com / password123');
  process.exit(0);
}

createAdmins().catch(e => { console.error('❌', e.message); process.exit(1); });
