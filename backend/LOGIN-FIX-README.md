# 🔐 Login Fix + Complete Setup Guide
## Pulse ERP — Getting Started

---

## WHY LOGIN FAILS

The login page shows "Login failed" for one of these reasons:
1. **User doesn't exist** in the database (most common)
2. **Password was stored un-hashed** (plain text won't match bcrypt)
3. **Frontend can't reach backend** (missing `.env` or wrong port)

---

## STEP 1 — Fix the Database (Do this first)

Open **pgAdmin** → Connect to your `Pulse` database → Open Query Tool → paste and run:

```sql
-- Paste entire contents of fix-login-users.sql here
```

Or run from terminal:
```bash
psql -U postgres -d Pulse -f fix-login-users.sql
```

This creates **all users** with password **`password123`**.

---

## STEP 2 — Verify Users Exist

In pgAdmin Query Tool:
```sql
SELECT email, role, is_active FROM users ORDER BY id;
```

You should see these rows:

| Email | Role | Active |
|---|---|---|
| `superadmin@company.com` | super_admin | true |
| `superadmin@pulse.com` | super_admin | true |
| `admin@company.com` | super_admin | true |
| `admin@pulse.com` | super_admin | true |
| `hr@company.com` | manager | true |
| `finance@company.com` | manager | true |
| `manager@company.com` | manager | true |
| `employee@company.com` | employee | true |
| `john@pulse.com` | employee | true |

---

## STEP 3 — Set Up Frontend Project Root

The `src/` folder needs a project root. Copy these files to the **folder that contains your `src/` folder**:

```
your-project/
├── package.json        ← copy this
├── vite.config.js      ← copy this
├── index.html          ← copy this
├── .env                ← copy this
└── src/                ← your existing React source
    ├── main.jsx
    ├── App.jsx
    └── ...
```

---

## STEP 4 — Install Frontend Dependencies

```bash
# In the folder containing src/ (NOT inside src/)
npm install
```

---

## STEP 5 — Set Up Backend Environment

Make sure `backend/.env` has:
```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=Pulse
DB_USER=postgres
DB_PASSWORD=1234567890
JWT_SECRET=mysupersecretkey
PORT=5000
NODE_ENV=development
```

Change `DB_PASSWORD` to match your PostgreSQL password.

---

## STEP 6 — Run Both Servers

**Terminal 1 — Backend:**
```bash
cd backend
npm install
npm run dev
```

Wait for: `[Server] Pulse ERP running on port 5000` and `[DB] Connected to PostgreSQL`

**Terminal 2 — Frontend:**
```bash
# From the folder containing src/
npm run dev
```

Wait for: `Local: http://localhost:5173/`

---

## STEP 7 — Login

Open `http://localhost:5173`

| Email | Password | Role |
|---|---|---|
| `superadmin@company.com` | `password123` | Super Admin |
| `admin@pulse.com` | `password123` | Super Admin |
| `hr@pulse.com` | `password123` | Manager |
| `john@pulse.com` | `password123` | Employee |

---

## TROUBLESHOOTING

### ❌ "Login failed. Please try again."

**Check 1 — Is backend running?**
Open browser: `http://localhost:5000/api/health`
- If you see `{"status":"healthy"}` → backend is up ✅
- If you see "This site can't be reached" → backend is not running ❌

**Check 2 — Does the user exist in DB?**
```sql
SELECT email, role, is_active FROM users WHERE email = 'superadmin@company.com';
```
- If no rows → run `fix-login-users.sql` again
- If `is_active = false` → run: `UPDATE users SET is_active=true;`

**Check 3 — Is password hash correct?**
```sql
SELECT email, LEFT(password_hash, 7) as hash_prefix FROM users;
```
- Should show `$2b$10$` or `$2a$10$` prefix (bcrypt format)
- If it shows `hashed_password` or plain text → run `fix-login-users.sql` to reset

**Check 4 — CORS issue?**
Open browser DevTools → Console → Look for red CORS errors
- Solution: make sure `.env` has `VITE_API_URL=http://localhost:5000/api`

**Check 5 — Rate limited?**
If you tried logging in many times, the backend rate-limits at 15 attempts per 15 min.
Wait 15 minutes OR restart the backend server.

---

## Quick Reset (Nuclear Option)

If nothing works, run this in pgAdmin to completely reset users:

```sql
TRUNCATE users CASCADE;
```

Then run `fix-login-users.sql` again.

---

## After Login — What You Can Do

| Role | Dashboard | Access |
|---|---|---|
| `super_admin` | Full ERP Dashboard | Everything |
| `admin` | Admin Dashboard | All modules |
| `manager` | Manager Dashboard | Team data |
| `employee` | Employee Home | Own data only |
