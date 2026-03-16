import pool from "./src/config/db.js";

async function setupHomePortal() {
  try {
    console.log("🏠 Setting up Home Portal tables...");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        department VARCHAR(100),
        event_date DATE NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("✅ Events table created");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS downloads (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        category VARCHAR(100),
        file_url TEXT NOT NULL,
        updated_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT true
      );
    `);
    console.log("✅ Downloads table created");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS holidays (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        date DATE NOT NULL,
        description TEXT
      );
    `);
    console.log("✅ Holidays table created");

    await pool.query(`
      ALTER TABLE announcements 
      ADD COLUMN IF NOT EXISTS expiry_date DATE,
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
    `);
    console.log("✅ Announcements table updated");

    await pool.query(`
      ALTER TABLE policies 
      ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active',
      ADD COLUMN IF NOT EXISTS category VARCHAR(100);
    `);
    console.log("✅ Policies table updated");

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
      CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(date);
      CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(is_active, expiry_date);
      CREATE INDEX IF NOT EXISTS idx_policies_status ON policies(status);
    `);
    console.log("✅ Indexes created");

    await pool.query(`
      INSERT INTO events (title, department, event_date, description) VALUES
      ('Q1 Town Hall', 'All', CURRENT_DATE + INTERVAL '5 days', 'Quarterly business review and updates'),
      ('Fire Safety Training', 'Operations', CURRENT_DATE + INTERVAL '10 days', 'Mandatory safety training for all staff'),
      ('Team Building Activity', 'HR', CURRENT_DATE + INTERVAL '15 days', 'Outdoor team building event'),
      ('Product Launch', 'Sales', CURRENT_DATE + INTERVAL '20 days', 'New product line launch event')
      ON CONFLICT DO NOTHING;
    `);
    console.log("✅ Sample events created");

    await pool.query(`
      INSERT INTO holidays (name, date, description) VALUES
      ('New Year', '2026-01-01', 'New Year Day'),
      ('Republic Day', '2026-01-26', 'Republic Day of India'),
      ('Holi', '2026-03-14', 'Festival of Colors'),
      ('Good Friday', '2026-04-03', 'Good Friday'),
      ('Independence Day', '2026-08-15', 'Independence Day of India'),
      ('Gandhi Jayanti', '2026-10-02', 'Birth anniversary of Mahatma Gandhi'),
      ('Diwali', '2026-10-19', 'Festival of Lights'),
      ('Christmas', '2026-12-25', 'Christmas Day')
      ON CONFLICT DO NOTHING;
    `);
    console.log("✅ Sample holidays created");

    console.log("\n🎉 Home Portal setup complete!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

setupHomePortal();
