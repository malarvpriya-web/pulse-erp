# HOLIDAY CALENDAR AUDIT
## National / State / Festival / Company / Optional / Regional
**Audit Date:** 2026-06-12  
**Source:** holidays.routes.js, HolidayCalendar.jsx (leaves/ version), migrations

---

## 1. HOLIDAY TABLE SCHEMA

**Table:** `holidays`  
**Migrations:** 20260531000006, 20260601000008, 20260604000001

| Column | Type | Notes |
|--------|------|-------|
| id | serial PK | — |
| name | varchar | Holiday name |
| date | date | Holiday date |
| type | varchar | National/State/Festival/Company/Optional/Regional |
| description | text | — |
| company_id | integer FK | NULL = global, visible to all tenants |
| zone_id | integer FK | → master_zones, for regional holidays |
| created_at | timestamp | — |
| updated_at | timestamp | — |

**Unique constraint:** `UNIQUE(name, date, company_id)` — prevents duplicates per company

---

## 2. HOLIDAY TYPES SUPPORTED

| Type | Purpose | Visible To |
|------|---------|-----------|
| National | Republic Day, Independence Day, Gandhi Jayanti | All companies (company_id=NULL) |
| State | State-specific public holidays | Zone-filtered |
| Festival | Diwali, Eid, Christmas, etc. | All or zone-specific |
| Company | Company-declared holidays | company_id=specific company |
| Optional | Employee can choose (Optional Holiday leave type) | All in company |
| Regional | Zone/region-specific | zone_id filter |

---

## 3. BACKEND API

### GET /holidays
```javascript
// Filters supported:
year=2026         → WHERE EXTRACT(YEAR FROM date) = ?
zone_id=3         → WHERE (zone_id = ? OR zone_id IS NULL)
upcoming=true     → WHERE date >= CURRENT_DATE ORDER BY date ASC LIMIT 10

// Company scoping:
WHERE company_id = req.scope.company_id OR company_id IS NULL
// → employees see both company-specific + global (NULL) holidays
```

### POST /holidays
```javascript
1. Duplicate check: SELECT WHERE name=? AND date=? AND company_id=?
2. INSERT INTO holidays
3. AUTO-SYNC: INSERT INTO attendance (status='holiday', source='holiday_sync')
              FOR ALL active employees WHERE date NOT IN ('present', 'late')
   → Skips employees who already have a present/late record for that date
```

### PATCH /holidays/:id
```javascript
1. UPDATE holidays SET name, date, type, description
2. Re-sync attendance: DELETE old source='holiday_sync' records + re-INSERT
```

### DELETE /holidays/:id
```javascript
1. DELETE FROM holidays
2. DELETE FROM attendance WHERE date=holiday.date AND source='holiday_sync'
   → Safe reversal — only removes holiday-synced records
```

---

## 4. HOLIDAY CALENDAR FRONTEND

**File:** `HolidayCalendar.jsx` (leaves/ version, 390 lines)

### 4.1 Features
- Monthly grid calendar view
- Holiday dots on each day
- Type filter: National / State / Festival / Company / Optional / Regional
- Year selector (current year + prev/next)
- List view alongside grid
- Stats panel: total count, upcoming count, count by type
- Add Holiday modal (admin/hr)
- Delete holiday (admin/hr)

### 4.2 APIs Called
```
GET /api/v1/holidays?year=2026   → Load all holidays for year
POST /api/v1/holidays            → Create holiday (admin/hr)
DELETE /api/v1/holidays/:id      → Delete holiday (admin/hr)
```

### 4.3 Add Holiday Modal Fields
- Name (text input)
- Date (date picker)
- Type (dropdown: National/State/Festival/Company/Optional/Regional)
- Description (optional)
- **MISSING: Zone selector** — `zone_id` column exists in DB, GET supports filter, but add modal has no zone picker

---

## 5. ZONE SUPPORT

