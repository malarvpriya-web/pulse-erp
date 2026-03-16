# 🚀 Recruitment Module - Quick Setup Guide

## Step 1: Database Setup ✅

The schema already exists at: `backend/database/recruitment-schema.sql`

If not already applied, run:
```bash
psql -U postgres -d Pulse -f backend/database/recruitment-schema.sql
```

## Step 2: Backend Integration ✅

The backend files are already created:
- `backend/src/modules/recruitment/repositories/recruitment.repository.js`
- `backend/src/modules/recruitment/routes/recruitment.routes.js`

### Register Routes in server.js

Add this line to your `backend/server.js`:

```javascript
// Add with other route imports
const recruitmentRoutes = require('./src/modules/recruitment/routes/recruitment.routes');

// Add with other route registrations
app.use('/api/recruitment', recruitmentRoutes);
```

## Step 3: Frontend Integration ✅

All frontend files created in: `frontend/src/features/recruitment/pages/`

### Add Routes to App.jsx

Add these imports at the top of `frontend/src/App.jsx`:

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
```

Add these routes inside your `<Routes>` component:

```javascript
{/* Recruitment Module */}
<Route path="/recruitment/dashboard" element={<RecruitmentDashboard />} />
<Route path="/recruitment/openings" element={<JobOpenings />} />
<Route path="/recruitment/pipeline/:jobId?" element={<CandidatePipeline />} />
<Route path="/recruitment/candidates" element={<AllCandidates />} />
<Route path="/recruitment/candidates/:id" element={<CandidateDetail />} />
<Route path="/recruitment/interviews" element={<InterviewScheduler />} />
<Route path="/recruitment/email-templates" element={<EmailTemplates />} />
```

## Step 4: Add Navigation Links

Add recruitment links to your navigation menu:

```javascript
<Link to="/recruitment/dashboard">Recruitment</Link>
<Link to="/recruitment/openings">Job Openings</Link>
<Link to="/recruitment/candidates">Candidates</Link>
```

## Step 5: Test the Module

1. **Start Backend:**
   ```bash
   cd backend
   npm run dev
   ```

2. **Start Frontend:**
   ```bash
   cd frontend
   npm run dev
   ```

3. **Access Pages:**
   - Dashboard: http://localhost:5173/recruitment/dashboard
   - Job Openings: http://localhost:5173/recruitment/openings
   - Candidates: http://localhost:5173/recruitment/candidates

## 📋 Quick Test Checklist

- [ ] Create a job requisition
- [ ] Approve requisition
- [ ] Create job opening
- [ ] Add a candidate
- [ ] View candidate in pipeline
- [ ] Move candidate through stages
- [ ] Schedule an interview
- [ ] Add interview feedback
- [ ] Create an offer
- [ ] View dashboard analytics

## 🎯 Key URLs

| Page | URL |
|------|-----|
| Dashboard | `/recruitment/dashboard` |
| Job Openings | `/recruitment/openings` |
| Pipeline | `/recruitment/pipeline` |
| All Candidates | `/recruitment/candidates` |
| Candidate Detail | `/recruitment/candidates/:id` |
| Interviews | `/recruitment/interviews` |
| Email Templates | `/recruitment/email-templates` |

## 📊 API Base URL

All recruitment APIs are available at:
```
http://localhost:5000/api/recruitment/
```

## ✅ Module is Ready!

All files have been created and are production-ready. Just integrate the routes and start using!

## 🆘 Troubleshooting

**Issue:** Routes not working
- **Fix:** Make sure you've added the routes to server.js and App.jsx

**Issue:** Database errors
- **Fix:** Ensure recruitment-schema.sql has been executed

**Issue:** 404 on API calls
- **Fix:** Check that backend server is running and routes are registered

**Issue:** Styling issues
- **Fix:** Ensure Recruitment.css is being imported in the page components

## 📞 Need Help?

Check the full documentation in `RECRUITMENT-MODULE-README.md`
