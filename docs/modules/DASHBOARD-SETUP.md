# ERP Dashboard Installation Guide

## Required Packages

Install the following packages for the dashboard to work:

```bash
cd frontend
npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities chart.js react-chartjs-2
```

## Package Details

- **@dnd-kit/core** - Core drag and drop functionality
- **@dnd-kit/sortable** - Sortable drag and drop for widget rearrangement
- **@dnd-kit/utilities** - Utility functions for dnd-kit
- **chart.js** - Chart rendering library
- **react-chartjs-2** - React wrapper for Chart.js

## Backend Setup

The dashboard routes are already integrated into the backend server.

## Usage

1. Install the packages above
2. Navigate to the ERPDashboard page from your sidebar
3. The dashboard will automatically load widgets based on user role (admin/executive, manager, or employee)
4. Drag and drop widgets to rearrange
5. Use checkboxes to show/hide widgets
6. Click "Reset Layout" to restore default layout

## Features

✅ Role-based widget display
✅ Drag and drop widget rearrangement
✅ Show/hide widgets
✅ Persistent layout (saved in localStorage)
✅ Real-time data from backend
✅ Responsive design
✅ Interactive charts
✅ Security - only shows data user has permission to view

## Widget Types

### Executive Dashboard
- Revenue Overview (with trend chart)
- Profitability metrics
- Cash Position
- Sales Pipeline
- Workforce Snapshot
- Operations Snapshot
- Notifications

### Manager Dashboard
- Team Attendance Today
- Pending Approvals
- Project Health
- Team Performance
- Department Spend (with chart)
- Notifications

### Employee Dashboard
- My Attendance (with chart)
- My Leave Balance
- My Tasks
- My Approvals Status
- My Payslips
- Announcements & Celebrations

## Customization

To add new widgets:

1. Create widget component in `frontend/src/components/dashboard/widgets/`
2. Add widget type to `dashboardConfig.js`
3. Add widget to appropriate role array
4. Add data fetching logic in backend `dashboard.controller.js`
5. Import and register in `Widget.jsx`

## API Endpoints

- `GET /api/dashboard` - Get user info
- `GET /api/dashboard/data` - Get dashboard data based on role
