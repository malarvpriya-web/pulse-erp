/**
 * 20260429000002_rule_validation.js
 *
 * Phase 2 — Rule Engine + Validation Engine
 * Creates: rules_master, validation_rules
 * Seeds:   low-stock inventory rule, leave overlap validation rule
 *
 * KNOWN ISSUE: This file shares a timestamp prefix (20260429000002) with
 * 20260429000002_workflow_sla_columns.js. The migration system tracks by
 * filename (not timestamp), so both run correctly. Do NOT rename either file
 * if it has already been applied to production — renaming would cause the
 * system to attempt a re-run. The correct fix on a future migration is to
 * use a higher sequence number (20260429000003, etc.).
 */

export async function up(knex) {

  // ── 1. Business rules master ─────────────────────────────────────────────────
  // Backfill missing columns first so CREATE INDEX below finds them if table pre-exists
  await knex.raw(`ALTER TABLE rules_master ALTER COLUMN rule_name DROP NOT NULL`).catch(() => {});
  await knex.raw(`ALTER TABLE rules_master ADD COLUMN IF NOT EXISTS name           VARCHAR(200)`);
  await knex.raw(`ALTER TABLE rules_master ADD COLUMN IF NOT EXISTS code           VARCHAR(100)`);
  await knex.raw(`ALTER TABLE rules_master ADD COLUMN IF NOT EXISTS module         VARCHAR(100)`);
  await knex.raw(`ALTER TABLE rules_master ADD COLUMN IF NOT EXISTS rule_type      VARCHAR(50) DEFAULT 'alert'`);
  await knex.raw(`ALTER TABLE rules_master ADD COLUMN IF NOT EXISTS condition_expr JSONB`);
  await knex.raw(`ALTER TABLE rules_master ADD COLUMN IF NOT EXISTS action_expr    JSONB`);
  await knex.raw(`ALTER TABLE rules_master ADD COLUMN IF NOT EXISTS company_id     INTEGER REFERENCES companies(id) ON DELETE SET NULL`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rules_master_code_key') THEN
        ALTER TABLE rules_master ADD CONSTRAINT rules_master_code_key UNIQUE (code);
      END IF;
    END $$
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS rules_master (
      id              SERIAL PRIMARY KEY,
      name            VARCHAR(200) NOT NULL,
      code            VARCHAR(100) UNIQUE NOT NULL,
      module          VARCHAR(100) NOT NULL,
      rule_type       VARCHAR(50)  DEFAULT 'alert',
      condition_expr  JSONB        NOT NULL,
      action_expr     JSONB        NOT NULL,
      is_active       BOOLEAN      DEFAULT TRUE,
      priority        INTEGER      DEFAULT 50,
      company_id      INTEGER      REFERENCES companies(id) ON DELETE SET NULL,
      description     TEXT,
      created_at      TIMESTAMPTZ  DEFAULT NOW(),
      updated_at      TIMESTAMPTZ  DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rules_module ON rules_master(module, is_active);
    CREATE INDEX IF NOT EXISTS idx_rules_code   ON rules_master(code);
  `);

  // ── 2. Validation rules ──────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS validation_rules (
      id            SERIAL PRIMARY KEY,
      name          VARCHAR(200) NOT NULL,
      code          VARCHAR(100) UNIQUE NOT NULL,
      module        VARCHAR(100) NOT NULL,
      field_name    VARCHAR(100) NOT NULL,
      rule_type     VARCHAR(50)  DEFAULT 'required',
      rule_expr     JSONB        NOT NULL,
      error_message VARCHAR(500),
      is_active     BOOLEAN      DEFAULT TRUE,
      company_id    INTEGER      REFERENCES companies(id) ON DELETE SET NULL,
      created_at    TIMESTAMPTZ  DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_val_rules_module ON validation_rules(module, is_active);
    CREATE INDEX IF NOT EXISTS idx_val_rules_field  ON validation_rules(module, field_name);
  `);

  // ── 3. Seed: inventory low-stock alert rule ───────────────────────────────────
  await knex.raw(`
    INSERT INTO rules_master
      (name, code, module, rule_type, condition_expr, action_expr, is_active, priority, description)
    VALUES
      (
        'Inventory Low Stock Alert',
        'inventory_low_stock',
        'inventory',
        'alert',
        '{"field": "current_quantity", "operator": "lte", "value_field": "reorder_point"}',
        '{"type": "notify", "target_role": "admin", "severity": "warning", "message_template": "Item {{item_name}} ({{item_code}}) is at or below reorder point. Current: {{current_quantity}}, Reorder at: {{reorder_point}}"}',
        true,
        10,
        'Triggers when an inventory item reaches or falls below its reorder point'
      ),
      (
        'Inventory Out of Stock',
        'inventory_out_of_stock',
        'inventory',
        'alert',
        '{"field": "current_quantity", "operator": "lte", "value": 0}',
        '{"type": "notify", "target_role": "admin", "severity": "critical", "message_template": "Item {{item_name}} ({{item_code}}) is OUT OF STOCK. Immediate reorder required."}',
        true,
        1,
        'Triggers when an inventory item hits zero stock'
      )
    ON CONFLICT (code) DO NOTHING
  `);

  // ── 4. Seed: leave validation rules ──────────────────────────────────────────
  await knex.raw(`
    INSERT INTO validation_rules
      (name, code, module, field_name, rule_type, rule_expr, error_message, is_active)
    VALUES
      (
        'Leave Reason Required',
        'leave_reason_required',
        'leaves',
        'reason',
        'required',
        '{"required": true, "min_length": 10}',
        'Reason is required and must be at least 10 characters',
        true
      ),
      (
        'Leave Days Minimum',
        'leave_days_min',
        'leaves',
        'days',
        'range',
        '{"min": 1}',
        'Leave must be at least 1 day',
        true
      ),
      (
        'Leave Days Maximum',
        'leave_days_max',
        'leaves',
        'days',
        'range',
        '{"max": 90}',
        'Leave cannot exceed 90 consecutive days',
        true
      )
    ON CONFLICT (code) DO NOTHING
  `);

  // ── 5. Seed: project validation rules ────────────────────────────────────────
  await knex.raw(`
    INSERT INTO validation_rules
      (name, code, module, field_name, rule_type, rule_expr, error_message, is_active)
    VALUES
      (
        'Project Name Required',
        'project_name_required',
        'projects',
        'project_name',
        'required',
        '{"required": true, "min_length": 3}',
        'Project name is required (min 3 characters)',
        true
      ),
      (
        'Project Budget Positive',
        'project_budget_positive',
        'projects',
        'budget',
        'range',
        '{"min": 0}',
        'Project budget must be a positive number',
        true
      )
    ON CONFLICT (code) DO NOTHING
  `);
}

export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS validation_rules CASCADE;
    DROP TABLE IF EXISTS rules_master      CASCADE;
  `);
}
