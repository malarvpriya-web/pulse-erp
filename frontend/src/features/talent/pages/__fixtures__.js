// Sample data for Talent pages — used as fallbacks in development only.
// Guard every usage with import.meta.env.DEV.

// ── RecruiterDashboard ────────────────────────────────────────────────────────
export const SAMPLE_RECRUITER_KPI = {
  open_positions:    18,
  active_candidates: 74,
  interviews_week:   12,
  offers_pending:    5,
};

export const SAMPLE_PIPELINE_STAGES = [
  { stage: 'Applied',    count: 148 },
  { stage: 'Screened',   count: 89  },
  { stage: 'Interview',  count: 42  },
  { stage: 'Offer',      count: 11  },
  { stage: 'Hired',      count: 6   },
];

export const SAMPLE_RECRUITER_ACTIVITY = [
  { id:1, action:'Shortlisted',  candidate:'Rahul Sharma',    role:'Sr. Backend Engineer',    time:'2h ago',  recruiter:'Priya Menon' },
  { id:2, action:'Interview Set',candidate:'Anjali Bose',     role:'UX Designer',             time:'3h ago',  recruiter:'Karan Verma' },
  { id:3, action:'Offer Sent',   candidate:'Mohit Agarwal',   role:'Product Manager',         time:'5h ago',  recruiter:'Priya Menon' },
  { id:4, action:'Rejected',     candidate:'Sunita Rao',      role:'QA Analyst',              time:'1d ago',  recruiter:'Karan Verma' },
  { id:5, action:'Hired',        candidate:'Deepak Kumar',    role:'DevOps Engineer',         time:'1d ago',  recruiter:'Priya Menon' },
];

export const SAMPLE_RECRUITER_DEPARTMENTS = ['Engineering', 'Product', 'Design', 'Sales', 'HR', 'Finance'];

// ── RecruitmentAgencies ───────────────────────────────────────────────────────
export const SAMPLE_AGENCIES = [
  { id:1, name:'TalentBridge India',   specialization:'Technology',   contact:'contact@talentbridge.in', phone:'+91 98765 43210', active_roles:8,  success_rate:72, status:'active'   },
  { id:2, name:'PeoplePro Consulting', specialization:'Finance & HR', contact:'hr@peoplepro.co.in',      phone:'+91 87654 32109', active_roles:5,  success_rate:65, status:'active'   },
  { id:3, name:'HireRight Solutions',  specialization:'Technology',   contact:'info@hireright.in',        phone:'+91 76543 21098', active_roles:3,  success_rate:58, status:'active'   },
  { id:4, name:'ExecSearch Partners',  specialization:'Executive',    contact:'exec@execsearch.in',       phone:'+91 65432 10987', active_roles:2,  success_rate:80, status:'active'   },
  { id:5, name:'QuickHire India',      specialization:'Mass Hiring',  contact:'ops@quickhire.in',         phone:'+91 54321 09876', active_roles:0,  success_rate:45, status:'inactive' },
  { id:6, name:'NicheRecruit',         specialization:'Design & UX',  contact:'hello@nicherecruit.in',    phone:'+91 43210 98765', active_roles:1,  success_rate:70, status:'active'   },
];

