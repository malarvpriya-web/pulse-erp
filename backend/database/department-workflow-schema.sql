-- =====================================================
-- DEPARTMENT WORKFLOW & OPERATIONS SCHEMA
-- =====================================================

-- =====================================================
-- 1. WORKFLOW CONFIGURATION
-- =====================================================
CREATE TABLE workflow_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_name VARCHAR(255) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    created_by UUID REFERENCES employees(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE workflow_template_stages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES workflow_templates(id) ON DELETE CASCADE,
    department_id INTEGER NOT NULL, -- References departments table
    stage_name VARCHAR(100) NOT NULL, -- e.g. "Design Phase", "Quality Check"
    sequence_order INTEGER NOT NULL,
    expected_duration_days INTEGER DEFAULT 1,
    is_parallel BOOLEAN DEFAULT false,
    allow_skip BOOLEAN DEFAULT false,
    sla_hours INTEGER, -- Service Level Agreement in hours
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_workflow_stages_template ON workflow_template_stages(template_id);

-- =====================================================
-- 2. PROJECT WORKFLOW TRACKING
-- =====================================================
CREATE TABLE project_workflows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    template_id UUID REFERENCES workflow_templates(id),
    status VARCHAR(50) DEFAULT 'active', -- active, completed, on_hold, cancelled
    current_stage_sequence INTEGER DEFAULT 1,
    start_date DATE DEFAULT CURRENT_DATE,
    completed_date DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_proj_workflow_project ON project_workflows(project_id);

CREATE TABLE project_workflow_stages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_workflow_id UUID NOT NULL REFERENCES project_workflows(id) ON DELETE CASCADE,
    template_stage_id UUID REFERENCES workflow_template_stages(id),
    department_id INTEGER, -- Snapshot
    stage_name VARCHAR(100),
    status VARCHAR(50) DEFAULT 'pending', -- pending, in_progress, completed, skipped, rework, delayed
    start_date TIMESTAMP,
    end_date TIMESTAMP,
    actual_duration_hours DECIMAL(10,2),
    assigned_to UUID REFERENCES employees(id), -- Specific person in dept
    completed_by UUID REFERENCES employees(id),
    notes TEXT,
    is_rework BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_proj_stage_workflow ON project_workflow_stages(project_workflow_id);
CREATE INDEX idx_proj_stage_dept ON project_workflow_stages(department_id);
CREATE INDEX idx_proj_stage_status ON project_workflow_stages(status);

-- =====================================================
-- 3. WORKFLOW HISTORY (Audit & Rework Loops)
-- =====================================================
CREATE TABLE workflow_transitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_workflow_id UUID NOT NULL REFERENCES project_workflows(id) ON DELETE CASCADE,
    from_stage_id UUID REFERENCES project_workflow_stages(id),
    to_stage_id UUID REFERENCES project_workflow_stages(id),
    transition_type VARCHAR(50), -- forward, backward (rework), skip
    transition_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    performed_by UUID REFERENCES employees(id),
    comments TEXT
);

-- =====================================================
-- 4. ANALYTICS VIEWS
-- =====================================================

-- View: Department Workload Dashboard
CREATE OR REPLACE VIEW v_department_workload AS
SELECT
    d.department_name,
    COUNT(pws.id) FILTER (WHERE pws.status = 'pending') as projects_in_queue,
    COUNT(pws.id) FILTER (WHERE pws.status = 'in_progress') as projects_in_progress,
    COUNT(pws.id) FILTER (WHERE pws.status = 'in_progress' AND NOW() > (pws.start_date + (wts.expected_duration_days || ' days')::INTERVAL)) as overdue_projects,
    AVG(EXTRACT(EPOCH FROM (pws.end_date - pws.start_date))/86400) FILTER (WHERE pws.status = 'completed') as avg_completion_days,
    -- Performance Score (Simple: % of projects completed within SLA)
    CASE 
        WHEN COUNT(pws.id) FILTER (WHERE pws.status = 'completed') > 0 
        THEN (COUNT(pws.id) FILTER (WHERE pws.status = 'completed' AND pws.actual_duration_hours <= (wts.expected_duration_days * 24))::FLOAT / COUNT(pws.id) FILTER (WHERE pws.status = 'completed')) * 100
        ELSE 100 
    END as performance_score
FROM project_workflow_stages pws
JOIN workflow_template_stages wts ON pws.template_stage_id = wts.id
JOIN departments d ON wts.department_id = d.id
GROUP BY d.department_name;

-- View: Bottleneck Analytics
CREATE OR REPLACE VIEW v_workflow_bottlenecks AS
SELECT
    wts.stage_name,
    d.department_name,
    AVG(EXTRACT(EPOCH FROM (pws.end_date - pws.start_date))/86400) as avg_actual_days,
    AVG(wts.expected_duration_days) as expected_days,
    (AVG(EXTRACT(EPOCH FROM (pws.end_date - pws.start_date))/86400) - AVG(wts.expected_duration_days)) as delay_gap
FROM project_workflow_stages pws
JOIN workflow_template_stages wts ON pws.template_stage_id = wts.id
JOIN departments d ON wts.department_id = d.id
WHERE pws.status = 'completed'
GROUP BY wts.stage_name, d.department_name;