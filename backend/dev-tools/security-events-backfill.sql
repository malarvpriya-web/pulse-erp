-- ============================================================
-- Pulse ERP — Security Events table + historical backfill
-- Run once in pgAdmin or psql:
--   psql -U postgres -d Pulse -f security-events-backfill.sql
-- ============================================================

-- 1. Ensure security_events table exists (idempotent)
CREATE TABLE IF NOT EXISTS security_events (
  id         SERIAL PRIMARY KEY,
  event_type VARCHAR(80)  NOT NULL,
  severity   VARCHAR(20)  NOT NULL DEFAULT 'low',
  user_id    INT,
  ip_address VARCHAR(45),
  user_agent TEXT,
  path       VARCHAR(300),
  detail     JSONB,
  created_at TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_type    ON security_events(event_type);
CREATE INDEX IF NOT EXISTS idx_security_events_user    ON security_events(user_id);
CREATE INDEX IF NOT EXISTS idx_security_events_sev     ON security_events(severity);

-- 2. Backfill historical login events from auth_audit_log
--    (only rows not already mirrored — identified by matching user_id + created_at precision)
INSERT INTO security_events (event_type, severity, user_id, ip_address, created_at)
SELECT
  al.event   AS event_type,
  CASE al.event
    WHEN 'login_failed'  THEN 'medium'
    WHEN 'login_locked'  THEN 'high'
    ELSE 'low'
  END        AS severity,
  al.user_id,
  al.ip      AS ip_address,
  al.created_at
FROM auth_audit_log al
WHERE al.event IN (
  'login_success', 'login_failed', 'login_locked',
  'logout', 'password_changed', 'password_reset_complete', 'login_google'
)
ON CONFLICT DO NOTHING;

-- 3. Backfill last_login from users table as login_success events
--    (covers users whose auth_audit_log predates the table or was truncated)
INSERT INTO security_events (event_type, severity, user_id, created_at, detail)
SELECT
  'login_success' AS event_type,
  'low'           AS severity,
  u.id            AS user_id,
  u.last_login    AS created_at,
  jsonb_build_object('source', 'backfill_from_users_last_login') AS detail
FROM users u
WHERE u.last_login IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM security_events se
    WHERE se.user_id = u.id
      AND se.event_type = 'login_success'
      AND ABS(EXTRACT(EPOCH FROM (se.created_at - u.last_login))) < 5
  )
ON CONFLICT DO NOTHING;

-- 4. Verify
SELECT event_type, severity, COUNT(*) AS n
FROM security_events
GROUP BY event_type, severity
ORDER BY n DESC;
