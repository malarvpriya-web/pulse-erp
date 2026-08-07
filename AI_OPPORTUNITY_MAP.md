# AI Opportunity Map — Priority 4

Date: 2026-07-27. Scope: identify where AI should **assist / predict / recommend /
summarize** across Pulse — not build anything. Read `backend/src/modules/intelligence/
ai.routes.js` and `ceo-intelligence.routes.js` in full before writing this, because the
existing footprint is bigger and more mature than a first glance suggests — several
things on an initial wishlist already exist and shouldn't be re-proposed. All of it is
rule-based-heuristics-plus-optional-GPT-text; there is no trained ML model anywhere in
the codebase, which is the right call for a system this data-thin (per
`project_phase1_api_db_perf_audit` — the DB has too little history for real ML yet).

## What already exists, by category

### Predict
- **Revenue** (`GET /predict/sales`) — moving-average forecast from `sales_orders`.
- **Attrition** (`GET /predict/attrition`) — department-level exit-rate, last 90 days.
- **Device failure** (`GET /predict/device-failure`, `ai.routes.js:783`) — the most
  sophisticated thing in the file: a transparent, driver-based risk score (0-100) per
  IoT-connected asset, combining open/critical alerts, connection health, a real
  14-day linear-regression trend (`regr_slope`) on degradation metrics (THD, temp),
  and warranty/AMC status — each contributing points, each traceable to a labeled
  driver. **This already covers the "preventive maintenance" predictive angle** for
  IoT-connected equipment specifically.
- **Inventory** (`GET /predict/inventory`, `ai.routes.js:666`) — ✅ **fixed
  2026-08-05** (see `AUTOMATION_OPPORTUNITY_AUDIT.md` §6.2): `consumed_last_30d`
  now computes from `SUM(stock_ledger.quantity_out)` over the trailing 30 days
  instead of the old hardcoded `0`, and `risk_level` derives from real
  days-of-cover (`current_stock / avg_daily_consumption`) against the same
  lead-time + safety-stock reorder-point formula the EOQ Planner uses, so the two
  now agree on "at risk." Items with no movement history still fall back to the
  old static bucket — the dev DB's `stock_ledger` is currently empty, so it's
  running on that fallback today and will self-activate once GRN/production
  postings accumulate history.
- **CEO Intelligence** (`ceo-intelligence.routes.js`) — company-wide revenue forecast,
  customer/vendor health + risk scoring, renewal forecasts.

### Recommend
- **`GET /prescriptive`** (`ai.routes.js:846`) — a genuinely useful cross-module
  action list, each with `action` / `rationale` / `impact`: reorder items at/below
  reorder point, follow up on overdue receivables, investigate month-over-month
  revenue decline, review retention in high-turnover departments, (and more below the
  range read here — likely stale-approval nudges given the naming). This is the
  **"where AI should recommend" answer for Inventory, Finance, and HR already** — it's
  built, just not necessarily surfaced prominently outside the CEO-facing views (worth
  checking whether department-level users ever see their slice of this).
- **Device-failure's own `recommendation` field** — "Dispatch a service engineer",
  "Schedule an inspection", "Monitor closely" — recommend and predict fused in one
  response for IoT assets.

### Summarize
- **`POST /ceo-insights`** (`ai.routes.js:11`) — GPT-4o-mini narrative over live
  dashboard KPIs (revenue, attrition, pipeline, headcount), 3 concise bullets, with a
  rule-based fallback template when no API key is set (never fabricates numbers —
  good design to keep). **This is CEO/exec-dashboard-only.**
- **`POST /chat`, `/llm-chat`** — general copilot conversation, rate-limited
  (20/day/user).

### Assist
- **`POST /nav-search`** — natural-language "take me to X" → resolves to a route
  (GPT-based, gracefully degrades to "no match" without an API key).
- **`GET /smart-search`** — the topbar search-everything box (employees, invoices,
  projects, leads, inventory) — plain SQL `ILIKE`, no AI needed, correctly not
  over-engineered.

