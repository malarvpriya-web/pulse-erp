# Pulse ERP — Production Go-Live Runbook

**Last updated:** 2026-04-25  
**Target platform:** Render.com (managed PostgreSQL + Node web service + static frontend)

---

## Pre-flight: Roles

| Owner | Scope |
|---|---|
| **Backend Dev** | Server, migrations, env vars, smoke tests |
| **Frontend Dev** | Build artifacts, SPA config |
| **DB Admin** | PostgreSQL plan upgrade, connection limits, backups |
| **Product Lead** | Go/no-go sign-off, stakeholder communication |

---

## Phase 1 — Environment Validation

> Run before any build. Fix ALL failures before proceeding.

| # | Step | Command | Owner | Pass criteria |
|---|---|---|---|---|
| 1.1 | Confirm Render DB is paid tier | Render dashboard → pulse-db → Plan | DB Admin | Not "free" (free = 90-day expiry, 25-conn limit) |
| 1.2 | Verify all required env vars set in Render backend | Render dashboard → pulse-backend → Environment | Backend Dev | All 9 vars present (see list below) |
| 1.3 | Verify FRONTEND_URL matches actual static URL | Render dashboard → pulse-frontend → URL | Backend Dev | No trailing slash; matches CORS origin in server.js |
| 1.4 | Confirm JWT_SECRET is ≥ 32 chars | `echo $JWT_SECRET \| wc -c` (Render shell) | Backend Dev | ≥ 33 (includes newline) |
| 1.5 | Verify ALERT_WEBHOOK_URL is reachable | `curl -s -o /dev/null -w "%{http_code}" $ALERT_WEBHOOK_URL` | Backend Dev | 2xx or 405 |

**Required env vars (render.yaml reference):**

```
NODE_ENV=production
PORT=10000
DATABASE_URL          # auto-linked from pulse-db
JWT_SECRET            # auto-generated — rotate before go-live
FRONTEND_URL          # e.g. https://pulse-erp.onrender.com
ALERT_WEBHOOK_URL     # Slack/Teams webhook for health alerts
ALERT_THRESHOLD_MS=800
MEMORY_ALERT_MB=450
LOG_TO_FILE=true
```

---

## Phase 2 — Database Migrations

| # | Step | Command | Owner | Pass criteria |
|---|---|---|---|---|
| 2.1 | Check current migration status | `cd backend && npm run migrate:status` | Backend Dev | All expected migrations show "applied" |
| 2.2 | Run pending migrations | `cd backend && npm run migrate` | Backend Dev | "Database schema is up to date" with no errors |
| 2.3 | Verify checksums (tamper check) | `cd backend && node -e "import('./src/config/migrations.js').then(m=>m.verifyApplied())"` | Backend Dev | No checksum mismatch errors |
| 2.4 | Spot-check critical tables exist | See SQL block below | DB Admin | All 9 tables present |
| 2.5 | Verify seed data | See SQL block below | DB Admin | leave_types ≥ 5, employees ≥ 1 |

**Table presence check:**

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'employees','leave_applications','leave_types','leave_balances',
    'exit_requests','exit_interviews','exit_clearance',
    'fixed_assets','schema_migrations'
  )
