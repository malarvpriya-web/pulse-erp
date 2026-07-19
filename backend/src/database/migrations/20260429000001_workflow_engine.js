/**
 * 20260429000001_workflow_engine.js
 *
 * Phase 2 — Workflow Engine
 * Creates: workflows, workflow_steps, workflow_transitions,
 *          workflow_instances, workflow_instance_steps
 * Seeds:   default Leave Approval workflow (2-step: manager → HR)
 *
 * BACKWARD COMPAT: IF NOT EXISTS / ON CONFLICT everywhere.
 * Existing workflow_rules + workflow_executions tables are NOT touched.
 */

export async function up(knex) {

  // ── 1. Workflow definitions (templates) ──────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS workflows (
      id            SERIAL PRIMARY KEY,
      name          VARCHAR(200) NOT NULL,
      code          VARCHAR(100) UNIQUE NOT NULL,
      module        VARCHAR(100) NOT NULL,
      trigger_event VARCHAR(100) NOT NULL DEFAULT 'on_submit',
      is_active     BOOLEAN      DEFAULT TRUE,
      company_id    INTEGER      REFERENCES companies(id) ON DELETE SET NULL,
      description   TEXT,
      created_at    TIMESTAMPTZ  DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_workflows_module ON workflows(module);
    CREATE INDEX IF NOT EXISTS idx_workflows_active ON workflows(module, is_active);
  `);

  // ── 2. Workflow steps ────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS workflow_steps (
      id             SERIAL PRIMARY KEY,
      workflow_id    INTEGER      NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      step_code      VARCHAR(100) NOT NULL,
      step_name      VARCHAR(200) NOT NULL,
      step_type      VARCHAR(50)  DEFAULT 'approval',
      assignee_role  VARCHAR(50),
      sequence_order INTEGER      DEFAULT 1,
      is_initial     BOOLEAN      DEFAULT FALSE,
      is_terminal    BOOLEAN      DEFAULT FALSE,
      sla_hours      INTEGER,
      created_at     TIMESTAMPTZ  DEFAULT NOW(),
      UNIQUE(workflow_id, step_code)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_steps_wf ON workflow_steps(workflow_id);
  `);
  // Add missing columns if the table pre-existed without them
  await knex.raw(`ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS step_code      VARCHAR(100)`);
  await knex.raw(`ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS assignee_role  VARCHAR(50)`);
  await knex.raw(`ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS sequence_order INTEGER DEFAULT 1`);
  await knex.raw(`ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS is_initial     BOOLEAN DEFAULT FALSE`);
  await knex.raw(`ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS is_terminal    BOOLEAN DEFAULT FALSE`);
  await knex.raw(`ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS sla_hours      INTEGER`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'workflow_steps_workflow_id_step_code_key'
      ) THEN
        ALTER TABLE workflow_steps ADD CONSTRAINT workflow_steps_workflow_id_step_code_key UNIQUE (workflow_id, step_code);
      END IF;
    END $$
  `);

  // ── 3. Workflow transitions (edges between steps) ─────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS workflow_transitions (
      id            SERIAL PRIMARY KEY,
      workflow_id   INTEGER      NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      from_step_id  INTEGER      NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
      to_step_id    INTEGER      REFERENCES workflow_steps(id) ON DELETE SET NULL,
      action        VARCHAR(50)  NOT NULL,
      outcome       VARCHAR(50)  DEFAULT 'in_progress',
      condition_expr JSONB,
      created_at    TIMESTAMPTZ  DEFAULT NOW(),
      UNIQUE(from_step_id, action)
    );
    CREATE INDEX IF NOT EXISTS idx_wf_trans_from ON workflow_transitions(from_step_id);
    CREATE INDEX IF NOT EXISTS idx_wf_trans_wf   ON workflow_transitions(workflow_id);
  `);
  // Add missing columns if the table pre-existed without them
  await knex.raw(`ALTER TABLE workflow_transitions ADD COLUMN IF NOT EXISTS action         VARCHAR(50)`);
  await knex.raw(`ALTER TABLE workflow_transitions ADD COLUMN IF NOT EXISTS outcome        VARCHAR(50) DEFAULT 'in_progress'`);
  await knex.raw(`ALTER TABLE workflow_transitions ADD COLUMN IF NOT EXISTS condition_expr JSONB`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'workflow_transitions_from_step_id_action_key'
      ) THEN
        ALTER TABLE workflow_transitions ADD CONSTRAINT workflow_transitions_from_step_id_action_key UNIQUE (from_step_id, action);
      END IF;
    END $$
  `);

  // ── 4. Workflow instances (runtime tracking) ──────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS workflow_instances (
      id              SERIAL PRIMARY KEY,
      workflow_id     INTEGER      NOT NULL REFERENCES workflows(id),
      module          VARCHAR(100) NOT NULL,
      entity_id       INTEGER      NOT NULL,
      entity_type     VARCHAR(100),
      status          VARCHAR(50)  DEFAULT 'pending',
      current_step_id INTEGER      REFERENCES workflow_steps(id),
      initiated_by    INTEGER      REFERENCES users(id),
      completed_at    TIMESTAMPTZ,
      created_at      TIMESTAMPTZ  DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_wf_inst_entity ON workflow_instances(module, entity_id);
    CREATE INDEX IF NOT EXISTS idx_wf_inst_status ON workflow_instances(status);
    CREATE INDEX IF NOT EXISTS idx_wf_inst_step   ON workflow_instances(current_step_id);
  `);

  // ── 5. Workflow instance steps (per-step audit trail) ────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS workflow_instance_steps (
      id          SERIAL PRIMARY KEY,
      instance_id INTEGER      NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
      step_id     INTEGER      NOT NULL REFERENCES workflow_steps(id),
      status      VARCHAR(50)  DEFAULT 'pending',
      assigned_to INTEGER      REFERENCES users(id),
      actioned_by INTEGER      REFERENCES users(id),
      actioned_at TIMESTAMPTZ,
      comments    TEXT,
      created_at  TIMESTAMPTZ  DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_wf_ist_instance  ON workflow_instance_steps(instance_id);
    CREATE INDEX IF NOT EXISTS idx_wf_ist_status    ON workflow_instance_steps(status);
    CREATE INDEX IF NOT EXISTS idx_wf_ist_step      ON workflow_instance_steps(step_id);
  `);

  // ── 6. Seed: default Leave Approval workflow ──────────────────────────────────
  await knex.raw(`
    INSERT INTO workflows (name, code, module, trigger_event, is_active, description)
    VALUES (
      'Leave Approval', 'leave_approval', 'leaves', 'on_submit', true,
      'Default 2-step leave approval: manager review then HR confirmation'
    )
    ON CONFLICT (code) DO NOTHING
  `);

  await knex.raw(`
    INSERT INTO workflow_steps
      (workflow_id, step_code, step_name, step_type, assignee_role, sequence_order, is_initial, is_terminal)
    SELECT w.id, s.step_code, s.step_name, s.step_type, s.assignee_role, s.seq, s.is_initial, s.is_terminal
    FROM workflows w
    CROSS JOIN (VALUES
      ('manager_approval', 'Manager Approval', 'approval', 'manager',  1, true,  false),
      ('hr_confirmation',  'HR Confirmation',  'approval', 'hr',       2, false, false),
      ('approved',         'Approved',         'terminal', null,       3, false, true),
      ('rejected',         'Rejected',         'terminal', null,       4, false, true)
    ) AS s(step_code, step_name, step_type, assignee_role, seq, is_initial, is_terminal)
    WHERE w.code = 'leave_approval'
    ON CONFLICT (workflow_id, step_code) DO NOTHING
  `);

  // Seed transitions using a DO block so we can look up step IDs by code
  await knex.raw(`
    DO $$
    DECLARE
      v_wf_id     INTEGER;
      v_mgr_id    INTEGER;
      v_hr_id     INTEGER;
      v_appr_id   INTEGER;
      v_rej_id    INTEGER;
    BEGIN
      SELECT id INTO v_wf_id FROM workflows WHERE code = 'leave_approval';
      IF v_wf_id IS NULL THEN RETURN; END IF;

      SELECT id INTO v_mgr_id  FROM workflow_steps WHERE workflow_id = v_wf_id AND step_code = 'manager_approval';
      SELECT id INTO v_hr_id   FROM workflow_steps WHERE workflow_id = v_wf_id AND step_code = 'hr_confirmation';
      SELECT id INTO v_appr_id FROM workflow_steps WHERE workflow_id = v_wf_id AND step_code = 'approved';
      SELECT id INTO v_rej_id  FROM workflow_steps WHERE workflow_id = v_wf_id AND step_code = 'rejected';

      INSERT INTO workflow_transitions (workflow_id, from_step_id, to_step_id, action, outcome)
      VALUES
        (v_wf_id, v_mgr_id, v_hr_id,    'approve', 'in_progress'),
        (v_wf_id, v_mgr_id, v_rej_id,   'reject',  'rejected'),
        (v_wf_id, v_hr_id,  v_appr_id,  'approve', 'approved'),
        (v_wf_id, v_hr_id,  v_rej_id,   'reject',  'rejected')
      ON CONFLICT (from_step_id, action) DO NOTHING;
    END;
    $$
  `);

  // ── 7. Seed: default Project Creation workflow (single-step auto) ─────────────
  await knex.raw(`
    INSERT INTO workflows (name, code, module, trigger_event, is_active, description)
    VALUES (
      'Project Creation', 'project_creation', 'projects', 'on_create', true,
      'Manager approval required for new project creation'
    )
    ON CONFLICT (code) DO NOTHING
  `);

  await knex.raw(`
    INSERT INTO workflow_steps
      (workflow_id, step_code, step_name, step_type, assignee_role, sequence_order, is_initial, is_terminal)
    SELECT w.id, s.step_code, s.step_name, s.step_type, s.assignee_role, s.seq, s.is_initial, s.is_terminal
    FROM workflows w
    CROSS JOIN (VALUES
      ('manager_approval', 'Manager Approval', 'approval', 'manager', 1, true,  false),
      ('approved',         'Approved',         'terminal', null,      2, false, true),
      ('rejected',         'Rejected',         'terminal', null,      3, false, true)
    ) AS s(step_code, step_name, step_type, assignee_role, seq, is_initial, is_terminal)
    WHERE w.code = 'project_creation'
    ON CONFLICT (workflow_id, step_code) DO NOTHING
  `);

  await knex.raw(`
    DO $$
    DECLARE
      v_wf_id    INTEGER;
      v_mgr_id   INTEGER;
      v_appr_id  INTEGER;
      v_rej_id   INTEGER;
    BEGIN
      SELECT id INTO v_wf_id   FROM workflows      WHERE code        = 'project_creation';
      IF v_wf_id IS NULL THEN RETURN; END IF;
      SELECT id INTO v_mgr_id  FROM workflow_steps WHERE workflow_id = v_wf_id AND step_code = 'manager_approval';
      SELECT id INTO v_appr_id FROM workflow_steps WHERE workflow_id = v_wf_id AND step_code = 'approved';
      SELECT id INTO v_rej_id  FROM workflow_steps WHERE workflow_id = v_wf_id AND step_code = 'rejected';

      INSERT INTO workflow_transitions (workflow_id, from_step_id, to_step_id, action, outcome)
      VALUES
        (v_wf_id, v_mgr_id, v_appr_id, 'approve', 'approved'),
        (v_wf_id, v_mgr_id, v_rej_id,  'reject',  'rejected')
      ON CONFLICT (from_step_id, action) DO NOTHING;
    END;
    $$
  `);
}

export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS workflow_instance_steps CASCADE;
    DROP TABLE IF EXISTS workflow_instances       CASCADE;
    DROP TABLE IF EXISTS workflow_transitions     CASCADE;
    DROP TABLE IF EXISTS workflow_steps           CASCADE;
    DROP TABLE IF EXISTS workflows               CASCADE;
  `);
}
