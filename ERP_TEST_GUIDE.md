# Pulse ERP — Complete Tester's Walkthrough
**Company:** Manifest Technologies Pvt Ltd, Chennai
**Seed Date:** April 2026
**All passwords:** `Manifest@123`

---

## Login Credentials Quick Reference

| Role | Email | What You Can Test |
|------|-------|-------------------|
| Super Admin | admin@manifest.in | Everything |
| HR Manager | hr@manifest.in | Employees, Leaves, Payroll, Attendance, Announcements |
| Finance | accounts@manifest.in | Invoices, Bills, Journal, Payroll payments |
| Manager | manager@manifest.in | Projects, Tasks, Timesheets, Performance |
| Employee (Dev) | dev1@manifest.in | My Payslip, My Leave, My Timesheet, My Goals |
| Sales | sales@manifest.in | CRM, Leads, Opportunities |

---

## MODULE: Employees

**Login as:** hr@manifest.in
**Navigate to:** HR → Employees

### Test 1: Employee List
- **Expected:** 50 employees listed in a table/grid
- **Check:** Filter by Department → "Engineering" → should show 18 employees
- **Check:** Status filter → "Active" = 45, "On Leave" = 3, "Inactive" = 2

### Test 2: Employee Profile
- Click on **EMP001 — Arjun Mehta** (CEO)
- **Expected:** Full profile card with: department = Management, designation = CEO & Founder, joining date = 15 Jan 2019, basic salary = ₹1,20,000
- **Check:** PAN number visible, IFSC code = SBIN0001001

### Test 3: Employee Search
- Search by name "Priya" → should return 2 results (Priya Nair EMP030, Priya Ramasamy EMP020)
- Search by department "QA" → should return 4 employees (EMP047–EMP050)

### Test 4: Department Distribution
- Navigate to Org Chart or department summary
- **Expected breakdown:** Engineering 18 | Sales 8 | Operations 5 | HR 4 | Finance 4 | Marketing 4 | QA 4 | Management 3

### Test 5: Employee Salary Range
- Sort by basic_salary descending
- **Top earner:** Arjun Mehta (EMP001) — ₹1,20,000/month
- **Lowest salary:** Manikandan P (EMP041) — ₹28,000/month

---

## MODULE: Attendance

**Login as:** hr@manifest.in
**Navigate to:** HR → Attendance

### Test 1: Daily Attendance View
- Select today's date (Apr 5, 2026)
- **Expected:** Records for ~40+ active employees showing Present/Absent/Late
- Check-in times should be between 08:45 and 10:30 AM

### Test 2: Attendance Summary (Last 30 Days)
- Select "Arun Krishnan" (EMP005) → view 30-day history
- **Expected:** ~21-22 Present, 1-2 Late, 1-2 Absent out of ~22 working days
- Work hours: 8-12 hours per day when present

### Test 3: Late Arrivals
- Filter by status = "Late"
- **Expected:** Multiple records with check-in time after 09:30
- These employees should show reduced working hours on those days

### Test 4: Absent Employees
- Filter by date = any weekday in March 2026, status = "Absent"
- **Expected:** ~2-3 employees absent per day (5% absence rate)

### Test 5: Attendance Statistics
- View attendance dashboard/stats
- **Expected:** ~90% present rate, ~5% late, ~5% absent across all employees

---

## MODULE: Leaves

**Login as:** hr@manifest.in
**Navigate to:** HR → Leaves

### Test 1: Leave Requests List
- **Expected:** 15 leave requests total
  - 10 Approved
  - 3 Pending
  - 2 Rejected

### Test 2: Pending Approvals
- Filter by status = "Pending"
- **Expected:** 3 requests:
  1. Sathish Kumar (EMP019) — 5 days Annual Leave, Apr 3–7 (family travel)
  2. Divya Krishnan (EMP024) — 1 day Casual Leave, Apr 7 (bank work)
  3. Radhika Venkat (EMP033) — 2 days Sick Leave, Apr 10–11 (headache)

### Test 3: Approve a Leave
- Click "Approve" on Divya Krishnan's leave request
- **Expected:** Status changes to "Approved", toast notification appears
- Check leave balance: Casual remaining should decrease by 1

