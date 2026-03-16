import pool from "./src/config/db.js";

async function testStatus() {
  try {
    // Check if status column exists
    const colCheck = await pool.query(`
      SELECT column_name, data_type, column_default 
      FROM information_schema.columns 
      WHERE table_name = 'employees' AND column_name = 'status'
    `);
    console.log("Status column info:", colCheck.rows);
    
    // Get first employee
    const emp = await pool.query("SELECT id, first_name, status FROM employees LIMIT 1");
    if (emp.rows.length > 0) {
      console.log("\nCurrent employee:", emp.rows[0]);
      
      // Try update
      const newStatus = emp.rows[0].status === "Active" ? "Probation" : "Active";
      console.log(`\nUpdating to: ${newStatus}`);
      
      const result = await pool.query(
        "UPDATE employees SET status = $1 WHERE id = $2 RETURNING id, first_name, status",
        [newStatus, emp.rows[0].id]
      );
      console.log("After update:", result.rows[0]);
    }
    
    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

testStatus();
