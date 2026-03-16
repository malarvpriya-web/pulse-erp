-- =====================================================
-- RECRUITMENT MODULE - SAMPLE DATA FOR TESTING
-- =====================================================

-- Insert sample email templates
INSERT INTO email_templates (template_name, template_type, subject, body_html, variables_json) VALUES
('Application Received', 'application_received', 'Application Received - {{job_title}}', 
'<p>Dear {{candidate_name}},</p><p>Thank you for applying for the position of <strong>{{job_title}}</strong> at our company.</p><p>We have received your application and our team will review it shortly.</p><p>Best regards,<br>HR Team</p>', 
'{"candidate_name": "string", "job_title": "string"}'),

('Interview Scheduled', 'interview_scheduled', 'Interview Scheduled - {{job_title}}',
'<p>Dear {{candidate_name}},</p><p>We are pleased to invite you for an interview for the position of <strong>{{job_title}}</strong>.</p><p><strong>Date:</strong> {{interview_date}}<br><strong>Time:</strong> {{interview_time}}<br><strong>Meeting Link:</strong> {{meeting_link}}</p><p>Please confirm your availability.</p><p>Best regards,<br>HR Team</p>',
'{"candidate_name": "string", "job_title": "string", "interview_date": "string", "interview_time": "string", "meeting_link": "string"}'),

('Interview Reminder', 'interview_reminder', 'Interview Reminder - Tomorrow',
'<p>Dear {{candidate_name}},</p><p>This is a reminder about your interview scheduled for tomorrow.</p><p><strong>Position:</strong> {{job_title}}<br><strong>Date:</strong> {{interview_date}}<br><strong>Time:</strong> {{interview_time}}<br><strong>Meeting Link:</strong> {{meeting_link}}</p><p>We look forward to meeting you!</p><p>Best regards,<br>HR Team</p>',
'{"candidate_name": "string", "job_title": "string", "interview_date": "string", "interview_time": "string", "meeting_link": "string"}'),

('Rejection Email', 'rejection', 'Application Status - {{job_title}}',
'<p>Dear {{candidate_name}},</p><p>Thank you for your interest in the position of <strong>{{job_title}}</strong> and for taking the time to interview with us.</p><p>After careful consideration, we have decided to move forward with other candidates whose qualifications more closely match our current needs.</p><p>We appreciate your interest in our company and wish you the best in your job search.</p><p>Best regards,<br>HR Team</p>',
'{"candidate_name": "string", "job_title": "string"}'),

('Offer Letter', 'offer_letter', 'Job Offer - {{job_title}}',
'<p>Dear {{candidate_name}},</p><p>We are delighted to offer you the position of <strong>{{job_title}}</strong> at {{company_name}}.</p><p><strong>Salary:</strong> {{offered_salary}}<br><strong>Joining Date:</strong> {{joining_date}}</p><p>Please review the attached offer letter and let us know your decision.</p><p>We look forward to welcoming you to our team!</p><p>Best regards,<br>HR Team</p>',
'{"candidate_name": "string", "job_title": "string", "company_name": "string", "offered_salary": "string", "joining_date": "string"}'),

('Joining Instructions', 'joining_instructions', 'Welcome to {{company_name}} - Joining Instructions',
'<p>Dear {{candidate_name}},</p><p>Welcome to {{company_name}}! We are excited to have you join our team.</p><p><strong>Your Joining Date:</strong> {{joining_date}}<br><strong>Position:</strong> {{job_title}}</p><p><strong>What to bring:</strong></p><ul><li>Government-issued ID</li><li>Educational certificates</li><li>Previous employment documents</li><li>Bank account details</li></ul><p><strong>Reporting Time:</strong> 9:00 AM<br><strong>Reporting Location:</strong> HR Department</p><p>If you have any questions, please feel free to contact us.</p><p>See you soon!<br>HR Team</p>',
'{"candidate_name": "string", "job_title": "string", "company_name": "string", "joining_date": "string"}');

-- Sample job requisitions (assuming employee with id exists)
-- Note: Replace the UUID with actual employee ID from your employees table
INSERT INTO job_requisitions (job_title, department, employment_type, number_of_positions, job_description, skills_required, experience_required, location, salary_range, status) VALUES
('Senior Full Stack Developer', 'Engineering', 'full_time', 2, 
'We are looking for an experienced Full Stack Developer to join our engineering team. You will be responsible for developing and maintaining web applications using modern technologies.',
'React, Node.js, PostgreSQL, AWS, Docker',
'5-7 years',
'Remote / Hybrid',
'$90,000 - $120,000',
'approved'),

('Product Manager', 'Product', 'full_time', 1,
'Seeking a Product Manager to lead product strategy and roadmap. You will work closely with engineering, design, and business teams.',
'Product Strategy, Agile, User Research, Analytics',
'3-5 years',
'New York, NY',
'$100,000 - $130,000',
'approved'),

('UI/UX Designer', 'Design', 'full_time', 1,
'Looking for a creative UI/UX Designer to create beautiful and intuitive user interfaces.',
'Figma, Adobe XD, User Research, Prototyping',
'2-4 years',
'San Francisco, CA',
'$70,000 - $90,000',
'approved'),

('DevOps Engineer', 'Engineering', 'full_time', 1,
'We need a DevOps Engineer to manage our infrastructure and deployment pipelines.',
'AWS, Kubernetes, Docker, CI/CD, Terraform',
'4-6 years',
'Remote',
'$95,000 - $125,000',
'draft'),

('Marketing Intern', 'Marketing', 'intern', 2,
'Summer internship opportunity for marketing students. Learn digital marketing, content creation, and campaign management.',
'Social Media, Content Writing, Analytics',
'0-1 years',
'Boston, MA',
'$15-20/hour',
'approved');

