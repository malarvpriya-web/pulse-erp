-- =====================================================================
-- Recruitment Module — Default Email Templates (10 templates)
-- Uses the global email_templates table (stage_trigger / category lookup)
-- Run after company seed. Safe to re-run — skips existing entries.
-- =====================================================================

-- Ensure a unique constraint exists on stage_trigger so ON CONFLICT works
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_email_templates_stage_trigger'
  ) THEN
    ALTER TABLE email_templates
      ADD CONSTRAINT uq_email_templates_stage_trigger UNIQUE (stage_trigger);
  END IF;
END
$$;

INSERT INTO email_templates (name, category, stage_trigger, subject, body_html, variables) VALUES

-- 1. Application Received
(
  'Application Received',
  'application_received',
  'application_received',
  'We received your application — {{job_title}} at Manifest Technologies',
  '<p>Dear {{candidate_name}},</p>
<p>Thank you for applying for <strong>{{job_title}}</strong>. We have received your application and will review it carefully.</p>
<p>We will be in touch within 5–7 business days.</p>
<p>Warm regards,<br>HR Team, Manifest Technologies</p>',
  '["candidate_name","job_title"]'::jsonb
),

-- 2. Screening Scheduled
(
  'Screening Scheduled',
  'screening_scheduled',
  'screening_scheduled',
  'Screening call scheduled — {{job_title}}',
  '<p>Dear {{candidate_name}},</p>
<p>We invite you for an initial screening call for the <strong>{{job_title}}</strong> position.</p>
<p><strong>Date &amp; Time:</strong> {{interview_date}} at {{interview_time}}<br>
<strong>Mode:</strong> {{interview_mode}}</p>
<p>Please confirm your availability by replying to this email.</p>
<p>Best regards,<br>HR Team, Manifest Technologies</p>',
  '["candidate_name","job_title","interview_date","interview_time","interview_mode"]'::jsonb
),

-- 3. 1st Level Interview Scheduled
(
  '1st Level Interview Scheduled',
  'interview_l1_scheduled',
  'interview_l1_scheduled',
  '1st Level Interview Invitation — {{job_title}}',
  '<p>Dear {{candidate_name}},</p>
<p>Congratulations on clearing the screening round! You are invited for a <strong>1st Level Interview</strong> for <strong>{{job_title}}</strong>.</p>
<p><strong>Date:</strong> {{interview_date}} &nbsp; <strong>Time:</strong> {{interview_time}}<br>
<strong>Mode:</strong> {{interview_mode}}</p>
<p>Best regards,<br>HR Team, Manifest Technologies</p>',
  '["candidate_name","job_title","interview_date","interview_time","interview_mode"]'::jsonb
),

-- 4. 2nd Level Interview Scheduled
(
  '2nd Level Interview Scheduled',
  'interview_l2_scheduled',
  'interview_l2_scheduled',
  '2nd Level Interview Invitation — {{job_title}}',
  '<p>Dear {{candidate_name}},</p>
<p>Congratulations on clearing the 1st round! You are invited for a <strong>2nd Level Interview</strong> for <strong>{{job_title}}</strong>.</p>
<p><strong>Date:</strong> {{interview_date}} &nbsp; <strong>Time:</strong> {{interview_time}}<br>
<strong>Mode:</strong> {{interview_mode}}</p>
<p>Best regards,<br>HR Team, Manifest Technologies</p>',
  '["candidate_name","job_title","interview_date","interview_time","interview_mode"]'::jsonb
),

-- 5. Interview Rejected
(
  'Interview Rejection',
  'interview_rejected',
  'interview_rejected',
  'Update on your application — {{job_title}}',
  '<p>Dear {{candidate_name}},</p>
<p>Thank you for interviewing with us for <strong>{{job_title}}</strong>. After careful consideration, we have decided to move forward with other candidates at this time.</p>
<p>We appreciate your interest in Manifest Technologies and encourage you to apply for future openings.</p>
<p>Warm regards,<br>HR Team, Manifest Technologies</p>',
  '["candidate_name","job_title"]'::jsonb
),

