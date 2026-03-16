import pool from "./src/config/db.js";

async function setupLeaves() {
  try {
    console.log("📝 Setting up leaves table...");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS leaves (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        leave_type VARCHAR(50) NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        days DECIMAL(4,1) NOT NULL,
        reason TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        manager_comment TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("✅ Leaves table created");

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_leaves_employee_id ON leaves(employee_id);
      CREATE INDEX IF NOT EXISTS idx_leaves_status ON leaves(status);
      CREATE INDEX IF NOT EXISTS idx_leaves_dates ON leaves(start_date, end_date);
    `);
    console.log("✅ Indexes created");

    await pool.query(`
      CREATE OR REPLACE FUNCTION update_leaves_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await pool.query(`
      DROP TRIGGER IF EXISTS leaves_updated_at_trigger ON leaves;
      CREATE TRIGGER leaves_updated_at_trigger
      BEFORE UPDATE ON leaves
      FOR EACH ROW
      EXECUTE FUNCTION update_leaves_updated_at();
    `);
    console.log("✅ Trigger created");

    console.log("\n🎉 Leaves table setup complete!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

setupLeaves();
