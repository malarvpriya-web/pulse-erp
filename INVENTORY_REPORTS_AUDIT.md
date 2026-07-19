# INVENTORY REPORTS AUDIT
## Step 17 — Stock Ledger, Batch, Serial, Movement, Valuation, ABC, Slow Moving, Dead Stock, Exports
### Audited: 2026-06-13

---

## REPORTS MATRIX

| Report | Route | Page | Export (CSV) | Export (Excel) | Export (PDF) | Status |
|--------|-------|------|-------------|---------------|-------------|--------|
| Stock Ledger | GET /inventory/stock/movement | StockMovements | ❌ | ❌ | ❌ | ⚠️ LIST ONLY |
| Stock Summary | GET /inventory/stock/summary | StockSummary | ✅ | ✅ | ❌ | ✅ LIVE |
| Inventory Valuation | GET /inventory/stock/valuation | — | ❌ | ❌ | ❌ | ⚠️ API only |
| ABC Analysis | POST /inventory/abc-analysis/run | InventoryIntelligence | ❌ | ❌ | ❌ | ✅ LIVE |
| Slow Movers | GET /inventory/slow-movers | InventoryIntelligence | ❌ | ❌ | ❌ | ✅ LIVE |
| Stock Aging | GET /inventory/advanced/stock-aging | AdvancedDashboard | ❌ | ❌ | ❌ | ✅ LIVE |
| Material Consumption | GET /inventory/advanced/material-consumption | MaterialConsumption | ❌ | ❌ | ❌ | ✅ LIVE |
| Batch Report | GET /inventory/advanced/batches | BatchTracking | ❌ | ❌ | ❌ | ⚠️ LIST ONLY |
| Serial Report | — | — | — | — | — | ❌ MISSING |
| Warehouse Utilization | Computed in StoresDashboard | StoresDashboard | ❌ | ❌ | ❌ | ⚠️ SCREEN ONLY |
| Inventory Report Page | GET /inventory/stock/summary | InventoryReport | ❌ | ❌ | ❌ | ⚠️ STUB |
| Reorder Report | GET /inventory/reorder-alerts | InventoryIntelligence | ❌ | ❌ | ❌ | ✅ LIVE |
| Low Stock Report | GET /inventory/stock/low-stock | InventoryDashboard | ❌ | ❌ | ❌ | ⚠️ DASHBOARD ONLY |
| Dead Stock | ❌ MISSING | — | — | — | — | ❌ MISSING |
| Price History | GET /procurement/price-history | PriceHistory | — | — | — | ⚠️ PROCUREMENT PAGE |
| Landed Cost Report | GET /inventory/landed-costs | InventoryIntelligence | ❌ | ❌ | ❌ | ✅ LIVE |

---

## REPORT DETAIL ANALYSIS

### Stock Summary Report (StockSummary.jsx)
**Route:** GET /inventory/stock/summary
**Features:**
- KPIs: Total SKUs, Total Value, Low Stock Count, Out of Stock Count ✅
- Table with all items, balance, avg_rate, value ✅
- Filters: warehouse, item type, search ✅
- Sort columns ✅
- Export CSV/Excel ✅ (client-side generation)
**Status: ✅ BEST REPORT IN MODULE**

### ABC Analysis (InventoryIntelligence.jsx)
**Route:** POST /inventory/abc-analysis/run → caches in abc_analysis_cache
**Features:**
- SQL CTE with 12-month consumption value ✅
- Cumulative % classification (A≤70%, B≤90%, C>90%) ✅
- Pie chart + category stats ✅
- "Run ABC" button to refresh ✅
**Missing:** Export, date range selection, per-warehouse ABC

### Slow Movers Report (InventoryIntelligence.jsx)
**Route:** GET /inventory/slow-movers
**SQL:**
```sql
WHERE last movement > 90 days ago AND current_stock > 0
ORDER BY stock_value DESC
```
**Missing:** Configurable 90-day threshold, export

### Dead Stock Report
**Status: ❌ MISSING**
Dead stock = items with NO movement ever, AND current_stock > 0.
Query needed:
```sql
SELECT ii.* FROM inventory_items ii
WHERE NOT EXISTS (SELECT 1 FROM stock_ledger sl WHERE sl.item_id = ii.id)
AND ii.current_stock > 0
```

### Stock Ledger Report
**Status: ⚠️ LIST ONLY — No dedicated report page**
The StockMovements page shows movement list but:
- No item-level ledger view (all transactions for one item)
- No date range filter on the page
- No opening balance shown
- No closing balance shown
- No export

### Batch Report
**Status: ⚠️ LIST ONLY**
BatchTracking page shows batch list but:
- No batch consumption history
- No batch cost summary
- No expiry report with export

---

## EXPORT CAPABILITY AUDIT

| Export Type | Available In | Notes |
|------------|-------------|-------|
| CSV | StockSummary.jsx | Client-side only |
| Excel | StockSummary.jsx | Client-side only |
| PDF | ❌ NONE | No PDF generation anywhere |
| Batch export | ❌ NONE | — |
| Serial export | ❌ NONE | No serial module |
| Valuation export | ❌ NONE | API-only, no UI export |
| Stock Ledger export | ❌ NONE | No export |

---

## MISSING REPORTS

| Report | Priority | Why Needed |
|--------|----------|-----------|
| Stock Ledger (per item, date range, opening/closing) | P0 | Audit requirement |
| Dead Stock | P1 | Working capital optimization |
| Batch Traceability Report | P0 | Customer QC requirement |
| Serial Number Report | P0 | Asset tracking |
| Valuation with Export | P1 | Finance reporting |
| Inventory Turnover | P1 | Management KPI |
| Reorder Suggestion Report | P1 | Procurement planning |
| Warehouse-wise Value Report | P1 | Store manager requirement |
| Item-wise Transaction History | P0 | Auditor requirement |
| GRN vs Invoice matching | P1 | Finance requirement |

---

## REPORTS AUDIT SCORE

| Report | Score | Notes |
|--------|-------|-------|
| Stock Ledger | 2/5 | List exists, no proper ledger report |
| Stock Summary | 5/5 | Complete with filters and export |
| Valuation Report | 2/5 | API works, no UI/export |
| Batch Report | 2/5 | List only |
| Serial Report | 0/5 | MISSING |
| Movement Report | 2/5 | List only, no filters |
| ABC Analysis | 4/5 | Works, no export |
| Slow Moving | 3/5 | Works, no export |
| Dead Stock | 0/5 | MISSING |
| Warehouse Report | 3/5 | StoresDashboard, no export |
| CSV Export | 3/5 | Only in StockSummary |
| Excel Export | 3/5 | Only in StockSummary |
| PDF Export | 0/5 | Not anywhere |

**Overall: 29/65 = 45%**
