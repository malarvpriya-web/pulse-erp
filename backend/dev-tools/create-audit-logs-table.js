import pool from "./src/config/db.js";

const createAuditLogsTable = async () => {
  try {
    await pool.query(`
      DROP TABLE IF EXISTS audit_logs CASCADE;
      
      CREATE TABLE audit_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        action VARCHAR(100),
        module VARCHAR(100),
        record_id INTEGER,
        old_data JSON,
        new_data JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
    `);
    
    console.log("✅ audit_logs table and index created successfully");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error creating table:", err);
    process.exit(1);
  }
};

createAuditLogsTable();
