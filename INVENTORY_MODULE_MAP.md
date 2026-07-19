# INVENTORY MODULE MAP
## Pulse ERP — Complete Inventory Inventory
### Audited: 2026-06-13 | Auditor: Multi-role Audit (Inventory / Stores / Supply Chain / Cost Accountant / ERP Architect / Internal Auditor)

---

## BACKEND — ROUTES

### 1. inventory.routes.js
**Mount:** `v1Router.use("/inventory", verifyToken, inventoryRoutes)`
**File:** `backend/src/modules/inventory/routes/inventory.routes.js`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /inventory/items | requirePermission('inventory','add') | Create item |
| GET | /inventory/items | requirePermission('inventory','view') | List items |
| GET | /inventory/items/:id | requirePermission('inventory','view') | Get item by ID |
| PUT | /inventory/items/:id | requirePermission('inventory','edit') | Update item |
| GET | /inventory/warehouses | requirePermission('inventory','view') | List warehouses |
| GET | /inventory/stock/summary | requirePermission('inventory','view') | Stock summary |
| GET | /inventory/stock/low-stock | requirePermission('inventory','view') | Low stock items |
| POST | /inventory/stock/movement | requirePermission('inventory','add') | Manual IN/OUT |
| GET | /inventory/stock/movement | requirePermission('inventory','view') | Movement history |
| GET | /inventory/stock/valuation | requirePermission('inventory','view') | Inventory valuation |
| POST | /inventory/rm-issues | requirePermission('inventory','add') | Create RM issue |
| GET | /inventory/rm-issues | requirePermission('inventory','view') | List RM issues |
| GET | /inventory/rm-issues/:id | requirePermission('inventory','view') | Get RM issue |
| POST | /inventory/stock-transfers | requirePermission('inventory','add') | Create direct transfer |
| GET | /inventory/stock-transfers | requirePermission('inventory','view') | List transfers |
| POST | /inventory/stock-adjustments | requirePermission('inventory','add') | Create adjustment |
| GET | /inventory/analytics/consumption-trends | requirePermission('inventory','view') | Consumption trends |
| GET | /inventory/dashboard | requirePermission('inventory','view') | Dashboard KPIs |
| GET | /inventory/reorder-alerts | requirePermission('inventory','view') | Reorder alerts |
| POST | /inventory/reorder-alerts/generate-pos | requirePermission('inventory','add') | Auto-generate PRs |
| GET | /inventory/abc-analysis | requirePermission('inventory','view') | ABC analysis (cached) |
| POST | /inventory/abc-analysis/run | requirePermission('inventory','view') | Run ABC analysis |
| GET | /inventory/slow-movers | requirePermission('inventory','view') | Slow movers |
| GET | /inventory/warehouse-transfers | requirePermission('inventory','view') | Staged transfers |
| POST | /inventory/warehouse-transfers | requirePermission('inventory','add') | Create staged transfer |
| PUT | /inventory/warehouse-transfers/:id/dispatch | requirePermission('inventory','edit') | Dispatch transfer |
| PUT | /inventory/warehouse-transfers/:id/receive | requirePermission('inventory','edit') | Receive transfer |
| GET | /inventory/landed-costs | requirePermission('inventory','view') | Landed costs |
| POST | /inventory/landed-costs | requirePermission('inventory','add') | Create landed cost |
| POST | /inventory/landed-costs/:id/allocate | requirePermission('inventory','edit') | Allocate landed cost |

