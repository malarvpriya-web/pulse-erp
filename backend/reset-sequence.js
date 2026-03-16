import pool from "./src/config/db.js";

async function resetSequence() {
  try {
    // Reset the ID sequence to 1
    await pool.query("ALTER SEQUENCE employees_id_seq RESTART WITH 1");
    console.log("✅ ID sequence reset to 1");
    
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

resetSequence();
