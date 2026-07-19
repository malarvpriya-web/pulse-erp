# Recruitment / Applicant Tracking System (ATS) Module

Complete production-ready recruitment management system with backend API and React frontend.

## 📋 Features

### Backend Features
- ✅ Job Requisition Management
- ✅ Job Opening Management
- ✅ Candidate Database with Resume Upload
- ✅ Bulk Candidate Import
- ✅ Recruitment Pipeline Stages
- ✅ Stage History Tracking
- ✅ Interview Scheduling
- ✅ Interview Notes & Feedback
- ✅ Email Template Management
- ✅ Offer Letter Management
- ✅ Automated Offer Acceptance Flow
- ✅ Analytics & Dashboard
- ✅ UUID Primary Keys
- ✅ Soft Delete Support
- ✅ Timestamps & Audit Logging
- ✅ Database Indexing

### Frontend Features
- ✅ Recruitment Dashboard with Metrics
- ✅ Job Openings Management
- ✅ Candidate Pipeline (Kanban View)
- ✅ Candidate Detail Page
- ✅ All Candidates Database
- ✅ Interview Scheduler
- ✅ Email Template Manager
- ✅ Search & Filters
- ✅ Responsive Design
- ✅ Role-Based Access Ready

## 🗂️ Module Structure

### Backend Structure
```
backend/src/modules/recruitment/
├── repositories/
│   └── recruitment.repository.js    # Database operations
└── routes/
    └── recruitment.routes.js        # API endpoints
```

### Frontend Structure
```
frontend/src/features/recruitment/
└── pages/
    ├── RecruitmentDashboard.jsx     # Main dashboard
    ├── JobOpenings.jsx              # Job openings & requisitions
    ├── CandidatePipeline.jsx        # Kanban pipeline view
    ├── CandidateDetail.jsx          # Candidate details
    ├── AllCandidates.jsx            # Candidate database
    ├── InterviewScheduler.jsx       # Interview management
    ├── EmailTemplates.jsx           # Email template manager
    ├── Recruitment.css              # Styles
    └── index.js                     # Exports
```

## 🔌 API Endpoints

### Job Requisitions
- `GET /api/recruitment/requisitions` - Get all requisitions
- `GET /api/recruitment/requisitions/:id` - Get requisition by ID
- `POST /api/recruitment/requisitions` - Create requisition
- `PUT /api/recruitment/requisitions/:id` - Update requisition
- `DELETE /api/recruitment/requisitions/:id` - Delete requisition

### Job Openings
- `GET /api/recruitment/openings` - Get all openings
- `GET /api/recruitment/openings/:id` - Get opening by ID
- `POST /api/recruitment/openings` - Create opening
- `PUT /api/recruitment/openings/:id` - Update opening

### Candidates
- `GET /api/recruitment/candidates` - Get all candidates
- `GET /api/recruitment/candidates/:id` - Get candidate by ID
- `POST /api/recruitment/candidates` - Create candidate (with resume upload)
- `POST /api/recruitment/candidates/bulk` - Bulk create candidates
- `PUT /api/recruitment/candidates/:id` - Update candidate
- `POST /api/recruitment/candidates/:id/move-stage` - Move candidate stage
- `GET /api/recruitment/candidates/:id/history` - Get stage history

### Pipeline
- `GET /api/recruitment/pipeline/:job_opening_id` - Get pipeline stats
- `GET /api/recruitment/pipeline/:job_opening_id/:stage` - Get candidates by stage

### Interview Notes
- `POST /api/recruitment/interview-notes` - Create interview note
- `GET /api/recruitment/interview-notes/:candidate_id` - Get notes for candidate

### Interviews
- `GET /api/recruitment/interviews` - Get all interviews
- `POST /api/recruitment/interviews` - Schedule interview
- `PUT /api/recruitment/interviews/:id` - Update interview

### Email Templates
- `GET /api/recruitment/email-templates` - Get all templates
- `GET /api/recruitment/email-templates/:id` - Get template by ID
- `POST /api/recruitment/email-templates` - Create template
- `PUT /api/recruitment/email-templates/:id` - Update template
- `DELETE /api/recruitment/email-templates/:id` - Delete template

### Offers
- `GET /api/recruitment/offers` - Get all offers
- `GET /api/recruitment/offers/:id` - Get offer by ID
- `POST /api/recruitment/offers` - Create offer
- `PUT /api/recruitment/offers/:id` - Update offer
- `POST /api/recruitment/offers/:id/accept` - Accept offer

### Analytics
- `GET /api/recruitment/dashboard` - Get dashboard metrics
- `GET /api/recruitment/analytics/source` - Get source analytics
- `GET /api/recruitment/analytics/time-to-hire` - Get time to hire
- `GET /api/recruitment/analytics/offer-acceptance-rate` - Get offer acceptance rate
- `GET /api/recruitment/analytics/interview-to-hire-ratio` - Get interview to hire ratio

## 📊 Database Schema

### Tables Created
1. **job_requisitions** - Hiring requests
2. **job_openings** - Active job postings
3. **recruitment_stages** - Pipeline stages
4. **candidates** - Candidate master data
5. **candidate_stage_history** - Stage movement tracking
6. **interview_notes** - Interview feedback
7. **interview_schedules** - Interview scheduling
8. **email_templates** - Email templates
9. **offer_letters** - Offer management
10. **recruitment_emails_sent** - Email log

