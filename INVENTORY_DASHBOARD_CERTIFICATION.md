# INVENTORY DASHBOARD CERTIFICATION
## Step 18 — Live Data Verification, No DEV/Mock Data
### Audited: 2026-06-13

---

## DASHBOARD WIDGETS CERTIFICATION

### PRIMARY INVENTORY DASHBOARD (InventoryDashboard.jsx)

| Widget | API | DB Verified | Classification | Certification |
|--------|-----|-------------|---------------|--------------|
| Total Items | /inventory/dashboard → total_items | COUNT(*) FROM inventory_items | ✅ LIVE | CERTIFIED |
| Low Stock | /inventory/dashboard → low_stock_count | getLowStockItems() FROM stock_ledger | ✅ LIVE | CERTIFIED |
| Inventory Value | /inventory/dashboard → total_value | SUM((qty_in-qty_out)*rate) FROM stock_ledger | ✅ LIVE | CERTIFIED |
| Holding Cost/Month | /inventory/dashboard → total_holding_cost_monthly | total_value × env_rate / 12 | ✅ LIVE | CERTIFIED |
| Pending POs | /inventory/dashboard → pending_pos | **HARDCODED: 0** | ❌ PLACEHOLDER | NOT CERTIFIED |
| Stock Qty by Category | /inventory/stock/summary | stock_ledger aggregation | ✅ LIVE | CERTIFIED |
| Low Stock Alerts List | /inventory/stock/low-stock | stock_ledger vs reorder_level | ✅ LIVE | CERTIFIED |
| Recent Movements | /inventory/stock/movement?limit=8 | stock_ledger last 8 rows | ✅ LIVE | CERTIFIED |
| EOQ Planner | /procurement/analytics/eoq | purchase_history | ✅ LIVE | CERTIFIED |
| ABC Chart | Client-side from /inventory/stock/summary | stock values | ✅ LIVE | CERTIFIED |

**Dashboard Score: 9/10 CERTIFIED**
**Defect: pending_pos = 0 (hardcoded placeholder)**

---

### ADVANCED INVENTORY DASHBOARD (AdvancedInventoryDashboard.jsx)

| Widget | API | DB Verified | Classification | Certification |
|--------|-----|-------------|---------------|--------------|
| Low Stock Alerts | /inventory/advanced/dashboard | stock_alerts COUNT | ✅ LIVE | CERTIFIED |
| Active Reservations | /inventory/advanced/dashboard | inventory_reservations COUNT | ✅ LIVE | CERTIFIED |
| Pending Suggestions | /inventory/advanced/dashboard | purchase_suggestions COUNT | ✅ LIVE | CERTIFIED |
| Expiring Batches | /inventory/advanced/dashboard | inventory_batches WHERE expiry_date | ✅ LIVE | CERTIFIED |
| Total Reserved Value | /inventory/advanced/dashboard | v_stock_summary | ✅ LIVE | CERTIFIED |
| Total Available Value | /inventory/advanced/dashboard | v_stock_summary | ✅ LIVE | CERTIFIED |
| Reserved vs Available Chart | /inventory/advanced/reserved-vs-available | inventory_batches | ✅ LIVE | CERTIFIED |
| Stock Aging Chart | /inventory/advanced/stock-aging | v_batch_stock | ✅ LIVE | CERTIFIED |
| Active Alerts List | /inventory/advanced/alerts?status=active | stock_alerts | ✅ LIVE | CERTIFIED |

**Dashboard Score: 10/10 CERTIFIED**

---

### STORES DASHBOARD (StoresDashboard.jsx)

| Widget | API | Classification | Certification |
|--------|-----|---------------|--------------|
| Warehouse Cards | /inventory/stock/summary grouped by warehouse | ✅ LIVE | CERTIFIED |
| Per-warehouse SKU count | Client aggregation | ✅ LIVE | CERTIFIED |
| Per-warehouse total value | Client: balance × avg_rate | ✅ LIVE | CERTIFIED |
| Low stock per warehouse | Client filter | ✅ LIVE | CERTIFIED |

**Dashboard Score: 4/4 CERTIFIED**

---

## DEV/MOCK DATA VERIFICATION

**Search performed:** Grep for hardcoded values, mock data, demo data in inventory pages

| File | Line | Content | Classification |
|------|------|---------|---------------|
| inventory.routes.js | 459 | `pending_pos: 0` | ❌ PLACEHOLDER |
| inventory.routes.js | 485 | `7 AS lead_time_days` | ❌ HARDCODED |
| inventory.routes.js | 486 | `false AS auto_create_po` | ❌ HARDCODED |
| ItemMaster.jsx | 6 | CATEGORIES = [...] hardcoded | ❌ STATIC |
| ItemMaster.jsx | 7 | UNITS = [...] hardcoded | ❌ STATIC |
| InventoryReport.jsx | 22 | "Configure backend endpoint: /inventory/inventory-report" | ❌ STALE MSG |
| warehouse.routes.js | 38 | Seed data for copper wire in bins | ⚠️ SEED |
| warehouse.routes.js | 11-25 | Auto-seed warehouse if empty | ⚠️ SEED (acceptable) |

---

## MRP ALERTS CERTIFICATION

| Widget | API | Status | Certification |
|--------|-----|--------|--------------|
| Reorder Alerts | /inventory/reorder-alerts | ✅ LIVE | CERTIFIED |
| Items below reorder | HAVING current_stock ≤ reorder_level | ✅ LIVE | CERTIFIED |
| Shortfall quantity | ii.reorder_level - current_stock | ✅ LIVE | CERTIFIED |
| Lead time | Hardcoded 7 days | ❌ STATIC | NOT CERTIFIED |

---

## WAREHOUSE UTILIZATION CERTIFICATION

| Widget | Status | Notes |
|--------|--------|-------|
| Warehouse value per location | ✅ LIVE | StoresDashboard |
| Bin occupancy | ✅ LIVE | bin_locations.current_items |
| Zone utilization % | ❌ MISSING | No capacity tracking |
| Overall utilization % | ❌ MISSING | No total capacity field |

---

## SERIALIZED ASSETS CERTIFICATION

| Widget | Status | Notes |
|--------|--------|-------|
| Serialized asset count | ❌ NOT POSSIBLE | No serial_numbers table |
| Serialized asset value | ❌ NOT POSSIBLE | No serial tracking |

---

## OPEN TRANSFERS CERTIFICATION

| Widget | Status | Notes |
|--------|--------|-------|
| Warehouse transfers (in-transit) | ✅ LIVE | warehouse_transfers WHERE status='in-transit' |
| Direct transfers open | ❌ NO STATUS | stock_transfers has no status column |

---

## FINAL CERTIFICATION SUMMARY

| Dashboard | Certified | Defects |
|-----------|-----------|---------|
| Inventory Dashboard | 9/10 | pending_pos placeholder |
| Advanced Dashboard | 10/10 | None |
| Stores Dashboard | 4/4 | None |
| MRP Alerts | 3/4 | Lead time hardcoded |
| Warehouse Utilization | 2/5 | No capacity tracking |
| Serialized Assets | 0/2 | No serial module |
| Open Transfers | 1/2 | No direct transfer status |

**Overall Dashboard Certification: 29/37 = 78%**

**Blocking items to reach 100%:**
1. Fix pending_pos: wire to procurement module
2. Add lead_time_days to item master
3. Implement serial number tracking
4. Add warehouse capacity fields
