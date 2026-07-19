# LEAVE PARITY REPORT
## Comparison with Keka / Darwinbox / Zoho People / SAP SuccessFactors
**Audit Date:** 2026-06-12

---

## COMPARISON MATRIX

| Feature | Pulse ERP | Keka | Darwinbox | Zoho People | SAP SF |
|---------|-----------|------|-----------|-------------|--------|
| **Leave Types** | | | | | |
| Custom leave types | ✅ | ✅ | ✅ | ✅ | ✅ |
| Per-company leave types | ✅ | ✅ | ✅ | ✅ | ✅ |
| Statutory types (EL/PL/CL/SL) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Industrial leave types | ✅ (TL/EML/SL2/SDL/FDL) | ❌ | ❌ | ❌ | ✅ |
| Adoption/quarantine leave | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Accrual** | | | | | |
| Monthly accrual | ✅ | ✅ | ✅ | ✅ | ✅ |
| Pro-rata for joiners | ✅ | ✅ | ✅ | ✅ | ✅ |
| Accrual audit trail | ❌ | ✅ | ✅ | ✅ | ✅ |
| Joining-date accrual | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Carry Forward** | | | | | |
| CF with cap | ✅ | ✅ | ✅ | ✅ | ✅ |
| CF expiry | ✅ | ✅ | ✅ | ✅ | ✅ |
| Opening balance tracking | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Approval Workflow** | | | | | |
| Multi-level approval (3-level) | ✅ | ✅ | ✅ | ✅ | ✅ |
| L2 mandatory config | ❌ | ✅ | ✅ | ✅ | ✅ |
| Delegation | ✅ (backend only) | ✅ | ✅ | ✅ | ✅ |
| SLA escalation | ✅ (L1 only) | ✅ (all levels) | ✅ | ✅ | ✅ |
| Auto-approve on SLA breach | ❌ | ✅ (optional) | ✅ | ❌ | ✅ |
| **Policy** | | | | | |
| Sandwich rule | ✅ | ✅ | ✅ | ✅ | ✅ |
| Probation restriction | ✅ | ✅ | ✅ | ✅ | ✅ |
| Gender restriction | ✅ | ✅ | ✅ | ✅ | ✅ |
| Per-company policy overrides | ❌ (table exists, unused) | ✅ | ✅ | ✅ | ✅ |
| Department-level policy | ❌ | ✅ | ✅ | ✅ | ✅ |
| Minimum staffing enforcement | ❌ | ✅ | ✅ | ❌ | ✅ |
| **Holiday Calendar** | | | | | |
| Zone/region support | ✅ (backend, no UI) | ✅ | ✅ | ✅ | ✅ |
| National holiday pre-seeding | ❌ | ✅ | ✅ | ✅ | ✅ |
| iCal import/export | ❌ | ✅ | ✅ | ✅ | ✅ |
| Year copy | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Comp Off** | | | | | |
| Comp off with expiry | ✅ | ✅ | ✅ | ✅ | ✅ |
| Project-linked comp off | ✅ (no UI) | ❌ | ✅ | ❌ | ✅ |
| Work date validation | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Encashment** | | | | | |
| Leave encashment | ✅ | ✅ | ✅ | ✅ | ✅ |
| Slab-based TDS | ❌ | ✅ | ✅ | ✅ | ✅ |
| Encashment on separation | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Attendance Integration** | | | | | |
| Auto attendance on approval | ✅ | ✅ | ✅ | ✅ | ✅ |
| Safe reversal on cancel | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Payroll Integration** | | | | | |
| LOP auto-deduction | ❌ (indirect) | ✅ | ✅ | ✅ | ✅ |
| Encashment payroll posting | ✅ (with run_id) | ✅ | ✅ | ✅ | ✅ |
| **Reports** | | | | | |
| CSV export | ✅ | ✅ | ✅ | ✅ | ✅ |
| Excel export | ❌ | ✅ | ✅ | ✅ | ✅ |
| PDF export | ❌ | ✅ | ✅ | ✅ | ✅ |
| Factories Act Form A | ❌ | ✅ | ✅ | ✅ | ✅ |
| Leave liability report | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Mobile** | | | | | |
| Apply leave (mobile) | ✅ (responsive) | ✅ App | ✅ App | ✅ App | ✅ App |
| Approve on mobile | ✅ (responsive) | ✅ App | ✅ App | ✅ App | ✅ App |
| Native mobile app | ❌ | ✅ | ✅ | ✅ | ✅ |

---

## PARITY GAPS SUMMARY

**Critical gaps vs competitors:**
1. opening_balance never written (all competitors maintain it)
2. leave_policies table unused (all competitors have per-company policy overrides)
3. LOP direct payroll posting missing
4. No Excel/PDF export (all competitors have this)
5. No national holiday pre-seeding
6. TDS hardcoded at flat 10% (all competitors use slab-based)
7. L2 mandatory not configurable
8. No native mobile app (web-only)

**Pulse advantages:**
1. Industrial leave types (TL/EML/SL2/SDL/FDL) — unique for manufacturing/HVDC
2. Project milestone conflict detection — not in most HR tools
3. Comp off project linking (backend)
4. WFH as leave type with attendance sync
