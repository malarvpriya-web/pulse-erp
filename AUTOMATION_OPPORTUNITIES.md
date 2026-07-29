# Automation Opportunities — Priority 3

Date: 2026-07-27. Scope: "what work is repeated by humans that the system could do
instead" — cross-referenced against what's actually already built in
`backend/src/jobs/*.cron.js` (11 jobs, all wired up in `server.js:222-230` imports /
`server.js:863-871` invocations) so nothing here duplicates existing automation.

## What already runs today

| Job | Schedule | What it does |
|---|---|---|
| `probation.cron.js` | Daily 09:00 | Warns manager + super_admin 15 days before probation end, and again on day 180 |
| `amcRenewal.cron.js` | Daily 09:00 | AMC/service-contract renewal reminders, default 30 days before expiry |
| `deliveryFollowup.cron.js` | — | PO delivery-followup reminders, default 7 days |
| `overdueReminders.cron.js` | Daily 09:00 | AR overdue (invoice reminders) + AP overdue (payment follow-up) |
| `esignReminder.cron.js` | Hourly | Resends e-signature reminders per document's own interval/max-count |
| `leave.cron.js` | Various | Monthly accrual, year-end carry-forward, carry-forward expiry, comp-off expiry, escalation |
| `attendance.cron.js` | Daily 23:45 + 30-min sweep | Auto-absent marking, auto-checkout |
| `scurveSnapshot.cron.js` | Monthly | EVM S-curve snapshot per project |
| `iotMonitor.cron.js` | Every 5 min | Device online/stale/offline + threshold alerts |
| `healthMonitor.cron.js` | — | System health/perf metrics + webhook alerting |
| `backup.cron.js` | Daily 02:00 IST | DB backup + retention + optional S3 upload |

So **invoice reminders, payment follow-up, probation reminders, and AMC reminders are
already automated** — they're on the user's wishlist but don't need building.

### The reusable pattern (copy this, don't reinvent it)
Every reminder-style job follows the same shape, cleanest in `amcRenewal.cron.js`:
1. `getReceivers()` — query `users` for the roles who should be notified.
2. A due-date query with a configurable reminder window (`WHERE end_date BETWEEN
   CURRENT_DATE AND CURRENT_DATE + ($1 * INTERVAL '1 day')`, window read from an env var).
3. `insertReminder()` — de-dups by checking `notifications` for the same
   `(user_id, module_name, reference_id, notification_type, created_at::date)` before
   inserting, so a job that runs daily doesn't spam the same person every day for the
   same contract.
4. `node-cron.schedule(...)` + a one-line `console.log` on startup.
5. Wire it into `server.js` (import near line 222–230, call near line 863–871).

Every gap below fits this exact shape — the effort is almost entirely "write the due-
date query," because the receiver-lookup/dedup/schedule scaffolding is already a solved,
copy-pasteable problem in this codebase.

---

## Gaps — genuinely missing, in rough build-effort order

### 1. Warranty expiry reminders — cheapest win, data already modeled
Warranty dates already exist as real columns across `projects`, `commissioning`,
`customer360`, `serialNumbers` and more (confirmed — `warranty` appears in 38 backend
files). Nobody gets warned before one lapses. This is a same-day port of
`amcRenewal.cron.js` — same query shape, different table/column, same receivers
(service_manager/manager/admin).

### 2. Preventive-maintenance due reminders — the query already exists, just not on a cron
`maintenance_schedules` already has `next_due_date`, `frequency_days`, and an
`overdue` computed flag; `maintenance.routes.js` already contains a query for "due
within 7 days" (line 602) and "overdue" (line 623) — used today only when someone
opens the Maintenance page and looks. There's no `preventiveMaintenance.cron.js`
turning that same query into a proactive notification. Straightforward: reuse the
existing query, wrap it in the standard job pattern, notify the asset's
`assigned_to` + production/maintenance roles.

### 3. Appraisal / performance-review reminders — same shape as probation
`probation.cron.js` is a template for exactly this: warn manager + HR N days before a
review cycle's due date, and again if it's overdue. Needs a due-date source — check
whether `performance_reviews`/appraisal-cycle tables already carry a due date before
building; if the review-cycle model already has start/end dates (likely, given
Performance is a full module), this is another near-copy of `probation.cron.js`.

### 4. Monthly KPI report distribution
Every number needed already exists behind live dashboard queries (Executive
Dashboard, CEO Intelligence, department dashboards). The gap isn't computing the
KPIs — it's packaging them into a scheduled digest (email/notification) instead of
requiring someone to log in and look. Simplest version: a monthly cron that re-runs
the existing dashboard queries for the prior month and posts a summary
notification/report to admin + department heads. Pairs naturally with the "AI should
summarize" opportunity in `AI_OPPORTUNITY_MAP.md` — the automation is "run it on a
schedule," the AI opportunity on top of it is "narrate the numbers in a sentence or
two instead of just tabulating them."

### 5. Automatic customer satisfaction survey
`csat_responses` already exists as a table (per the Service Feedback module) but
nothing appears to auto-*trigger* a survey — today it depends on someone remembering
to send one. Natural trigger points already exist as events in the system: ticket
closed (`support_tickets` status → closed), AMC renewal completed, installation/
commissioning marked done. A job (or a direct event-hook rather than a cron, since
this is event-triggered, not time-triggered) that fires a survey request on those
existing status transitions closes the loop.

### 6. Inventory reorder — partially automated, missing the last mile
The hard part already exists and is good: `EOQ Planner` on the Inventory dashboard
computes Economic Order Quantity, Reorder Point, and Annual Demand per item live
(confirmed via `store_keeper__Inventory.png` in the Priority-1 audit — this dashboard
is one of the better ones in the app). What's missing is the automatic step from
"this item is below its reorder point" to "a draft Purchase Request already exists
for it" — today a human still has to notice the Low Stock Alert and manually raise a
PR. A daily job that walks items where `current_stock <= reorder_point` and
auto-drafts a PR (not auto-*approves* — keep a human in the loop for the actual spend
decision) would close this without removing oversight.

### 7. Onboarding — exists as a manual trigger today, not a real pipeline
Found `POST /recruitment/auto-creation/:candidateId/trigger`
(`recruitment.routes.js:813`) — when invoked, it does correctly cascade
employee-record + payroll enrollment creation for a hired candidate. But it's sitting
behind a "pending" queue someone has to remember to open and click — it's not fired
automatically when a candidate's status flips to Hired/offer-accepted. Wiring the
existing trigger logic to fire on that status transition (rather than waiting for a
manual click) would make onboarding actually automatic rather than semi-automatic. It
also still stops at employee+payroll — asset assignment, login welcome email, and
shift assignment (per `AddEmployee`/`EditEmployee` asset+shift wiring already built
for manual employee creation) aren't part of the auto-creation path yet and would be
the natural next extension.

---

## Suggested build order
1. Warranty expiry (cheapest — pure port of an existing job).
2. Preventive maintenance (query already written, just needs the cron wrapper).
3. Onboarding trigger-on-status-change (removes a "someone has to remember" step from
   a path that already mostly works).
4. Appraisal reminders (same template, pending confirmation of a due-date field).
5. CSAT survey trigger (event-hook rather than cron — slightly different shape).
6. Reorder → draft-PR automation (touches procurement approval flow, so scope the
   "draft only" boundary carefully).
7. Monthly KPI digest (lowest urgency — a dashboard already exists for anyone who logs
   in; this only helps people who don't).
