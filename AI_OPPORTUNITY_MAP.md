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
- **Inventory** (`GET /predict/inventory`, `ai.routes.js:666`) — ⚠ **partially a
  stub**: it buckets items into critical/warning/ok purely from
  `current_stock` vs `reorder_level` (a threshold check, which the EOQ Planner
  already does on the Inventory dashboard) — the column that would make it a real
  *prediction*, `consumed_last_30d`, is hardcoded to `0` (`ai.routes.js:674`), so
  consumption velocity never actually factors in. Cheap, concrete fix before calling
  this "AI-predicted": wire it to actual stock-movement history.
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
- **Department-level digests** — an HR-Dashboard, Production-Dashboard, or
  Quality-Dashboard version of the same "3 bullets from live KPIs" call. Directly
  compounds with the `AUTOMATION_OPPORTUNITIES.md` "monthly KPI report" automation —
  the cron delivers the numbers, this narrates them.
- **Ticket / complaint thread summarization** — a long `support_tickets` conversation
  or a customer complaint history condensed to "what's the actual unresolved issue and
  what's been tried" for a Service Engineer picking up someone else's ticket.
- **Project status narrative** — `Project 360°` already aggregates a lot of
  cross-module data (per `PROJECT_TRACEABILITY_MAP.md`); a one-paragraph "is this
  project healthy" summary on top of the EVM/CPI/SPI numbers is the same pattern again.

### Predict
- **Fix the inventory stub first** (above) before adding new prediction surfaces on
  top of it.
- **Quality / defect-rate prediction** — QC has none today. Given Production already
  has batch/quality-rating data (`production_manager__Production.png` shows a "Quality
  Rating Distribution" widget) there's a real signal to predict from — e.g., "this
  batch's defect rate is trending toward the NCR threshold" before it's inspected.
- **Individual-level attrition risk** — today's model is department-aggregate only;
  the same tenure/status signal used there could plausibly rank individual
  flight-risk, if the business wants that granularity (worth confirming appetite —
  individual risk scoring is more sensitive than a department rollup).
- **Vendor delivery-delay prediction** — `deliveryFollowup.cron.js` reacts to a PO
  already being late; there's no forward-looking "this vendor is likely to be late
  based on their history" signal feeding into PO planning.

### Recommend
- **Extend `/prescriptive` to Sales and Service** — it currently covers
  Inventory/Finance/Revenue/HR; the same shape (action/rationale/impact) applied to
  `customerHealth.service.js`'s existing health/risk scores would give "these 3
  at-risk customers need outreach this week" — the scoring already exists, only the
  recommendation wrapper is missing, exactly like the inventory-cron pattern in
  `AUTOMATION_OPPORTUNITIES.md`.
- **Lead/opportunity prioritization for Sales** — CRM has pipeline data but no
  "work these leads first" ranking today.

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
