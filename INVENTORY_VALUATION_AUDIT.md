# INVENTORY VALUATION AUDIT
## Step 10 — FIFO, Weighted Average, Standard Cost, Valuation Reports
### Audited: 2026-06-13

---

## VALUATION ROUTE AUDIT

### GET /inventory/stock/valuation
**File:** inventory.routes.js:173-180
**DB Query:**
```sql
SELECT ii.item_code, ii.item_name, ii.item_type,
       w.warehouse_name,
       COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) as balance,
       COALESCE(AVG(sl.rate), 0) as avg_rate,
       COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) * COALESCE(AVG(sl.rate), 0) as value
FROM inventory_items ii
CROSS JOIN warehouses w
LEFT JOIN stock_ledger sl ON ii.id = sl.item_id AND w.id = sl.warehouse_id
WHERE ii.deleted_at IS NULL AND w.deleted_at IS NULL
GROUP BY ...
HAVING balance > 0
ORDER BY value DESC
```
**Method Used: WEIGHTED AVERAGE (AVG of all rates)**

---

## VALUATION METHOD ASSESSMENT

### Setting vs Implementation Gap

**Setting (InventorySettings.jsx:37-39):**
```javascript
{
  key: 'valuation_method',
  label: 'Inventory Valuation Method',
  type: 'select',
  options: ['FIFO', 'LIFO', 'Weighted Average'],
  default: 'Weighted Average',
}
```

**Backend Implementation:**
```sql
COALESCE(AVG(sl.rate), 0) as avg_rate
```

| Method | Setting Available | Backend Implementation | Verdict |
|--------|-----------------|----------------------|---------|
| FIFO | ✅ | ❌ | SETTING EXISTS, NOT IMPLEMENTED |
| LIFO | ✅ | ❌ | SETTING EXISTS, NOT IMPLEMENTED |
| Weighted Average | ✅ | ✅ | IMPLEMENTED |
| Standard Cost | ❌ | ❌ | Not in settings, not implemented |

**CRITICAL FINDING:** The valuation_method setting in InventorySettings saves to company_settings table but the backend `/inventory/stock/valuation` route NEVER reads this setting. It always uses AVG(rate) regardless of configuration.

---

## HOLDING COST CALCULATION (BONUS — VERIFIED)

```javascript
// inventoryItem.repository.js:4-8
getHoldingRate() {
  const parsed = Number.parseFloat(process.env.INVENTORY_HOLDING_COST_RATE ?? '0.18');
  if (!Number.isFinite(parsed) || parsed < 0) return 0.18;
  return parsed;
}
```
- Annual holding cost = inventory_value × 18% ✅
- Monthly = annual / 12 ✅
- Configurable via env var ✅

---

## FIFO IMPLEMENTATION GAP

### What FIFO Requires
```
For each OUT movement, consume the OLDEST inventory layers first.
Requires a FIFO layers table:
  fifo_layers (id, item_id, warehouse_id, received_date, quantity_in, quantity_remaining, rate)
```

**Current state:** stock_ledger has rate per entry but no FIFO consumption logic.
Each stock_ledger entry records the rate at time of transaction.
For issue, the rate=0 (no rate captured on issue in manual movements).

**FIFO would require:**
1. A fifo_layers table tracking each receipt
2. On issue: find oldest layer first, consume it, record the FIFO rate

**This is a multi-sprint effort — not a quick fix.**

---

## STOCK VALUE CALCULATION CONSISTENCY

### Dashboard endpoint:
```sql
SELECT COALESCE(SUM((quantity_in - quantity_out) * rate), 0) as value
FROM stock_ledger
```
Uses per-entry rate × net qty.

### Valuation endpoint:
```sql
COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) * COALESCE(AVG(sl.rate), 0) as value
```
Uses balance × average rate.

**⚠️ INCONSISTENCY:** Two endpoints calculate inventory value differently.
Dashboard uses per-entry rate, valuation uses average rate. Values may differ.

---

## dual STOCK TRACKING ISSUE

**Evidence:**
- `inventory_items.current_stock` column exists (from core_schema)
- `stock_ledger` table also tracks quantity_in/quantity_out/balance_qty
- `cogsJournal.service.js:74` updates `inventory_items.current_stock` directly:
```javascript
UPDATE inventory_items SET current_stock = GREATEST(0, current_stock - $1)
```
- `stockLedger.repository.js:getStockSummary()` calculates from stock_ledger

**Impact:** current_stock in inventory_items can go out of sync with stock_ledger balance.
Standard cost report and valuation may give different numbers.

---

## VALUATION REPORTS AVAILABLE

| Report | Status | Export |
|--------|--------|--------|
| Stock Valuation (by item/warehouse) | ✅ GET /inventory/stock/valuation | ❌ No export |
| ABC Analysis | ✅ GET /inventory/abc-analysis/run | ❌ No export |
| Stock Aging | ✅ GET /inventory/advanced/stock-aging | ❌ No export |
| Slow Movers | ✅ GET /inventory/slow-movers | ❌ No export |
| FIFO Valuation Report | ❌ MISSING | — |
| Standard Cost Variance | ❌ MISSING | — |

---

## VALUATION AUDIT SCORE

| Category | Score | Notes |
|----------|-------|-------|
| Weighted Average | 4/5 | Implemented but inconsistent calculation |
| FIFO | 0/5 | Setting exists, backend ignores it |
| LIFO | 0/5 | Setting exists, backend ignores it |
| Standard Cost | 0/5 | Not implemented at all |
| Holding Cost | 4/5 | Implemented, env-configurable |
| Valuation Report | 3/5 | Available, no export, no FIFO |
| Consistency | 2/5 | Dashboard vs valuation endpoint differ |

**Overall: 13/35 = 37%**
