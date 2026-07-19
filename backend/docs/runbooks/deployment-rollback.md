# Deployment Rollback Runbook

**System:** Pulse ERP  
**Purpose:** Revert a broken deployment to the last known-good version.

---

## Symptoms Indicating Rollback Is Needed

- `/api/health` degrades immediately after a deploy
- Error rate spikes in logs post-deploy (watch for 5xx bursts)
- Critical workflow broken: login fails, payroll errors, data not saving
- New deployment fails health check and Railway/Render enters restart loop

---

## Diagnosis — Is This Deployment-Caused?

### 1. Check deploy timing vs. incident start
```bash
# Railway
railway deployments list

# Render
# Check Render dashboard → Deploys tab → find the deploy SHA and timestamp
```

If the incident started within 5 minutes of a deploy completing → strong correlation.

### 2. Check health endpoint
```bash
curl https://your-app.railway.app/api/health | jq .
```

Look at `db.status`, `migrations.status`, and `tables.status`.

### 3. Check backend logs for startup errors
```bash
railway logs | head -100
```

Common deployment-induced errors:
- `Required environment variables are not set` → missing env var added in new code
- Migration `❌ failed — rolled back` → bad migration in the new commit
- `SyntaxError` / `Cannot find module` → broken import or missing dependency

---

## Rollback Procedure

### Option A — Railway (preferred: instant traffic switch)

1. Open Railway dashboard → your backend service
2. Click **Deployments** tab
3. Find the last successful deployment (green checkmark)
4. Click **Redeploy** on that deployment

This rolls traffic back in ~30 seconds with zero data loss.

### Option B — Render

1. Open Render dashboard → your web service
2. Click **Deploys** tab
3. Find the last successful deploy
4. Click **Rollback to this deploy**

### Option C — Manual Git rollback (last resort)

```bash
# Identify the last good commit
git log --oneline -10

# Revert to that commit (creates a new revert commit — safe)
git revert HEAD --no-edit

# Or reset and force-push (only if no other developers on the branch)
git reset --hard <last-good-sha>
git push origin main --force-with-lease

# Trigger a redeploy
railway up
```

---

## Migration Rollback (if a bad migration was applied)

Only needed if the new deploy ran a migration that broke the schema.

```bash
# Check what was applied
npm run migrate:status

# Roll back the last applied migration
npm run migrate:rollback
```

**Warning:** Rolling back a migration that dropped columns or tables may not be reversible without a database restore. Follow the [Database Restore Runbook](database-restore.md) if data was lost.

---

## Post-Rollback Verification

```bash
# 1. Health check
curl https://your-app.railway.app/api/health | jq '{status, db, migrations}'

# 2. Smoke tests
npm run smoke:prod

# 3. Manual: log in and verify the most recently broken workflow
```

---

## Preventing Re-Occurrence

Before re-deploying the reverted code:

1. Reproduce the failure in a staging environment
2. Fix the root cause (don't just revert — understand why)
3. Add a test that would have caught it
4. Deploy to staging → verify → then promote to production

---

## Escalation

| Situation | Action |
|---|---|
| Rollback doesn't restore health | Follow [Database Failure Runbook](database-failure.md) |
| Health OK but users report data inconsistency | Audit logs → identify affected records → manual patch |
| Repeated rollbacks for same root cause | Engineering manager must approve next deploy |