### Key Features
- UUID primary keys
- Soft delete (deleted_at)
- Timestamps (created_at, updated_at)
- Foreign key relationships
- Database indexes for performance
- Triggers for auto-closing filled positions

## 🚀 Setup Instructions

### Backend Setup

1. **Database Schema**
   ```bash
   # Run the schema file
   psql -U postgres -d Pulse -f backend/database/recruitment-schema.sql
   ```

2. **Register Routes** (in server.js)
   ```javascript
   const recruitmentRoutes = require('./src/modules/recruitment/routes/recruitment.routes');
   app.use('/api/recruitment', recruitmentRoutes);
   ```

3. **Start Server**
   ```bash
   cd backend
   npm run dev
   ```

### Frontend Setup

1. **Add Routes** (in App.jsx)
   ```javascript
   import {
     RecruitmentDashboard,
     JobOpenings,
     CandidatePipeline,
     CandidateDetail,
     AllCandidates,
     InterviewScheduler,
     EmailTemplates
   } from './features/recruitment/pages';

   // Add routes
   <Route path="/recruitment/dashboard" element={<RecruitmentDashboard />} />
   <Route path="/recruitment/openings" element={<JobOpenings />} />
   <Route path="/recruitment/pipeline/:jobId?" element={<CandidatePipeline />} />
   <Route path="/recruitment/candidates" element={<AllCandidates />} />
   <Route path="/recruitment/candidates/:id" element={<CandidateDetail />} />
   <Route path="/recruitment/interviews" element={<InterviewScheduler />} />
   <Route path="/recruitment/email-templates" element={<EmailTemplates />} />
   ```

2. **Start Frontend**
   ```bash
   cd frontend
   npm run dev
   ```

## 🎯 Usage Flow

### 1. Create Job Requisition
- HR creates a job requisition with details
- Status: draft → pending_approval → approved

### 2. Create Job Opening
- Once approved, create job opening
- Set opening and closing dates
- Status changes to "open"

### 3. Add Candidates
- Add candidates manually or bulk upload
- Candidates start in "applied" stage
- Resume upload supported

### 4. Manage Pipeline
- View candidates in Kanban board
- Drag/drop or select to move stages
- Track stage history automatically

### 5. Schedule Interviews
- Schedule interviews with date/time
- Set mode: online/offline/phone
- Add meeting links for online interviews

### 6. Add Feedback
- Interviewers add notes and ratings
- Recommendation: strong_hire/hire/hold/reject
- Track all feedback history

### 7. Create Offer
- Generate offer letter
- Set salary and joining date
- Send to candidate

### 8. Accept Offer
- Candidate accepts offer
- Status changes to "hired"
- Position filled count increments
- Job opening auto-closes when filled

### 9. Analytics
- View dashboard metrics
- Track source analytics
- Monitor time to hire
- Check offer acceptance rate

## 📧 Email Templates

### Template Types
1. **application_received** - Confirmation email
2. **interview_scheduled** - Interview invitation
3. **interview_reminder** - Interview reminder
4. **rejection** - Rejection email
5. **offer_letter** - Offer letter
6. **joining_instructions** - Onboarding instructions

### Available Variables
- `{{candidate_name}}`
- `{{candidate_email}}`
- `{{job_title}}`
- `{{interview_date}}`
- `{{interview_time}}`
- `{{meeting_link}}`
- `{{company_name}}`

## 🔐 Security Features

- JWT authentication required
- Role-based access control ready
- Input validation
- SQL injection prevention
- XSS protection

## 📈 Analytics Metrics

1. **Open Positions** - Active job openings
2. **Active Candidates** - Candidates in pipeline
3. **Interviews Scheduled** - Upcoming interviews
4. **Offers Pending** - Sent offers awaiting response
5. **Offers Accepted** - Successful hires
6. **Source Analytics** - Candidate sources breakdown
7. **Time to Hire** - Average days to hire
8. **Offer Acceptance Rate** - Percentage of accepted offers
9. **Interview to Hire Ratio** - Conversion rate

## 🎨 UI Components

- Modern card-based design
- Kanban board for pipeline
- Timeline for stage history
- Modal forms
- Responsive tables
- Search and filters
- Status badges
- Action buttons

## 🔄 Workflow Automation

1. **Auto Stage History** - Tracks every stage movement
2. **Auto Close Jobs** - Closes when positions filled
3. **Auto Status Update** - Updates candidate status on hire/reject
4. **Email Logging** - Logs all sent emails

## 📝 Best Practices

- Use UUID for all IDs
- Soft delete for data retention
- Index frequently queried columns
- Validate input data
- Handle errors gracefully
- Log important actions
- Use transactions for critical operations

## 🚧 Future Enhancements

- [ ] Email automation integration
- [ ] Calendar integration
- [ ] Video interview integration
- [ ] AI resume parsing
- [ ] Candidate scoring
- [ ] Interview feedback forms
- [ ] Offer letter templates
- [ ] Background check integration
- [ ] Onboarding workflow
- [ ] Mobile app

## 📞 Support

For issues or questions, contact the development team.

---

**Version:** 1.0.0  
**Last Updated:** 2024  
**Status:** Production Ready ✅