### Test 4: Leave Balance
- View leave balance for EMP005 (Arun Krishnan)
- **Expected:** Annual = 12 total, Sick = 6, Casual = 6
- After seeding, used = 0 (balances start at 0 used, ready for the year)

### Test 5: Leave Types
- Check that all 3 leave types exist: Annual Leave, Sick Leave, Casual Leave
- Rejected requests show rejection reason field

---

## MODULE: Payroll

**Login as:** hr@manifest.in
**Navigate to:** HR → Payroll

### Test 1: Payroll Runs List
- **Expected:** 2 payroll runs:
  1. **February 2026** — Status: Completed (45 paid, 5 pending)
  2. **January 2026** — Status: Paid (all 50 employees)

### Test 2: February 2026 Payroll Details
- Click on February 2026 payroll
- **Expected:** 50 employees listed with gross/net amounts
- **Verify totals:**
  - Total employees: 50
  - Gross payroll ≈ ₹32–35 Lakhs
  - Net payroll ≈ ₹28–30 Lakhs (after PF, ESI, PT, TDS deductions)

### Test 3: Individual Payslip
- Click the eye icon on **Arjun Mehta** (EMP001 — CEO, ₹1,20,000 basic)
- **Expected payslip breakdown:**
  - Basic: ₹1,20,000
  - HRA (40%): ₹48,000
  - Conveyance: ₹1,600
  - Medical: ₹1,250
  - Gross: ₹1,70,850 (approx)
  - PF (12% of ₹15,000 cap): ₹1,800
  - TDS (10% of basic): ₹12,000
  - Net Pay: ≈ ₹1,55,000+

### Test 4: Junior Employee Payslip
- Click payslip for **Manikandan P** (EMP041, ₹28,000 basic)
- **Expected:**
  - Basic: ₹28,000
  - HRA (40%): ₹11,200
  - Gross ≈ ₹42,050
  - ESI (0.75%, since gross < ₹21,000): Check — actually gross > ₹21,000, so ESI = 0
  - PF = ₹3,360 (12% of ₹28,000)
  - PT = ₹200 (gross > ₹10,000)

### Test 5: Mark Pending as Paid (Feb 2026)
- Find the 5 pending employees in February 2026
- Click "Mark as Paid" on one of them
- **Expected:** Status changes to "paid", count of pending decreases to 4

---

## MODULE: Finance — Invoices

**Login as:** accounts@manifest.in
**Navigate to:** Finance → Invoices

### Test 1: Invoice List
- **Expected:** 24 invoices total (INV-2025-001 to INV-2025-024)
- Status breakdown: 15 Paid | 5 Partially Paid | 4 Overdue

### Test 2: Overdue Invoices
- Filter by status = "Overdue"
- **Expected:** 4 invoices:
  1. INV-2025-021 — TechSolutions India — ₹5,25,100 — Mar 1, 2026
  2. INV-2025-022 — Sundaram Finance — ₹3,77,600 — Mar 5, 2026
  3. INV-2025-023 — Apollo Hospitals — ₹2,06,500 — Mar 10, 2026
  4. INV-2025-024 — Ramco Systems — ₹7,25,700 — Mar 15, 2026
- Total overdue: ≈ ₹18.3 Lakhs

### Test 3: Invoice Detail
- Click **INV-2025-002** (HDFC Bank — ₹8,50,000)
- **Expected:**
  - Subtotal: ₹8,50,000
  - CGST (9%): ₹76,500
  - SGST (9%): ₹76,500
  - Total: ₹10,03,000
  - Status: Paid (paid_amount = ₹10,03,000, balance = ₹0)

### Test 4: Partially Paid Invoice
- Click **INV-2025-016** (TVS Motor — Cloud Migration)
- **Expected:**
  - Total: ₹7,67,000
  - Paid: ₹3,83,500 (50%)
  - Balance: ₹3,83,500
  - Status: Partially Paid

### Test 5: Total Revenue
- View receivables summary/dashboard
- **Expected:** Total invoiced ≈ ₹1.2–1.5 Cr across 6 months

---

## MODULE: Finance — Bills

**Login as:** accounts@manifest.in
**Navigate to:** Finance → Bills

