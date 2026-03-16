import pool from './src/config/db.js';
import bcrypt from 'bcryptjs';

async function seed() {
  console.log('🌱 Seeding database...');

  // Users
  const hash = await bcrypt.hash('password123', 10);
  await pool.query(`
    INSERT INTO users (name, email, password_hash, role, department, is_active)
    VALUES
      ('Super Admin',    'admin@pulse.com',   '${hash}', 'super_admin', 'Management', true),
      ('Finance Manager','finance@pulse.com', '${hash}', 'manager',     'Finance',    true),
      ('HR Manager',     'hr@pulse.com',      '${hash}', 'manager',     'HR',         true),
      ('John Employee',  'john@pulse.com',    '${hash}', 'employee',    'Finance',    true),
      ('Sara Employee',  'sara@pulse.com',    '${hash}', 'employee',    'HR',         true)
    ON CONFLICT (email) DO NOTHING
  `).catch(e => console.log('Users:', e.message));

  // Employees
  await pool.query(`
    INSERT INTO employees (first_name, last_name, company_email, department, designation, joining_date, employment_type, status)
    VALUES
      ('Arjun',   'Kumar',   'arjun@pulse.com',   'Engineering', 'Senior Developer',  '2023-01-15', 'Full-time', 'Active'),
      ('Priya',   'Sharma',  'priya@pulse.com',   'Finance',     'Finance Analyst',   '2023-03-20', 'Full-time', 'Active'),
      ('Ravi',    'Patel',   'ravi@pulse.com',    'HR',          'HR Executive',      '2023-02-10', 'Full-time', 'Active'),
      ('Anitha',  'Reddy',   'anitha@pulse.com',  'Sales',       'Sales Manager',     '2022-11-05', 'Full-time', 'Active'),
      ('Vikram',  'Nair',    'vikram@pulse.com',  'Engineering', 'Frontend Dev',      '2024-01-08', 'Full-time', 'Active'),
      ('Deepa',   'Menon',   'deepa@pulse.com',   'Marketing',   'Marketing Lead',    '2023-06-15', 'Full-time', 'Active'),
      ('Suresh',  'Rao',     'suresh@pulse.com',  'Operations',  'Ops Manager',       '2022-08-20', 'Full-time', 'Active'),
      ('Kavitha', 'Singh',   'kavitha@pulse.com', 'Finance',     'Accountant',        '2024-02-01', 'Full-time', 'Active'),
      ('Mohan',   'Das',     'mohan@pulse.com',   'Engineering', 'Backend Dev',       '2023-09-12', 'Full-time', 'Active'),
      ('Lakshmi', 'Iyer',    'lakshmi@pulse.com', 'HR',          'HR Manager',        '2022-05-18', 'Full-time', 'Active')
    ON CONFLICT (company_email) DO NOTHING
  `).catch(e => console.log('Employees:', e.message));

  // Leaves
  await pool.query(`
    INSERT INTO leaves (employee_email, leave_type, start_date, end_date, status, reason)
    VALUES
      ('arjun@pulse.com',   'Annual',  '2026-03-20', '2026-03-22', 'pending',  'Family function'),
      ('priya@pulse.com',   'Sick',    '2026-03-15', '2026-03-15', 'pending',  'Not feeling well'),
      ('ravi@pulse.com',    'Annual',  '2026-03-25', '2026-03-28', 'pending',  'Vacation'),
      ('vikram@pulse.com',  'Casual',  '2026-03-18', '2026-03-18', 'approved', 'Personal work'),
      ('deepa@pulse.com',   'Sick',    '2026-03-10', '2026-03-11', 'approved', 'Fever'),
      ('suresh@pulse.com',  'Annual',  '2026-04-01', '2026-04-05', 'pending',  'Annual leave'),
      ('kavitha@pulse.com', 'Casual',  '2026-03-17', '2026-03-17', 'rejected', 'Personal')
    ON CONFLICT DO NOTHING
  `).catch(e => console.log('Leaves:', e.message));

  // Invoices
  await pool.query(`
    INSERT INTO invoices (invoice_number, party_name, total_amount, status, due_date, created_at)
    VALUES
      ('INV-001', 'TechCorp Ltd',      125000, 'paid',    '2026-02-28', '2026-01-15'),
      ('INV-002', 'Global Services',    87500, 'paid',    '2026-02-15', '2026-01-20'),
      ('INV-003', 'Alpha Solutions',   145000, 'pending', '2026-03-30', '2026-02-10'),
      ('INV-004', 'Beta Systems',       62000, 'pending', '2026-03-25', '2026-02-18'),
      ('INV-005', 'Gamma Corp',         93000, 'overdue', '2026-03-01', '2026-02-01'),
      ('INV-006', 'Delta Industries',  110000, 'paid',    '2026-03-10', '2026-02-20'),
      ('INV-007', 'Epsilon Tech',       78000, 'pending', '2026-04-05', '2026-03-01'),
      ('INV-008', 'Zeta Partners',     156000, 'paid',    '2026-03-05', '2026-02-05'),
      ('INV-009', 'Eta Enterprises',    44000, 'overdue', '2026-02-20', '2026-01-25'),
      ('INV-010', 'Theta Group',        98000, 'pending', '2026-04-10', '2026-03-08'),
      ('INV-011', 'Iota Corp',          73000, 'paid',    '2026-03-12', '2026-02-12'),
      ('INV-012', 'Kappa Ltd',         134000, 'paid',    '2026-03-20', '2026-02-20')
    ON CONFLICT DO NOTHING
  `).catch(e => console.log('Invoices:', e.message));

  // Expense claims
  await pool.query(`
    INSERT INTO expense_claims (claim_number, employee_email, category, amount, status, description, created_at)
    VALUES
      ('EXP-001', 'arjun@pulse.com',   'Travel',     4500,  'approved', 'Client visit Chennai',   '2026-03-01'),
      ('EXP-002', 'priya@pulse.com',   'IT',         12000, 'pending',  'Software license',       '2026-03-05'),
      ('EXP-003', 'deepa@pulse.com',   'Marketing',  35000, 'approved', 'Campaign materials',     '2026-03-08'),
      ('EXP-004', 'vikram@pulse.com',  'Travel',     8200,  'pending',  'Conference Bangalore',   '2026-03-10'),
      ('EXP-005', 'suresh@pulse.com',  'Operations', 22000, 'approved', 'Office supplies',        '2026-03-12'),
      ('EXP-006', 'kavitha@pulse.com', 'Training',   15000, 'pending',  'Accounting workshop',    '2026-03-14'),
      ('EXP-007', 'mohan@pulse.com',   'IT',         9800,  'approved', 'Dev tools subscription', '2026-03-02'),
      ('EXP-008', 'ravi@pulse.com',    'Travel',     3200,  'approved', 'Office commute',         '2026-03-06')
    ON CONFLICT DO NOTHING
  `).catch(e => console.log('Expenses:', e.message));

  console.log('✅ Seed complete! Login with admin@pulse.com / password123');
  process.exit(0);
}

seed().catch(e => { console.error('❌ Seed failed:', e.message); process.exit(1); });