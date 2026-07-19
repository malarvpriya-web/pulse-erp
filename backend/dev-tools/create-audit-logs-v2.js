import pool from "./src/config/db.js";

const createAuditLogsTable = async () => {
  try {
    await pool.query(`
      DROP TABLE IF EXISTS audit_logs CASCADE;
      
      CREATE TABLE audit_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        module_name VARCHAR(100) NOT NULL,
        action_type VARCHAR(50),
        reference_id INTEGER,
        reference_type VARCHAR(100),
        old_data_json JSONB,
        new_data_json JSONB,
        ip_address VARCHAR(50),
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_module ON audit_logs(module_name);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action_type);`);
    
    console.log("✅ audit_logs table recreated to match repository!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error creating table:", err);
    process.exit(1);
  }
};

createAuditLogsTable();
