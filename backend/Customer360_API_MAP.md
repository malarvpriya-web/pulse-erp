# Customer 360 Intelligence Layer — API Map

Phase 49A | Implementation date: 2026-06-16

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/crm/customer-360/:customerId` | Full 360 — all 16 domains in one call |
| GET | `/api/v1/crm/customer-360/:customerId/timeline` | Unified chronological timeline (200 events max) |
| GET | `/api/v1/crm/customer-360/:customerId/health` | Customer health engine output |
| GET | `/api/v1/crm/customer-360/:customerId/documents` | Google Drive folder structure |

> **customerId** = `parties.id`. All legacy `/customer360/:partyId` sub-routes remain active.

---

## Primary Response Shape — GET /customer-360/:customerId

```json
{
  "data": {
    "customer":      { party, account, contacts[], outstanding },
    "sales":         { leads[], opportunities[], quotations[], sales_orders[], metrics{} },
    "tenders":       { list[], metrics{} },
    "projects":      { list[], milestones[], metrics{} },
    "engineering":   { boms[], ecns[], metrics{} },
    "procurement":   { purchase_requests[], rfqs[], purchase_orders[], grns[], metrics{} },
    "production":    { orders[], metrics{} },
    "quality":       { fat_reports[], sat_reports[], ncrs[], metrics{} },
    "logistics":     { dispatches[], metrics{} },
    "commissioning": { reports[], metrics{} },
    "service":       { tickets[], field_visits[], service_contracts[], metrics{} },
    "amc":           { contracts[], warranty_records[], metrics{} },
    "finance":       { invoices[], payments[], metrics{} },
    "travel":        { customer_visits[], project_travel[], metrics{} },
    "documents":     { root, folders[] },
    "timeline":      [ timelineEvent, ... ],
    "health":        { total_score, label, churn_risk, breakdown{} },
    "_meta":         { customer_id, company_id, generated_at, cache_ttl_seconds }
  }
}
```

---

## Domain → Table → Query Map

### 49A-1 Customer Profile

| Field | Table | Filter |
|-------|-------|--------|
| Party (GSTIN, PAN, credit_limit) | `parties` | `id = customerId` |
| Account (account_manager, credit_limit) | `accounts` | `party_id = customerId AND company_id = $cid` |
| Contacts | `contacts JOIN accounts` | `accounts.party_id = customerId AND company_id = $cid` |
| Outstanding | `invoices` | `party_id = customerId AND status != 'paid'` |

### 49A-2 Sales

| Data | Table | Filter |
|------|-------|--------|
| Leads | `leads LEFT JOIN employees` | email/company_name match, `company_id = $cid` |
| Opportunities | `opportunities LEFT JOIN employees` | `account_id` or `lead_id` link, `company_id = $cid` |
| Quotations | `quotations` | `customer_id = customerId, company_id = $cid` |
| Sales Orders | `sales_orders` | `customer_id = customerId, company_id = $cid` |

**Metrics**: lead_count, opportunity_count, quotation_count, po_count, pipeline_value, won_value, lost_value, win_rate

### 49A-3 Tenders

| Data | Table | Filter |
|------|-------|--------|
| Tenders | `opportunities` | `tender_number IS NOT NULL` + account/lead link |

**Metrics**: total, live, won, lost, total_bid_value, won_value, strike_rate

### 49A-4 Projects

| Data | Table | Filter |
|------|-------|--------|
| Projects | `projects LEFT JOIN employees` | `customer_id = customerId, company_id = $cid` |
| Cost | `project_cost_summary` | `project_id IN (...)` |
| Milestones | `project_milestones` | `project_id = ANY(projectIds)` |

**Metrics**: total_projects, active_projects, completed_projects, total_budget, total_actual_cost, margin_pct

### 49A-5 Engineering

| Data | Table | Filter |
|------|-------|--------|
| BOMs | `bom_headers` | via `production_orders → sales_orders → customer_id` |
| ECNs | `engineering_changes` | via `engineering_change_items → bom_id → bom_headers` |
| BOM lines count | `bom_lines` | `bom_id` |

**Metrics**: bom_count, ecn_count, open_ecns

### 49A-6 Procurement

| Data | Table | Filter |
|------|-------|--------|
| PRs | `purchase_requests` | `project_id = ANY(projectIds) OR sales_order_id = ANY(soIds)` |
| RFQs | `rfqs` | same |
| POs | `purchase_orders LEFT JOIN vendors` | same |
| GRNs | `goods_receipt_notes` | `purchase_order_id IN (PO ids)` |

**Metrics**: pr_count, rfq_count, po_count, grn_count, po_value

### 49A-7 Production

| Data | Table | Filter |
|------|-------|--------|
| Production Orders | `production_orders LEFT JOIN bom_headers` | `sales_order_id IN (SO ids), company_id = $cid` |
| Operations progress | `production_operations` | `production_order_id` |

**Metrics**: total_orders, in_progress, completed

### 49A-8 Quality

| Data | Table | Filter |
|------|-------|--------|
| FAT Reports | `fat_reports` | `customer_id = customerId, company_id = $cid` |
| SAT Reports | `sat_reports` | same |
| NCRs | `non_conformance_reports` | same |

**Metrics**: fat_count, sat_count, ncr_count, open_ncrs, fat_passed, sat_accepted

### 49A-9 Logistics

| Data | Table | Filter |
|------|-------|--------|
| Dispatches | `dispatch_records` | `customer_id = customerId, company_id = $cid` |

**Metrics**: total_dispatches, delivered, in_transit

### 49A-10 Commissioning

| Data | Table | Filter |
|------|-------|--------|
| Reports | `commissioning_reports` | `customer_id = customerId, company_id = $cid` |

**Metrics**: total, pending, accepted

### 49A-11 Service

| Data | Table | Filter |
|------|-------|--------|
| Tickets | `support_tickets` | `customer_id = customerId, company_id = $cid` |
| Field Visits | `field_service_visits LEFT JOIN employees` | same |
| Service Contracts | `service_contracts` | same |

**Metrics**: open_tickets, closed_tickets, critical_open, total_field_visits, avg_resolution_days

### 49A-12 AMC

| Data | Table | Filter |
|------|-------|--------|
| AMC Contracts | `amc_contracts` | `customer_id = customerId, company_id = $cid` |
| Warranty | `warranty_register` | same |

**Metrics**: total_contracts, active_contracts, expiring_soon (≤90 days), total_revenue

### 49A-13 Finance

| Data | Table | Filter |
|------|-------|--------|
| Invoices | `invoices` | `party_id = customerId, company_id = $cid` |
| Payments | `customer_payments` | `party_id = customerId, company_id = $cid` |

**Metrics**: total_invoices, total_revenue, outstanding, collected, overdue_count, lifetime_value, avg_order_value, orders_this_year

### 49A-14 Travel

| Data | Table | Filter |
|------|-------|--------|
| Customer Visits | `customer_visits LEFT JOIN employees` | `customer_id = customerId, company_id = $cid` |
| Project Travel | `travel_requests JOIN projects` | `projects.customer_id = customerId` |

**Metrics**: total_visits, total_project_trips, total_travel_cost, by_type[]

### 49A-15 Documents

| Data | Source |
|------|--------|
| Drive folder map | Generated from `parties.name` — 13 standard folders |

Folders: Opportunities, Quotations, Purchase Orders, Contracts, Drawings, BOM, FAT Reports, SAT Reports, Commissioning Reports, Service Reports, AMC, Invoices, Correspondence.

### 49A-16 Timeline

Events collected from 11 tables and merged, sorted descending by date (200 max):

| Event Type | Source Table | Date Field |
|------------|-------------|------------|
| `lead` | `leads` | `created_at` |
| `opportunity` | `opportunities` | `created_at` |
| `quotation` | `quotations` | `created_at` |
| `sales_order` | `sales_orders` | `created_at` |
| `project` | `projects` | `created_at` |
| `invoice` | `invoices` | `created_at` |
| `fat` | `fat_reports` | `completed_date` |
| `dispatch` | `dispatch_records` | `dispatch_date` |
| `commissioning` | `commissioning_reports` | `commissioning_date` |
| `ticket` | `support_tickets` | `created_at` |
| `amc` | `amc_contracts` | `created_at` |

---

## 49A-17 Health Engine

Scores are additive. Max = 100.

| Component | Max Score | Logic |
|-----------|-----------|-------|
| Revenue Score | 25 | Lifetime value tiers: ≥₹1Cr=25, ≥₹10L=20, ≥₹1L=15, >0=10 |
| Collection Score | 20 | `20 - overdue_count × 4` |
| Margin Score | 15 | Project margin %: ≥30%=15, ≥20%=12, ≥10%=8, >0=4 |
| NCR Score | 10 | `10 - critical_open_tickets × 3` |
| Ticket Score | 15 | `(closed / total) × 15` |
| AMC Score | 10 | `min(10, active_contracts × 4)` |
| Project Success | 5 | `(completed / total) × 5` |

| Score | Label | Churn Risk |
|-------|-------|-----------|
| 85–100 | Excellent | low |
| 65–84 | Good | low |
| 40–64 | Watchlist | medium |
| 0–39 | Critical | high |

---

## 49A-18 Performance Strategy

### Parallelism
All 16 aggregator calls are fired simultaneously via `Promise.all()` in `getCustomer360()`.  
Timeline uses `Promise.allSettled()` across 11 tables — one failed table never blocks the rest.

### Cache
- Store: Node.js `Map` (in-process, per-worker)
- Key: `c360_${customerId}_${companyId}`
- TTL: 60 seconds
- Health sub-cache key: `c360_health_${customerId}_${companyId}`
- Invalidation: `cacheInvalidate(customerId, companyId)` — call after any write to customer data

### Recommended Indexes

```sql
-- Finance
CREATE INDEX IF NOT EXISTS idx_invoices_party_company ON invoices (party_id, company_id);
CREATE INDEX IF NOT EXISTS idx_customer_payments_party ON customer_payments (party_id, company_id);

