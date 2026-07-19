import pool from "./src/config/db.js";

async function testStatusUpdate() {
  try {
    // Get first employee
    const result = await pool.query("SELECT id, first_name, status FROM employees LIMIT 1");
    if (result.rows.length === 0) {
      console.log("No employees found");
      return;
    }
    
    const emp = result.rows[0];
    console.log("Testing with employee:", emp);
    
    // Try to update status
    const newStatus = emp.status === "Active" ? "Probation" : "Active";
    console.log(`Updating status from ${emp.status} to ${newStatus}`);
    
    const updateResult = await pool.query(
      "UPDATE employees SET status = $1 WHERE id = $2 RETURNING *",
      [newStatus, emp.id]
    );
    
    console.log("Update successful:", updateResult.rows[0].status);
    
    // Verify
    const verifyResult = await pool.query("SELECT status FROM employees WHERE id = $1", [emp.id]);
    console.log("Verified status:", verifyResult.rows[0].status);
    
    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

testStatusUpdate();
