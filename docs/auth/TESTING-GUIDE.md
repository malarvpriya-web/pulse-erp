# Authentication Flow Testing Guide

## Prerequisites
1. Backend running on port 5000
2. Frontend running on port 5173 (or configured port)
3. Database setup completed with test users

## Setup Database
```bash
cd backend
node setup-users-permissions-new.js
```

## Test Users
| Email | Password | Role | Expected Redirect |
|-------|----------|------|-------------------|
| superadmin@company.com | password123 | super_admin | ERPDashboard |
| admin@company.com | password123 | admin | ERPDashboard |
| depthead@company.com | password123 | department_head | ERPDashboard |
| manager@company.com | password123 | manager | ERPDashboard |
| employee@company.com | password123 | employee | Home |

## Test Cases

### 1. Login Flow Test
**Steps:**
1. Open application (should show login page)
2. Enter email: `admin@company.com`
3. Enter password: `password123`
4. Click Login button

**Expected Results:**
- ✅ Loading state shows "Logging in..."
- ✅ POST request to `/api/auth/login` succeeds
- ✅ GET request to `/api/auth/permissions` succeeds
- ✅ localStorage contains:
  - `token` (JWT string)
  - `user` (JSON object with id, name, email, role, department)
  - `role` (string: "admin")
  - `permissions` (JSON array of permission objects)
- ✅ Redirects to ERPDashboard
- ✅ Sidebar shows all modules (admin has full access)

### 2. Permission-Based Sidebar Test
**Steps:**
1. Login as `employee@company.com`
2. Check sidebar visibility

**Expected Results:**
- ✅ Only shows modules where `can_view = true`
- ✅ Employee sees limited modules:
  - Home
  - Attendance
  - Leaves
  - Travel Desk
  - Service Desk
  - HR
  - Timesheets
- ✅ Does NOT see:
  - Finance
  - Inventory
  - Projects
  - CRM
  - Sales

### 3. Protected Route Test
**Steps:**
1. Login as `employee@company.com`
2. Try to access Finance module (if visible, manually navigate)
3. Check if access is blocked

**Expected Results:**
- ✅ Shows "Access Denied" message
- ✅ Provides "Go to Home" button
- ✅ Cannot view restricted content

### 4. Role-Based Redirect Test
**Test each role:**

**Super Admin:**
- Login: `superadmin@company.com`
- Expected: Redirects to ERPDashboard
- Sidebar: Shows ALL modules

**Admin:**
- Login: `admin@company.com`
- Expected: Redirects to ERPDashboard
- Sidebar: Shows ALL modules

**Department Head:**
- Login: `depthead@company.com`
- Expected: Redirects to ERPDashboard
- Sidebar: Shows manager-level modules

**Manager:**
- Login: `manager@company.com`
- Expected: Redirects to ERPDashboard
- Sidebar: Shows manager-level modules

**Employee:**
- Login: `employee@company.com`
- Expected: Redirects to Home
- Sidebar: Shows employee-level modules only

### 5. Logout Test
**Steps:**
1. Login with any user
2. Click "Logout" button in topbar

**Expected Results:**
- ✅ localStorage cleared:
  - `token` removed
  - `user` removed
  - `role` removed
  - `permissions` removed
- ✅ Redirects to login page
- ✅ Cannot access protected routes

### 6. Session Persistence Test
**Steps:**
1. Login with any user
2. Refresh the page (F5)

**Expected Results:**
- ✅ User remains logged in
- ✅ Same page/dashboard shown
- ✅ Sidebar permissions maintained

### 7. Invalid Credentials Test
**Steps:**
1. Enter email: `test@company.com`
2. Enter password: `wrongpassword`
3. Click Login

**Expected Results:**
- ✅ Shows error: "Invalid email or password"
- ✅ Does not redirect
- ✅ Form remains accessible
- ✅ No data stored in localStorage

### 8. Inactive Account Test
**Steps:**
1. Update user in database: `UPDATE users SET is_active = false WHERE email = 'employee@company.com'`
2. Try to login with `employee@company.com`

**Expected Results:**
- ✅ Shows error: "Account is inactive"
- ✅ Login blocked
- ✅ No token generated

### 9. Token Expiration Test
**Steps:**
1. Login successfully
2. Manually expire token (wait 8 hours or modify JWT_SECRET)
3. Try to access protected API endpoint

**Expected Results:**
- ✅ API returns 401 error
- ✅ Shows "Session expired" message
- ✅ Redirects to login

### 10. Permission Check Test
**Steps:**
1. Login as `employee@company.com`
2. Open browser console
3. Run: `localStorage.getItem('permissions')`

**Expected Results:**
```json
[
  {
    "module": "employees",
    "can_view": true,
    "can_add": false,
    "can_edit": false,
    "can_delete": false,
    "can_approve": false,
    "can_export": false
  },
  // ... other modules
]
```

## Debugging

### Check localStorage
```javascript
// In browser console
console.log('Token:', localStorage.getItem('token'));
console.log('User:', JSON.parse(localStorage.getItem('user')));
console.log('Role:', localStorage.getItem('role'));
console.log('Permissions:', JSON.parse(localStorage.getItem('permissions')));
```

### Check API Calls
1. Open Network tab in DevTools
2. Login
3. Verify:
   - POST `/api/auth/login` returns 200
   - GET `/api/auth/permissions` returns 200
   - Authorization header present: `Bearer <token>`

### Check Permission Function
```javascript
// In browser console
import { hasPermission } from './utils/permissions';
console.log(hasPermission('finance', 'view')); // Should return true/false
```

## Common Issues

### Issue: Login succeeds but sidebar empty
**Solution:** Check permissions are fetched and stored correctly

### Issue: "Session expired" immediately after login
**Solution:** Check JWT_SECRET matches between frontend and backend

### Issue: All users see same sidebar
**Solution:** Verify role is stored correctly in localStorage

### Issue: Permission check always returns false
**Solution:** Check module names match exactly in permissions table

### Issue: Redirect not working
**Solution:** Verify role value matches expected values in roleRedirects object

## API Endpoints Reference

### POST /api/auth/login
```bash
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@company.com","password":"password123"}'
```

### GET /api/auth/permissions
```bash
curl -X GET http://localhost:5000/api/auth/permissions \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

## Success Criteria
- ✅ All 10 test cases pass
- ✅ No console errors
- ✅ Proper error messages displayed
- ✅ Permissions enforced correctly
- ✅ Role-based navigation works
- ✅ Logout clears all data
- ✅ Session persists on refresh
