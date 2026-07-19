# Pulse ERP — Defect Register

Generated: 2026-04-22  
Scope: HR/Payroll · Finance · CRM/Sales · Inventory/Procurement · Projects

---

## Severity Legend

| Level | Definition | Go-live gate |
|-------|-----------|--------------|
| **P0** | Data corruption, fabricated data shown to users, always-crashing endpoints | **MUST close before go-live** |
| **P1** | Endpoint always fails, silent data loss, security regression | **MUST close before go-live** |
| **P2** | Degraded UX, missing validation, PII exposure, code smell | Fix in next sprint |

---

## P0 — Critical (all closed before go-live)

| ID | Module | File | Description | Status |
|----|--------|------|-------------|--------|
| P0-01 | Finance | `finance.controller.js:getFinanceDashboard` | Returns entirely hardcoded KPIs (bank=₹250K, AR=₹125K, etc.). No DB query. All financial data shown to users is fabricated. | ✅ Fixed |
| P0-02 | Finance | `finance.controller.js:getCFODashboard` | Returns hardcoded balance sheet ratios (assets=₹1.25M, ROE=18.3%, etc.). No DB query. CFO sees fake figures. | ✅ Fixed |
| P0-03 | Finance | `finance.controller.js:getInvoiceStats` | Returns hardcoded counts (totalInvoices=45, paidInvoices=32, overdueInvoices=5). No DB query. | ✅ Fixed |
| P0-04 | Finance | `finance.controller.js:getBillStats` | Returns hardcoded counts (totalBills=38, overdueBills=3). No DB query. | ✅ Fixed |
| P0-05 | Finance | `finance.controller.js:createJournalEntry` | (a) Inserts into `journal_entry_lines` — table doesn't exist (schema uses `journal_lines`). Always throws 500. (b) Uses column `date` — schema has `entry_date`. Always throws 500. (c) No transaction: header row is created then lines insert crashes → orphaned entry with no lines (data corruption). (d) No validation: `lines.reduce()` crashes on missing input before any guard. | ✅ Fixed |

---

## P1 — High (all closed before go-live)

| ID | Module | File | Description | Status |
|----|--------|------|-------------|--------|
| P1-01 | Finance | `finance.controller.js:getJournalEntries` | `ORDER BY date DESC` — column is `entry_date` in schema. Always throws 500 "column date does not exist". | ✅ Fixed |
| P1-02 | Finance | `finance.controller.js:createAccount` | Inserts `(code, name, type, parent, status)` — schema columns are `(account_code, account_name, account_type, parent_account_id, is_active)`. Always throws 500. | ✅ Fixed |
| P1-03 | Finance | `finance.controller.js:closePeriod` | `result.rows[0]` accessed without checking `rows.length`. Returns `undefined` if period ID not found → `res.json(undefined)` sends empty 200. | ✅ Fixed |
| P1-04 | Finance | `accounting.routes.js` (top-level) | DDL `CREATE TABLE` + seed data executed as fire-and-forget `pool.query().then()` on every server import. Errors silently swallowed. Race condition if two instances start simultaneously. Should be a migration. | ✅ Fixed |

---

## P2 — Medium (next sprint)

| ID | Module | File | Description | Status |
|----|--------|------|-------------|--------|
| P2-01 | Projects | `projects.routes.js:GET /employees` | Returns employee PII (dob, joining_date, anniversary_date) to ALL authenticated roles with no role restriction. | ✅ Fixed |
| P2-02 | Finance | `finance.controller.js:getAccounts` | `SELECT * FROM chart_of_accounts ORDER BY code` — column is `account_code` not `code`. Throws 500. | ✅ Fixed |
| P2-03 | Finance | `finance.controller.js:createJournalEntry` | No validation that `lines` is a non-empty array before calling `.reduce()`. Covered by P0-05 fix. | ✅ Fixed |
| P2-04 | Finance | `finance.controller.js` (multiple) | No input validation on required fields across createAccount, createJournalEntry. | ✅ Fixed |
| P2-05 | HR/Payroll | `leave.routes.js` + `server.js` | `/api/leaves` is mounted without `verifyToken` in server.js. The route file itself applies `verifyToken` to each handler — so individual routes ARE protected, but defence-in-depth at the mount level is absent. | ✅ Fixed |

---

## Auth coverage — all modules

| Mount path | verifyToken at mount | Route-level auth |
|-----------|---------------------|-----------------|
| `/api/finance` | ✅ server.js | — |
| `/api/accounting` | ✅ server.js | ✅ (inline) |
| `/api/leaves` | ❌ server.js | ✅ per-route — net result: protected |
| `/api/leaves-new` | ✅ server.js | — |
| `/api/payroll` | ✅ server.js | ✅ allowRoles |
| `/api/projects` | ✅ server.js | — |
| `/api/tasks` | ✅ server.js | — |
| `/api/crm` | ✅ server.js | — |
| `/api/inventory` | ✅ server.js | — |
| `/api/procurement` | ✅ server.js | — |

> All routes are effectively protected. The `/api/leaves` gap is defence-in-depth only (P2-05).
