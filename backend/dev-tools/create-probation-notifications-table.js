import pool from './src/config/db.js';

async function createProbationNotificationsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS probation_notifications (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER REFERENCES employees(id),
        notified_to VARCHAR(255),
        notified_role VARCHAR(50),
        status VARCHAR(50) DEFAULT 'pending',
        decision VARCHAR(50),
        performance_rating INTEGER,
        comments TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        decided_at TIMESTAMP
      )
    `);
    console.log('✅ probation_notifications table created successfully');
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    process.exit();
  }
}

createProbationNotificationsTable();