---

## Real gaps (things not yet covered, by category)

### Summarize — the least-developed pillar, and the easiest to extend
The narrative-summary pattern (`ceo-insights`) is proven and cheap to repeat, but
exists for exactly one persona. Natural extensions, same pattern:
- ~~**Department-level digests**~~ — ✅ **Done 2026-08-06**, see
  `MODULE_FEATURE_CONNECTION_MANUAL.md` §70. `departmentDigest.cron.js` sends a monthly
  narrated digest per department (headcount, attrition rate via `calcAttritionRate()`,
  joiners/leavers) to leadership + HR roles, reusing `narrateKpis()` untouched and the
  existing notifications pipeline — live-verified end-to-end against the real dev DB
  (13 departments, 39 real notification rows, dedup confirmed). Production/Quality
  department-specific dashboards weren't targeted separately — the built version covers
  any department present on `employees`, HR numbers only (headcount/attrition), not each
  department's own domain KPIs (e.g. Production's on-time rate, Quality's NCR rate) — a
  further, separately-scoped extension if wanted.
- ~~**Ticket / complaint thread summarization**~~ — ✅ **Done 2026-08-06**, see
  `MODULE_FEATURE_CONNECTION_MANUAL.md` §79. Only 1 real comment exists across all 15 real
  `support_tickets` in this pilot DB (a second candidate table, `ticket_conversations`, is
  a dead twin with 0 rows) — built anyway at the user's explicit request, synthetic/real
  verified. New `ticketThreadNarrator.js` (GPT-optional/rule-based) + `GET
  /api/ai/predict/ticket-summary/:id`. The rule-based fallback deliberately doesn't
  attempt to compress free text — it surfaces the real thread verbatim (latest comment,
  count, ticket age/SLA state) instead of risking a fabricated paraphrase. Live-verified
  against the one real comment that exists (correctly quoted) and a zero-comment ticket
  (correctly fell back to the original description). Wired into `AllTickets.jsx`'s ticket
  detail drawer as an "AI Handoff Summary" panel.
- ~~**Project status narrative**~~ — ✅ **Done 2026-08-06**, see
  `MODULE_FEATURE_CONNECTION_MANUAL.md` §78. Checked `Project 360°`'s own aggregated
  EVM/CPI/SPI numbers first — found `project_cost_summary` empty (never yet triggered by
  real usage) and 3 of the health-score engine's ~28 source queries silently broken by
  wrong table names (`service_tickets`/`goods_receipts`/`lifecycle_events`), flagged not
  fixed. Built `GET /api/ai/predict/project-health/:id` self-contained off `projects`'
  own always-populated columns instead — transparent driver-based risk score (schedule
  variance, days-overdue, cost variance, stalled progress) plus a GPT-optional/
  rule-based narrative, same discipline as `ceo-insights`. Surfaced in `Project360.jsx`'s
  Overview tab as an "AI Health Summary" card. Live-verified against the 3 real
  active/planning projects in the dev DB — correctly distinguished two genuinely
  100+-day-overdue projects (critical) from one merely-stalled one (healthy band).

### Predict
- ~~**Quality / defect-rate prediction**~~ — ✅ **Done 2026-08-06**, see
  `MODULE_FEATURE_CONNECTION_MANUAL.md` §79. `quality_tests` is empty and `ncr_reports`'
  8 rows are synthetic fixture data with no real item/batch linkage — built anyway at the
  user's explicit request. New `GET /api/ai/predict/quality-risk`: transparent
  driver-based batch risk score (fail rate of tests recorded so far, scrap rate, item's
  historical fail-rate baseline) — deliberately excludes an NCR-per-batch driver since
  `ncr_reports.reference_id` has no reliable linkage in the live data, which would make
  it an assumption dressed up as a signal. Verified via a rolled-back synthetic
  transaction (3/5 tests failed, 8% scrap → correctly scored 50/`high`); real data
  correctly returns nothing (both real open production orders have zero tests recorded).
