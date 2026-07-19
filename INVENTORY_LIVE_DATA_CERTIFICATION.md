# INVENTORY LIVE DATA CERTIFICATION
## Step 3 — Every Widget, KPI, Chart, Grid Classified
### Audited: 2026-06-13

---

## CLASSIFICATION KEY
- ✅ LIVE — reads from real DB via authenticated API
- ⚠️ PARTIAL — some fields live, some fallback/calculated client-side
- ❌ MOCK/STATIC — hardcoded or demo data
- 🔴 DEAD — UI element with no data source

---

## INVENTORY DASHBOARD (InventoryDashboard.jsx)

| Widget | Data Source | Classification | Evidence |
|--------|-------------|----------------|----------|
| Total Items KPI | GET /inventory/dashboard → total_items | ✅ LIVE | `COUNT(*) FROM inventory_items WHERE is_active = true` |
| Low Stock KPI | GET /inventory/dashboard → low_stock_count | ✅ LIVE | `stockLedgerRepo.getLowStockItems()` |
| Inventory Value KPI | GET /inventory/dashboard → total_value | ✅ LIVE | `SUM((quantity_in - quantity_out) * rate) FROM stock_ledger` |
| Holding Cost/Month KPI | GET /inventory/dashboard → total_holding_cost_monthly | ✅ LIVE | `total_value × INVENTORY_HOLDING_COST_RATE / 12` |
| Pending POs KPI | GET /inventory/dashboard → pending_pos | ⚠️ PARTIAL | Hardcoded `0` in backend: `pending_pos: 0` |
| Stock Qty by Category Chart | GET /inventory/stock/summary | ✅ LIVE | Groups by category from DB |
| Low Stock Alerts List | GET /inventory/stock/low-stock | ✅ LIVE | Real reorder_level comparison |
| Recent Stock Movements Table | GET /inventory/stock/movement?limit=8 | ✅ LIVE | stock_ledger rows |
| EOQ Planner | GET /procurement/analytics/eoq?item_id=X | ✅ LIVE | Calculated from purchase history |
| ABC Analysis Chart | Computed client-side from /inventory/stock/summary | ⚠️ PARTIAL | Client-side ABC, not the server-side ABC analysis |

**Dashboard Score: 9/10 live — Pending POs = 0 (hardcoded placeholder)**

---

## ADVANCED INVENTORY DASHBOARD (AdvancedInventoryDashboard.jsx)

| Widget | Data Source | Classification | Evidence |
|--------|-------------|----------------|----------|
| Low Stock Alerts count | GET /inventory/advanced/dashboard → low_stock_alerts | ✅ LIVE | COUNT from stock_alerts WHERE status='active' |
| Active Reservations count | GET /inventory/advanced/dashboard → active_reservations | ✅ LIVE | COUNT from inventory_reservations WHERE status='active' |
| Pending Suggestions count | GET /inventory/advanced/dashboard → pending_suggestions | ✅ LIVE | COUNT from purchase_suggestions |
| Expiring Batches count | GET /inventory/advanced/dashboard → expiring_batches | ✅ LIVE | inventory_batches WHERE expiry_date ≤ NOW()+30d |
| Total Reserved Value | GET /inventory/advanced/dashboard → total_reserved_value | ✅ LIVE | v_stock_summary aggregation |
| Total Available Value | GET /inventory/advanced/dashboard → total_available_value | ✅ LIVE | v_stock_summary aggregation |
| Reserved vs Available Chart | GET /inventory/advanced/reserved-vs-available | ✅ LIVE | inventory_batches aggregation |
| Stock Aging Chart | GET /inventory/advanced/stock-aging | ✅ LIVE | v_batch_stock age_days |
| Active Alerts List | GET /inventory/advanced/alerts?status=active | ✅ LIVE | stock_alerts table |

**Dashboard Score: 10/10 live**

---

## ITEM MASTER (ItemMaster.jsx)

| Widget | Data Source | Classification | Evidence |
|--------|-------------|----------------|----------|
| Items Grid | GET /inventory/items | ✅ LIVE | inventory_items table |
| Category Filter | Hardcoded array: ['Raw Materials','Finished Goods','Packaging','Consumables','Spares','WIP'] | ❌ STATIC | No DB-backed categories |
| Unit Dropdown | Hardcoded: ['pcs','kg','ltr','mtr','box','rolls','cans','set'] | ❌ STATIC | No UOM master table |
| Stock Status Badge | Calculated client-side from current_stock/reorder_level | ⚠️ PARTIAL | Uses item fields, not stock_ledger |

**Score: 2/4 live**

---

## STOCK SUMMARY (StockSummary.jsx)

