// Sample data for Recruitment pages — used as fallbacks in development only.
// Each component imports what it needs and guards with import.meta.env.DEV.

// ── CandidatePipeline — job openings (id + title + department) ────────────────
export const SAMPLE_OPENINGS = [
  { id: 1, job_title: 'Senior React Developer', department: 'Engineering' },
  { id: 2, job_title: 'Finance Manager',         department: 'Finance'     },
  { id: 3, job_title: 'Data Analyst',            department: 'Operations'  },
];

// ── CandidatePipeline — candidates (current_stage, score, overall_status) ─────
export const SAMPLE_CANDIDATES_PIPELINE = [
  { id:1,  full_name:'Arjun Mehta',     email:'arjun.m@gmail.com',   phone:'+91 98765 11111', source:'linkedin',   current_stage:'applied',   score:72, role_applied:'Senior React Developer', overall_status:'active' },
  { id:2,  full_name:'Kavitha Iyer',    email:'kavitha@outlook.com', phone:'+91 87654 22222', source:'website',    current_stage:'screening', score:85, role_applied:'Senior React Developer', overall_status:'active' },
  { id:3,  full_name:'Rohit Bansal',    email:'rohit.b@gmail.com',   phone:'+91 76543 33333', source:'referral',   current_stage:'interview', score:91, role_applied:'Senior React Developer', overall_status:'active' },
  { id:4,  full_name:'Sneha Kulkarni',  email:'sneha.k@yahoo.com',   phone:'+91 65432 44444', source:'job_portal', current_stage:'offer',     score:88, role_applied:'Senior React Developer', overall_status:'active' },
  { id:5,  full_name:'Deepak Joshi',    email:'deepak.j@gmail.com',  phone:'+91 54321 55555', source:'campus',     current_stage:'hired',     score:94, role_applied:'Senior React Developer', overall_status:'active' },
  { id:6,  full_name:'Anjali Nair',     email:'anjali.n@gmail.com',  phone:'+91 43210 66666', source:'linkedin',   current_stage:'applied',   score:63, role_applied:'Senior React Developer', overall_status:'active' },
  { id:7,  full_name:'Suresh Pillai',   email:'suresh.p@gmail.com',  phone:'+91 32109 77777', source:'website',    current_stage:'screening', score:79, role_applied:'Finance Manager',        overall_status:'active' },
  { id:8,  full_name:'Meera Varma',     email:'meera.v@gmail.com',   phone:'+91 21098 88888', source:'referral',   current_stage:'applied',   score:55, role_applied:'Data Analyst',           overall_status:'active' },
  { id:9,  full_name:'Kiran Reddy',     email:'kiran.r@gmail.com',   phone:'+91 10987 99999', source:'manual',     current_stage:'interview', score:68, role_applied:'Finance Manager',        overall_status:'rejected' },
];

// ── JobOpenings — full job postings ───────────────────────────────────────────
export const SAMPLE_JOBS = [
  { id:1, job_title:'Senior React Developer',    department:'Engineering', employment_type:'full_time', location:'Bangalore',  number_of_positions:2, positions_filled:0, applicants_count:14, status:'open',   experience_required:'4-6 years',   salary_range:'₹18L - ₹28L', skills_required:'React, Node.js, TypeScript', closing_date:'2026-04-30' },
  { id:2, job_title:'Finance Manager',           department:'Finance',     employment_type:'full_time', location:'Mumbai',     number_of_positions:1, positions_filled:0, applicants_count:8,  status:'open',   experience_required:'6-8 years',   salary_range:'₹20L - ₹30L', skills_required:'CA, SAP, Financial Reporting', closing_date:'2026-04-15' },
  { id:3, job_title:'HR Business Partner',       department:'HR',          employment_type:'full_time', location:'Hyderabad',  number_of_positions:1, positions_filled:1, applicants_count:22, status:'closed', experience_required:'3-5 years',   salary_range:'₹12L - ₹18L', skills_required:'HRBP, PMS, Talent Acquisition', closing_date:'2026-03-15' },
  { id:4, job_title:'Data Analyst',              department:'Operations',  employment_type:'full_time', location:'Chennai',    number_of_positions:2, positions_filled:0, applicants_count:19, status:'open',   experience_required:'2-4 years',   salary_range:'₹10L - ₹16L', skills_required:'Python, SQL, Power BI', closing_date:'2026-05-01' },
  { id:5, job_title:'Sales Executive',           department:'Sales',       employment_type:'full_time', location:'Delhi',      number_of_positions:3, positions_filled:1, applicants_count:31, status:'open',   experience_required:'1-3 years',   salary_range:'₹5L - ₹9L',  skills_required:'B2B Sales, CRM, Cold Calling', closing_date:'2026-04-20' },
  { id:6, job_title:'DevOps Engineer (Intern)',  department:'Engineering', employment_type:'intern',    location:'Bangalore',  number_of_positions:1, positions_filled:0, applicants_count:7,  status:'draft',  experience_required:'Fresher',     salary_range:'₹25K/month',  skills_required:'Linux, Docker, AWS basics', closing_date:'2026-05-15' },
];

