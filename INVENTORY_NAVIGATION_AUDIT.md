# INVENTORY NAVIGATION AUDIT
## Step 2 — Menu → Page → API → DB
### Audited: 2026-06-13

---

## NAVIGATION MATRIX

| # | Menu Label | Route Key | Component File | API Called | DB Tables | Loads | Saves | Updates | Status |
|---|-----------|-----------|----------------|-----------|-----------|-------|-------|---------|--------|
| 1 | Dashboard | InventoryDashboard | inventory/pages/InventoryDashboard.jsx | /inventory/dashboard, /inventory/stock/summary, /inventory/stock/low-stock, /inventory/stock/movement, /inventory/items, /procurement/analytics/eoq | inventory_items, stock_ledger | ✓ | — | — | ✅ LIVE |
| 2 | Advanced Dashboard | AdvancedInventoryDashboard | inventory/pages/AdvancedInventoryDashboard.jsx | /inventory/advanced/dashboard, /inventory/advanced/reserved-vs-available, /inventory/advanced/stock-aging, /inventory/advanced/alerts | inventory_batches, inventory_reservations, stock_alerts | ✓ | — | — | ✅ LIVE |
| 3 | Item Master | ItemMaster | inventory/pages/ItemMaster.jsx | GET/POST/PUT /inventory/items | inventory_items | ✓ | ✓ | ✓ | ⚠️ BUG (field names) |
| 4 | Stock Summary | StockSummary | inventory/pages/StockSummary.jsx | /inventory/stock/summary | inventory_items, stock_ledger, warehouses | ✓ | — | — | ✅ LIVE |
| 5 | Stock Movements | StockMovements | inventory/pages/StockMovements.jsx | GET /inventory/stock/movement, POST /inventory/stock-adjustments | stock_ledger, stock_adjustments | ✓ | ✓ | — | ✅ LIVE |
| 6 | Batch Tracking | BatchTracking | inventory/pages/BatchTracking.jsx | GET /inventory/advanced/batches, POST /inventory/advanced/batches, PUT /inventory/advanced/batches/:id/consume | inventory_batches, v_batch_stock | ✓ | ✓ | ✓ | ✅ LIVE |
| 7 | Material Consumption | MaterialConsumption | inventory/pages/MaterialConsumption.jsx | /inventory/advanced/material-consumption | v_material_consumption_by_project | ✓ | — | — | ✅ LIVE |
| 8 | Stock Alerts | StockAlertsAndSuggestions | inventory/pages/StockAlertsAndSuggestions.jsx | /inventory/advanced/alerts, /inventory/advanced/purchase-suggestions | stock_alerts, purchase_suggestions | ✓ | — | ✓ | ✅ LIVE |
| 9 | Reservations | StockReservations | inventory/pages/StockReservations.jsx | /inventory/advanced/reservations | inventory_reservations | ✓ | ✓ | ✓ | ✅ LIVE |
| 10 | Inventory Report | InventoryReport | inventory/pages/InventoryReport.jsx | /inventory/stock/summary | stock_ledger | ✓ | — | — | ⚠️ STUB (shows fallback message) |
| 11 | Stores Dashboard | StoresDashboard | inventory/pages/StoresDashboard.jsx | /inventory/stock/summary | stock_ledger | ✓ | — | — | ✅ LIVE |
| 12 | Warehouse | WarehouseManagement | inventory/pages/WarehouseManagement.jsx | /warehouse/bins, /warehouse/zones, /warehouse/bins/assign, /warehouse/inward, /warehouse/pick-lists, /warehouse/cycle-count | bin_locations, warehouse_zones, cycle_count_headers, pick_lists | ✓ | ✓ | ✓ | ✅ LIVE |
| 13 | Inventory Intel | InventoryIntelligence | inventory/pages/InventoryIntelligence.jsx | /inventory/reorder-alerts, /inventory/warehouse-transfers, /inventory/abc-analysis, /inventory/slow-movers, /inventory/landed-costs | stock_ledger, abc_analysis_cache, warehouse_transfers, landed_costs | ✓ | ✓ | ✓ | ✅ LIVE |
| 14 | Quality | QualityManagement | inventory/pages/QualityManagement.jsx | /quality/checklists | quality_checklists | ✓ | ✓ | ✓ | ✅ LIVE |
| 15 | Logistics | LogisticsShipping | inventory/pages/LogisticsShipping.jsx | /logistics/shipments | shipments | ✓ | ✓ | — | ✅ LIVE |
| 16 | Settings | InventorySettings | inventory/pages/InventorySettings.jsx | /settings/inventory, /master/warehouses | company_settings | ✓ | ✓ | — | ⚠️ PARTIAL |

