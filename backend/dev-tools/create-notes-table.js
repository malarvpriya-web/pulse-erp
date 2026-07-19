import pool from "./src/config/db.js";

const createHrNotesTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hr_notes (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
        note_text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("✅ hr_notes table created successfully");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error creating table:", err);
    process.exit(1);
  }
};

createHrNotesTable();
