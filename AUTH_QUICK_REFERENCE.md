# Authentication System Quick Reference

## 📋 Implementation Checklist

### Backend ✅
- [x] Users table with bcrypt password hashing
- [x] Permissions table with module-level access
- [x] POST /api/auth/login endpoint
- [x] GET /api/auth/permissions endpoint
- [x] JWT token generation (8-hour expiry)
- [x] Token verification middleware
- [x] Role validation middleware
- [x] Permission checking middleware

### Frontend ✅
- [x] Login page with API integration
- [x] Token storage in localStorage
- [x] User data storage in localStorage
- [x] Role storage in localStorage
- [x] Permissions storage in localStorage
- [x] Role-based redirect after login
- [x] Permission-based sidebar filtering
- [x] Protected route component
- [x] Unauthorized page
- [x] Logout functionality

## 🔑 localStorage Keys

```javascript
localStorage.setItem("token", "jwt_token_string");
localStorage.setItem("user", JSON.stringify({
  id: 1,
  name: "Admin User",
  email: "admin@company.com",
  role: "admin",
  department: "HR"
}));
localStorage.setItem("role", "admin");
localStorage.setItem("permissions", JSON.stringify([
  {
    module: "employees",
    can_view: true,
    can_add: true,
    can_edit: true,
    can_delete: true,
    can_approve: true,
    can_export: true
  }
]));
```

## 🚀 Login Flow

```
1. User enters email/password
   ↓
2. POST /api/auth/login
   ↓
3. Backend validates credentials
   ↓
4. Backend generates JWT token
   ↓
5. Frontend stores token
   ↓
6. GET /api/auth/permissions (with token)
   ↓
7. Frontend stores permissions
   ↓
8. Redirect based on role
   ↓
9. Render dashboard with filtered sidebar
```

## 🎯 Role-Based Redirects

| Role | Redirect Page |
|------|---------------|
| employee | Home |
| manager | ERPDashboard |
| department_head | ERPDashboard |
| admin | ERPDashboard |
| super_admin | ERPDashboard |

## 🔒 Permission Modules

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

## 🛡️ Permission Actions

- can_view
- can_add
- can_edit
- can_delete
- can_approve
- can_export

## 📝 Code Snippets

### Check Permission
```javascript
import { hasPermission } from "../utils/permissions";

if (hasPermission("finance", "view")) {
  // Show finance module
}

if (hasPermission("employees", "add")) {
  // Show add employee button
}
```

### Get User Info
```javascript
const user = JSON.parse(localStorage.getItem("user"));
console.log(user.name); // "Admin User"
console.log(user.role); // "admin"
```

### Make Authenticated API Call
```javascript
const token = localStorage.getItem("token");
const response = await api.get("/employees", {
  headers: { Authorization: `Bearer ${token}` }
});
```

### Logout
```javascript
const handleLogout = () => {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  localStorage.removeItem("role");
  localStorage.removeItem("permissions");
  window.location.href = "/";
};
```

## 🧪 Test Users

```
superadmin@company.com / password123
admin@company.com / password123
depthead@company.com / password123
manager@company.com / password123
employee@company.com / password123
```

## ⚠️ Error Messages

| Error | Meaning |
|-------|---------|
| Invalid email or password | Wrong credentials |
| Account is inactive | User account disabled |
| Session expired | Token expired or invalid |
| Access denied | Insufficient permissions |

## 🔧 Setup Commands

```bash
# Setup database
cd backend
node setup-users-permissions-new.js

# Start backend
npm run dev

# Start frontend (new terminal)
cd frontend
npm run dev
```

## 📊 Permission Levels by Role

### Super Admin
- All modules: ✅ View, Add, Edit, Delete, Approve, Export

### Admin
- All modules: ✅ View, Add, Edit, Delete, Approve, Export

### Department Head
- All modules: ✅ View, Add, Edit, Approve, Export
- ❌ Delete

### Manager
- All modules: ✅ View, Add, Edit, Export
- ❌ Delete, Approve

### Employee
- All modules: ✅ View only
- ❌ Add, Edit, Delete, Approve, Export

## 🎨 Login Button Styling

```javascript
style={{
  background: "#b5b5b5",
  color: "white",
  cursor: "pointer"
}}
onMouseEnter={(e) => e.target.style.background = "#0284c7"}
onMouseLeave={(e) => e.target.style.background = "#b5b5b5"}
```

## 📱 API Endpoints

### Login
```
POST /api/auth/login
Body: { email, password }
Response: { token, user }
```

### Get Permissions
```
GET /api/auth/permissions
Headers: { Authorization: "Bearer <token>" }
Response: { permissions: [...] }
```

## 🔍 Debugging

```javascript
// Check if logged in
console.log(!!localStorage.getItem("token"));

// Check current role
console.log(localStorage.getItem("role"));

// Check permissions
console.log(JSON.parse(localStorage.getItem("permissions")));

// Check user data
console.log(JSON.parse(localStorage.getItem("user")));
```

## ✨ Key Features

1. ✅ Bcrypt password hashing
2. ✅ JWT authentication (8-hour expiry)
3. ✅ Role-based access control
4. ✅ Module-level permissions
5. ✅ Action-level permissions
6. ✅ Automatic sidebar filtering
7. ✅ Protected routes
8. ✅ Session persistence
9. ✅ Secure logout
10. ✅ Friendly error messages