### Test 1: Bills List
- **Expected:** 12 bills total
- 9 Paid | 3 Unpaid (March 2026 bills)

### Test 2: Unpaid Bills
- Filter by status = "Unpaid"
- **Expected:** 3 bills due in April 2026:
  1. BILL-2026-010 — AWS Cloud Services March — ₹49,000 + GST = ₹57,820 — Due Apr 30
  2. BILL-2026-011 — Microsoft 365 March — ₹28,000 + GST = ₹33,040 — Due Apr 30
  3. BILL-2026-012 — Office Rent March — ₹85,000 + GST = ₹1,00,300 — Due Apr 15

### Test 3: Monthly AWS Cost Trend
- Filter bills by supplier "Amazon Web Services India"
- **Expected:** 3 bills showing cost increase: ₹45,000 → ₹47,500 → ₹49,000 (Jan–Mar)

---

## MODULE: Finance — Journal Entries

**Login as:** accounts@manifest.in
**Navigate to:** Finance → Journal Entries

### Test 1: Journal Entry List
- **Expected:** 20 posted journal entries (JE-2026-001 to JE-2026-020)
- All entries should have status = "posted"

### Test 2: Salary Journal Entry
- Click **JE-2026-001** — "Salary payment January 2026"
- **Expected:** 2 lines:
  - Dr: 5000 (Salaries & Wages) — ₹32,00,000
  - Cr: 1010 (Bank - SBI Current) — ₹32,00,000
  - Total Dr = Total Cr = ₹32,00,000 ✅ Balanced

### Test 3: GST Journal Entry
- Click **JE-2026-020** — "GST payment March 2026"
- **Expected:** 3 lines (debit CGST + SGST, credit bank)
- Verify debits = credits

### Test 4: Chart of Accounts
- Navigate to Finance → Chart of Accounts
- **Expected:** 44 accounts across 5 groups
- 1000-series: Assets (10) | 2000-series: Liabilities (9) | 3000-series: Equity (3) | 4000-series: Revenue (8) | 5000-series: Expenses (14)

---

## MODULE: CRM

**Login as:** sales@manifest.in
**Navigate to:** CRM

### Test 1: Leads Pipeline
- **Expected:** 12 leads in pipeline view
- Stage distribution:
  - Prospecting: 3 (L&T Tech, NTT Data, Sun TV)
  - Qualified: 2 (Wipro, Dmart)
  - Demo: 2 (Cognizant, Piramal)
  - Proposal: 2 (Titan, Reliance Jio)
  - Negotiation: 1 (Mphasis)
  - Closed Won: 1 (Hexaware)
  - Closed Lost: 1 (CSS Corp)

### Test 2: Lead Detail
- Click **LEAD003 — Cognizant Technology**
- **Expected:**
  - Contact: Priya Mehta (priya.m@cognizant.com)
  - Source: Referral
  - Estimated Value: ₹32,00,000
  - Stage: Demo
  - Requirement: Data Analytics

### Test 3: Opportunities
- Navigate to CRM → Opportunities
- **Expected:** 6 opportunities
- Highest value: OPP008 — Reliance Jio Network Management — ₹60,00,000
- Check OPP006 — Hexaware (Closed Won) — ₹15,00,000

### Test 4: CRM Accounts
- Navigate to CRM → Accounts
- **Expected:** 8 companies/accounts
- Mix of Enterprise (Tata Steel, Infosys BPM), Mid-Market (Sify, Coromandel), SME (Matrimony.com)

### Test 5: Pipeline Value
- View pipeline summary
- **Total opportunity pipeline:** ≈ ₹1.2 Crore
- Win rate check: 1 Closed Won, 1 Closed Lost out of 12 leads = 50% win rate (closed deals)

---

## MODULE: Projects

**Login as:** manager@manifest.in
**Navigate to:** Projects

### Test 1: Project List
- **Expected:** 8 projects
- Status breakdown: Ongoing (3) | Completed (2) | At Risk (2) | Planning (1)

### Test 2: At-Risk Projects (should be highlighted)
- **PROJ004 — Data Analytics Dashboard (HDFC Bank)**
  - Status: At Risk, Progress: 55%
  - Budget: ₹50,00,000
  - Check: 1 task "Dashboard Development" is BLOCKED
