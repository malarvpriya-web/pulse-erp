-- ============================================================
-- Pulse ERP — 13-System Intelligence Layer Migration
-- Run:  psql -U postgres -d Pulse -f system-intelligence-migration.sql
-- ============================================================

-- ╔══════════════════════════════════════════════════════════╗
-- ║  1. RULE ENGINE                                          ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS rules_master (
  id             SERIAL PRIMARY KEY,
  module_name    VARCHAR(100) NOT NULL,  -- leave, travel, order, inventory, hr
  rule_name      VARCHAR(200) NOT NULL,
  description    TEXT,
  condition_json JSONB        NOT NULL DEFAULT '{}',
  action_json    JSONB        NOT NULL DEFAULT '{}',
  priority       INTEGER      DEFAULT 10,
  is_active      BOOLEAN      DEFAULT true,
  created_by     INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ  DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rules_module    ON rules_master(module_name);
CREATE INDEX IF NOT EXISTS idx_rules_active    ON rules_master(is_active);
CREATE INDEX IF NOT EXISTS idx_rules_priority  ON rules_master(module_name, priority);

-- Seed default rules
INSERT INTO rules_master (module_name, rule_name, description, condition_json, action_json, priority)
VALUES
  ('leave',     'Long Leave HR Approval',   'Leaves > 3 days require HR approval',
   '{"leave_days": {"op": ">", "value": 3}}',
   '{"require_hr_approval": true, "notify_roles": ["hr_manager"]}', 10),

  ('leave',     'Emergency Leave Auto-Approve', 'Medical leave with doc auto-approves after 24h',
   '{"leave_type": "Sick Leave", "has_document": true}',
   '{"auto_approve_after_hours": 24, "notify_employee": true}', 5),

  ('travel',    'International Travel CFO',  'International travel needs CFO sign-off',
   '{"destination_type": "international", "estimated_cost": {"op": ">", "value": 50000}}',
   '{"require_cfo_approval": true, "require_insurance_proof": true}', 10),

  ('travel',    'Budget Cap Travel',         'Flag travel over ₹1L',
   '{"estimated_cost": {"op": ">", "value": 100000}}',
   '{"flag_for_review": true, "notify_roles": ["admin", "finance_manager"]}', 20),

  ('inventory', 'Low Stock Alert',           'Auto-alert when stock hits reorder level',
   '{"quantity": {"op": "<=", "field": "reorder_level"}}',
   '{"create_alert": true, "notify_roles": ["inventory_manager"], "suggest_reorder": true}', 5),

  ('inventory', 'Critical Stock Halt',       'Halt orders when stock is zero',
   '{"quantity": {"op": "<=", "value": 0}}',
   '{"block_sales_order": true, "notify_roles": ["admin", "inventory_manager"]}', 1),

  ('hr',        'Probation Auto-Reminder',   'Remind HR 30 days before probation end',
   '{"days_to_probation_end": {"op": "<=", "value": 30}}',
   '{"send_reminder": true, "notify_roles": ["hr_manager"], "create_task": true}', 10),

  ('finance',   'Large Invoice Approval',    'Invoices > ₹5L need CFO approval',
   '{"amount": {"op": ">", "value": 500000}}',
   '{"require_cfo_approval": true, "require_supporting_docs": true}', 5),

  ('order',     'Discount Limit Rule',       'Sales discounts > 20% need manager approval',
   '{"discount_percentage": {"op": ">", "value": 20}}',
   '{"require_manager_approval": true, "max_auto_discount": 20}', 10)
ON CONFLICT DO NOTHING;


-- ╔══════════════════════════════════════════════════════════╗
-- ║  2. PERMISSION ENGINE (Role-Based + Field-Level)         ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS roles (
  id          SERIAL PRIMARY KEY,
  role_name   VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  is_system   BOOLEAN DEFAULT false,  -- system roles cannot be deleted
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  id            SERIAL PRIMARY KEY,
  role_name     VARCHAR(100) NOT NULL,
  module        VARCHAR(100) NOT NULL,
  action        VARCHAR(50)  NOT NULL,  -- view, add, edit, delete, approve, export
  is_allowed    BOOLEAN      DEFAULT true,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(role_name, module, action)
);

CREATE TABLE IF NOT EXISTS field_permissions (
  id          SERIAL PRIMARY KEY,
  role_name   VARCHAR(100) NOT NULL,
  module      VARCHAR(100) NOT NULL,
  field_name  VARCHAR(100) NOT NULL,
  is_visible  BOOLEAN      DEFAULT true,
  is_editable BOOLEAN      DEFAULT true,
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(role_name, module, field_name)
);

CREATE INDEX IF NOT EXISTS idx_role_perms_role   ON role_permissions(role_name, module);
CREATE INDEX IF NOT EXISTS idx_field_perms_role  ON field_permissions(role_name, module);

-- Seed system roles
INSERT INTO roles (role_name, description, is_system) VALUES
  ('super_admin',    'Full system access',                true),
  ('admin',          'Administrative access',             true),
  ('manager',        'Team management access',            true),
  ('department_head','Department-level access',           true),
  ('employee',       'Self-service access only',          true),
  ('auditor',        'Read-only access to all modules',   false),
  ('finance_manager','Finance module full access',        false),
  ('hr_manager',     'HR module full access',             false)
ON CONFLICT (role_name) DO NOTHING;

-- Seed role permissions
INSERT INTO role_permissions (role_name, module, action, is_allowed)
SELECT r.role_name, m.module, a.action, r.role_name IN ('super_admin','admin')
FROM (VALUES ('super_admin'),('admin'),('manager'),('department_head'),('employee')) AS r(role_name)
CROSS JOIN (VALUES ('employees'),('finance'),('projects'),('leave'),('attendance'),
                   ('recruitment'),('inventory'),('travel'),('crm'),('sales'),
                   ('timesheets'),('performance'),('reports')) AS m(module)
CROSS JOIN (VALUES ('view'),('add'),('edit'),('delete'),('approve'),('export')) AS a(action)
ON CONFLICT (role_name, module, action) DO NOTHING;

-- Set specific employee permissions (view only on most)
UPDATE role_permissions SET is_allowed = true
WHERE role_name = 'employee' AND action = 'view'
  AND module IN ('leave','attendance','timesheets','performance');

-- Seed sensitive field permissions (employees can't see salary)
INSERT INTO field_permissions (role_name, module, field_name, is_visible, is_editable)
VALUES
  ('employee',  'employees', 'basic_salary',  false, false),
  ('employee',  'employees', 'annual_ctc',    false, false),
  ('employee',  'employees', 'hra',           false, false),
  ('employee',  'employees', 'pan_number',    false, false),
  ('employee',  'employees', 'aadhaar_number',false, false),
  ('employee',  'employees', 'bank_account',  false, false),
  ('manager',   'employees', 'basic_salary',  true,  false),
  ('manager',   'employees', 'annual_ctc',    true,  false),
  ('auditor',   'finance',   'payment_details',true, false),
  ('auditor',   'employees', 'basic_salary',  true,  false)
ON CONFLICT (role_name, module, field_name) DO NOTHING;


-- ╔══════════════════════════════════════════════════════════╗
-- ║  3. WORKFLOW ENGINE                                      ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS workflow_master (
  id          SERIAL PRIMARY KEY,
  module      VARCHAR(100) NOT NULL,
  name        VARCHAR(200) NOT NULL,
  description TEXT,
  is_active   BOOLEAN      DEFAULT true,
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(module, name)
);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id            SERIAL PRIMARY KEY,
  workflow_id   INTEGER NOT NULL REFERENCES workflow_master(id) ON DELETE CASCADE,
  step_name     VARCHAR(200) NOT NULL,
  sequence      INTEGER      NOT NULL,
  role_required VARCHAR(100),          -- which role handles this step
  auto_approve  BOOLEAN      DEFAULT false,
  timeout_hours INTEGER,               -- auto-escalate after N hours
  notify_roles  TEXT[],               -- roles to notify on entry
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow_transitions (
  id             SERIAL PRIMARY KEY,
  workflow_id    INTEGER NOT NULL REFERENCES workflow_master(id) ON DELETE CASCADE,
  from_step_id   INTEGER REFERENCES workflow_steps(id) ON DELETE CASCADE,
  to_step_id     INTEGER REFERENCES workflow_steps(id) ON DELETE CASCADE,
  condition_json JSONB   DEFAULT '{}',
  action_label   VARCHAR(100) DEFAULT 'Proceed',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow_instances (
  id           SERIAL PRIMARY KEY,
  workflow_id  INTEGER NOT NULL REFERENCES workflow_master(id),
  module       VARCHAR(100) NOT NULL,
  record_id    INTEGER      NOT NULL,
  current_step INTEGER      REFERENCES workflow_steps(id),
  status       VARCHAR(50)  DEFAULT 'active', -- active, completed, cancelled
  started_by   INTEGER      REFERENCES users(id),
  started_at   TIMESTAMPTZ  DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS workflow_instance_history (
  id          SERIAL PRIMARY KEY,
  instance_id INTEGER NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  step_id     INTEGER REFERENCES workflow_steps(id),
  action      VARCHAR(50),  -- approved, rejected, escalated
  actor_id    INTEGER       REFERENCES users(id),
  comment     TEXT,
  acted_at    TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wf_instances_module ON workflow_instances(module, record_id);
CREATE INDEX IF NOT EXISTS idx_wf_instances_status ON workflow_instances(status);

-- Seed workflows
DO $$
DECLARE
  wf_id INTEGER;
  s1 INTEGER; s2 INTEGER; s3 INTEGER;
BEGIN
  -- Leave Approval Workflow
  IF NOT EXISTS (SELECT 1 FROM workflow_master WHERE module='leave' AND name='Leave Approval') THEN
    INSERT INTO workflow_master (module, name, description) VALUES
      ('leave','Leave Approval','Standard leave approval process')
    RETURNING id INTO wf_id;
    INSERT INTO workflow_steps (workflow_id,step_name,sequence,role_required,notify_roles)
      VALUES (wf_id,'Employee Submits',1,'employee',ARRAY['employee']) RETURNING id INTO s1;
    INSERT INTO workflow_steps (workflow_id,step_name,sequence,role_required,notify_roles)
      VALUES (wf_id,'Manager Review',2,'manager',ARRAY['manager']) RETURNING id INTO s2;
    INSERT INTO workflow_steps (workflow_id,step_name,sequence,role_required,notify_roles)
      VALUES (wf_id,'HR Approval',3,'hr_manager',ARRAY['hr_manager','employee']) RETURNING id INTO s3;
    INSERT INTO workflow_transitions (workflow_id,from_step_id,to_step_id,action_label) VALUES
      (wf_id,s1,s2,'Submit'), (wf_id,s2,s3,'Approve'), (wf_id,s2,s1,'Reject');
  END IF;

  -- Travel Request Workflow
  IF NOT EXISTS (SELECT 1 FROM workflow_master WHERE module='travel' AND name='Travel Approval') THEN
    INSERT INTO workflow_master (module, name, description) VALUES
      ('travel','Travel Approval','Travel request approval chain')
    RETURNING id INTO wf_id;
    INSERT INTO workflow_steps (workflow_id,step_name,sequence,role_required)
      VALUES (wf_id,'Request Submitted',1,'employee') RETURNING id INTO s1;
    INSERT INTO workflow_steps (workflow_id,step_name,sequence,role_required)
      VALUES (wf_id,'Manager Approval',2,'manager') RETURNING id INTO s2;
    INSERT INTO workflow_steps (workflow_id,step_name,sequence,role_required)
      VALUES (wf_id,'Finance Approval',3,'finance_manager') RETURNING id INTO s3;
    INSERT INTO workflow_transitions (workflow_id,from_step_id,to_step_id,action_label) VALUES
      (wf_id,s1,s2,'Submit'),(wf_id,s2,s3,'Approve'),(wf_id,s2,s1,'Reject');
  END IF;

  -- Purchase Order Workflow
  IF NOT EXISTS (SELECT 1 FROM workflow_master WHERE module='procurement' AND name='PO Approval') THEN
    INSERT INTO workflow_master (module,name,description) VALUES
      ('procurement','PO Approval','Purchase order approval process')
    RETURNING id INTO wf_id;
    INSERT INTO workflow_steps (workflow_id,step_name,sequence,role_required)
      VALUES (wf_id,'PR Raised',1,'employee') RETURNING id INTO s1;
    INSERT INTO workflow_steps (workflow_id,step_name,sequence,role_required)
      VALUES (wf_id,'Dept Head Review',2,'department_head') RETURNING id INTO s2;
    INSERT INTO workflow_steps (workflow_id,step_name,sequence,role_required)
      VALUES (wf_id,'Finance Approved',3,'finance_manager') RETURNING id INTO s3;
    INSERT INTO workflow_transitions (workflow_id,from_step_id,to_step_id,action_label) VALUES
      (wf_id,s1,s2,'Submit'),(wf_id,s2,s3,'Approve'),(wf_id,s2,s1,'Reject');
  END IF;
END$$;


-- ╔══════════════════════════════════════════════════════════╗
-- ║  4. SLA / TAT TRACKING                                   ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS sla_config (
  id             SERIAL PRIMARY KEY,
  module         VARCHAR(100) NOT NULL,
  stage          VARCHAR(100) NOT NULL,
  expected_hours NUMERIC(8,2) NOT NULL,
  escalation_hours NUMERIC(8,2),
  escalate_to_role VARCHAR(100),
  is_active      BOOLEAN DEFAULT true,
  UNIQUE(module, stage)
);

CREATE TABLE IF NOT EXISTS sla_tracking (
  id          SERIAL PRIMARY KEY,
  module      VARCHAR(100) NOT NULL,
  record_id   INTEGER      NOT NULL,
  stage       VARCHAR(100) NOT NULL,
  start_time  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  end_time    TIMESTAMPTZ,
  expected_by TIMESTAMPTZ,
  duration_hours NUMERIC(8,2),
  status      VARCHAR(20)  DEFAULT 'running',  -- running, on_time, delayed, escalated
  assigned_to INTEGER      REFERENCES users(id),
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sla_module    ON sla_tracking(module, record_id);
CREATE INDEX IF NOT EXISTS idx_sla_status    ON sla_tracking(status);
CREATE INDEX IF NOT EXISTS idx_sla_expected  ON sla_tracking(expected_by) WHERE status='running';

-- Seed SLA configs
INSERT INTO sla_config (module, stage, expected_hours, escalation_hours, escalate_to_role)
VALUES
  ('leave',       'manager_review',   24,  48,  'hr_manager'),
  ('leave',       'hr_approval',      24,  48,  'admin'),
  ('travel',      'manager_approval', 24,  48,  'admin'),
  ('travel',      'finance_approval', 48,  72,  'admin'),
  ('servicedesk', 'open',             4,   8,   'manager'),
  ('servicedesk', 'in_progress',      24,  48,  'manager'),
  ('procurement', 'dept_approval',    24,  48,  'admin'),
  ('procurement', 'finance_approval', 48,  72,  'admin'),
  ('recruitment', 'cv_review',        48,  96,  'hr_manager'),
  ('recruitment', 'interview_schedule',24, 48,  'hr_manager'),
  ('finance',     'invoice_approval', 48,  96,  'admin'),
  ('complaints',  'assigned',         24,  48,  'manager'),
  ('complaints',  'in_progress',      72,  120, 'admin')
ON CONFLICT (module, stage) DO NOTHING;


-- ╔══════════════════════════════════════════════════════════╗
-- ║  5. NOTIFICATION ENGINE                                  ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS notification_rules (
  id           SERIAL PRIMARY KEY,
  event_name   VARCHAR(200) NOT NULL,   -- leave_applied, po_approved, etc.
  module       VARCHAR(100) NOT NULL,
  trigger_role VARCHAR(100),
  notify_role  VARCHAR(100),
  notify_self  BOOLEAN      DEFAULT true,
  channel      TEXT[]       DEFAULT ARRAY['app'],  -- app, email, sms, whatsapp
  template     TEXT,
  is_active    BOOLEAN      DEFAULT true,
  created_at   TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(event_name, notify_role)
);

-- Ensure notifications table has needed columns
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS module    VARCHAR(100);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS record_id INTEGER;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS priority  VARCHAR(20) DEFAULT 'normal';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS channel   VARCHAR(20) DEFAULT 'app';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS action_url TEXT;

CREATE INDEX IF NOT EXISTS idx_notif_user_unread ON notifications(user_id, is_read) WHERE is_read=false;

-- Seed notification rules
INSERT INTO notification_rules (event_name, module, trigger_role, notify_role, channel, template)
VALUES
  ('leave_applied',        'leave',       'employee',       'manager',
   ARRAY['app','email'], 'Leave request from {employee_name} for {leave_days} days pending your approval.'),
  ('leave_approved',       'leave',       'manager',        'employee',
   ARRAY['app'],         'Your leave from {start_date} to {end_date} has been approved.'),
  ('leave_rejected',       'leave',       'manager',        'employee',
   ARRAY['app','email'], 'Your leave request has been rejected. Reason: {reason}'),
  ('po_raised',            'procurement', 'employee',       'manager',
   ARRAY['app'],         'New Purchase Request #{pr_number} awaiting your approval.'),
  ('po_approved',          'procurement', 'manager',        'employee',
   ARRAY['app'],         'Your Purchase Request #{pr_number} has been approved.'),
  ('travel_applied',       'travel',      'employee',       'manager',
   ARRAY['app','email'], 'Travel request to {destination} from {employee_name} needs approval.'),
  ('invoice_overdue',      'finance',     'system',         'finance_manager',
   ARRAY['app','email'], 'Invoice #{invoice_number} of ₹{amount} is {days_overdue} days overdue.'),
  ('low_stock_alert',      'inventory',   'system',         'admin',
   ARRAY['app'],         '{item_name} stock is critically low ({quantity} units remaining).'),
  ('probation_ending',     'hr',          'system',         'hr_manager',
   ARRAY['app','email'], '{employee_name}\'s probation period ends in {days_remaining} days.'),
  ('ticket_assigned',      'servicedesk', 'manager',        'employee',
   ARRAY['app'],         'Ticket #{ticket_id} has been assigned to you. Priority: {priority}'),
  ('sla_breach',           'system',      'system',         'admin',
   ARRAY['app','email'], 'SLA breach: {module} record #{record_id} at stage {stage} is {hours_delayed}h delayed.')
ON CONFLICT (event_name, notify_role) DO NOTHING;


-- ╔══════════════════════════════════════════════════════════╗
-- ║  6. DASHBOARD BUILDER                                    ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER      REFERENCES users(id) ON DELETE CASCADE,
  role_default VARCHAR(100),             -- if set, applies to all users of this role
  widget_type  VARCHAR(50)  NOT NULL,    -- chart, table, kpi, list, calendar
  widget_name  VARCHAR(200) NOT NULL,
  query_config JSONB        NOT NULL DEFAULT '{}',
  position_x   INTEGER      DEFAULT 0,
  position_y   INTEGER      DEFAULT 0,
  width        INTEGER      DEFAULT 4,   -- grid columns (1-12)
  height       INTEGER      DEFAULT 2,   -- grid rows
  is_visible   BOOLEAN      DEFAULT true,
  refresh_secs INTEGER      DEFAULT 300, -- auto-refresh interval
  created_at   TIMESTAMPTZ  DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_widgets_user   ON dashboard_widgets(user_id);
CREATE INDEX IF NOT EXISTS idx_widgets_role   ON dashboard_widgets(role_default);

-- Seed default widgets for admin role
INSERT INTO dashboard_widgets (role_default, widget_type, widget_name, query_config, position_x, position_y, width, height)
VALUES
  ('admin', 'kpi', 'Total Employees',
   '{"module":"employees","metric":"count","filter":"status=active","color":"#6366f1"}', 0,0,3,1),
  ('admin', 'kpi', 'Pending Leaves',
   '{"module":"leave","metric":"count","filter":"status=pending","color":"#f59e0b"}', 3,0,3,1),
  ('admin', 'kpi', 'Open Tickets',
   '{"module":"servicedesk","metric":"count","filter":"status=open","color":"#ef4444"}', 6,0,3,1),
  ('admin', 'kpi', 'Monthly Revenue',
   '{"module":"finance","metric":"sum","field":"amount","filter":"type=invoice&period=current_month","color":"#10b981"}', 9,0,3,1),
  ('admin', 'chart', 'Department Headcount',
   '{"module":"employees","chart":"bar","group_by":"department","metric":"count"}', 0,1,6,3),
  ('admin', 'chart', 'Monthly Revenue Trend',
   '{"module":"finance","chart":"line","group_by":"month","metric":"sum","field":"amount"}', 6,1,6,3),
  ('admin', 'table', 'Pending Approvals',
   '{"module":"approvals","filter":"status=pending","limit":5,"columns":["type","requester","date"]}', 0,4,6,3),
  ('admin', 'chart', 'Leave Type Distribution',
   '{"module":"leave","chart":"pie","group_by":"leave_type","metric":"count"}', 6,4,6,3),
  ('employee', 'kpi', 'My Leave Balance',
   '{"module":"leave","metric":"balance","scope":"self","color":"#6366f1"}', 0,0,4,1),
  ('employee', 'kpi', 'My Attendance %',
   '{"module":"attendance","metric":"percentage","scope":"self","period":"current_month","color":"#10b981"}', 4,0,4,1),
  ('employee', 'kpi', 'Open Tasks',
   '{"module":"tasks","metric":"count","filter":"status=open","scope":"self","color":"#f59e0b"}', 8,0,4,1),
  ('employee', 'list', 'My Recent Leaves',
   '{"module":"leave","filter":"scope=self","limit":5,"columns":["type","start_date","status"]}', 0,1,6,3),
  ('manager',  'chart', 'Team Attendance Today',
   '{"module":"attendance","chart":"bar","group_by":"status","filter":"date=today&scope=team"}', 0,0,6,3),
  ('manager',  'table', 'Team Pending Leaves',
   '{"module":"leave","filter":"status=pending&scope=team","limit":10}', 6,0,6,3)
ON CONFLICT DO NOTHING;


-- ╔══════════════════════════════════════════════════════════╗
-- ║  7. DOCUMENT MANAGEMENT SYSTEM                           ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS documents (
  id            SERIAL PRIMARY KEY,
  module        VARCHAR(100) NOT NULL,
  record_id     INTEGER,
  document_name VARCHAR(300) NOT NULL,
  document_type VARCHAR(100),           -- contract, invoice, id_proof, etc.
  file_path     TEXT         NOT NULL,
  file_size     BIGINT,
  mime_type     VARCHAR(100),
  version       INTEGER      DEFAULT 1,
  is_mandatory  BOOLEAN      DEFAULT false,
  is_verified   BOOLEAN      DEFAULT false,
  verified_by   INTEGER      REFERENCES users(id),
  verified_at   TIMESTAMPTZ,
  uploaded_by   INTEGER      REFERENCES users(id),
  tags          TEXT[],
  expires_at    DATE,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS document_versions (
  id          SERIAL PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  file_path   TEXT    NOT NULL,
  file_size   BIGINT,
  uploaded_by INTEGER REFERENCES users(id),
  change_note TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_docs_module    ON documents(module, record_id);
CREATE INDEX IF NOT EXISTS idx_docs_type      ON documents(document_type);
CREATE INDEX IF NOT EXISTS idx_docs_expires   ON documents(expires_at) WHERE expires_at IS NOT NULL;


-- ╔══════════════════════════════════════════════════════════╗
-- ║  8. AUDIT LOG (Enhanced)                                 ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS audit_logs (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  user_name  VARCHAR(255),
  user_role  VARCHAR(100),
  module     VARCHAR(100) NOT NULL,
  record_id  INTEGER,
  action     VARCHAR(50)  NOT NULL,  -- create, update, delete, approve, reject, login, logout
  old_data   JSONB,
  new_data   JSONB,
  changed_fields TEXT[],
  ip_address VARCHAR(50),
  user_agent TEXT,
  session_id VARCHAR(200),
  timestamp  TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_user      ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_module    ON audit_logs(module, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_action    ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp DESC);


-- ╔══════════════════════════════════════════════════════════╗
-- ║  9. FINANCIAL LAYER (Cost/Profit Tracking)               ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS project_costs (
  id            SERIAL PRIMARY KEY,
  project_id    INTEGER      REFERENCES projects(id) ON DELETE CASCADE,
  cost_type     VARCHAR(100) NOT NULL,  -- labor, material, travel, overhead
  description   TEXT,
  amount        NUMERIC(15,2) NOT NULL,
  recorded_by   INTEGER      REFERENCES users(id),
  cost_date     DATE         DEFAULT CURRENT_DATE,
  is_approved   BOOLEAN      DEFAULT false,
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS budget_vs_actual (
  id           SERIAL PRIMARY KEY,
  module       VARCHAR(100) NOT NULL,
  reference_id INTEGER,
  budget_amount NUMERIC(15,2) DEFAULT 0,
  actual_amount NUMERIC(15,2) DEFAULT 0,
  variance      NUMERIC(15,2) GENERATED ALWAYS AS (budget_amount - actual_amount) STORED,
  period        VARCHAR(20),  -- YYYY-MM or YYYY-Q1 etc.
  department    VARCHAR(100),
  updated_at    TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(module, reference_id, period)
);

CREATE TABLE IF NOT EXISTS profit_tracker (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER      REFERENCES projects(id),
  period       VARCHAR(20)  NOT NULL,  -- YYYY-MM
  revenue      NUMERIC(15,2) DEFAULT 0,
  direct_cost  NUMERIC(15,2) DEFAULT 0,
  overhead     NUMERIC(15,2) DEFAULT 0,
  gross_profit NUMERIC(15,2) GENERATED ALWAYS AS (revenue - direct_cost) STORED,
  net_profit   NUMERIC(15,2) GENERATED ALWAYS AS (revenue - direct_cost - overhead) STORED,
  margin_pct   NUMERIC(7,2),
  updated_at   TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(project_id, period)
);

CREATE INDEX IF NOT EXISTS idx_project_costs_project ON project_costs(project_id);
CREATE INDEX IF NOT EXISTS idx_bva_module            ON budget_vs_actual(module, period);
CREATE INDEX IF NOT EXISTS idx_profit_project        ON profit_tracker(project_id, period);


-- ╔══════════════════════════════════════════════════════════╗
-- ║  10. MASTER DATA ENGINE                                  ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS masters (
  id          SERIAL PRIMARY KEY,
  type        VARCHAR(100) NOT NULL,   -- status, category, department, designation, etc.
  code        VARCHAR(100),
  value       VARCHAR(300) NOT NULL,
  label       VARCHAR(300),
  parent_id   INTEGER      REFERENCES masters(id) ON DELETE SET NULL,
  sort_order  INTEGER      DEFAULT 0,
  is_active   BOOLEAN      DEFAULT true,
  metadata    JSONB        DEFAULT '{}',
  created_by  INTEGER      REFERENCES users(id),
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(type, value)
);

CREATE INDEX IF NOT EXISTS idx_masters_type   ON masters(type, is_active);
CREATE INDEX IF NOT EXISTS idx_masters_parent ON masters(parent_id);

-- Seed master data
INSERT INTO masters (type, code, value, label, sort_order) VALUES
  -- Employee statuses
  ('employee_status','ACT','active','Active',1),
  ('employee_status','PRB','probation','Probation',2),
  ('employee_status','CON','contract','Contract',3),
  ('employee_status','INA','inactive','Inactive',4),
  ('employee_status','LFT','left','Left',5),
  -- Leave types backup
  ('leave_type','CL','Casual Leave','Casual Leave',1),
  ('leave_type','SL','Sick Leave','Sick Leave',2),
  ('leave_type','EL','Earned Leave','Earned Leave',3),
  ('leave_type','ML','Maternity Leave','Maternity Leave',4),
  ('leave_type','PL','Paternity Leave','Paternity Leave',5),
  -- Priority levels
  ('priority','LOW','low','Low',1),
  ('priority','MED','medium','Medium',2),
  ('priority','HGH','high','High',3),
  ('priority','CRT','critical','Critical',4),
  -- Ticket statuses
  ('ticket_status','OPN','open','Open',1),
  ('ticket_status','INP','in_progress','In Progress',2),
  ('ticket_status','PND','pending','Pending',3),
  ('ticket_status','RSV','resolved','Resolved',4),
  ('ticket_status','CLS','closed','Closed',5),
  -- Travel categories
  ('travel_category','DOM','domestic','Domestic',1),
  ('travel_category','INT','international','International',2),
  -- Expense types
  ('expense_type','FARE','fare','Travel Fare',1),
  ('expense_type','HTLS','hotel','Hotel/Accommodation',2),
  ('expense_type','MEAL','meals','Meals & Entertainment',3),
  ('expense_type','MISC','miscellaneous','Miscellaneous',4),
  -- Departments
  ('department','ENG','Engineering','Engineering',1),
  ('department','HR','HR','Human Resources',2),
  ('department','FIN','Finance','Finance',3),
  ('department','SAL','Sales','Sales',4),
  ('department','MKT','Marketing','Marketing',5),
  ('department','OPS','Operations','Operations',6),
  ('department','PRD','Product','Product',7),
  ('department','DSN','Design','Design',8),
  ('department','IT','IT','Information Technology',9)
ON CONFLICT (type, value) DO NOTHING;


-- ╔══════════════════════════════════════════════════════════╗
-- ║  11. MULTI-COMPANY / MULTI-BRANCH                        ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS companies (
  id           SERIAL PRIMARY KEY,
  company_name VARCHAR(300) NOT NULL,
  company_code VARCHAR(50)  UNIQUE NOT NULL,
  address      TEXT,
  city         VARCHAR(100),
  country      VARCHAR(100) DEFAULT 'India',
  gst_number   VARCHAR(50),
  pan_number   VARCHAR(30),
  email        VARCHAR(200),
  phone        VARCHAR(30),
  logo_url     TEXT,
  is_active    BOOLEAN      DEFAULT true,
  created_at   TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS branches (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  branch_name  VARCHAR(200) NOT NULL,
  branch_code  VARCHAR(50)  UNIQUE NOT NULL,
  city         VARCHAR(100),
  address      TEXT,
  is_head_office BOOLEAN    DEFAULT false,
  is_active    BOOLEAN      DEFAULT true,
  created_at   TIMESTAMPTZ  DEFAULT NOW()
);

-- Add company/branch context to key tables (safe ALTER)
ALTER TABLE employees   ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);
ALTER TABLE employees   ADD COLUMN IF NOT EXISTS branch_id  INTEGER REFERENCES branches(id);
ALTER TABLE users       ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);
ALTER TABLE users       ADD COLUMN IF NOT EXISTS branch_id  INTEGER REFERENCES branches(id);

CREATE INDEX IF NOT EXISTS idx_emp_company  ON employees(company_id);
CREATE INDEX IF NOT EXISTS idx_emp_branch   ON employees(branch_id);

-- Seed default company
INSERT INTO companies (company_name, company_code, country, is_active)
VALUES ('Pulse Technologies Pvt Ltd', 'PULSE', 'India', true)
ON CONFLICT (company_code) DO NOTHING;

INSERT INTO branches (company_id, branch_name, branch_code, city, is_head_office)
SELECT id, 'Head Office', 'HO', 'Bengaluru', true
FROM companies WHERE company_code = 'PULSE'
ON CONFLICT (branch_code) DO NOTHING;


-- ╔══════════════════════════════════════════════════════════╗
-- ║  12. SMART INSIGHTS CACHE                                ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS insights_cache (
  id           SERIAL PRIMARY KEY,
  metric_key   VARCHAR(200) UNIQUE NOT NULL,
  metric_name  VARCHAR(300) NOT NULL,
  category     VARCHAR(100),          -- hr, finance, operations, sales
  value        JSONB        NOT NULL DEFAULT '{}',
  trend        VARCHAR(20),           -- up, down, stable
  trend_pct    NUMERIC(7,2),
  description  TEXT,
  alert_level  VARCHAR(20),           -- info, warning, critical
  last_updated TIMESTAMPTZ  DEFAULT NOW(),
  refresh_mins INTEGER      DEFAULT 60
);

CREATE INDEX IF NOT EXISTS idx_insights_category ON insights_cache(category);
CREATE INDEX IF NOT EXISTS idx_insights_updated  ON insights_cache(last_updated);

-- Seed insight definitions (values will be populated by scheduled jobs)
INSERT INTO insights_cache (metric_key, metric_name, category, value, description)
VALUES
  ('hr.most_delayed_dept',      'Most Delayed Department',      'hr',
   '{"department": null, "avg_delay_hours": 0}',
   'Department with highest average task completion delay'),
  ('hr.attrition_rate_30d',     'Attrition Rate (30 days)',     'hr',
   '{"rate_pct": 0, "employees_left": 0}',
   'Employee attrition rate over last 30 days'),
  ('hr.avg_leave_utilization',  'Avg Leave Utilization',        'hr',
   '{"utilization_pct": 0}',
   'Average leave days used vs. allocated'),
  ('sales.top_complaint_product','Top Complaint Product',       'sales',
   '{"product": null, "complaint_count": 0}',
   'Product or service with most complaints this month'),
  ('sales.pipeline_health',     'Sales Pipeline Health',        'sales',
   '{"total_value": 0, "avg_deal_age_days": 0, "conversion_rate": 0}',
   'Overall health of the sales pipeline'),
  ('finance.overdue_invoices',  'Overdue Invoices',             'finance',
   '{"count": 0, "total_amount": 0}',
   'Count and value of overdue invoices'),
  ('finance.monthly_burn_rate', 'Monthly Burn Rate',            'finance',
   '{"amount": 0, "vs_last_month_pct": 0}',
   'Total expenses this month vs. last month'),
  ('ops.avg_ticket_resolution', 'Avg Ticket Resolution Time',  'operations',
   '{"avg_hours": 0, "sla_breach_count": 0}',
   'Average hours to resolve service desk tickets'),
  ('ops.inventory_turnover',    'Inventory Turnover Rate',      'operations',
   '{"rate": 0, "slow_moving_items": 0}',
   'Inventory movement efficiency'),
  ('hr.top_performer_dept',     'Top Performing Department',    'hr',
   '{"department": null, "score": 0}',
   'Department with highest average performance score')
ON CONFLICT (metric_key) DO NOTHING;


-- ╔══════════════════════════════════════════════════════════╗
-- ║  13. DATA VALIDATION ENGINE                              ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS validation_rules (
  id              SERIAL PRIMARY KEY,
  module          VARCHAR(100) NOT NULL,
  field_name      VARCHAR(100) NOT NULL,
  rule_type       VARCHAR(50)  NOT NULL,  -- required, min, max, regex, custom, range
  rule_value      TEXT,                   -- the rule parameter
  error_message   TEXT,
  is_active       BOOLEAN      DEFAULT true,
  priority        INTEGER      DEFAULT 10,
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(module, field_name, rule_type)
);

CREATE INDEX IF NOT EXISTS idx_val_rules_module ON validation_rules(module, is_active);

-- Seed validation rules
INSERT INTO validation_rules (module, field_name, rule_type, rule_value, error_message)
VALUES
  -- Employee validations
  ('employees', 'company_email',  'required',  null,                         'Company email is required'),
  ('employees', 'company_email',  'regex',     '^[^@]+@[^@]+\.[^@]+$',      'Must be a valid email address'),
  ('employees', 'first_name',     'required',  null,                         'First name is required'),
  ('employees', 'first_name',     'min_length','2',                          'First name must be at least 2 characters'),
  ('employees', 'joining_date',   'required',  null,                         'Joining date is required'),
  ('employees', 'phone',          'regex',     '^\+?[0-9]{10,15}$',         'Enter a valid phone number'),
  ('employees', 'basic_salary',   'min',       '0',                          'Salary cannot be negative'),
  ('employees', 'annual_ctc',     'min',       '0',                          'CTC cannot be negative'),
  -- Leave validations
  ('leave',     'leave_days',     'min',       '0.5',                        'Minimum leave is half day'),
  ('leave',     'leave_days',     'max',       '30',                         'Cannot apply for more than 30 days at once'),
  ('leave',     'start_date',     'required',  null,                         'Start date is required'),
  ('leave',     'leave_type',     'required',  null,                         'Leave type is required'),
  -- Travel validations
  ('travel',    'destination',    'required',  null,                         'Destination is required'),
  ('travel',    'estimated_cost', 'min',       '0',                          'Cost cannot be negative'),
  ('travel',    'estimated_cost', 'max',       '500000',                     'Travel cost exceeds ₹5L limit — CFO approval required'),
  -- Finance validations
  ('finance',   'amount',         'required',  null,                         'Amount is required'),
  ('finance',   'amount',         'min',       '0',                          'Amount must be positive'),
  ('finance',   'invoice_date',   'required',  null,                         'Invoice date is required'),
  -- Inventory validations
  ('inventory', 'quantity',       'min',       '0',                          'Quantity cannot be negative'),
  ('inventory', 'unit_price',     'min',       '0',                          'Price cannot be negative'),
  ('inventory', 'item_name',      'required',  null,                         'Item name is required'),
  ('inventory', 'item_name',      'min_length','2',                          'Item name must be at least 2 characters'),
  -- Recruitment validations
  ('recruitment','email',         'regex',     '^[^@]+@[^@]+\.[^@]+$',      'Must be a valid email address'),
  ('recruitment','phone',         'min_length','10',                         'Phone number too short')
ON CONFLICT (module, field_name, rule_type) DO NOTHING;


-- ╔══════════════════════════════════════════════════════════╗
-- ║  VERIFY ALL TABLES CREATED                               ║
-- ╚══════════════════════════════════════════════════════════╝

SELECT tablename AS "Table Created"
FROM pg_tables
WHERE schemaname='public'
  AND tablename IN (
    'rules_master','roles','role_permissions','field_permissions',
    'workflow_master','workflow_steps','workflow_transitions',
    'workflow_instances','workflow_instance_history',
    'sla_config','sla_tracking',
    'notification_rules',
    'dashboard_widgets',
    'documents','document_versions',
    'audit_logs',
    'project_costs','budget_vs_actual','profit_tracker',
    'masters',
    'companies','branches',
    'insights_cache',
    'validation_rules'
  )
ORDER BY tablename;
