// Sample data for Leaves pages — used as fallbacks in development only.
// Each component imports what it needs and guards with import.meta.env.DEV.
// Names were disambiguated to avoid clashes: see source comments.

// ── AllLeaves (sampleLeaves / sampleBalance / sampleTeamLeaves) ───────────────
export const SAMPLE_LEAVES_ALL = [
  { id: 1, first_name: 'Arjun',  last_name: 'Sharma',  department: 'Engineering', leave_type: 'Annual Leave',   start_date: '2026-03-18', end_date: '2026-03-20', days: 3, reason: 'Family vacation',         status: 'pending',  created_at: '2026-03-14' },
  { id: 2, first_name: 'Priya',  last_name: 'Menon',   department: 'Design',      leave_type: 'Medical Leave',  start_date: '2026-03-16', end_date: '2026-03-16', days: 1, reason: 'Doctor appointment',       status: 'approved', created_at: '2026-03-12' },
  { id: 3, first_name: 'Rahul',  last_name: 'Kumar',   department: 'Engineering', leave_type: 'Casual Leave',   start_date: '2026-03-22', end_date: '2026-03-22', days: 1, reason: 'Personal work',            status: 'pending',  created_at: '2026-03-13' },
  { id: 4, first_name: 'Sneha',  last_name: 'Pillai',  department: 'QA',          leave_type: 'Annual Leave',   start_date: '2026-03-10', end_date: '2026-03-13', days: 4, reason: 'Travel',                   status: 'approved', created_at: '2026-03-05' },
  { id: 5, first_name: 'Vikram', last_name: 'Singh',   department: 'Engineering', leave_type: 'Sick Leave',     start_date: '2026-03-14', end_date: '2026-03-15', days: 2, reason: 'Fever',                    status: 'rejected', created_at: '2026-03-13' },
  { id: 6, first_name: 'Divya',  last_name: 'Nair',    department: 'HR',          leave_type: 'Compensatory',   start_date: '2026-03-25', end_date: '2026-03-25', days: 1, reason: 'Weekend worked last week',  status: 'pending',  created_at: '2026-03-15' },
];

export const SAMPLE_BALANCE_ALL = { annual: 10, sick: 3, casual: 2, compensatory: 1 };

export const SAMPLE_TEAM_WEEK = {
  Mon: ['Priya M.'],
  Tue: ['Priya M.', 'Vikram S.'],
  Wed: [],
  Thu: ['Sneha P.'],
  Fri: [],
};

// ── ApplyLeave (SAMPLE_BALANCES) ──────────────────────────────────────────────
export const SAMPLE_BALANCES = {
  'Sick Leave':       { used: 3,  pending: 1 },
  'Casual Leave':     { used: 5,  pending: 0 },
  'Earned Leave':     { used: 6,  pending: 2 },
  'Maternity Leave':  { used: 0,  pending: 0 },
  'Paternity Leave':  { used: 0,  pending: 0 },
  'Compensatory Off': { used: 1,  pending: 0 },
  'Unpaid Leave':     { used: 0,  pending: 0 },
};

// ── LeaveCalendar (SAMPLE_LEAVES — renamed to avoid clash with TeamLeaves) ────
export const SAMPLE_CALENDAR_LEAVES = [
  { id: 1,  employee: 'Arjun Mehta',   type: 'Casual',   startDate: '2026-03-10', endDate: '2026-03-11', status: 'Approved' },
  { id: 2,  employee: 'Priya Sharma',  type: 'Sick',     startDate: '2026-03-15', endDate: '2026-03-15', status: 'Approved' },
  { id: 3,  employee: 'Rahul Verma',   type: 'Earned',   startDate: '2026-03-17', endDate: '2026-03-21', status: 'Approved' },
  { id: 4,  employee: 'Sneha Iyer',    type: 'Casual',   startDate: '2026-03-20', endDate: '2026-03-20', status: 'Pending'  },
  { id: 5,  employee: 'Kiran Das',     type: 'Sick',     startDate: '2026-03-24', endDate: '2026-03-25', status: 'Approved' },
  { id: 6,  employee: 'Vikram Singh',  type: 'Earned',   startDate: '2026-03-27', endDate: '2026-03-29', status: 'Approved' },
  { id: 7,  employee: 'Meera Joshi',   type: 'Optional', startDate: '2026-03-25', endDate: '2026-03-25', status: 'Approved' },
  { id: 8,  employee: 'Rohit Gupta',   type: 'Casual',   startDate: '2026-04-01', endDate: '2026-04-02', status: 'Pending'  },
  { id: 9,  employee: 'Anika Patel',   type: 'Earned',   startDate: '2026-03-03', endDate: '2026-03-07', status: 'Approved' },
  { id: 10, employee: 'Suresh Nair',   type: 'Sick',     startDate: '2026-03-18', endDate: '2026-03-18', status: 'Approved' },
];

