# Database Failure Runbook

**System:** Pulse ERP  
**Severity:** P0 — All database-dependent features unavailable

---

## Symptoms

- `/api/health` returns `{"status":"degraded","db":{"status":"error"}}`
- Backend logs: `Unexpected DB pool error`, `connect ECONNREFUSED`, `Connection timeout`
- Frontend: Blank screens, "Something went wrong" errors across all modules
- 503 responses from all authenticated API endpoints

---

## Initial Diagnosis

### 1. Check the health endpoint
```bash
curl https://your-app.railway.app/api/health | jq .
```
Expected on failure:
```json
{
  "status": "degraded",
  "db": { "status": "error", "error": "connect ETIMEDOUT" }
}
```

### 2. Check the DB pool error in logs
```bash
# Render
render logs --service <service-id> | grep "DB pool error"

# Railway
railway logs | grep -E "pool error|ECONNREFUSED|timeout"
```

### 3. Determine failure type

| Error message | Likely cause |
|---|---|
| `ECONNREFUSED` | DB process not running or wrong host |
| `ETIMEDOUT` | Network/firewall between app and DB |
| `too many clients` | Connection pool exhausted |
| `password authentication failed` | Rotated credentials not updated |
| `database does not exist` | DB dropped or wrong DB_NAME |

---

## Actions

### A — DB process not running (ECONNREFUSED)

1. Check the DB provider dashboard (Render PostgreSQL, Neon, Supabase, Railway Postgres)
2. Look for recent incident banners or alerts
3. If managed service: open a support ticket with the provider; do NOT attempt to restart their infrastructure
4. If self-hosted: SSH to the DB host → `systemctl status postgresql` → `systemctl start postgresql`

### B — Network/firewall (ETIMEDOUT)

1. Verify `DATABASE_URL` or `DB_HOST` is correct in the service environment variables
2. Check VPC/security-group rules: the app host must reach the DB on port 5432
3. If using Railway: verify the private network link is active between services

### C — Connection pool exhausted (`too many clients`)

1. Check `max` pool setting in `src/config/db.js` (currently 30)
2. Check PostgreSQL `max_connections` on the DB server
3. Restart the application service — this drains all pools and reconnects
4. If persistent: investigate slow queries holding connections (see query analysis below)

```sql
-- Find connections by state
SELECT state, COUNT(*) FROM pg_stat_activity GROUP BY state;

-- Kill idle connections
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE state = 'idle' AND query_start < NOW() - INTERVAL '10 minutes';
```

### D — Credentials rotated / wrong password

1. Update `DATABASE_URL` or `DB_PASSWORD` in the service environment
2. Redeploy or restart the service

### E — DB is up but data is corrupt / tables missing

Escalate immediately and follow the [Database Restore Runbook](database-restore.md).

---

## Query Analysis (for slow-query-induced failures)

```sql
-- Long-running queries
SELECT pid, now() - query_start AS duration, state, query
FROM pg_stat_activity
WHERE state != 'idle' AND query_start < NOW() - INTERVAL '30s'
ORDER BY duration DESC;

-- Lock waits
SELECT blocked.pid, blocked.query, blocking.pid AS blocking_pid
FROM pg_stat_activity blocked
JOIN pg_stat_activity blocking ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
WHERE NOT blocked.granted;
```

---

## Escalation

| Escalate when | Contact |
|---|---|
| DB unreachable > 5 minutes | Engineering on-call |
| Provider outage confirmed | Engineering manager |
| Data loss suspected | CTO + follow [Database Restore Runbook](database-restore.md) |
| SLA breach imminent | Customer Success + CTO |

---

## Post-Incident

1. Confirm `/api/health` returns `{"status":"ok"}`
2. Run `npm run smoke:prod` to verify end-to-end
3. Document the incident: root cause, timeline, actions taken, prevention
4. File a post-mortem within 48 hours if downtime exceeded 30 minutes