- **PROJ006 — Chatbot Integration (Sundaram Finance)**
  - Status: At Risk, Progress: 30%
  - Check: 1 task "CRM API Integration" is BLOCKED

### Test 3: Completed Projects
- **PROJ002 — Cloud Migration (Apollo Hospitals)**
  - Progress: 100%, Status: Completed
  - All 5 tasks should show "completed"
- **PROJ005 — IT Security Audit (Murugappa)**
  - Progress: 100%, Status: Completed
  - All 3 tasks should show "completed"

### Test 4: Project Budget Overview
- **Largest project:** PROJ001 — ERP Implementation TVS Motor — ₹45,00,000
- **Smallest project:** PROJ005 — Security Audit Murugappa — ₹9,00,000

### Test 5: Task Kanban / List
- Navigate to PROJ001 → Tasks
- **Expected:** 7 tasks in various statuses
  - Completed: 3 (Requirements, Architecture, Finance Module)
  - In Progress: 2 (HR Module, Supply Chain)
  - Todo: 2 (UAT, Go-live)

---

## MODULE: Timesheets

**Login as:** manager@manifest.in
**Navigate to:** Projects → Timesheets

### Test 1: Timesheet List
- **Expected:** 80 timesheet records (20 employees × 4 weeks)
- Status: Approved (40 records, weeks 1-2), Submitted (40 records, weeks 3-4)

### Test 2: Weekly Timesheet
- Click on any timesheet → view daily entries
- **Expected:** 5 entries (Mon–Fri), 6–9 hours each
- All entries linked to a project

### Test 3: Approve Timesheets
- Filter by status = "Submitted"
- Click "Approve" on any timesheet
- **Expected:** Status changes to "Approved"

### Test 4: My Timesheet (as employee)
- Login as dev1@manifest.in
- Navigate to My Timesheets
- **Expected:** 4 weeks of timesheets, 2 approved + 2 submitted

---

## MODULE: Performance

**Login as:** manager@manifest.in
**Navigate to:** HR → Performance

### Test 1: Performance Reviews
- **Expected:** 30 performance reviews for FY2025-26
- Status: 20 Approved, 10 Submitted

### Test 2: Review Detail
- Click any approved review
- **Expected:** 4 rating categories (Work Quality, Productivity, Teamwork, Communication)
- All ratings between 3.0 and 5.0
- Overall rating = average of 4 categories

### Test 3: Goals
- Navigate to Goals
- **Expected:** 20 goals across departments
- Status mix: 17 In Progress, 3 Completed
- Categories: technical, sales, hr, learning, marketing, quality, strategy, business

### Test 4: Top Goals (check specific data)
- **EMP005 (Arun Krishnan):** AWS Solutions Architect Certification — 90% complete — COMPLETED
- **EMP006 (Deepa Shankar):** React Performance Optimization — 100% — COMPLETED
- **EMP031 (Revathi Sundaram):** Employee Engagement — 100% — COMPLETED

### Test 5: My Goals (as employee)
- Login as dev1@manifest.in → Navigate to My Goals
- Should see: AWS Certification goal at 90%, status = completed

---

## MODULE: Recruitment

**Login as:** hr@manifest.in
**Navigate to:** HR → Recruitment

### Test 1: Job Openings
- **Expected:** 5 open positions:
  1. Senior Full Stack Developer (Chennai, 5 openings)
  2. DevOps Engineer (Chennai, 2 openings)
  3. Sales Manager - North India (Delhi, 1 opening)
  4. Data Scientist (Chennai, 2 openings)
  5. HR Business Partner (Chennai, 1 opening)

### Test 2: Candidate Pipeline
- Click on **JOB001 — Senior Full Stack Developer**
- **Expected:** 5 candidates
  - CAND001 Arvind Subramaniam — Resume Screening
  - CAND002 Meghna Pillai — Phone Screen
  - CAND003 Rajan T — Technical Round 1
  - CAND004 Shalini Sharma — Final Round
  - CAND011 Aarav Patel — Offer Extended (selected)

