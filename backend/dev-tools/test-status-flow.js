import pool from "./src/config/db.js";

async function testStatusFlow() {
  try {
    console.log("=== Testing Status Update Flow ===\n");
    
    // 1. Get an employee
    const emp = await pool.query("SELECT id, first_name, status FROM employees WHERE id = 2");
    console.log("1. Current employee:", emp.rows[0]);
    
    // 2. Update status
    const newStatus = emp.rows[0].status === "Active" ? "Probation" : "Active";
    console.log(`\n2. Updating status to: ${newStatus}`);
    
    const updateResult = await pool.query(
      "UPDATE employees SET status = $1 WHERE id = $2 RETURNING id, first_name, status",
      [newStatus, emp.rows[0].id]
    );
    console.log("   Update result:", updateResult.rows[0]);
    
    // 3. Verify by fetching again
    const verify = await pool.query("SELECT id, first_name, status FROM employees WHERE id = $1", [emp.rows[0].id]);
    console.log("\n3. Verification fetch:", verify.rows[0]);
    
    // 4. Check if it persists
    console.log("\n4. Status persisted:", verify.rows[0].status === newStatus ? "✅ YES" : "❌ NO");
    
    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

testStatusFlow();
