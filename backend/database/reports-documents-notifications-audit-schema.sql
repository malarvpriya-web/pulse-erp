-- =====================================================
-- REPORTS, DOCUMENTS, NOTIFICATIONS, AUDIT & ORGCHART SCHEMA
-- =====================================================

-- ============ REPORTS ENGINE ============

CREATE TABLE saved_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_name VARCHAR(255) NOT NULL,
    module_name VARCHAR(100) NOT NULL,
    report_type VARCHAR(100),
    filters_json JSONB,
    columns_json JSONB,
    created_by UUID REFERENCES employees(id),
    is_public BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_saved_reports_module ON saved_reports(module_name);
CREATE INDEX idx_saved_reports_created_by ON saved_reports(created_by);

CREATE TABLE scheduled_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id UUID REFERENCES saved_reports(id),
    schedule_type VARCHAR(50) CHECK (schedule_type IN ('daily', 'weekly', 'monthly')),
    schedule_time TIME,
    schedule_day INTEGER,
    recipients_json JSONB,
    last_run_at TIMESTAMP,
    next_run_at TIMESTAMP,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_scheduled_reports_next_run ON scheduled_reports(next_run_at);

-- ============ DOCUMENT GENERATOR ============

CREATE TABLE document_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_name VARCHAR(255) NOT NULL,
    document_type VARCHAR(100) CHECK (document_type IN ('offer_letter', 'appointment_letter', 'experience_letter', 'warning_letter', 'relieving_letter', 'purchase_order', 'quotation', 'invoice', 'contract')),
    template_html TEXT NOT NULL,
    variables_json JSONB,
    is_active BOOLEAN DEFAULT true,
    version INTEGER DEFAULT 1,
    created_by UUID REFERENCES employees(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_document_templates_type ON document_templates(document_type);

CREATE TABLE generated_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID REFERENCES document_templates(id),
    document_type VARCHAR(100),
    reference_id UUID,
    reference_type VARCHAR(100),
    document_data_json JSONB,
    file_path VARCHAR(500),
    generated_by UUID REFERENCES employees(id),
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_generated_documents_reference ON generated_documents(reference_id, reference_type);
CREATE INDEX idx_generated_documents_type ON generated_documents(document_type);

-- ============ ORGANIZATION CHART ============

CREATE TABLE org_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID REFERENCES employees(id) UNIQUE,
    manager_id UUID REFERENCES employees(id),
    department VARCHAR(100),
    position_level INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_org_relationships_employee ON org_relationships(employee_id);
CREATE INDEX idx_org_relationships_manager ON org_relationships(manager_id);
CREATE INDEX idx_org_relationships_department ON org_relationships(department);

-- ============ NOTIFICATION CENTER ============

CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES employees(id),
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    module_name VARCHAR(100),
    reference_id UUID,
    notification_type VARCHAR(50) CHECK (notification_type IN ('info', 'success', 'warning', 'error', 'approval')),
    is_read BOOLEAN DEFAULT false,
    read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_is_read ON notifications(is_read);
CREATE INDEX idx_notifications_created_at ON notifications(created_at);
CREATE INDEX idx_notifications_module ON notifications(module_name);

CREATE TABLE notification_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES employees(id) UNIQUE,
    email_notifications BOOLEAN DEFAULT true,
    push_notifications BOOLEAN DEFAULT true,
    notification_types_json JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_notification_preferences_user ON notification_preferences(user_id);

-- ============ AUDIT LOG ============

CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES employees(id),
    module_name VARCHAR(100) NOT NULL,
    action_type VARCHAR(50) CHECK (action_type IN ('create', 'update', 'delete', 'approve', 'reject', 'login', 'logout', 'export', 'view')),
    reference_id UUID,
    reference_type VARCHAR(100),
    old_data_json JSONB,
    new_data_json JSONB,
    ip_address VARCHAR(50),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_module ON audit_logs(module_name);
CREATE INDEX idx_audit_logs_action ON audit_logs(action_type);
CREATE INDEX idx_audit_logs_reference ON audit_logs(reference_id, reference_type);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);

-- ============ SYSTEM LOGS ============

CREATE TABLE system_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    log_level VARCHAR(20) CHECK (log_level IN ('info', 'warning', 'error', 'critical')),
    module_name VARCHAR(100),
    message TEXT NOT NULL,
    error_stack TEXT,
    metadata_json JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_system_logs_level ON system_logs(log_level);
CREATE INDEX idx_system_logs_module ON system_logs(module_name);
CREATE INDEX idx_system_logs_created_at ON system_logs(created_at);