-- Sample job openings (will be created after requisitions are approved)
-- Get the IDs from job_requisitions and create openings
INSERT INTO job_openings (requisition_id, opening_date, closing_date, positions_filled, status)
SELECT id, CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days', 0, 'open'
FROM job_requisitions
WHERE status = 'approved'
LIMIT 4;

-- Sample candidates
-- Get job opening IDs first
DO $$
DECLARE
    opening_id_1 UUID;
    opening_id_2 UUID;
    opening_id_3 UUID;
    candidate_id_1 UUID;
    candidate_id_2 UUID;
    candidate_id_3 UUID;
BEGIN
    -- Get opening IDs
    SELECT id INTO opening_id_1 FROM job_openings LIMIT 1 OFFSET 0;
    SELECT id INTO opening_id_2 FROM job_openings LIMIT 1 OFFSET 1;
    SELECT id INTO opening_id_3 FROM job_openings LIMIT 1 OFFSET 2;

    -- Insert candidates
    INSERT INTO candidates (full_name, email, phone, source, applied_job_id, current_stage, overall_status)
    VALUES 
    ('John Smith', 'john.smith@email.com', '+1-555-0101', 'linkedin', opening_id_1, 'applied', 'active')
    RETURNING id INTO candidate_id_1;

    INSERT INTO candidates (full_name, email, phone, source, applied_job_id, current_stage, overall_status)
    VALUES 
    ('Sarah Johnson', 'sarah.j@email.com', '+1-555-0102', 'website', opening_id_1, 'screening', 'active')
    RETURNING id INTO candidate_id_2;

    INSERT INTO candidates (full_name, email, phone, source, applied_job_id, current_stage, overall_status)
    VALUES 
    ('Michael Chen', 'michael.chen@email.com', '+1-555-0103', 'referral', opening_id_1, 'hr_round', 'active')
    RETURNING id INTO candidate_id_3;

    INSERT INTO candidates (full_name, email, phone, source, applied_job_id, current_stage, overall_status)
    VALUES 
    ('Emily Davis', 'emily.davis@email.com', '+1-555-0104', 'job_portal', opening_id_2, 'applied', 'active');

    INSERT INTO candidates (full_name, email, phone, source, applied_job_id, current_stage, overall_status)
    VALUES 
    ('David Wilson', 'david.w@email.com', '+1-555-0105', 'linkedin', opening_id_2, 'technical_round', 'active');

    INSERT INTO candidates (full_name, email, phone, source, applied_job_id, current_stage, overall_status)
    VALUES 
    ('Lisa Anderson', 'lisa.a@email.com', '+1-555-0106', 'website', opening_id_3, 'final_round', 'active');

    INSERT INTO candidates (full_name, email, phone, source, applied_job_id, current_stage, overall_status)
    VALUES 
    ('James Brown', 'james.brown@email.com', '+1-555-0107', 'referral', opening_id_3, 'offer', 'active');

    -- Add stage history for candidates
    INSERT INTO candidate_stage_history (candidate_id, stage, notes)
    VALUES 
    (candidate_id_1, 'applied', 'Application received'),
    (candidate_id_2, 'applied', 'Application received'),
    (candidate_id_2, 'screening', 'Resume screening passed'),
    (candidate_id_3, 'applied', 'Application received'),
    (candidate_id_3, 'screening', 'Resume screening passed'),
    (candidate_id_3, 'hr_round', 'Moved to HR round');

    -- Add sample interview schedules
    INSERT INTO interview_schedules (candidate_id, interview_date, interview_time, interview_mode, meeting_link, status, notes)
    VALUES 
    (candidate_id_2, CURRENT_DATE + INTERVAL '2 days', '10:00:00', 'online', 'https://meet.google.com/abc-defg-hij', 'scheduled', 'Initial screening call'),
    (candidate_id_3, CURRENT_DATE + INTERVAL '3 days', '14:00:00', 'online', 'https://meet.google.com/xyz-uvwx-yz', 'scheduled', 'HR interview');

    -- Add sample interview notes
    INSERT INTO interview_notes (candidate_id, interview_round, rating, comments, recommendation)
    VALUES 
    (candidate_id_2, 'Phone Screening', 4.5, 'Strong communication skills. Good technical background. Recommended for next round.', 'hire'),
    (candidate_id_3, 'HR Round', 4.0, 'Good cultural fit. Salary expectations align. Moving to technical round.', 'hire');

END $$;

-- Verify data
SELECT 'Job Requisitions:' as info, COUNT(*) as count FROM job_requisitions
UNION ALL
SELECT 'Job Openings:', COUNT(*) FROM job_openings
UNION ALL
SELECT 'Candidates:', COUNT(*) FROM candidates
UNION ALL
SELECT 'Email Templates:', COUNT(*) FROM email_templates
UNION ALL
SELECT 'Interview Schedules:', COUNT(*) FROM interview_schedules
UNION ALL
SELECT 'Interview Notes:', COUNT(*) FROM interview_notes;

-- Display sample data
SELECT 'Sample Job Openings:' as info;
SELECT jo.id, jr.job_title, jr.department, jo.status, jo.positions_filled, jr.number_of_positions
FROM job_openings jo
JOIN job_requisitions jr ON jo.requisition_id = jr.id
LIMIT 5;

SELECT 'Sample Candidates:' as info;
SELECT c.full_name, c.email, c.current_stage, c.source, jr.job_title
FROM candidates c
LEFT JOIN job_openings jo ON c.applied_job_id = jo.id
LEFT JOIN job_requisitions jr ON jo.requisition_id = jr.id
LIMIT 10;

COMMIT;
