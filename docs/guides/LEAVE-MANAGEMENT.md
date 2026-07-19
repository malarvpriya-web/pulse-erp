# Leave Management Module - Implementation Guide

## Overview
Complete leave management system with employee self-service, manager approvals, and admin oversight.

## Database Schema

### Leaves Table
```sql
CREATE TABLE leaves (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  leave_type VARCHAR(50) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  days DECIMAL(4,1) NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  manager_comment TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Status Values:**
- `pending` - Awaiting manager approval
- `approved` - Approved by manager
- `rejected` - Rejected by manager

## Backend APIs

### 1. POST /api/leaves
**Description:** Create new leave request

**Authentication:** Required (Bearer token)

**Request Body:**
```json
{
  "leave_type": "Sick Leave",
  "start_date": "2026-03-20",
  "end_date": "2026-03-22",
  "days": 3,
  "reason": "Medical appointment"
}
```

**Response:**
```json
{
  "id": 1,
  "employee_id": 5,
  "leave_type": "Sick Leave",
  "start_date": "2026-03-20",
  "end_date": "2026-03-22",
  "days": 3,
  "reason": "Medical appointment",
  "status": "pending",
  "created_at": "2026-03-15T10:30:00Z"
}
```

### 2. GET /api/leaves/my
**Description:** Get current user's leave requests

**Authentication:** Required

**Response:**
```json
[
  {
    "id": 1,
    "employee_id": 5,
    "first_name": "John",
    "last_name": "Doe",
    "department": "Finance",
    "leave_type": "Sick Leave",
    "start_date": "2026-03-20",
    "end_date": "2026-03-22",
    "days": 3,
    "reason": "Medical appointment",
    "status": "pending",
    "manager_comment": null,
    "created_at": "2026-03-15T10:30:00Z"
  }
]
```

### 3. GET /api/leaves/team
**Description:** Get leave requests for team members (manager view)

**Authentication:** Required

**Response:** Same as /my but includes all team members

### 4. GET /api/leaves
**Description:** Get all leave requests (admin view)

**Authentication:** Required

**Response:** Same as /my but includes all employees

### 5. PATCH /api/leaves/:id/approve
**Description:** Approve a leave request

**Authentication:** Required

**Request Body:**
```json
{
  "manager_comment": "Approved. Take care."
}
```

**Response:**
```json
{
  "id": 1,
  "status": "approved",
  "manager_comment": "Approved. Take care.",
  "updated_at": "2026-03-16T09:00:00Z"
}
```

### 6. PATCH /api/leaves/:id/reject
**Description:** Reject a leave request

**Authentication:** Required

**Request Body:**
```json
{
  "manager_comment": "Please reschedule due to project deadline."
}
```

**Response:**
```json
{
  "id": 1,
  "status": "rejected",
  "manager_comment": "Please reschedule due to project deadline.",
  "updated_at": "2026-03-16T09:00:00Z"
}
```

## Frontend Pages

### 1. ApplyLeave.jsx
**Purpose:** Employee applies for leave

**Features:**
- Leave type dropdown (Sick, Casual, Earned, etc.)
- Date range picker
- Automatic days calculation
- Reason text area
- Form validation
- Success/error messages

**Access:** All employees

### 2. MyLeaves.jsx
**Purpose:** View own leave history

**Features:**
- Table view of all leave requests
- Status badges (color-coded)
- Date formatting
- Manager comments display

**Access:** All employees

### 3. TeamLeaves.jsx
**Purpose:** Manager reviews team leave requests

**Features:**
- Table view of team requests
- Approve/Reject actions
- Modal for review
- Manager comment input
- Real-time status updates

**Access:** Managers, Department Heads

### 4. AllLeaves.jsx
**Purpose:** Admin views all leave requests

**Features:**
- Statistics dashboard (Total, Pending, Approved, Rejected)
- Search by employee/department/leave type
- Filter by status
- Complete leave history
- Export capability (future)

**Access:** Admin, Super Admin

## Status Badge Colors

```javascript
const statusStyles = {
  pending: {
    background: "#fed7aa",  // Orange
    color: "#9a3412"
  },
  approved: {
    background: "#bbf7d0",  // Green
    color: "#166534"
  },
  rejected: {
    background: "#fecaca",  // Red
    color: "#991b1b"
  }
};
```

## Leave Types

1. Sick Leave
2. Casual Leave
3. Earned Leave
4. Maternity Leave
5. Paternity Leave
6. Unpaid Leave
7. Compensatory Off

## Date Formatting

All dates use the global date formatter:

```javascript
import { formatDate } from "../utils/dateFormatter";

