// Sample data for Projects pages — used as fallbacks in development only.
// Each component imports what it needs and guards with import.meta.env.DEV.
// All names disambiguated to avoid clashes across files.

// ── KanbanBoard — minimal project list (id + name only) ───────────────────────
export const SAMPLE_PROJECTS_MINIMAL = [
  { id: 1, project_name: 'ERP Implementation - TechCorp' },
  { id: 2, project_name: 'Cloud Migration - Alpha Mfg'   },
  { id: 3, project_name: 'Mobile App - BrightFin'        },
];

// ── KanbanBoard — kanban task objects ─────────────────────────────────────────
export const SAMPLE_TASKS_KANBAN = [
  { id:1, task_title:'Review API integration docs',   task_description:'Check all endpoint docs', status:'in_progress', priority:'high',     assigned_to_name:'Rajesh K',  due_date:'2026-03-20', project_id:1 },
  { id:2, task_title:'Update deployment checklist',   task_description:'',                         status:'todo',        priority:'medium',   assigned_to_name:'Priya S',   due_date:'2026-03-22', project_id:1 },
  { id:3, task_title:'UAT sign-off meeting',          task_description:'',                         status:'todo',        priority:'high',     assigned_to_name:'Anand M',   due_date:'2026-03-18', project_id:1 },
  { id:4, task_title:'Fix auth middleware bug',       task_description:'JWT refresh not working',  status:'in_progress', priority:'critical', assigned_to_name:'Rajesh K',  due_date:'2026-03-17', project_id:1 },
  { id:5, task_title:'Write unit tests for invoices', task_description:'',                         status:'review',      priority:'medium',   assigned_to_name:'Sunita R',  due_date:'2026-03-25', project_id:1 },
  { id:6, task_title:'DB schema migration script',   task_description:'V3 to V4',                 status:'done',        priority:'high',     assigned_to_name:'Priya S',   due_date:'2026-03-10', project_id:1 },
  { id:7, task_title:'Set up CI/CD pipeline',        task_description:'',                         status:'done',        priority:'medium',   assigned_to_name:'Anand M',   due_date:'2026-03-08', project_id:1 },
  { id:8, task_title:'Design cloud architecture',    task_description:'',                         status:'in_progress', priority:'high',     assigned_to_name:'Ravi K',    due_date:'2026-03-25', project_id:2 },
  { id:9, task_title:'Migrate staging DB',           task_description:'',                         status:'todo',        priority:'medium',   assigned_to_name:'Vikram N',  due_date:'2026-04-01', project_id:2 },
];

// ── ProjectDetail — tasks (assignee_name, no project_id) ─────────────────────
export const SAMPLE_TASKS_DETAIL = [
  { id: 1, task_title: 'Requirements gathering',       status: 'done',        priority: 'High',   assignee_name: 'Rajesh K', due_date: '2025-01-15' },
  { id: 2, task_title: 'System design & architecture', status: 'done',        priority: 'High',   assignee_name: 'Priya S',  due_date: '2025-01-31' },
  { id: 3, task_title: 'Database schema design',       status: 'in_progress', priority: 'High',   assignee_name: 'Anand M',  due_date: '2025-02-15' },
  { id: 4, task_title: 'API integration setup',        status: 'in_progress', priority: 'Medium', assignee_name: 'Rajesh K', due_date: '2025-02-20' },
  { id: 5, task_title: 'Frontend development',         status: 'todo',        priority: 'Medium', assignee_name: 'Priya S',  due_date: '2025-03-01' },
  { id: 6, task_title: 'UAT testing',                  status: 'todo',        priority: 'High',   assignee_name: 'Ravi K',   due_date: '2025-03-15' },
  { id: 7, task_title: 'Performance optimization',     status: 'review',      priority: 'Low',    assignee_name: 'Anand M',  due_date: '2025-02-28' },
];

// ── ProjectDetail — team members ──────────────────────────────────────────────
export const SAMPLE_TEAM = [
  { id: 1, name: 'Rajesh Kumar', role: 'Project Manager', avatar: 'RK' },
  { id: 2, name: 'Priya Sharma', role: 'Lead Developer',  avatar: 'PS' },
  { id: 3, name: 'Anand Menon',  role: 'Backend Dev',     avatar: 'AM' },
  { id: 4, name: 'Ravi Kumar',   role: 'QA Engineer',     avatar: 'RK' },
];

