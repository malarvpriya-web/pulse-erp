-- =====================================================
-- SERVICE DESK & FIELD SERVICE ENTERPRISE SCHEMA
-- =====================================================

-- =====================================================
-- 1. KNOWLEDGE BASE & SELF SERVICE
-- =====================================================
CREATE TABLE knowledge_base_articles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    category_id UUID REFERENCES ticket_categories(id),
    tags TEXT[],
    is_public BOOLEAN DEFAULT false,
    view_count INTEGER DEFAULT 0,
    helpful_count INTEGER DEFAULT 0,
    created_by UUID, -- References employees(id)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE canned_responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(100) NOT NULL,
    message TEXT NOT NULL,
    category_id UUID REFERENCES ticket_categories(id),
    created_by UUID, -- References employees(id)
    is_global BOOLEAN DEFAULT false
);

-- =====================================================
-- 2. CUSTOMER SATISFACTION (CSAT)
-- =====================================================
CREATE TABLE csat_surveys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    comments TEXT,
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- 3. SERVICE CONTRACTS (AMC / SLA)
-- =====================================================
CREATE TABLE service_contracts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_number VARCHAR(50) UNIQUE NOT NULL,
    customer_id UUID NOT NULL REFERENCES parties(id),
    contract_name VARCHAR(255),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    sla_policy_id UUID REFERENCES sla_policies(id),
    status VARCHAR(20) DEFAULT 'Active', -- Active, Expired, Cancelled
    value DECIMAL(15,2),
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Link tickets to contracts (Optional: Run manually if needed)
-- ALTER TABLE tickets ADD COLUMN contract_id UUID REFERENCES service_contracts(id);

-- =====================================================
-- 4. FIELD SERVICE MANAGEMENT
-- =====================================================
CREATE TABLE field_service_visits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL REFERENCES tickets(id),
    technician_id UUID, -- References employees(id)
    scheduled_start TIMESTAMP,
    scheduled_end TIMESTAMP,
    actual_start TIMESTAMP,
    actual_end TIMESTAMP,
    status VARCHAR(20) DEFAULT 'Scheduled', -- Scheduled, In_Progress, Completed, Cancelled
    visit_notes TEXT,
    customer_signature_url VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_fsm_ticket ON field_service_visits(ticket_id);
CREATE INDEX idx_fsm_tech ON field_service_visits(technician_id);

CREATE TABLE service_visit_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    visit_id UUID NOT NULL REFERENCES field_service_visits(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES inventory_items(id),
    quantity DECIMAL(10,2) NOT NULL,
    is_billable BOOLEAN DEFAULT true,
    cost DECIMAL(15,2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- 5. AUTOMATION & ESCALATION
-- =====================================================
CREATE TABLE ticket_escalation_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_name VARCHAR(100) NOT NULL,
    condition_criteria JSONB, -- e.g. { "priority": "High", "overdue_hours": 4 }
    action_type VARCHAR(50), -- "Notify_Manager", "Reassign", "Change_Priority"
    action_target UUID, -- Employee ID or Role ID
    is_active BOOLEAN DEFAULT true
);

-- =====================================================
-- 6. ANALYTICS VIEWS
-- =====================================================
CREATE OR REPLACE VIEW v_agent_performance AS
SELECT 
    t.assigned_to AS agent_id,
    COUNT(t.id) AS total_assigned,
    COUNT(CASE WHEN t.status = 'Resolved' THEN 1 END) AS resolved_count,
    AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at))/3600)::NUMERIC(10,2) AS avg_resolution_hours,
    AVG(cs.rating)::NUMERIC(3,2) AS avg_csat
FROM tickets t
LEFT JOIN csat_surveys cs ON cs.ticket_id = t.id
GROUP BY t.assigned_to;