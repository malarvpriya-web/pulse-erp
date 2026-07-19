# WAREHOUSE MANAGEMENT AUDIT
## Step 5 — Warehouse, Zones, Bins, Racks
### Audited: 2026-06-13

---

## DATABASE SCHEMA

### warehouses (inline DDL — NO dedicated migration)
```
warehouses:
  id SERIAL PK
  name VARCHAR (original column)
  warehouse_name VARCHAR (added by 20260522000001 when 'name' exists)
  address VARCHAR
  type VARCHAR (main, etc.)
  deleted_at TIMESTAMPTZ
```
> ⚠️ Dual-column issue: `name` vs `warehouse_name` — normalised by migration 20260522000001 but inconsistent.

### warehouse_zones (inline DDL — NO dedicated migration)
```
warehouse_zones:
  id SERIAL PK
  warehouse_id → warehouses(id)
  name VARCHAR
  zone_type VARCHAR (receiving/storage/dispatch)
```

### bin_locations (inline DDL — NO dedicated migration)
```
bin_locations:
  id SERIAL PK
  zone_id → warehouse_zones(id)
  bin_code VARCHAR
  row_no VARCHAR
  shelf VARCHAR
  level VARCHAR
  current_items JSONB DEFAULT '[]'
```

---

## API AUDIT

### Routes Available (warehouse.routes.js)

| Endpoint | Function | Auth Level | Status |
|----------|----------|------------|--------|
| GET /warehouse/bins | List all bins | verifyToken only | ✅ Works |
| GET /warehouse/zones | List zones with warehouse | verifyToken only | ✅ Works |
| POST /warehouse/bins/assign | Assign item to bin | verifyToken only | ✅ Works |
| POST /warehouse/inward | Receive goods, stock ledger entry | verifyToken only | ✅ Works |
| GET /warehouse/pick-lists | List pick lists | verifyToken only | ✅ Works |
| POST /warehouse/pick-lists | Create pick list | verifyToken only | ✅ Works |
| PUT /warehouse/pick-lists/:id/pick | Process picking | verifyToken only | ✅ Works |
| POST /warehouse/dispatch | Mark as dispatched | verifyToken only | ✅ Works |
| GET /warehouse/cycle-count | List cycle counts | verifyToken only | ✅ Works |
| POST /warehouse/cycle-count | Create cycle count | verifyToken only | ✅ Works |
| POST /warehouse/cycle-count/:id/submit | Submit with variance adjustments | verifyToken only | ✅ Works |

### MISSING Routes

| Missing Endpoint | Impact |
|-----------------|--------|
| POST /warehouse | Create new warehouse | ❌ No API — only hardcoded seed |
| GET /warehouse | List all warehouses | ❌ Only via /inventory/warehouses |
| PUT /warehouse/:id | Update warehouse | ❌ Missing |
| DELETE /warehouse/:id | Deactivate warehouse | ❌ Missing |
| POST /warehouse/zones | Create zone | ❌ Missing |
| PUT /warehouse/zones/:id | Update zone | ❌ Missing |
| GET /warehouse/pick-lists/:id | Get single pick list | ❌ Missing |

---

## WAREHOUSE FEATURES AUDIT

| Feature | Status | Evidence |
|---------|--------|----------|
| Warehouse Creation via UI | ❌ MISSING | No POST /warehouse endpoint; only seed in code |
| Warehouse Types | ⚠️ PARTIAL | Only 'main' type seeded; no type management |
| Warehouse Status | ⚠️ PARTIAL | deleted_at exists but no is_active toggle |
| Warehouse Locations | ✅ Present | warehouse_zones table |
| Bins | ✅ Present | bin_locations table |
| Racks / Rows | ✅ Present | row_no, shelf columns in bin_locations |
| Zones | ✅ Present | zone_type: receiving/storage/dispatch |
| Bin Occupancy | ⚠️ PARTIAL | current_items JSONB, not linked by item_id |
| Bin Capacity | ❌ MISSING | No max_capacity column |
| Warehouse Utilization % | ❌ MISSING | No capacity tracking |
| Multi-warehouse support | ✅ Present | warehouses table + stock_ledger.warehouse_id |
| Receiving Dock | ✅ Present | POST /warehouse/inward + zone_type='receiving' |
| Quarantine Zone | ⚠️ PARTIAL | Zone type seeded as 'Quarantine Zone' but no quarantine_stock tracking |
| Dispatch Bay | ✅ Present | Pick list → dispatch flow |

---

## CRITICAL ISSUES

### #1 — No Warehouse CRUD via API
**Evidence:** warehouse.routes.js lines 9-45 contains SEED DATA only (setTimeout(seedData, 2500))
No POST /warehouse, PUT /warehouse/:id routes exist.
**Impact:** Cannot create or modify warehouses through the ERP UI — must use DB seed.

### #2 — bin_locations.current_items uses item names (not item_id)
**Evidence:** warehouse.routes.js:38
```javascript
items.push({ item: item_name, qty: parseFloat(qty), unit });  // item name string only
```
**Impact:** Bin contents cannot be joined to inventory_items table by foreign key.
Stock traceability from bin → item → batch is broken.

### #3 — No Permission Enforcement on Warehouse Routes
**Evidence:** warehouse.routes.js — all routes use `verifyToken` only, no `requirePermission()`
**Impact:** Any authenticated user (including employees) can assign items to bins, create pick lists, or modify cycle counts.

### #4 — warehouse_name / name Column Inconsistency
**Evidence:** migration 20260522000001_inventory_ddl.js:229-247
```sql
IF EXISTS (column 'name') AND NOT EXISTS (column 'warehouse_name')
THEN ALTER TABLE warehouses ADD COLUMN warehouse_name VARCHAR(200);
UPDATE warehouses SET warehouse_name = name;
```
**Impact:** Some queries use `warehouse_name`, some use `name`. Inconsistent responses.

### #5 — cycle_count_headers and pick_lists have NO tracked migration
**Evidence:** These tables are referenced in warehouse.routes.js but their CREATE TABLE statements are not in any migration file.
**Impact:** Fresh deployment may fail if these tables don't exist.

---

## WAREHOUSE AUDIT SCORE

| Category | Score | Notes |
|----------|-------|-------|
| Warehouse CRUD | 2/5 | Read + soft-delete only; no Create/Update via API |
| Zone Management | 3/5 | Read + seed; no Create/Update |
| Bin Management | 4/5 | Full CRUD; item linking by name not ID |
| Pick List | 4/5 | Complete workflow |
| Receiving (Inward) | 4/5 | Works with stock ledger |
| Cycle Count | 5/5 | Excellent — pre-flight, variance, atomic |
| Security | 1/5 | No permission guards |
| Capacity Tracking | 0/5 | Not implemented |

**Overall: 23/40 = 58%**
