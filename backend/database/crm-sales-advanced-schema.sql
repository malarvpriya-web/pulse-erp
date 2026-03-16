-- =====================================================
-- CRM & SALES ADVANCED OPERATIONS SCHEMA
-- =====================================================

-- =====================================================
-- 1. ACCOUNTS & CONTACTS (B2B Structure)
-- =====================================================
-- Accounts are companies/organizations
CREATE TABLE crm_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_name VARCHAR(255) NOT NULL,
    industry VARCHAR(100),
    website VARCHAR(255),
    phone VARCHAR(50),
    billing_address TEXT,
    shipping_address TEXT,
    account_owner_id UUID REFERENCES employees(id),
    parent_account_id UUID REFERENCES crm_accounts(id),
    segment VARCHAR(50), -- Enterprise, Mid-Market, SMB
    status VARCHAR(50) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Contacts are people within accounts
CREATE TABLE crm_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID REFERENCES crm_accounts(id) ON DELETE CASCADE,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(100),
    phone VARCHAR(50),
    job_title VARCHAR(100),
    department VARCHAR(100),
    is_primary BOOLEAN DEFAULT false,
    decision_role VARCHAR(50), -- Decision Maker, Influencer, Champion, Gatekeeper
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Multi-contact opportunities (Many-to-Many)
CREATE TABLE opportunity_contacts (
    opportunity_id UUID REFERENCES opportunities(id) ON DELETE CASCADE,
    contact_id UUID REFERENCES crm_contacts(id) ON DELETE CASCADE,
    role VARCHAR(50), -- Technical Evaluator, Business User, etc.
    is_primary BOOLEAN DEFAULT false,
    PRIMARY KEY (opportunity_id, contact_id)
);

-- =====================================================
-- 2. PRICE BOOKS & DISCOUNT CONTROL
-- =====================================================
CREATE TABLE price_books (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    book_name VARCHAR(100) NOT NULL,
    currency VARCHAR(10) DEFAULT 'USD',
    is_active BOOLEAN DEFAULT true,
    is_standard BOOLEAN DEFAULT false,
    description TEXT,
    valid_from DATE,
    valid_to DATE
);

CREATE TABLE price_book_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    price_book_id UUID REFERENCES price_books(id) ON DELETE CASCADE,
    item_id UUID REFERENCES inventory_items(id) ON DELETE CASCADE,
    list_price DECIMAL(15,2) NOT NULL,
    min_price DECIMAL(15,2), -- Floor price for discounts
    is_active BOOLEAN DEFAULT true,
    UNIQUE(price_book_id, item_id)
);

-- =====================================================
-- 3. SUBSCRIPTIONS & RENEWALS
-- =====================================================
CREATE TABLE subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_number VARCHAR(50) UNIQUE NOT NULL,
    account_id UUID REFERENCES crm_accounts(id),
    opportunity_id UUID REFERENCES opportunities(id),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    renewal_date DATE,
    status VARCHAR(50) DEFAULT 'active', -- active, expired, cancelled, renewed
    mrr DECIMAL(15,2) DEFAULT 0, -- Monthly Recurring Revenue
    arr DECIMAL(15,2) DEFAULT 0, -- Annual Recurring Revenue
    billing_frequency VARCHAR(20) DEFAULT 'monthly', -- monthly, quarterly, annual
    auto_renew BOOLEAN DEFAULT true,
    cancellation_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_subs_renewal ON subscriptions(renewal_date);
CREATE INDEX idx_subs_account ON subscriptions(account_id);

-- =====================================================
-- 4. PARTNER / CHANNEL SALES
-- =====================================================
CREATE TABLE sales_partners (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_name VARCHAR(255) NOT NULL,
    partner_type VARCHAR(50), -- Reseller, Distributor, Referral, SI
    status VARCHAR(50) DEFAULT 'active',
    agreement_start_date DATE,
    agreement_end_date DATE,
    commission_rate DECIMAL(5,2) DEFAULT 0,
    primary_contact_name VARCHAR(100),
    primary_contact_email VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Link Opportunities to Partners
-- ALTER TABLE opportunities ADD COLUMN partner_id UUID REFERENCES sales_partners(id);

-- =====================================================
-- 5. SALES ACTIVITIES & CALENDAR
-- =====================================================
-- Enhanced activity tracking for calendar view
CREATE TABLE sales_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject VARCHAR(255) NOT NULL,
    activity_type VARCHAR(50), -- Call, Email, Meeting, Demo, Follow-up
    due_date TIMESTAMP,
    status VARCHAR(50) DEFAULT 'open', -- open, completed, deferred
    priority VARCHAR(20) DEFAULT 'medium',
    assigned_to UUID REFERENCES employees(id),
    related_to_type VARCHAR(50), -- lead, opportunity, account, contact
    related_to_id UUID,
    description TEXT,
    reminder_at TIMESTAMP,
    is_reminder_sent BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_sales_tasks_assigned ON sales_tasks(assigned_to);
CREATE INDEX idx_sales_tasks_due ON sales_tasks(due_date);

-- =====================================================
-- 6. SALES DOCUMENT LIBRARY
-- =====================================================
CREATE TABLE sales_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_name VARCHAR(255) NOT NULL,
    category VARCHAR(50), -- Proposal, Contract, Case Study, Datasheet
    file_url VARCHAR(500) NOT NULL,
    file_type VARCHAR(50),
    file_size INTEGER,
    related_to_type VARCHAR(50), -- opportunity, account
    related_to_id UUID,
    uploaded_by UUID REFERENCES employees(id),
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_public BOOLEAN DEFAULT false -- Accessible to partners?
);

-- =====================================================
-- 7. ANALYTICS VIEWS
-- =====================================================

-- View: Deal Aging Report
CREATE OR REPLACE VIEW v_deal_aging AS
SELECT 
    o.id,
    o.opportunity_name,
    o.stage,
    o.assigned_to,
    o.created_at,
    EXTRACT(DAY FROM (NOW() - o.created_at)) AS age_days,
    EXTRACT(DAY FROM (NOW() - o.updated_at)) AS days_since_last_update
FROM opportunities o
WHERE o.stage NOT IN ('won', 'lost');

-- View: Pipeline Coverage
CREATE OR REPLACE VIEW v_pipeline_coverage AS
SELECT 
    e.id AS employee_id,
    e.first_name || ' ' || e.last_name AS sales_rep,
    COALESCE(st.target_amount, 0) AS quota,
    COALESCE(SUM(o.expected_value), 0) AS pipeline_amount,
    CASE WHEN COALESCE(st.target_amount, 0) > 0 
         THEN COALESCE(SUM(o.expected_value), 0) / st.target_amount 
         ELSE 0 END AS coverage_ratio
FROM employees e
LEFT JOIN sales_targets st ON st.employee_id = e.id AND st.month = date_trunc('month', CURRENT_DATE)
LEFT JOIN opportunities o ON o.assigned_to = e.id AND o.stage NOT IN ('won', 'lost') AND o.expected_closing_date BETWEEN date_trunc('month', CURRENT_DATE) AND (date_trunc('month', CURRENT_DATE) + interval '1 month - 1 day')
GROUP BY e.id, e.first_name, e.last_name, st.target_amount;