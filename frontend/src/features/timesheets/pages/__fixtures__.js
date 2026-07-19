// Sample data for Timesheets pages — used as fallbacks in development only.
// Each component imports what it needs and guards with import.meta.env.DEV.

// ── MyTimesheet — active project list ────────────────────────────────────────
export const SAMPLE_PROJECTS = [
  { id: 1, project_name: 'ERP Implementation - TechCorp', project_code: 'PROJ-001' },
  { id: 2, project_name: 'Cloud Migration - Alpha Mfg',   project_code: 'PROJ-002' },
  { id: 3, project_name: 'Data Analytics - MediTech',     project_code: 'PROJ-005' },
];

// ── MyTimesheet — timesheet entries map { project_id: { date: hours } } ──────
export const SAMPLE_ENTRIES = {
  1: { '2026-03-09': 4, '2026-03-10': 3.5, '2026-03-11': 4, '2026-03-12': 2, '2026-03-13': 3 },
  2: { '2026-03-09': 3, '2026-03-10': 4,   '2026-03-11': 2, '2026-03-13': 5 },
  3: { '2026-03-10': 0.5, '2026-03-12': 2, '2026-03-14': 4 },
};

// ── UtilizationReport — employee utilization rows ─────────────────────────────
export const SAMPLE_EMPLOYEES_UTIL = [
  { id: 1, employee: 'Kiran Das',    department: 'Engineering', billable: 38, nonBillable: 7,  total: 45, utilization: 84 },
  { id: 2, employee: 'Meera Joshi',  department: 'Engineering', billable: 34, nonBillable: 4,  total: 38, utilization: 89 },
  { id: 3, employee: 'Rohit Gupta',  department: 'Operations',  billable: 28, nonBillable: 12, total: 40, utilization: 70 },
  { id: 4, employee: 'Sneha Iyer',   department: 'Finance',     billable: 30, nonBillable: 12, total: 42, utilization: 71 },
  { id: 5, employee: 'Vikram Singh', department: 'Sales',       billable: 35, nonBillable: 6,  total: 41, utilization: 85 },
  { id: 6, employee: 'Anika Patel',  department: 'HR',          billable: 20, nonBillable: 20, total: 40, utilization: 50 },
  { id: 7, employee: 'Arjun Mehta',  department: 'Sales',       billable: 36, nonBillable: 5,  total: 41, utilization: 88 },
  { id: 8, employee: 'Priya Sharma', department: 'Engineering', billable: 32, nonBillable: 8,  total: 40, utilization: 80 },
];

// ── UtilizationReport — weekly billable chart data ────────────────────────────
export const SAMPLE_CHART = [
  { week: 'W1 Mar', billable: 276, nonBillable: 84 },
  { week: 'W2 Mar', billable: 290, nonBillable: 74 },
  { week: 'W3 Mar', billable: 268, nonBillable: 92 },
  { week: 'W4 Mar', billable: 310, nonBillable: 58 },
];

// ── WeeklyProductionReport — employee weekly hours rows ───────────────────────
export const SAMPLE_EMPLOYEES_WEEKLY = [
  { id:1, name:'Arjun Mehta',   dept:'Engineering', mon:8,   tue:8,   wed:7.5, thu:7,   fri:8,   total:38.5, billable:38.5, submitted:'Mar 17', status:'Approved'  },
  { id:2, name:'Priya Sharma',  dept:'HR',          mon:8,   tue:8,   wed:8,   thu:8,   fri:8,   total:40,   billable:32,   submitted:'Mar 17', status:'Approved'  },
  { id:3, name:'Rohit Verma',   dept:'Finance',     mon:8,   tue:7,   wed:7,   thu:8,   fri:6,   total:36,   billable:28,   submitted:'Mar 16', status:'Pending'   },
  { id:4, name:'Sneha Pillai',  dept:'Product',     mon:9,   tue:8,   wed:8,   thu:9,   fri:8,   total:42,   billable:36,   submitted:'Mar 17', status:'Approved'  },
  { id:5, name:'Kiran Nair',    dept:'Sales',       mon:9,   tue:9,   wed:8,   thu:9,   fri:9,   total:44,   billable:40,   submitted:'Mar 15', status:'Approved'  },
  { id:6, name:'Deepa Reddy',   dept:'Engineering', mon:6,   tue:6,   wed:6,   thu:6,   fri:6,   total:30,   billable:28,   submitted:'Mar 17', status:'Rejected'  },
  { id:7, name:'Ananya Iyer',   dept:'Marketing',   mon:7,   tue:7,   wed:7,   thu:7,   fri:7,   total:35,   billable:20,   submitted:'Mar 17', status:'Pending'   },
];

