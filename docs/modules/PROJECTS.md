# PROJECT MANAGEMENT, TIMESHEETS & PERFORMANCE MODULE

Complete enterprise-grade system for project tracking, time management, and employee performance evaluation.

---

## 📋 TABLE OF CONTENTS

1. [Architecture Overview](#architecture-overview)
2. [Database Schema](#database-schema)
3. [API Endpoints](#api-endpoints)
4. [Frontend Pages](#frontend-pages)
5. [Workflows](#workflows)
6. [Integration Points](#integration-points)
7. [Usage Examples](#usage-examples)

---

## 🏗 ARCHITECTURE OVERVIEW

### Module Structure

```
backend/src/modules/
├── projects/
│   ├── repositories/
│   │   ├── project.repository.js
│   │   ├── task.repository.js
│   │   └── projectCost.repository.js
│   └── routes/
│       └── projects.routes.js
├── timesheets/
│   ├── repositories/
│   │   └── timesheet.repository.js
│   └── routes/
│       └── timesheets.routes.js
└── performance/
    ├── repositories/
    │   └── performance.repository.js
    └── routes/
        └── performance.routes.js

frontend/src/features/
├── projects/pages/
│   ├── Projects.jsx
│   └── KanbanBoard.jsx
├── timesheets/pages/
│   └── Timesheets.jsx
└── performance/pages/
    └── PerformanceReviews.jsx
```

### Design Patterns

- **Repository Pattern**: Data access layer separation
- **RESTful API**: Standard HTTP methods and status codes
- **UUID Primary Keys**: Distributed system ready
- **Soft Delete**: Audit trail preservation
- **Audit Logging**: Complete change tracking

---

## 🗄 DATABASE SCHEMA

### Projects Module

#### projects
- `id` (UUID, PK)
- `project_code` (VARCHAR, UNIQUE) - Auto-generated PRJ-0001
- `project_name` (VARCHAR)
- `customer_id` (UUID, FK → parties)
- `start_date`, `end_date` (DATE)
- `project_manager_id` (UUID, FK → employees)
- `status` (planning, active, on_hold, completed, cancelled)
- `budget_amount` (DECIMAL)
- `description` (TEXT)
- Audit: `created_at`, `updated_at`, `created_by`, `deleted_at`

#### project_team_members
- `id` (UUID, PK)
- `project_id` (UUID, FK → projects)
- `employee_id` (UUID, FK → employees)
- `role` (manager, developer, tester, support, analyst, designer)
- `allocation_percentage` (DECIMAL) - 0-100%

#### tasks
- `id` (UUID, PK)
- `project_id` (UUID, FK → projects)
- `task_title`, `task_description` (VARCHAR, TEXT)
- `assigned_to` (UUID, FK → employees)
- `priority` (low, medium, high, critical)
- `status` (todo, in_progress, review, done, blocked)
- `start_date`, `due_date` (DATE)
- `estimated_hours`, `actual_hours` (DECIMAL)
- Audit: `created_at`, `updated_at`, `created_by`, `deleted_at`

#### project_milestones
- `id` (UUID, PK)
- `project_id` (UUID, FK → projects)
- `milestone_name` (VARCHAR)
- `milestone_date` (DATE)
- `status` (pending, achieved, missed)

#### project_cost_summary
- `id` (UUID, PK)
- `project_id` (UUID, FK → projects)
- `labour_cost` (DECIMAL) - From approved timesheets
- `material_cost` (DECIMAL) - From inventory consumption
- `expense_cost` (DECIMAL) - From finance expenses
- `total_cost` (DECIMAL, GENERATED) - Sum of all costs

### Timesheets Module

#### timesheet_entries
- `id` (UUID, PK)
- `employee_id` (UUID, FK → employees)
- `project_id` (UUID, FK → projects)
- `task_id` (UUID, FK → tasks)
- `work_date` (DATE)
- `hours_worked` (DECIMAL) - 0-24 hours
- `description` (TEXT)
- `is_billable` (BOOLEAN)
- `status` (draft, submitted, approved, rejected)
- `submitted_at`, `approved_at` (TIMESTAMP)
- `approved_by` (UUID, FK → employees)
- `rejection_reason` (TEXT)
- Audit: `created_at`, `updated_at`, `deleted_at`

#### timesheet_approvals
- `id` (UUID, PK)
- `employee_id` (UUID, FK → employees)
- `week_start_date`, `week_end_date` (DATE)
- `total_hours` (DECIMAL)
- `status` (pending, approved, rejected)
- `submitted_at`, `approved_at` (TIMESTAMP)
- `approved_by` (UUID, FK → employees)
- `comments` (TEXT)

### Performance Module

#### performance_goals
- `id` (UUID, PK)
- `employee_id` (UUID, FK → employees)
- `review_period` (VARCHAR) - e.g., "2024-Q1", "2024-Annual"
- `goal_title`, `goal_description` (VARCHAR, TEXT)
- `target_value` (VARCHAR)
- `weightage` (DECIMAL) - 0-100%
- `status` (active, achieved, not_achieved, cancelled)
- Audit: `created_at`, `updated_at`, `deleted_at`

#### performance_reviews
- `id` (UUID, PK)
- `employee_id` (UUID, FK → employees)
- `review_period` (VARCHAR)
- `review_type` (quarterly, half_yearly, annual)
- **Self Review:**
  - `self_rating` (DECIMAL 1-5)
  - `self_comments`, `achievements`, `challenges` (TEXT)
  - `self_submitted_at` (TIMESTAMP)
- **Manager Review:**
  - `manager_id` (UUID, FK → employees)
  - `manager_rating` (DECIMAL 1-5)
  - `manager_comments` (TEXT)
  - `promotion_recommendation` (BOOLEAN)
  - `salary_revision_percentage` (DECIMAL)
  - `manager_submitted_at` (TIMESTAMP)
- `final_rating` (DECIMAL 1-5)
- `status` (draft, self_submitted, manager_review, completed, cancelled)
- Audit: `created_at`, `updated_at`, `deleted_at`

#### performance_feedback
- `id` (UUID, PK)
- `review_id` (UUID, FK → performance_reviews)
- `feedback_from` (UUID, FK → employees)
- `feedback_type` (peer, subordinate, manager)
- `rating` (DECIMAL 1-5)
- `comments` (TEXT)
- `submitted_at` (TIMESTAMP)

#### performance_history
- `id` (UUID, PK)
- `employee_id` (UUID, FK → employees)
- `review_period` (VARCHAR)
- `final_rating` (DECIMAL)
- `promotion_given` (BOOLEAN)
- `salary_revision_percentage` (DECIMAL)
- `created_at` (TIMESTAMP)

---

## 🔌 API ENDPOINTS

### Projects API (`/api/projects`)

#### Projects
- `GET /projects` - List all projects (filters: status, project_manager_id)
- `GET /projects/dashboard` - Dashboard stats
- `GET /projects/next-code` - Get next project code
- `GET /projects/:id` - Get project details
- `POST /projects` - Create project
- `PUT /projects/:id` - Update project
- `DELETE /projects/:id` - Soft delete project

#### Tasks
- `GET /tasks` - List tasks (filters: project_id, assigned_to, status)
- `GET /tasks/overdue` - Get overdue tasks
- `GET /tasks/kanban/:project_id` - Get Kanban board data
- `GET /tasks/:id` - Get task details
- `POST /tasks` - Create task
- `PUT /tasks/:id` - Update task (including status change)
- `DELETE /tasks/:id` - Soft delete task

#### Project Costs
- `GET /projects/:id/costs` - Get project cost summary
- `POST /projects/:id/costs` - Update project costs
- `GET /projects/analytics/profitability` - Project profitability analysis

### Timesheets API (`/api/timesheets`)

- `GET /timesheets` - List timesheets (filters: employee_id, project_id, status, date range)
- `GET /timesheets/:id` - Get timesheet entry
- `POST /timesheets` - Create timesheet entry
- `PUT /timesheets/:id` - Update timesheet entry
- `DELETE /timesheets/:id` - Soft delete entry
- `POST /timesheets/submit-week` - Submit week for approval
- `POST /timesheets/approve` - Approve timesheet entries (auto-updates project labour cost)
- `POST /timesheets/reject` - Reject timesheet entries
- `GET /timesheets/summary/weekly` - Weekly hours summary
- `GET /timesheets/utilization/:employee_id` - Employee utilization metrics
- `GET /timesheets/pending-approvals/:manager_id` - Pending approvals for manager

### Performance API (`/api/performance`)

#### Goals
- `GET /goals` - List goals (filters: employee_id, review_period)
- `POST /goals` - Create goal
- `PUT /goals/:id` - Update goal

#### Reviews
- `GET /reviews` - List reviews (filters: employee_id, manager_id, status)
- `GET /reviews/:id` - Get review details
- `POST /reviews` - Create review
- `PUT /reviews/:id` - Update review
- `POST /reviews/:id/self-review` - Submit self review
- `POST /reviews/:id/manager-review` - Submit manager review

#### Analytics
- `GET /analytics/top-performers` - Top performers list
- `GET /analytics/department-performance` - Department-wise performance
- `GET /analytics/goal-completion` - Goal completion rates

---

## 🎨 FRONTEND PAGES

### Projects Module

#### Projects.jsx
- **Features:**
  - Grid view of all projects
  - Project cards with progress bars
  - Status badges (planning, active, on_hold, completed, cancelled)
  - Create new project form
  - Auto-generated project codes
  - Customer and manager selection
  - Budget tracking
- **Styling:** Card-based layout, responsive grid

#### KanbanBoard.jsx
- **Features:**
  - 4-column Kanban board (To Do, In Progress, Review, Done)
  - Drag-and-drop task status updates
  - Priority badges (low, medium, high, critical)
  - Task creation form
  - Project selector
  - Assignee display
  - Due date tracking
- **Styling:** Column-based layout, color-coded priorities

### Timesheets Module

#### Timesheets.jsx
- **Features:**
  - Timesheet entry form
  - Project and task selection
  - Hours worked input (0-24)
  - Billable/non-billable toggle
  - Weekly submission
  - Status tracking (draft, submitted, approved, rejected)
  - Total hours display
  - Table view of all entries
- **Styling:** Table layout with form modal

### Performance Module

#### PerformanceReviews.jsx
- **Features:**
  - Review cards by period
  - Self review form (rating, achievements, challenges, comments)
  - Manager review display
  - Rating visualization (stars)
  - Promotion recommendations
  - Salary revision display
  - Final rating highlight
  - Status tracking
- **Styling:** Card-based layout with rating displays

---

## 🔄 WORKFLOWS

### Project Lifecycle

1. **Planning Phase**
   - Create project with basic details
   - Assign project manager
   - Set budget and timeline
   - Add team members

2. **Active Phase**
   - Create tasks and assign to team
   - Track progress via Kanban board
   - Log timesheets against tasks
   - Monitor costs vs budget

3. **Completion**
   - Mark all tasks as done
   - Review final costs
   - Calculate profitability
   - Archive project

### Timesheet Workflow

1. **Daily Entry**
   - Employee logs hours worked
   - Selects project and task
   - Marks as billable/non-billable
   - Saves as draft

2. **Weekly Submission**
   - Employee reviews week's entries
   - Submits for approval
   - Status changes to "submitted"

3. **Manager Approval**
   - Manager reviews pending timesheets
   - Approves or rejects with reason
   - Approved entries update project labour costs
   - System calculates utilization metrics

### Performance Review Workflow

1. **Review Creation**
   - HR creates review for employee
   - Sets review period and type
   - Status: "draft"

2. **Self Review**
   - Employee completes self assessment
   - Provides rating, achievements, challenges
   - Submits for manager review
   - Status: "self_submitted"

3. **Manager Review**
   - Manager reviews self assessment
   - Provides manager rating and comments
   - Makes promotion/salary recommendations
   - Calculates final rating
   - Status: "completed"

4. **History Tracking**
   - Completed review saved to history
   - Used for trend analysis
   - Supports promotion pipeline

---

## 🔗 INTEGRATION POINTS

### Finance Integration

**Project Costing:**
- Labour cost from approved timesheets (hours × rate)
- Material cost from inventory RM issues
- Expense cost from finance expense claims
- Real-time profitability calculation

**Revenue Recognition:**
- Billable hours → Invoice generation
- Project milestones → Payment schedules

### Inventory Integration

**Material Consumption:**
- RM issues linked to projects
- Material costs auto-update project_cost_summary
- Stock tracking per project

### HR & Payroll Integration

**Timesheet to Payroll:**
- Approved hours → Payroll processing
- Overtime calculation
- Leave integration

**Performance to HR:**
- Promotion recommendations → HR actions
- Salary revisions → Payroll updates
- Performance history → Career planning

---

## 📊 USAGE EXAMPLES

### Create Project with Tasks

```javascript
// 1. Create Project
POST /api/projects/projects
{
  "project_code": "PRJ-0001",
  "project_name": "Website Redesign",
  "customer_id": "uuid",
  "start_date": "2024-01-01",
  "end_date": "2024-06-30",
  "project_manager_id": "uuid",
  "status": "active",
  "budget_amount": 500000
}

// 2. Create Tasks
POST /api/projects/tasks
{
  "project_id": "uuid",
  "task_title": "Design Homepage",
  "assigned_to": "uuid",
  "priority": "high",
  "status": "todo",
  "due_date": "2024-02-15",
  "estimated_hours": 40
}
```

### Log Timesheet and Approve

```javascript
// 1. Create Timesheet Entry
POST /api/timesheets/timesheets
{
  "employee_id": "uuid",
  "project_id": "uuid",
  "task_id": "uuid",
  "work_date": "2024-01-15",
  "hours_worked": 8,
  "description": "Completed homepage design mockups",
  "is_billable": true,
  "status": "draft"
}

// 2. Submit Week
POST /api/timesheets/timesheets/submit-week
{
  "employee_id": "uuid",
  "week_start": "2024-01-15",
  "week_end": "2024-01-21"
}

// 3. Approve Timesheets (Manager)
POST /api/timesheets/timesheets/approve
{
  "ids": ["uuid1", "uuid2"],
  "approved_by": "manager_uuid"
}
// Auto-updates project labour costs
```

### Performance Review Cycle

```javascript
// 1. Create Review (HR)
POST /api/performance/reviews
{
  "employee_id": "uuid",
  "review_period": "2024-Q1",
  "review_type": "quarterly"
}

// 2. Self Review (Employee)
POST /api/performance/reviews/:id/self-review
{
  "self_rating": 4.5,
  "achievements": "Completed 3 major projects ahead of schedule",
  "challenges": "Learning new technology stack",
  "self_comments": "Strong quarter with excellent delivery"
}

// 3. Manager Review
POST /api/performance/reviews/:id/manager-review
{
  "manager_id": "uuid",
  "manager_rating": 4.7,
  "manager_comments": "Exceptional performance and leadership",
  "promotion_recommendation": true,
  "salary_revision_percentage": 15,
  "final_rating": 4.6
}
```

### Get Analytics

```javascript
// Project Profitability
GET /api/projects/projects/analytics/profitability
// Returns: budget vs actual cost, profit margin %

// Employee Utilization
GET /api/timesheets/timesheets/utilization/:employee_id?start_date=2024-01-01&end_date=2024-03-31
// Returns: billable %, total hours, working days

// Top Performers
GET /api/performance/analytics/top-performers?limit=10
// Returns: employees with avg rating >= 4.0

// Department Performance
GET /api/performance/analytics/department-performance
// Returns: avg rating, promotion recommendations by department
```

---

## 🎯 KEY FEATURES

### Projects
✅ Auto-generated project codes  
✅ Multi-status tracking  
✅ Budget vs actual monitoring  
✅ Task progress visualization  
✅ Kanban board for agile teams  
✅ Overdue task alerts  
✅ Project profitability analysis  

### Timesheets
✅ Daily time logging  
✅ Project/task association  
✅ Billable/non-billable tracking  
✅ Weekly submission workflow  
✅ Manager approval system  
✅ Utilization metrics  
✅ Auto-update project costs  

### Performance
✅ Self review + manager review  
✅ 5-point rating scale  
✅ Achievements tracking  
✅ Promotion recommendations  
✅ Salary revision suggestions  
✅ Performance history  
✅ Top performers analytics  
✅ Department performance  

---

## 🚀 PRODUCTION READY

- ✅ UUID primary keys
- ✅ Soft delete with audit trail
- ✅ Comprehensive indexing
- ✅ Transaction support
- ✅ Error handling
- ✅ Input validation
- ✅ RESTful API design
- ✅ Responsive UI
- ✅ Consistent styling
- ✅ Integration ready

---

## 📝 NOTES

- All monetary values use DECIMAL(15,2)
- All ratings use DECIMAL(3,2) for 1.00-5.00 scale
- Dates stored in ISO format
- Timestamps in UTC
- Soft delete preserves data integrity
- Audit logs track all changes
- Finance integration uses approved timesheets only
- Project costs update automatically on timesheet approval
- Performance history enables trend analysis

---

**Module Status:** ✅ Production Ready  
**Last Updated:** 2024  
**Version:** 1.0.0
