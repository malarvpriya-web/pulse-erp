import pool from "./src/config/db.js";

async function addMaritalStatus() {
  try {
    await pool.query(`
      ALTER TABLE employees 
      ADD COLUMN IF NOT EXISTS marital_status VARCHAR(20)
    `);
    console.log("✅ marital_status column added successfully");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

addMaritalStatus();
