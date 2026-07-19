-- ============================================================
-- Pulse ERP — Missing Tables Migration
-- Run this in pgAdmin or psql:
--   psql -U postgres -d Pulse -f missing-tables-migration.sql
-- ============================================================

-- ── Workflows (Operations module) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflows (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(200) NOT NULL,
  trigger_event VARCHAR(100) DEFAULT '',
  description   TEXT         DEFAULT '',
  steps         JSONB        DEFAULT '[]',
  active        BOOLEAN      DEFAULT TRUE,
  created_by    INTEGER      REFERENCES employees(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW()
);

-- ── Talent Pools ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS talent_pools (
  id             SERIAL PRIMARY KEY,
  pool_name      VARCHAR(100) NOT NULL,
  skill_category VARCHAR(100) DEFAULT '',
  description    TEXT         DEFAULT '',
  created_at     TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS talent_pool_candidates (
  id           SERIAL PRIMARY KEY,
  pool_id      INTEGER REFERENCES talent_pools(id) ON DELETE CASCADE,
  candidate_id INTEGER REFERENCES candidates(id) ON DELETE CASCADE,
  added_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(pool_id, candidate_id)
);

-- ── Recruitment Agencies ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recruitment_agencies (
  id           SERIAL PRIMARY KEY,
  agency_name  VARCHAR(150) NOT NULL,
  type         VARCHAR(50)  DEFAULT 'Permanent',
  city         VARCHAR(100) DEFAULT '',
  contact_name VARCHAR(100) DEFAULT '',
  phone        VARCHAR(30)  DEFAULT '',
  placements   INTEGER      DEFAULT 0,
  success_rate NUMERIC(5,2) DEFAULT 0,
  avg_fee      NUMERIC(5,2) DEFAULT 0,
  rating       NUMERIC(3,1) DEFAULT 0,
  status       VARCHAR(20)  DEFAULT 'Active',
  created_at   TIMESTAMPTZ  DEFAULT NOW()
);

-- ── Interview Questions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS interview_questions (
  id              SERIAL PRIMARY KEY,
  question        TEXT         NOT NULL,
  category        VARCHAR(100) DEFAULT 'General',
  difficulty      VARCHAR(20)  DEFAULT 'Medium',
  expected_answer TEXT         DEFAULT '',
  tags            TEXT         DEFAULT '',
  created_at      TIMESTAMPTZ  DEFAULT NOW()
);

-- ── HR Downloads ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_downloads (
  id          SERIAL PRIMARY KEY,
  title       VARCHAR(200) NOT NULL,
  category    VARCHAR(50)  DEFAULT 'General',
  description TEXT         DEFAULT '',
  file_url    TEXT         DEFAULT '#',
  downloads   INTEGER      DEFAULT 0,
  created_by  INTEGER      REFERENCES employees(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- ── HR Policies ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_policies (
  id          SERIAL PRIMARY KEY,
  title       VARCHAR(200) NOT NULL,
  category    VARCHAR(50)  DEFAULT 'General',
  description TEXT         DEFAULT '',
  file_url    TEXT         DEFAULT '#',
  created_by  INTEGER      REFERENCES employees(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- ── Employee Salary Columns (if missing) ──────────────────────────────────────
ALTER TABLE employees ADD COLUMN IF NOT EXISTS basic_salary  NUMERIC(12,2);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS hra           NUMERIC(12,2);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS allowances    NUMERIC(12,2);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS annual_ctc    NUMERIC(12,2);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS work_location VARCHAR(50);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS skill_level   VARCHAR(50);

-- ── Seed default leave types if table is empty ────────────────────────────────
INSERT INTO leave_types (name, days_allowed, carry_forward, applicable_gender)
SELECT * FROM (VALUES
  ('Casual Leave',    12, false, 'All'),
  ('Sick Leave',      10, false, 'All'),
  ('Earned Leave',    21, true,  'All'),
  ('Maternity Leave', 90, false, 'Female'),
  ('Paternity Leave', 15, false, 'Male'),
  ('Optional Holiday', 2, false, 'All')
) AS v(name, days_allowed, carry_forward, applicable_gender)
WHERE NOT EXISTS (SELECT 1 FROM leave_types LIMIT 1);

-- ── Seed sample interview questions if empty ──────────────────────────────────
INSERT INTO interview_questions (question, category, difficulty, expected_answer)
SELECT * FROM (VALUES
  ('Tell me about yourself and your experience.', 'General', 'Easy', 'Structured introduction covering experience, skills, and goals.'),
  ('What are your greatest strengths?', 'General', 'Easy', 'Specific strengths with examples from past work.'),
  ('Describe a challenging project you handled.', 'Behavioral', 'Medium', 'STAR method: Situation, Task, Action, Result.'),
  ('Where do you see yourself in 5 years?', 'General', 'Medium', 'Career goals aligned with company growth.'),
  ('Why do you want to work here?', 'General', 'Easy', 'Research on company, culture, and role alignment.'),
  ('Explain the difference between REST and GraphQL.', 'Technical', 'Medium', 'REST uses multiple endpoints; GraphQL uses a single endpoint with flexible queries.'),
  ('How do you handle tight deadlines?', 'Behavioral', 'Medium', 'Prioritization, communication, and time management strategies.')
) AS v(question, category, difficulty, expected_answer)
WHERE NOT EXISTS (SELECT 1 FROM interview_questions LIMIT 1);

-- ── Seed sample HR downloads if empty ────────────────────────────────────────
INSERT INTO hr_downloads (title, category, description, file_url)
SELECT * FROM (VALUES
  ('Employee Handbook 2026', 'Handbook', 'Complete guide for all employees', '#'),
  ('Leave Application Form', 'Forms', 'Standard leave request form', '#'),
  ('Expense Claim Template', 'Forms', 'Template for expense reimbursement', '#'),
  ('Code of Conduct Policy', 'Policy', 'Company code of conduct and ethics', '#'),
  ('Onboarding Checklist', 'Checklist', 'New employee onboarding steps', '#')
) AS v(title, category, description, file_url)
WHERE NOT EXISTS (SELECT 1 FROM hr_downloads LIMIT 1);

-- ── Seed sample HR policies if empty ─────────────────────────────────────────
INSERT INTO hr_policies (title, category, description)
SELECT * FROM (VALUES
  ('Leave Policy', 'Leave', 'Rules governing leave types, eligibility, and application process'),
  ('Travel & Expense Policy', 'Finance', 'Guidelines for business travel and expense reimbursement'),
  ('Anti-Harassment Policy', 'Compliance', 'Zero tolerance policy on workplace harassment'),
  ('Remote Work Policy', 'Work', 'Guidelines for working from home and hybrid arrangements'),
  ('Performance Review Policy', 'Performance', 'Annual and quarterly review process and rating criteria')
) AS v(title, category, description)
WHERE NOT EXISTS (SELECT 1 FROM hr_policies LIMIT 1);

-- ── Verify ────────────────────────────────────────────────────────────────────
SELECT 'workflows'           AS tbl, COUNT(*) FROM workflows
UNION ALL SELECT 'talent_pools',        COUNT(*) FROM talent_pools
UNION ALL SELECT 'recruitment_agencies',COUNT(*) FROM recruitment_agencies
UNION ALL SELECT 'interview_questions', COUNT(*) FROM interview_questions
UNION ALL SELECT 'hr_downloads',        COUNT(*) FROM hr_downloads
UNION ALL SELECT 'hr_policies',         COUNT(*) FROM hr_policies
UNION ALL SELECT 'leave_types',         COUNT(*) FROM leave_types;
