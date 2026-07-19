// Sample data for HR pages — used as fallbacks in development only.
// Each component imports what it needs and guards with import.meta.env.DEV.

// ── Payroll ────────────────────────────────────────────────────────────────────
export const SAMPLE_LIST = [
  { id:1, employee_id:'EMP001', name:'Arjun Sharma',  department:'Engineering', designation:'Sr. Developer',   month:'February 2026', basic:45000, hra:18000, allowances:8000, gross:71000, pf:5400, esi:532,  tds:4200, total_deductions:10132, net_pay:60868, status:'paid',       paid_on:'28 Feb 2026' },
  { id:2, employee_id:'EMP002', name:'Priya Menon',   department:'Design',      designation:'UI Designer',     month:'February 2026', basic:38000, hra:15200, allowances:6000, gross:59200, pf:4560, esi:444,  tds:2800, total_deductions:7804,  net_pay:51396, status:'paid',       paid_on:'28 Feb 2026' },
  { id:3, employee_id:'EMP003', name:'Rahul Kumar',   department:'Engineering', designation:'Developer',       month:'February 2026', basic:32000, hra:12800, allowances:5000, gross:49800, pf:3840, esi:374,  tds:1800, total_deductions:6014,  net_pay:43786, status:'paid',       paid_on:'28 Feb 2026' },
  { id:4, employee_id:'EMP004', name:'Sneha Pillai',  department:'QA',          designation:'QA Engineer',     month:'February 2026', basic:28000, hra:11200, allowances:4500, gross:43700, pf:3360, esi:328,  tds:1200, total_deductions:4888,  net_pay:38812, status:'pending',    paid_on:null },
  { id:5, employee_id:'EMP005', name:'Vikram Singh',  department:'Engineering', designation:'Backend Dev',     month:'February 2026', basic:35000, hra:14000, allowances:5500, gross:54500, pf:4200, esi:409,  tds:2200, total_deductions:6809,  net_pay:47691, status:'pending',    paid_on:null },
  { id:6, employee_id:'EMP006', name:'Divya Nair',    department:'HR',          designation:'HR Executive',    month:'February 2026', basic:30000, hra:12000, allowances:4000, gross:46000, pf:3600, esi:345,  tds:1500, total_deductions:5445,  net_pay:40555, status:'processing', paid_on:null },
  { id:7, employee_id:'EMP007', name:'Karan Mehta',   department:'Finance',     designation:'Finance Analyst', month:'February 2026', basic:40000, hra:16000, allowances:7000, gross:63000, pf:4800, esi:473,  tds:3200, total_deductions:8473,  net_pay:54527, status:'paid',       paid_on:'28 Feb 2026' },
  { id:8, employee_id:'EMP008', name:'Ananya Iyer',   department:'Marketing',   designation:'Marketing Exec',  month:'February 2026', basic:26000, hra:10400, allowances:3500, gross:39900, pf:3120, esi:299,  tds:900,  total_deductions:4319,  net_pay:35581, status:'on_hold',    paid_on:null },
];

export const SAMPLE_SUMMARY = { total_employees:24, total_gross:1248000, total_net:1089450, total_deductions:158550, paid_count:18, pending_count:4, processing_count:2 };

export const SAMPLE_TREND = [
  { month:'Sep', gross:1180000, net:1030000 },
  { month:'Oct', gross:1195000, net:1042000 },
  { month:'Nov', gross:1210000, net:1055000 },
  { month:'Dec', gross:1235000, net:1078000 },
  { month:'Jan', gross:1240000, net:1082000 },
  { month:'Feb', gross:1248000, net:1089450 },
];

// ── Offboarding ────────────────────────────────────────────────────────────────
export const SAMPLE_EMPLOYEES = [
  { id:1, name:'Manish Gupta',   department:'Operations',  last_working_day:'2026-03-31', reason:'Resignation' },
  { id:2, name:'Seema Joshi',    department:'Finance',     last_working_day:'2026-04-15', reason:'Retirement' },
  { id:3, name:'Kiran Nair',     department:'Sales',       last_working_day:'2026-04-30', reason:'Resignation' },
];

