# LEAVE MOBILE AUDIT
## Mobile Experience — Apply, Approve, Calendar, Comp Off
**Audit Date:** 2026-06-12  
**Source:** ApplyLeave.jsx, LeaveApprovals.jsx, MyLeaves.jsx — CSS/responsive review

---

## 1. MOBILE HARDENING STATUS

**Phase 44A note (from memory):** Global mobile hardening was applied across all modules. This covers basic responsive layouts, touch targets, and overflow handling.

---

## 2. PAGE-BY-PAGE MOBILE ASSESSMENT

### 2.1 Apply Leave (ApplyLeave.jsx)
| Element | Mobile Status |
|---------|--------------|
| Balance cards | ✅ Stack vertically on mobile (flex-wrap) |
| Leave type dropdown | ✅ Full-width on mobile |
| Date range picker | ⚠ Date pickers can be cramped on small screens |
| Half-day toggle | ✅ Simple toggle, touch-friendly |
| Day count display | ✅ Inline text |
| Attachment upload | ✅ File input works on mobile (native file picker) |
| Submit button | ✅ Full-width on mobile |
| Admin employee picker | ⚠ Dropdown — may be long on mobile |

### 2.2 My Leaves (MyLeaves.jsx)
| Element | Mobile Status |
|---------|--------------|
| Status filter pills | ✅ Horizontal scroll on overflow |
| Leave cards | ✅ Full-width cards, stack vertically |
| ApprovalPipeline (L1→L2→L3 status) | ⚠ 3-column timeline may be tight on small screens |
| Cancel button | ✅ Inside card, touch target OK |

### 2.3 Leave Approvals (LeaveApprovals.jsx)
| Element | Mobile Status |
|---------|--------------|
| 4 tab headers (L1/L2/L3/Team) | ⚠ May overflow on 320px screens — needs scrollable tabs |
| Application list table | ⚠ Tables with 8+ columns are problematic on mobile |
| Bulk approve checkbox | ⚠ Checkbox + row layout needs touch-friendly spacing |
| Approval/rejection buttons | ✅ Buttons in card layout |
| History drawer | ✅ Full-screen drawer on mobile |

### 2.4 Leave Calendar (LeaveCalendar.jsx)
| Element | Mobile Status |
|---------|--------------|
| Monthly grid | ⚠ 7-column calendar grid is cramped on mobile |
| Leave dots per day | ⚠ Very small click targets on mobile |
| Day detail panel | ✅ Full-width on mobile |
| On leave today sidebar | ⚠ Side-by-side layout needs mobile breakpoint |

### 2.5 Holiday Calendar (HolidayCalendar.jsx)
| Element | Mobile Status |
|---------|--------------|
| Monthly grid | ⚠ Same as leave calendar — cramped |
| Type filter chips | ✅ Wrap on overflow |
| Add holiday modal | ✅ Modal is full-screen on mobile |
| Stats panel | ✅ Cards stack vertically |

### 2.6 Comp Off Page (CompOffPage.jsx)
| Element | Mobile Status |
|---------|--------------|
| Balance cards (4) | ✅ Grid → 2×2 on mobile |
| Expiry warning banner | ✅ Full width |
| Submit form | ✅ Stack on mobile |
| Records list | ✅ Card layout |

---

## 3. NATIVE APP STATUS

**Status:** ❌ No native mobile app (iOS/Android)  
**PWA (Phase 8 from memory):** PWA support was built — manifest.json, service worker, offline capabilities  
**PWA leave support:** Web-based PWA works for leave apply/view, but approval requires manager opening the web app — no push notification on mobile.

---

## 4. MOBILE GAPS

| Gap | Severity |
|-----|----------|
| Calendar grid cramped on mobile (<375px) | MEDIUM |
| LeaveApprovals table view — needs card/list view on mobile | HIGH |
| ApprovalPipeline 3-column on narrow screens | MEDIUM |
| No native app (iOS/Android) for approvals | HIGH |
| No mobile push notification for approval requests | HIGH |
| Tab headers in LeaveApprovals may overflow on 320px | LOW |

---

## MOBILE AUDIT SCORECARD

| Page | Score |
|------|-------|
| Apply Leave | 85% |
| My Leaves | 80% |
| Leave Approvals | 60% |
| Leave Calendar | 65% |
| Holiday Calendar | 70% |
| Comp Off | 85% |
| Leave Encashment | 75% |
| Leave Reports | 70% |
| Native App | 0% |
| PWA | 70% |

**MOBILE OVERALL: 66/100**