// ── ResumeDatabase ────────────────────────────────────────────────────────────
export const SAMPLE_RESUMES = [
  { id:1, name:'Rahul Sharma',    current_role:'Sr. Software Engineer', experience:6, location:'Bangalore', skills:'React, Node.js, AWS',         status:'shortlisted', email:'rahul.s@email.com',   summary:'6 years of full-stack development experience with strong AWS background.' },
  { id:2, name:'Anjali Bose',     current_role:'UX Designer',           experience:4, location:'Mumbai',    skills:'Figma, UX Research, Prototyping', status:'new',         email:'anjali.b@email.com',  summary:'Creative UX designer with 4 years building B2B SaaS products.' },
  { id:3, name:'Mohit Agarwal',   current_role:'Product Manager',       experience:7, location:'Delhi',     skills:'Product Strategy, Agile, SQL', status:'reviewed',    email:'mohit.a@email.com',   summary:'PM with 7 years across fintech and edtech verticals.' },
  { id:4, name:'Sunita Rao',      current_role:'QA Analyst',            experience:3, location:'Hyderabad', skills:'Selenium, JIRA, API Testing',  status:'reviewed',    email:'sunita.r@email.com',  summary:'QA specialist with automation testing expertise.' },
  { id:5, name:'Deepak Kumar',    current_role:'DevOps Engineer',       experience:5, location:'Pune',      skills:'Docker, Kubernetes, CI/CD',    status:'shortlisted', email:'deepak.k@email.com',  summary:'DevOps engineer with strong container orchestration skills.' },
  { id:6, name:'Kavita Pillai',   current_role:'Data Analyst',          experience:2, location:'Chennai',   skills:'Python, SQL, Tableau',         status:'new',         email:'kavita.p@email.com',  summary:'Data analyst transitioning from academic research into industry.' },
  { id:7, name:'Arjun Reddy',     current_role:'Backend Engineer',      experience:4, location:'Bangalore', skills:'Java, Spring Boot, Kafka',     status:'shortlisted', email:'arjun.r@email.com',   summary:'Backend engineer specializing in high-throughput distributed systems.' },
  { id:8, name:'Neha Joshi',      current_role:'HR Business Partner',   experience:8, location:'Mumbai',    skills:'HR Strategy, HRBP, Talent Mgmt', status:'new',       email:'neha.j@email.com',    summary:'Seasoned HRBP with experience across IT and manufacturing sectors.' },
];

// ── InterviewQuestionBank ─────────────────────────────────────────────────────
export const SAMPLE_QUESTIONS = [
  { id:1,  text:'Explain the difference between REST and GraphQL APIs.',                         category:'Technical',   difficulty:'Medium', usage_count:34 },
  { id:2,  text:'How do you handle state management in large React applications?',                category:'Technical',   difficulty:'Hard',   usage_count:28 },
  { id:3,  text:'Describe a time you resolved a conflict within your team.',                      category:'Behavioral',  difficulty:'Medium', usage_count:52 },
  { id:4,  text:'Where do you see yourself in 5 years?',                                         category:'HR',          difficulty:'Easy',   usage_count:89 },
  { id:5,  text:'A client\'s revenue dropped 20% in Q3. How do you identify the root cause?',    category:'Case Study',  difficulty:'Hard',   usage_count:15 },
  { id:6,  text:'What is your greatest professional weakness?',                                   category:'HR',          difficulty:'Easy',   usage_count:76 },
  { id:7,  text:'Explain database indexing and when you would avoid adding an index.',            category:'Technical',   difficulty:'Medium', usage_count:22 },
  { id:8,  text:'Tell me about a project you failed and what you learned.',                       category:'Behavioral',  difficulty:'Medium', usage_count:41 },
  { id:9,  text:'How would you prioritize a backlog with 50 items and a 2-week sprint?',          category:'Case Study',  difficulty:'Medium', usage_count:19 },
  { id:10, text:'What motivates you to perform at your best?',                                    category:'HR',          difficulty:'Easy',   usage_count:63 },
];

// ── TalentPools ───────────────────────────────────────────────────────────────
export const SAMPLE_POOLS = [
  { id:1, name:'Frontend Engineers',    description:'React/Vue/Angular specialists for product team openings', candidate_count:34, last_updated:'2026-03-20', tags:['React', 'Frontend', 'JavaScript'], status:'active' },
  { id:2, name:'Backend Engineers',     description:'Node.js, Java, Python backend talent pipeline',           candidate_count:48, last_updated:'2026-03-18', tags:['Node.js', 'Java', 'Backend'],       status:'active' },
  { id:3, name:'Product Managers',      description:'PMs with B2B SaaS and agile experience',                 candidate_count:19, last_updated:'2026-03-15', tags:['Product', 'Agile', 'B2B'],          status:'active' },
  { id:4, name:'UX/UI Designers',       description:'Figma-first designers from leading tech companies',       candidate_count:22, last_updated:'2026-03-10', tags:['UX', 'Figma', 'Design'],            status:'active' },
  { id:5, name:'Data & Analytics',      description:'Data scientists and analysts for BI and ML roles',        candidate_count:15, last_updated:'2026-03-08', tags:['Python', 'SQL', 'Data'],            status:'active' },
  { id:6, name:'Sales Executives',      description:'Enterprise sales reps with SaaS deal experience',         candidate_count:27, last_updated:'2026-02-28', tags:['Sales', 'SaaS', 'Enterprise'],      status:'paused' },
];