// ── EmployeeDocuments ─────────────────────────────────────────────────────────
export const SAMPLE_DOCS = [
  { id: 1, name: 'Offer Letter - 2023.pdf',      type: 'Offer Letter',          size: '245 KB', uploaded_by: 'HR Admin', uploaded_at: '2023-04-01', status: 'verified' },
  { id: 2, name: 'Employment Contract.pdf',       type: 'Contract',              size: '380 KB', uploaded_by: 'HR Admin', uploaded_at: '2023-04-01', status: 'verified' },
  { id: 3, name: 'PAN_Card.jpg',                  type: 'PAN Card',              size: '120 KB', uploaded_by: 'Employee',  uploaded_at: '2023-04-03', status: 'verified' },
  { id: 4, name: 'Aadhaar_Front.jpg',             type: 'Aadhaar',               size: '180 KB', uploaded_by: 'Employee',  uploaded_at: '2023-04-03', status: 'pending' },
  { id: 5, name: 'Graduation_Certificate.pdf',    type: 'Education Certificate', size: '512 KB', uploaded_by: 'Employee',  uploaded_at: '2023-04-05', status: 'verified' },
];

// ── EmployeeDirectory ──────────────────────────────────────────────────────────
export const SAMPLE_EMPLOYEES_DIR = [
  { id:1, name:'Arjun Mehta',    designation:'Senior Developer',    department:'Engineering', email:'arjun@company.com',  phone:'+91 98765 00001', location:'Bangalore', status:'active' },
  { id:2, name:'Priya Sharma',   designation:'HR Manager',          department:'HR',          email:'priya@company.com',  phone:'+91 98765 00002', location:'Mumbai',    status:'active' },
  { id:3, name:'Rohit Verma',    designation:'Finance Analyst',     department:'Finance',     email:'rohit@company.com',  phone:'+91 98765 00003', location:'Delhi',     status:'active' },
  { id:4, name:'Sneha Pillai',   designation:'Product Manager',     department:'Product',     email:'sneha@company.com',  phone:'+91 98765 00004', location:'Pune',      status:'active' },
  { id:5, name:'Kiran Nair',     designation:'Sales Executive',     department:'Sales',       email:'kiran@company.com',  phone:'+91 98765 00005', location:'Chennai',   status:'active' },
  { id:6, name:'Deepa Reddy',    designation:'QA Engineer',         department:'Engineering', email:'deepa@company.com',  phone:'+91 98765 00006', location:'Hyderabad', status:'active' },
  { id:7, name:'Manish Gupta',   designation:'Operations Lead',     department:'Operations',  email:'manish@company.com', phone:'+91 98765 00007', location:'Bangalore', status:'inactive' },
  { id:8, name:'Ananya Iyer',    designation:'Marketing Executive', department:'Marketing',   email:'ananya@company.com', phone:'+91 98765 00008', location:'Mumbai',    status:'active' },
];

// ── Shifts ─────────────────────────────────────────────────────────────────────
export const SAMPLE_SHIFTS = [
  { id:1, name:'Morning Shift',   start:'08:00', end:'16:00', grace_minutes:15, departments:['Engineering', 'Sales'],   employees_count:42, color:'#6366f1' },
  { id:2, name:'General Shift',   start:'09:30', end:'18:30', grace_minutes:15, departments:['HR', 'Finance', 'Admin'], employees_count:28, color:'#10b981' },
  { id:3, name:'Evening Shift',   start:'14:00', end:'22:00', grace_minutes:10, departments:['Operations'],             employees_count:15, color:'#f59e0b' },
  { id:4, name:'Night Shift',     start:'22:00', end:'06:00', grace_minutes:10, departments:['Support'],               employees_count:8,  color:'#8b5cf6' },
  { id:5, name:'Flexible Shift',  start:'10:00', end:'19:00', grace_minutes:30, departments:['Product', 'Marketing'],  employees_count:20, color:'#ec4899' },
];
