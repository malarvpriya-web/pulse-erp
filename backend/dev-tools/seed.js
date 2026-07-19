import pool from './src/config/db.js';
import bcrypt from 'bcryptjs';

async function seed() {
  console.log('🌱 Seeding database...');

  const hash = await bcrypt.hash('password123', 10);

  // ── users ────────────────────────────────────────────────────────────
  await pool.query(`
    INSERT INTO users (name, email, password_hash, role, department, is_active)
    VALUES
      ('Super Admin',    'admin@pulse.com',   '${hash}', 'super_admin', 'Management', true),
      ('Finance Manager','finance@pulse.com', '${hash}', 'manager',     'Finance',    true),
      ('HR Manager',     'hr@pulse.com',      '${hash}', 'manager',     'HR',         true),
      ('John Employee',  'john@pulse.com',    '${hash}', 'employee',    'Finance',    true),
      ('Sara Employee',  'sara@pulse.com',    '${hash}', 'employee',    'HR',         true)
    ON CONFLICT (email) DO NOTHING
  `).catch(e => console.log('Users:', e.message));

  // ── employees (use DO UPDATE to handle any existing unique constraint) ─
  const empRows = [
    ['Arjun',   'Kumar',   'arjun@pulse.com',   'Engineering', 'Senior Developer',  '2023-01-15'],
    ['Priya',   'Sharma',  'priya@pulse.com',   'Finance',     'Finance Analyst',   '2023-03-20'],
    ['Ravi',    'Patel',   'ravi@pulse.com',    'HR',          'HR Executive',      '2023-02-10'],
    ['Anitha',  'Reddy',   'anitha@pulse.com',  'Sales',       'Sales Manager',     '2022-11-05'],
    ['Vikram',  'Nair',    'vikram@pulse.com',  'Engineering', 'Frontend Dev',      '2024-01-08'],
    ['Deepa',   'Menon',   'deepa@pulse.com',   'Marketing',   'Marketing Lead',    '2023-06-15'],
    ['Suresh',  'Rao',     'suresh@pulse.com',  'Operations',  'Ops Manager',       '2022-08-20'],
    ['Kavitha', 'Singh',   'kavitha@pulse.com', 'Finance',     'Accountant',        '2024-02-01'],
    ['Mohan',   'Das',     'mohan@pulse.com',   'Engineering', 'Backend Dev',       '2023-09-12'],
    ['Lakshmi', 'Iyer',    'lakshmi@pulse.com', 'HR',          'HR Manager',        '2022-05-18'],
  ];
  for (const [fn, ln, email, dept, desig, join_date] of empRows) {
    await pool.query(
      `INSERT INTO employees (name, first_name, last_name, company_email, department, designation, joining_date, employment_type, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Full-time','Active')`,
      [`${fn} ${ln}`, fn, ln, email, dept, desig, join_date]
    ).catch(() => {}); // skip if duplicate
  }
  console.log('Employees: done');

  // ── leaves (uses employee_id, from_date, to_date per actual schema) ───
  const empIdRows = await pool.query(
    `SELECT id FROM employees ORDER BY id LIMIT 7`
  ).catch(() => ({ rows: [] }));
  const empIds = empIdRows.rows.map(r => r.id);
  if (empIds.length >= 7) {
    const leaveData = [
      [empIds[0], 'Annual', '2026-03-20', '2026-03-22', 3,   'pending',  'Family function'],
      [empIds[1], 'Sick',   '2026-03-15', '2026-03-15', 1,   'pending',  'Not feeling well'],
      [empIds[2], 'Annual', '2026-03-25', '2026-03-28', 4,   'pending',  'Vacation'],
      [empIds[3], 'Casual', '2026-03-18', '2026-03-18', 1,   'approved', 'Personal work'],
      [empIds[4], 'Sick',   '2026-03-10', '2026-03-11', 2,   'approved', 'Fever'],
      [empIds[5], 'Annual', '2026-04-01', '2026-04-05', 5,   'pending',  'Annual leave'],
      [empIds[6], 'Casual', '2026-03-17', '2026-03-17', 1,   'rejected', 'Personal'],
    ];
    for (const [eid, type, start, end, days, status, reason] of leaveData) {
      await pool.query(
        `INSERT INTO leaves (employee_id, leave_type, start_date, end_date, days, status, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [eid, type, start, end, days, status, reason]
      ).catch(() => {});
    }
  }
  console.log('Leaves: done');

  // ── invoices (party_name compatible — customer_id stays NULL for seed) ─
  await pool.query(`
    INSERT INTO invoices (invoice_number, party_name, total_amount, status, due_date, invoice_date, balance, created_at)
    VALUES
      ('INV-001', 'TechCorp Ltd',      125000, 'paid',    '2026-02-28', '2026-01-15', 0,      '2026-01-15'),
      ('INV-002', 'Global Services',    87500, 'paid',    '2026-02-15', '2026-01-20', 0,      '2026-01-20'),
      ('INV-003', 'Alpha Solutions',   145000, 'pending', '2026-03-30', '2026-02-10', 145000, '2026-02-10'),
      ('INV-004', 'Beta Systems',       62000, 'pending', '2026-03-25', '2026-02-18', 62000,  '2026-02-18'),
      ('INV-005', 'Gamma Corp',         93000, 'overdue', '2026-03-01', '2026-02-01', 93000,  '2026-02-01'),
      ('INV-006', 'Delta Industries',  110000, 'paid',    '2026-03-10', '2026-02-20', 0,      '2026-02-20'),
      ('INV-007', 'Epsilon Tech',       78000, 'pending', '2026-04-05', '2026-03-01', 78000,  '2026-03-01'),
      ('INV-008', 'Zeta Partners',     156000, 'paid',    '2026-03-05', '2026-02-05', 0,      '2026-02-05'),
      ('INV-009', 'Eta Enterprises',    44000, 'overdue', '2026-02-20', '2026-01-25', 44000,  '2026-01-25'),
      ('INV-010', 'Theta Group',        98000, 'pending', '2026-04-10', '2026-03-08', 98000,  '2026-03-08'),
      ('INV-011', 'TechCorp Ltd',       73000, 'paid',    '2026-03-12', '2026-02-12', 0,      '2026-02-12'),
      ('INV-012', 'Alpha Solutions',   134000, 'paid',    '2026-03-20', '2026-02-20', 0,      '2026-02-20')
    ON CONFLICT (invoice_number) DO NOTHING
  `).catch(e => console.log('Invoices:', e.message));

  // ── supplier bills ─────────────────────────────────────────────────────
  await pool.query(`
    INSERT INTO bills (bill_number, party_name, amount, total_amount, status, due_date, bill_date, balance, created_at)
    VALUES
      ('BILL-001', 'Office Supplies Co',  12000, 12000, 'pending', '2026-03-20', '2026-03-01', 12000, '2026-03-01'),
      ('BILL-002', 'Cloud Services Ltd',  28000, 28000, 'pending', '2026-03-25', '2026-03-05', 28000, '2026-03-05'),
      ('BILL-003', 'Marketing Agency',    45000, 45000, 'pending', '2026-03-28', '2026-03-08', 45000, '2026-03-08'),
      ('BILL-004', 'IT Hardware Store',   18500, 18500, 'paid',    '2026-03-10', '2026-02-20', 0,     '2026-02-20'),
      ('BILL-005', 'Office Supplies Co',  9200,  9200,  'paid',    '2026-02-28', '2026-02-01', 0,     '2026-02-01'),
      ('BILL-006', 'Cloud Services Ltd',  28000, 28000, 'overdue', '2026-03-01', '2026-02-10', 28000, '2026-02-10')
    ON CONFLICT (bill_number) DO NOTHING
  `).catch(e => console.log('Bills:', e.message));

  // ── expense claims ─────────────────────────────────────────────────────
  await pool.query(`
    INSERT INTO expense_claims (claim_number, employee_email, category, amount, total_amount, status, description, created_at)
    VALUES
      ('EXP-001', 'arjun@pulse.com',   'Travel',     4500,  4500,  'approved', 'Client visit Chennai',   '2026-03-01'),
      ('EXP-002', 'priya@pulse.com',   'IT',         12000, 12000, 'pending',  'Software license',       '2026-03-05'),
      ('EXP-003', 'deepa@pulse.com',   'Marketing',  35000, 35000, 'approved', 'Campaign materials',     '2026-03-08'),
      ('EXP-004', 'vikram@pulse.com',  'Travel',     8200,  8200,  'pending',  'Conference Bangalore',   '2026-03-10'),
      ('EXP-005', 'suresh@pulse.com',  'Operations', 22000, 22000, 'approved', 'Office supplies',        '2026-03-12'),
      ('EXP-006', 'kavitha@pulse.com', 'Training',   15000, 15000, 'pending',  'Accounting workshop',    '2026-03-14'),
      ('EXP-007', 'mohan@pulse.com',   'IT',         9800,  9800,  'approved', 'Dev tools subscription', '2026-03-02'),
      ('EXP-008', 'ravi@pulse.com',    'Travel',     3200,  3200,  'approved', 'Office commute',         '2026-03-06')
    ON CONFLICT (claim_number) DO NOTHING
  `).catch(e => console.log('Expenses:', e.message));

  // ── CRM leads ──────────────────────────────────────────────────────────
  await pool.query(`
    INSERT INTO crm_leads (lead_name, company, email, phone, source, status, owner, lead_score, notes)
    VALUES
      ('Rajesh Kumar',    'InfoTech Solutions',  'rajesh@infotech.com',  '9812345678', 'Website',    'Qualified',  'Anitha Reddy', 85, 'Interested in ERP'),
      ('Sunita Patel',    'Global Dynamics',     'sunita@globaldyn.com', '9823456789', 'Referral',   'New',        'Anitha Reddy', 60, 'Cold outreach'),
      ('Amir Khan',       'TechStart Inc',       'amir@techstart.com',   '9834567890', 'LinkedIn',   'Contacted',  'Anitha Reddy', 72, 'Demo scheduled'),
      ('Preethi Nair',    'Apex Systems',        'preethi@apex.com',     '9845678901', 'Exhibition', 'Qualified',  'Deepa Menon',  78, 'RFP received'),
      ('Dev Sharma',      'NextGen Corp',        'dev@nextgen.com',      '9856789012', 'Website',    'New',        'Deepa Menon',  45, 'Needs follow-up'),
      ('Meera Iyer',      'Precision Ltd',       'meera@precision.com',  '9867890123', 'Referral',   'Negotiation','Anitha Reddy', 92, 'Proposal sent'),
      ('Kiran Bose',      'DataFlow Systems',    'kiran@dataflow.com',   '9878901234', 'Cold Call',  'Contacted',  'Deepa Menon',  55, 'Initial call done'),
      ('Ashish Rao',      'CloudEdge India',     'ashish@cloudedge.com', '9889012345', 'Website',    'Lost',       'Anitha Reddy', 30, 'Chose competitor')
    ON CONFLICT DO NOTHING
  `).catch(e => console.log('CRM Leads:', e.message));

  // ── CRM opportunities ──────────────────────────────────────────────────
  await pool.query(`
    INSERT INTO crm_opportunities (title, company, contact, value, stage, probability, expected_close, owner)
    VALUES
      ('ERP Implementation',        'InfoTech Solutions', 'Rajesh Kumar',  850000, 'proposal',      70, '2026-04-30', 'Anitha Reddy'),
      ('Cloud Migration Project',   'Apex Systems',       'Preethi Nair',  540000, 'negotiation',   85, '2026-03-31', 'Anitha Reddy'),
      ('HR Module Upgrade',         'Global Dynamics',    'Sunita Patel',  220000, 'qualification', 40, '2026-05-31', 'Deepa Menon'),
      ('Finance Module License',    'NextGen Corp',       'Dev Sharma',    180000, 'prospecting',   20, '2026-06-30', 'Deepa Menon'),
      ('Annual SaaS Subscription',  'Precision Ltd',      'Meera Iyer',    360000, 'negotiation',   90, '2026-03-25', 'Anitha Reddy'),
      ('Custom Integration Work',   'TechStart Inc',      'Amir Khan',     120000, 'proposal',      60, '2026-04-15', 'Deepa Menon')
    ON CONFLICT DO NOTHING
  `).catch(e => console.log('CRM Opportunities:', e.message));

  // ── CRM accounts ──────────────────────────────────────────────────────
  await pool.query(`
    INSERT INTO crm_accounts (account_name, industry, website, phone, email, account_type, annual_revenue, employees_count, owner, status)
    VALUES
      ('InfoTech Solutions',  'Technology',    'www.infotech.com',   '0441234567', 'info@infotech.com',   'Customer',   25000000, 250, 'Anitha Reddy', 'Active'),
      ('Global Dynamics',     'Manufacturing', 'www.globaldyn.com',  '0442345678', 'info@globaldyn.com',  'Prospect',   45000000, 500, 'Anitha Reddy', 'Active'),
      ('Apex Systems',        'IT Services',   'www.apex.com',       '0443456789', 'info@apex.com',       'Customer',   18000000, 180, 'Deepa Menon',  'Active'),
      ('NextGen Corp',        'FMCG',          'www.nextgen.com',    '0444567890', 'info@nextgen.com',    'Prospect',   60000000, 800, 'Deepa Menon',  'Active'),
      ('Precision Ltd',       'Engineering',   'www.precision.com',  '0445678901', 'info@precision.com',  'Customer',   32000000, 320, 'Anitha Reddy', 'Active'),
      ('DataFlow Systems',    'Analytics',     'www.dataflow.com',   '0446789012', 'info@dataflow.com',   'Partner',    12000000, 120, 'Deepa Menon',  'Active')
    ON CONFLICT DO NOTHING
  `).catch(e => console.log('CRM Accounts:', e.message));

  // ── CRM contacts ──────────────────────────────────────────────────────
  await pool.query(`
    INSERT INTO crm_contacts (full_name, title, email, phone, department, lead_source, status)
    VALUES
      ('Rajesh Kumar',   'CTO',        'rajesh@infotech.com',  '9812345678', 'Technology',  'Website',    'Active'),
      ('Sunita Patel',   'CFO',        'sunita@globaldyn.com', '9823456789', 'Finance',     'Referral',   'Active'),
      ('Preethi Nair',   'IT Head',    'preethi@apex.com',     '9845678901', 'IT',          'Exhibition', 'Active'),
      ('Dev Sharma',     'CEO',        'dev@nextgen.com',      '9856789012', 'Management',  'Website',    'Active'),
      ('Meera Iyer',     'Procurement','meera@precision.com',  '9867890123', 'Procurement', 'Referral',   'Active'),
      ('Kiran Bose',     'Data Head',  'kiran@dataflow.com',   '9878901234', 'Analytics',   'Cold Call',  'Active')
    ON CONFLICT DO NOTHING
  `).catch(e => console.log('CRM Contacts:', e.message));

  // ── support tickets ────────────────────────────────────────────────────
  await pool.query(`
    INSERT INTO support_tickets (ticket_number, title, description, category, priority, status, requester_name, requester_email, team)
    VALUES
      ('TKT-0001', 'Cannot login to ERP system',       'User unable to login after password reset', 'Access',    'High',   'Open',       'Arjun Kumar',   'arjun@pulse.com',   'IT Support'),
      ('TKT-0002', 'Invoice not generating PDF',        'PDF export fails for invoices > 5 items',   'Finance',   'Medium', 'In Progress','Priya Sharma',  'priya@pulse.com',   'Finance IT'),
      ('TKT-0003', 'Payroll calculation mismatch',      'March payroll shows wrong deductions',       'Payroll',   'High',   'Open',       'Kavitha Singh', 'kavitha@pulse.com', 'HR Support'),
      ('TKT-0004', 'Leave balance not updating',        'Approved leaves not deducting from balance', 'HR',        'Medium', 'Resolved',   'Ravi Patel',    'ravi@pulse.com',    'HR Support'),
      ('TKT-0005', 'Attendance report incorrect',       'Report shows wrong punch times',             'Attendance','Low',    'Open',       'Vikram Nair',   'vikram@pulse.com',  'IT Support'),
      ('TKT-0006', 'CRM lead import failing',           'Excel bulk import throws error on row 45',   'CRM',       'Medium', 'Open',       'Anitha Reddy',  'anitha@pulse.com',  'CRM Support'),
      ('TKT-0007', 'Email notifications not sending',   'Approval email not received by managers',    'System',    'High',   'In Progress','Deepa Menon',   'deepa@pulse.com',   'IT Support'),
      ('TKT-0008', 'Slow dashboard loading',            'Main dashboard takes 20+ seconds to load',   'Performance','Low',   'Open',       'Suresh Rao',    'suresh@pulse.com',  'IT Support'),
      ('TKT-0009', 'Purchase order approval stuck',     'PO stuck in pending state after 3 days',     'Procurement','High',  'Resolved',   'Mohan Das',     'mohan@pulse.com',   'Finance IT'),
      ('TKT-0010', 'Document upload size limit error',  'Cannot upload files larger than 5MB',        'Documents', 'Medium', 'Open',       'Lakshmi Iyer',  'lakshmi@pulse.com', 'IT Support')
    ON CONFLICT (ticket_number) DO NOTHING
  `).catch(e => console.log('Support Tickets:', e.message));

  // ── crm lead activities ────────────────────────────────────────────────
  const leads = await pool.query('SELECT id FROM crm_leads LIMIT 3').catch(() => ({ rows: [] }));
  if (leads.rows.length > 0) {
    for (const lead of leads.rows) {
      await pool.query(`
        INSERT INTO crm_lead_activities (lead_id, activity, description, performed_by)
        VALUES
          ($1, 'Call', 'Initial discovery call — identified key pain points', 'Anitha Reddy'),
          ($1, 'Email', 'Sent product brochure and pricing deck', 'Deepa Menon'),
          ($1, 'Meeting', 'Product demo conducted — positive response', 'Anitha Reddy')
        ON CONFLICT DO NOTHING
      `, [lead.id]).catch(e => console.log('Lead activities:', e.message));
    }
  }

  console.log('✅ Seed complete! Login: admin@pulse.com / password123');
  process.exit(0);
}

seed().catch(e => { console.error('❌ Seed failed:', e.message); process.exit(1); });