- **Individual-level attrition risk** — today's model is department-aggregate only;
  the same tenure/status signal used there could plausibly rank individual
  flight-risk, if the business wants that granularity (worth confirming appetite —
  individual risk scoring is more sensitive than a department rollup).
- ~~**Vendor delivery-delay prediction**~~ — ✅ **Done 2026-08-06**, see
  `MODULE_FEATURE_CONNECTION_MANUAL.md` §74. A 9th `/prescriptive` recommendation ranks
  vendors by historical late-delivery rate (≥2 delivered POs, ≥34% late) who currently
  have an open PO — the forward-looking signal `deliveryFollowup.cron.js` doesn't provide
  (it only reacts to a PO already overdue). Falls back to `order_date +
  vendor.lead_time_days` as the implied expected date when `expected_delivery_date` is
  unset (true for nearly every real PO in this pilot's data). **Note**: the pre-existing
  Vendor Health Engine (Phase 49G, `vendorHealth.service.js`, `vendor_health_scores.otd_pct`/
  `delivery_score`) looks like it should already cover this but doesn't — `vendor_health_scores`
  has zero rows; two of its source queries reference columns that don't exist on
  `goods_receipt_notes`/`purchase_orders` and fail silently. Flagged, not fixed — a
  separate, larger task than this one gap.

### Recommend
- ~~**Extend `/prescriptive` to Sales and Service**~~ — ✅ **Already done**, found live
  2026-08-06 (see `MODULE_FEATURE_CONNECTION_MANUAL.md` §69) — a concurrent session had
  already shipped it without updating this doc. `ai.routes.js:852-878` calls
  `getSalesDashboard`/`getServiceDashboard` (`customerHealth.service.js`) and pushes a
  Sales rec for `at_risk`/`needs_attention` customers and a Service rec for open
  critical-priority escalations, same `{action, rationale, impact}` shape as the rest of
  the endpoint. **Update 2026-08-06 (§71):** the wiring was correct but had never actually
  fired — `customer_health_scores.customer_id` was `INTEGER` against a `uuid` customer
  identity space, so every write since the engine shipped (2026-06-16) silently failed.
  Fixed via a corrective migration and live-verified: the Sales rec now fires for real
  flagged accounts.
- ~~**Lead/opportunity prioritization for Sales**~~ — ✅ **Done 2026-08-06**, see
  `MODULE_FEATURE_CONNECTION_MANUAL.md` §75. New `GET /api/ai/predict/lead-priority` scores
  every open opportunity on expected revenue, pipeline stage, closing-date urgency,
  staleness, and whether a next step is defined — same transparent driver-based pattern as
  `/predict/device-failure`, not a black-box rank. Surfaced in `ERPIntelligence.jsx`'s
  Predictive tab as a "Lead Priority Queue" panel. Live-verified against the 6 real open
  opportunities in the dev DB — produced a genuinely differentiated 61-95 ranking.

### Assist
- **In-context drafting, not just navigation/search** — nothing today helps a human
  *compose* something (a rejection email, an offer letter, an AMC renewal quote, a QC
  non-conformance description). The chat copilot exists but is a separate,
  general-purpose surface, not embedded in the specific form a user is already filling.
  Lowest-risk starting point: a "draft this" button next to a free-text field that
  calls the same `/llm-chat` infrastructure with a task-specific prompt, keeping a
  human in the loop to edit/approve before saving — same spirit as `ceo-insights`'
  "never invents operational data" rule.

---

## Cross-cutting note
Every existing endpoint above correctly grounds its output in live query results and
either falls back to a rule-based response or fails closed when `OPENAI_API_KEY` is
absent — none of them fabricate numbers. Any new AI surface should keep that same
discipline: the model narrates or ranks what the database already says, it doesn't
invent facts the database doesn't have.
