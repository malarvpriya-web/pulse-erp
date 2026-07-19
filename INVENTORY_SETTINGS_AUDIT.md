# INVENTORY SETTINGS AUDIT
## Step 20 — Settings Load, Save, Persist, Completeness
### Audited: 2026-06-13

---

## SETTINGS PAGE ANALYSIS

**File:** `frontend/src/features/inventory/pages/InventorySettings.jsx`
**Component:** Uses `ModuleSettingsPanel` component
**API:** GET/POST/PATCH `/settings/inventory`

---

## SETTINGS SECTIONS AVAILABLE

### Section 1: Reorder Rules
| Setting | Key | Type | Default | Status |
|---------|-----|------|---------|--------|
| Default Reorder Point (days of stock) | default_reorder_days | number | 7 | ✅ |
| Auto-Generate Purchase Request | auto_generate_pr | toggle | false | ✅ |

### Section 2: Valuation
| Setting | Key | Type | Options | Status |
|---------|-----|------|---------|--------|
| Inventory Valuation Method | valuation_method | select | FIFO, LIFO, Weighted Average | ⚠️ UI only — backend ignores |

### Section 3: Warehouses
| Setting | Key | Type | Status |
|---------|-----|------|--------|
| Default Warehouse | default_warehouse | select (from /master/warehouses) | ⚠️ Wrong API endpoint |
| Allow Negative Stock | negative_stock_allowed | toggle | ✅ |

### Section 4: Alerts
| Setting | Key | Type | Status |
|---------|-----|------|--------|
| Low Stock Alert Threshold (%) | low_stock_threshold_pct | number | ✅ |
| Critical Stock Threshold (%) | critical_stock_threshold_pct | number | ✅ |

---

## SETTINGS BUGS

### BUG #1 — Wrong Warehouse API Endpoint
**File:** InventorySettings.jsx:93
```javascript
api.get('/master/warehouses')   // ← WRONG endpoint
// Should be:
api.get('/inventory/warehouses') // ← correct
```
**Impact:** Default Warehouse dropdown is always empty (unless /master/warehouses exists)

### BUG #2 — valuation_method setting is IGNORED by backend
**Evidence:**
- Setting saved to company_settings via /settings/inventory ✅
- GET /inventory/stock/valuation uses `AVG(rate)` regardless of setting ❌
- No code reads `valuation_method` from company_settings in the valuation endpoint

### BUG #3 — auto_generate_pr setting is IGNORED by backend
**Evidence:**
- Setting saved to company_settings ✅
- GET /inventory/reorder-alerts returns `auto_create_po: false` hardcoded ❌
- No route reads `auto_generate_pr` from company_settings

---

## MISSING SETTINGS

| Required Setting | Key | Status |
|----------------|-----|--------|
| Item Number Series | item_number_prefix / sequence | ❌ MISSING |
| Default Warehouse | default_warehouse | ⚠️ Wrong API |
| Negative Stock Policy | negative_stock_allowed | ✅ Present |
| Reservation Rules | reservation_mode | ❌ MISSING |
| Consumption Rules | consumption_method | ❌ MISSING |
| Auto Batch Number | auto_batch_numbering | ❌ MISSING |
| Auto Serial Number | auto_serial_numbering | ❌ MISSING |
| Bin Management Toggle | bin_management_enabled | ❌ MISSING |
| Transfer Approval Required | transfer_approval_required | ❌ MISSING |
| Incoming Inspection Default | incoming_inspection_required | ❌ MISSING |
| Stock Hold Rules | quality_hold_enabled | ❌ MISSING |
| ABC Thresholds (A/B cutoff %) | abc_a_threshold, abc_b_threshold | ❌ MISSING |
| Slow Mover Threshold (days) | slow_mover_days | ❌ MISSING |
| Holding Cost Rate | holding_cost_rate | ❌ MISSING (env var only) |

---

## SETTINGS THAT SAVE + LOAD CORRECTLY

| Setting | Saves | Loads | Persists | Verdict |
|---------|-------|-------|---------|---------|
| default_reorder_days | ✅ | ✅ | ✅ | PASS |
| auto_generate_pr | ✅ (saves) | ✅ (loads) | ✅ | PASS (backend ignores) |
| valuation_method | ✅ (saves) | ✅ (loads) | ✅ | PASS (backend ignores) |
| default_warehouse | ✅ (saves) | ⚠️ (wrong API) | ✅ | FAIL — dropdown empty |
| negative_stock_allowed | ✅ | ✅ | ✅ | PASS (not enforced) |
| low_stock_threshold_pct | ✅ | ✅ | ✅ | PASS |
| critical_stock_threshold_pct | ✅ | ✅ | ✅ | PASS |

**Settings that save/load: 7/7 (UI works)**
**Settings actually enforced by backend: 0/7**

---

## SETTINGS COMPLETENESS VS STANDARD

| Category | Standard Requirements | Present | Missing |
|----------|----------------------|---------|---------|
| General | Item Number Series, Default Warehouse | Default Warehouse (broken) | Item Number Series |
| Stock Rules | Negative Stock, Reservation Rules, Consumption Rules | Negative Stock only | 2 |
| Batch & Serial | Auto Batch, Auto Serial | ❌ NONE | Both |
| Warehouse | Bin Management, Transfer Rules | ❌ NONE | Both |
| Quality | Incoming Inspection, Stock Hold | ❌ NONE | Both |
| Reports | Valuation Method, ABC Thresholds | Valuation (not enforced) | ABC Thresholds |

**Settings Completeness: 1/12 actually enforced = 8%**

---

## SETTINGS AUDIT SCORE

| Category | Score | Notes |
|----------|-------|-------|
| Settings UI loads | 4/5 | warehouse dropdown broken |
| Settings save | 5/5 | All 7 settings save |
| Settings enforced | 0/5 | NONE of the settings affect backend behavior |
| Completeness | 2/10 | Most required settings missing |

**Overall: 11/25 = 44%**
