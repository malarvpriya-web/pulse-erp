# CYCLE COUNT AUDIT
## Step 11 — Plans, Physical Count, Variance, Adjustment, Approval, Audit Trail
### Audited: 2026-06-13

---

## DATABASE SCHEMA

### cycle_count_headers (NO tracked migration — exists in warehouse.routes.js referenced tables)
```sql
cycle_count_headers:
  id SERIAL PK
  warehouse_id → warehouses
  zone_id → warehouse_zones
  scheduled_date DATE
  counted_by INTEGER (employee or user)
  status VARCHAR (open/completed)
  -- MISSING: approved_by, approval_date, approval_status
```

### cycle_count_lines (NO tracked migration)
```sql
cycle_count_lines:
  id SERIAL PK
  header_id → cycle_count_headers
  item_id → inventory_items (nullable)
  item_name VARCHAR
  bin_location_id → bin_locations
  bin_code VARCHAR
  system_qty NUMERIC
  counted_qty NUMERIC
  variance NUMERIC (counted_qty - system_qty)
  status VARCHAR (pending/counted)
```

---

## CYCLE COUNT WORKFLOW AUDIT

### Step 1: Create Cycle Count
**Route:** POST /warehouse/cycle-count
**File:** warehouse.routes.js:346-401
```
Input: warehouse_id OR zone_id, scheduled_date, counted_by
Action:
  1. Resolve warehouse_id (from zone if not provided) ✅
  2. INSERT cycle_count_headers ✅
  3. Pre-populate lines from bin_locations.current_items ✅
  4. For each bin item → lookup item_id by name ✅ (graceful)
```
**Status: ✅ COMPLETE**

### Step 2: Submit Count
**Route:** POST /warehouse/cycle-count/:id/submit
**File:** warehouse.routes.js:404-538
```
Input: lines[] = [{ line_id, counted_qty, system_qty }]
Action:
  PRE-FLIGHT:
    1. Resolve warehouse_id ✅
    2. For each variance line: resolve item_id ✅
    3. Collect unresolvable items → FAIL if any ✅
  WRITE PASS (all or nothing):
    1. UPDATE cycle_count_lines (counted_qty, variance, status='counted') ✅
    2. For variance lines: INSERT stock_ledger (transaction_type='cycle_count') ✅
       - Positive variance → quantity_in
       - Negative variance → quantity_out
    3. UPDATE cycle_count_headers status='completed', warehouse_id=resolved ✅
```
**Status: ✅ EXCELLENT — Atomic, pre-flight validated, stock ledger updated**

---

## CYCLE COUNT FEATURES AUDIT

| Feature | Status | Notes |
|---------|--------|-------|
| Create Cycle Count Plan | ✅ | Creates header + pre-populated lines |
| Pre-populate from Bins | ✅ | From bin_locations.current_items |
| Manual Item Entry | ⚠️ | Only via bin contents; cannot add items not in bins |
| Submit Physical Count | ✅ | Updates counted_qty and variance |
| Variance Calculation | ✅ | Automatic: counted - system |
| Stock Adjustment on Variance | ✅ | Atomic stock_ledger entries |
| Zero-variance lines | ✅ | Handled (no ledger write needed) |
| Unresolvable item pre-flight | ✅ | Returns 422 with unresolved list |
| Warehouse Validation | ✅ | Fails gracefully if no warehouse |
| View Cycle Counts | ✅ | GET /warehouse/cycle-count with aggregates |
| Variance Report | ⚠️ | Total variance per header, no detail API |
| Approval Workflow | ❌ MISSING | No approval before adjustments apply |
| Partial Count (zone-only) | ✅ | zone_id supported |
| Cycle Count PDF/Report | ❌ MISSING | No export |
| Scheduled Counts (recurring) | ❌ MISSING | No scheduling logic |
| Blind Count Mode | ❌ MISSING | System qty visible to counter |
| Count Freeze (block movements) | ❌ MISSING | Stock can be moved during count |
| Audit Trail | ⚠️ | Only via stock_ledger reference_type='cycle_count' |

---

## CRITICAL ISSUES

### #1 — No Approval Workflow
**Impact:** Variance adjustments apply immediately on submit without manager review.
For high-value items, this is a P1 risk.
**Fix:** Add approval step: status='pending_approval' → approved_by → then apply to stock_ledger

### #2 — No Tracked Migration for cycle_count tables
**Impact:** Fresh deployment may fail — tables must exist before warehouse routes run.
**Fix:** Add migration: CREATE TABLE cycle_count_headers / cycle_count_lines

### #3 — bin_locations.current_items JSONB not linked by item_id
**Impact:** If an item is renamed, the cycle count lines will fail to resolve item_id (gracefully returns unresolved list)
**Fix:** Use item_id in bin_locations.current_items

### #4 — Cycle Count blocks stock movements (should)
**Impact:** Stock can be received/issued during a count, invalidating system_qty
**Fix:** Lock zone during active cycle count or recalculate system_qty at submit time

---

## CYCLE COUNT SCORE

| Category | Score | Notes |
|----------|-------|-------|
| Plan Creation | 4/5 | Works, no scheduling |
| Physical Count Entry | 4/5 | Correct, no blind mode |
| Variance Calculation | 5/5 | Automatic and correct |
| Stock Adjustment | 5/5 | Atomic, pre-flight validated |
| Approval Workflow | 0/5 | Not implemented |
| Audit Trail | 3/5 | Via stock_ledger only |
| Reports/Export | 1/5 | No dedicated report |
| Count Freeze | 0/5 | Not implemented |

**Overall: 22/40 = 55%**