// ── TimesheetApprovals ────────────────────────────────────────────────────────
export const SAMPLE_TIMESHEET_APPROVALS = [
  { id: 1, employee: 'Sneha Iyer',   department: 'Finance',     weekOf: '2026-03-10', totalHours: 42, status: 'Pending',
    breakdown: [
      { day: 'Mon', project: 'Budget Review',    hours: 8 },
      { day: 'Tue', project: 'Invoice Processing', hours: 9 },
      { day: 'Wed', project: 'Budget Review',    hours: 8 },
      { day: 'Thu', project: 'Team Meeting',     hours: 7 },
      { day: 'Fri', project: 'Reporting',        hours: 10 },
    ]
  },
  { id: 2, employee: 'Rohit Gupta',  department: 'Operations',  weekOf: '2026-03-10', totalHours: 40, status: 'Pending',
    breakdown: [
      { day: 'Mon', project: 'Ops Planning',     hours: 8 },
      { day: 'Tue', project: 'Vendor Calls',     hours: 8 },
      { day: 'Wed', project: 'Ops Planning',     hours: 8 },
      { day: 'Thu', project: 'Process Review',   hours: 8 },
      { day: 'Fri', project: 'Documentation',    hours: 8 },
    ]
  },
  { id: 3, employee: 'Kiran Das',    department: 'Engineering', weekOf: '2026-03-10', totalHours: 45, status: 'Approved',
    breakdown: [
      { day: 'Mon', project: 'Feature Dev',      hours: 9 },
      { day: 'Tue', project: 'Feature Dev',      hours: 9 },
      { day: 'Wed', project: 'Code Review',      hours: 9 },
      { day: 'Thu', project: 'Feature Dev',      hours: 9 },
      { day: 'Fri', project: 'Bug Fixes',        hours: 9 },
    ]
  },
  { id: 4, employee: 'Meera Joshi',  department: 'Engineering', weekOf: '2026-03-03', totalHours: 38, status: 'Rejected',
    breakdown: [
      { day: 'Mon', project: 'Backend API',      hours: 8 },
      { day: 'Tue', project: 'Backend API',      hours: 7 },
      { day: 'Wed', project: 'Testing',          hours: 8 },
      { day: 'Thu', project: 'Testing',          hours: 7 },
      { day: 'Fri', project: 'Deployment',       hours: 8 },
    ]
  },
  { id: 5, employee: 'Vikram Singh', department: 'Sales',       weekOf: '2026-03-10', totalHours: 41, status: 'Pending',
    breakdown: [
      { day: 'Mon', project: 'Client Calls',     hours: 8 },
      { day: 'Tue', project: 'Proposal Writing', hours: 9 },
      { day: 'Wed', project: 'Client Calls',     hours: 8 },
      { day: 'Thu', project: 'Pipeline Review',  hours: 8 },
      { day: 'Fri', project: 'CRM Update',       hours: 8 },
    ]
  },
  { id: 6, employee: 'Anika Patel',  department: 'HR',          weekOf: '2026-03-10', totalHours: 40, status: 'Pending',
    breakdown: [
      { day: 'Mon', project: 'Recruitment',      hours: 8 },
      { day: 'Tue', project: 'Onboarding',       hours: 8 },
      { day: 'Wed', project: 'Recruitment',      hours: 8 },
      { day: 'Thu', project: 'Payroll',          hours: 8 },
      { day: 'Fri', project: 'HR Meetings',      hours: 8 },
    ]
  },
];

// ── WeeklyProductionReport — employees who haven't submitted ──────────────────
export const SAMPLE_MISSING = [
  { name:'Vikram Singh', dept:'Operations', due:'Mar 17' },
  { name:'Shalini Iyer', dept:'Product',    due:'Mar 17' },
];