### Test 3: Scheduled Interviews
- Navigate to Interviews calendar
- **Expected:** 3 interviews scheduled for April 10, 2026 at 10:00 AM via Google Meet
- Interviewer: Rajesh Menon (EMP004)

### Test 4: Candidate Status
- Filter candidates by status = "selected"
- **Expected:** 1 candidate — Aarav Patel (JOB001) — Offer Extended

### Test 5: Recruitment Funnel
- Check stats: 12 applied → 3 interviews → 1 selected
- Time to hire metric (if available)

---

## MODULE: Inventory

**Login as:** admin@manifest.in
**Navigate to:** Inventory

### Test 1: Inventory List
- **Expected:** 20 items across 3 categories:
  - Software Licenses: 10 items
  - Hardware: 5 items
  - Office Supplies: 5 items

### Test 2: Reorder Alerts (Critical!)
- **Expected:** 3 items below reorder point (should show red/warning badge):
  1. **INV-009 Postman Business** — Qty: 4, Reorder Point: 5 ⚠️
  2. **INV-010 DataGrip IDE** — Qty: 3, Reorder Point: 5 ⚠️
  3. **INV-015 Logitech Webcam C920** — Qty: 2, Reorder Point: 3 ⚠️

### Test 3: Highest Value Items
- Sort by unit_cost descending
- **Most expensive:** Dell Laptop Core i7 — ₹85,000 each, 8 in stock = ₹6,80,000 value

### Test 4: Item Detail
- Click **INV-001 Microsoft Office 365**
- **Expected:** Category = Software License, Qty = 35, Cost = ₹2,800/user, Warehouse = Chennai HQ

---

## MODULE: Service Desk

**Login as:** admin@manifest.in
**Navigate to:** Service Desk → Tickets

### Test 1: Ticket Dashboard
- **Expected:** 15 tickets total
  - Open: 6
  - In Progress: 5
  - Resolved: 4

### Test 2: Critical Tickets
- Filter by priority = "Critical"
- **Expected:** 2 tickets:
  1. TKT-2026-001 — "Laptop screen flickering on EMP005 machine" — IT Support — Open
  2. TKT-2026-015 — "Electricity bill payment in invoice system" — Finance — In Progress

### Test 3: Ticket Detail
- Click **TKT-2026-001**
- **Expected:**
  - Raised by: Arun Krishnan (EMP005)
  - Assigned to: Dinesh Chandran (EMP015, DevOps Engineer)
  - Category: IT Support
  - Priority: Critical

### Test 4: Categories
- Filter by category = "IT Support" → 7 tickets
- Filter by category = "HR" → 3 tickets
- Filter by category = "Finance" → 3 tickets
- Filter by category = "Operations" → 2 tickets

### Test 5: Resolve a Ticket
- Click **TKT-2026-007** — "Printer in 3rd floor not working"
- Update status → "Resolved"
- Add resolution note: "Printer cartridge replaced"
- **Expected:** Status changes, resolved_at timestamp set

---

## MODULE: Travel

**Login as:** hr@manifest.in
**Navigate to:** HR → Travel Requests

### Test 1: Travel Request List
- **Expected:** 10 travel requests
  - Approved: 4 (future dates in April 2026)
  - Completed: 4 (Feb–Mar 2026 travel)
  - Pending: 2

### Test 2: Highest Cost Travel
- Sort by estimated_cost
- **Most expensive:** Rajiv Kapoor to Delhi ₹22,000 — Sales pitch to Tata Steel

### Test 3: Pending Approvals
- Filter by status = "Pending"
- **Expected:** 2 requests:
  1. Vijay Raman (EMP007) — Mumbai, Apr 8–10 — ERP demo for NTT Data — ₹19,500
  2. Kavitha Selvan (EMP022) — Bangalore, Apr 15–17 — Salesforce World Tour — ₹13,500

### Test 4: Approve a Travel Request
- Click "Approve" on Vijay Raman's request
- **Expected:** Status changes to "Approved", notification triggered

### Test 5: Travel by Destination
- Mumbai: 3 trips | Bangalore: 3 trips | Hyderabad: 1 trip | Delhi: 1 trip | Pune: 1 trip | Chennai: 1 trip (local)

---

## MODULE: Announcements