| Widget | Data Source | Classification | Evidence |
|--------|-------------|----------------|----------|
| Total SKUs KPI | Client aggregation from /inventory/stock/summary | ✅ LIVE | count of summary rows |
| Total Stock Value KPI | Client aggregation: balance × avg_rate | ✅ LIVE | computed from live data |
| Low Stock Items KPI | Client filter: balance ≤ reorder_level | ✅ LIVE | computed from live data |
| Out of Stock KPI | Client filter: balance ≤ 0 | ✅ LIVE | computed from live data |
| Stock Summary Grid | GET /inventory/stock/summary | ✅ LIVE | v_stock_summary aggregation |
| Warehouse Filter | Extracted from summary data | ✅ LIVE | warehouse_name from DB |
| Type Filter | Extracted from summary data | ✅ LIVE | item_type from DB |
| Export Button | Client-side CSV/Excel | ✅ LIVE | generates from loaded data |

**Score: 8/8 live**

---

## STOCK MOVEMENTS (StockMovements.jsx)

| Widget | Data Source | Classification | Evidence |
|--------|-------------|----------------|----------|
| Movements Grid | GET /inventory/stock/movement | ✅ LIVE | stock_ledger table |
| Adjustment Type Filter | Hardcoded: Addition/Deduction/Write-off | ❌ STATIC | No adjustment type master |
| Item Dropdown (in form) | GET /inventory/items | ✅ LIVE | inventory_items table |
| Adjustment Submit | POST /inventory/stock-adjustments | ✅ LIVE | Transactional stock change |

**Score: 3/4 live**

---

## BATCH TRACKING (BatchTracking.jsx)

| Widget | Data Source | Classification | Evidence |
|--------|-------------|----------------|----------|
| Batches Grid | GET /inventory/advanced/batches | ✅ LIVE | v_batch_stock view |
| Item Dropdown | GET /inventory/items | ✅ LIVE | inventory_items |
| Warehouse Dropdown | GET /inventory/warehouses | ✅ LIVE | warehouses table |
| Create Batch Form | POST /inventory/advanced/batches | ✅ LIVE | inventory_batches table |
| Consume Batch | PUT /inventory/advanced/batches/:id/consume | ✅ LIVE | inventory_batches update |
| Status Filter (active) | URL param to GET /batches | ✅ LIVE | filtered by status |

**Score: 6/6 live**

---

## STOCK ALERTS & SUGGESTIONS (StockAlertsAndSuggestions.jsx)

| Widget | Data Source | Classification | Evidence |
|--------|-------------|----------------|----------|
| Active Alerts Grid | GET /inventory/advanced/alerts | ✅ LIVE | stock_alerts table |
| Acknowledge Action | POST /inventory/advanced/alerts/:id/acknowledge | ✅ LIVE | DB update |
| Resolve Action | POST /inventory/advanced/alerts/:id/resolve | ✅ LIVE | DB update |
| Purchase Suggestions Grid | GET /inventory/advanced/purchase-suggestions | ✅ LIVE | purchase_suggestions table |
| Convert to PR | POST /purchase-suggestions/:id/convert | ✅ LIVE | creates purchase_request |
| Reject Suggestion | POST /purchase-suggestions/:id/reject | ✅ LIVE | DB update |

**Score: 6/6 live**

---

## STOCK RESERVATIONS (StockReservations.jsx)

| Widget | Data Source | Classification | Evidence |
|--------|-------------|----------------|----------|
| Reservations Grid | GET /inventory/advanced/reservations | ✅ LIVE | inventory_reservations |
| Create Reservation | POST /inventory/advanced/reservations | ✅ LIVE | inventory_reservations |
| Consume Reservation | POST /reservations/:id/consume | ✅ LIVE | DB update |
| Cancel Reservation | POST /reservations/:id/cancel | ✅ LIVE | DB update |

**Score: 4/4 live**

---

## INVENTORY INTELLIGENCE (InventoryIntelligence.jsx)

| Widget | Data Source | Classification | Evidence |
|--------|-------------|----------------|----------|
| Reorder Alerts Grid | GET /inventory/reorder-alerts | ✅ LIVE | CROSS JOIN items × warehouses with stock balance |
| Auto-Generate POs | POST /inventory/reorder-alerts/generate-pos | ✅ LIVE | creates purchase_requests |
| Warehouse Transfers Grid | GET /inventory/warehouse-transfers | ✅ LIVE | warehouse_transfers table |
| Transfer Status Workflow | PUT /warehouse-transfers/:id/dispatch+receive | ✅ LIVE | stock_ledger entries |
| ABC Analysis Display | GET /inventory/abc-analysis | ✅ LIVE | abc_analysis_cache |
| Run ABC Button | POST /inventory/abc-analysis/run | ✅ LIVE | SQL CTE analysis |
| Slow Movers Grid | GET /inventory/slow-movers | ✅ LIVE | stock_ledger last movement |
| Landed Costs Grid | GET /inventory/landed-costs | ✅ LIVE | landed_costs table |
| Lead Time | Hardcoded `7 days` in reorder-alerts query | ❌ STATIC | Not from item master |

