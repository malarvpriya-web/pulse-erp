-- ============================================================
-- Pulse ERP — Admin Setup Tables Migration
-- Run: psql -U postgres -d Pulse -f admin-setup-tables-migration.sql
-- ============================================================

-- ── Products ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id           SERIAL       PRIMARY KEY,
  product_name VARCHAR(200) NOT NULL,
  description  TEXT         DEFAULT '',
  is_active    BOOLEAN      DEFAULT TRUE,
  created_at   TIMESTAMPTZ  DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  DEFAULT NOW()
);
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_active   BOOLEAN     DEFAULT TRUE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ DEFAULT NOW();

-- ── Document Types ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_types (
  id          SERIAL       PRIMARY KEY,
  doc_type    VARCHAR(100) NOT NULL,
  doc_name    VARCHAR(200) NOT NULL,
  max_size_mb NUMERIC(6,2) DEFAULT 10,
  is_active   BOOLEAN      DEFAULT TRUE,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

-- ── Status Values — REMOVED 2026-07-16 ────────────────────────────────────────
-- `status_values` backed the Status Setup screen, which had zero readers: every
-- module hardcodes its own status list. Dropped by migration
-- 20260716000010_drop_status_values.js. Do not recreate it here.

-- ── Approver Config ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approver_config (
  id             SERIAL       PRIMARY KEY,
  module         VARCHAR(100) NOT NULL,
  approver_role  VARCHAR(100) NOT NULL,
  approver_email VARCHAR(255) DEFAULT '',
  sequence       INTEGER      DEFAULT 1,
  is_active      BOOLEAN      DEFAULT TRUE,
  created_at     TIMESTAMPTZ  DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  DEFAULT NOW()
);

-- ── Notification Rules (already created by system-intelligence-migration) ─────
CREATE TABLE IF NOT EXISTS notification_rules (
  id           SERIAL       PRIMARY KEY,
  event_name   VARCHAR(200) NOT NULL,
  module       VARCHAR(100) NOT NULL,
  trigger_role VARCHAR(100) DEFAULT '',
  notify_role  VARCHAR(100) DEFAULT '',
  notify_self  BOOLEAN      DEFAULT TRUE,
  channel      TEXT[]       DEFAULT ARRAY['app'],
  template     TEXT         DEFAULT '',
  is_active    BOOLEAN      DEFAULT TRUE,
  created_at   TIMESTAMPTZ  DEFAULT NOW()
);

-- ── Verify ────────────────────────────────────────────────────────────────────
SELECT tablename AS "Table"
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('products','document_types','approver_config','notification_rules')
ORDER BY tablename;