// ── OnboardingChecklist — new hires ───────────────────────────────────────────
export const SAMPLE_NEW_HIRES = [
  { id:1, name:'Roshni Kapoor',  designation:'Senior Developer',  department:'Engineering', joining_date:'2026-03-10', email:'roshni@company.com' },
  { id:2, name:'Karthik Rajan',  designation:'DevOps Intern',      department:'Engineering', joining_date:'2026-03-17', email:'karthik@company.com' },
  { id:3, name:'Fatima Sheikh',  designation:'HR Executive',       department:'HR',          joining_date:'2026-03-20', email:'fatima@company.com' },
];

// ── RecruitmentDashboard — open positions ─────────────────────────────────────
export const SAMPLE_POSITIONS = [
  { id: 1, title: 'Senior React Developer',   department: 'Engineering', location: 'Bangalore',   openings: 2, applicants: 18, stage: 'Interviewing', priority: 'high',   posted: 'Feb 10 2026' },
  { id: 2, title: 'Product Manager',           department: 'Product',     location: 'Remote',      openings: 1, applicants: 34, stage: 'Screening',    priority: 'high',   posted: 'Feb 18 2026' },
  { id: 3, title: 'DevOps Engineer',           department: 'Engineering', location: 'Hyderabad',   openings: 1, applicants: 12, stage: 'Interviewing', priority: 'medium', posted: 'Jan 28 2026' },
  { id: 4, title: 'UX Designer',               department: 'Design',      location: 'Bangalore',   openings: 2, applicants: 26, stage: 'Offer',        priority: 'medium', posted: 'Jan 20 2026' },
  { id: 5, title: 'Data Analyst',              department: 'Analytics',   location: 'Pune',        openings: 1, applicants: 22, stage: 'Screening',    priority: 'low',    posted: 'Feb 25 2026' },
];

// ── RecruitmentDashboard — candidates (stage, rating, avatar) ─────────────────
export const SAMPLE_CANDIDATES_DASHBOARD = [
  { id: 1,  name: 'Arjun Mehta',    role: 'Senior React Developer', stage: 'Interview',  rating: 4, email: 'arjun@email.com',  phone: '+91 98765 43210', applied: 'Feb 12', avatar: 'AM' },
  { id: 2,  name: 'Priya Sharma',   role: 'Product Manager',        stage: 'Screening',  rating: 5, email: 'priya@email.com',  phone: '+91 87654 32109', applied: 'Feb 19', avatar: 'PS' },
  { id: 3,  name: 'Rohan Verma',    role: 'DevOps Engineer',        stage: 'Offer',      rating: 4, email: 'rohan@email.com',  phone: '+91 76543 21098', applied: 'Jan 30', avatar: 'RV' },
  { id: 4,  name: 'Sneha Iyer',     role: 'UX Designer',            stage: 'Hired',      rating: 5, email: 'sneha@email.com',  phone: '+91 65432 10987', applied: 'Jan 22', avatar: 'SI' },
  { id: 5,  name: 'Kiran Rao',      role: 'Data Analyst',           stage: 'Applied',    rating: 3, email: 'kiran@email.com',  phone: '+91 54321 09876', applied: 'Feb 26', avatar: 'KR' },
  { id: 6,  name: 'Anjali Das',     role: 'Senior React Developer', stage: 'Screening',  rating: 4, email: 'anjali@email.com', phone: '+91 43210 98765', applied: 'Feb 14', avatar: 'AD' },
  { id: 7,  name: 'Vikram Nair',    role: 'UX Designer',            stage: 'Interview',  rating: 3, email: 'vikram@email.com', phone: '+91 32109 87654', applied: 'Jan 25', avatar: 'VN' },
  { id: 8,  name: 'Deepa Pillai',   role: 'Product Manager',        stage: 'Interview',  rating: 5, email: 'deepa@email.com',  phone: '+91 21098 76543', applied: 'Feb 20', avatar: 'DP' },
];

