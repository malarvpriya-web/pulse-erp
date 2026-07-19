# Pulse ERP — Rollback Runbook

**Audience:** On-call engineer or deploy owner  
**Last updated:** 2026-04-23

---

## 1. When to roll back

Roll back immediately (do not wait for a fix) if **any** of the following is true:

| Signal | Source | Threshold |
|--------|--------|-----------|
| `GET /api/health` returns HTTP 503 | Health endpoint / smoke test | Sustained > 3 min |
| DB status `"degraded"` alert fired | `ALERT_WEBHOOK_URL` | 2nd consecutive check |
| Smoke tests fail on production | `npm run smoke:prod` | Any failure |
| Critical path broken (login, payroll, invoices) | User report / manual test | Any confirmed break |
| Error rate spike visible in Render logs | Render dashboard → Logs | > 10 × baseline in 5 min |

**Do not** roll back for:  
- Single slow request (check health first)  
- UI cosmetic regression  
- A known fix that is < 15 min away

---

## 2. Decision tree

```
Alert fires
  └─ Check /api/health
       ├─ status "ok"  → Investigate logs; no rollback yet
       └─ status "degraded"
            ├─ db.status "error"  → DB issue, see §4 (DB rollback)
            └─ db.status "ok"     → App-level regression, see §3 (app rollback)
```

---

## 3. App rollback (Render service)

Fastest path — Render keeps the last 5 successful deploys.

1. Open **Render dashboard** → `pulse-backend` service → **Deploys** tab
2. Find the last deploy whose status was **"Live"** before the incident
3. Click **⋯ (options)** → **Roll back to this deploy**
4. Wait for "Deploying…" → "Live" (typically 60–90 s on Render free tier)
5. Verify:
   ```bash
   curl https://pulse-backend.onrender.com/api/health
   # expect: {"status":"ok", ...}
   ```
6. Run full smoke suite:
   ```bash
   BACKEND_URL=https://pulse-backend.onrender.com \
   FRONTEND_URL=https://pulse-frontend.onrender.com \
     npm run smoke:prod
   ```
7. If frontend also shows breakage, roll it back the same way.

> **Tip:** The `commit` field in `/api/health` shows the deployed git SHA. Compare it against your expected SHA before and after rollback.

---

## 4. Database rollback (migration)

Use only if the new deploy added a migration **and** that migration caused the breakage.

> ⚠️ Database rollbacks are destructive. Only proceed if you are certain the migration caused the incident.

### Step 1 — Verify migration is the cause

```bash
# From your local machine with production DB creds
DB_HOST=... DB_PASSWORD=... npm run migrate:status
```

Look for the most recently applied migration. If its `applied_at` matches the incident start time, it is the likely cause.

### Step 2 — Roll back the migration

```bash
DB_HOST=<prod-host> DB_PORT=5432 DB_NAME=pulse \
DB_USER=pulse DB_PASSWORD=<secret> \
  npm run migrate:rollback
```

This calls the migration's `down()` function and removes the row from `schema_migrations`.

**Repeat** `npm run migrate:rollback` if multiple migrations were applied in the same deploy.

### Step 3 — Roll back the app (§3 above)

After the DB schema is restored, roll back the Render service so the running code matches the schema.

### Step 4 — Verify

```bash
DB_HOST=... npm run migrate:status   # confirms pending migration removed
npm run smoke:prod                   # confirms app is healthy
```

---

## 5. Emergency env-var-only patch

If the incident is caused by a wrong env var value (e.g., wrong `FRONTEND_URL`):

1. Render dashboard → service → **Environment** tab
2. Edit the variable → **Save changes**
3. Render automatically redeploys — no code change needed
4. Verify with `/api/health` and `smoke:prod`

No rollback needed for env-var-only fixes.

---

## 6. Post-rollback checklist

- [ ] `/api/health` returns `{"status":"ok"}` for both backend and DB
- [ ] `npm run smoke:prod` exits 0
- [ ] Alert channel shows no new incidents for 10 min
- [ ] File an incident report (see §7)
- [ ] Open a bug ticket with: incident time, rolled-back SHA, root cause hypothesis
- [ ] Re-deploy the fix via a new commit (never re-apply a rolled-back deploy without a fix)

---

## 7. Incident report template

```
## Incident — <date>

**Start:** <ISO timestamp>
**End (rollback complete):** <ISO timestamp>
**Duration:** <N min>
**Severity:** P0 / P1 / P2
**Deploy SHA that caused it:** <git sha>

### What broke
<describe symptom>

### Root cause
<describe cause>

### Rollback steps taken
1. <step>
2. <step>

### Fix (link to PR)
<link>

### Prevention
<what change prevents recurrence>
```

---

## 8. Key contacts & links

| Resource | URL |
|----------|-----|
| Render dashboard | https://dashboard.render.com |
| Backend health | `https://pulse-backend.onrender.com/api/health` |
| Backend logs | Render dashboard → `pulse-backend` → Logs |
| Smoke test script | `backend/scripts/smoke-prod.js` |
| Migration runner | `npm run migrate:status` / `npm run migrate:rollback` |
