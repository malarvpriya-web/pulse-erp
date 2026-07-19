-- ============================================================
-- Pulse ERP — Projects & Tasks Fix Migration
-- Run this in pgAdmin Query Tool or psql:
--   psql -U postgres -d Pulse -f projects-fix-migration.sql
--
-- Fixes: original schema used UUID FKs referencing employees(id)
-- which is SERIAL (INTEGER), causing table creation to fail.
-- ============================================================

-- Drop old tables if they exist with wrong types (safe order)
DROP TABLE IF EXISTS project_milestones CASCADE;
DROP TABLE IF EXISTS project_team_members CASCADE;
DROP TABLE IF EXISTS tasks CASCADE;
DROP TABLE IF EXISTS projects CASCADE;

-- ── Projects ──────────────────────────────────────────────────────────────
CREATE TABLE projects (
    id              SERIAL PRIMARY KEY,
    project_code    VARCHAR(50) UNIQUE NOT NULL,
    project_name    VARCHAR(255) NOT NULL,
    customer_name   VARCHAR(255),
    start_date      DATE NOT NULL DEFAULT CURRENT_DATE,
    end_date        DATE,
    project_manager_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    status          VARCHAR(20) DEFAULT 'planning'
                    CHECK (status IN ('planning', 'active', 'on_hold', 'completed', 'cancelled')),
    budget_amount   DECIMAL(15,2) DEFAULT 0,
    actual_cost     DECIMAL(15,2) DEFAULT 0,
    description     TEXT,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by      INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    deleted_at      TIMESTAMP
);

CREATE INDEX idx_projects_manager ON projects(project_manager_id);
CREATE INDEX idx_projects_status  ON projects(status);
CREATE INDEX idx_projects_code    ON projects(project_code);

-- ── Tasks ─────────────────────────────────────────────────────────────────
CREATE TABLE tasks (
    id               SERIAL PRIMARY KEY,
    project_id       INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    task_title       VARCHAR(255) NOT NULL,
    task_description TEXT,
    assigned_to      INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    assignment_type  VARCHAR(50) DEFAULT 'all_employees'
                     CHECK (assignment_type IN ('all_employees', 'managers', 'individual')),
    priority         VARCHAR(20) DEFAULT 'medium'
                     CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    status           VARCHAR(20) DEFAULT 'todo'
                     CHECK (status IN ('todo', 'in_progress', 'review', 'done', 'blocked')),
    start_date       DATE,
    due_date         DATE,
    estimated_hours  DECIMAL(8,2),
    actual_hours     DECIMAL(8,2) DEFAULT 0,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by       INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    deleted_at       TIMESTAMP
);

CREATE INDEX idx_tasks_project  ON tasks(project_id);
CREATE INDEX idx_tasks_assigned ON tasks(assigned_to);
CREATE INDEX idx_tasks_status   ON tasks(status);
CREATE INDEX idx_tasks_due_date ON tasks(due_date);