ORDER BY table_name;
-- Expect: 9 rows
```

**Seed data check:**

```sql
SELECT 'leave_types' AS tbl, COUNT(*) FROM leave_types WHERE is_active = true
UNION ALL
SELECT 'employees', COUNT(*) FROM employees WHERE status IS DISTINCT FROM 'Left';
```

**Rollback command (if migration breaks prod):**

```bash
cd backend && npm run migrate:rollback
# Rolls back the last applied migration (each migration runs in a transaction)
```

---

## Phase 3 — Build Artifacts

| # | Step | Command | Owner | Pass criteria |
|---|---|---|---|---|
| 3.1 | Install backend deps | `cd backend && npm install --omit=dev` | Backend Dev | No audit high/critical |
| 3.2 | Run backend tests | `cd backend && npm test` | Backend Dev | 0 failures |
| 3.3 | Install frontend deps | `cd frontend && npm install` | Frontend Dev | Clean install |
| 3.4 | Run frontend lint | `cd frontend && npm run lint:ci` | Frontend Dev | 0 errors (warnings OK) |
| 3.5 | Run frontend tests | `cd frontend && npm test -- --run` | Frontend Dev | 0 failures |
| 3.6 | Build frontend bundle | `cd frontend && npm run build` | Frontend Dev | `dist/` produced, no Vite errors |
| 3.7 | Check bundle size | `du -sh frontend/dist/assets/*.js \| sort -h \| tail -5` | Frontend Dev | No single chunk > 2 MB |
| 3.8 | Verify SPA rewrite in render.yaml | `rewrite: destination: /index.html` under pulse-frontend routes | Frontend Dev | Present — required for client-side routing |

---

## Phase 4 — Deployment

| # | Step | Command | Owner | Pass criteria |
|---|---|---|---|---|
| 4.1 | Run pre-deploy hook | `cd backend && npm run pre-deploy` | Backend Dev | No errors |
| 4.2 | Push to deploy branch (triggers Render auto-deploy) | `git push origin main` | Backend Dev | Render build pipeline starts within 60s |
| 4.3 | Monitor backend build logs | Render dashboard → pulse-backend → Logs | Backend Dev | "✅ Pulse ERP on port 10000" in logs |
| 4.4 | Monitor frontend build | Render dashboard → pulse-frontend → Logs | Frontend Dev | "Build successful" |
| 4.5 | Run post-deploy hook | `cd backend && npm run post-deploy` | Backend Dev | No errors |

---

## Phase 5 — Health Checks

| # | Step | Command | Owner | Pass criteria |
|---|---|---|---|---|
| 5.1 | Backend health endpoint | `curl https://<backend-url>/api/health` | Backend Dev | `{"status":"healthy","db":{"status":"connected",...}}` |
| 5.2 | DB latency | Parse `db.latency_ms` from health response | Backend Dev | < 200 ms |
| 5.3 | Memory | Parse `memory.rss_mb` from health response | Backend Dev | < 450 MB |
| 5.4 | Frontend loads | Open `https://<frontend-url>` in browser | Frontend Dev | Login page renders, no blank screen |
| 5.5 | Login smoke test | `POST /api/login` with valid credentials | Backend Dev | 200 with JWT token |
| 5.6 | Full smoke suite | `cd backend && npm run smoke:prod` | Backend Dev | All assertions pass |

**Quick health check one-liner:**

```bash
curl -s https://<backend-url>/api/health | node -e \
  "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
   console.log('Status:',d.status,'DB:',d.db?.status,'Latency:',d.db?.latency_ms+'ms','Mem:',d.memory?.rss_mb+'MB')"
```

---

## Phase 6 — Go / No-Go Sign-Off

> Product Lead reviews Phases 1–5 results and signs off.

| Condition | Decision |
|---|---|
| All health checks green, 0 smoke failures | **GO** |
| 1–2 non-critical smoke failures (cosmetic, non-auth) | **GO with ticket** — log, proceed |
| Any auth failure, DB connection error, or migration error | **NO-GO** — rollback immediately |
| Memory > 450 MB at startup | **NO-GO** — investigate before deploying |

---

## Rollback Plan

Execute in order if a NO-GO condition is detected post-deploy:

```bash
# Step 1: Revert to previous commit on Render (triggers redeploy)
git revert HEAD --no-edit
git push origin main

# Step 2: If migration caused the failure, rollback last migration
cd backend && npm run migrate:rollback

# Step 3: If DB is corrupted, restore from backup
cd backend && npm run backup:list               # find latest backup timestamp
cd backend && npm run backup:restore <timestamp> # confirm before running
```

| Step | Owner | Time estimate |
|---|---|---|
| Git revert + redeploy | Backend Dev | ~5 min (Render rebuild) |
| Migration rollback | Backend Dev | ~1 min |
| DB restore | DB Admin | 5–15 min |

---

## Post-Go-Live Monitoring (First 48 hours)

### Automated (health monitor runs every 5 min)
- Alerts fire to `ALERT_WEBHOOK_URL` if latency > 800 ms or memory > 450 MB
- Verify alerts arrive in configured channel within 10 min of deploy

### Hour 1 — Manual checks

| Check | How | Threshold |
|---|---|---|
| Error rate | Render logs → filter `"level":"ERROR"` | 0 errors in first 15 min |
| Auth failures | Filter `"status":401` or `"status":403` | < 5 in first hour |
| DB latency trend | `/api/health` repeated every 5 min | Stable < 200 ms |
| 500 errors | Filter `"status":500` | 0 — any 500 requires immediate investigation |
| Leave apply flow | Employee logs in, applies leave, checks status = pending | Pass |
| Exit management | Navigate to Exit Management, active list loads | Pass |

### Hour 24 — Manual checks

| Check | How | Action if failing |
|---|---|---|
| DB disk usage | Render → pulse-db → Storage | Alert if > 80% of plan limit |
| Slow queries | Filter logs `"ms":` values > 500 | Investigate query plan |
| Leave balance accuracy | Spot-check 2–3 employees via `/api/leaves-new/balance/:id` | File bug; do not hotfix day 1 |
| Backup integrity | `cd backend && npm run backup:drill` | Must complete without errors |

### Log filter reference (Render log search)

```
"status":5          → all 5xx errors
"level":"ERROR"     → application errors
"status":401        → auth failures
"ms":1[0-9]{3}      → requests > 1 second
[ExitRoutes]        → exit module errors
```

---

## Known Issues (do NOT block go-live)

| ID | Issue | Workaround | Target sprint |
|---|---|---|---|
| KI-01 | Leave balance shows 0 for new employees until bulk-allocate runs | HR runs `POST /api/leaves-new/bulk-allocate` once after deploy | Sprint +1 |
| KI-02 | FnF computation uses static 18-day leave balance, not live DB value | Manual adjustment during F&F approval | Sprint +1 |
| KI-03 | Exit clearance NOC checkboxes not linked to notification system | Manual follow-up by HR | Sprint +2 |
| KI-04 | Assets bulk import not implemented | Manual entry via form | Sprint +2 |
| KI-05 | `GET /api/dashboard` (root path) returns 404 | Frontend only calls sub-paths; not user-visible | Sprint +1 |

---

## Freeze Criteria (stop all deployments if triggered)

| Trigger | Action |
|---|---|
| Any auth bypass vulnerability reported | Freeze all deploys; patch within 4 hours |
| DB latency > 1000 ms sustained > 5 min | Page DB Admin; freeze non-critical deploys |
| Memory grows > 50 MB/hour (leak pattern) | Restart service; open P0 ticket; freeze deploys |
| Data corruption in `employees` or `leave_balances` | Immediate rollback to last backup; all-hands |
| > 10% of login attempts return 500 | Freeze; investigate JWT/DB within 30 min |

---

## Quick Reference

```bash
# Health
curl https://<backend-url>/api/health

# Migration status / run / rollback
cd backend && npm run migrate:status
cd backend && npm run migrate
cd backend && npm run migrate:rollback

# Smoke tests
cd backend && npm run smoke:prod

# Backup
cd backend && npm run backup
cd backend && npm run backup:list
```

| Resource | Location |
|---|---|
| Backend health | `https://<backend-url>/api/health` |
| Render dashboard | `https://dashboard.render.com` |
| Backend logs | Render → pulse-backend → Logs |
| DB console | Render → pulse-db → Connect |
| Alert channel | Configured via `ALERT_WEBHOOK_URL` |