**Login as:** any role
**Navigate to:** HR → Announcements (or Home Dashboard)

### Test 1: Announcement List
- **Expected:** 5 active announcements:
  1. ⭐ Q1 Appraisal Cycle Begins — HIGH priority — valid Apr 1–30
  2. 📋 New Leave Policy 2026 — MEDIUM priority — valid Mar 25–Dec 31
  3. 🏗️ Office Renovation - Block B — MEDIUM priority — valid Apr 2–20
  4. 🏖️ Team Outing - April 2026 — LOW priority — valid Apr 1–26
  5. 🔐 Mandatory Security Training — HIGH priority — valid Mar 28–Apr 30

### Test 2: High Priority Announcements
- Filter by priority = "High"
- **Expected:** 2 announcements (Appraisal + Security Training)
- These should be prominently displayed (red/orange banner)

### Test 3: Announcement Detail
- Click "Q1 Appraisal Cycle Begins"
- **Expected:** Full content visible, author = Priya Nair (HR Manager), dates showing

---

## MODULE: Notifications

**Login as:** admin@manifest.in
**Navigate to:** Notifications (bell icon or dedicated page)

### Test 1: Notification Count
- **Expected:** 20 notifications for admin user
- Unread count badge should show 17+ (some are pre-marked as read)

### Test 2: Notification Categories
- Leave approvals pending: 3 notifications
- Invoice overdue alerts: 4 notifications
- Payroll notifications: 2 notifications
- Ticket assignments: 3 notifications
- Inventory alerts: 1 notification
- Project at-risk: 2 notifications
- Finance (bills due): 3 notifications
- Appraisal + recruitment: 2 notifications

### Test 3: Priority Notifications (Critical)
- 2 critical ticket notifications should be marked as urgent/red

### Test 4: Mark as Read
- Click any notification → mark as read
- **Expected:** Badge count decreases, notification style changes

---

## MODULE: Reports

**Login as:** admin@manifest.in
**Navigate to:** Reports

### Test 1: Payroll Summary Report
- Select Report Type: Payroll Summary
- Period: February 2026
- **Expected:** Shows 50 employees, total gross ≈ ₹32-35L, total net ≈ ₹28-30L
- Department-wise breakdown shows Engineering as largest cost center

### Test 2: Accounts Receivable Aging
- Select: AR Aging Report
- **Expected:**
  - Current: ~₹8L (invoices due soon)
  - 1-30 days overdue: ~₹10L
  - 31-60 days: ~₹8L
  - 4 overdue invoices visible

### Test 3: Employee Headcount Report
- Select: Headcount by Department
- **Expected chart:** Engineering 36% | Sales 16% | Others proportional

### Test 4: Project Profitability
- Select: Project Status Report
- **Expected:** 8 projects with budget vs actual cost comparison
- At-risk projects highlighted in red

---

## MODULE: Org Chart

**Login as:** any role
**Navigate to:** HR → Org Chart

### Test 1: Hierarchy Display
- **Expected:** Tree structure showing company hierarchy
- Top: Arjun Mehta (CEO)
- Level 2: Sunita Krishnamurthy (CTO), Vikram Nambiar (VP Ops), etc.
- Level 3: Department Managers (Rajesh Menon, Priya Nair, Suresh Kumar, etc.)

### Test 2: Department View
- Click "Engineering" department
- **Expected:** Shows Rajesh Menon (Manager) and 17 direct/indirect reports

---

## MODULE: Audit Logs

**Login as:** admin@manifest.in
**Navigate to:** Admin → Audit Logs

### Test 1: Activity Log
- **Expected:** Audit log entries for all seed-time operations
- Note: Audit logs may be empty if seed didn't explicitly write to audit_logs table
- After performing any action (approve leave, mark payroll paid), audit entry should appear

### Test 2: User Activity
- Filter by user = admin@manifest.in
- **Expected:** Recent login events

---

## Quick End-to-End Flow Tests

### Flow 1: Employee Lifecycle
1. Login as **hr@manifest.in**
2. View employee **EMP019 (Sathish Kumar)**
3. Go to Leaves → find his pending 5-day leave request (Apr 3–7)
4. Approve it → status changes to "Approved"
5. Go to Attendance → verify he has no attendance on Apr 3–7 (on leave)
6. Go to Payroll → his March payslip should still show full salary

