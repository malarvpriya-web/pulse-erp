-- =====================================================
-- PROJECT MANAGEMENT, TIMESHEETS & PERFORMANCE SCHEMA
-- =====================================================

-- ============ PROJECT MANAGEMENT MODULE ============

CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_code VARCHAR(50) UNIQUE NOT NULL,
    project_name VARCHAR(255) NOT NULL,
    customer_id UUID REFERENCES parties(id),
    start_date DATE NOT NULL,
    end_date DATE,
    project_manager_id UUID REFERENCES employees(id),
    status VARCHAR(20) DEFAULT 'planning' CHECK (status IN ('planning', 'active', 'on_hold', 'completed', 'cancelled')),
    billing_model VARCHAR(50) CHECK (billing_model IN ('fixed', 'time_material', 'milestone', 'retainer')),
    project_type VARCHAR(20) DEFAULT 'external' CHECK (project_type IN ('internal', 'external')),
    health_score DECIMAL(5,2) DEFAULT 100,
    is_frozen BOOLEAN DEFAULT false,
    budget_amount DECIMAL(15,2) DEFAULT 0,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by UUID,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_projects_customer ON projects(customer_id);
CREATE INDEX idx_projects_manager ON projects(project_manager_id);
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_code ON projects(project_code);

CREATE TABLE project_team_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    employee_id UUID REFERENCES employees(id),
    role VARCHAR(50) CHECK (role IN ('manager', 'developer', 'tester', 'support', 'analyst', 'designer')),
    allocation_percentage DECIMAL(5,2) DEFAULT 100,
    cost_rate DECIMAL(15,2), -- Hourly cost to company
    billing_rate DECIMAL(15,2), -- Hourly rate billed to client
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_team_project ON project_team_members(project_id);
CREATE INDEX idx_team_employee ON project_team_members(employee_id);

CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    task_title VARCHAR(255) NOT NULL,
    parent_task_id UUID REFERENCES tasks(id), -- For WBS Hierarchy
    wbs_code VARCHAR(50), -- e.g., 1.1, 1.1.2
    task_description TEXT,
    assigned_to UUID REFERENCES employees(id),
    priority VARCHAR(20) DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    status VARCHAR(20) DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'review', 'done', 'blocked')),
    start_date DATE,
    due_date DATE,
    estimated_hours DECIMAL(8,2),
    actual_hours DECIMAL(8,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by UUID,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_assigned ON tasks(assigned_to);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_due_date ON tasks(due_date);

CREATE TABLE project_milestones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    milestone_name VARCHAR(255) NOT NULL,
    milestone_date DATE NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'achieved', 'missed')),
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_milestones_project ON project_milestones(project_id);

