# Pulse ERP — Go-Live Checklists (Phase 38J)

Generated: 2026-05-29  
Target: Industrial manufacturing / EPC / power-electronics companies

---

## 1. DEPLOYMENT CHECKLIST

### Environment (do once per environment)
- [ ] Set `NODE_ENV=production` on server
- [ ] Set `JWT_SECRET` (minimum 32 chars, random — `openssl rand -hex 32`)
- [ ] Set `ENCRYPTION_KEY` (exactly 32 chars — required in production)
- [ ] Set `DATABASE_URL` or individual `DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD`
- [ ] Set `FRONTEND_URL` to deployed frontend origin (e.g. `https://app.yourcompany.com`)
- [ ] Set `PORT` (default 5000)
- [ ] Set `LOG_TO_FILE=true` and verify `logs/` directory is writable
- [ ] Set `ALERT_WEBHOOK_URL` (Slack/Discord) for operational alerts
- [ ] Set `BACKUP_S3_BUCKET` + `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` for off-site backups
- [ ] Set `METRICS_TOKEN` for Prometheus metrics endpoint protection
- [ ] Set `SMTP_HOST / SMTP_USER / SMTP_PASS` for OTP email delivery

### Integrations (set only if using)
- [ ] `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` — payment gateway
- [ ] `ZOHO_SIGN_CLIENT_ID` + `ZOHO_SIGN_ACCESS_TOKEN` + `ZOHO_SIGN_DC` — document signing
- [ ] `TALLY_GATEWAY_URL` — Tally sync integration
- [ ] `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_ID` — WhatsApp notifications

### Before First Start
- [ ] Run `npm run migrate` and verify all 45 migrations applied (check `npm run migrate:status`)
- [ ] Run `npm run pre-deploy` (pre-flight checks)
- [ ] Verify `/api/health` returns `status: "ok"`
- [ ] Verify DB tables check shows no `missing` tables
- [ ] Confirm no `tamper_warnings` in migrations output
- [ ] Run smoke tests: `npm run smoke:prod`

### Frontend Build
- [ ] `npm run build` in frontend — no TypeScript/ESLint errors
- [ ] Confirm `dist/` is served by CDN or static host
- [ ] Confirm `VITE_API_URL` points to production backend
- [ ] Verify `devLogin.js` is NOT in the production bundle (`grep -r devLogin dist/`)

---

## 2. ROLLBACK CHECKLIST

### Trigger conditions for rollback
- `/api/health` returns `status: "degraded"` for > 2 minutes after deploy
- Critical workflow (payroll, approvals) fails on first real transaction
- Auth tokens stop validating for active users

### Rollback procedure
- [ ] Keep previous Docker image / deployment tagged (do not overwrite `latest` until verified)
- [ ] Record the last successful `schema_migrations` row before deploying new version
- [ ] If rollback needed:
  1. `npm run migrate:rollback` to reverse last migration (if schema changed)
  2. Re-deploy previous image / `git checkout` to previous tag
  3. Restart server — verify `/api/health` returns `ok`
  4. Notify active users of brief interruption
- [ ] Never rollback a migration that deleted columns without first restoring data from backup

---

## 3. BACKUP CHECKLIST

### Automated backups (configured via env)
- [ ] `BACKUP_S3_BUCKET` set and accessible from server
- [ ] `BACKUP_CRON_SCHEDULE` set (default: `30 20 * * *` = 02:00 IST)
- [ ] `BACKUP_RETAIN_DAYS` set (default: 7 days local)
- [ ] Verify first backup runs: `npm run backup` → check S3 bucket
- [ ] Set `TEST_DB_NAME` for restore drill capability

### Weekly verification
- [ ] Run `npm run backup:list` — confirm backups are present and timestamped correctly
- [ ] Run `npm run backup:drill` monthly — full restore to test DB, verify row counts
- [ ] Monitor backup cron logs (`logs/health.log`) for failure alerts