### 2. advancedInventory.routes.js
**Mount:** `router.use('/advanced', advInventoryRouter)` (sub-router of inventory)
**File:** `backend/src/modules/inventory/routes/advancedInventory.routes.js`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /inventory/advanced/batches | requirePermission('inventory','add') | Create batch |
| GET | /inventory/advanced/batches | requirePermission('inventory','view') | List batches |
| PUT | /inventory/advanced/batches/:id/consume | requirePermission('inventory','edit') | Consume batch |
| POST | /inventory/advanced/reservations | requirePermission('inventory','add') | Create reservation |
| GET | /inventory/advanced/reservations | requirePermission('inventory','view') | List reservations |
| POST | /inventory/advanced/reservations/:id/consume | requirePermission('inventory','edit') | Consume reservation |
| POST | /inventory/advanced/reservations/:id/cancel | requirePermission('inventory','edit') | Cancel reservation |
| POST | /inventory/advanced/allocations | requirePermission('inventory','add') | Create allocation |
| GET | /inventory/advanced/allocations | requirePermission('inventory','view') | List allocations |
| GET | /inventory/advanced/alerts | requirePermission('inventory','view') | Stock alerts |
| POST | /inventory/advanced/alerts/:id/acknowledge | requirePermission('inventory','edit') | Acknowledge alert |
| POST | /inventory/advanced/alerts/:id/resolve | requirePermission('inventory','edit') | Resolve alert |
| GET | /inventory/advanced/purchase-suggestions | requirePermission('inventory','view') | Purchase suggestions |
| POST | /inventory/advanced/purchase-suggestions/:id/reject | requirePermission('inventory','edit') | Reject suggestion |
| POST | /inventory/advanced/purchase-suggestions/:id/convert | requirePermission('inventory','add') | Convert to PR |
| GET | /inventory/advanced/stock-summary | requirePermission('inventory','view') | Advanced stock summary |
| GET | /inventory/advanced/stock-aging | requirePermission('inventory','view') | Stock aging report |
| GET | /inventory/advanced/material-consumption | requirePermission('inventory','view') | Material consumption |
| GET | /inventory/advanced/reserved-vs-available | requirePermission('inventory','view') | Reserved vs available |
| GET | /inventory/advanced/dashboard | requirePermission('inventory','view') | Advanced dashboard |

### 3. warehouse.routes.js
**Mount:** `v1Router.use("/warehouse", verifyToken, warehouseRoutes)`
**File:** `backend/src/modules/warehouse/warehouse.routes.js`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /warehouse/bins | verifyToken only | Bin locations |
| GET | /warehouse/zones | verifyToken only | Warehouse zones |
| POST | /warehouse/bins/assign | verifyToken only | Assign item to bin |
| POST | /warehouse/inward | verifyToken only | Receive goods inward |
| GET | /warehouse/pick-lists | verifyToken only | Pick lists |
| POST | /warehouse/pick-lists | verifyToken only | Create pick list |
| PUT | /warehouse/pick-lists/:id/pick | verifyToken only | Process picking |
| POST | /warehouse/dispatch | verifyToken only | Dispatch |
| GET | /warehouse/cycle-count | verifyToken only | Cycle count list |
| POST | /warehouse/cycle-count | verifyToken only | Create cycle count |
| POST | /warehouse/cycle-count/:id/submit | verifyToken only | Submit cycle count |

> ⚠️ SECURITY GAP: warehouse.routes.js uses verifyToken only — NO requirePermission() calls on any route.

---

## BACKEND — REPOSITORIES

| File | Tables Used |
|------|-------------|
| `inventory/repositories/inventoryItem.repository.js` | inventory_items |
| `inventory/repositories/stockLedger.repository.js` | stock_ledger |
| `inventory/repositories/advancedInventory.repository.js` | inventory_batches, inventory_reservations, inventory_allocations, stock_alerts, purchase_suggestions, v_stock_summary, v_batch_stock, v_material_consumption_by_project |
| `inventory/repositories/rmIssue.repository.js` | rm_issues, rm_issue_items |
| `procurement/repositories/grn.repository.js` | goods_received_notes, grn_items |
| `procurement/repositories/purchaseOrder.repository.js` | purchase_orders, purchase_order_items |

---

## BACKEND — SERVICES

| File | Description |
|------|-------------|
| `inventory/services/rmIssue.service.js` | RM Issue creation with stock deduction |
| `procurement/services/grn.service.js` | GRN creation with batch + stock ledger entry |
| `finance/services/cogsJournal.service.js` | COGS journal on dispatch/invoice |

---

## DATABASE — TABLES (Inventory Module)