CREATE TABLE project_cost_summary (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    labour_cost DECIMAL(15,2) DEFAULT 0,
    material_cost DECIMAL(15,2) DEFAULT 0,
    expense_cost DECIMAL(15,2) DEFAULT 0,
    total_cost DECIMAL(15,2) GENERATED ALWAYS AS (labour_cost + material_cost + expense_cost) STORED,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_cost_project ON project_cost_summary(project_id);

-- ============ TIMESHEET MODULE ============

CREATE TABLE timesheet_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID REFERENCES employees(id),
    project_id UUID REFERENCES projects(id),
    task_id UUID REFERENCES tasks(id),
    work_date DATE NOT NULL,
    hours_worked DECIMAL(5,2) NOT NULL CHECK (hours_worked > 0 AND hours_worked <= 24),
    description TEXT,
    is_billable BOOLEAN DEFAULT true,
    is_locked BOOLEAN DEFAULT false, -- Locked after payroll/invoicing
    payroll_period_id UUID,
    status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
    submitted_at TIMESTAMP,
    approved_at TIMESTAMP,
    approved_by UUID REFERENCES employees(id),
    rejection_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_timesheet_employee ON timesheet_entries(employee_id);
CREATE INDEX idx_timesheet_project ON timesheet_entries(project_id);
CREATE INDEX idx_timesheet_task ON timesheet_entries(task_id);
CREATE INDEX idx_timesheet_date ON timesheet_entries(work_date);
CREATE INDEX idx_timesheet_status ON timesheet_entries(status);

CREATE TABLE timesheet_approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID REFERENCES employees(id),
    week_start_date DATE NOT NULL,
    week_end_date DATE NOT NULL,
    total_hours DECIMAL(8,2),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    approved_by UUID REFERENCES employees(id),
    approved_at TIMESTAMP,
    comments TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_approval_employee ON timesheet_approvals(employee_id);
CREATE INDEX idx_approval_week ON timesheet_approvals(week_start_date);

-- ============ PERFORMANCE MANAGEMENT MODULE ============

CREATE TABLE performance_goals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID REFERENCES employees(id),
    review_period VARCHAR(20) NOT NULL,
    goal_title VARCHAR(255) NOT NULL,
    goal_description TEXT,
    target_value VARCHAR(100),
    weightage DECIMAL(5,2) DEFAULT 0 CHECK (weightage >= 0 AND weightage <= 100),
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'achieved', 'not_achieved', 'cancelled')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_goals_employee ON performance_goals(employee_id);
CREATE INDEX idx_goals_period ON performance_goals(review_period);

CREATE TABLE performance_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID REFERENCES employees(id),
    review_period VARCHAR(20) NOT NULL,
    review_type VARCHAR(20) DEFAULT 'annual' CHECK (review_type IN ('quarterly', 'half_yearly', 'annual')),
    
    -- Self Review
    self_rating DECIMAL(3,2) CHECK (self_rating >= 1 AND self_rating <= 5),
    self_comments TEXT,
    achievements TEXT,
    challenges TEXT,
    self_submitted_at TIMESTAMP,
    
    -- Manager Review
    manager_id UUID REFERENCES employees(id),
    manager_rating DECIMAL(3,2) CHECK (manager_rating >= 1 AND manager_rating <= 5),
    manager_comments TEXT,
    promotion_recommendation BOOLEAN DEFAULT false,
    salary_revision_percentage DECIMAL(5,2),
    manager_submitted_at TIMESTAMP,
    
    -- Final
    final_rating DECIMAL(3,2),
    status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'self_submitted', 'manager_review', 'completed', 'cancelled')),
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_reviews_employee ON performance_reviews(employee_id);
CREATE INDEX idx_reviews_manager ON performance_reviews(manager_id);
CREATE INDEX idx_reviews_period ON performance_reviews(review_period);
CREATE INDEX idx_reviews_status ON performance_reviews(status);

CREATE TABLE performance_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id UUID REFERENCES performance_reviews(id) ON DELETE CASCADE,
    feedback_from UUID REFERENCES employees(id),
    feedback_type VARCHAR(20) DEFAULT 'peer' CHECK (feedback_type IN ('peer', 'subordinate', 'manager')),
    rating DECIMAL(3,2) CHECK (rating >= 1 AND rating <= 5),
    comments TEXT,
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_feedback_review ON performance_feedback(review_id);
CREATE INDEX idx_feedback_from ON performance_feedback(feedback_from);

CREATE TABLE performance_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID REFERENCES employees(id),
    review_period VARCHAR(20) NOT NULL,
    final_rating DECIMAL(3,2),
    promotion_given BOOLEAN DEFAULT false,
    salary_revision_percentage DECIMAL(5,2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_history_employee ON performance_history(employee_id);

-- ============ AUDIT LOG ============

CREATE TABLE project_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_name VARCHAR(100),
    record_id UUID,
    action VARCHAR(20),
    old_values JSONB,
    new_values JSONB,
    changed_by UUID,
    changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_project_audit_table ON project_audit_log(table_name);
CREATE INDEX idx_project_audit_record ON project_audit_log(record_id);