// ── LeaveApprovals ────────────────────────────────────────────────────────────
export const SAMPLE_LEAVE_APPROVALS = [
  { id: 1, employee: 'Sneha Iyer',   department: 'Finance',     leaveType: 'Casual', startDate: '2026-03-20', endDate: '2026-03-20', days: 1, reason: 'Personal work',        status: 'Pending'  },
  { id: 2, employee: 'Rohit Gupta',  department: 'Operations',  leaveType: 'Earned', startDate: '2026-04-01', endDate: '2026-04-02', days: 2, reason: 'Family function',       status: 'Pending'  },
  { id: 3, employee: 'Kiran Das',    department: 'Engineering', leaveType: 'Sick',   startDate: '2026-03-24', endDate: '2026-03-25', days: 2, reason: 'Medical appointment',   status: 'Approved' },
  { id: 4, employee: 'Meera Joshi',  department: 'Engineering', leaveType: 'Casual', startDate: '2026-03-18', endDate: '2026-03-18', days: 1, reason: 'Bank work',             status: 'Rejected' },
  { id: 5, employee: 'Vikram Singh', department: 'Sales',       leaveType: 'Earned', startDate: '2026-03-27', endDate: '2026-03-29', days: 3, reason: 'Vacation',             status: 'Approved' },
  { id: 6, employee: 'Anika Patel',  department: 'HR',          leaveType: 'Sick',   startDate: '2026-03-31', endDate: '2026-03-31', days: 1, reason: 'Fever and cold',       status: 'Pending'  },
];

// ── TeamLeaves (SAMPLE_LEAVES — renamed to avoid clash with LeaveCalendar) ────
export const SAMPLE_TEAM_LEAVES = [
  { id: 1, first_name: 'Rajesh',  last_name: 'Kumar',  department: 'Engineering',  leave_type: 'Sick Leave',    start_date: '2026-03-10', end_date: '2026-03-12', days: 3, reason: 'Fever and flu',      status: 'pending',  manager_comment: '' },
  { id: 2, first_name: 'Priya',   last_name: 'Sharma', department: 'Sales',        leave_type: 'Casual Leave',  start_date: '2026-03-15', end_date: '2026-03-15', days: 1, reason: 'Personal work',      status: 'approved', manager_comment: 'Approved' },
  { id: 3, first_name: 'Anand',   last_name: 'Mehta',  department: 'Finance',      leave_type: 'Earned Leave',  start_date: '2026-03-20', end_date: '2026-03-24', days: 5, reason: 'Vacation trip',      status: 'pending',  manager_comment: '' },
  { id: 4, first_name: 'Sunita',  last_name: 'Rao',    department: 'HR',           leave_type: 'Sick Leave',    start_date: '2026-02-28', end_date: '2026-02-28', days: 1, reason: 'Doctor visit',       status: 'approved', manager_comment: 'Get well soon' },
  { id: 5, first_name: 'Vikram',  last_name: 'Nair',   department: 'Engineering',  leave_type: 'Casual Leave',  start_date: '2026-03-18', end_date: '2026-03-18', days: 1, reason: 'Family function',    status: 'rejected', manager_comment: 'Sprint in progress' },
  { id: 6, first_name: 'Meena',   last_name: 'Pillai', department: 'Operations',   leave_type: 'Earned Leave',  start_date: '2026-04-01', end_date: '2026-04-05', days: 5, reason: 'Annual vacation',    status: 'pending',  manager_comment: '' },
];
