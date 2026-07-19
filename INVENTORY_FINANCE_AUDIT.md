# INVENTORY ↔ FINANCE INTEGRATION AUDIT
## Step 15 — Inventory → GL, Inventory → Costing, Inventory → Valuation
### Audited: 2026-06-13

---

## COGS JOURNAL ON INVOICE DISPATCH (VERIFIED)

**File:** `backend/src/modules/finance/services/cogsJournal.service.js`

```
Invoice creation / dispatch →
  cogsJournalService.createForInvoice() →
    Filter items with item_id + unit_cost > 0
    total_cogs = SUM(unit_cost × quantity)
    
    Journal Entry:
      DR 5001 Cost of Goods Sold — Raw Material  (expense) ✅
      CR 1032 Finished Goods Inventory           (asset)   ✅
    
    ALSO:
      UPDATE inventory_items SET current_stock = GREATEST(0, current_stock - qty) ✅
      INSERT stock_ledger (transaction_type=?, reference_type='invoice') ✅
```
**Status: ✅ LIVE — COGS journal fires on invoice dispatch**

---

## GL ACCOUNT MAPPING

### inventory_items GL columns:
- `inventory_account_id` → maps to chart_of_accounts (asset account e.g. 1032)
- `expense_account_id` → maps to chart_of_accounts (expense account e.g. 5001)

**Finding:** These columns exist in the DB but are NOT editable in the ItemMaster form.
The COGS journal uses hardcoded account codes ('5001', '1032') — NOT the item's account IDs.

```javascript
// cogsJournal.service.js:52, 63
account_code: '5001',   // HARDCODED
account_code: '1032',   // HARDCODED
```

**Impact:** Multi-product GL mapping (different items → different GL accounts) is NOT implemented.
All COGS goes to 5001 and all FG inventory credits to 1032 regardless of item type.

---

## GRN → GL JOURNAL

**Status: ❌ MISSING**

Expected: On GRN, create journal entry:
```
DR 1031 Raw Material Inventory (asset)
CR 2001 Accounts Payable (liability)
```
**Current state:** GRN creates stock_ledger entry but NO journal entry in the accounting module.
The inventory increase is NOT recorded in the GL until invoice/bill is posted.

**Impact:** Inventory asset account is understated until purchase bill is posted.
Timing gap between physical receipt and GL recognition.

---

## STOCK ADJUSTMENT → GL

**Status: ❌ MISSING**
Stock adjustments (increases/decreases) update stock_ledger but do NOT create GL journal entries.

Expected on adjustment:
```
Increase: DR 1031 Inventory   CR 5099 Inventory Adjustment Gain
Decrease: DR 5099 Adjustment  CR 1031 Inventory
```

---

## TRANSFER → GL

**Status: ❌ MISSING**
Inter-warehouse transfers update stock_ledger but do NOT create GL entries.
(Internal transfers typically don't need GL entries if same company, but multi-entity needs them.)

---

## DUAL STOCK TRACKING ISSUE (VERIFIED)

**Evidence in cogsJournal.service.js:71-80:**
```javascript
UPDATE inventory_items
SET current_stock = GREATEST(0, current_stock - $1)
WHERE id = $2
```

AND separately, stockLedger entries track the same quantity.

**Two systems tracking stock:**
1. `inventory_items.current_stock` — updated by COGS journal (invoice dispatch)
2. `stock_ledger.balance_qty` — updated by all stock movements

**These can go out of sync:**
- GRN adds to stock_ledger but NOT to inventory_items.current_stock
- Invoice dispatch subtracts from inventory_items.current_stock AND creates stock_ledger entry
- Cycle count adjusts stock_ledger but NOT inventory_items.current_stock

---

## FINANCE INTEGRATION SCORE

| GL Posting | Score | Notes |
|------------|-------|-------|
| COGS on Invoice (DR COGS / CR FG Inv) | 4/5 | Works but hardcoded accounts |
| GRN → GL (DR Inv / CR AP) | 0/5 | Not implemented |
| Stock Adjustment → GL | 0/5 | Not implemented |
| Transfer → GL | 0/5 | Not applicable for same entity |
| Item-level GL account mapping | 1/5 | Columns exist, not used in COGS |
| Inventory valuation in balance sheet | 2/5 | Only via manual FG/RM accounts |
| Stock value consistency | 2/5 | Dual tracking causes desync |
| Standard cost variance | 0/5 | Not implemented |

**Overall: 9/40 = 23% — CRITICAL FINANCE INTEGRATION GAPS**
