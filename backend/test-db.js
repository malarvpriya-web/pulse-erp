import pool from "./src/config/db.js";

async function testDB() {
  try {
    const res = await pool.query("SELECT NOW()");
    console.log("✅ PostgreSQL Connected Successfully");
    console.log(res.rows);
  } catch (err) {
    console.error("❌ DB Connection Error:", err);
  }
}

testDB();