# Pulse ERP — Deployment Guide

## Architecture

| Layer    | Technology              | Host              |
|----------|-------------------------|-------------------|
| Frontend | React 19 + Vite 8       | Vercel / Netlify  |
| Backend  | Node.js + Express       | Railway           |
| Database | PostgreSQL (Neon.tech)  | Neon serverless   |

---

## Backend Deployment (Railway)

### 1. Environment Variables (Railway dashboard → Settings → Variables)

| Variable        | Value                                                      | Required |
|-----------------|------------------------------------------------------------|----------|
| `DATABASE_URL`  | `postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require` | ✅ **Critical** |
| `JWT_SECRET`    | Any random 32+ char string (e.g. `openssl rand -hex 32`)  | ✅ Required |
| `NODE_ENV`      | `production`                                               | Recommended |
| `FRONTEND_URL`  | `https://your-frontend.vercel.app`                         | For CORS |
| `PORT`          | `5000` (Railway sets this automatically)                   | Auto-set |

> **Most common error:** `ECONNREFUSED ::1:5432` means `DATABASE_URL` is not set.
> → Go to Railway → Your Service → Variables → Add `DATABASE_URL`

### 2. Getting your DATABASE_URL

From [Neon dashboard](https://console.neon.tech):
1. Select your project
2. Click **Connection Details**
3. Copy the **Pooled connection** string (ends with `?sslmode=require`)

### 3. Deploy Steps

```bash
# Push to GitHub — Railway auto-deploys on push
git add .
git commit -m "Deploy Phase 20"
git push origin main
```

Railway detects `railway.toml` → builds with nixpacks → runs `node server.js`.

### 4. Verify Deployment

Check Railway logs for:
```
[DB] Connected to PostgreSQL — Neon/cloud (DATABASE_URL)
[Server] Pulse ERP running on port 5000
✅ Database migrations completed successfully
```

Health check: `GET https://your-backend.up.railway.app/api/health`

---

## Frontend Deployment (Vercel)

### 1. Environment Variables

| Variable       | Value                                                        |
|----------------|--------------------------------------------------------------|
| `VITE_API_URL` | `https://your-backend.up.railway.app/api`                    |

### 2. Build Settings (Vercel)

| Setting           | Value               |
|-------------------|---------------------|
| Framework Preset  | Vite                |
| Root Directory    | `frontend`          |
| Build Command     | `npm run build`     |
| Output Directory  | `dist`              |

### 3. Deploy

```bash
# Option A: Vercel CLI
cd frontend
npx vercel --prod

# Option B: Push to GitHub (auto-deploy if connected)
git push origin main
```

---

## Test Credentials

| Email                 | Password      | Role         |
|-----------------------|---------------|--------------|
| admin@pulse.com       | password123   | Super Admin  |
| finance@pulse.com     | password123   | Admin        |
| hr@pulse.com          | password123   | Manager      |
| john@pulse.com        | password123   | Employee     |
| admin@company.com     | password123   | Super Admin  |

> Passwords are seeded via `runMigrations()` using bcrypt on first deploy.

---

## Troubleshooting

### `connect ECONNREFUSED ::1:5432`
**Cause:** `DATABASE_URL` not set in Railway
**Fix:** Railway → Service → Variables → add `DATABASE_URL` (Neon connection string)

### `Invalid token` / 401 on all requests
**Cause:** `JWT_SECRET` missing or different between deploys
**Fix:** Set `JWT_SECRET` in Railway Variables — use the same value everywhere

### CORS errors in browser console
**Cause:** `FRONTEND_URL` not set, or frontend URL doesn't match
**Fix:** Add `FRONTEND_URL=https://your-exact-frontend.vercel.app` to Railway Variables

### Login returns `Invalid email or password`
**Cause:** `users` table empty (migrations didn't run or failed)
**Fix:** Check Railway logs for migration errors. The `DATABASE_URL` must be set *before* first deploy so migrations can create the `users` table.

### `₹undefined` in payroll / finance
**Cause:** Field name mismatch between backend and frontend
**Fix:** All amounts go through `formatINR(value || 0)` — ensure backend returns numeric fields (not strings)

---

## Local Development

```bash
# Start backend
cd backend
npm install
# Create .env with DB_HOST, DB_USER, DB_PASSWORD (see .env file)
npm run dev   # nodemon server.js on port 5000

# Start frontend
cd frontend
npm install
# .env already set to http://localhost:5000/api
npm run dev   # Vite on port 5173
```

---

## Database Tables

| Table              | Purpose                    | Seed rows |
|--------------------|----------------------------|-----------|
| `employees`        | Core employee records       | 17+       |
| `users`            | Auth accounts               | 5         |
| `leave_requests`   | Leave applications          | 10+       |
| `attendance`       | Daily attendance log        | 200+      |
| `timesheets`       | Weekly timesheets           | 7+        |
| `holidays`         | Public holiday calendar     | 13        |
| `invoices`         | Finance invoices            | 10+       |
| `leads`            | CRM leads                   | 15+       |
| `projects`         | Project tracker             | 5         |
| `complaints`       | Customer complaints         | 5+        |
| `notifications`    | In-app notifications        | 20+       |
| `support_tickets`  | IT/HR service desk          | 8         |
| `inventory_items`  | Item master                 | 5+        |
| `travel_requests`  | Travel management           | 2+        |
| `announcements`    | Company announcements       | 5+        |