**Score: 8/9 live — Lead time is hardcoded**

---

## STORES DASHBOARD (StoresDashboard.jsx)

| Widget | Data Source | Classification | Evidence |
|--------|-------------|----------------|----------|
| Warehouse Cards | GET /inventory/stock/summary → grouped by warehouse | ✅ LIVE | Real warehouse data |
| SKU Count per Warehouse | Client aggregation | ✅ LIVE | Computed from live |
| Total Value per Warehouse | Client: balance × avg_rate | ✅ LIVE | Computed from live |
| Low Stock count per Warehouse | Client filter | ✅ LIVE | Computed from live |

**Score: 4/4 live**

---

## WAREHOUSE MANAGEMENT (WarehouseManagement.jsx)

| Widget | Data Source | Classification | Evidence |
|--------|-------------|----------------|----------|
| Bin Grid | GET /warehouse/bins | ✅ LIVE | bin_locations table |
| Zone List | GET /warehouse/zones | ✅ LIVE | warehouse_zones table |
| Assign Item to Bin | POST /warehouse/bins/assign | ✅ LIVE | bin_locations update |
| Inward Form | POST /warehouse/inward | ✅ LIVE | stock_ledger + bin_locations |
| Pick Lists | GET /warehouse/pick-lists | ✅ LIVE | pick_lists + pick_list_lines |
| Cycle Count List | GET /warehouse/cycle-count | ✅ LIVE | cycle_count_headers |
| Submit Count | POST /warehouse/cycle-count/:id/submit | ✅ LIVE | stock_ledger adjustments |
| Bin contents JSONB | current_items JSONB field | ⚠️ PARTIAL | Items stored by name, not item_id link |

**Score: 7/8 live — bin current_items not linked by item_id**

---

## INVENTORY REPORT (InventoryReport.jsx)

| Widget | Data Source | Classification | Evidence |
|--------|-------------|----------------|----------|
| Report Table | GET /inventory/stock/summary | ✅ LIVE | stock_ledger aggregation |
| Export | None | ❌ MISSING | No export button |
| Date Filter | None | ❌ MISSING | No date filter |
| Fallback message | Hardcoded string | ❌ STATIC | "Configure backend endpoint: /inventory/inventory-report" |

**Score: 1/4 — Minimal stub report**

---

## MATERIAL CONSUMPTION (MaterialConsumption.jsx)

| Widget | Data Source | Classification |
|--------|-------------|----------------|
| Consumption by Project | GET /inventory/advanced/material-consumption | ✅ LIVE |

**Score: 1/1 live (when v_material_consumption_by_project view is active)**

---

## SUMMARY — LIVE DATA CERTIFICATION

| Page | Score | Status |
|------|-------|--------|
| Inventory Dashboard | 9/10 | ✅ LIVE (pending_pos placeholder) |
| Advanced Dashboard | 10/10 | ✅ LIVE |
| Item Master | 2/4 | ⚠️ PARTIAL |
| Stock Summary | 8/8 | ✅ LIVE |
| Stock Movements | 3/4 | ✅ LIVE |
| Batch Tracking | 6/6 | ✅ LIVE |
| Stock Alerts | 6/6 | ✅ LIVE |
| Reservations | 4/4 | ✅ LIVE |
| Inventory Intelligence | 8/9 | ✅ LIVE (lead time hardcoded) |
| Stores Dashboard | 4/4 | ✅ LIVE |
| Warehouse Management | 7/8 | ✅ LIVE |
| Inventory Report | 1/4 | ❌ STUB |
| Material Consumption | 1/1 | ✅ LIVE |

### Mock / Static Data Remaining
| Element | File | Line | Verdict |
|---------|------|------|---------|
| pending_pos = 0 | inventory.routes.js:459 | L459 | PLACEHOLDER — wire to procurement |
| lead_time_days = 7 | inventory.routes.js:485 | L485 | HARDCODED — add to item master |
| CATEGORIES array | ItemMaster.jsx:6 | L6 | STATIC — create item_categories table |
| UNITS array | ItemMaster.jsx:7 | L7 | STATIC — create uom_master table |
| "/inventory/inventory-report" message | InventoryReport.jsx:22 | L22 | STALE MSG — remove fallback |
