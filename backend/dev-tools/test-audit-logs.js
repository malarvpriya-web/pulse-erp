import auditRepository from './src/modules/audit/repositories/audit.repository.js';
import pool from './src/config/db.js';

async function test() {
  try {
    console.log("Testing logCreate...");
    const result = await auditRepository.logCreate(
      1, // user_id
      'TestModule', // module_name
      100, // reference_id
      'TestRecord', // reference_type
      { status: "success", detail: "tested new schema" }, // new_data
      '127.0.0.1' // ip_address
    );
    console.log("✅ logCreate Success! Inserted Record:");
    console.log(result);
  } catch (err) {
    console.error("❌ logCreate failed:", err);
  } finally {
    await pool.end(); // close db connection
    process.exit(0);
  }
}

test();