-- Sales
CREATE INDEX IF NOT EXISTS idx_quotations_customer ON quotations (customer_id, company_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sales_orders_customer ON sales_orders (customer_id, company_id) WHERE deleted_at IS NULL;

-- Projects
CREATE INDEX IF NOT EXISTS idx_projects_customer ON projects (customer_id, company_id) WHERE deleted_at IS NULL;

-- Service / AMC
CREATE INDEX IF NOT EXISTS idx_support_tickets_customer ON support_tickets (customer_id, company_id);
CREATE INDEX IF NOT EXISTS idx_amc_contracts_customer ON amc_contracts (customer_id, company_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_customer ON dispatch_records (customer_id, company_id);
CREATE INDEX IF NOT EXISTS idx_commissioning_customer ON commissioning_reports (customer_id, company_id);
CREATE INDEX IF NOT EXISTS idx_fat_customer ON fat_reports (customer_id, company_id);
CREATE INDEX IF NOT EXISTS idx_sat_customer ON sat_reports (customer_id, company_id);
```

---

## 49A-19 Security

Every repository query includes:

```js
AND ($N::int IS NULL OR company_id = $N)
```

- `companyId = req.user?.company_id ?? null` — extracted from JWT by `verifyToken` middleware
- When `company_id` is `NULL` (super-admin context), the filter is skipped
- No cross-company data leakage possible: Customer A's `customerId` will return empty arrays for any domain where Company B holds the data

---

## File Structure

```
backend/src/modules/crm/
  customer360.repository.js   — raw SQL for all 16 domains
  customer360.service.js      — orchestration, caching, metrics, health engine
  customer360.controller.js   — HTTP request handlers
  routes/
    customer360.routes.js     — route wiring (unified + legacy endpoints)
```

## Mounted at

```
server.js → v1Router.use("/crm", verifyToken, crmRoutes)
→ crm/routes/index.js → router.use(customer360Routes)
→ /api/v1/crm/customer-360/:customerId
```