### Core Tables (migration: 20260330000000_core_schema.js)
```
inventory_items
  id, item_code, item_name, item_type, unit_of_measure,
  reorder_level, current_stock, standard_cost,
  inventory_account_id, expense_account_id, description,
  is_active, deleted_at, created_at, updated_at
  + company_id (migration 20260530000001)
  + hsn_code, default_gst_rate (migration 20260506000004)
  + manufacturer (migration 20260505000001)
```

### Ledger Table (migration: 20260427000001_remaining_tables.js)
```
stock_ledger
  id, item_id → inventory_items, warehouse_id → warehouses,
  transaction_type, quantity_in, quantity_out, balance_qty,
  rate, value, reference_type, reference_id,
  transaction_date, remarks, created_by, created_at
```

### Warehouse Tables (from warehouse.routes.js seed — NOT in tracked migration)
```
warehouses
  id, name, address, type (+ warehouse_name alias column)
warehouse_zones
  id, warehouse_id, name, zone_type (receiving/storage/dispatch)
bin_locations
  id, zone_id, bin_code, row_no, shelf, level, current_items (JSONB)
```

### Transfer Tables (migration: 20260522000001_inventory_ddl.js)
```
stock_adjustments
  id, adjustment_number, warehouse_id, adjustment_date, adjustment_type, reason, notes
stock_adjustment_items
  id, adjustment_id, item_id, quantity, remarks
stock_transfers
  id, transfer_number, from_warehouse_id, to_warehouse_id, transfer_date, transferred_by, notes
stock_transfer_items
  id, transfer_id, item_id, quantity
warehouse_transfers
  id, transfer_number, from_warehouse_id, to_warehouse_id, items (JSONB), status
  (draft→in-transit→received→cancelled), transfer_date, received_date, notes, created_by
```

### Batch & Reservation Tables (migration: 20260522000001_inventory_ddl.js)
```
inventory_batches
  id, item_id, warehouse_id, batch_number, received_date, expiry_date,
  supplier_id, grn_id, quantity_received, quantity_available,
  quantity_consumed, quantity_reserved, rate, status, deleted_at
inventory_reservations
  id, item_id, warehouse_id, batch_id, reservation_type, reference_type,
  reference_id, reference_number, quantity_reserved, quantity_remaining,
  quantity_consumed, reserved_date, expiry_date, reserved_by, notes, status
inventory_allocations
  id, item_id, batch_id, warehouse_id, allocation_type, reference_type,
  reference_id, quantity, rate, allocation_date, allocated_by, purpose
```

### Alert & Analysis Tables (migration: 20260522000001_inventory_ddl.js)
```
stock_alerts
  id, item_id, warehouse_id, alert_type, status, alert_date,
  acknowledged_by, acknowledged_at, resolved_at, resolved_by, notes
purchase_suggestions
  id, item_id, warehouse_id, suggested_quantity, priority, status,
  generated_date, converted_to_pr_id, rejected_by, rejection_reason
abc_analysis_cache
  id, computed_at, stats (JSONB), items (JSONB)
landed_costs
  id, po_id, freight_cost, customs_duty, insurance, other_charges,
  total_landed_cost, allocation_method, status, allocated_at, allocated_items
```

### Cycle Count Tables (warehouse.routes.js — NOT in tracked migration)
```
cycle_count_headers
  id, warehouse_id, zone_id, scheduled_date, counted_by, status
cycle_count_lines
  id, header_id, item_id, item_name, bin_location_id, bin_code,
  system_qty, counted_qty, variance, status
pick_lists
  id, sales_order_id, sales_order_ref, notes, status, completed_at
pick_list_lines
  id, pick_list_id, item_id, item_name, bin_location_id, bin_code,
  required_qty, picked_qty, status
```

### Database Views (migration: 20260522000001_inventory_ddl.js)
```
v_stock_summary       → inventory_items × warehouses + stock_ledger
v_batch_stock         → inventory_batches + inventory_items + warehouses
v_material_consumption_by_project → rm_issues + rm_issue_items + inventory_items
```

### Database Functions
```
calculate_available_stock(item_id, warehouse_id) → NUMERIC
  Returns total_stock - reserved_stock
```