// ── Projects.jsx — full project data (canonical) ──────────────────────────────
export const SAMPLE_PROJECTS = [
  { id:1, project_code:'PROJ-001', project_name:'ERP Implementation - TechCorp',  customer_name:'TechCorp Solutions',   manager_name:'Rajesh K', status:'active',    budget_amount:2500000, actual_cost:1200000, total_tasks:24, completed_tasks:14, end_date:'2026-06-30', team_size:6 },
  { id:2, project_code:'PROJ-002', project_name:'Cloud Migration - Alpha Mfg',     customer_name:'Alpha Manufacturing',  manager_name:'Priya S',  status:'active',    budget_amount:1800000, actual_cost:950000,  total_tasks:18, completed_tasks:8,  end_date:'2026-05-31', team_size:4 },
  { id:3, project_code:'PROJ-003', project_name:'Mobile App - BrightFin',          customer_name:'BrightFin Ltd',        manager_name:'Anand M',  status:'planning',  budget_amount:800000,  actual_cost:45000,   total_tasks:32, completed_tasks:2,  end_date:'2026-09-30', team_size:3 },
  { id:4, project_code:'PROJ-004', project_name:'Security Audit - Global Trade',   customer_name:'Global Trade Partners', manager_name:'Ravi K',  status:'on_hold',   budget_amount:450000,  actual_cost:280000,  total_tasks:12, completed_tasks:8,  end_date:'2025-12-31', team_size:2 },
  { id:5, project_code:'PROJ-005', project_name:'Data Analytics - MediTech',       customer_name:'MediTech Services',    manager_name:'Rajesh K', status:'active',    budget_amount:1200000, actual_cost:980000,  total_tasks:20, completed_tasks:16, end_date:'2026-04-15', team_size:5 },
  { id:6, project_code:'PROJ-006', project_name:'CRM Integration - RetailCo',      customer_name:'RetailCo Ltd',         manager_name:'Priya S',  status:'completed', budget_amount:600000,  actual_cost:590000,  total_tasks:15, completed_tasks:15, end_date:'2025-11-30', team_size:3 },
];

// ── ProjectsDashboard — project data (different end_dates from Projects.jsx) ──
export const SAMPLE_PROJECTS_DASHBOARD = [
  { id: 1, project_code: 'PROJ-001', project_name: 'ERP Implementation - TechCorp',   customer_name: 'TechCorp Solutions',   manager_name: 'Rajesh K', status: 'active',    budget_amount: 2500000, actual_cost: 1200000, total_tasks: 24, completed_tasks: 14, end_date: '2025-03-31', team_size: 6 },
  { id: 2, project_code: 'PROJ-002', project_name: 'Cloud Migration - Alpha Mfg',      customer_name: 'Alpha Manufacturing',  manager_name: 'Priya S',  status: 'active',    budget_amount: 1800000, actual_cost: 950000,  total_tasks: 18, completed_tasks: 8,  end_date: '2025-02-28', team_size: 4 },
  { id: 3, project_code: 'PROJ-003', project_name: 'Mobile App - BrightFin',           customer_name: 'BrightFin Ltd',        manager_name: 'Anand M',  status: 'planning',  budget_amount: 800000,  actual_cost: 45000,   total_tasks: 32, completed_tasks: 2,  end_date: '2025-06-30', team_size: 3 },
  { id: 4, project_code: 'PROJ-004', project_name: 'Security Audit - Global Trade',    customer_name: 'Global Trade Partners', manager_name: 'Ravi K', status: 'on_hold',   budget_amount: 450000,  actual_cost: 280000,  total_tasks: 12, completed_tasks: 8,  end_date: '2024-12-31', team_size: 2 },
  { id: 5, project_code: 'PROJ-005', project_name: 'Data Analytics - MediTech',        customer_name: 'MediTech Services',    manager_name: 'Rajesh K', status: 'active',    budget_amount: 1200000, actual_cost: 980000,  total_tasks: 20, completed_tasks: 16, end_date: '2025-01-15', team_size: 5 },
  { id: 6, project_code: 'PROJ-006', project_name: 'CRM Integration - RetailCo',       customer_name: 'RetailCo Ltd',         manager_name: 'Priya S',  status: 'completed', budget_amount: 600000,  actual_cost: 590000,  total_tasks: 15, completed_tasks: 15, end_date: '2024-11-30', team_size: 3 },
];

// ── ProjectsDashboard — tasks due today ───────────────────────────────────────
export const SAMPLE_TASKS_TODAY = [
  { id: 1, task_title: 'Review API integration docs',    project_name: 'ERP Implementation', priority: 'High',   status: 'in_progress' },
  { id: 2, task_title: 'Update deployment checklist',    project_name: 'Cloud Migration',     priority: 'Medium', status: 'todo' },
  { id: 3, task_title: 'UAT sign-off meeting',           project_name: 'Data Analytics',      priority: 'High',   status: 'todo' },
];