### Flow 2: Invoice to Receipt
1. Login as **accounts@manifest.in**
2. View **INV-2025-021** (TechSolutions India — Overdue — ₹5,25,100)
3. Click "Record Payment" / "Mark as Received"
4. Enter amount: ₹5,25,100, Mode: Bank Transfer
5. **Expected:** Invoice status changes to "paid", balance = ₹0
6. Journal entry should auto-create: Dr 1010 (Bank) Cr 1100 (AR)

### Flow 3: Project → Task → Timesheet
1. Login as **manager@manifest.in**
2. Navigate to PROJ001 (TVS Motor ERP)
3. Find task "HR Module Development" (in_progress)
4. Switch to **dev1@manifest.in** (Arun Krishnan — assigned to PROJ001)
5. Navigate to My Timesheets → current week
6. Add timesheet entry: PROJ001, 8 hours, "HR module backend API development"
7. Submit timesheet
8. Switch back to manager@manifest.in → approve the timesheet

### Flow 4: CRM → Opportunity → Quotation
1. Login as **sales@manifest.in**
2. Navigate to CRM → Leads → LEAD008 (NTT Data — Prospecting)
3. Move lead to "Qualified" stage
4. Create Opportunity from the lead (value: ₹45,00,000, close date: Sep 2026)
5. Navigate to Sales → Quotations → Create New
6. Link to the opportunity, add services line items
7. Save as draft

### Flow 5: Procurement → 3-Way Match
1. Login as **admin@manifest.in**
2. Navigate to Procurement → Purchase Requests
3. View **PR-2026-006** (GitHub Enterprise — pending approval)
4. Approve the PR
5. Create PO from approved PR → select SUPP001 (AWS) or SUPP002 (Microsoft)
6. Navigate to POs → confirm delivery
7. Create GRN from the PO
8. Bill should auto-link for 3-way matching

---

## Known Empty Tables (Require Manual Input via UI)

These tables have no seed data and are populated only through UI actions:

| Module | Empty Tables | How to Populate |
|--------|-------------|-----------------|
| Finance | invoice_items, bill_items, payments, receipts | Create invoices/bills with line items via UI |
| Finance | bank_accounts, accounting_periods | Setup → Finance Configuration |
| Sales | quotations, sales_orders, targets, commissions | Sales → Create Quote, Set Targets |
| Procurement | vendor_quotes, rfq_*, three_way_match | Procurement → Create RFQ |
| Inventory | stock_ledger, stock_adjustments | Inventory → Stock Movements |
| HR | probation_records, training_programs, skill_matrix | HR → Training, Skills module |
| Service Desk | sla_policies, knowledge_base, csat_surveys | Service Desk → Settings, KB |
| Admin | integration_settings, workflow_rules | Admin → Settings, Automation |
| Marketing | campaigns | Marketing → Campaigns |

---

## Troubleshooting

### "No data found" on a seeded table
1. Check browser network tab for the API response
2. Verify the JWT token is valid: `localStorage.getItem('token')`
3. Try re-seeding: `node src/database/seeds/runMigrations.js`
4. Check table exists: run `node src/database/seeds/testChecklist.js`

### Login fails
- Ensure backend is running on port 5000
- Check `.env` file has correct `DB_NAME`, `DB_USER`, `DB_PASSWORD`
- Try browser console: `devLogin('admin')` using `devLogin.js`

### Salary calculations look wrong
- Basic salary is stored per month
- HRA = 40% of basic
- PF = 12% of basic (max basic for PF calculation = ₹15,000)
- ESI = 0.75% of gross (only if gross ≤ ₹21,000)
- Professional Tax = ₹200 flat (if gross > ₹10,000)

### GSTIN format reminder
- Tamil Nadu code: **33**
- Format: `33AAAAA0000A1Z5`
- Manifest Technologies GSTIN: `33AABCM1234A1Z5`

---

*Pulse ERP Test Guide — Manifest Technologies, Chennai*
*Seed system built for testing all 225+ frontend pages and 68+ backend routes*
