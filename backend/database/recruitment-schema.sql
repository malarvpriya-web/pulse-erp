-- =====================================================
-- RECRUITMENT / ATS MODULE SCHEMA
-- =====================================================

CREATE TABLE job_requisitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_title VARCHAR(255) NOT NULL,
    department VARCHAR(100),
    employment_type VARCHAR(20) CHECK (employment_type IN ('full_time', 'contract', 'intern', 'part_time')),
    number_of_positions INTEGER NOT NULL,
    job_description TEXT,
    skills_required TEXT,
    experience_required VARCHAR(100),
    location VARCHAR(255),
    salary_range VARCHAR(100),
    requested_by UUID REFERENCES employees(id),
    status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'open', 'closed')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_job_requisitions_status ON job_requisitions(status);
CREATE INDEX idx_job_requisitions_requested_by ON job_requisitions(requested_by);

CREATE TABLE job_openings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requisition_id UUID REFERENCES job_requisitions(id),
    opening_date DATE NOT NULL,
    closing_date DATE,
    positions_filled INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'paused', 'closed')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_job_openings_requisition ON job_openings(requisition_id);
CREATE INDEX idx_job_openings_status ON job_openings(status);

CREATE TABLE recruitment_stages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stage_name VARCHAR(100) NOT NULL UNIQUE,
    stage_order INTEGER NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO recruitment_stages (stage_name, stage_order) VALUES
    ('applied', 1),
    ('screening', 2),
    ('hr_round', 3),
    ('technical_round', 4),
    ('final_round', 5),
    ('offer', 6),
    ('hired', 7),
    ('rejected', 8);

CREATE TABLE candidates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    resume_file_url VARCHAR(500),
    source VARCHAR(50) CHECK (source IN ('website', 'referral', 'linkedin', 'manual', 'job_portal', 'campus')),
    applied_job_id UUID REFERENCES job_openings(id),
    current_stage VARCHAR(100),
    overall_status VARCHAR(20) DEFAULT 'active' CHECK (overall_status IN ('active', 'rejected', 'hired', 'withdrawn')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_candidates_email ON candidates(email);
CREATE INDEX idx_candidates_job ON candidates(applied_job_id);
CREATE INDEX idx_candidates_stage ON candidates(current_stage);
CREATE INDEX idx_candidates_status ON candidates(overall_status);

CREATE TABLE candidate_stage_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    stage VARCHAR(100) NOT NULL,
    moved_by UUID REFERENCES employees(id),
    moved_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_stage_history_candidate ON candidate_stage_history(candidate_id);

CREATE TABLE interview_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    interviewer_id UUID REFERENCES employees(id),
    interview_round VARCHAR(100),
    rating DECIMAL(3,2) CHECK (rating >= 1 AND rating <= 5),
    comments TEXT,
    recommendation VARCHAR(20) CHECK (recommendation IN ('hire', 'reject', 'hold', 'strong_hire')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_interview_notes_candidate ON interview_notes(candidate_id);
CREATE INDEX idx_interview_notes_interviewer ON interview_notes(interviewer_id);

CREATE TABLE interview_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    interview_date DATE NOT NULL,
    interview_time TIME NOT NULL,
    interview_mode VARCHAR(20) CHECK (interview_mode IN ('online', 'offline', 'phone')),
    meeting_link VARCHAR(500),
    interviewer_id UUID REFERENCES employees(id),
    status VARCHAR(20) DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled', 'rescheduled')),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_interview_schedules_candidate ON interview_schedules(candidate_id);
CREATE INDEX idx_interview_schedules_interviewer ON interview_schedules(interviewer_id);
CREATE INDEX idx_interview_schedules_date ON interview_schedules(interview_date);

CREATE TABLE email_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_name VARCHAR(255) NOT NULL UNIQUE,
    template_type VARCHAR(50) CHECK (template_type IN ('application_received', 'interview_scheduled', 'interview_reminder', 'rejection', 'offer_letter', 'joining_instructions')),
    subject VARCHAR(500) NOT NULL,
    body_html TEXT NOT NULL,
    variables_json JSONB,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_email_templates_type ON email_templates(template_type);

CREATE TABLE offer_letters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    job_opening_id UUID REFERENCES job_openings(id),
    offered_salary DECIMAL(15,2) NOT NULL,
    joining_date DATE NOT NULL,
    offer_status VARCHAR(20) DEFAULT 'draft' CHECK (offer_status IN ('draft', 'sent', 'accepted', 'declined', 'withdrawn')),
    offer_sent_date DATE,
    response_date DATE,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_offer_letters_candidate ON offer_letters(candidate_id);
CREATE INDEX idx_offer_letters_status ON offer_letters(offer_status);

CREATE TABLE recruitment_emails_sent (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES candidates(id),
    template_id UUID REFERENCES email_templates(id),
    sent_to VARCHAR(255),
    subject VARCHAR(500),
    body_html TEXT,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'bounced'))
);

CREATE INDEX idx_recruitment_emails_candidate ON recruitment_emails_sent(candidate_id);

-- Trigger to auto-close job opening when filled
CREATE OR REPLACE FUNCTION check_job_opening_filled()
RETURNS TRIGGER AS $$
DECLARE
    required_positions INTEGER;
BEGIN
    SELECT number_of_positions INTO required_positions
    FROM job_requisitions
    WHERE id = (SELECT requisition_id FROM job_openings WHERE id = NEW.job_opening_id);
    
    IF (SELECT positions_filled FROM job_openings WHERE id = NEW.job_opening_id) >= required_positions THEN
        UPDATE job_openings SET status = 'closed', updated_at = CURRENT_TIMESTAMP
        WHERE id = NEW.job_opening_id;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_check_job_filled
AFTER UPDATE ON offer_letters
FOR EACH ROW
WHEN (NEW.offer_status = 'accepted' AND OLD.offer_status != 'accepted')
EXECUTE FUNCTION check_job_opening_filled();
