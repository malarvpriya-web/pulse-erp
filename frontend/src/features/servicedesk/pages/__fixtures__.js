// Sample data for Service Desk pages — used as fallbacks in development only.
// Guard every usage with import.meta.env.DEV.

// ── AgentWorkload ─────────────────────────────────────────────────────────────
export const SAMPLE_AGENTS = [
  { id:1, name:'Ravi Kumar',    department:'L1 Support', open_tickets:8,  in_progress:3, resolved_today:5,  avg_response_mins:18, utilization:82 },
  { id:2, name:'Sneha Iyer',    department:'L2 Support', open_tickets:5,  in_progress:2, resolved_today:7,  avg_response_mins:32, utilization:74 },
  { id:3, name:'Arjun Mehta',   department:'L1 Support', open_tickets:12, in_progress:4, resolved_today:3,  avg_response_mins:12, utilization:95 },
  { id:4, name:'Priya Sharma',  department:'L3 Support', open_tickets:3,  in_progress:1, resolved_today:9,  avg_response_mins:55, utilization:58 },
  { id:5, name:'Kiran Das',     department:'L2 Support', open_tickets:7,  in_progress:3, resolved_today:6,  avg_response_mins:28, utilization:79 },
  { id:6, name:'Meera Joshi',   department:'L1 Support', open_tickets:10, in_progress:5, resolved_today:4,  avg_response_mins:15, utilization:90 },
];

// ── FieldService ──────────────────────────────────────────────────────────────
export const SAMPLE_FIELD_REQUESTS = [
  { id:1, request_number:'FS-2026-001', customer:'TechCorp Solutions',    location:'Bangalore, KA',  category:'Hardware Repair',    engineer:'Vikram N',  priority:'High',   status:'in_progress', scheduled_date:'2026-03-20' },
  { id:2, request_number:'FS-2026-002', customer:'Alpha Manufacturing',   location:'Mumbai, MH',     category:'Network Setup',      engineer:'Rohit G',   priority:'Medium', status:'scheduled',   scheduled_date:'2026-03-21' },
  { id:3, request_number:'FS-2026-003', customer:'BrightFin Ltd',         location:'Chennai, TN',    category:'Software Install',   engineer:'Anand M',   priority:'Low',    status:'completed',   scheduled_date:'2026-03-18' },
  { id:4, request_number:'FS-2026-004', customer:'Global Trade Partners', location:'Delhi, DL',      category:'Preventive Maint',   engineer:'Unassigned',priority:'High',   status:'open',        scheduled_date:'2026-03-22' },
  { id:5, request_number:'FS-2026-005', customer:'MediTech Services',     location:'Hyderabad, TS',  category:'Hardware Repair',    engineer:'Vikram N',  priority:'Medium', status:'scheduled',   scheduled_date:'2026-03-22' },
  { id:6, request_number:'FS-2026-006', customer:'RetailCo Ltd',          location:'Pune, MH',       category:'Network Setup',      engineer:'Rohit G',   priority:'Low',    status:'open',        scheduled_date:'2026-03-25' },
];

// ── FieldVisitScheduler ───────────────────────────────────────────────────────
export const SAMPLE_VISITS = [
  { id:1, visit_id:'VIS-001', customer:'TechCorp Solutions',    address:'14 IT Park, Whitefield, Bangalore', engineer:'Vikram Nair',  scheduled_date:'2026-03-20', scheduled_time:'10:00 AM', purpose:'Hardware Repair',  status:'confirmed', duration_hrs:3 },
  { id:2, visit_id:'VIS-002', customer:'Alpha Manufacturing',   address:'MIDC, Andheri, Mumbai',             engineer:'Rohit Gupta',  scheduled_date:'2026-03-21', scheduled_time:'09:30 AM', purpose:'Network Setup',    status:'confirmed', duration_hrs:4 },
  { id:3, visit_id:'VIS-003', customer:'BrightFin Ltd',         address:'Anna Salai, Chennai',               engineer:'Anand Menon',  scheduled_date:'2026-03-21', scheduled_time:'02:00 PM', purpose:'Software Install', status:'pending',   duration_hrs:2 },
  { id:4, visit_id:'VIS-004', customer:'Global Trade Partners', address:'Connaught Place, Delhi',            engineer:'Ravi Kumar',   scheduled_date:'2026-03-22', scheduled_time:'11:00 AM', purpose:'Preventive Maint', status:'confirmed', duration_hrs:2 },
  { id:5, visit_id:'VIS-005', customer:'MediTech Services',     address:'HITEC City, Hyderabad',             engineer:'Vikram Nair',  scheduled_date:'2026-03-22', scheduled_time:'03:00 PM', purpose:'Hardware Repair',  status:'pending',   duration_hrs:3 },
  { id:6, visit_id:'VIS-006', customer:'RetailCo Ltd',          address:'Hinjewadi, Pune',                   engineer:'Sneha Iyer',   scheduled_date:'2026-03-25', scheduled_time:'10:30 AM', purpose:'Network Audit',    status:'pending',   duration_hrs:2 },
];