### Pre-major-change backup (manual)
- [ ] Before any schema migration: `npm run backup`
- [ ] Before any bulk data import: `npm run backup`
- [ ] Confirm backup completed before proceeding

---

## 4. ADMIN ONBOARDING CHECKLIST

### Step 1 — First Login
- [ ] Login with super-admin credentials
- [ ] Change default password immediately
- [ ] Configure company profile (name, GSTIN, CIN, address, logo)

### Step 2 — Setup Wizard (7 steps — resume anytime)
1. [ ] Company Profile — legal name, GSTIN, financial year start
2. [ ] Branches — Head Office, Factory, Service Center
3. [ ] Departments — HR, Finance, Procurement, Production, QC, Engineering, Sales, CRM, Service
4. [ ] Designations — MD, GM, Manager, Supervisor, Engineer, Officer, Executive
5. [ ] Roles & Permissions — Admin, HR Manager, Finance Manager, etc.
6. [ ] Attendance Setup — shift types, geo-fence zones, policies
7. [ ] Payroll Setup — salary structures, PF/ESI/TDS config, pay cycles

### Step 3 — Master Data
- [ ] Chart of Accounts verified (Settings → Finance & Tax → Chart of Accounts)
- [ ] GST settings: GSTIN, state code, tax rates configured
- [ ] TDS sections and deductees added (REAL PANs — no demo data)
- [ ] Holiday calendar for current FY uploaded
- [ ] Leave types configured (PL, CL, SL, LOP, Comp-Off)
- [ ] Approval hierarchies configured per department

### Step 4 — Inventory & Production
- [ ] Inventory locations/warehouses created
- [ ] UOM master set up (Nos, Kg, Mtr, Ltrs, Sets)
- [ ] Item master seeded (raw materials, finished goods, consumables)
- [ ] Work centres configured (verify defaults or create real ones)
- [ ] BOM rules and cost centres set up

### Step 5 — CRM & Sales
- [ ] Customer master seeded
- [ ] Sales territories / regions configured
- [ ] Quotation templates set up
- [ ] Pricing rules configured

---

## 5. FIRST CUSTOMER CHECKLIST

### Day 0 — Pre-Go-Live (1 week before)
- [ ] Admin training completed (4 hours minimum)
- [ ] Test all 9 user roles with dummy transactions
- [ ] Run full SST/HVDC project simulation (Lead → Dispatch)
- [ ] Verify payroll calculation for at least 3 employee types
- [ ] Verify attendance punch-in / punch-out with geo-fencing
- [ ] Verify leave application and manager approval flow
- [ ] Verify purchase request → PO → GRN → 3-way match
- [ ] Verify GSTR-1 export generates valid CSV (`GET /api/gstr1/export?period=MMYYYY`)
- [ ] Verify payslip PDF downloads correctly
- [ ] Verify notifications reach intended users
- [ ] `/api/health` shows `status: "ok"`, all tables present

### Day 1 — Go-Live
- [ ] Onboard all employees (HR Admin performs or uses bulk upload)
- [ ] Assign roles to all users
- [ ] Record opening inventory balances
- [ ] Record opening financial balances (Chart of Accounts → Opening Balances)
- [ ] Mark FY start in accounting periods
- [ ] Configure attendance policy for each department
- [ ] Enable cron jobs (payroll, probation, health monitor, delivery follow-up)

### Week 1 — Hyper-Care
- [ ] Daily `/api/health` check
- [ ] Monitor `logs/errors.log` for unexpected 500s
- [ ] Confirm audit_logs are being written for all approvals
- [ ] Confirm workflow transitions are completing (no stuck instances)
- [ ] Confirm backup ran successfully every day
- [ ] Address any UX confusion (if users need developer help > 2 times for same task — mark UX incomplete)

---

## 6. ADMIN TRAINING CHECKLIST

### Module 1 — User & Role Management (30 min)
- [ ] Create user accounts
- [ ] Assign roles and permissions
- [ ] Reset passwords
- [ ] Deactivate / offboard users

