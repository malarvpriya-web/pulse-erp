# Pulse ERP — Hypercare Protocol (48–72 h)

**Triggered by:** Every production deployment  
**Duration:** 48 h standard · extend to 72 h if P1 bug found in first 24 h  
**Last updated:** 2026-04-23

---

## Overview

Hypercare is the intensive monitoring window immediately after a go-live or major release. The goal is to catch and fix regressions before users notice them — not to wait for users to file support tickets.

---

## Timeline

### Hour 0–4 · Intensive watch

- Keep the deploy engineer available with no other critical work
- Check `/api/health` manually every **30 minutes**:
  ```bash
  curl https://pulse-backend.onrender.com/api/health | jq '{status,db,memory,commit}'
  ```
- Check Render logs for unexpected 5xx bursts every 30 min (Render dashboard → `pulse-backend` → Logs)
- Run the full smoke suite after the first 30 min to confirm warm-state health:
  ```bash
  BACKEND_URL=https://pulse-backend.onrender.com \
  FRONTEND_URL=https://pulse-frontend.onrender.com \
    npm run smoke:prod
  ```
- Walk the critical user path manually: **login → payroll → invoices → journal entries**

### Hour 4–24 · Active watch

- Health checks: automated (health monitor fires every 5 min; alert webhook fires on incident)
- Manual check: every **2 hours** during business hours (9 AM–7 PM)
- Respond to any P0/P1 bug report within **1 hour**
- Hotfixes deployed same day (see §3 — fast-lane process)

### Hour 24–48 · Normal + elevated

- Automated monitoring only (webhook alerts)
- Respond to P0/P1 within **2 hours**
- P2 bugs triaged and scheduled for next sprint
- Daily 15-min hypercare stand-up to review any flags

### Hour 48–72 · Wind-down (extension only)

Activated if a P1 bug was found in the first 24 h. Otherwise hypercare ends at 48 h.

- Same as Hour 24–48 cadence
- At 72 h: run the go/no-go checklist (§5) and formally close hypercare

---

## Monitoring checklist — run every 2 hours during business hours

```bash
# 1. Health endpoint
curl -s https://pulse-backend.onrender.com/api/health | \
  jq '{status, db_latency: .db.latency_ms, mem_mb: .memory.rss_mb, pressure: .memory.pressure, commit}'

# 2. Smoke tests
BACKEND_URL=https://pulse-backend.onrender.com \
FRONTEND_URL=https://pulse-frontend.onrender.com \
  npm run smoke:prod

# 3. Render logs — scan for ERROR lines in the last 2 hours
#    (do this in Render dashboard → Logs → filter level:ERROR)
```

Expected healthy output:
```json
{ "status": "ok", "db_latency": "<200", "pressure": false }
```

---

## Severity classification (during hypercare)

| Severity | Definition | Response SLA | Action |
|----------|-----------|--------------|--------|
| **P0** | Data corruption, crash on critical path, security breach | Immediate | Rollback first, fix second |
| **P1** | Feature always fails, data loss risk, auth bypass | < 1 h (h 0–24), < 2 h (h 24–72) | Hotfix fast-lane |
| **P2** | Degraded UX, wrong data shown (non-corrupt), cosmetic | Next business day | Ticket + schedule |

---

## Fast-lane hotfix process

Hotfixes during hypercare skip the normal sprint cycle.

```
1. Branch from main
   git checkout -b hotfix/<ticket>

2. Fix, unit-test locally
   npm test   (must be 55/55)

3. Peer review — minimum 1 reviewer, async is fine
   (do NOT skip review even under pressure — the last deploy broke prod)

4. Merge to main with a clear commit message
   "fix: <what broke> — hypercare hotfix"

5. Render auto-deploys on merge to main

6. Wait for "Live" status in Render dashboard (60–90 s)

7. Run smoke tests immediately after deploy
   npm run smoke:prod

8. Add the fix to DEFECTS.md or close the associated ticket
```

> **Rule:** Never hotfix by editing env vars to mask a bug. Fix the code.  
> **Rule:** If the hotfix introduces a new migration, run `npm run migrate:status` locally first to confirm it's safe.

---

## Alert triage guide

When `ALERT_WEBHOOK_URL` fires an alert:

| Alert message | Likely cause | First action |
|--------------|--------------|--------------|
| 🚨 DB DEGRADED | DB unreachable — network, credentials, Render DB restart | Check Render dashboard → `pulse-db` service status |
| ⚠️ HIGH DB LATENCY | DB under load, slow query, connection pool exhausted | Check for expensive queries in Render DB metrics |
| ⚠️ MEMORY PRESSURE | Memory leak, large payload, Render free-tier limit | Restart service (Render → Manual Deploy → Re-deploy); file a P1 if recurring |
| ✅ DB RECOVERED | Self-healed after transient failure | Confirm with `/api/health`; no action if < 2 failures |
| ✅ LATENCY RECOVERED | Spike resolved | No action |

---

## Go/no-go checklist — hypercare close

Run at 48 h (or 72 h if extended). Hypercare ends only when all are green.

- [ ] No P0 or P1 bugs open
- [ ] `/api/health` → `{"status":"ok"}` for > 24 h uninterrupted
- [ ] `npm run smoke:prod` exits 0
- [ ] No `🚨 DB DEGRADED` alert in the last 24 h
- [ ] Memory pressure alert not recurring (single spike OK)
- [ ] No user-reported critical regressions
- [ ] Any P2 bugs found are ticketed and scheduled
- [ ] Incident reports filed for any rollbacks that occurred
- [ ] Alert webhook confirmed working (send a manual test ping)

When all checked: announce **"Hypercare closed"** in the team channel with the UTC timestamp.

---

## Escalation path

| Situation | Escalate to |
|-----------|-------------|
| P0 not resolved in 30 min | Tech lead / CTO |
| DB unrecoverable without DBA help | Database administrator |
| Rollback itself fails | Render support (https://render.com/support) |
| Security incident | Security lead — do NOT post details in general channels |
