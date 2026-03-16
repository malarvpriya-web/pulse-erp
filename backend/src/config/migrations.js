import pool from './db.js';

export const runMigrations = async () => {
  console.log('🔄 Running database migrations...');
  
  try {
    // Add missing employee columns
    const migrations = [
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS company_phone VARCHAR(20)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS employee_role VARCHAR(50)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS marital_status VARCHAR(20)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS father_name VARCHAR(100)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS mother_name VARCHAR(100)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS spouse_name VARCHAR(100)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS anniversary_date DATE',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS current_address TEXT',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS permanent_address TEXT',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS highest_qualification VARCHAR(50)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS basic_qualification VARCHAR(50)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS reporting_manager VARCHAR(100)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS location VARCHAR(100)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS employment_type VARCHAR(50)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS skill_type VARCHAR(50)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS zone VARCHAR(50)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS previous_company_1 VARCHAR(200)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS previous_role_1 VARCHAR(100)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS previous_years_1 INTEGER',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS previous_company_2 VARCHAR(200)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS previous_role_2 VARCHAR(100)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS previous_years_2 INTEGER',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS branch_name VARCHAR(100)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS account_number VARCHAR(50)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS ifsc_code VARCHAR(20)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS nominee_name VARCHAR(100)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS emergency_name VARCHAR(100)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS emergency_phone VARCHAR(20)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS emergency_relationship VARCHAR(50)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS pan_number VARCHAR(20)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS aadhaar_number VARCHAR(20)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS pf_number VARCHAR(50)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS uan_number VARCHAR(50)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS esic_number VARCHAR(50)',
      'ALTER TABLE employees ADD COLUMN IF NOT EXISTS notes TEXT'
    ];

    for (const migration of migrations) {
      await pool.query(migration);
    }

    console.log('✅ Database migrations completed successfully');
  } catch (error) {
    console.error('❌ Migration error:', error.message);
  }
};
