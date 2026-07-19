import pool from "./src/config/db.js";

const migrateAuditLogsTable = async () => {
  try {
    // 1. Check if audit_logs table exists and back it up
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'audit_logs') THEN
          -- Drop backup if it already exists to avoid errors on multiple runs
          DROP TABLE IF EXISTS audit_logs_backup CASCADE;
          
          -- Rename the table
          ALTER TABLE audit_logs RENAME TO audit_logs_backup;
          
          -- Rename known indexes to avoid name conflicts when recreating
          ALTER INDEX IF EXISTS idx_audit_logs_user RENAME TO idx_audit_logs_user_backup;
          ALTER INDEX IF EXISTS idx_audit_logs_module RENAME TO idx_audit_logs_module_backup;
          ALTER INDEX IF EXISTS idx_audit_logs_action RENAME TO idx_audit_logs_action_backup;
          ALTER INDEX IF EXISTS idx_audit_logs_user_id RENAME TO idx_audit_logs_user_id_backup;
          
        END IF;
      END $$;
    `);

    // 2. Create the new audit_logs table using the v2 schema
    await pool.query(`
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
    
    // 3. Create the necessary indexes
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_module ON audit_logs(module_name);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action_type);`);
    
    console.log("✅ Successfully backed up existing audit_logs to audit_logs_backup (if existed) and created new audit_logs table.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error migrating table:", err);
    process.exit(1);
  }
};

migrateAuditLogsTable();