-- 6. Offer Sent
(
  'Offer Letter Sent',
  'offer_sent',
  'offer_sent',
  'Offer Letter — {{job_title}} at Manifest Technologies',
  '<p>Dear {{candidate_name}},</p>
<p>We are delighted to extend an offer for <strong>{{job_title}}</strong> at Manifest Technologies.</p>
<p><strong>Offered CTC:</strong> ₹{{offered_salary}} per annum<br>
<strong>Joining Date:</strong> {{joining_date}}</p>
<p>Please confirm your acceptance by {{acceptance_deadline}}.</p>
<p>Best regards,<br>HR Team, Manifest Technologies</p>',
  '["candidate_name","job_title","offered_salary","joining_date","acceptance_deadline"]'::jsonb
),

-- 7. Offer Accepted
(
  'Offer Accepted Confirmation',
  'offer_accepted',
  'offer_accepted',
  'Offer Accepted — Welcome to Manifest Technologies!',
  '<p>Dear {{candidate_name}},</p>
<p>We are thrilled to confirm your acceptance of the offer for <strong>{{job_title}}</strong>.</p>
<p>Your joining date is <strong>{{joining_date}}</strong>. Our HR team will reach out with pre-joining formalities.</p>
<p>We are excited to have you on board!</p>
<p>Best regards,<br>HR Team, Manifest Technologies</p>',
  '["candidate_name","job_title","joining_date"]'::jsonb
),

-- 8. Hired / Welcome (looked up by triggerEmail('hired_welcome', ...))
(
  'New Employee Welcome',
  'hired_welcome',
  'hired_welcome',
  'Welcome to Manifest Technologies — {{employee_name}}!',
  '<p>Dear {{employee_name}},</p>
<p>Welcome to <strong>Manifest Technologies</strong>! We are excited to have you join us as <strong>{{designation}}</strong>.</p>
<p><strong>Employee ID:</strong> {{employee_id}}<br>
<strong>Joining Date:</strong> {{joining_date}}</p>
<p>Your onboarding schedule will be shared shortly. Please carry original documents on your first day.</p>
<p>Looking forward to working together!<br>HR Team, Manifest Technologies</p>',
  '["employee_name","employee_id","designation","joining_date"]'::jsonb
),

-- 9. Interviewer Notification
(
  'Interviewer Assignment Notification',
  'interviewer_notification',
  'interviewer_notification',
  'Interview Assignment — {{candidate_name}} on {{interview_date}}',
  '<p>Dear {{interviewer_name}},</p>
<p>You have been assigned to interview <strong>{{candidate_name}}</strong> for <strong>{{job_title}}</strong>.</p>
<p><strong>Date:</strong> {{interview_date}} &nbsp; <strong>Time:</strong> {{interview_time}}<br>
<strong>Mode:</strong> {{interview_mode}}</p>
<p>Please submit your feedback after the interview.</p>
<p>Thank you,<br>HR Team, Manifest Technologies</p>',
  '["interviewer_name","candidate_name","job_title","interview_date","interview_time","interview_mode"]'::jsonb
),

-- 10. Onboarding Reminder
(
  'Onboarding Reminder',
  'onboarding_reminder',
  'onboarding_reminder',
  'Onboarding Reminder — Joining on {{joining_date}}',
  '<p>Dear {{employee_name}},</p>
<p>This is a friendly reminder that your joining date is <strong>{{joining_date}}</strong>.</p>
<p>Please carry:</p>
<ul>
  <li>Government-issued photo ID (Aadhaar / Passport)</li>
  <li>Educational certificates (originals + copies)</li>
  <li>Previous employment relieving letter</li>
  <li>Last 3 months salary slips</li>
  <li>2 passport-size photographs</li>
  <li>Bank account details for payroll</li>
</ul>
<p>Report to HR at 9:00 AM. See you soon!</p>
<p>HR Team, Manifest Technologies</p>',
  '["employee_name","joining_date","designation"]'::jsonb
)

ON CONFLICT (stage_trigger) DO NOTHING;