formatDate("2026-03-20"); // "20 March 2026"
```

## Setup Instructions

### Backend Setup
```bash
cd backend

# Create leaves table
node setup-leaves.js

# Start server
npm run dev
```

### Frontend
No additional setup required. Pages are already integrated.

## Testing

### Test Employee Flow
1. Login as `employee@company.com`
2. Navigate to Apply Leave
3. Fill form:
   - Leave Type: Sick Leave
   - Start Date: Tomorrow
   - End Date: Day after tomorrow
   - Reason: Medical appointment
4. Submit
5. Navigate to My Leaves
6. Verify leave appears with "PENDING" status

### Test Manager Flow
1. Login as `manager@company.com`
2. Navigate to Team Leaves
3. Verify employee's leave request appears
4. Click "Review"
5. Add manager comment
6. Click "Approve" or "Reject"
7. Verify status updates

### Test Admin Flow
1. Login as `admin@company.com`
2. Navigate to All Leaves
3. Verify all leave requests visible
4. Check statistics dashboard
5. Test search and filter

## API Testing with cURL

### Create Leave
```bash
curl -X POST http://localhost:5000/api/leaves \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "leave_type": "Sick Leave",
    "start_date": "2026-03-20",
    "end_date": "2026-03-22",
    "days": 3,
    "reason": "Medical appointment"
  }'
```

### Get My Leaves
```bash
curl http://localhost:5000/api/leaves/my \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Approve Leave
```bash
curl -X PATCH http://localhost:5000/api/leaves/1/approve \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "manager_comment": "Approved"
  }'
```

## Security

1. **Authentication:** All endpoints require valid JWT token
2. **Authorization:** 
   - Employees can only view/create their own leaves
   - Managers can view/approve team leaves
   - Admins can view all leaves
3. **Validation:**
   - End date must be >= start date
   - All required fields validated
   - Days must be positive number

## Future Enhancements

1. **Leave Balance Tracking**
   - Track available leave days per type
   - Deduct from balance on approval
   - Show remaining balance

2. **Email Notifications**
   - Notify manager on new request
   - Notify employee on approval/rejection

3. **Calendar Integration**
   - Visual calendar view
   - Team availability calendar
   - Holiday integration

4. **Leave Policies**
   - Configure leave types per company
   - Set maximum days per type
   - Blackout dates

5. **Reporting**
   - Leave utilization reports
   - Department-wise analysis
   - Export to Excel/PDF

6. **Attachments**
   - Upload medical certificates
   - Supporting documents

## Troubleshooting

### Issue: Leave not appearing in My Leaves
**Solution:** Check employee_id matches logged-in user

### Issue: Manager cannot see team leaves
**Solution:** Verify reporting_manager field in employees table

### Issue: Dates not formatting correctly
**Solution:** Ensure dateFormatter utility is imported

### Issue: Status badge not showing color
**Solution:** Check status value matches exactly (pending/approved/rejected)

## Files Created

### Backend
- `src/leaves/leave.service.js`
- `src/leaves/leave.controller.js`
- `src/leaves/leave.routes.js`
- `database/leaves-schema.sql`
- `setup-leaves.js`

### Frontend
- `pages/ApplyLeave.jsx`
- `pages/MyLeaves.jsx`
- `pages/TeamLeaves.jsx`
- `pages/AllLeaves.jsx`

## Success Criteria

✅ Employees can apply for leave
✅ Employees can view their leave history
✅ Managers can view team leave requests
✅ Managers can approve/reject leaves
✅ Admins can view all leaves
✅ Status badges show correct colors
✅ Dates display in DD Month YYYY format
✅ Authentication works on all endpoints
✅ Manager comments saved and displayed
✅ Real-time updates after approval/rejection
