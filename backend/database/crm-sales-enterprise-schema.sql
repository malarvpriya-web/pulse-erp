-- =====================================================
-- CRM & SALES ENTERPRISE ENHANCEMENTS
-- =====================================================

-- =====================================================
-- 1. TERRITORY MANAGEMENT
-- =====================================================
CREATE TABLE sales_territories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    territory_name VARCHAR(100) UNIQUE NOT NULL,
    region VARCHAR(100),
    manager_id UUID REFERENCES employees(id),
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Link Employees to Territories (Many-to-Many)
CREATE TABLE sales_territory_members (
    territory_id UUID REFERENCES sales_territories(id) ON DELETE CASCADE,
    employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
    PRIMARY KEY (territory_id, employee_id)
);

-- =====================================================
-- 2. LEAD SCORING & DUPLICATE DETECTION
-- =====================================================
CREATE TABLE lead_scoring_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_name VARCHAR(100) NOT NULL,
    criteria_field VARCHAR(50) NOT NULL, -- e.g., 'source', 'industry', 'job_title'
    criteria_value VARCHAR(100) NOT NULL,
    score_points INTEGER NOT NULL, -- Can be positive or negative
    is_active BOOLEAN DEFAULT true
);

-- Add scoring and territory fields to existing leads table
-- ALTER TABLE leads ADD COLUMN score INTEGER DEFAULT 0;
-- ALTER TABLE leads ADD COLUMN territory_id UUID REFERENCES sales_territories(id);
-- ALTER TABLE leads ADD COLUMN is_duplicate BOOLEAN DEFAULT false;
-- ALTER TABLE leads ADD COLUMN duplicate_of_id UUID REFERENCES leads(id);

-- =====================================================
-- 3. SALES FORECASTING
-- =====================================================
CREATE TABLE sales_forecasts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID REFERENCES employees(id),
    territory_id UUID REFERENCES sales_territories(id),
    forecast_period_start DATE NOT NULL,
    forecast_period_end DATE NOT NULL,
    quota_amount DECIMAL(15,2) NOT NULL,
    commit_amount DECIMAL(15,2) DEFAULT 0, -- High confidence
    best_case_amount DECIMAL(15,2) DEFAULT 0, -- Potential upside
    pipeline_amount DECIMAL(15,2) DEFAULT 0, -- Total open pipe
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- 4. SALES PLAYBOOKS
-- =====================================================
CREATE TABLE sales_playbooks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    playbook_name VARCHAR(100) NOT NULL,
    applicable_stage VARCHAR(50), -- e.g., 'Qualification', 'Negotiation'
    description TEXT,
    is_active BOOLEAN DEFAULT true
);

CREATE TABLE playbook_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    playbook_id UUID REFERENCES sales_playbooks(id) ON DELETE CASCADE,
    step_order INTEGER NOT NULL,
    step_description TEXT NOT NULL,
    is_mandatory BOOLEAN DEFAULT false,
    resource_link VARCHAR(255) -- Link to scripts, templates, etc.
);

-- =====================================================
-- 5. COMPETITOR TRACKING
-- =====================================================
CREATE TABLE competitors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    competitor_name VARCHAR(100) UNIQUE NOT NULL,
    strengths TEXT,
    weaknesses TEXT,
    pricing_strategy VARCHAR(100),
    website VARCHAR(255)
);

-- Link Opportunities to Competitors (for lost deals)
-- ALTER TABLE opportunities ADD COLUMN competitor_id UUID REFERENCES competitors(id);

-- =====================================================
-- 6. ACCOUNT MANAGEMENT (Key Accounts)
-- =====================================================
CREATE TABLE account_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID REFERENCES parties(id) ON DELETE CASCADE, -- Assuming parties table holds accounts
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100),
    job_title VARCHAR(100),
    email VARCHAR(100),
    phone VARCHAR(50),
    is_primary BOOLEAN DEFAULT false,
    decision_power VARCHAR(50) -- e.g., 'Influencer', 'Decision Maker', 'Gatekeeper'
);

-- =====================================================
-- 7. ACTIVITY LOGGING (Calls & Emails)
-- =====================================================
CREATE TABLE sales_calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID REFERENCES leads(id), -- Optional
    opportunity_id UUID REFERENCES opportunities(id), -- Optional
    contact_id UUID REFERENCES account_contacts(id), -- Optional
    logged_by UUID REFERENCES employees(id),
    call_start_time TIMESTAMP NOT NULL,
    duration_minutes INTEGER,
    call_type VARCHAR(20) CHECK (call_type IN ('outbound', 'inbound')),
    outcome VARCHAR(50), -- e.g., 'Connected', 'Voicemail', 'Wrong Number'
    notes TEXT,
    recording_url VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sales_emails (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID REFERENCES leads(id),
    opportunity_id UUID REFERENCES opportunities(id),
    contact_id UUID REFERENCES account_contacts(id),
    sent_by UUID REFERENCES employees(id),
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    subject VARCHAR(255),
    body_preview TEXT,
    status VARCHAR(20) DEFAULT 'sent' -- sent, opened, clicked, replied
);

-- =====================================================
-- 8. DEAL APPROVAL WORKFLOW
-- =====================================================
CREATE TABLE deal_approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    opportunity_id UUID REFERENCES opportunities(id) ON DELETE CASCADE,
    requested_by UUID REFERENCES employees(id),
    approval_type VARCHAR(50), -- e.g., 'Discount > 20%', 'Credit Terms'
    justification TEXT,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    approved_by UUID REFERENCES employees(id),
    approved_at TIMESTAMP,
    comments TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- 9. ANALYTICS VIEWS
-- =====================================================

-- View: Sales Rep Performance Leaderboard
CREATE OR REPLACE VIEW v_sales_rep_performance AS
SELECT 
    e.id AS employee_id,
    e.first_name || ' ' || e.last_name AS sales_rep,
    COUNT(DISTINCT l.id) AS leads_owned,
    COUNT(DISTINCT o.id) AS opportunities_owned,
    SUM(CASE WHEN o.stage = 'won' THEN o.expected_value ELSE 0 END) AS revenue_won,
    AVG(CASE WHEN o.stage = 'won' THEN EXTRACT(DAY FROM (o.updated_at - o.created_at)) END) AS avg_sales_cycle_days
FROM employees e
LEFT JOIN leads l ON l.assigned_to = e.id
LEFT JOIN opportunities o ON o.assigned_to = e.id
GROUP BY e.id, e.first_name, e.last_name;