import pool from "./src/config/db.js";

async function testNotes() {
  try {
    const result = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'employees' AND column_name = 'notes';
    `);
    
    console.log("Notes column:", result.rows);
    
    // Test insert with notes
    const testInsert = await pool.query(`
      INSERT INTO employees (office_id, first_name, last_name, company_email, notes)
      VALUES ('TEST001', 'Test', 'User', 'test@test.com', 'This is a test note')
      RETURNING id, notes;
    `);
    
    console.log("Test insert result:", testInsert.rows[0]);
    
    // Delete test record
    await pool.query("DELETE FROM employees WHERE office_id = 'TEST001'");
    console.log("Test record deleted");
    
    process.exit(0);
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

testNotes();
