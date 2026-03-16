# Authentication & Permission System Setup Guide

## Overview
Complete role-based authentication system with granular permissions for the Pulse ERP application.

## Database Structure

### Users Table
- `id` (primary key)
- `name`
- `email` (unique)
- `password_hash` (bcrypt)
- `role` (employee, manager, department_head, admin, super_admin)
- `department`
- `is_active`
- `created_at`

### Permissions Table
- `id` (primary key)
- `user_id` (foreign key)
- `module` (employees, finance, projects, reports, inventory, announcements, policies, downloads, leave, travel, service)
- `can_view`
- `can_add`
- `can_edit`
- `can_delete`
- `can_approve`
- `can_export`

## Setup Instructions

### 1. Run Database Setup
```bash
cd backend
node setup-users-permissions-new.js
```

This will:
- Create users and permissions tables
- Add indexes for performance
- Insert 5 test users with different roles
- Configure permissions for each role

### 2. Test Users Created

| Email | Password | Role | Dashboard Redirect |
|-------|----------|------|-------------------|
| superadmin@company.com | password123 | super_admin | /executive-dashboard |
| admin@company.com | password123 | admin | /admin-dashboard |
| depthead@company.com | password123 | department_head | /manager-dashboard |
| manager@company.com | password123 | manager | /manager-dashboard |
| employee@company.com | password123 | employee | /home |

### 3. Permission Levels by Role

**Super Admin**: Full access to all modules (view, add, edit, delete, approve, export)

**Admin**: Full access to all modules (view, add, edit, delete, approve, export)

**Department Head**: View, add, edit, approve, export (no delete)

**Manager**: View, add, edit, export (no delete, no approve)

**Employee**: View only (no add, edit, delete, approve, export)

## API Endpoints

### POST /api/auth/login
Login endpoint with bcrypt password verification.

**Request:**
```json
{
  "email": "admin@company.com",
  "password": "password123"
}
```

**Response:**
```json
{
  "token": "jwt_token_here",
  "user": {
    "id": 2,
    "name": "Admin User",
    "email": "admin@company.com",
    "role": "admin",
    "department": "HR"
  }
}
```

### GET /api/auth/permissions
Get user permissions (requires authentication).

**Headers:**
```
Authorization: Bearer <token>
```

**Response:**
```json
{
  "permissions": [
    {
      "module": "employees",
      "can_view": true,
      "can_add": true,
      "can_edit": true,
      "can_delete": true,
      "can_approve": true,
      "can_export": true
    }
  ]
}
```

## Frontend Implementation

### Login Flow
1. User enters email and password
2. System validates credentials
3. JWT token generated (8-hour expiration)
4. User data and permissions fetched
5. Stored in localStorage:
   - `token`
   - `user` (JSON string)
   - `role`
   - `permissions` (JSON string)
6. User redirected based on role

### Role-Based Redirection
- `employee` → `/home`
- `manager` → `/manager-dashboard`
- `department_head` → `/manager-dashboard`
- `admin` → `/admin-dashboard`
- `super_admin` → `/executive-dashboard`

### Permission Checking

**In Components:**
```javascript
import { hasPermission } from "../utils/permissions";

// Check if user can view finance module
if (hasPermission("finance", "view")) {
  // Show finance menu
}

// Check if user can add employees
if (hasPermission("employees", "add")) {
  // Show add button
}
```

**In Sidebar:**
Automatically filters menu items based on permissions.

**In Layout:**
Redirects to `/unauthorized` if user tries to access restricted page.

### Logout
Clears all authentication data:
- token
- user
- role
- permissions

## Security Features

1. **Password Hashing**: bcrypt with 10 salt rounds
2. **JWT Authentication**: 8-hour token expiration
3. **Token Verification**: Middleware checks on protected routes
4. **Role Validation**: Server-side role checking
5. **Permission Validation**: Granular module-level permissions
6. **Session Expiry**: Friendly error messages
7. **Inactive Account**: Blocks login for inactive users

## Error Messages

- "Invalid email or password" - Wrong credentials
- "Account is inactive" - User account disabled
- "Session expired" - Token expired or invalid
- "Access denied" - Insufficient permissions

## Testing

### Test Login
1. Start backend: `npm run dev` (in backend folder)
2. Start frontend: `npm run dev` (in frontend folder)
3. Login with any test user
4. Verify role-based redirection
5. Check sidebar visibility based on permissions
6. Try accessing restricted pages

### Test Permissions
1. Login as employee@company.com
2. Verify limited sidebar menu
3. Try accessing /finance directly
4. Should redirect to /unauthorized

### Test Logout
1. Click logout button
2. Verify redirect to login
3. Verify localStorage cleared
4. Try accessing protected route
5. Should redirect to login

## Modules Available

- employees
- finance
- projects
- reports
- inventory
- announcements
- policies
- downloads
- leave
- travel
- service

## Adding New Users

Use the register endpoint or insert directly:

```javascript
const response = await api.post("/auth/register", {
  name: "New User",
  email: "newuser@company.com",
  password: "password123",
  role: "employee",
  department: "Sales"
});
```

Then add permissions for each module.

## Troubleshooting

**Login fails:**
- Check database connection
- Verify user exists in users table
- Check password hash matches

**Permissions not working:**
- Verify permissions table has entries for user
- Check localStorage has permissions data
- Verify module names match exactly

**Token expired:**
- User needs to login again
- Token expires after 8 hours

**Sidebar not showing modules:**
- Check permissions.can_view = true
- Verify module name mapping in Sidebar.jsx

## Production Considerations

1. Change JWT_SECRET in .env
2. Use HTTPS for all requests
3. Implement refresh tokens
4. Add rate limiting on login
5. Log authentication attempts
6. Implement password reset
7. Add 2FA for admin users
8. Regular security audits
