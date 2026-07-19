# INVENTORY CONSOLIDATION PLAN
## Step 22 — Duplication Elimination, Recommended Structure
### Audited: 2026-06-13

---

## CURRENT INVENTORY PAGE INVENTORY

| Page | File | Route Path | Access Via | Status |
|------|------|-----------|-----------|--------|
| InventoryDashboard | inventory/pages/InventoryDashboard.jsx | /inventory | moduleRegistry | KEEP |
| AdvancedInventoryDashboard | inventory/pages/AdvancedInventoryDashboard.jsx | /inventory/advanced | moduleRegistry | MERGE into Dashboard |
| ItemMaster | inventory/pages/ItemMaster.jsx | /inventory/items | moduleRegistry | KEEP (fix bugs) |
| StockSummary | inventory/pages/StockSummary.jsx | /inventory/stock | moduleRegistry | KEEP |
| StockMovements | inventory/pages/StockMovements.jsx | /inventory/movements | moduleRegistry | KEEP |
| BatchTracking | inventory/pages/BatchTracking.jsx | /inventory/batch | moduleRegistry | KEEP |
| MaterialConsumption | inventory/pages/MaterialConsumption.jsx | /inventory/material | moduleRegistry | KEEP |
| StockAlerts | inventory/pages/StockAlerts.jsx | /inventory/alerts | moduleRegistry | KEEP |
| Reservations | inventory/pages/Reservations.jsx | /inventory/reservations | moduleRegistry | KEEP |
| InventoryReport | inventory/pages/InventoryReport.jsx | /inventory/report | moduleRegistry | REBUILD (stub) |
| StoresDashboard | inventory/pages/StoresDashboard.jsx | /inventory/stores | moduleRegistry | MERGE into Dashboard |
| WarehouseManagement | warehouse/pages/WarehouseManagement.jsx | /inventory/warehouse | sidebar only | KEEP (fix security) |
| InventoryIntelligence | inventory/pages/InventoryIntelligence.jsx | /inventory/intelligence | sidebar only | KEEP |
| LogisticsShipping | logistics/pages/LogisticsShipping.jsx | /inventory/logistics | sidebar only | KEEP |
| QualityManagement | quality/pages/QualityManagement.jsx | /inventory/quality | sidebar only | KEEP |
| InventorySettings | inventory/pages/InventorySettings.jsx | /inventory/settings | moduleRegistry | FIX (not rebuild) |

---

## DUPLICATION ANALYSIS

### Duplication #1 — THREE DASHBOARDS

**Duplicated pages:**
1. `InventoryDashboard.jsx` — KPIs + charts + low stock + movements
2. `AdvancedInventoryDashboard.jsx` — batch alerts + reservations + suggestions + aging
3. `StoresDashboard.jsx` — warehouse-wise value and SKU count

**Problem:** Three separate entry points for "inventory dashboard." User must know which dashboard to open.

**Recommendation: MERGE into single tabbed InventoryDashboard**
```
InventoryDashboard.jsx
  Tab 1: Overview (total items, value, movements) ← from current InventoryDashboard
  Tab 2: Warehouse View (per-warehouse KPIs) ← from StoresDashboard
  Tab 3: Advanced (batch alerts, reservations, aging) ← from AdvancedDashboard
```
**DELETE:** AdvancedInventoryDashboard.jsx, StoresDashboard.jsx
**RESULT:** 3 files → 1 file, 3 sidebar entries → 1

---

### Duplication #2 — STOCK SUMMARY vs DASHBOARD

**InventoryDashboard.jsx** calls `/inventory/stock/summary` for the category chart
**StockSummary.jsx** calls `/inventory/stock/summary` for the full report

**Problem:** Same API called twice, similar data shown in two pages.

**Recommendation: KEEP BOTH but differentiate**
- Dashboard: summary KPIs + visual chart only (quick overview)
- StockSummary: full filtered report with export (power user)
**No merge needed, but duplication should be documented in UI.**

---

### Duplication #3 — INVENTORY INTELLIGENCE vs REPORTS

**InventoryIntelligence.jsx** shows: ABC Analysis + Slow Movers + Reorder Alerts + Landed Costs
**InventoryReport.jsx** shows: Raw JSON dump of stock summary (stub)

**Problem:** InventoryReport.jsx is a useless stub; real reporting is in InventoryIntelligence.

**Recommendation: REBUILD InventoryReport.jsx as the proper report hub:**
```
InventoryReport.jsx (rebuilt)
  Section 1: Stock Ledger Report (per item, date range, opening/closing)
  Section 2: Inventory Valuation Report (with export)
  Section 3: ABC Analysis (moved from Intelligence)
  Section 4: Slow Movers / Dead Stock
  Section 5: Batch Report
  Section 6: GRN vs Invoice Matching
```
**InventoryIntelligence.jsx: keep for analytics/insights (non-report data)**

---

### Duplication #4 — ORPHAN NAVIGATION PAGES (4 pages)