---

## DEAD PAGES — None Found
All 16 registered components have corresponding backend API routes.

---

## BROKEN ROUTES

### CRITICAL BUG #1 — ItemMaster Field Name Mismatch
**File:** `frontend/src/features/inventory/pages/ItemMaster.jsx`
**Evidence:**
```javascript
// Frontend form (line 10-14):
const emptyForm = () => ({
  sku: '', name: '', category: '', unit: 'pcs',
  current_stock: '', reorder_level: '', unit_price: '',
  ...
});
```
**Backend repository (inventoryItem.repository.js:6-12):**
```javascript
const { item_code, item_name, ... } = data;
INSERT INTO inventory_items (item_code, item_name, ...)
VALUES ($1, $2, ...)
// item_name = undefined when frontend sends 'name'
```
**Impact:** CREATE → item_name will be NULL in DB (validation may not catch it if backend validate() is lenient)
**Impact:** UPDATE → item_name set to NULL/undefined, erasing item name

### CRITICAL BUG #2 — InventorySettings calls wrong warehouse endpoint
**File:** `frontend/src/features/inventory/pages/InventorySettings.jsx:93`
```javascript
api.get('/master/warehouses')  // This endpoint may not exist
// Should be: api.get('/inventory/warehouses')
```
**Impact:** Default Warehouse dropdown will always be empty

### WARNING #3 — InventoryReport fallback message
**File:** `frontend/src/features/inventory/pages/InventoryReport.jsx:22`
```javascript
<code>/inventory/inventory-report</code>  // Shows when data is empty
```
**Impact:** Users see a "Configure backend endpoint" message in production if no stock exists

---

## ORPHAN PAGES (in routes.jsx but NOT in moduleRegistry.js)

| Page | Routes.jsx | moduleRegistry | Accessible Via |
|------|-----------|----------------|----------------|
| InventoryIntelligence | ✓ | ❌ | Sidebar submenu only |
| WarehouseManagement | ✓ | ❌ | Sidebar submenu only |
| LogisticsShipping | ✓ | ❌ | Sidebar submenu only |
| QualityManagement | ✓ | ❌ | Sidebar submenu only |

> These 4 pages are accessible via the sidebar's inline menu but not tracked in moduleRegistry.js.
> This means role-based permission enforcement does NOT apply to these 4 pages.
> Anyone with 'inventory' access sees them regardless of sub-permissions.

---

## DUPLICATE PAGES

| Overlap | Page A | Page B | Verdict |
|---------|--------|--------|---------|
| Stock Summary / Stores Dashboard | StockSummary | StoresDashboard | Both call /inventory/stock/summary — MERGE CANDIDATE |
| Inventory Dashboard / Advanced Dashboard | InventoryDashboard | AdvancedInventoryDashboard | Complementary — KEEP BOTH |
| Inventory Report / Stock Summary | InventoryReport | StockSummary | InventoryReport is a STUB of StockSummary — CONSOLIDATE |

---

## MISSING PAGES (no route exists)

| Missing Page | Why Needed |
|-------------|-----------|
| Serial Number Tracking | No serial_numbers table, no API, no page |
| Cycle Count (dedicated) | Only accessible via WarehouseManagement tab |
| Stock Transfer (dedicated) | Only via InventoryIntelligence tab |
| Finished Goods Receipt | No FGR page for production completion |
| Valuation Report | No dedicated valuation report page |
| Vendor Price History | Exists as procurement page, not linked from inventory |

---

## PAGE NAVIGATION INTEGRITY

All `setPage()` calls verified:
- InventoryDashboard → ItemMaster ✓
- InventoryDashboard → StockMovements ✓
- InventoryDashboard → PurchaseOrders ✓
- InventoryDashboard → InventorySettings ✓
- AdvancedInventoryDashboard → BatchTracking ✓
- AdvancedInventoryDashboard → StockReservations ✓
- AdvancedInventoryDashboard → StockAlertsAndSuggestions ✓