---

## MISSING DATABASE TABLES

| Table | Status | Impact |
|-------|--------|--------|
| serial_numbers | ❌ MISSING | CRITICAL — No serial tracking |
| item_categories | ❌ MISSING | Categories are hardcoded in frontend |
| inventory_transactions | ❌ MISSING | stock_ledger serves this purpose (acceptable) |
| fifo_layers | ❌ MISSING | FIFO valuation not implemented |
| standard_cost_history | ❌ MISSING | Standard cost tracking |
| stock_holds / quarantine_stock | ❌ MISSING | Quality hold tracking |
| safety_stock | ❌ MISSING | safety_stock column not in inventory_items |

---

## FRONTEND — PAGES

| Page | File | Registered In | Menu Visible |
|------|------|---------------|--------------|
| InventoryDashboard | features/inventory/pages/InventoryDashboard.jsx | routes.jsx + moduleRegistry | ✓ YES |
| AdvancedInventoryDashboard | features/inventory/pages/AdvancedInventoryDashboard.jsx | routes.jsx + moduleRegistry | ✓ YES |
| ItemMaster | features/inventory/pages/ItemMaster.jsx | routes.jsx + moduleRegistry | ✓ YES |
| StockSummary | features/inventory/pages/StockSummary.jsx | routes.jsx + moduleRegistry | ✓ YES |
| StockMovements | features/inventory/pages/StockMovements.jsx | routes.jsx + moduleRegistry | ✓ YES |
| BatchTracking | features/inventory/pages/BatchTracking.jsx | routes.jsx + moduleRegistry | ✓ YES |
| MaterialConsumption | features/inventory/pages/MaterialConsumption.jsx | routes.jsx + moduleRegistry | ✓ YES |
| StockAlertsAndSuggestions | features/inventory/pages/StockAlertsAndSuggestions.jsx | routes.jsx + moduleRegistry | ✓ YES |
| StockReservations | features/inventory/pages/StockReservations.jsx | routes.jsx + moduleRegistry | ✓ YES |
| InventoryReport | features/inventory/pages/InventoryReport.jsx | routes.jsx + moduleRegistry | ✓ YES |
| StoresDashboard | features/inventory/pages/StoresDashboard.jsx | routes.jsx + moduleRegistry | ✓ YES |
| WarehouseManagement | features/inventory/pages/WarehouseManagement.jsx | routes.jsx + sidebar | ⚠ Sidebar only |
| InventoryIntelligence | features/inventory/pages/InventoryIntelligence.jsx | routes.jsx + sidebar | ⚠ Sidebar only |
| LogisticsShipping | features/inventory/pages/LogisticsShipping.jsx | routes.jsx + sidebar | ⚠ Sidebar only |
| QualityManagement | features/inventory/pages/QualityManagement.jsx | routes.jsx + sidebar | ⚠ Sidebar only |
| InventorySettings | features/inventory/pages/InventorySettings.jsx | routes.jsx + settings | ✓ YES |

---

## FRONTEND — SERVICES

| File | Endpoints Used |
|------|---------------|
| `features/inventory/services/inventoryService.js` | Various /inventory/* endpoints |

---

## NAVIGATION REGISTRATION

| Source | Items |
|--------|-------|
| moduleRegistry.js | 11 items (Dashboard, Advanced, Items, Stock, Movements, Batch, Material, Alerts, Reservations, Report, Stores) |
| routes.jsx sidebar | 16 items (adds Warehouse, Intelligence, Quality, Logistics) |
| Settings sidebar | 1 item (InventorySettings) |

---

## SUMMARY COUNTS

| Category | Count |
|----------|-------|
| Backend Route Files | 3 |
| Backend API Endpoints | 43 |
| Backend Repositories | 6 |
| Backend Services | 3 |
| Frontend Pages | 16 |
| Database Tables (inventory core) | 17 |
| Database Views | 3 |
| Database Functions | 1 |
| Migrations (inventory) | 3 |
| MISSING Serial Tables | 1 (critical) |
| MISSING Valuation Tables | 2 |
