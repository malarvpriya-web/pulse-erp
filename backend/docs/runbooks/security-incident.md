# Security Incident Runbook

**System:** Pulse ERP  
**Purpose:** Respond to unauthorized access, data breach, or credential compromise.

---

## Severity Classification

| Level | Criteria | Response Time |
|---|---|---|
| P0 | Active breach, data exfiltration in progress, production credentials compromised | Immediate |
| P1 | Unauthorized access confirmed, scope unknown | < 1 hour |
| P2 | Suspicious activity detected, not yet confirmed | < 4 hours |
| P3 | Anomaly in audit logs, likely benign | Next business day |

---

## Symptoms

- Audit logs show actions by users at unexpected times or from unexpected IPs
- `/api/audit` shows bulk data exports, repeated failed logins, or role changes you didn't make
- JWT tokens accepted after expected expiry
- Unexpected admin users in the system
- S3 backup bucket accessed without matching application request
- Alert webhook fired for anomalous activity
- Employee report of unauthorized access to their data

---

## Immediate Actions (P0/P1)

### 1. Revoke all active sessions

Rotate `JWT_SECRET` immediately. This invalidates every active token in the system.

```bash
# Generate a new secret
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# Update the env var in Railway/Render
railway variables set JWT_SECRET=<new-secret>

# Redeploy to pick up the new secret
railway up
```

All users will be logged out and required to re-authenticate.

### 2. Rotate database credentials

If the database password may be compromised:

1. Generate a new password in the DB provider dashboard (Render/Neon/Supabase)
2. Update `DATABASE_URL` or `DB_PASSWORD` in the service environment
3. Redeploy the backend service

### 3. Block the suspected source IP (if identified)

For Railway/Render behind a load balancer:
- Add an IP block rule in Cloudflare or your WAF
- If no WAF: add a middleware block in `server.js` temporarily

### 4. Preserve evidence — do NOT wipe logs

```bash
# Download audit logs before any remediation that might overwrite them
curl -H "Authorization: Bearer <admin-token>" \
  "https://your-app.railway.app/api/v1/audit?limit=1000" \
  > incident-audit-$(date +%Y%m%d-%H%M%S).json
```

---

## Diagnosis

### Check audit logs for the incident window
```bash
curl -H "Authorization: Bearer <admin-token>" \
  "https://your-app.railway.app/api/v1/audit?from=2026-05-29T00:00:00Z&to=2026-05-29T06:00:00Z"
```

Look for:
- `action: DELETE` or `action: UPDATE` on sensitive tables (employees, payroll, users)
- Bulk `SELECT` on payroll or personal data
- Role/permission changes (`module: security` or `module: admin`)
- Login attempts from IPs not in your corporate range

### Check for unauthorized admin users
```sql
SELECT id, email, role, created_at, last_login
FROM users
WHERE role IN ('super_admin', 'admin', 'hr_manager')
ORDER BY created_at DESC;
```

### Check for data exfiltration in access logs
```bash
# Railway logs — look for large response payloads or unusual query patterns
railway logs | grep -E '"status":200' | grep -E '"path":"/api/(payroll|employees|finance)"' | tail -100
```

### Identify the attack vector
- **Brute force / credential stuffing**: Look for repeated 401s from a single IP
- **Stolen JWT**: Valid token used from unexpected IP or time
- **SQL injection**: Look for unusual characters in query params in access logs
- **Insider threat**: Valid credentials used for unauthorized data access
- **Dependency vulnerability**: Check `npm audit` for known CVEs

---

## Containment

### Brute force attack
1. The rate limiter (if deployed) should have triggered — verify it is active
2. Block the attacking IP range at the infrastructure layer
3. Enable CAPTCHA on the login endpoint (future hardening)

### Compromised employee credentials
1. Immediately disable the user account:
```sql
UPDATE users SET is_active = false WHERE email = '<compromised-email>';
```
2. Invalidate their specific tokens by rotating `JWT_SECRET` (affects all users — coordinate timing)
3. Review all audit log entries for that user over the past 30 days

### Data exfiltration confirmed
1. Document what was accessed (tables, row counts, timeframe)
2. Notify the affected individuals per your privacy policy and applicable law
3. File an incident report with the DPO (Data Protection Officer)

---

## Post-Incident

### Required within 24 hours
- [ ] Root cause identified
- [ ] Attack vector closed
- [ ] Credentials rotated (JWT_SECRET, DB password if needed)
- [ ] Affected users notified
- [ ] Audit log exported and stored offline

### Required within 72 hours
- [ ] Post-mortem document written
- [ ] DPDP / GDPR breach notification filed if personal data was involved
- [ ] Security controls reviewed and updated

### Required within 1 week
- [ ] Remediation deployed and tested
- [ ] Penetration test or security review scheduled if P0/P1
- [ ] Security runbook updated with lessons learned

---

## Escalation

| Severity | Who to notify |
|---|---|
| P0 — Active breach | CTO + Engineering lead (immediate) |
| P1 — Confirmed access | Engineering manager + CTO (within 1 hour) |
| Personal data involved | DPO + Legal (within 4 hours of confirmation) |
| Customer data involved | Customer Success lead + Account owners |
| Regulatory impact | Legal counsel |

---

## Security Contact

Internal security email: security@manifesttechnologies.in (replace with actual address)  
Report a vulnerability: same address, PGP key on request.
