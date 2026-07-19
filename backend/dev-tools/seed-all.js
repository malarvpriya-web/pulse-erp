/**
 * seed-all.js  — Complete Pulse ERP data seed
 * Usage (from backend folder): node seed-all.js
 * Safe to run multiple times (ON CONFLICT DO NOTHING)
 */

import pool from './src/config/db.js';
import bcrypt from 'bcryptjs';

const pw = await bcrypt.hash('Pulse@123', 10);

async function run(label, fn) {
  try { await fn(); console.log(`  ✅ ${label}`); }
  catch (e) { console.log(`  ⚠️  ${label} — ${e.message.split('\n')[0]}`); }
}

async function main() {
  console.log('\n🌱 Pulse ERP — Complete Seed\n');

  await run('Users', async () => {
    await pool.query(`
      INSERT INTO users (name, email, password_hash, role, department, is_active) VALUES
        ('Super Admin',    'superadmin@manifest.in','${pw}','super_admin',    'Management', true),
        ('Admin User',     'admin@manifest.in',     '${pw}','admin',          'Management', true),
        ('Ravi Kumar',     'ravi@manifest.in',      '${pw}','manager',        'Engineering',true),
        ('Priya Sharma',   'priya@manifest.in',     '${pw}','hr',             'HR',         true),
        ('Anand Krishnan', 'anand@manifest.in',     '${pw}','employee',       'Engineering',true),
        ('Divya Nair',     'divya@manifest.in',     '${pw}','employee',       'Finance',    true),
        ('Suresh Pillai',  'suresh@manifest.in',    '${pw}','department_head','Sales',      true),
        ('Meena Iyer',     'meena@manifest.in',     '${pw}','employee',       'HR',         true),
        ('Karthik Rajan',  'karthik@manifest.in',   '${pw}','manager',        'Finance',    true),
        ('Lakshmi Devi',   'lakshmi@manifest.in',   '${pw}','employee',       'Operations', true)
      ON CONFLICT (email) DO NOTHING
    `);
  });

  await run('Employees (47 records)', async () => {
    const names = [
      ['Arjun','Sharma','Engineering','Software Engineer',45000],
      ['Priya','Menon','Engineering','Sr. Engineer',65000],
      ['Rahul','Kumar','Finance','Finance Analyst',40000],
      ['Sneha','Pillai','HR','HR Executive',38000],
      ['Vikram','Singh','Sales','Sales Executive',35000],
      ['Divya','Nair','Finance','Accountant',42000],
      ['Karan','Mehta','Engineering','Tech Lead',80000],
      ['Ananya','Iyer','Marketing','Marketing Executive',36000],
      ['Suresh','Rajan','Operations','Operations Manager',75000],
      ['Meena','Krishnan','HR','HR Manager',70000],
      ['Arun','Patel','Engineering','Developer',48000],
      ['Kavitha','Reddy','Sales','Sales Manager',72000],
      ['Manoj','Gupta','Finance','Senior Accountant',58000],
      ['Deepa','Shetty','Engineering','QA Engineer',44000],
      ['Rajesh','Venkat','Operations','Operations Executive',40000],
      ['Suma','Bhat','HR','Recruiter',35000],
      ['Naveen','Joshi','Engineering','Backend Developer',55000],
      ['Pooja','Malhotra','Marketing','Content Writer',32000],
      ['Sanjay','Desai','Sales','Sales Executive',38000],
      ['Rekha','Nambiar','Finance','Finance Manager',85000],
      ['Ajith','Thomas','Engineering','DevOps Engineer',60000],
      ['Sunita','Hegde','HR','HR Executive',36000],
      ['Muthukumar','Pandian','Engineering','Frontend Developer',52000],
      ['Lalitha','Subramanian','Operations','Coordinator',34000],
      ['Balachandran','Pillai','Finance','Tax Analyst',50000],
      ['Revathi','Krishnaswamy','Marketing','Digital Marketing',40000],
      ['Dinesh','Babu','Engineering','Full Stack Dev',62000],
      ['Shanthi','Arumugam','HR','Payroll Executive',38000],
      ['Gopal','Ramachandran','Sales','Business Dev',55000],
      ['Nithya','Selvaraj','Engineering','QA Lead',58000],
      ['Venkatesan','Murugan','Operations','Logistics Manager',68000],
      ['Archana','Kapoor','Finance','Accounts Executive',44000],
      ['Harish','Narayanan','Engineering','Mobile Developer',56000],
      ['Geetha','Krishnan','HR','Training Manager',62000],
      ['Praveen','Anand','Sales','Key Account Manager',70000],
      ['Sowmya','Ramamurthy','Marketing','Brand Manager',65000],
      ['Rameshan','Nair','Engineering','Architect',95000],
      ['Jayalakshmi','Srinivasan','Finance','CFO',120000],
      ['Muruganantham','Thirugnanam','Operations','Supply Chain',60000],
      ['Kamala','Devi','HR','HR Director',110000],
      ['Sundaram','Palani','Engineering','CTO',150000],
      ['Vasantha','Kumari','Marketing','CMO',130000],
      ['Thiruvenkatam','Raghunathan','Sales','VP Sales',140000],
      ['Saraswathi','Venkataraman','Finance','FP&A Manager',85000],
      ['Palanisamy','Chinnasamy','Engineering','Sr. Developer',70000],
      ['Bhuvaneswari','Natarajan','HR','Compliance Officer',55000],
      ['Chandrasekaran','Mahadevan','Operations','COO',160000],
    ];
    for (let i = 0; i < names.length; i++) {
      const [fn,ln,dept,desig,basic] = names[i];
      const num  = String(i+1).padStart(3,'0');
      const join = new Date(2021 + Math.floor(i/12), i%12, 1+(i%28));
      const status = i < 43 ? 'Active' : (i < 45 ? 'Probation' : 'Active');
      await pool.query(`
        INSERT INTO employees (office_id,first_name,last_name,company_email,department,designation,joining_date,basic_salary,status,gender)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (company_email) DO NOTHING
      `, [`EMP${num}`,fn,ln,`${fn.toLowerCase()}.${ln.toLowerCase()}@manifest.in`,dept,desig,join.toISOString().slice(0,10),basic,status,i%3===0?'Female':'Male']);
    }
  });

  await run('Leave Types', async () => {
    await pool.query(`
      INSERT INTO leave_types (leave_name,code,days_allowed,carry_forward,is_paid,applicable_to) VALUES
        ('Annual Leave','AL',18,true,true,'all'),
        ('Sick Leave','SL',12,false,true,'all'),
        ('Casual Leave','CL',6,false,true,'all'),
        ('Maternity Leave','ML',180,false,true,'female'),
        ('Paternity Leave','PL',5,false,true,'male'),
        ('Compensatory Leave','CO',0,false,true,'all'),
        ('Loss of Pay','LOP',0,false,false,'all')
      ON CONFLICT (code) DO NOTHING
    `);
  });

  await run('Holidays', async () => {
    await pool.query(`
      INSERT INTO holidays (name,date,type,description) VALUES
        ('New Year Day','2026-01-01','National','New Year'),
        ('Republic Day','2026-01-26','National','Republic Day'),
        ('Holi','2026-03-04','Festival','Festival of Colours'),
        ('Good Friday','2026-04-03','National','Good Friday'),
        ('Tamil New Year','2026-04-14','Regional','Puthandu'),
        ('Labour Day','2026-05-01','National','International Workers Day'),
        ('Independence Day','2026-08-15','National','Independence Day'),
        ('Gandhi Jayanti','2026-10-02','National','Gandhi Jayanti'),
        ('Diwali','2026-10-20','Festival','Festival of Lights'),
        ('Christmas','2026-12-25','National','Christmas Day')
      ON CONFLICT DO NOTHING
    `);
  });

  await run('Announcements', async () => {
    const today = new Date().toISOString().slice(0,10);
    const future = new Date(); future.setMonth(future.getMonth()+2);
    const end = future.toISOString().slice(0,10);
    await pool.query(`
      INSERT INTO announcements (title,message,target_type,is_active,from_date,to_date,created_by) VALUES
        ('Q1 Appraisal Cycle Open','Q1 2026 performance appraisal is now open. Complete self-assessment by April 30.','all',true,'${today}','${end}',1),
        ('New Leave Policy May 2026','Updated leave policy with enhanced maternity/paternity benefits from May 1.','all',true,'${today}','${end}',1),
        ('Company Picnic April 26','Annual company picnic at ECR Beach Resort. Register by April 20 with HR.','all',true,'${today}','${end}',1),
        ('ERP Training Sessions','Mandatory Pulse ERP training for all employees. Batches April 21-25.','all',true,'${today}','${end}',1),
        ('Office Timings Update','New hours: 9AM-6PM effective April 15. Flexible WFH on Fridays continues.','all',true,'${today}','${end}',1),
        ('Health Insurance Renewal','Submit medical documents before April 30 to HR for group health insurance renewal.','all',true,'${today}','${end}',1),
        ('Congratulations Engineering Team','Kudos for delivering Project Alpha 2 weeks ahead of schedule!','all',true,'${today}','${end}',1),
        ('Cafeteria Menu Updated','New healthy menu options added from April 14. Feedback to hr@manifest.in.','all',true,'${today}','${end}',1)
      ON CONFLICT DO NOTHING
    `);
  });

  await run('Attendance (30 days)', async () => {
    const {rows:emps} = await pool.query('SELECT id,company_email FROM employees LIMIT 47');
    const pool2 = ['present','present','present','present','present','present','late','absent'];
    for (let d=29;d>=0;d--) {
      const dt = new Date(); dt.setDate(dt.getDate()-d);
      if (dt.getDay()===0||dt.getDay()===6) continue;
      const dateStr = dt.toISOString().slice(0,10);
      for (const emp of emps) {
        const st = pool2[Math.floor(Math.random()*pool2.length)];
        await pool.query(`
          INSERT INTO attendance (employee_id,employee_email,date,status,check_in,check_out)
          VALUES ($1,$2,$3,$4,$5,'18:30:00') ON CONFLICT DO NOTHING
        `,[emp.id,emp.company_email,dateStr,st,st==='late'?'10:15:00':'09:00:00']).catch(()=>{});
      }
    }
  });

  await run('Leave Applications', async () => {
    const {rows:emps} = await pool.query('SELECT id,company_email,first_name,last_name FROM employees LIMIT 20');
    const types   = ['Annual','Sick','Casual'];
    const statuses= ['pending','approved','approved','rejected'];
    for (let i=0;i<30;i++) {
      const emp = emps[i%emps.length];
      const dt  = new Date(); dt.setDate(dt.getDate()-(i*5));
      const end = new Date(dt); end.setDate(end.getDate()+(1+i%3));
      await pool.query(`
        INSERT INTO leaves (employee_id,employee_email,employee_name,leave_type,start_date,end_date,status,reason,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'Personal reasons',NOW()-INTERVAL '${i*3} days')
        ON CONFLICT DO NOTHING
      `,[emp.id,emp.company_email,`${emp.first_name} ${emp.last_name}`,types[i%types.length],
         dt.toISOString().slice(0,10),end.toISOString().slice(0,10),statuses[i%statuses.length]]).catch(()=>{});
    }
  });

  await run('Projects', async () => {
    const projects = [
      ['PRJ-001','Pulse ERP Implementation','Software Development',500000,320000,'active',64,'2026-01-01','2026-06-30'],
      ['PRJ-002','Website Redesign','Web Development',120000,90000,'active',75,'2026-02-01','2026-04-30'],
      ['PRJ-003','Mobile App v2.0','Mobile Development',350000,180000,'active',51,'2026-02-15','2026-07-31'],
      ['PRJ-004','Data Migration','Infrastructure',200000,200000,'completed',100,'2025-11-01','2026-02-28'],
      ['PRJ-005','CRM Integration','Integration',150000,60000,'active',40,'2026-03-01','2026-05-31'],
      ['PRJ-006','Security Audit','Security',80000,80000,'completed',100,'2026-01-15','2026-02-15'],
      ['PRJ-007','API Gateway Setup','Infrastructure',90000,30000,'active',33,'2026-04-01','2026-06-15'],
      ['PRJ-008','Client Portal','Web Development',250000,50000,'planning',20,'2026-04-15','2026-08-31'],
    ];
    for (const [code,name,type,budget,actual,status,pct,start,end] of projects) {
      await pool.query(`
        INSERT INTO projects (project_code,name,type,budget,actual_cost,status,completion_percentage,start_date,end_date,client_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Manifest Technologies')
        ON CONFLICT DO NOTHING
      `,[code,name,type,budget,actual,status,pct,start,end]).catch(()=>{});
    }
  });

  await run('Invoices', async () => {
    const customers = ['TechCorp Solutions','Alpha Manufacturing','BrightFin Ltd','Global Trade','MediTech Services'];
    const statuses  = ['paid','paid','paid','pending','overdue'];
    for (let i=1;i<=20;i++) {
      const amt = ((50000+(i*35000))*1.18).toFixed(2);
      const dt  = new Date(); dt.setDate(dt.getDate()-(i*8));
      const due = new Date(dt); due.setDate(due.getDate()+30);
      await pool.query(`
        INSERT INTO invoices (invoice_number,party_name,total_amount,status,invoice_date,due_date,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING
      `,[`INV-2026-${String(i).padStart(4,'0')}`,customers[i%customers.length],amt,
         statuses[i%statuses.length],dt.toISOString().slice(0,10),due.toISOString().slice(0,10),dt.toISOString()]).catch(()=>{});
    }
  });

  await run('Bills', async () => {
    const vendors = ['AWS India','Microsoft India','Tata Teleservices','Airtel Business','HP India'];
    const statuses= ['paid','pending','overdue'];
    for (let i=1;i<=15;i++) {
      const dt  = new Date(); dt.setDate(dt.getDate()-(i*10));
      const due = new Date(dt); due.setDate(due.getDate()+30);
      await pool.query(`
        INSERT INTO bills (bill_number,party_name,amount,status,bill_date,due_date)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING
      `,[`BILL-2026-${String(i).padStart(4,'0')}`,vendors[i%vendors.length],15000+(i*12000),
         statuses[i%statuses.length],dt.toISOString().slice(0,10),due.toISOString().slice(0,10)]).catch(()=>{});
    }
  });

  await run('CRM Leads', async () => {
    const leads = [
      ['Zenith Technologies','Rajesh Kumar','rajesh@zenith.in','Referral','Qualified',2400000],
      ['Alpha Manufacturing','Sunita Mehta','sunita@alpha.in','Website','Proposal',1800000],
      ['BrightFin Ltd','Anita Reddy','anita@brightfin.in','LinkedIn','New',600000],
      ['Global Trade Partners','Vijay Nair','vijay@gtp.in','Cold Call','Negotiation',3200000],
      ['MNO Retail Group','Deepa Shetty','deepa@mnorg.in','Event','New',1200000],
      ['InfoTech Pvt Ltd','Sanjay Gupta','sanjay@infotech.in','Website','Contacted',900000],
      ['Sunrise Pharma','Meena Iyer','meena@sunrise.in','Referral','Qualified',4500000],
      ['BuildTech Corp','Ravi Shankar','ravi@buildtech.in','LinkedIn','Proposal',2800000],
      ['EduSoft Solutions','Priya Das','priya@edusoft.in','Website','New',750000],
      ['AutoParts India','Kumar Raja','kumar@autoparts.in','Cold Call','Contacted',1600000],
    ];
    for (const [company,contact,email,source,status,value] of leads) {
      await pool.query(`
        INSERT INTO leads (company_name,contact_person,email,lead_source,status,value)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING
      `,[company,contact,email,source,status,value]).catch(()=>{});
    }
  });

  await run('Vendors', async () => {
    const vendors = [
      ['Amazon Web Services','Cloud Services','billing@aws.in'],
      ['Microsoft India','Software Licenses','enterprise@microsoft.com'],
      ['HP India Pvt Ltd','IT Equipment','hp-enterprise@hp.com'],
      ['Dell Technologies','IT Equipment','dell.india@dell.com'],
      ['Airtel Business','Telecom','business@airtel.in'],
    ];
    for (const [name,cat,email] of vendors) {
      await pool.query(`
        INSERT INTO vendors (vendor_name,category,email,status)
        VALUES ($1,$2,$3,'active') ON CONFLICT DO NOTHING
      `,[name,cat,email]).catch(()=>{});
    }
  });

  await run('Audit Logs', async () => {
    const logs = [
      ['login','Auth','User logged in','admin@manifest.in'],
      ['create','Employees','Added new employee','admin@manifest.in'],
      ['update','Leaves','Approved leave request','priya@manifest.in'],
      ['create','Finance','Invoice INV-2026-0012 raised','divya@manifest.in'],
      ['update','HR','Payroll generated for March 2026','admin@manifest.in'],
      ['create','CRM','Lead Zenith Technologies added','ravi@manifest.in'],
      ['update','Projects','Project marked 64% done','karthik@manifest.in'],
      ['login','Auth','Manager login','ravi@manifest.in'],
      ['create','Finance','Bill approved','karthik@manifest.in'],
      ['update','Employees','Employee profile updated','admin@manifest.in'],
    ];
    for (let i=0;i<logs.length;i++) {
      const [action,module,description,user] = logs[i];
      await pool.query(`
        INSERT INTO audit_logs (action,module,description,performed_by,user_email,created_at)
        VALUES ($1,$2,$3,$4,$4,NOW()-INTERVAL '${i*2} hours') ON CONFLICT DO NOTHING
      `,[action,module,description,user]).catch(()=>{});
    }
  });

  await run('Payroll Records', async () => {
    const {rows:emps} = await pool.query('SELECT id,first_name,last_name,department,designation,basic_salary FROM employees LIMIT 20');
    for (const month of ['January 2026','February 2026','March 2026']) {
      for (const emp of emps) {
        const basic  = parseFloat(emp.basic_salary)||35000;
        const hra    = Math.round(basic*0.4);
        const gross  = basic+hra+1600+1250;
        const pf     = Math.min(basic,15000)*0.12;
        const esi    = gross<=21000?Math.round(gross*0.0075):0;
        const tds    = gross>50000?Math.round((gross-50000)*0.1/12):0;
        const deduct = pf+esi+tds;
        const net    = gross-deduct;
        await pool.query(`
          INSERT INTO payroll_records (employee_id,employee_name,department,designation,month,basic,hra,gross,pf,esi,tds,total_deductions,net_pay,status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING
        `,[emp.id,`${emp.first_name} ${emp.last_name}`,emp.department,emp.designation,
           month,basic,hra,gross,pf,esi,tds,deduct,net,
           month==='March 2026'?'pending':'paid']).catch(()=>{});
      }
    }
  });

  console.log('\n═══════════════════════════════════════');
  console.log('✅ Seed complete! Pulse ERP is ready.');
  console.log('═══════════════════════════════════════');
  console.log('\n🔑 Login credentials (password: Pulse@123):');
  console.log('   superadmin@manifest.in  →  Super Admin');
  console.log('   admin@manifest.in       →  Admin');
  console.log('   ravi@manifest.in        →  Manager');
  console.log('   priya@manifest.in       →  HR');
  console.log('   anand@manifest.in       →  Employee\n');

  await pool.end();
}

main().catch(e => { console.error('❌ Seed failed:', e.message); process.exit(1); });
