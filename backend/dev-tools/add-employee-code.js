import pool from "./src/config/db.js";

async function addEmployeeCodeColumn() {
  try {
    await pool.query(`
      ALTER TABLE employees 
      ADD COLUMN IF NOT EXISTS employee_code VARCHAR(20) UNIQUE;
    `);
    console.log("✅ employee_code column added");

    // Update existing employees with codes
    const employees = await pool.query("SELECT id FROM employees ORDER BY id");
    for (let i = 0; i < employees.rows.length; i++) {
      const code = `EMP${String(i + 1).padStart(3, "0")}`;
      await pool.query("UPDATE employees SET employee_code = $1 WHERE id = $2", [code, employees.rows[i].id]);
    }
    console.log(`✅ Updated ${employees.rows.length} employees with codes`);

    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

addEmployeeCodeColumn();