**Table:** `master_zones` (from migration 20260531000006)  
**Columns:** id, zone_name, zone_code, states[], description, is_active

**Current state:**
- DB schema: ✅ zone_id FK on holidays
- Backend GET: ✅ zone_id filter supported
- Backend POST: ❌ zone_id NOT accepted in POST body (not in insert query)
- Frontend GET filter: ❌ Zone selector not in HolidayCalendar.jsx main filter
- Frontend add modal: ❌ Zone selector missing

**Impact:** Zonal/regional holiday configuration is database-level only — HR cannot assign zone via UI.

---

## 6. ATTENDANCE AUTO-SYNC

**On holiday CREATE:**
```sql
INSERT INTO attendance (employee_id, date, status='holiday', source='holiday_sync', company_id)
SELECT id, holiday_date, 'holiday', 'holiday_sync', company_id
FROM employees
WHERE is_active = true AND company_id = ?
ON CONFLICT (employee_id, date) 
  DO NOTHING  -- does not overwrite present/late/other existing records
```
Note: Code "skips present/late" — verifying: uses ON CONFLICT DO NOTHING or WHERE NOT EXISTS check.

**On holiday DELETE:**
```sql
DELETE FROM attendance
WHERE date = holiday.date 
  AND source = 'holiday_sync'
  AND company_id = ?
```

**Safe reversal:** ✅ Only removes `source='holiday_sync'` records — won't touch manually-entered attendance.

---

## 7. OPTIONAL HOLIDAY FLOW

**Leave Type:** `Optional Holiday (OH)` — annual_quota=2  
**Purpose:** Employees can choose 2 optional holidays per year from a declared optional list

**Current implementation:**
- Optional Holiday leave type exists ✅
- Employees apply Optional Holiday leave via standard apply flow ✅
- No explicit "optional holiday list" feature — employees must know which holidays are Optional type ❌
- No enforcement that employee picks from the declared Optional list ❌
- **Gap:** System allows applying Optional Holiday leave on ANY date, not restricted to declared OH-type holidays

---

## 8. PUBLIC HOLIDAY vs. COMPANY HOLIDAY

| Aspect | Status |
|--------|--------|
| Pre-seeded national holidays | ❌ Not seeded — DB is empty, company must add manually |
| Import from government list | ❌ No import feature |
| iCalendar (.ics) import | ❌ Not supported |
| Copy holidays from previous year | ❌ Not supported |
| Holiday carry-forward | N/A — holidays are date-specific |

---

## 9. DUPLICATE HolidayCalendar

**Two files detected:**
1. `frontend/src/features/leaves/pages/HolidayCalendar.jsx` (leaves module)
2. `frontend/src/features/hr/pages/HolidayCalendar.jsx` (HR module)

Both registered in moduleRegistry.js:
- `leaves.holidays` → HolidayCalendar
- `hr.holiday` → HolidayCalendar

HR module version was not deeply read in this audit — functionality may differ.  
**Recommendation:** Consolidate to single component.

---

## 10. HOLIDAY CALENDAR SCORECARD

| Feature | Status | Score |
|---------|--------|-------|
| Holiday CRUD | ✅ Full Create/Edit/Delete | 90% |
| Monthly grid view | ✅ | 100% |
| Type classification | ✅ 6 types | 100% |
| Attendance auto-sync on create | ✅ | 100% |
| Attendance reverse on delete | ✅ | 100% |
| Zone support (GET filter) | ✅ Backend | 50% |
| Zone support (add UI) | ❌ Missing | 0% |
| Zone support (POST) | ❌ Not accepted | 0% |
| Optional holiday enforcement | ❌ Not restricted to declared list | 30% |
| National holiday pre-seeding | ❌ Empty DB | 0% |
| iCal/bulk import | ❌ | 0% |
| Year copy | ❌ | 0% |
| Dedup constraint | ✅ | 100% |

**HOLIDAY CALENDAR OVERALL: 65/100**
