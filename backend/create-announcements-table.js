import pool from "./src/config/db.js";

const createAnnouncementsTable = async () => {
  try {
    await pool.query(`
      DROP TABLE IF EXISTS announcements;
      CREATE TABLE announcements (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        from_date TIMESTAMP NOT NULL,
        to_date TIMESTAMP NOT NULL,
        target_type VARCHAR(50) DEFAULT 'all',
        target_value VARCHAR(255),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("✅ announcements table created successfully");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error creating table:", err);
    process.exit(1);
  }
};

createAnnouncementsTable();
