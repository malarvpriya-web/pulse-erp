# INVENTORY SECURITY AUDIT
## Step 19 — Role-Based Access Control, Permission Matrix
### Audited: 2026-06-13

---

## PERMISSION FRAMEWORK

The ERP uses `requirePermission(module, action)` middleware.
- `view` → read-only access
- `add` → create new records
- `edit` → update existing records
- (no `delete` permission enforced anywhere in inventory)

---

## INVENTORY ROUTES PERMISSION AUDIT

### inventory.routes.js — All routes use requirePermission

| Route | Permission Required | Correct Level |
|-------|-------------------|---------------|
| GET /inventory/items | inventory.view | ✅ |
| POST /inventory/items | inventory.add | ✅ |
| PUT /inventory/items/:id | inventory.edit | ✅ |
| GET /inventory/stock/summary | inventory.view | ✅ |
| POST /inventory/stock/movement | inventory.add | ✅ |
| POST /inventory/stock-transfers | inventory.add | ✅ |
| PUT /warehouse-transfers/:id/dispatch | inventory.edit | ✅ |
| PUT /warehouse-transfers/:id/receive | inventory.edit | ✅ |
| POST /inventory/stock-adjustments | inventory.add | ✅ |
| POST /inventory/rm-issues | inventory.add | ✅ |
| GET /inventory/reorder-alerts | inventory.view | ✅ |
| GET /inventory/abc-analysis | inventory.view | ✅ |
| GET /inventory/stock/valuation | inventory.view | ⚠️ Should restrict to finance role |
| GET /inventory/landed-costs | inventory.view | ⚠️ Should restrict to finance role |

### advancedInventory.routes.js — All routes use requirePermission
All routes properly use `requirePermission('inventory', action)` ✅

---

## WAREHOUSE ROUTES — SECURITY FAILURE

**File:** `backend/src/modules/warehouse/warehouse.routes.js`
**Mount:** `v1Router.use("/warehouse", verifyToken, warehouseRoutes)`

| Route | Auth Applied | Permission Check | Risk |
|-------|-------------|-----------------|------|
| GET /warehouse/bins | verifyToken | ❌ NONE | Any employee can view bins |
| GET /warehouse/zones | verifyToken | ❌ NONE | Any employee can view zones |
| POST /warehouse/bins/assign | verifyToken | ❌ NONE | Any employee can assign items to bins |
| POST /warehouse/inward | verifyToken | ❌ NONE | Any employee can receive goods |
| POST /warehouse/pick-lists | verifyToken | ❌ NONE | Any employee can create pick lists |
| PUT /warehouse/pick-lists/:id/pick | verifyToken | ❌ NONE | Any employee can process picks (reduces stock!) |
| POST /warehouse/dispatch | verifyToken | ❌ NONE | Any employee can dispatch goods |
| GET /warehouse/cycle-count | verifyToken | ❌ NONE | Any employee can view counts |
| POST /warehouse/cycle-count | verifyToken | ❌ NONE | Any employee can initiate counts |
| POST /warehouse/cycle-count/:id/submit | verifyToken | ❌ NONE | Any employee can adjust stock! |

**SEVERITY: P0 — CRITICAL SECURITY VULNERABILITY**
Any authenticated user (including employees with no warehouse role) can:
1. Modify bin contents
2. Receive goods (creating stock_ledger entries)
3. Reduce stock via pick lists
4. Apply cycle count variances directly to stock

---

## ROLE-BASED VISIBILITY MATRIX

### Who should see what

| Role | Item Master | Stock View | Adjustments | Transfers | Valuation | Warehouse | Reports |
|------|------------|------------|-------------|-----------|-----------|-----------|---------|
| super_admin | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| admin | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| manager | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| stores_manager | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| production_head | View | ✅ | ❌ | ❌ | ❌ | View | View |
| procurement | View | View | ❌ | ❌ | ❌ | ❌ | ✅ |
| quality | View | View | ❌ | ❌ | ❌ | ❌ | View |
| finance | View | View | ❌ | ❌ | ✅ | ❌ | ✅ |
| employee | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

### Current moduleRegistry Permissions for Inventory
```javascript
// moduleRegistry.js:456
permissions: ['super_admin', 'admin', 'manager']
```
**All inventory sub-pages only visible to super_admin, admin, manager.**

**Issue:** Stores Manager, Production Head, Quality, Finance roles cannot access inventory pages.
These roles would need specialized inventory access that doesn't exist in the current permission matrix.

---

## IDOR (INSECURE DIRECT OBJECT REFERENCE) CHECK

| Route | company_id scoped | IDOR Risk |
|-------|------------------|----------|
| GET /inventory/items | ✅ (company_id filter) | Low |
| GET /inventory/items/:id | ⚠️ findById(id) — no company_id check | MEDIUM |
| PUT /inventory/items/:id | ⚠️ update(id, data) — no company_id check | MEDIUM |
| GET /inventory/advanced/batches | ✅ (v_batch_stock no company filter) | HIGH |
| GET /warehouse/bins | ❌ No company filter | HIGH |

**Recommendation:** Add company_id scoping to all inventory endpoints.

---

## ADJUSTMENT RIGHTS

| Role | Stock Adjustment | Transfer | Cycle Count Variance |
|------|-----------------|----------|---------------------|
| super_admin | ✅ | ✅ | ✅ |
| admin | ✅ | ✅ | ✅ |
| manager | ✅ | ✅ | ✅ |
| Any authenticated user | ✅ (warehouse routes) | ✅ (warehouse routes) | ✅ (warehouse routes) |

**The warehouse routes security gap means adjustment rights are uncontrolled.**

---

## SECURITY AUDIT SCORE

| Category | Score | Notes |
|----------|-------|-------|
| Inventory routes auth | 4/5 | Good, missing delete |
| Advanced inventory auth | 5/5 | Good |
| Warehouse routes auth | 0/5 | CRITICAL — no permission checks |
| IDOR protection (items) | 3/5 | company_id at list, not single-item |
| IDOR protection (batches) | 2/5 | No company filter |
| Role-based visibility | 2/5 | Only 3 roles can access |
| Audit logging | 4/5 | inventory.routes.js logs create/update |
| Valuation access control | 2/5 | Visible to all 3 roles |

**Overall: 22/40 = 55%**
