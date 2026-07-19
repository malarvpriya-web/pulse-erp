# INVENTORY MRP AUDIT
## Step 16 — Stock Levels, Safety Stock, Reorder Point, MRP Demand, Shortage, Auto Procurement
### Audited: 2026-06-13

---

## MRP COMPONENTS VERIFIED

### Reorder Alerts (VERIFIED)
**Route:** GET /inventory/reorder-alerts
**File:** inventory.routes.js:469-500

```sql
SELECT
  ii.id, ii.item_code, ii.item_name,
  ii.reorder_level AS reorder_point,
  w.id AS warehouse_id, w.warehouse_name,
  COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) AS current_stock,
  ii.reorder_level - current_stock AS shortfall,
  GREATEST(ii.reorder_level * 2 - current_stock, ii.reorder_level) AS reorder_qty,
  7 AS lead_time_days,        ← HARDCODED
  false AS auto_create_po      ← HARDCODED
FROM inventory_items ii
CROSS JOIN warehouses w
LEFT JOIN stock_ledger sl ON ii.id = sl.item_id AND w.id = sl.warehouse_id
WHERE ii.is_active = true AND ii.reorder_level > 0
GROUP BY ...
HAVING current_stock <= ii.reorder_level
ORDER BY shortfall DESC
```
**Status: ✅ LIVE — Items at/below reorder level are detected**

### Auto-Generate PRs (VERIFIED)
**Route:** POST /inventory/reorder-alerts/generate-pos
**Status: ✅ LIVE — Creates purchase_requests for selected items**

### Purchase Suggestions (VERIFIED)
**Route:** GET /inventory/advanced/purchase-suggestions
**Route:** POST /inventory/advanced/purchase-suggestions/:id/convert (→ PR)
**Route:** POST /inventory/advanced/purchase-suggestions/:id/reject
**Status: ✅ LIVE**

---

## MRP FEATURE AUDIT

| Feature | Status | Evidence |
|---------|--------|----------|
| Current Stock Level | ✅ | From stock_ledger SUM |
| Reorder Point | ✅ | inventory_items.reorder_level |
| Safety Stock | ❌ MISSING | No safety_stock column in inventory_items |
| Lead Time per Item | ❌ MISSING | Hardcoded 7 days in query |
| MRP Demand Calculation | ❌ MISSING | No demand from BOM/production plan |
| Shortage Detection | ✅ | current_stock ≤ reorder_level |
| Auto Procurement (PR creation) | ✅ | reorder-alerts/generate-pos |
| Purchase Suggestion | ✅ | purchase_suggestions table |
| Suggest → PR conversion | ✅ | /purchase-suggestions/:id/convert |
| ABC-based reorder rules | ❌ MISSING | ABC computed but not applied to reorder |
| EOQ Calculation | ✅ | /procurement/analytics/eoq (external) |
| Multi-warehouse MRP | ⚠️ PARTIAL | CROSS JOIN all warehouses, aggregate per item+warehouse |
| Production Plan → MRP demand | ❌ MISSING | BOM/execution not linked to MRP |
| Safety Stock Calculation | ❌ MISSING | Not implemented |
| Forecast-based MRP | ❌ MISSING | Not implemented |

---

## CRITICAL MRP GAPS

### #1 — No Safety Stock Column
**Impact:** Cannot distinguish reorder point from safety stock.
The reorder_level serves as both — no buffer stock below which alerts fire earlier.
**Fix:** Add `safety_stock NUMERIC(12,2) DEFAULT 0` to inventory_items

### #2 — Hardcoded Lead Time (7 days)
**Evidence:** inventory.routes.js:485 `7 AS lead_time_days`
**Impact:** Reorder alerts cannot account for actual supplier lead times.
Items with 30-day lead time get the same urgency as 1-day items.
**Fix:** Add `default_lead_time_days INTEGER` to inventory_items or vendor_items table

### #3 — No Production Plan → MRP Link
**Impact:** MRP does not consider outstanding production orders when calculating material requirements.
If 100 units of Product X are in production requiring 500 IGBT units, the MRP doesn't know this demand.
**Fix:** execution.routes.js must feed BOM-exploded demand into MRP calculation

### #4 — Reorder Qty Formula is Simplistic
**Evidence:** `GREATEST(ii.reorder_level * 2 - current_stock, ii.reorder_level) AS reorder_qty`
**Impact:** Reorder quantity = 2× reorder level minus current stock. Not based on EOQ or actual demand.
**Fix:** Use EOQ from /procurement/analytics/eoq when available

---

## MRP AUDIT SCORE

| Feature | Score | Notes |
|---------|-------|-------|
| Stock Level Detection | 5/5 | Real-time from stock_ledger |
| Reorder Point Alerts | 4/5 | Works, lead time hardcoded |
| Safety Stock | 0/5 | Column doesn't exist |
| Auto PR Generation | 5/5 | Implemented |
| Purchase Suggestion Management | 5/5 | Full CRUD + convert |
| BOM → MRP Demand | 0/5 | Not wired |
| Production Plan → MRP | 0/5 | Not wired |
| Forecast-based Reorder | 0/5 | Not implemented |
| ABC-based Reorder Rules | 1/5 | ABC computed, not applied |
| EOQ Integration | 3/5 | EOQ exists in procurement, not used in MRP |

**Overall: 23/50 = 46%**
