-- EVENTS TABLE
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  department VARCHAR(100),
  event_date DATE NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- RESOURCES/DOWNLOADS TABLE
CREATE TABLE IF NOT EXISTS downloads (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(100),
  file_url TEXT NOT NULL,
  updated_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT true
);

-- HOLIDAYS TABLE
CREATE TABLE IF NOT EXISTS holidays (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  date DATE NOT NULL,
  description TEXT
);

-- Update announcements table if needed
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS expiry_date DATE;
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

-- Update policies table if needed
ALTER TABLE policies ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';
ALTER TABLE policies ADD COLUMN IF NOT EXISTS category VARCHAR(100);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(date);
CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(is_active, expiry_date);
CREATE INDEX IF NOT EXISTS idx_policies_status ON policies(status);
