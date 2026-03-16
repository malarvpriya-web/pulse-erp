-- =====================================================
-- FIELD SERVICE MANAGEMENT ENHANCEMENTS
-- =====================================================

-- =====================================================
-- 1. SERVICE ENGINEER MANAGEMENT
-- =====================================================
CREATE TABLE service_engineers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL REFERENCES employees(id),
    skills TEXT[], -- Array of skills e.g. ['HVAC', 'Electrical', 'Plumbing']
    service_region VARCHAR(100),
    availability_status VARCHAR(50) DEFAULT 'Available', -- Available, On_Visit, Leave, Busy
    current_workload INTEGER DEFAULT 0, -- Count of active assigned tickets
    latitude DECIMAL(10, 8), -- For geo-location
    longitude DECIMAL(11, 8),
    last_location_update TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_engineers_region ON service_engineers(service_region);

-- =====================================================
-- 2. TICKET ENHANCEMENTS (Alter existing table)
-- =====================================================
-- Assuming 'tickets' table exists from core module

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS region VARCHAR(100);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS branch VARCHAR(100);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS service_type VARCHAR(50); -- Warranty, AMC, Chargeable, Installation
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS is_repeat_complaint BOOLEAN DEFAULT false;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS root_cause VARCHAR(255);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolution_time_hours DECIMAL(10,2);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS product_category VARCHAR(100);

-- =====================================================
-- 3. ENHANCED VISIT REPORTS
-- =====================================================
-- Extends the basic field_service_visits table

ALTER TABLE field_service_visits ADD COLUMN IF NOT EXISTS problem_found TEXT;
ALTER TABLE field_service_visits ADD COLUMN IF NOT EXISTS work_done TEXT;
ALTER TABLE field_service_visits ADD COLUMN IF NOT EXISTS next_visit_required BOOLEAN DEFAULT false;
ALTER TABLE field_service_visits ADD COLUMN IF NOT EXISTS photos_urls TEXT[];
ALTER TABLE field_service_visits ADD COLUMN IF NOT EXISTS customer_rating INTEGER;
ALTER TABLE field_service_visits ADD COLUMN IF NOT EXISTS customer_feedback TEXT;
ALTER TABLE field_service_visits ADD COLUMN IF NOT EXISTS visit_type VARCHAR(50); -- Inspection, Repair, Maintenance

-- =====================================================
-- 4. SERVICE ANALYTICS VIEWS
-- =====================================================

-- View: Service Dashboard KPIs
CREATE OR REPLACE VIEW v_service_dashboard_kpis AS
SELECT
    (SELECT COUNT(*) FROM tickets WHERE created_at::DATE = CURRENT_DATE) as registered_today,
    (SELECT COUNT(*) FROM tickets WHERE status = 'Open') as open_complaints,
    (SELECT COUNT(*) FROM tickets WHERE status = 'Closed' AND updated_at::DATE = CURRENT_DATE) as closed_today,
    (SELECT COUNT(*) FROM tickets WHERE due_date < CURRENT_TIMESTAMP AND status != 'Closed') as overdue_tickets,
    (SELECT COUNT(*) FROM field_service_visits WHERE scheduled_start::DATE = CURRENT_DATE) as visits_scheduled_today,
    -- First time fix rate: (Tickets closed without repeat / Total closed tickets) * 100
    CASE 
        WHEN (SELECT COUNT(*) FROM tickets WHERE status = 'Closed') > 0 
        THEN ((SELECT COUNT(*) FROM tickets WHERE status = 'Closed' AND is_repeat_complaint = false)::FLOAT / (SELECT COUNT(*) FROM tickets WHERE status = 'Closed')) * 100 
        ELSE 0 
    END as first_time_fix_rate;

-- View: Complaints by Region
CREATE OR REPLACE VIEW v_complaints_by_region AS
SELECT 
    region, 
    COUNT(*) as total_complaints,
    COUNT(CASE WHEN status = 'Open' THEN 1 END) as open_complaints
FROM tickets 
GROUP BY region;

-- View: Engineer Workload
CREATE OR REPLACE VIEW v_engineer_workload_stats AS
SELECT 
    e.first_name || ' ' || e.last_name as engineer_name,
    se.service_region,
    se.current_workload,
    se.availability_status
FROM service_engineers se
JOIN employees e ON se.employee_id = e.id;

COMMIT;