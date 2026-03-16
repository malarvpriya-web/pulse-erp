-- =====================================================
-- ATTENDANCE & LEAVE MANAGEMENT SCHEMA
-- =====================================================

-- ============ ATTENDANCE MODULE ============

CREATE TABLE shifts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shift_name VARCHAR(100) NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    grace_minutes INTEGER DEFAULT 15,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_shifts_active ON shifts(is_active);

CREATE TABLE employee_shifts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID REFERENCES employees(id),
    shift_id UUID REFERENCES shifts(id),
    effective_from DATE NOT NULL,
    effective_to DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_employee_shifts_employee ON employee_shifts(employee_id);
CREATE INDEX idx_employee_shifts_shift ON employee_shifts(shift_id);

CREATE TABLE attendance_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID REFERENCES employees(id),
    attendance_date DATE NOT NULL,
    check_in_time TIME,
    check_out_time TIME,
    total_hours DECIMAL(5,2),
    status VARCHAR(20) DEFAULT 'present' CHECK (status IN ('present', 'absent', 'half_day', 'wfh', 'on_leave')),
    late_minutes INTEGER DEFAULT 0,
    early_leave_minutes INTEGER DEFAULT 0,
    remarks TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP,
    UNIQUE(employee_id, attendance_date)
);

CREATE INDEX idx_attendance_employee ON attendance_records(employee_id);
CREATE INDEX idx_attendance_date ON attendance_records(attendance_date);
CREATE INDEX idx_attendance_status ON attendance_records(status);

CREATE TABLE attendance_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID REFERENCES employees(id),
    notification_type VARCHAR(50) CHECK (notification_type IN ('late_arrival', 'early_leave', 'absent', 'missing_checkout')),
    attendance_date DATE NOT NULL,
    late_minutes INTEGER,
    message TEXT,
    is_sent BOOLEAN DEFAULT false,
    sent_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_attendance_notifications_employee ON attendance_notifications(employee_id);
CREATE INDEX idx_attendance_notifications_date ON attendance_notifications(attendance_date);

-- ============ LEAVE MANAGEMENT MODULE ============

CREATE TABLE leave_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    leave_name VARCHAR(100) NOT NULL UNIQUE,
    leave_code VARCHAR(10) NOT NULL UNIQUE,
    annual_quota INTEGER NOT NULL,
    carry_forward_allowed BOOLEAN DEFAULT false,
    max_carry_forward INTEGER DEFAULT 0,
    encashable BOOLEAN DEFAULT false,
    requires_document BOOLEAN DEFAULT false,
    min_days_notice INTEGER DEFAULT 0,
    max_consecutive_days INTEGER,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_leave_types_active ON leave_types(is_active);

CREATE TABLE leave_balances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID REFERENCES employees(id),
    leave_type_id UUID REFERENCES leave_types(id),
    year INTEGER NOT NULL,
    allocated_days DECIMAL(5,2) NOT NULL,
    used_days DECIMAL(5,2) DEFAULT 0,
    remaining_days DECIMAL(5,2) GENERATED ALWAYS AS (allocated_days - used_days) STORED,
    carried_forward DECIMAL(5,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(employee_id, leave_type_id, year)
);

CREATE INDEX idx_leave_balances_employee ON leave_balances(employee_id);
CREATE INDEX idx_leave_balances_year ON leave_balances(year);

CREATE TABLE leave_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID REFERENCES employees(id),
    leave_type_id UUID REFERENCES leave_types(id),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    number_of_days DECIMAL(5,2) NOT NULL,
    reason TEXT NOT NULL,
    attachment_url VARCHAR(500),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Level 1 Approval (Manager)
    manager_id UUID REFERENCES employees(id),
    manager_status VARCHAR(20) CHECK (manager_status IN ('pending', 'approved', 'rejected')),
    manager_comments TEXT,
    manager_approved_at TIMESTAMP,
    
    -- Level 2 Approval (HR)
    hr_id UUID REFERENCES employees(id),
    hr_status VARCHAR(20) CHECK (hr_status IN ('pending', 'approved', 'rejected')),
    hr_comments TEXT,
    hr_approved_at TIMESTAMP,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_leave_applications_employee ON leave_applications(employee_id);
CREATE INDEX idx_leave_applications_status ON leave_applications(status);
CREATE INDEX idx_leave_applications_dates ON leave_applications(start_date, end_date);
CREATE INDEX idx_leave_applications_manager ON leave_applications(manager_id);

CREATE TABLE leave_approval_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    leave_application_id UUID REFERENCES leave_applications(id),
    approver_id UUID REFERENCES employees(id),
    approval_level INTEGER CHECK (approval_level IN (1, 2)),
    action VARCHAR(20) CHECK (action IN ('approved', 'rejected')),
    comments TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_leave_approval_history_application ON leave_approval_history(leave_application_id);

-- ============ FUNCTIONS ============

-- Function to calculate working days between two dates (excluding weekends)
CREATE OR REPLACE FUNCTION calculate_working_days(start_date DATE, end_date DATE)
RETURNS DECIMAL AS $$
DECLARE
    days DECIMAL := 0;
    current_date DATE := start_date;
BEGIN
    WHILE current_date <= end_date LOOP
        IF EXTRACT(DOW FROM current_date) NOT IN (0, 6) THEN
            days := days + 1;
        END IF;
        current_date := current_date + 1;
    END LOOP;
    RETURN days;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update leave balance on approval
CREATE OR REPLACE FUNCTION update_leave_balance()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'approved' AND OLD.status != 'approved' THEN
        UPDATE leave_balances
        SET used_days = used_days + NEW.number_of_days,
            updated_at = CURRENT_TIMESTAMP
        WHERE employee_id = NEW.employee_id
          AND leave_type_id = NEW.leave_type_id
          AND year = EXTRACT(YEAR FROM NEW.start_date);
    END IF;
    
    IF NEW.status = 'cancelled' AND OLD.status = 'approved' THEN
        UPDATE leave_balances
        SET used_days = used_days - NEW.number_of_days,
            updated_at = CURRENT_TIMESTAMP
        WHERE employee_id = NEW.employee_id
          AND leave_type_id = NEW.leave_type_id
          AND year = EXTRACT(YEAR FROM NEW.start_date);
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_leave_balance
AFTER UPDATE ON leave_applications
FOR EACH ROW
EXECUTE FUNCTION update_leave_balance();

-- ============ SEED DATA ============

-- Insert default leave types
INSERT INTO leave_types (leave_name, leave_code, annual_quota, carry_forward_allowed, max_carry_forward, encashable, requires_document)
VALUES 
    ('Casual Leave', 'CL', 12, true, 5, false, false),
    ('Sick Leave', 'SL', 12, false, 0, false, true),
    ('Earned Leave', 'EL', 15, true, 10, true, false),
    ('Maternity Leave', 'ML', 180, false, 0, false, true),
    ('Paternity Leave', 'PL', 15, false, 0, false, false);

-- Insert default shift
INSERT INTO shifts (shift_name, start_time, end_time, grace_minutes)
VALUES ('General Shift', '09:00:00', '18:00:00', 15);
