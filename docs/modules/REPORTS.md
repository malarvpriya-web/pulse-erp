# REPORTS, DOCUMENTS, NOTIFICATIONS, AUDIT & ORGCHART MODULES

Complete enterprise-grade system for reporting, document generation, notifications, audit logging, and organization hierarchy.

---

## 📋 TABLE OF CONTENTS

1. [Architecture Overview](#architecture-overview)
2. [Database Schema](#database-schema)
3. [API Endpoints](#api-endpoints)
4. [Frontend Pages](#frontend-pages)
5. [Usage Examples](#usage-examples)

---

## 🏗 ARCHITECTURE OVERVIEW

### Module Structure

```
backend/src/modules/
├── reports/
│   ├── repositories/reports.repository.js
│   └── routes/reports.routes.js
├── documents/
│   ├── repositories/documents.repository.js
│   └── routes/documents.routes.js
├── notifications/
│   ├── repositories/notifications.repository.js
│   └── routes/notifications.routes.js
├── audit/
│   ├── repositories/audit.repository.js
│   └── routes/audit.routes.js
└── orgchart/
    ├── repositories/orgchart.repository.js
    └── routes/orgchart.routes.js

frontend/src/features/
├── reports/pages/Reports.jsx
├── notifications/pages/NotificationCenter.jsx
├── orgchart/pages/OrgChart.jsx
└── audit/pages/AuditLogs.jsx
```

---

## 🗄 DATABASE SCHEMA

### Reports Engine

#### saved_reports
- `id` (UUID, PK)
- `report_name` (VARCHAR) *
- `module_name` (VARCHAR) *
- `report_type` (VARCHAR)
- `filters_json` (JSONB) - Saved filter criteria
- `columns_json` (JSONB) - Column configuration
- `created_by` (UUID, FK → employees)
- `is_public` (BOOLEAN) - Share with all users
- Audit: `created_at`, `updated_at`, `deleted_at`

#### scheduled_reports
- `id` (UUID, PK)
- `report_id` (UUID, FK → saved_reports)
- `schedule_type` (daily, weekly, monthly)
- `schedule_time` (TIME)
- `schedule_day` (INTEGER)
- `recipients_json` (JSONB) - Email recipients
- `last_run_at`, `next_run_at` (TIMESTAMP)
- `is_active` (BOOLEAN)
- Audit: `created_at`, `deleted_at`

### Document Generator

#### document_templates
- `id` (UUID, PK)
- `template_name` (VARCHAR) *
- `document_type` (offer_letter, appointment_letter, experience_letter, warning_letter, relieving_letter, purchase_order, quotation, invoice, contract)
- `template_html` (TEXT) * - HTML template with placeholders
- `variables_json` (JSONB) - Available variables
- `is_active` (BOOLEAN)
- `version` (INTEGER)
- `created_by` (UUID, FK → employees)
- Audit: `created_at`, `updated_at`, `deleted_at`

#### generated_documents
- `id` (UUID, PK)
- `template_id` (UUID, FK → document_templates)
- `document_type` (VARCHAR)
- `reference_id` (UUID) - Employee/Customer/Order ID
- `reference_type` (VARCHAR) - employee, customer, order
- `document_data_json` (JSONB) - Merged data
- `file_path` (VARCHAR) - PDF file path
- `generated_by` (UUID, FK → employees)
- `generated_at` (TIMESTAMP)
- `deleted_at` (TIMESTAMP)

### Organization Chart

#### org_relationships
- `id` (UUID, PK)
- `employee_id` (UUID, FK → employees, UNIQUE)
- `manager_id` (UUID, FK → employees)
- `department` (VARCHAR)
- `position_level` (INTEGER) - Hierarchy level (0=CEO, 1=VP, etc.)
- Audit: `created_at`, `updated_at`, `deleted_at`

### Notification Center

#### notifications
- `id` (UUID, PK)
- `user_id` (UUID, FK → employees)
- `title` (VARCHAR) *
- `message` (TEXT) *
- `module_name` (VARCHAR)
- `reference_id` (UUID)
- `notification_type` (info, success, warning, error, approval)
- `is_read` (BOOLEAN)
- `read_at` (TIMESTAMP)
- Audit: `created_at`, `deleted_at`

#### notification_preferences
- `id` (UUID, PK)
- `user_id` (UUID, FK → employees, UNIQUE)
- `email_notifications` (BOOLEAN)
- `push_notifications` (BOOLEAN)
- `notification_types_json` (JSONB)
- Audit: `created_at`, `updated_at`

### Audit Log

#### audit_logs
- `id` (UUID, PK)
- `user_id` (UUID, FK → employees)
- `module_name` (VARCHAR) *
- `action_type` (create, update, delete, approve, reject, login, logout, export, view)
- `reference_id` (UUID)
- `reference_type` (VARCHAR)
- `old_data_json` (JSONB) - Before state
- `new_data_json` (JSONB) - After state
- `ip_address` (VARCHAR)
- `user_agent` (TEXT)
- `created_at` (TIMESTAMP)

#### system_logs
- `id` (UUID, PK)
- `log_level` (info, warning, error, critical)
- `module_name` (VARCHAR)
- `message` (TEXT) *
- `error_stack` (TEXT)
- `metadata_json` (JSONB)
- `created_at` (TIMESTAMP)

---

## 🔌 API ENDPOINTS

### Reports API (`/api/reports`)

#### Saved Reports
- `GET /saved` - List user's saved reports
- `POST /saved` - Create saved report
- `DELETE /saved/:id` - Delete saved report

#### Prebuilt Reports
- `GET /attendance` - Attendance report (filters: start_date, end_date, department)
- `GET /leave` - Leave report (filters: start_date, end_date, status)
- `GET /sales` - Sales report (filters: start_date, end_date)
- `GET /stock` - Stock report (current inventory levels)
- `GET /project-cost` - Project cost report (budget vs actual)

### Documents API (`/api/documents`)

#### Templates
- `GET /templates` - List templates (filters: document_type, is_active)
- `GET /templates/:id` - Get template details
- `POST /templates` - Create template
- `PUT /templates/:id` - Update template
- `DELETE /templates/:id` - Soft delete template

#### Generated Documents
- `GET /generated` - List generated documents (filters: reference_id, reference_type, document_type)
- `POST /generate` - Generate document from template

### Notifications API (`/api/notifications`)

- `GET /` - List user notifications (filters: is_read, module_name)
- `GET /unread-count` - Get unread count
- `POST /` - Create notification
- `PUT /:id/read` - Mark as read
- `PUT /mark-all-read` - Mark all as read
- `DELETE /:id` - Delete notification

### Audit API (`/api/audit`)

- `GET /` - List audit logs (filters: user_id, module_name, action_type, date range)
- `GET /reference/:reference_id/:reference_type` - Get logs for specific record
- `GET /activity-summary` - Activity summary by module/action
- `POST /` - Create audit log

### OrgChart API (`/api/orgchart`)

- `GET /hierarchy` - Get flat hierarchy list
- `GET /tree` - Get hierarchical tree structure
- `GET /department/:department` - Get employees by department
- `GET /direct-reports/:manager_id` - Get direct reports
- `POST /relationship` - Create/update org relationship

---

## 🎨 FRONTEND PAGES

### Reports.jsx
- **Features:**
  - Report type selector (Attendance, Leave, Sales, Stock, Project Cost)
  - Dynamic filters based on report type
  - Date range filters
  - Generate report button
  - Dynamic table rendering
  - Export to Excel button
- **Styling:** Table layout with filter panel

### NotificationCenter.jsx
- **Features:**
  - Notification list with unread indicator
  - Filter by read/unread status
  - Notification type badges (info, success, warning, error, approval)
  - Mark as read functionality
  - Mark all as read
  - Delete notifications
  - Timestamp display
  - Module name display
- **Styling:** Card-based layout with color-coded types

### OrgChart.jsx
- **Features:**
  - List view (grouped by department)
  - Tree view (hierarchical structure)
  - View toggle
  - Employee cards with designation
  - Manager relationships
  - Department grouping
- **Styling:** Grid layout for list, tree structure for hierarchy

### AuditLogs.jsx
- **Features:**
  - Audit log table
  - Filter by module, action type, date range
  - Action type badges (create, update, delete, approve, etc.)
  - User name display
  - IP address tracking
  - Timestamp display
- **Styling:** Table layout with filter panel

---

## 📊 USAGE EXAMPLES

### Generate and Save Report

```javascript
// 1. Generate Attendance Report
GET /api/reports/attendance?start_date=2024-01-01&end_date=2024-01-31&department=IT

// 2. Save Report Configuration
POST /api/reports/saved
{
  "report_name": "Monthly IT Attendance",
  "module_name": "hr",
  "report_type": "attendance",
  "filters_json": {
    "department": "IT",
    "date_range": "monthly"
  },
  "columns_json": ["name", "department", "present_days", "absent_days"],
  "is_public": false
}

// 3. Get Saved Reports
GET /api/reports/saved
```

### Create and Use Document Template

```javascript
// 1. Create Template
POST /api/documents/templates
{
  "template_name": "Offer Letter",
  "document_type": "offer_letter",
  "template_html": "<html><body><h1>Offer Letter</h1><p>Dear {{employee_name}},</p><p>We are pleased to offer you the position of {{designation}} with a salary of {{salary}}.</p></body></html>",
  "variables_json": ["employee_name", "designation", "salary", "joining_date"]
}

// 2. Generate Document
POST /api/documents/generate
{
  "template_id": "template_uuid",
  "document_type": "offer_letter",
  "reference_id": "employee_uuid",
  "reference_type": "employee",
  "document_data_json": {
    "employee_name": "John Doe",
    "designation": "Software Engineer",
    "salary": "₹800,000",
    "joining_date": "2024-02-01"
  },
  "file_path": "/documents/offer_letter_john_doe.pdf"
}

// 3. Get Generated Documents
GET /api/documents/generated?reference_id=employee_uuid&reference_type=employee
```

### Notification Workflow

```javascript
// 1. Create Notification
POST /api/notifications
{
  "user_id": "employee_uuid",
  "title": "Leave Approved",
  "message": "Your leave request from 2024-02-01 to 2024-02-05 has been approved",
  "module_name": "hr",
  "reference_id": "leave_uuid",
  "notification_type": "success"
}

// 2. Get Unread Notifications
GET /api/notifications?is_read=false

// 3. Mark as Read
PUT /api/notifications/:notification_id/read

// 4. Get Unread Count
GET /api/notifications/unread-count
// Returns: { "count": 5 }

// 5. Mark All as Read
PUT /api/notifications/mark-all-read
```

### Audit Logging

```javascript
// 1. Log Create Action
POST /api/audit
{
  "module_name": "employees",
  "action_type": "create",
  "reference_id": "employee_uuid",
  "reference_type": "employee",
  "new_data_json": {
    "name": "John Doe",
    "email": "john@example.com",
    "designation": "Software Engineer"
  }
}

// 2. Log Update Action
POST /api/audit
{
  "module_name": "employees",
  "action_type": "update",
  "reference_id": "employee_uuid",
  "reference_type": "employee",
  "old_data_json": { "salary": 700000 },
  "new_data_json": { "salary": 800000 }
}

// 3. Search Audit Logs
GET /api/audit?module_name=employees&action_type=update&start_date=2024-01-01&end_date=2024-01-31

// 4. Get Logs for Specific Record
GET /api/audit/reference/employee_uuid/employee

// 5. Get Activity Summary
GET /api/audit/activity-summary?start_date=2024-01-01&end_date=2024-01-31
```

### Organization Chart

```javascript
// 1. Create Org Relationship
POST /api/orgchart/relationship
{
  "employee_id": "employee_uuid",
  "manager_id": "manager_uuid",
  "department": "Engineering",
  "position_level": 2
}

// 2. Get Hierarchy
GET /api/orgchart/hierarchy
// Returns flat list with manager relationships

// 3. Get Tree Structure
GET /api/orgchart/tree
// Returns nested tree structure

// 4. Get Department Employees
GET /api/orgchart/department/Engineering

// 5. Get Direct Reports
GET /api/orgchart/direct-reports/manager_uuid
```

---

## 🎯 KEY FEATURES

### Reports Engine
✅ Prebuilt reports for all modules  
✅ Custom report builder  
✅ Save report configurations  
✅ Dynamic filters  
✅ Export to Excel/PDF  
✅ Scheduled email reports  
✅ Public/private reports  

### Document Generator
✅ Template management  
✅ HTML templates with variables  
✅ Variable placeholders  
✅ PDF generation  
✅ Version history  
✅ Multiple document types  
✅ Document tracking  

### Notification Center
✅ Real-time notifications  
✅ Read/unread tracking  
✅ Notification types (info, success, warning, error, approval)  
✅ Module-based filtering  
✅ Mark all as read  
✅ Delete notifications  
✅ Unread count badge  

### Organization Chart
✅ Hierarchical structure  
✅ Manager-employee relationships  
✅ Department grouping  
✅ List and tree views  
✅ Position levels  
✅ Direct reports  
✅ Visual hierarchy  

### Audit Log
✅ Complete action tracking  
✅ Before/after state capture  
✅ IP address logging  
✅ User agent tracking  
✅ Module-based filtering  
✅ Action type filtering  
✅ Date range search  
✅ Activity summary  

---

## 🚀 PRODUCTION READY

- ✅ UUID primary keys
- ✅ Soft delete with audit trail
- ✅ Comprehensive indexing
- ✅ JSONB for flexible data
- ✅ RESTful API design
- ✅ Responsive UI
- ✅ Consistent styling
- ✅ Integration ready

---

## 📝 NOTES

- Reports use JSONB for flexible filter/column storage
- Document templates support HTML with {{variable}} placeholders
- Notifications auto-expire after 30 days (can be configured)
- Audit logs are immutable (no updates/deletes)
- OrgChart position_level: 0=CEO, 1=VP, 2=Manager, 3=Team Lead, 4=Individual Contributor
- All timestamps in UTC
- IP address captured from request
- User agent captured for device tracking

---

**Module Status:** ✅ Production Ready  
**Last Updated:** 2024  
**Version:** 1.0.0