**Pages accessible from sidebar but NOT in moduleRegistry:**
1. `WarehouseManagement` — critical, real backend, but no permission guard
2. `InventoryIntelligence` — live data, no permission guard
3. `LogisticsShipping` — separate module, accessed via inventory sidebar
4. `QualityManagement` — separate module, accessed via inventory sidebar

**Recommendation:**
- WarehouseManagement → ADD to moduleRegistry as `warehouse` sub-module under Inventory
- InventoryIntelligence → ADD to moduleRegistry under Inventory
- LogisticsShipping → MOVE to Logistics module in moduleRegistry
- QualityManagement → MOVE to Quality module in moduleRegistry

---

### Duplication #5 — STOCK ALERTS vs LOW STOCK IN DASHBOARD

**InventoryDashboard.jsx** shows low stock alerts list
**StockAlerts.jsx** shows advanced stock alerts from `stock_alerts` table

**Problem:** Two different alert types shown in different pages — confusing.

**Recommendation: KEEP BOTH — they serve different purposes:**
- Dashboard low stock: simple reorder_level breaches (from stock_ledger calc)
- StockAlerts: configurable thresholds with resolve workflow (from stock_alerts table)
**Add a link from Dashboard low stock → StockAlerts for full management.**

---

## RECOMMENDED INVENTORY CENTER STRUCTURE

```
INVENTORY
├── Dashboard (tabbed: Overview | Warehouse View | Advanced)
├── MASTER DATA
│   ├── Item Master (fix field name bugs + add HSN/GST/manufacturer)
│   └── Warehouse Management (add to moduleRegistry, add requirePermission)
├── TRANSACTIONS
│   ├── Stock Summary (view + filter + export)
│   ├── Stock Movements (ledger view)
│   ├── Batch Tracking
│   ├── Material Consumption (production issues)
│   └── Reservations (+ Allocations)
├── ALERTS & MRP
│   ├── Stock Alerts (advanced alerts)
│   └── Reorder Alerts (MRP-driven, links to PR generation)
├── ANALYTICS
│   └── Inventory Intelligence (ABC + Slow Movers + Landed Cost)
├── REPORTS
│   └── Inventory Reports (rebuilt hub: Ledger + Valuation + Batch + Expiry + GRN)
└── SETTINGS
    └── Inventory Settings (fix warehouse API + add missing settings)
```

**Pages removed:** AdvancedInventoryDashboard, StoresDashboard (merged into Dashboard)
**Pages rebuilt:** InventoryReport (from stub to full report hub)
**Pages moved:** LogisticsShipping → Logistics module; QualityManagement → Quality module
**Pages added to moduleRegistry:** WarehouseManagement, InventoryIntelligence

---

## BACKEND ROUTE CONSOLIDATION

### Duplication #1 — DUAL STOCK TRACKING

**Problem:** Both `inventory_items.current_stock` AND `stock_ledger` track stock quantities.
They can and do desync (cogsJournal.service.js updates both independently).

**Recommendation: REMOVE inventory_items.current_stock as authoritative source.**
- Source of truth: stock_ledger (SUM qty_in - qty_out)
- current_stock: computed/cached field only, refreshed on each movement
- Remove direct UPDATE to inventory_items.current_stock from cogsJournal.service.js

### Duplication #2 — HARDCODED VALUES ACROSS ROUTES

**Files with hardcoded values that should read from company_settings:**
1. `inventory.routes.js:485` — `7 AS lead_time_days` → read from item master
2. `inventory.routes.js:486` — `false AS auto_create_po` → read from company_settings.auto_generate_pr
3. `inventory.routes.js:459` — `pending_pos: 0` → COUNT from purchase_orders WHERE status='pending'
4. `warehouse.routes.js:38` — seed data for copper wire → move to seeds/ directory

### Duplication #3 — STOCK ADJUSTMENT + CYCLE COUNT VARIANCE

Both `stock-adjustments` and warehouse `cycle-count/submit` do the same thing:
create `stock_ledger` entries to adjust stock.

**Recommendation:** Create a single `adjustStock(client, item_id, qty, reason, created_by)` service
function that both call — single point of audit logging.

---

## CONSOLIDATION PRIORITY

| Action | Priority | Effort | Impact |
|--------|----------|--------|--------|
| Merge 3 dashboards into 1 tabbed | P1 | 2 days | High — UX clarity |
| Add warehouse routes requirePermission | P0 | 2 hours | Critical — security |
| Add orphan pages to moduleRegistry | P0 | 1 hour | Critical — security |
| Fix ItemMaster field name mismatch | P0 | 30 min | Critical — creates NULL items |
| Fix InventorySettings warehouse API | P1 | 30 min | Medium |
| Rebuild InventoryReport.jsx | P1 | 3 days | High |
| Remove inventory_items.current_stock dual tracking | P2 | 1 day | Medium |
| Extract adjustStock service function | P2 | 4 hours | Medium |
| Move Logistics/Quality from inventory sidebar | P2 | 1 hour | Low |
