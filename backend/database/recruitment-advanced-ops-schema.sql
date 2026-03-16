-- =====================================================
-- RECRUITMENT ADVANCED OPERATIONS SCHEMA
-- =====================================================

-- =====================================================
-- 1. JOB DESCRIPTION & POSTING ENHANCEMENTS
-- =====================================================

-- Add fields to job_openings for internal/external posting
-- ALTER TABLE job_openings ADD COLUMN posting_type VARCHAR(20) DEFAULT 'external' CHECK (posting_type IN ('internal', 'external', 'both'));
-- ALTER TABLE job_openings ADD COLUMN is_public BOOLEAN DEFAULT false; -- For career website integration

CREATE TABLE job_description_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_opening_id UUID NOT NULL REFERENCES job_openings(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    description_text TEXT NOT NULL,
    changed_by UUID REFERENCES employees(id),
    changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_jd_versions_job ON job_description_versions(job_opening_id);

-- =====================================================
-- 2. TALENT PIPELINE & SOURCING
-- =====================================================

-- Add fields to candidates table
-- ALTER TABLE candidates ADD COLUMN agency_id UUID REFERENCES recruitment_agencies(id);
-- ALTER TABLE candidates ADD COLUMN consent_given BOOLEAN DEFAULT false;
-- ALTER TABLE candidates ADD COLUMN data_retention_expiry_date DATE;

CREATE TABLE talent_pools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    owner_id UUID REFERENCES employees(id)
);

CREATE TABLE candidate_talent_pools (
    candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    pool_id UUID NOT NULL REFERENCES talent_pools(id) ON DELETE CASCADE,
    PRIMARY KEY (candidate_id, pool_id)
);

CREATE TABLE recruitment_agencies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_name VARCHAR(255) UNIQUE NOT NULL,
    contact_person VARCHAR(100),
    email VARCHAR(100),
    phone VARCHAR(50),
    commission_rate DECIMAL(5,2),
    status VARCHAR(20) DEFAULT 'active'
);

-- =====================================================
-- 3. INTERVIEW & OFFER PROCESS
-- =====================================================

CREATE TABLE interview_question_bank (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category VARCHAR(100) NOT NULL, -- e.g., 'Behavioral', 'Technical - Java', 'System Design'
    question_text TEXT NOT NULL,
    difficulty_level VARCHAR(20) DEFAULT 'medium',
    created_by UUID
);

CREATE TABLE hiring_committee_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    job_opening_id UUID NOT NULL REFERENCES job_openings(id) ON DELETE CASCADE,
    member_id UUID NOT NULL REFERENCES employees(id),
    decision VARCHAR(20) NOT NULL CHECK (decision IN ('strong_hire', 'hire', 'no_hire', 'hold')),
    feedback TEXT,
    decision_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_hiring_decisions_candidate ON hiring_committee_decisions(candidate_id, job_opening_id);

-- Add fields to offer_letters table
-- ALTER TABLE offer_letters ADD COLUMN rejection_reason VARCHAR(255);
-- ALTER TABLE offer_letters ADD COLUMN rejection_notes TEXT;
-- ALTER TABLE offer_letters ADD COLUMN onboarding_triggered BOOLEAN DEFAULT false;

CREATE TABLE offer_negotiation_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    offer_id UUID NOT NULL REFERENCES offer_letters(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    offered_salary DECIMAL(15,2),
    other_benefits TEXT,
    negotiation_notes TEXT,
    status VARCHAR(50), -- 'Company Offer', 'Candidate Counter', 'Finalized'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- 4. ONBOARDING & COMPLIANCE
-- =====================================================

CREATE TABLE pre_joining_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    document_type VARCHAR(100) NOT NULL, -- 'ID Proof', 'Education Certificate', 'Previous Employment'
    file_url VARCHAR(500),
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'uploaded', 'verified', 'rejected')),
    verified_by UUID,
    verified_at TIMESTAMP
);

-- =====================================================
-- 5. FORECASTING & ANALYTICS
-- =====================================================

CREATE TABLE hiring_forecasts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id UUID,
    job_role VARCHAR(100) NOT NULL,
    forecast_period VARCHAR(20) NOT NULL, -- e.g., '2025-Q1'
    predicted_openings INTEGER NOT NULL,
    notes TEXT,
    created_by UUID,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE VIEW v_sourcing_roi AS
SELECT
    c.source,
    COUNT(c.id) AS total_candidates,
    COUNT(ol.id) AS total_hires,
    (SELECT SUM(rc.amount) FROM recruitment_costs rc WHERE rc.cost_type = c.source) AS total_cost,
    CASE
        WHEN COUNT(ol.id) > 0 THEN (SELECT SUM(rc.amount) FROM recruitment_costs rc WHERE rc.cost_type = c.source) / COUNT(ol.id)
        ELSE 0
    END AS cost_per_hire
FROM candidates c
LEFT JOIN offer_letters ol ON c.id = ol.candidate_id AND ol.offer_status = 'accepted'
GROUP BY c.source;

CREATE OR REPLACE VIEW v_offer_drop_analytics AS
SELECT
    ol.rejection_reason,
    COUNT(ol.id) AS drop_count,
    jo.job_title,
    jr.department
FROM offer_letters ol
JOIN job_openings jo ON ol.job_opening_id = jo.id
JOIN job_requisitions jr ON jo.requisition_id = jr.id
WHERE ol.offer_status = 'rejected' AND ol.rejection_reason IS NOT NULL
GROUP BY ol.rejection_reason, jo.job_title, jr.department;

COMMIT;