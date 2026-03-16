-- =====================================================
-- ADVANCED PROJECT MANAGEMENT FEATURES SCHEMA
-- =====================================================

-- =====================================================
-- 1. PROJECT TEMPLATES
-- =====================================================
CREATE TABLE project_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_name VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    created_by UUID,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE project_template_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES project_templates(id) ON DELETE CASCADE,
    task_title VARCHAR(255) NOT NULL,
    task_description TEXT,
    estimated_hours DECIMAL(8,2),
    relative_due_days INTEGER, -- e.g., 7 days after project start
    priority VARCHAR(20) DEFAULT 'medium'
);

CREATE INDEX idx_template_tasks_template ON project_template_tasks(template_id);

-- =====================================================
-- 2. RISK & ISSUE TRACKING
-- =====================================================
CREATE TABLE project_risks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    risk_description TEXT NOT NULL,
    probability VARCHAR(20) CHECK (probability IN ('low', 'medium', 'high')),
    impact VARCHAR(20) CHECK (impact IN ('low', 'medium', 'high')),
    mitigation_plan TEXT,
    owner_id UUID REFERENCES employees(id),
    status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'mitigated', 'closed')),
    created_by UUID,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_risks_project ON project_risks(project_id);

CREATE TABLE project_issues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    issue_description TEXT NOT NULL,
    priority VARCHAR(20) DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    resolution_plan TEXT,
    owner_id UUID REFERENCES employees(id),
    status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
    created_by UUID,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_issues_project ON project_issues(project_id);

-- =====================================================
-- 3. CHANGE REQUEST MANAGEMENT
-- =====================================================
CREATE TABLE project_change_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    cr_number VARCHAR(50) UNIQUE NOT NULL,
    request_title VARCHAR(255) NOT NULL,
    request_description TEXT,
    requested_by_id UUID,
    request_date DATE NOT NULL,
    impact_analysis TEXT,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    approved_by_id UUID,
    approved_date DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_cr_project ON project_change_requests(project_id);