### Module 2 — HR Operations (60 min)
- [ ] Add / edit employee profiles
- [ ] Configure attendance shifts and geo-fence
- [ ] Approve / reject leave requests
- [ ] Run monthly payroll cycle
- [ ] Generate payslips and Form 16

### Module 3 — Finance (60 min)
- [ ] Create journal entries
- [ ] Record invoices and bills
- [ ] Process payment batches
- [ ] Run GSTR-1 / GSTR-3B export
- [ ] View P&L, Balance Sheet, Cash Flow statements

### Module 4 — Procurement & Inventory (45 min)
- [ ] Create purchase requests and approve
- [ ] Issue POs to vendors
- [ ] Record GRN and complete 3-way match
- [ ] Manage stock levels and alerts

### Module 5 — Production & Quality (45 min)
- [ ] Create BOMs and production orders
- [ ] Execute work centre operations
- [ ] Record QC inspections and NCRs
- [ ] Run depreciation and manage fixed assets

### Module 6 — Reports & Exports (30 min)
- [ ] Run attendance reports
- [ ] Export payroll data
- [ ] Export GST returns
- [ ] Use CEO / HR Analytics dashboards
- [ ] Set up scheduled notifications

---

## 7. PRODUCTION MONITORING CHECKLIST

### Automated (runs continuously)
- `healthMonitor.cron.js` — checks DB latency every 60s, alerts if > `ALERT_THRESHOLD_MS`
- `backup.cron.js` — nightly backup at configured schedule
- `deliveryFollowup.cron.js` — sends overdue delivery alerts
- `probation.cron.js` — flags probation end dates

### Manual (daily — 5 min)
- [ ] `GET /api/health` — verify `status: "ok"`
- [ ] Check `logs/errors.log` — zero 500s expected in steady state
- [ ] Check `logs/health.log` — confirm backup ran, DB latency within threshold
- [ ] Verify `/api/metrics` counters — `workflow_transition_failures` and `notification_failures` should be 0

### Weekly
- [ ] Check `audit_logs` table for any suspicious activity patterns
- [ ] Review SecurityCenter → Blocked IPs / failed login attempts
- [ ] Run `npm run backup:list` — verify all 7 daily backups present
- [ ] Review pending workflow instances older than 5 business days

### Monthly
- [ ] Run restore drill: `npm run backup:drill`
- [ ] Review user access — deactivate any leavers
- [ ] Rotate `JWT_SECRET` and `ENCRYPTION_KEY` if required by policy
- [ ] Apply OS / Node.js security patches
- [ ] Review and archive old audit logs

---

## CERTIFICATION LEVEL

Based on Phase 38 assessment:

| Dimension | Status |
|-----------|--------|
| Backend routes coverage | ✅ All 23 modules — complete |
| Auth & JWT | ✅ Production-grade |
| Migration system | ✅ Checksummed, tamper-detected |
| Health endpoint | ✅ DB + migrations + memory |
| Backup system | ✅ S3 + local + drill support |
| Cron jobs | ✅ Probation + Health + Delivery + Backup |
| Demo data seeds | ✅ Fixed — guarded by NODE_ENV |
| Payment gateway | ✅ Fixed — explicit 503 in production |
| Document signing | ✅ Fixed — no silent demo state |
| Asset disposal GL | ✅ Fixed — real journal entry created |
| GST CSV exports | ✅ Added — GSTR-1 B2B + GSTR-3B |
| Dev scripts in root | ✅ Moved to dev-tools/ |
| devLogin in prod build | ✅ Stubbed out in vite.config.js |
| Fake TDS PANs | ✅ Fixed — dev-only guard |

**Certification: Enterprise Pilot Ready**

The ERP is ready for a controlled first-customer pilot with full admin support. Promotion to **Industrial Go-Live Ready** requires:
1. Razorpay / Zoho Sign credentials configured and tested end-to-end
2. First payroll cycle completed in production with real employee data
3. GSTR-1 CSV verified against GSTN portal for at least one period
4. Successful restore drill from S3 backup
