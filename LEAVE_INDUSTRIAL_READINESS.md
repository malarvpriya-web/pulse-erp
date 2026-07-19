# LEAVE INDUSTRIAL READINESS AUDIT
## Manufacturing / HVDC / Field Use
**Audit Date:** 2026-06-12  
**Context:** Manifest Technologies — HVDC, STATCOM, SST projects with field engineers

---

## 1. INDUSTRIAL LEAVE TYPES (Seeded)

| Code | Name | Use Case | Quota | Encashable |
|------|------|----------|-------|------------|
| TL | Travel Leave | Engineers travelling to customer sites/project locations | 6d | No |
| EML | Emergency Leave | Critical site emergencies, zero notice, negative balance allowed | 3d | No |
| SL2 | Site Leave | Engineers deployed at customer sites/commissioning | 12d, CF=6d | Yes (3d) |
| SDL | Shutdown Leave | Mandatory plant/factory shutdown — separate from personal quota | 5d | No |
| FDL | Field Duty Leave | HVDC/STATCOM/SST extended deployment | 10d, CF=5d | Yes (5d) |

All seeded in migration `20260609000001_leave_module_hardening.js`. ✅

---

## 2. FIELD ENGINEER SCENARIOS

### 2.1 Site Deployment → Leave Application
**Scenario:** Engineer on 3-month HVDC site deployment needs leave

**Verified flow:**
- Employee applies Site Leave (SL2) with 3-day advance notice ✅
- Manager approves L1 ✅
- HR approves L3 ✅
- Attendance auto-synced ✅
- SL2 is encashable — engineer can encash unused days ✅

### 2.2 Weekend/Holiday Overtime → Comp Off
**Scenario:** Engineer works Saturday during commissioning

**Verified flow:**
- Employee submits comp off via CompOffPage ✅
- Links to holiday_id (if weekend work was on a declared holiday) ✅
- Manager approves — credit added to Compensatory Leave balance ✅
- project_id can be linked in DB (no UI yet) ❌

**Gap:** No validation that work_date is actually a weekend/holiday ❌

### 2.3 Plant Shutdown
**Scenario:** Annual plant maintenance shutdown (5 days)

**Verified:**
- Shutdown Leave (SDL) type exists ✅
- annual_quota=5, no notice required, all employees (incl. probation) eligible ✅
- HR bulk allocates for all employees ✅
- Employees apply SDL — treated as paid, no personal quota deduction ✅

### 2.4 Emergency Leave on Site
**Scenario:** Engineer on remote site has family emergency

**Verified:**
- Emergency Leave (EML) — zero notice required ✅
- Negative balance allowed ✅
- Can apply from mobile (web app) ✅
- No push notification to manager (gap) ❌

---

## 3. HVDC/STATCOM SPECIFIC

### 3.1 Extended Deployment Tracking
**FDL (Field Duty Leave):** Designed for HVDC/STATCOM/SST engineers  
- 10d quota, CF=5d, encashable up to 5d
- Tracks time off from extended field deployment
- No automatic tracking of "time on deployment" — FDL is manually allocated by HR ❌
- No project-linked leave allocation (engineer on Project X gets extra FDL) ❌

### 3.2 Site-Based Zone Calendar
**Scenario:** Engineer at a site in another state needs local state holidays

**Status:**
- Zone support in DB ✅
- zone_id filter on GET /holidays ✅
- No UI to assign zone to employee ❌
- No auto-selection of holidays based on employee's current deployment location ❌

---

## 4. MANUFACTURING FLOOR USE

### 4.1 Shift Workers
**Requirement:** Leave for shift workers (morning/evening/night shifts)

**Status:**
- Half-day leave supported ✅
- Shift-aware leave (different start/end for night shift) ❌ Not implemented
- No integration with shift scheduling module ❌

### 4.2 LOP for Absenteeism
**Requirement:** Factory floor worker absent without notice → automatic LOP

**Status:**
- LOP leave type exists ✅
- Probation enforcement → forced LOP ✅
- Auto-LOP for unexpected absence: Depends on attendance module detecting absence → payroll deduction ⚠ Indirect

### 4.3 Safety Training Mandatory Leave
**Leave type:** Safety Training (SAFETY, 2d quota)
- Used for mandatory safety training days ✅
- No enforcement that employees must take this leave before deadline ❌
- No training schedule integration ❌

---

## 5. INDUSTRIAL READINESS SCORECARD

| Feature | Status | Score |
|---------|--------|-------|
| Travel Leave type | ✅ Seeded | 100% |
| Emergency Leave (zero notice) | ✅ | 100% |
| Site Leave (CF, encashable) | ✅ | 100% |
| Shutdown Leave (separate quota) | ✅ | 100% |
| Field Duty Leave (HVDC/STATCOM) | ✅ Seeded | 100% |
| Comp Off for weekend site work | ✅ | 85% |
| Weekend work date validation | ❌ | 0% |
| Project-linked comp off (UI) | ❌ | 20% |
| Zonal holiday for site location | ❌ No UI | 30% |
| Shift-aware leave | ❌ | 0% |
| Extended deployment tracking | ❌ | 0% |
| Safety training enforcement | ❌ | 20% |
| Mobile approval for field managers | ✅ (web PWA) | 70% |
| Emergency leave mobile apply | ✅ (web PWA) | 70% |

**INDUSTRIAL READINESS OVERALL: 64/100**

---

## 6. GAPS TO CLOSE FOR FULL INDUSTRIAL CERTIFICATION

| Gap | Priority | Effort |
|-----|----------|--------|
| Add weekend/holiday validation on comp off submit | HIGH | Small |
| Expose project_id in comp off submit UI | HIGH | Small |
| Zone selector in holiday add modal (site-based holidays) | HIGH | Small |
| Auto-zone assignment based on employee deployment | MEDIUM | Medium |
| Shift-aware leave duration calculation | MEDIUM | Large |
| Deployment tracking → auto FDL allocation | MEDIUM | Large |
| Safety training deadline enforcement | LOW | Medium |
