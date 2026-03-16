-- =====================================================
-- TRAVEL DESK & EXPENSE MANAGEMENT SCHEMA
-- =====================================================

-- =====================================================
-- 1. TRAVEL POLICIES
-- =====================================================
CREATE TABLE travel_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_name VARCHAR(100) NOT NULL,
    travel_type VARCHAR(20) CHECK (travel_type IN ('domestic', 'international')),
    max_hotel_per_night DECIMAL(15,2),
    daily_food_allowance DECIMAL(15,2),
    allowed_travel_class VARCHAR(50), -- Economy, Business, First
    requires_approval_above DECIMAL(15,2),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- 2. TRAVEL REQUESTS
-- =====================================================
CREATE TABLE travel_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_number VARCHAR(50) UNIQUE NOT NULL,
    employee_id UUID NOT NULL REFERENCES employees(id),
    travel_type VARCHAR(20) CHECK (travel_type IN ('domestic', 'international')),
    purpose TEXT NOT NULL,
    project_id UUID REFERENCES projects(id), -- Optional link to project
    customer_id UUID REFERENCES parties(id), -- Optional link to customer
    from_city VARCHAR(100) NOT NULL,
    to_city VARCHAR(100) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    estimated_cost DECIMAL(15,2),
    travel_mode VARCHAR(50), -- Flight, Train, Bus, Car
    accommodation_required BOOLEAN DEFAULT false,
    advance_required BOOLEAN DEFAULT false,
    advance_amount DECIMAL(15,2) DEFAULT 0,
    status VARCHAR(50) DEFAULT 'draft', -- draft, submitted, approved, booked, completed, expense_submitted, closed, rejected
    approval_level INTEGER DEFAULT 0,
    current_approver_id UUID REFERENCES employees(id),
    rejection_reason TEXT,
    policy_violation_flag BOOLEAN DEFAULT false,
    policy_violation_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_travel_employee ON travel_requests(employee_id);
CREATE INDEX idx_travel_status ON travel_requests(status);
CREATE INDEX idx_travel_dates ON travel_requests(start_date, end_date);

-- =====================================================
-- 3. TRAVEL BOOKINGS
-- =====================================================
CREATE TABLE travel_bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES travel_requests(id) ON DELETE CASCADE,
    booking_type VARCHAR(50), -- Flight, Hotel, Train, Car
    booking_reference VARCHAR(100),
    vendor_name VARCHAR(100), -- Travel Agency or Airline
    booking_date DATE,
    cost DECIMAL(15,2),
    details JSONB, -- Flight numbers, Hotel address etc.
    status VARCHAR(50) DEFAULT 'booked', -- booked, cancelled
    created_by UUID REFERENCES employees(id), -- Travel Desk Agent
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bookings_request ON travel_bookings(request_id);

-- =====================================================
-- 4. TRAVEL ADVANCES
-- =====================================================
CREATE TABLE travel_advances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES travel_requests(id) ON DELETE CASCADE,
    employee_id UUID NOT NULL REFERENCES employees(id),
    amount DECIMAL(15,2) NOT NULL,
    payment_date DATE,
    payment_mode VARCHAR(50), -- Bank Transfer, Cash, Card
    status VARCHAR(50) DEFAULT 'requested', -- requested, approved, paid, adjusted
    finance_approver_id UUID REFERENCES employees(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- 5. TRAVEL EXPENSES & CLAIMS
-- =====================================================
CREATE TABLE travel_expense_claims (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_number VARCHAR(50) UNIQUE NOT NULL,
    request_id UUID NOT NULL REFERENCES travel_requests(id),
    employee_id UUID NOT NULL REFERENCES employees(id),
    submission_date DATE DEFAULT CURRENT_DATE,
    total_amount DECIMAL(15,2) DEFAULT 0,
    advance_adjusted DECIMAL(15,2) DEFAULT 0,
    reimbursement_amount DECIMAL(15,2) GENERATED ALWAYS AS (total_amount - advance_adjusted) STORED,
    status VARCHAR(50) DEFAULT 'submitted', -- submitted, approved, paid, rejected
    finance_approver_id UUID REFERENCES employees(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE travel_expense_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id UUID NOT NULL REFERENCES travel_expense_claims(id) ON DELETE CASCADE,
    expense_date DATE NOT NULL,
    category VARCHAR(50) NOT NULL, -- Flight, Hotel, Food, Transport, Misc
    amount DECIMAL(15,2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'USD',
    description TEXT,
    has_bill BOOLEAN DEFAULT true,
    bill_attachment_url VARCHAR(500),
    is_policy_compliant BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- 6. ADVANCED FEATURES
-- =====================================================

-- Emergency Contacts for Trips
CREATE TABLE travel_emergency_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES travel_requests(id) ON DELETE CASCADE,
    contact_name VARCHAR(100) NOT NULL,
    relationship VARCHAR(50),
    phone_number VARCHAR(50) NOT NULL,
    email VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Travel Vendors
CREATE TABLE travel_vendors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_name VARCHAR(100) NOT NULL,
    service_type VARCHAR(50), -- Agency, Airline, Hotel Chain
    contact_person VARCHAR(100),
    email VARCHAR(100),
    phone VARCHAR(50),
    rating DECIMAL(3,2),
    is_active BOOLEAN DEFAULT true
);

-- =====================================================
-- 7. ANALYTICS VIEWS
-- =====================================================

-- View: Travel Dashboard KPIs
CREATE OR REPLACE VIEW v_travel_dashboard_kpis AS
SELECT
    (SELECT COUNT(*) FROM travel_requests WHERE created_at::DATE >= date_trunc('month', CURRENT_DATE)) as requests_this_month,
    (SELECT COUNT(*) FROM travel_requests WHERE start_date > CURRENT_DATE AND status = 'approved') as upcoming_trips,
    (SELECT COUNT(*) FROM travel_requests WHERE CURRENT_DATE BETWEEN start_date AND end_date AND status IN ('booked', 'approved')) as trips_in_progress,
    (SELECT COALESCE(SUM(total_amount), 0) FROM travel_expense_claims WHERE submission_date >= date_trunc('month', CURRENT_DATE)) as expenses_this_month,
    (SELECT COUNT(*) FROM travel_expense_claims WHERE status = 'submitted') as pending_reimbursements,
    (SELECT COUNT(*) FROM travel_requests WHERE status IN ('submitted', 'draft')) as pending_approvals;

-- View: Travel Spend by Department
CREATE OR REPLACE VIEW v_travel_spend_by_dept AS
SELECT 
    d.department_name,
    COALESCE(SUM(tec.total_amount), 0) as total_spend
FROM travel_expense_claims tec
JOIN employees e ON tec.employee_id = e.id
JOIN departments d ON e.department_id = d.id
WHERE tec.status = 'paid'
GROUP BY d.department_name;