// ── RecruitmentDashboard — scheduled interviews ───────────────────────────────
export const SAMPLE_INTERVIEWS = [
  { id: 1, candidate: 'Arjun Mehta',   role: 'Senior React Developer', date: 'Mar 16 2026', time: '10:00 AM', type: 'Technical', interviewer: 'Suresh Kumar',  status: 'scheduled' },
  { id: 2, candidate: 'Deepa Pillai',  role: 'Product Manager',        date: 'Mar 16 2026', time: '2:30 PM',  type: 'HR',        interviewer: 'Meera Joshi',   status: 'scheduled' },
  { id: 3, candidate: 'Vikram Nair',   role: 'UX Designer',            date: 'Mar 17 2026', time: '11:00 AM', type: 'Portfolio', interviewer: 'Anand Rao',     status: 'scheduled' },
  { id: 4, candidate: 'Anjali Das',    role: 'Senior React Developer', date: 'Mar 18 2026', time: '3:00 PM',  type: 'Technical', interviewer: 'Suresh Kumar',  status: 'pending' },
];

// ── RecruitmentDashboard — pipeline funnel counts ─────────────────────────────
export const SAMPLE_PIPELINE_COUNTS = [
  { stage: 'Applied',   count: 112, color: '#94a3b8' },
  { stage: 'Screening', count: 64,  color: '#60a5fa' },
  { stage: 'Interview', count: 28,  color: '#a78bfa' },
  { stage: 'Offer',     count: 9,   color: '#f59e0b' },
  { stage: 'Hired',     count: 5,   color: '#22c55e' },
];

// ── RecruitmentDashboard — candidate source breakdown ─────────────────────────
export const SAMPLE_SOURCE = [
  { name: 'LinkedIn',   value: 42 },
  { name: 'Naukri',     value: 28 },
  { name: 'Referral',   value: 18 },
  { name: 'Website',    value: 12 },
];

// ── JobRequisitionPipeline — requisitions ─────────────────────────────────────
export const SAMPLE_REQUISITIONS = [
  { id: 1, requisition_id: 'REQ-2026-001', title: 'Senior React Developer', department: 'Engineering', openings: 2, applicants: 14, stage: 'Interviewing', posted_date: '2026-02-10', status: 'open' },
  { id: 2, requisition_id: 'REQ-2026-002', title: 'HR Business Partner',    department: 'HR',          openings: 1, applicants: 8,  stage: 'Screening',    posted_date: '2026-02-18', status: 'open' },
  { id: 3, requisition_id: 'REQ-2026-003', title: 'Financial Analyst',      department: 'Finance',     openings: 1, applicants: 0,  stage: 'Draft',        posted_date: null,         status: 'draft' },
  { id: 4, requisition_id: 'REQ-2026-004', title: 'Sales Executive',        department: 'Sales',       openings: 3, applicants: 22, stage: 'Offer',        posted_date: '2026-01-15', status: 'open' },
  { id: 5, requisition_id: 'REQ-2026-005', title: 'Backend Engineer',       department: 'Engineering', openings: 2, applicants: 18, stage: 'Filled',       posted_date: '2025-12-01', status: 'filled' },
];

// ── OfferManagement — offers ───────────────────────────────────────────────────
export const SAMPLE_OFFERS = [
  { id: 1, candidate_name: 'Vikram Singh', role: 'Senior React Developer', department: 'Engineering', offer_date: '2026-03-10', ctc: 1800000, status: 'pending',  expiry_date: '2026-03-20' },
  { id: 2, candidate_name: 'Meera Joshi',  role: 'HR Business Partner',    department: 'HR',          offer_date: '2026-03-08', ctc: 850000,  status: 'accepted', expiry_date: '2026-03-18' },
  { id: 3, candidate_name: 'Suresh Nair',  role: 'Sales Executive',        department: 'Sales',       offer_date: '2026-03-05', ctc: 720000,  status: 'rejected', expiry_date: '2026-03-15' },
  { id: 4, candidate_name: 'Anil Kumar',   role: 'Backend Engineer',       department: 'Engineering', offer_date: '2026-02-20', ctc: 1500000, status: 'expired',  expiry_date: '2026-03-01' },
  { id: 5, candidate_name: 'Divya Rao',    role: 'Financial Analyst',      department: 'Finance',     offer_date: '2026-03-15', ctc: 900000,  status: 'pending',  expiry_date: '2026-03-25' },
];
