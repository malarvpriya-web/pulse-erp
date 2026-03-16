import pool from "./src/config/db.js";

async function cleanupColumns() {
  try {
    // Drop employee_code and emp_id columns, keep only office_id
    await pool.query("ALTER TABLE employees DROP COLUMN IF EXISTS employee_code");
    console.log("✅ Dropped employee_code column");
    
    await pool.query("ALTER TABLE employees DROP COLUMN IF EXISTS emp_id");
    console.log("✅ Dropped emp_id column");
    
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

cleanupColumns();