-- =====================================================
-- 4. PROJECT BILLING
-- =====================================================
CREATE TABLE project_billing_milestones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    milestone_name VARCHAR(255) NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    due_date DATE,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'invoiced', 'paid')),
    invoice_id UUID REFERENCES invoices(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_billing_project ON project_billing_milestones(project_id);

-- =====================================================
-- 5. ANALYTICS & KPI VIEWS
-- =====================================================

-- View: Project KPI Summary
CREATE OR REPLACE VIEW v_project_kpi_summary AS
SELECT
    p.id as project_id,
    p.project_name,
    p.status,
    p.budget_amount,
    COALESCE(pc.total_cost, 0) as actual_cost,
    (p.budget_amount - COALESCE(pc.total_cost, 0)) as budget_variance,
    CASE WHEN p.budget_amount > 0 THEN (COALESCE(pc.total_cost, 0) / p.budget_amount) * 100 ELSE 0 END as budget_burn_rate,
    (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done' AND t.due_date IS NOT NULL AND t.updated_at::date <= t.due_date) as on_time_tasks,
    (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.due_date IS NOT NULL) as total_tasks_with_due_date,
    CASE 
        WHEN (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.due_date IS NOT NULL) > 0
        THEN ((SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done' AND t.due_date IS NOT NULL AND t.updated_at::date <= t.due_date)::FLOAT / (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.due_date IS NOT NULL) * 100)
        ELSE 0 
    END as on_time_delivery_rate
FROM projects p
LEFT JOIN project_cost_summary pc ON p.id = pc.project_id;

-- View: Resource Capacity & Utilization
CREATE OR REPLACE VIEW v_resource_utilization AS
SELECT
    e.id as employee_id,
    e.first_name || ' ' || e.last_name as employee_name,
    COALESCE(SUM(ptm.allocation_percentage), 0) as total_allocation,
    (SELECT SUM(te.hours_worked) FROM timesheet_entries te WHERE te.employee_id = e.id AND te.work_date >= date_trunc('month', CURRENT_DATE)) as hours_this_month,
    (SELECT SUM(te.hours_worked) FROM timesheet_entries te WHERE te.employee_id = e.id AND te.work_date >= date_trunc('month', CURRENT_DATE) AND te.is_billable = true) as billable_hours_this_month,
    CASE 
        WHEN (SELECT SUM(te.hours_worked) FROM timesheet_entries te WHERE te.employee_id = e.id AND te.work_date >= date_trunc('month', CURRENT_DATE)) > 0
        THEN ((SELECT SUM(te.hours_worked) FROM timesheet_entries te WHERE te.employee_id = e.id AND te.work_date >= date_trunc('month', CURRENT_DATE) AND te.is_billable = true)::FLOAT / (SELECT SUM(te.hours_worked) FROM timesheet_entries te WHERE te.employee_id = e.id AND te.work_date >= date_trunc('month', CURRENT_DATE)) * 100)
        ELSE 0
    END as billable_percentage
FROM employees e
LEFT JOIN project_team_members ptm ON e.id = ptm.employee_id
LEFT JOIN projects p ON ptm.project_id = p.id AND p.status = 'active'
GROUP BY e.id, e.first_name, e.last_name;

-- =====================================================
-- 6. TASK DEPENDENCIES & WBS
-- =====================================================
CREATE TABLE task_dependencies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    predecessor_task_id UUID NOT NULL REFERENCES tasks(id),
    successor_task_id UUID NOT NULL REFERENCES tasks(id),
    dependency_type VARCHAR(20) DEFAULT 'finish_to_start' CHECK (dependency_type IN ('finish_to_start', 'start_to_start', 'finish_to_finish', 'start_to_finish')),
    lag_days INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_task_deps_pred ON task_dependencies(predecessor_task_id);
CREATE INDEX idx_task_deps_succ ON task_dependencies(successor_task_id);

-- =====================================================
-- 7. PROJECT BASELINES
-- =====================================================
CREATE TABLE project_baselines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    baseline_name VARCHAR(100) NOT NULL,
    baseline_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    snapshot_data JSONB, -- Stores full project state: tasks, dates, costs
    created_by UUID,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_baselines_project ON project_baselines(project_id);

-- =====================================================
-- 8. EARNED VALUE MANAGEMENT (EVM)
-- =====================================================
CREATE TABLE project_evm_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    snapshot_date DATE NOT NULL,
    planned_value DECIMAL(15,2) DEFAULT 0, -- PV (BCWS)
    earned_value DECIMAL(15,2) DEFAULT 0,  -- EV (BCWP)
    actual_cost DECIMAL(15,2) DEFAULT 0,   -- AC (ACWP)
    cpi DECIMAL(10,4), -- Cost Performance Index
    spi DECIMAL(10,4), -- Schedule Performance Index
    estimate_at_completion DECIMAL(15,2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_evm_project ON project_evm_snapshots(project_id);

-- =====================================================
-- 9. CLIENT COMMUNICATION LOGS
-- =====================================================
CREATE TABLE project_communications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    communication_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    communication_type VARCHAR(50) CHECK (communication_type IN ('email', 'meeting', 'call', 'site_visit')),
    subject VARCHAR(255),
    summary TEXT,
    participants TEXT[],
    action_items TEXT,
    logged_by UUID,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- 10. FINANCIAL FORECASTING
-- =====================================================
CREATE TABLE project_forecasts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    forecast_date DATE NOT NULL,
    period_start DATE,
    period_end DATE,
    forecast_revenue DECIMAL(15,2) DEFAULT 0,
    forecast_cost DECIMAL(15,2) DEFAULT 0,
    probability_percentage DECIMAL(5,2) DEFAULT 100,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- 11. PROJECT DOCUMENT VERSION CONTROL
-- =====================================================
CREATE TABLE project_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    document_name VARCHAR(255) NOT NULL,
    document_type VARCHAR(50),
    category VARCHAR(50), -- contract, spec, design, report
    current_version INTEGER DEFAULT 1,
    is_locked BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE project_document_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES project_documents(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    file_url VARCHAR(500) NOT NULL,
    file_size INTEGER,
    uploaded_by UUID,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    change_log TEXT
);

COMMIT;