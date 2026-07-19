import pool from './src/config/db.js';

async function addStatusColumn() {
  try {
    await pool.query(`
      ALTER TABLE employees 
      ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Probation'
    `);
    console.log('✅ Status column added successfully');
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    process.exit();
  }
}

addStatusColumn();