// ── KnowledgeBase ─────────────────────────────────────────────────────────────
export const SAMPLE_ARTICLES = [
  { id:1, title:'How to reset VPN credentials',               category:'Network',   views:342, helpful:89, status:'published', updated_at:'2026-03-10', author:'Ravi Kumar' },
  { id:2, title:'Laptop imaging procedure — Windows 11',      category:'Hardware',  views:218, helpful:74, status:'published', updated_at:'2026-03-08', author:'Arjun Mehta' },
  { id:3, title:'Outlook sync issues — common fixes',         category:'Software',  views:501, helpful:92, status:'published', updated_at:'2026-03-12', author:'Sneha Iyer' },
  { id:4, title:'Printer offline — troubleshooting guide',    category:'Hardware',  views:187, helpful:68, status:'published', updated_at:'2026-03-05', author:'Meera Joshi' },
  { id:5, title:'ERP login error codes reference',            category:'Software',  views:134, helpful:55, status:'published', updated_at:'2026-03-14', author:'Kiran Das' },
  { id:6, title:'New employee IT onboarding checklist',       category:'General',   views:93,  helpful:81, status:'published', updated_at:'2026-03-01', author:'Priya Sharma' },
  { id:7, title:'Cloud storage access policy 2026',           category:'Policy',    views:44,  helpful:70, status:'draft',     updated_at:'2026-03-16', author:'Ravi Kumar' },
  { id:8, title:'Two-factor authentication setup guide',      category:'Security',  views:276, helpful:95, status:'published', updated_at:'2026-03-09', author:'Arjun Mehta' },
];

// ── ServiceContracts ──────────────────────────────────────────────────────────
export const SAMPLE_CONTRACTS = [
  { id:1, contract_number:'SVC-2025-001', customer:'TechCorp Solutions',    type:'Comprehensive AMC', start_date:'2025-04-01', end_date:'2026-03-31', sla_hours:4,  value:480000,  status:'active',   contacts_covered:25 },
  { id:2, contract_number:'SVC-2025-002', customer:'Alpha Manufacturing',   type:'Basic AMC',         start_date:'2025-07-01', end_date:'2026-06-30', sla_hours:8,  value:180000,  status:'active',   contacts_covered:10 },
  { id:3, contract_number:'SVC-2024-003', customer:'BrightFin Ltd',         type:'Premium SLA',       start_date:'2024-10-01', end_date:'2025-09-30', sla_hours:2,  value:720000,  status:'expired',  contacts_covered:40 },
  { id:4, contract_number:'SVC-2026-004', customer:'Global Trade Partners', type:'Comprehensive AMC', start_date:'2026-01-01', end_date:'2026-12-31', sla_hours:4,  value:360000,  status:'active',   contacts_covered:18 },
  { id:5, contract_number:'SVC-2025-005', customer:'MediTech Services',     type:'Premium SLA',       start_date:'2025-06-01', end_date:'2026-05-31', sla_hours:2,  value:960000,  status:'active',   contacts_covered:50 },
  { id:6, contract_number:'SVC-2026-006', customer:'RetailCo Ltd',          type:'Basic AMC',         start_date:'2026-02-01', end_date:'2027-01-31', sla_hours:8,  value:120000,  status:'active',   contacts_covered:8  },
];

// ── ServiceEngineers ──────────────────────────────────────────────────────────
export const SAMPLE_ENGINEERS = [
  { id:1, name:'Vikram Nair',   employee_id:'ENG-001', skills:'Networking, Hardware, CCTV',      location:'Bangalore', status:'on_job',   active_jobs:2, rating:4.7, certifications:'CCNA, CompTIA A+' },
  { id:2, name:'Rohit Gupta',   employee_id:'ENG-002', skills:'Server, Networking, Surveillance',location:'Mumbai',    status:'available',active_jobs:0, rating:4.5, certifications:'MCSE, CCNA' },
  { id:3, name:'Anand Menon',   employee_id:'ENG-003', skills:'Software, ERP, Desktop Support',  location:'Chennai',   status:'on_job',   active_jobs:1, rating:4.8, certifications:'ITIL v4' },
  { id:4, name:'Sneha Iyer',    employee_id:'ENG-004', skills:'Networking, Firewall, VPN',       location:'Pune',      status:'available',active_jobs:0, rating:4.3, certifications:'CCNP' },
  { id:5, name:'Ravi Kumar',    employee_id:'ENG-005', skills:'Hardware, Printer, Desktop',      location:'Delhi',     status:'off',      active_jobs:0, rating:4.6, certifications:'CompTIA A+' },
  { id:6, name:'Kiran Das',     employee_id:'ENG-006', skills:'ERP, Software, Desktop Support',  location:'Hyderabad', status:'on_job',   active_jobs:3, rating:4.4, certifications:'ITIL v4, SAP Cert' },
];
