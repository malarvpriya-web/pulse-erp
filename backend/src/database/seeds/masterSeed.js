/**
 * masterSeed.js — Manifest Technologies Complete Database Seed
 * Run: node src/database/seeds/masterSeed.js
 *
 * Seeds ALL modules with realistic Indian company data for a 50-person
 * Chennai-based IT/software services company.
 *
 * ⚠️  DEV / STAGING ONLY.
 *     Seeds user accounts with the default password Manifest@123.
 *     NEVER run this on a production database.
 *     If run accidentally on production, rotate ALL user passwords immediately.
 *
 *     To run against a non-production DB, explicitly pass --seed flag:
 *       NODE_ENV=development node src/database/seeds/masterSeed.js --seed
 */

import pool from '../../../config/db.js';
import bcrypt from 'bcryptjs';

if (process.env.NODE_ENV === 'production' && !process.argv.includes('--seed')) {
  console.error('');
  console.error('🚫  masterSeed.js refused to run in NODE_ENV=production.');
  console.error('    This script seeds well-known dev passwords — running it on production');
  console.error('    would expose those accounts. Pass --seed to override (destructive).');
  console.error('');
  process.exit(1);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const fmt = (d) => d.toISOString().split('T')[0];

function addDays(base, n) {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}

function randomBetween(a, b) {
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function runSeed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('\n🌱 Starting Manifest Technologies database seed...\n');

    // ════════════════════════════════════════════════════════════
    // 1. COMPANY & USERS
    // ════════════════════════════════════════════════════════════
    const passwordHash = await bcrypt.hash('Manifest@123', 10);

    await client.query(`
      INSERT INTO users (name, email, password_hash, role, is_active, created_at)
      VALUES
        ('Admin User',       'admin@manifest.in',    $1, 'super_admin', true, NOW()),
        ('Priya Nair',       'hr@manifest.in',       $1, 'admin',       true, NOW()),
        ('Suresh Kumar',     'accounts@manifest.in', $1, 'admin',       true, NOW()),
        ('Rajesh Menon',     'manager@manifest.in',  $1, 'manager',     true, NOW()),
        ('Arun Krishnan',    'dev1@manifest.in',     $1, 'employee',    true, NOW()),
        ('Deepa Shankar',    'dev2@manifest.in',     $1, 'employee',    true, NOW()),
        ('Vijay Raman',      'dev3@manifest.in',     $1, 'employee',    true, NOW()),
        ('Kavitha Selvan',   'sales@manifest.in',    $1, 'employee',    true, NOW())
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
    `, [passwordHash]);
    console.log('✅ Seeded users: 8');

    // ════════════════════════════════════════════════════════════
    // 2. EMPLOYEES (50)
    // ════════════════════════════════════════════════════════════
    const employees = [
      // Management (3)
      ['EMP001','Arjun Mehta',       'arjun.mehta@manifest.in',     '9876543201','Management','CEO & Founder',              '2019-01-15',120000,'AABPM1234A','1234','SBI00123456','SBIN0001001','active'],
      ['EMP002','Sunita Krishnamurthy','sunita.k@manifest.in',      '9876543202','Management','Chief Technology Officer',   '2019-03-01',115000,'BCDSK2345B','2345','SBI00234567','SBIN0001002','active'],
      ['EMP003','Vikram Nambiar',    'vikram.n@manifest.in',        '9876543203','Management','VP Operations',              '2019-06-01',108000,'CEFVN3456C','3456','SBI00345678','SBIN0001003','active'],
      // Engineering (18)
      ['EMP004','Rajesh Menon',      'rajesh.m@manifest.in',        '9876543204','Engineering','Engineering Manager',       '2019-08-12',95000,'DFGRM4567D','4567','SBI00456789','SBIN0001004','active'],
      ['EMP005','Arun Krishnan',     'arun.k@manifest.in',          '9876543205','Engineering','Senior Software Engineer',  '2020-01-10',85000,'EHIAK5678E','5678','SBI00567890','SBIN0001005','active'],
      ['EMP006','Deepa Shankar',     'deepa.s@manifest.in',         '9876543206','Engineering','Senior Software Engineer',  '2020-02-14',82000,'FIJDS6789F','6789','SBI00678901','SBIN0001006','active'],
      ['EMP007','Vijay Raman',       'vijay.r@manifest.in',         '9876543207','Engineering','Software Engineer',         '2020-07-01',72000,'GJKVR7890G','7890','SBI00789012','SBIN0001007','active'],
      ['EMP008','Preethi Subramaniam','preethi.sub@manifest.in',   '9876543208','Engineering','Software Engineer',         '2021-01-04',68000,'HKLPS8901H','8901','SBI00890123','SBIN0001008','active'],
      ['EMP009','Karthik Balaji',    'karthik.b@manifest.in',       '9876543209','Engineering','Software Engineer',         '2021-03-15',65000,'ILMQB9012I','9012','SBI00901234','SBIN0001009','active'],
      ['EMP010','Ananya Iyer',       'ananya.i@manifest.in',        '9876543210','Engineering','Frontend Developer',        '2021-06-01',62000,'JMNRI0123J','0123','SBI01012345','SBIN0001010','active'],
      ['EMP011','Suresh Pillai',     'suresh.p@manifest.in',        '9876543211','Engineering','Frontend Developer',        '2021-09-01',60000,'KNOSP1234K','1234','SBI01123456','SBIN0001011','active'],
      ['EMP012','Meena Raghunathan', 'meena.r@manifest.in',         '9876543212','Engineering','Backend Developer',         '2022-01-10',58000,'LOPQR2345L','2345','SBI01234567','SBIN0001012','active'],
      ['EMP013','Ganesh Venkatesh',  'ganesh.v@manifest.in',        '9876543213','Engineering','Backend Developer',         '2022-04-01',56000,'MPQGS3456M','3456','SBI01345678','SBIN0001013','active'],
      ['EMP014','Lavanya Srinivasan','lavanya.sri@manifest.in',     '9876543214','Engineering','Full Stack Developer',      '2022-07-15',54000,'NQRLT4567N','4567','SBI01456789','SBIN0001014','active'],
      ['EMP015','Dinesh Chandran',   'dinesh.c@manifest.in',        '9876543215','Engineering','DevOps Engineer',           '2022-09-01',65000,'ORSMD5678O','5678','SBI01567890','SBIN0001015','active'],
      ['EMP016','Sangeetha Murugan', 'sangeetha.m@manifest.in',     '9876543216','Engineering','Junior Developer',          '2023-01-03',38000,'PSTNE6789P','6789','SBI01678901','SBIN0001016','active'],
      ['EMP017','Rohit Anand',       'rohit.a@manifest.in',         '9876543217','Engineering','Junior Developer',          '2023-06-05',36000,'QTUPА7890Q','7890','SBI01789012','SBIN0001017','active'],
      ['EMP018','Nithya Raj',        'nithya.raj@manifest.in',      '9876543218','Engineering','Mobile Developer',          '2023-08-14',52000,'RUVQR8901R','8901','SBI01890123','SBIN0001018','active'],
      ['EMP019','Sathish Kumar',     'sathish.k@manifest.in',       '9876543219','Engineering','Data Engineer',             '2024-01-08',55000,'SVWRS9012S','9012','SBI01901234','SBIN0001019','active'],
      ['EMP020','Priya Ramasamy',    'priya.rama@manifest.in',      '9876543220','Engineering','Cloud Architect',           '2024-03-01',78000,'TWXST0123T','0123','SBI02012345','SBIN0001020','active'],
      ['EMP021','Balachandar M',     'balachandar.m@manifest.in',   '9876543221','Engineering','Software Engineer',         '2024-06-10',48000,'UXYTA1234U','1234','SBI02123456','SBIN0001021','on_leave'],
      // Sales (8)
      ['EMP022','Kavitha Selvan',    'kavitha.s@manifest.in',       '9876543222','Sales','Sales Manager',                  '2019-10-01',88000,'VYZUA2345V','2345','SBI02234567','SBIN0001022','active'],
      ['EMP023','Murugan Palani',    'murugan.p@manifest.in',       '9876543223','Sales','Senior Sales Executive',         '2020-05-01',58000,'WABVB3456W','3456','SBI02345678','SBIN0001023','active'],
      ['EMP024','Saranya Devi',      'saranya.d@manifest.in',       '9876543224','Sales','Sales Executive',                '2021-02-01',45000,'XBCWC4567X','4567','SBI02456789','SBIN0001024','active'],
      ['EMP025','Praveen Raj',       'praveen.r@manifest.in',       '9876543225','Sales','Sales Executive',                '2021-08-16',42000,'YCDXD5678Y','5678','SBI02567890','SBIN0001025','active'],
      ['EMP026','Divya Krishnan',    'divya.k@manifest.in',         '9876543226','Sales','Business Development Executive', '2022-03-01',40000,'ZDEXE6789Z','6789','SBI02678901','SBIN0001026','active'],
      ['EMP027','Abishek Nair',      'abishek.n@manifest.in',       '9876543227','Sales','Business Development Executive', '2022-09-15',38000,'AEFYF7890A','7890','SBI02789012','SBIN0001027','active'],
      ['EMP028','Janani Suresh',     'janani.s@manifest.in',        '9876543228','Sales','Inside Sales Representative',    '2023-03-01',32000,'BFGZG8901B','8901','SBI02890123','SBIN0001028','active'],
      ['EMP029','Harish Babu',       'harish.b@manifest.in',        '9876543229','Sales','Inside Sales Representative',    '2023-07-01',30000,'CGHAH9012C','9012','SBI02901234','SBIN0001029','on_leave'],
      // HR (4)
      ['EMP030','Priya Nair',        'priya.nair@manifest.in',      '9876543230','HR','HR Manager',                       '2019-11-01',78000,'DHIHI0123D','0123','SBI03012345','SBIN0001030','active'],
      ['EMP031','Revathi Sundaram',  'revathi.s@manifest.in',       '9876543231','HR','HR Executive',                     '2020-08-01',42000,'EIJIJ1234E','1234','SBI03123456','SBIN0001031','active'],
      ['EMP032','Subha Lakshmi',     'subha.l@manifest.in',         '9876543232','HR','Recruiter',                        '2022-01-10',38000,'FJKJK2345F','2345','SBI03234567','SBIN0001032','active'],
      ['EMP033','Radhika Venkat',    'radhika.v@manifest.in',       '9876543233','HR','HR Assistant',                     '2023-05-01',28000,'GKLKL3456G','3456','SBI03345678','SBIN0001033','active'],
      // Finance (4)
      ['EMP034','Suresh Kumar',      'suresh.kumar@manifest.in',    '9876543234','Finance','Finance Manager',              '2019-12-01',82000,'HLMLM4567H','4567','SBI03456789','SBIN0001034','active'],
      ['EMP035','Anand Rajan',       'anand.r@manifest.in',         '9876543235','Finance','Senior Accountant',            '2020-04-01',52000,'IMNMN5678I','5678','SBI03567890','SBIN0001035','active'],
      ['EMP036','Mythili Gopal',     'mythili.g@manifest.in',       '9876543236','Finance','Accountant',                   '2021-07-01',40000,'JNONO6789J','6789','SBI03678901','SBIN0001036','active'],
      ['EMP037','Saravanan S',       'saravanan.s@manifest.in',     '9876543237','Finance','Accounts Executive',           '2022-11-01',32000,'KOPOP7890K','7890','SBI03789012','SBIN0001037','active'],
      // Operations (5)
      ['EMP038','Senthil Nathan',    'senthil.n@manifest.in',       '9876543238','Operations','Operations Manager',        '2020-01-15',72000,'LPQPQ8901L','8901','SBI03890123','SBIN0001038','active'],
      ['EMP039','Vasantha Kumar',    'vasantha.k@manifest.in',      '9876543239','Operations','Project Coordinator',       '2021-05-01',45000,'MQRQR9012M','9012','SBI03901234','SBIN0001039','active'],
      ['EMP040','Geetha Ramesh',     'geetha.r@manifest.in',        '9876543240','Operations','Administrative Executive',  '2022-02-14',35000,'NRSRS0123N','0123','SBI04012345','SBIN0001040','active'],
      ['EMP041','Manikandan P',      'manikandan.p@manifest.in',    '9876543241','Operations','Office Administrator',      '2023-01-09',28000,'OSTST1234O','1234','SBI04123456','SBIN0001041','active'],
      ['EMP042','Tamilselvi Arumugam','tamilselvi.a@manifest.in',   '9876543242','Operations','Executive Assistant',       '2023-09-04',26000,'PUTUT2345P','2345','SBI04234567','SBIN0001042','inactive'],
      // Marketing (4)
      ['EMP043','Keerthana Bhaskar', 'keerthana.b@manifest.in',     '9876543243','Marketing','Marketing Manager',          '2020-06-01',68000,'QVUVU3456Q','3456','SBI04345678','SBIN0001043','active'],
      ['EMP044','Prashanth Reddy',   'prashanth.r@manifest.in',     '9876543244','Marketing','Digital Marketing Specialist','2021-10-01',45000,'RWVWV4567R','4567','SBI04456789','SBIN0001044','active'],
      ['EMP045','Usha Rani',         'usha.rani@manifest.in',       '9876543245','Marketing','Content Writer',             '2022-06-13',32000,'SXWXW5678S','5678','SBI04567890','SBIN0001045','active'],
      ['EMP046','Balaji Subramaniam','balaji.sub@manifest.in',      '9876543246','Marketing','SEO Analyst',                '2023-04-03',30000,'TYXYX6789T','6789','SBI04678901','SBIN0001046','inactive'],
      // QA (4)
      ['EMP047','Nirmal Kumar',      'nirmal.k@manifest.in',        '9876543247','QA','QA Lead',                          '2020-09-01',62000,'UZYZY7890U','7890','SBI04789012','SBIN0001047','active'],
      ['EMP048','Sowmiya Raj',       'sowmiya.r@manifest.in',       '9876543248','QA','Senior QA Engineer',               '2021-04-01',52000,'VAZCZ8901V','8901','SBI04890123','SBIN0001048','active'],
      ['EMP049','Balakumar T',       'balakumar.t@manifest.in',     '9876543249','QA','QA Engineer',                      '2022-08-01',42000,'WBADA9012W','9012','SBI04901234','SBIN0001049','active'],
      ['EMP050','Sharmila Devi',     'sharmila.d@manifest.in',      '9876543250','QA','QA Engineer',                      '2023-02-13',36000,'XCBEB0123X','0123','SBI05012345','SBIN0001050','on_leave'],
    ];

    for (const e of employees) {
      await client.query(`
        INSERT INTO employees
          (employee_code, full_name, email, phone, department, designation,
           joining_date, basic_salary, pan_number, aadhaar_last4,
           bank_account, ifsc, status, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
        ON CONFLICT (employee_code) DO UPDATE SET
          full_name=EXCLUDED.full_name, email=EXCLUDED.email,
          basic_salary=EXCLUDED.basic_salary, status=EXCLUDED.status
      `, e);
    }
    console.log('✅ Seeded employees: 50');

    // Fetch employee IDs for FK references
    const { rows: empRows } = await client.query(
      `SELECT id, employee_code, full_name, email, department, basic_salary, status
       FROM employees ORDER BY employee_code`
    );
    const empByCode = {};
    empRows.forEach(r => { empByCode[r.employee_code] = r; });
    const activeEmps = empRows.filter(r => r.status === 'active');

    // ════════════════════════════════════════════════════════════
    // 3. ATTENDANCE (last 30 days for active employees)
    // ════════════════════════════════════════════════════════════
    const today = new Date('2026-04-05');
    let attCount = 0;

    for (const emp of activeEmps) {
      for (let d = 1; d <= 30; d++) {
        const date = addDays(today, -d);
        const dow = date.getDay(); // 0=Sun, 6=Sat
        if (dow === 0 || dow === 6) continue; // skip weekends

        const rand = Math.random();
        let status, checkIn = null, checkOut = null, workHours = null;

        if (rand < 0.05) {
          status = 'absent';
        } else if (rand < 0.10) {
          status = 'late';
          const lateMin = randomBetween(35, 90);
          const inH = 9, inM = 30 + lateMin > 59 ? Math.floor((30 + lateMin) / 60) : 0;
          const inMin = (30 + lateMin) % 60;
          checkIn  = `${String(inH + inM).padStart(2,'0')}:${String(inMin).padStart(2,'0')}:00`;
          const outH = randomBetween(17, 19), outM = randomBetween(30, 59);
          checkOut = `${String(outH).padStart(2,'0')}:${String(outM).padStart(2,'0')}:00`;
          const inTotalMin  = (inH + (lateMin > 30 ? 1 : 0)) * 60 + inMin;
          const outTotalMin = outH * 60 + outM;
          workHours = parseFloat(((outTotalMin - inTotalMin) / 60).toFixed(2));
        } else {
          status = 'present';
          const inH = 8, inM = randomBetween(45, 59);
          checkIn  = `${String(inH).padStart(2,'0')}:${String(inM).padStart(2,'0')}:00`;
          const outH = randomBetween(17, 20), outM = randomBetween(0, 59);
          checkOut = `${String(outH).padStart(2,'0')}:${String(outM).padStart(2,'0')}:00`;
          const inTotalMin  = inH * 60 + inM;
          const outTotalMin = outH * 60 + outM;
          workHours = parseFloat(((outTotalMin - inTotalMin) / 60).toFixed(2));
        }

        await client.query(`
          INSERT INTO attendance (employee_id, date, status, check_in, check_out, work_hours, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,NOW())
          ON CONFLICT (employee_id, date) DO NOTHING
        `, [emp.id, fmt(date), status, checkIn, checkOut, workHours]);
        attCount++;
      }
    }
    console.log(`✅ Seeded attendance: ~${attCount} records`);

    // ════════════════════════════════════════════════════════════
    // 4. LEAVES & LEAVE BALANCES
    // ════════════════════════════════════════════════════════════
    // Leave balances for all employees
    for (const emp of empRows) {
      await client.query(`
        INSERT INTO leave_balances (employee_id, year, annual_total, annual_used, annual_remaining,
          sick_total, sick_used, sick_remaining, casual_total, casual_used, casual_remaining)
        VALUES ($1, 2026, 12, 0, 12, 6, 0, 6, 6, 0, 6)
        ON CONFLICT (employee_id, year) DO NOTHING
      `, [emp.id]);
    }
    console.log('✅ Seeded leave_balances: 50');

    // Leave requests
    const leaveData = [
      [empByCode['EMP005'].id, 'Annual Leave',   '2026-01-13', '2026-01-14', 2, 'Family function in Madurai',              'approved'],
      [empByCode['EMP008'].id, 'Sick Leave',      '2026-01-20', '2026-01-21', 2, 'Fever and cold, doctor advised rest',     'approved'],
      [empByCode['EMP012'].id, 'Annual Leave',   '2026-01-26', '2026-01-28', 3, 'Travelling to native for Republic Day',   'approved'],
      [empByCode['EMP016'].id, 'Casual Leave',   '2026-02-03', '2026-02-03', 1, 'Personal work',                           'approved'],
      [empByCode['EMP022'].id, 'Annual Leave',   '2026-02-09', '2026-02-11', 3, 'Attending cousin\'s wedding in Trichy',   'approved'],
      [empByCode['EMP007'].id, 'Sick Leave',      '2026-02-17', '2026-02-18', 2, 'Viral fever, medical certificate attached','approved'],
      [empByCode['EMP030'].id, 'Annual Leave',   '2026-02-23', '2026-02-25', 3, 'Family vacation to Ooty',                 'approved'],
      [empByCode['EMP035'].id, 'Casual Leave',   '2026-03-05', '2026-03-05', 1, 'Child\'s school admission process',       'approved'],
      [empByCode['EMP047'].id, 'Annual Leave',   '2026-03-10', '2026-03-12', 3, 'Native place visit',                      'approved'],
      [empByCode['EMP011'].id, 'Sick Leave',      '2026-03-18', '2026-03-19', 2, 'Stomach infection, doctor consultation',  'approved'],
      [empByCode['EMP019'].id, 'Annual Leave',   '2026-03-28', '2026-04-01', 5, 'Pongal festival travel',                  'pending'],
      [empByCode['EMP024'].id, 'Casual Leave',   '2026-04-07', '2026-04-07', 1, 'Bank work and personal errands',          'pending'],
      [empByCode['EMP033'].id, 'Sick Leave',      '2026-04-10', '2026-04-11', 2, 'Medical check-up for recurring headache', 'pending'],
      [empByCode['EMP014'].id, 'Annual Leave',   '2026-03-15', '2026-03-20', 6, 'Need 2 weeks off for personal reasons',   'rejected'],
      [empByCode['EMP028'].id, 'Casual Leave',   '2026-03-25', '2026-03-27', 3, 'House hunting in Chennai',                'rejected'],
    ];
    for (const l of leaveData) {
      await client.query(`
        INSERT INTO leaves (employee_id, leave_type, start_date, end_date, days, reason, status, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT DO NOTHING
      `, l);
    }
    console.log('✅ Seeded leaves: 15');

    // ════════════════════════════════════════════════════════════
    // 5. CHART OF ACCOUNTS
    // ════════════════════════════════════════════════════════════
    const coa = [
      // Assets
      ['1000','Cash in Hand',         'asset', 'current_asset',  true,  null],
      ['1010','Bank - SBI Current',   'asset', 'current_asset',  true,  null],
      ['1020','Bank - HDFC Savings',  'asset', 'current_asset',  true,  null],
      ['1100','Accounts Receivable',  'asset', 'current_asset',  false, null],
      ['1200','Prepaid Expenses',     'asset', 'current_asset',  false, null],
      ['1300','Security Deposits',    'asset', 'current_asset',  false, null],
      ['1500','Computer Equipment',   'asset', 'fixed_asset',    false, null],
      ['1510','Office Furniture',     'asset', 'fixed_asset',    false, null],
      ['1520','Vehicles',             'asset', 'fixed_asset',    false, null],
      ['1900','Accumulated Depreciation','asset','fixed_asset',  false, null],
      // Liabilities
      ['2000','Accounts Payable',     'liability','current_liability',false,null],
      ['2100','GST Payable - CGST',   'liability','current_liability',false,null],
      ['2110','GST Payable - SGST',   'liability','current_liability',false,null],
      ['2120','GST Payable - IGST',   'liability','current_liability',false,null],
      ['2200','TDS Payable',          'liability','current_liability',false,null],
      ['2300','Salary Payable',       'liability','current_liability',false,null],
      ['2400','PF Payable',           'liability','current_liability',false,null],
      ['2500','ESI Payable',          'liability','current_liability',false,null],
      ['2600','Advance from Customers','liability','current_liability',false,null],
      // Equity
      ['3000','Share Capital',        'equity', null,             false, null],
      ['3100','Retained Earnings',    'equity', null,             false, null],
      ['3200','Current Year Profit',  'equity', null,             false, null],
      // Revenue
      ['4000','Software Development Services','revenue','operating_revenue',false,null],
      ['4010','ERP Implementation Revenue',   'revenue','operating_revenue',false,null],
      ['4020','Annual Maintenance Contract',  'revenue','operating_revenue',false,null],
      ['4030','IT Consulting Revenue',        'revenue','operating_revenue',false,null],
      ['4040','Cloud Infrastructure Services','revenue','operating_revenue',false,null],
      ['4900','Other Income',                 'revenue','other_income',     false,null],
      // Expenses
      ['5000','Salaries & Wages',     'expense','operating_expense',false,null],
      ['5010','PF Contribution',      'expense','operating_expense',false,null],
      ['5020','ESI Contribution',     'expense','operating_expense',false,null],
      ['5030','Gratuity Provision',   'expense','operating_expense',false,null],
      ['5100','Office Rent',          'expense','operating_expense',false,null],
      ['5110','Electricity & Water',  'expense','operating_expense',false,null],
      ['5120','Internet & Telecom',   'expense','operating_expense',false,null],
      ['5200','Software Licenses',    'expense','operating_expense',false,null],
      ['5210','Cloud Services - AWS', 'expense','operating_expense',false,null],
      ['5220','Cloud Services - Azure','expense','operating_expense',false,null],
      ['5300','Travel & Conveyance',  'expense','operating_expense',false,null],
      ['5310','Hotel & Accommodation','expense','operating_expense',false,null],
      ['5400','Marketing & Advertising','expense','operating_expense',false,null],
      ['5500','Professional Fees',    'expense','operating_expense',false,null],
      ['5600','Bank Charges',         'expense','operating_expense',false,null],
      ['5700','Depreciation',         'expense','operating_expense',false,null],
      ['5800','Miscellaneous Expenses','expense','operating_expense',false,null],
    ];
    for (const [code, name, type, sub, isCash, parent] of coa) {
      await client.query(`
        INSERT INTO chart_of_accounts (account_code, account_name, account_type, account_subtype, is_cash_account, parent_account_code)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (account_code) DO NOTHING
      `, [code, name, type, sub, isCash, parent]);
    }
    console.log('✅ Seeded chart_of_accounts: 44');

    // ════════════════════════════════════════════════════════════
    // 6. PARTIES (Customers & Suppliers)
    // ════════════════════════════════════════════════════════════
    const parties = [
      // Customers
      ['CUST001','TechSolutions India Pvt Ltd',   'customer','33AABCT1234A1Z5','AABCT1234A',5000000, 30,'techsolutions.in',  'accounts@techsolutions.in', '9044001234','Chennai'],
      ['CUST002','HDFC Bank Limited',             'customer','27AABCH0090N1ZV','AABCH0090N',25000000,45,'hdfcbank.com',      'vendor@hdfcbank.com',       '9022001234','Mumbai'],
      ['CUST003','Sundaram Finance Ltd',          'customer','33AABCS1234A1Z5','AABCS1234A',10000000,30,'sundaramfinance.in','it@sundaramfinance.in',     '9044002345','Chennai'],
      ['CUST004','Apollo Hospitals Enterprise',  'customer','33AABCA1234A1Z5','AABCA1234A',15000000,45,'apollohospitals.com','it.procurement@apollo.com','9044003456','Chennai'],
      ['CUST005','Ramco Systems Limited',         'customer','33AABCR1234A1Z5','AABCR1234A',8000000, 30,'ramco.com',         'procurement@ramco.com',    '9044004567','Chennai'],
      ['CUST006','TVS Motor Company',             'customer','33AABCT5678A1Z5','AABCT5678A',12000000,60,'tvsmotor.com',      'it@tvsmotor.com',           '9044005678','Chennai'],
      ['CUST007','CavinKare Pvt Ltd',             'customer','33AABCC1234A1Z5','AABCC1234A',5000000, 30,'cavinkare.com',     'tech@cavinkare.com',        '9044006789','Chennai'],
      ['CUST008','Murugappa Group',               'customer','33AABCM5678A1Z5','AABCM5678A',20000000,45,'murugappa.com',     'digital@murugappa.com',     '9044007890','Chennai'],
      ['CUST009','Ashok Leyland Limited',         'customer','33AABCA5678A1Z5','AABCA5678A',18000000,60,'ashokleyland.com',  'it.dept@ashokleyland.com', '9044008901','Chennai'],
      ['CUST010','Hexaware Technologies',         'customer','27AABCH5678A1Z5','AABCH5678A',7000000, 30,'hexaware.com',      'vendor@hexaware.com',       '9022002345','Mumbai'],
      // Suppliers
      ['SUPP001','Amazon Web Services India',     'supplier','29AANCA1234A1ZA','AANCA1234A',0,        30,'aws.amazon.com',   'billing@aws.amazon.in',     '1800108877','Bangalore'],
      ['SUPP002','Microsoft India Pvt Ltd',       'supplier','29AABCM1234A1ZA','AABCM1234A',0,        30,'microsoft.com',   'msvolume@microsoft.com',    '1800102285','Bangalore'],
      ['SUPP003','Prestige Corporate Properties', 'supplier','33AABCP1234A1Z5','AABCP1234A',0,        30,'prestigegroup.com','lease@prestigegroup.com',  '9044009012','Chennai'],
      ['SUPP004','BSNL Tamil Nadu',               'supplier','33AABCB1234A1Z5','AABCB1234A',0,        15,'bsnl.co.in',       'corporate@bsnltamil.in',    '1800424444','Chennai'],
      ['SUPP005','Tata Consultancy Services',     'supplier','27AABCT1234A1Z1','AABCT1234A',0,        30,'tcs.com',          'vendor@tcs.com',             '9022003456','Mumbai'],
      ['SUPP006','Zoho Corporation',              'supplier','33AABCZ1234A1Z5','AABCZ1234A',0,        30,'zoho.com',         'billing@zohocorp.com',      '9044010123','Chennai'],
      ['SUPP007','Staples India Pvt Ltd',         'supplier','27AABCS5678A1Z5','AABCS5678A',0,        15,'staples.in',       'corporate@staples.in',      '9022004567','Mumbai'],
      ['SUPP008','TNEB (Tamil Nadu Elec Board)',  'supplier','33AABCT9012A1Z5','AABCT9012A',0,        15,'tneb.in',          'commercial@tneb.in',        '9044011234','Chennai'],
    ];
    for (const [code,name,type,gstin,pan,creditLimit,payTerms,website,email,phone,city] of parties) {
      await client.query(`
        INSERT INTO parties (party_code, party_name, party_type, gstin, pan, credit_limit,
          payment_terms, website, email, phone, city, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
        ON CONFLICT (party_code) DO NOTHING
      `, [code,name,type,gstin,pan,creditLimit,payTerms,website,email,phone,city]);
    }
    console.log('✅ Seeded parties: 18 (10 customers, 8 suppliers)');

    // ════════════════════════════════════════════════════════════
    // 7. INVOICES (last 6 months)
    // ════════════════════════════════════════════════════════════
    const { rows: custRows } = await client.query(
      `SELECT id, party_code FROM parties WHERE party_type='customer' ORDER BY party_code`
    );
    const custByCode = {};
    custRows.forEach(r => { custByCode[r.party_code] = r; });

    const invoicesData = [
      // INV-2025-001 to INV-2025-024
      ['INV-2025-001',custByCode['CUST001']?.id,'2025-10-05','2025-11-04',450000,'Software Development Services','paid'],
      ['INV-2025-002',custByCode['CUST002']?.id,'2025-10-12','2025-11-11',850000,'ERP Implementation Phase 1','paid'],
      ['INV-2025-003',custByCode['CUST003']?.id,'2025-10-18','2025-11-17',180000,'Annual Maintenance Contract','paid'],
      ['INV-2025-004',custByCode['CUST004']?.id,'2025-10-25','2025-11-24',620000,'IT Consulting Services','paid'],
      ['INV-2025-005',custByCode['CUST005']?.id,'2025-11-03','2025-12-03',290000,'Software Development Services','paid'],
      ['INV-2025-006',custByCode['CUST006']?.id,'2025-11-10','2025-12-10',150000,'Annual Maintenance Contract','paid'],
      ['INV-2025-007',custByCode['CUST007']?.id,'2025-11-17','2025-12-17',480000,'Cloud Infrastructure Setup','paid'],
      ['INV-2025-008',custByCode['CUST008']?.id,'2025-11-24','2025-12-24',720000,'ERP Implementation Phase 2','paid'],
      ['INV-2025-009',custByCode['CUST009']?.id,'2025-12-01','2025-12-31',310000,'IT Consulting Services','paid'],
      ['INV-2025-010',custByCode['CUST010']?.id,'2025-12-08','2026-01-07',560000,'Software Development Services','paid'],
      ['INV-2025-011',custByCode['CUST001']?.id,'2025-12-15','2026-01-14',95000, 'Annual Maintenance Contract','paid'],
      ['INV-2025-012',custByCode['CUST002']?.id,'2025-12-22','2026-01-21',430000,'Data Analytics Dashboard','paid'],
      ['INV-2025-013',custByCode['CUST003']?.id,'2026-01-05','2026-02-04',780000,'ERP Implementation Phase 3','paid'],
      ['INV-2025-014',custByCode['CUST004']?.id,'2026-01-12','2026-02-11',240000,'Mobile App Development','paid'],
      ['INV-2025-015',custByCode['CUST005']?.id,'2026-01-19','2026-02-18',190000,'IT Consulting Services','paid'],
      ['INV-2025-016',custByCode['CUST006']?.id,'2026-01-26','2026-02-25',650000,'Cloud Migration Project','partially_paid'],
      ['INV-2025-017',custByCode['CUST007']?.id,'2026-02-02','2026-03-04',380000,'Software Development Services','partially_paid'],
      ['INV-2025-018',custByCode['CUST008']?.id,'2026-02-09','2026-03-11',520000,'ERP Implementation Phase 4','partially_paid'],
      ['INV-2025-019',custByCode['CUST009']?.id,'2026-02-16','2026-03-18',270000,'Annual Maintenance Contract','partially_paid'],
      ['INV-2025-020',custByCode['CUST010']?.id,'2026-02-23','2026-03-25',890000,'Data Warehouse Development','partially_paid'],
      ['INV-2025-021',custByCode['CUST001']?.id,'2026-03-01','2026-03-31',445000,'Software Development Services','overdue'],
      ['INV-2025-022',custByCode['CUST003']?.id,'2026-03-05','2026-04-04',320000,'IT Consulting Services','overdue'],
      ['INV-2025-023',custByCode['CUST004']?.id,'2026-03-10','2026-04-09',175000,'Annual Maintenance Contract','overdue'],
      ['INV-2025-024',custByCode['CUST005']?.id,'2026-03-15','2026-04-14',615000,'ERP Implementation Phase 5','overdue'],
    ];

    for (const [invNum, custId, invDate, dueDate, baseAmt, desc, status] of invoicesData) {
      if (!custId) continue;
      const cgst = parseFloat((baseAmt * 0.09).toFixed(2));
      const sgst = parseFloat((baseAmt * 0.09).toFixed(2));
      const total = parseFloat((baseAmt + cgst + sgst).toFixed(2));
      const paid = status === 'paid' ? total : status === 'partially_paid' ? parseFloat((total * 0.5).toFixed(2)) : 0;
      const balance = parseFloat((total - paid).toFixed(2));

      await client.query(`
        INSERT INTO invoices (invoice_number, party_id, invoice_date, due_date,
          subtotal, cgst_amount, sgst_amount, igst_amount, total_amount,
          paid_amount, balance_amount, status, description, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
        ON CONFLICT (invoice_number) DO NOTHING
      `, [invNum, custId, invDate, dueDate, baseAmt, cgst, sgst, 0, total, paid, balance, status, desc]);
    }
    console.log('✅ Seeded invoices: 24');

    // ════════════════════════════════════════════════════════════
    // 8. SUPPLIER BILLS (last 3 months)
    // ════════════════════════════════════════════════════════════
    const { rows: suppRows } = await client.query(
      `SELECT id, party_code FROM parties WHERE party_type='supplier' ORDER BY party_code`
    );
    const suppByCode = {};
    suppRows.forEach(r => { suppByCode[r.party_code] = r; });

    const billsData = [
      ['BILL-2026-001',suppByCode['SUPP001']?.id,'2026-01-31','2026-02-28',45000,'AWS Cloud Services - January 2026','paid'],
      ['BILL-2026-002',suppByCode['SUPP002']?.id,'2026-01-31','2026-02-28',28000,'Microsoft 365 Licenses - January 2026','paid'],
      ['BILL-2026-003',suppByCode['SUPP003']?.id,'2026-01-31','2026-02-15',85000,'Office Rent - January 2026','paid'],
      ['BILL-2026-004',suppByCode['SUPP004']?.id,'2026-01-31','2026-02-15',8500, 'BSNL Leased Line - January 2026','paid'],
      ['BILL-2026-005',suppByCode['SUPP008']?.id,'2026-01-31','2026-02-15',12000,'Electricity - January 2026','paid'],
      ['BILL-2026-006',suppByCode['SUPP001']?.id,'2026-02-28','2026-03-31',47500,'AWS Cloud Services - February 2026','paid'],
      ['BILL-2026-007',suppByCode['SUPP002']?.id,'2026-02-28','2026-03-31',28000,'Microsoft 365 Licenses - February 2026','paid'],
      ['BILL-2026-008',suppByCode['SUPP003']?.id,'2026-02-28','2026-03-15',85000,'Office Rent - February 2026','paid'],
      ['BILL-2026-009',suppByCode['SUPP006']?.id,'2026-02-28','2026-03-31',15000,'Zoho CRM Subscription - Q1 2026','paid'],
      ['BILL-2026-010',suppByCode['SUPP001']?.id,'2026-03-31','2026-04-30',49000,'AWS Cloud Services - March 2026','unpaid'],
      ['BILL-2026-011',suppByCode['SUPP002']?.id,'2026-03-31','2026-04-30',28000,'Microsoft 365 Licenses - March 2026','unpaid'],
      ['BILL-2026-012',suppByCode['SUPP003']?.id,'2026-03-31','2026-04-15',85000,'Office Rent - March 2026','unpaid'],
    ];

    for (const [billNum, suppId, billDate, dueDate, baseAmt, desc, status] of billsData) {
      if (!suppId) continue;
      const gst = parseFloat((baseAmt * 0.18).toFixed(2));
      const total = parseFloat((baseAmt + gst).toFixed(2));
      const paid = status === 'paid' ? total : 0;
      await client.query(`
        INSERT INTO bills (bill_number, party_id, bill_date, due_date,
          subtotal, gst_amount, total_amount, paid_amount, status, description, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
        ON CONFLICT (bill_number) DO NOTHING
      `, [billNum, suppId, billDate, dueDate, baseAmt, gst, total, paid, status, desc]);
    }
    console.log('✅ Seeded bills: 12');

    // ════════════════════════════════════════════════════════════
    // 9. JOURNAL ENTRIES
    // ════════════════════════════════════════════════════════════
    const jeData = [
      { ref: 'JE-2026-001', date: '2026-01-31', narration: 'Salary payment January 2026', lines: [['5000',3200000,'dr'],['1010',3200000,'cr']] },
      { ref: 'JE-2026-002', date: '2026-01-31', narration: 'PF contribution January 2026', lines: [['5010',384000,'dr'],['2400',384000,'cr']] },
      { ref: 'JE-2026-003', date: '2026-01-31', narration: 'Office rent January 2026',    lines: [['5100',85000,'dr'],['1010',85000,'cr']] },
      { ref: 'JE-2026-004', date: '2026-01-31', narration: 'AWS services January 2026',   lines: [['5210',45000,'dr'],['2000',45000,'cr']] },
      { ref: 'JE-2026-005', date: '2026-01-15', narration: 'Invoice receipt CUST002',     lines: [['1010',1003000,'dr'],['1100',1003000,'cr']] },
      { ref: 'JE-2026-006', date: '2026-02-05', narration: 'Invoice receipt CUST003',     lines: [['1010',212040,'dr'],['1100',212040,'cr']] },
      { ref: 'JE-2026-007', date: '2026-02-28', narration: 'Salary payment February 2026',lines: [['5000',3200000,'dr'],['1010',3200000,'cr']] },
      { ref: 'JE-2026-008', date: '2026-02-28', narration: 'PF contribution February 2026',lines:[['5010',384000,'dr'],['2400',384000,'cr']] },
      { ref: 'JE-2026-009', date: '2026-02-28', narration: 'Office rent February 2026',   lines: [['5100',85000,'dr'],['1010',85000,'cr']] },
      { ref: 'JE-2026-010', date: '2026-02-28', narration: 'AWS services February 2026',  lines: [['5210',47500,'dr'],['1010',47500,'cr']] },
      { ref: 'JE-2026-011', date: '2026-02-10', narration: 'Invoice INV-2025-013 booked', lines: [['1100',920040,'dr'],['4010',780000,'cr'],['2100',70200,'cr'],['2110',70200,'cr']] },
      { ref: 'JE-2026-012', date: '2026-02-20', narration: 'Invoice INV-2025-014 booked', lines: [['1100',283200,'dr'],['4000',240000,'cr'],['2100',21600,'cr'],['2110',21600,'cr']] },
      { ref: 'JE-2026-013', date: '2026-03-05', narration: 'Zoho CRM license payment',    lines: [['5200',15000,'dr'],['1010',15000,'cr']] },
      { ref: 'JE-2026-014', date: '2026-03-10', narration: 'TDS deposited to NSDL',       lines: [['2200',95000,'dr'],['1010',95000,'cr']] },
      { ref: 'JE-2026-015', date: '2026-03-15', narration: 'Advance received from TVS',   lines: [['1010',200000,'dr'],['2600',200000,'cr']] },
      { ref: 'JE-2026-016', date: '2026-03-31', narration: 'Salary payment March 2026',   lines: [['5000',3200000,'dr'],['1010',3200000,'cr']] },
      { ref: 'JE-2026-017', date: '2026-03-31', narration: 'PF contribution March 2026',  lines: [['5010',384000,'dr'],['2400',384000,'cr']] },
      { ref: 'JE-2026-018', date: '2026-03-31', narration: 'Office rent March 2026',      lines: [['5100',85000,'dr'],['2000',85000,'cr']] },
      { ref: 'JE-2026-019', date: '2026-03-31', narration: 'Depreciation Q1 2026',        lines: [['5700',87500,'dr'],['1900',87500,'cr']] },
      { ref: 'JE-2026-020', date: '2026-03-31', narration: 'GST payment March 2026',      lines: [['2100',180000,'dr'],['2110',180000,'cr'],['1010',360000,'cr']] },
    ];

    for (const je of jeData) {
      const totalDr = je.lines.filter(l=>l[2]==='dr').reduce((s,l)=>s+l[1],0);
      const { rows: [jeRow] } = await client.query(`
        INSERT INTO journal_entries (reference_number, entry_date, narration, total_debit, total_credit, status, created_at)
        VALUES ($1,$2,$3,$4,$4,'posted',NOW())
        ON CONFLICT (reference_number) DO NOTHING
        RETURNING id
      `, [je.ref, je.date, je.narration, totalDr]);

      if (jeRow) {
        for (const [accCode, amt, side] of je.lines) {
          await client.query(`
            INSERT INTO journal_lines (journal_entry_id, account_code, debit_amount, credit_amount, created_at)
            VALUES ($1,$2,$3,$4,NOW())
          `, [jeRow.id, accCode, side==='dr'?amt:0, side==='cr'?amt:0]);
        }
      }
    }
    console.log('✅ Seeded journal_entries: 20');

    // ════════════════════════════════════════════════════════════
    // 10. PROJECTS
    // ════════════════════════════════════════════════════════════
    const pmId = empByCode['EMP004'].id;
    const pm2Id = empByCode['EMP002'].id;

    const projectsData = [
      ['PROJ001','ERP Implementation - TVS Motor Co',    '2025-09-01','2026-06-30',4500000, pmId,  'ongoing',   65,'The complete ERP rollout for TVS Motor Company covering Finance, HR, and Supply Chain modules.'],
      ['PROJ002','Cloud Migration - Apollo Hospitals',   '2025-11-01','2026-03-31',2800000, pm2Id, 'completed', 100,'Migration of on-premise infrastructure to AWS cloud for Apollo Hospitals IT division.'],
      ['PROJ003','Mobile App Development - CavinKare',   '2026-01-15','2026-07-15',1800000, pmId,  'ongoing',   40,'Native mobile app for field sales team including CRM integration and offline support.'],
      ['PROJ004','Data Analytics Dashboard - HDFC Bank', '2025-10-01','2026-04-30',5000000, pm2Id, 'at_risk',   55,'Real-time analytics platform with BI dashboards for HDFC Bank retail division.'],
      ['PROJ005','IT Security Audit - Murugappa Group',  '2026-01-01','2026-03-15',900000,  pmId,  'completed', 100,'Comprehensive IT security assessment and vulnerability testing for Murugappa Group.'],
      ['PROJ006','Chatbot Integration - Sundaram Finance','2025-12-01','2026-05-31',1500000, pmId,  'at_risk',   30,'AI-powered customer service chatbot integration with existing loan management system.'],
      ['PROJ007','Annual Support Contract - Ramco',      '2026-01-01','2026-12-31',480000,  pm2Id, 'ongoing',   25,'Dedicated support team for Ramco ERP system maintenance and enhancements.'],
      ['PROJ008','Data Warehouse - Ashok Leyland',       '2026-03-01','2026-12-31',3200000, pmId,  'planning',  5, 'Enterprise data warehouse implementation with real-time data pipelines and ML capabilities.'],
    ];
    for (const [code,name,startDate,endDate,budget,pmId2,status,progress,desc] of projectsData) {
      await client.query(`
        INSERT INTO projects (project_code, project_name, start_date, end_date, budget,
          project_manager_id, status, progress_percentage, description, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
        ON CONFLICT (project_code) DO NOTHING
      `, [code,name,startDate,endDate,budget,pmId2,status,progress,desc]);
    }
    console.log('✅ Seeded projects: 8');

    const { rows: projRows } = await client.query(`SELECT id, project_code FROM projects ORDER BY project_code`);
    const projByCode = {};
    projRows.forEach(r => { projByCode[r.project_code] = r; });

    // ════════════════════════════════════════════════════════════
    // 11. TASKS (40 tasks spread across projects)
    // ════════════════════════════════════════════════════════════
    const tasks = [
      // PROJ001 - ERP Implementation TVS (ongoing)
      [projByCode['PROJ001']?.id,'Requirements Gathering & Analysis','completed', empByCode['EMP005'].id,'2025-09-01','2025-09-30','high'],
      [projByCode['PROJ001']?.id,'System Architecture Design',       'completed', empByCode['EMP002'].id,'2025-10-01','2025-10-31','high'],
      [projByCode['PROJ001']?.id,'Finance Module Development',       'completed', empByCode['EMP006'].id,'2025-11-01','2025-12-31','high'],
      [projByCode['PROJ001']?.id,'HR Module Development',            'in_progress',empByCode['EMP007'].id,'2026-01-01','2026-02-28','high'],
      [projByCode['PROJ001']?.id,'Supply Chain Module Development',  'in_progress',empByCode['EMP010'].id,'2026-02-01','2026-03-31','high'],
      [projByCode['PROJ001']?.id,'User Acceptance Testing',          'todo',      empByCode['EMP047'].id,'2026-04-01','2026-05-15','medium'],
      [projByCode['PROJ001']?.id,'Go-live Preparation',              'todo',      empByCode['EMP004'].id,'2026-05-16','2026-06-15','high'],
      // PROJ002 - Cloud Migration Apollo (completed)
      [projByCode['PROJ002']?.id,'Infrastructure Assessment',        'completed', empByCode['EMP015'].id,'2025-11-01','2025-11-15','high'],
      [projByCode['PROJ002']?.id,'AWS Architecture Setup',           'completed', empByCode['EMP019'].id,'2025-11-16','2025-12-15','high'],
      [projByCode['PROJ002']?.id,'Data Migration',                   'completed', empByCode['EMP013'].id,'2025-12-16','2026-01-31','high'],
      [projByCode['PROJ002']?.id,'Testing & Validation',             'completed', empByCode['EMP048'].id,'2026-02-01','2026-02-28','high'],
      [projByCode['PROJ002']?.id,'Cutover & Handover',               'completed', empByCode['EMP015'].id,'2026-03-01','2026-03-15','high'],
      // PROJ003 - Mobile App CavinKare
      [projByCode['PROJ003']?.id,'UI/UX Design',                     'completed', empByCode['EMP010'].id,'2026-01-15','2026-02-14','medium'],
      [projByCode['PROJ003']?.id,'Backend API Development',          'in_progress',empByCode['EMP012'].id,'2026-02-01','2026-03-31','high'],
      [projByCode['PROJ003']?.id,'iOS App Development',              'in_progress',empByCode['EMP018'].id,'2026-02-15','2026-04-30','high'],
      [projByCode['PROJ003']?.id,'Android App Development',          'todo',      empByCode['EMP018'].id,'2026-03-01','2026-05-31','high'],
      [projByCode['PROJ003']?.id,'QA Testing',                       'todo',      empByCode['EMP049'].id,'2026-05-01','2026-06-30','medium'],
      // PROJ004 - Data Analytics HDFC (at_risk)
      [projByCode['PROJ004']?.id,'Data Source Integration',          'completed', empByCode['EMP019'].id,'2025-10-01','2025-11-30','high'],
      [projByCode['PROJ004']?.id,'Data Pipeline Development',        'in_progress',empByCode['EMP013'].id,'2025-12-01','2026-02-28','high'],
      [projByCode['PROJ004']?.id,'Dashboard Development',            'blocked',   empByCode['EMP011'].id,'2026-01-01','2026-03-31','high'],
      [projByCode['PROJ004']?.id,'Performance Optimization',         'todo',      empByCode['EMP019'].id,'2026-03-01','2026-04-15','medium'],
      // PROJ005 - Security Audit (completed)
      [projByCode['PROJ005']?.id,'Penetration Testing',              'completed', empByCode['EMP015'].id,'2026-01-01','2026-02-15','high'],
      [projByCode['PROJ005']?.id,'Vulnerability Assessment Report',  'completed', empByCode['EMP047'].id,'2026-02-16','2026-03-05','high'],
      [projByCode['PROJ005']?.id,'Remediation Guidance',             'completed', empByCode['EMP015'].id,'2026-03-06','2026-03-15','medium'],
      // PROJ006 - Chatbot (at_risk)
      [projByCode['PROJ006']?.id,'Chatbot NLP Training',             'in_progress',empByCode['EMP019'].id,'2025-12-01','2026-03-31','high'],
      [projByCode['PROJ006']?.id,'CRM API Integration',              'blocked',   empByCode['EMP012'].id,'2026-02-01','2026-04-30','high'],
      [projByCode['PROJ006']?.id,'UAT with Customer',                'todo',      empByCode['EMP039'].id,'2026-04-01','2026-05-15','medium'],
      // PROJ007 - Support Contract Ramco
      [projByCode['PROJ007']?.id,'Monthly Issue Resolution - Q1',    'completed', empByCode['EMP007'].id,'2026-01-01','2026-03-31','medium'],
      [projByCode['PROJ007']?.id,'Monthly Issue Resolution - Q2',    'in_progress',empByCode['EMP008'].id,'2026-04-01','2026-06-30','medium'],
      // PROJ008 - Data Warehouse Ashok Leyland (planning)
      [projByCode['PROJ008']?.id,'Project Kickoff & Planning',       'in_progress',empByCode['EMP004'].id,'2026-03-01','2026-03-31','high'],
      [projByCode['PROJ008']?.id,'Technology Stack Selection',       'todo',      empByCode['EMP002'].id,'2026-04-01','2026-04-15','medium'],
      [projByCode['PROJ008']?.id,'Data Modeling',                    'todo',      empByCode['EMP019'].id,'2026-04-16','2026-05-31','high'],
    ];
    for (const [projId,title,status,assigneeId,startD,dueD,priority] of tasks) {
      if (!projId) continue;
      await client.query(`
        INSERT INTO tasks (project_id, title, status, assigned_to, start_date, due_date, priority, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT DO NOTHING
      `, [projId,title,status,assigneeId,startD,dueD,priority]);
    }
    console.log('✅ Seeded tasks: 32');

    // ════════════════════════════════════════════════════════════
    // 12. TIMESHEETS (last 4 weeks, 20 employees)
    // ════════════════════════════════════════════════════════════
    const { rows: tsEmpRows } = await client.query(
      `SELECT id FROM employees WHERE status='active' ORDER BY id LIMIT 20`
    );
    let tsCount = 0;
    for (const emp of tsEmpRows) {
      for (let week = 1; week <= 4; week++) {
        const weekStart = addDays(today, -(week * 7));
        const { rows: [tsRow] } = await client.query(`
          INSERT INTO timesheets (employee_id, week_start_date, week_end_date, total_hours, status, created_at)
          VALUES ($1, $2, $3, 0, $4, NOW())
          ON CONFLICT (employee_id, week_start_date) DO UPDATE SET status=EXCLUDED.status
          RETURNING id
        `, [emp.id, fmt(weekStart), fmt(addDays(weekStart, 6)), week <= 2 ? 'approved' : 'submitted']);

        if (tsRow) {
          let totalHrs = 0;
          for (let d = 0; d < 5; d++) {
            const entryDate = addDays(weekStart, d);
            const hrs = randomBetween(6, 9);
            const projId = projRows[Math.floor(Math.random() * Math.min(projRows.length, 6))].id;
            await client.query(`
              INSERT INTO timesheet_entries (timesheet_id, project_id, date, hours, description, created_at)
              VALUES ($1,$2,$3,$4,$5,NOW())
              ON CONFLICT DO NOTHING
            `, [tsRow.id, projId, fmt(entryDate), hrs, 'Development & implementation work']);
            totalHrs += hrs;
            tsCount++;
          }
          await client.query(`UPDATE timesheets SET total_hours=$1 WHERE id=$2`, [totalHrs, tsRow.id]);
        }
      }
    }
    console.log(`✅ Seeded timesheet entries: ~${tsCount}`);

    // ════════════════════════════════════════════════════════════
    // 13. CRM DATA
    // ════════════════════════════════════════════════════════════
    // CRM Accounts
    const crmAccounts = [
      ['ACC001','Tata Steel Limited',       'Enterprise','Manufacturing','tata.com',           'accounts@tata.com',       '9022011234','Mumbai',   5000000000],
      ['ACC002','Infosys BPM Ltd',          'Enterprise','IT Services', 'infosysbpm.com',      'vendor@infosysbpm.com',   '9080012345','Bangalore',8000000000],
      ['ACC003','Chennai Port Trust',        'Government','Logistics',   'chennaiport.gov.in',  'it@chennaiport.gov.in',   '9044021234','Chennai',  null],
      ['ACC004','Dalmia Bharat Group',       'Mid-Market','Manufacturing','dalmiabharat.com',   'tech@dalmiabharat.com',   '9011012345','Delhi',    2000000000],
      ['ACC005','Sify Technologies Ltd',     'Mid-Market','IT Services', 'sify.com',            'sales@sify.com',          '9044031234','Chennai',  500000000],
      ['ACC006','Coromandel International', 'Mid-Market','Agriculture', 'coromandel.com',      'it@coromandel.com',       '9044041234','Hyderabad',1000000000],
      ['ACC007','Matrimony.com Ltd',         'SME',       'Technology',  'matrimony.com',       'tech@matrimony.com',      '9044051234','Chennai',  200000000],
      ['ACC008','India Cements Limited',     'Enterprise','Manufacturing','indiacements.com',   'corporate.it@indiacements.com','9044061234','Chennai',1500000000],
    ];
    for (const [code,name,segment,industry,website,email,phone,city,revenue] of crmAccounts) {
      await client.query(`
        INSERT INTO accounts (account_code, account_name, segment, industry, website, email, phone, city, annual_revenue, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
        ON CONFLICT (account_code) DO NOTHING
      `, [code,name,segment,industry,website,email,phone,city,revenue]);
    }

    // CRM Leads
    const leadsData = [
      ['LEAD001','L&T Technology Services',   'Ravi Kumar',     'ravi.kumar@ltts.com',    '9022021234','Cold Call',    'Prospecting', 2500000,'ERP Implementation',   empByCode['EMP022'].id],
      ['LEAD002','Wipro Limited',             'Anand Sharma',   'anand.s@wipro.com',      '9080022345','Website',      'Qualified',   1800000,'Cloud Migration',       empByCode['EMP023'].id],
      ['LEAD003','Cognizant Technology',      'Priya Mehta',    'priya.m@cognizant.com',  '9044071234','Referral',     'Demo',        3200000,'Data Analytics',        empByCode['EMP022'].id],
      ['LEAD004','Titan Company Ltd',         'Suresh Iyer',    'suresh.i@titan.co.in',   '9080033456','LinkedIn',     'Proposal',    950000, 'Mobile App',             empByCode['EMP023'].id],
      ['LEAD005','Mphasis Limited',           'Kavitha Nair',   'kavitha.n@mphasis.com',  '9080044567','Email Outreach','Negotiation',2200000,'IT Consulting',          empByCode['EMP022'].id],
      ['LEAD006','Hexaware Technologies',     'Deepak Raj',     'deepak.r@hexaware.com',  '9022031234','Conference',   'Closed Won',  1500000,'Annual Support',         empByCode['EMP023'].id],
      ['LEAD007','CSS Corp Pvt Ltd',          'Arun Pillai',    'arun.p@csscorp.com',     '9044081234','Cold Call',    'Closed Lost', 800000, 'Software Audit',         empByCode['EMP024'].id],
      ['LEAD008','NTT Data India',            'Srinivasan M',   'srinivasan.m@nttdata.com','9080055678','Website',     'Prospecting', 4500000,'ERP Implementation',   empByCode['EMP022'].id],
      ['LEAD009','Dmart (Avenue Supermarts)', 'Ramesh Gupta',   'ramesh.g@dmart.in',      '9022041234','Referral',     'Qualified',   2800000,'Retail Analytics',       empByCode['EMP025'].id],
      ['LEAD010','Piramal Group',             'Neha Bhat',      'neha.b@piramal.com',     '9022051234','LinkedIn',     'Demo',        1200000,'Compliance Software',    empByCode['EMP023'].id],
      ['LEAD011','Reliance Jio',              'Vikram Singh',   'vikram.s@jio.com',       '9022061234','Conference',   'Proposal',    6000000,'Network Management',     empByCode['EMP022'].id],
      ['LEAD012','Sun TV Network',            'Lakshmi Raj',    'lakshmi.r@suntv.com',    '9044091234','Cold Call',    'Prospecting', 900000, 'Content Management',     empByCode['EMP026'].id],
    ];
    for (const [code,company,contact,email,phone,source,stage,value,req,ownerId] of leadsData) {
      await client.query(`
        INSERT INTO leads (lead_code, company_name, contact_person, email, phone, lead_source,
          status, estimated_value, requirements, owner_id, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
        ON CONFLICT (lead_code) DO NOTHING
      `, [code,company,contact,email,phone,source,stage,value,req,ownerId]);
    }

    // Opportunities
    const oppsData = [
      ['OPP001','ERP for L&T Technology',     2500000,'Proposal',   '2026-06-30',60,'LEAD001',empByCode['EMP022'].id],
      ['OPP002','Cloud Migration for Wipro',  1800000,'Negotiation','2026-05-31',75,'LEAD002',empByCode['EMP023'].id],
      ['OPP003','Analytics for Cognizant',    3200000,'Demo',       '2026-07-31',40,'LEAD003',empByCode['EMP022'].id],
      ['OPP004','Mobile App for Titan',       950000, 'Negotiation','2026-04-30',80,'LEAD004',empByCode['EMP023'].id],
      ['OPP005','IT Consulting - Mphasis',    2200000,'Proposal',   '2026-06-15',55,'LEAD005',empByCode['EMP022'].id],
      ['OPP006','Annual Support - Hexaware',  1500000,'Closed Won', '2026-03-31',100,'LEAD006',empByCode['EMP023'].id],
    ];
    for (const [code,name,value,stage,closeDate,prob,leadCode,ownerId] of oppsData) {
      await client.query(`
        INSERT INTO opportunities (opportunity_code, opportunity_name, deal_value, stage,
          expected_close_date, probability, lead_code, owner_id, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
        ON CONFLICT (opportunity_code) DO NOTHING
      `, [code,name,value,stage,closeDate,prob,leadCode,ownerId]);
    }
    console.log('✅ Seeded CRM data: 8 accounts, 12 leads, 6 opportunities');

    // CRM Contacts — primary + secondary contacts per account
    const { rows: accRows } = await client.query(
      `SELECT id, account_code FROM accounts ORDER BY account_code`
    );
    const accByCode = Object.fromEntries(accRows.map(a => [a.account_code, a]));

    const contactsData = [
      // [first, last, title, designation, department, email, phone, mobile, is_primary, account_code]
      ['Rajesh',   'Kumar',       'Mr',  'CEO',                    'Executive', 'rajesh.kumar@tata.com',       '9022011001', '9022011001', true,  'ACC001'],
      ['Ananya',   'Sharma',      'Ms',  'VP Procurement',         'Procurement','ananya.s@tata.com',           '9022011002', '9022011002', false, 'ACC001'],
      ['Sunita',   'Patel',       'Ms',  'CTO',                    'IT',        'sunita.patel@infosysbpm.com', '9080012001', '9080012001', true,  'ACC002'],
      ['Vikram',   'Nair',        'Mr',  'Head of Data',           'Analytics', 'vikram.n@infosysbpm.com',     '9080012002', '9080012002', false, 'ACC002'],
      ['Arjun',    'Pillai',      'Mr',  'IT Director',            'IT',        'arjun.pillai@chennaiport.gov.in','9044021001','9044021001',true,  'ACC003'],
      ['Priya',    'Meenakshi',   'Ms',  'Procurement Manager',    'Procurement','priya.m@chennaiport.gov.in',  '9044021002', '9044021002', false, 'ACC003'],
      ['Suresh',   'Iyer',        'Mr',  'CFO',                    'Finance',   'suresh.iyer@dalmiabharat.com','9011012001', '9011012001', true,  'ACC004'],
      ['Kavitha',  'Rajan',       'Ms',  'Head of IT',             'IT',        'kavitha.r@dalmiabharat.com',  '9011012002', '9011012002', false, 'ACC004'],
      ['Deepak',   'Krishnamurthy','Mr', 'IT Head',                'IT',        'deepak.k@sify.com',           '9044031001', '9044031001', true,  'ACC005'],
      ['Neha',     'Singh',       'Ms',  'Head of Operations',     'Operations','neha.s@coromandel.com',       '9044041001', '9044041001', true,  'ACC006'],
      ['Arun',     'Mathew',      'Mr',  'CTO',                    'Technology','arun.m@matrimony.com',        '9044051001', '9044051001', true,  'ACC007'],
      ['Lakshmi',  'Venkatesh',   'Ms',  'Head of Procurement',    'Procurement','lakshmi.v@indiacements.com', '9044061001', '9044061001', true,  'ACC008'],
    ];

    for (const [fn,ln,ti,desig,dept,email,phone,mobile,isPrimary,accCode] of contactsData) {
      const acc = accByCode[accCode];
      if (!acc) continue;
      await client.query(`
        INSERT INTO contacts
          (first_name, last_name, title, full_name, designation, department,
           email, phone, mobile, is_primary, account_id, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
        ON CONFLICT DO NOTHING
      `, [fn, ln, ti, `${fn} ${ln}`, desig, dept, email, phone, mobile, isPrimary, acc.id]);
    }
    console.log('✅ Seeded CRM contacts: 12 contacts across 8 accounts');

    // ════════════════════════════════════════════════════════════
    // 14. PURCHASE REQUESTS & ORDERS
    // ════════════════════════════════════════════════════════════
    const prData = [
      ['PR-2026-001',empByCode['EMP038'].id,'2026-01-10','Laptops for new hires',         'approved'],
      ['PR-2026-002',empByCode['EMP015'].id,'2026-01-15','Additional AWS Reserved Instances','approved'],
      ['PR-2026-003',empByCode['EMP034'].id,'2026-01-20','Tally ERP Licenses (5 users)',  'approved'],
      ['PR-2026-004',empByCode['EMP043'].id,'2026-02-05','Marketing collateral printing',  'approved'],
      ['PR-2026-005',empByCode['EMP038'].id,'2026-02-10','Office chairs and desks (10)',   'approved'],
      ['PR-2026-006',empByCode['EMP004'].id,'2026-02-20','GitHub Enterprise licenses',     'pending'],
      ['PR-2026-007',empByCode['EMP030'].id,'2026-03-01','HR software module upgrade',     'draft'],
      ['PR-2026-008',empByCode['EMP015'].id,'2026-03-15','SSL certificates renewal',       'pending'],
    ];
    for (const [prNum,reqId,prDate,desc,status] of prData) {
      await client.query(`
        INSERT INTO purchase_requests (pr_number, requested_by, request_date, description, status, created_at)
        VALUES ($1,$2,$3,$4,$5,NOW())
        ON CONFLICT (pr_number) DO NOTHING
      `, [prNum,reqId,prDate,desc,status]);
    }

    const { rows: prRows } = await client.query(`SELECT id, pr_number FROM purchase_requests ORDER BY pr_number`);
    const prByNum = {};
    prRows.forEach(r => { prByNum[r.pr_number] = r; });

    const poData = [
      ['PO-2026-001',suppByCode['SUPP007']?.id,prByNum['PR-2026-001']?.id,'2026-01-20','2026-02-10',125000,'approved'],
      ['PO-2026-002',suppByCode['SUPP001']?.id,prByNum['PR-2026-002']?.id,'2026-01-25','2026-02-01',180000,'received'],
      ['PO-2026-003',suppByCode['SUPP006']?.id,prByNum['PR-2026-003']?.id,'2026-01-28','2026-02-15',45000, 'received'],
      ['PO-2026-004',suppByCode['SUPP007']?.id,prByNum['PR-2026-004']?.id,'2026-02-12','2026-03-01',35000, 'received'],
      ['PO-2026-005',suppByCode['SUPP007']?.id,prByNum['PR-2026-005']?.id,'2026-02-18','2026-03-15',85000, 'approved'],
    ];
    for (const [poNum,suppId,prId,poDate,delDate,total,status] of poData) {
      if (!suppId || !prId) continue;
      await client.query(`
        INSERT INTO purchase_orders (po_number, supplier_id, pr_id, po_date, expected_delivery_date,
          total_amount, status, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT (po_number) DO NOTHING
      `, [poNum,suppId,prId,poDate,delDate,total,status]);
    }

    const { rows: poRows } = await client.query(`SELECT id, po_number FROM purchase_orders ORDER BY po_number`);
    const poByNum = {};
    poRows.forEach(r => { poByNum[r.po_number] = r; });

    // GRNs
    const grnData = [
      ['GRN-2026-001',poByNum['PO-2026-002']?.id,'2026-02-03','All items received in good condition'],
      ['GRN-2026-002',poByNum['PO-2026-003']?.id,'2026-02-16','License keys delivered via email'],
      ['GRN-2026-003',poByNum['PO-2026-004']?.id,'2026-02-28','Printed materials received, 2 boxes'],
    ];
    for (const [grnNum,poId,recDate,notes] of grnData) {
      if (!poId) continue;
      await client.query(`
        INSERT INTO goods_receipts (grn_number, po_id, received_date, notes, status, created_at)
        VALUES ($1,$2,$3,$4,'completed',NOW())
        ON CONFLICT (grn_number) DO NOTHING
      `, [grnNum,poId,recDate,notes]);
    }
    console.log('✅ Seeded PRs: 8, POs: 5, GRNs: 3');

    // ════════════════════════════════════════════════════════════
    // 15. INVENTORY ITEMS
    // ════════════════════════════════════════════════════════════
    const invItems = [
      // Software Licenses (10)
      ['INV-001','Microsoft Office 365',    'Software License','unit', 35, 2800, 10,'Chennai HQ'],
      ['INV-002','Adobe Creative Suite',    'Software License','unit', 8,  9500, 3, 'Chennai HQ'],
      ['INV-003','Jira Software',           'Software License','unit', 50, 1200, 10,'Chennai HQ'],
      ['INV-004','Figma Professional',      'Software License','unit', 12, 1500, 5, 'Chennai HQ'],
      ['INV-005','Slack Business+',         'Software License','unit', 50, 900,  10,'Chennai HQ'],
      ['INV-006','Zoom Pro',               'Software License','unit', 20, 1100, 5, 'Chennai HQ'],
      ['INV-007','GitHub Enterprise',       'Software License','unit', 40, 2500, 10,'Chennai HQ'],
      ['INV-008','Zoho CRM Professional',   'Software License','user', 15, 1800, 5, 'Chennai HQ'],
      ['INV-009','Postman Business',        'Software License','unit', 4,  1400, 5, 'Chennai HQ'],  // below reorder
      ['INV-010','DataGrip IDE',            'Software License','unit', 3,  2200, 5, 'Chennai HQ'],  // below reorder
      // Hardware (5)
      ['INV-011','Dell Laptop (Core i7)',   'Hardware',       'unit', 8,  85000,5, 'Chennai HQ'],
      ['INV-012','LG Monitor 27"',         'Hardware',       'unit', 5,  22000,4, 'Chennai HQ'],
      ['INV-013','HP LaserJet Printer',     'Hardware',       'unit', 2,  35000,1, 'Chennai HQ'],
      ['INV-014','Cisco IP Phone',          'Hardware',       'unit', 6,  8500, 5, 'Chennai HQ'],
      ['INV-015','Logitech Webcam C920',    'Hardware',       'unit', 2,  4500, 3, 'Chennai HQ'],  // below reorder
      // Office Supplies (5)
      ['INV-016','A4 Paper (Ream)',         'Office Supply',  'ream', 45, 350,  20,'Chennai HQ'],
      ['INV-017','Ballpoint Pens (Box)',    'Office Supply',  'box',  12, 120,  5, 'Chennai HQ'],
      ['INV-018','Whiteboard Markers',      'Office Supply',  'set',  8,  250,  4, 'Chennai HQ'],
      ['INV-019','Stapler + Staples Set',   'Office Supply',  'unit', 6,  180,  3, 'Chennai HQ'],
      ['INV-020','File Folders (Pack)',     'Office Supply',  'pack', 20, 200,  8, 'Chennai HQ'],
    ];
    for (const [code,name,cat,unit,qty,cost,reorder,wh] of invItems) {
      await client.query(`
        INSERT INTO inventory_items (item_code, item_name, category, unit_of_measure,
          current_quantity, unit_cost, reorder_point, warehouse, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
        ON CONFLICT (item_code) DO NOTHING
      `, [code,name,cat,unit,qty,cost,reorder,wh]);
    }
    console.log('✅ Seeded inventory_items: 20 (3 below reorder point)');

    // ════════════════════════════════════════════════════════════
    // 16. PAYROLL (2 months: Jan & Feb 2026)
    // ════════════════════════════════════════════════════════════
    for (const month of [{ label: '2026-01', name: 'January 2026', status: 'paid', paidAll: true },
                         { label: '2026-02', name: 'February 2026', status: 'completed', paidAll: false }]) {
      const { rows: [runRow] } = await client.query(`
        INSERT INTO payroll_runs (period_label, period_name, period_start, period_end,
          status, created_at)
        VALUES ($1,$2,$3,$4,$5,NOW())
        ON CONFLICT (period_label) DO UPDATE SET status=EXCLUDED.status
        RETURNING id
      `, [month.label, month.name, `${month.label}-01`, `${month.label}-28`, month.status]);

      if (!runRow) continue;

      let slipCount = 0;
      for (const emp of empRows) {
        const basic = parseFloat(emp.basic_salary);
        const hra = parseFloat((basic * 0.40).toFixed(2));
        const conveyance = 1600;
        const medical = 1250;
        const gross = basic + hra + conveyance + medical;
        const specialAllowance = Math.max(0, Math.round((gross - basic - hra - conveyance - medical) / 100) * 100);

        // Deductions
        const pfBasic = Math.min(basic, 15000);
        const pf = parseFloat((pfBasic * 0.12).toFixed(2));
        const esi = gross <= 21000 ? parseFloat((gross * 0.0075).toFixed(2)) : 0;
        const pt = gross > 10000 ? 200 : 0;
        const tds = basic >= 50000 ? parseFloat((basic * 0.10).toFixed(2)) : 0;
        const totalDeductions = pf + esi + pt + tds;
        const netPay = parseFloat((gross - totalDeductions).toFixed(2));

        let slipStatus;
        if (month.paidAll) {
          slipStatus = 'paid';
        } else {
          // Feb: 45 paid, 5 pending (last 5 employees)
          slipStatus = empRows.indexOf(emp) < 45 ? 'paid' : 'pending';
        }

        await client.query(`
          INSERT INTO payslips (payroll_run_id, employee_id, basic_salary, hra, conveyance_allowance,
            medical_allowance, special_allowance, gross_salary,
            pf_deduction, esi_deduction, professional_tax, tds_deduction,
            total_deductions, net_pay, status, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
          ON CONFLICT (payroll_run_id, employee_id) DO UPDATE SET status=EXCLUDED.status
        `, [runRow.id, emp.id, basic, hra, conveyance, medical, specialAllowance, gross + specialAllowance,
            pf, esi, pt, tds, totalDeductions, netPay, slipStatus]);
        slipCount++;
      }
      console.log(`✅ Seeded payslips for ${month.name}: ${slipCount} employees`);
    }

    // ════════════════════════════════════════════════════════════
    // 17. SERVICE DESK TICKETS
    // ════════════════════════════════════════════════════════════
    const { rows: [adminUser] } = await client.query(`SELECT id FROM users WHERE email='admin@manifest.in'`);
    const adminId = adminUser?.id;

    const ticketsData = [
      ['TKT-2026-001','Laptop screen flickering on EMP005 machine', 'IT Support','critical','open',      empByCode['EMP005'].id, empByCode['EMP015'].id],
      ['TKT-2026-002','Unable to access VPN from home',             'IT Support','high',    'in_progress',empByCode['EMP010'].id, empByCode['EMP015'].id],
      ['TKT-2026-003','Email not syncing on mobile',               'IT Support','medium',  'resolved',   empByCode['EMP024'].id, empByCode['EMP015'].id],
      ['TKT-2026-004','Salary slip for January not received',      'HR',        'high',    'in_progress',empByCode['EMP033'].id, empByCode['EMP030'].id],
      ['TKT-2026-005','Request for experience letter',             'HR',        'low',     'open',       empByCode['EMP028'].id, null],
      ['TKT-2026-006','Internet very slow in conference room 2',   'IT Support','high',    'in_progress',empByCode['EMP038'].id, empByCode['EMP015'].id],
      ['TKT-2026-007','Printer in 3rd floor not working',         'IT Support','medium',  'open',       empByCode['EMP031'].id, null],
      ['TKT-2026-008','TDS certificate for FY2024-25 required',   'Finance',   'medium',  'resolved',   empByCode['EMP007'].id, empByCode['EMP034'].id],
      ['TKT-2026-009','Access required for CRM module',           'IT Support','low',     'resolved',   empByCode['EMP026'].id, empByCode['EMP015'].id],
      ['TKT-2026-010','Office AC not working in QA bay',          'Operations','medium',  'open',       empByCode['EMP047'].id, empByCode['EMP038'].id],
      ['TKT-2026-011','Claim reimbursement for travel to Bangalore','Finance',  'medium',  'in_progress',empByCode['EMP023'].id, empByCode['EMP034'].id],
      ['TKT-2026-012','New employee onboarding - laptop setup',   'IT Support','high',    'resolved',   empByCode['EMP030'].id, empByCode['EMP015'].id],
      ['TKT-2026-013','Software license expired for Figma',       'IT Support','high',    'in_progress',empByCode['EMP044'].id, empByCode['EMP015'].id],
      ['TKT-2026-014','Leave policy clarification needed',        'HR',        'low',     'open',       empByCode['EMP016'].id, null],
      ['TKT-2026-015','Electricity bill payment in invoice system','Finance',  'critical', 'in_progress',empByCode['EMP036'].id, empByCode['EMP034'].id],
    ];
    for (const [tktNum,title,cat,priority,status,raisedBy,assignedTo] of ticketsData) {
      await client.query(`
        INSERT INTO tickets (ticket_number, title, category, priority, status,
          raised_by, assigned_to, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT (ticket_number) DO NOTHING
      `, [tktNum,title,cat,priority,status,raisedBy,assignedTo]);
    }
    console.log('✅ Seeded service desk tickets: 15');

    // ════════════════════════════════════════════════════════════
    // 18. ANNOUNCEMENTS
    // ════════════════════════════════════════════════════════════
    const announcements = [
      ['Q1 Appraisal Cycle Begins',  'The annual appraisal cycle for FY2025-26 has commenced. All employees must complete their self-assessment by April 15, 2026. Managers should complete team reviews by April 30. Increment letters will be issued by May 15. Please use the Performance module in Pulse ERP to submit your assessment.','2026-04-01','2026-04-30',empByCode['EMP030'].id,'all','high'],
      ['New Leave Policy 2026',       'Effective April 1, 2026, the company introduces Menstrual Leave (2 days/year), Work from Home policy (2 days/week for Engineering), and increases Paternity Leave from 5 to 10 days. Full policy document is available in the HR section.','2026-03-25','2026-12-31',empByCode['EMP030'].id,'all','medium'],
      ['Office Renovation - Block B', 'The Block B office area (2nd floor) will undergo renovation from April 10-20, 2026. Teams affected: QA and Marketing. Temporary seating has been arranged in the 3rd floor conference rooms. Please plan accordingly and carry your laptops.','2026-04-02','2026-04-20',empByCode['EMP038'].id,'all','medium'],
      ['Team Outing - April 2026',    'Annual team outing is scheduled for April 26, 2026 (Saturday). Venue: ECR Beach Resort, Chennai. Buses will depart from office at 8:00 AM. Activities include beach volleyball, bonfire, and cultural programs. RSVP to HR by April 15.','2026-04-01','2026-04-26',empByCode['EMP030'].id,'all','low'],
      ['Mandatory Security Training', 'All employees must complete the Cybersecurity Awareness Training module by April 30, 2026. The training covers phishing prevention, password security, and data handling. Non-completion will be noted in your appraisal. Login to the LMS portal using your company credentials.','2026-03-28','2026-04-30',empByCode['EMP038'].id,'all','high'],
    ];
    for (const [title,content,startDate,endDate,authorId,target,priority] of announcements) {
      await client.query(`
        INSERT INTO announcements (title, content, start_date, end_date, author_id, target_audience, priority, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT DO NOTHING
      `, [title,content,startDate,endDate,authorId,target,priority]);
    }
    console.log('✅ Seeded announcements: 5');

    // ════════════════════════════════════════════════════════════
    // 19. TRAVEL REQUESTS
    // ════════════════════════════════════════════════════════════
    const travelData = [
      [empByCode['EMP022'].id,'Mumbai',   '2026-02-10','2026-02-12','Client meeting with HDFC Bank digital team','approved',  18500],
      [empByCode['EMP004'].id,'Bangalore','2026-02-15','2026-02-16','Project kickoff meeting with client',         'approved',  9500],
      [empByCode['EMP005'].id,'Hyderabad','2026-02-20','2026-02-22','Technical conference: AWS re:Invent India',   'approved',  14200],
      [empByCode['EMP023'].id,'Delhi',    '2026-02-25','2026-02-27','Sales pitch to Tata Steel IT head',           'approved',  22000],
      [empByCode['EMP034'].id,'Mumbai',   '2026-03-01','2026-03-02','Finance compliance meeting',                  'completed', 11500],
      [empByCode['EMP002'].id,'Pune',     '2026-03-05','2026-03-06','Architecture review with Infosys team',       'completed', 8500],
      [empByCode['EMP043'].id,'Bangalore','2026-03-10','2026-03-12','Digital Marketing Summit 2026',               'completed', 16500],
      [empByCode['EMP047'].id,'Chennai',  '2026-03-20','2026-03-20','QA certification exam (local)',               'completed', 2500],
      [empByCode['EMP007'].id,'Mumbai',   '2026-04-08','2026-04-10','ERP demo for NTT Data India',                 'pending',   19500],
      [empByCode['EMP022'].id,'Bangalore','2026-04-15','2026-04-17','Partner conference: Salesforce World Tour',   'pending',   13500],
    ];
    for (const [empId,dest,startDate,endDate,purpose,status,estimatedCost] of travelData) {
      await client.query(`
        INSERT INTO travel_requests (employee_id, destination, travel_start_date, travel_end_date,
          purpose, status, estimated_cost, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT DO NOTHING
      `, [empId,dest,startDate,endDate,purpose,status,estimatedCost]);
    }
    console.log('✅ Seeded travel_requests: 10');

    // ════════════════════════════════════════════════════════════
    // 20. PERFORMANCE REVIEWS
    // ════════════════════════════════════════════════════════════
    const reviewees = empRows.slice(0, 30);
    for (const emp of reviewees) {
      const rating = (Math.random() * 2 + 3).toFixed(1); // 3.0 - 5.0
      const status = empRows.indexOf(emp) < 20 ? 'approved' : 'submitted';
      await client.query(`
        INSERT INTO performance_reviews (employee_id, review_period, review_year,
          work_quality_rating, productivity_rating, teamwork_rating, communication_rating,
          overall_rating, status, reviewer_id, created_at)
        VALUES ($1,'FY2025-26',2026,$2,$3,$4,$5,$6,$7,$8,NOW())
        ON CONFLICT (employee_id, review_period) DO NOTHING
      `, [emp.id,
          (Math.random()*2+3).toFixed(1), (Math.random()*2+3).toFixed(1),
          (Math.random()*2+3).toFixed(1), (Math.random()*2+3).toFixed(1),
          rating, status, empByCode['EMP004'].id]);
    }
    console.log('✅ Seeded performance_reviews: 30');

    // ════════════════════════════════════════════════════════════
    // 21. GOALS
    // ════════════════════════════════════════════════════════════
    const goalsData = [
      [empByCode['EMP001'].id,'Company Revenue Target Q1 2026',   'Achieve ₹1.5 Cr revenue in Q1 2026 through new client acquisition and renewals','business','2026-01-01','2026-03-31',80,'in_progress'],
      [empByCode['EMP022'].id,'Sales Target Q1 2026',             'Close deals worth ₹50L in Q1 through pipeline conversion',                    'sales',   '2026-01-01','2026-03-31',70,'in_progress'],
      [empByCode['EMP004'].id,'Project Delivery Excellence',       'Deliver all ongoing projects on time with >90% customer satisfaction score', 'operations','2026-01-01','2026-06-30',60,'in_progress'],
      [empByCode['EMP005'].id,'AWS Solutions Architect Certification','Complete AWS SAA-C03 certification by March 31',                          'learning','2026-01-01','2026-03-31',90,'completed'],
      [empByCode['EMP006'].id,'React Performance Optimization',    'Reduce page load time by 40% across all frontend modules',                  'technical','2026-01-01','2026-03-31',100,'completed'],
      [empByCode['EMP007'].id,'Code Quality Improvement',          'Achieve >80% code coverage in all new modules',                             'technical','2026-01-01','2026-06-30',55,'in_progress'],
      [empByCode['EMP010'].id,'UI/UX Design System',              'Create and document a unified design system for Pulse ERP',                 'technical','2026-01-01','2026-06-30',40,'in_progress'],
      [empByCode['EMP015'].id,'DevOps Maturity',                  'Implement full CI/CD pipeline and reduce deployment time by 60%',           'technical','2026-01-01','2026-06-30',75,'in_progress'],
      [empByCode['EMP019'].id,'Data Platform Setup',              'Build real-time data pipeline processing 1M events/day',                    'technical','2026-01-01','2026-06-30',50,'in_progress'],
      [empByCode['EMP030'].id,'Talent Acquisition',               'Hire 8 engineers by June 2026 to support growth',                          'hr',      '2026-01-01','2026-06-30',37,'in_progress'],
      [empByCode['EMP034'].id,'Finance Automation',               'Automate monthly closing process, reduce time from 5 days to 1 day',       'operations','2026-01-01','2026-06-30',60,'in_progress'],
      [empByCode['EMP043'].id,'Brand Awareness',                  'Increase LinkedIn followers by 2000 and generate 5 inbound leads/month',   'marketing','2026-01-01','2026-06-30',45,'in_progress'],
      [empByCode['EMP047'].id,'Zero Critical Bugs',               'Ensure zero P1 bugs in production for 3 consecutive months',               'quality', '2026-01-01','2026-06-30',66,'in_progress'],
      [empByCode['EMP023'].id,'Client Retention',                 'Maintain 95% client retention rate, upsell AMC to 5 existing clients',     'sales',   '2026-01-01','2026-06-30',50,'in_progress'],
      [empByCode['EMP002'].id,'Technology Roadmap 2026',          'Publish and execute technology roadmap for next 3 years',                  'strategy','2026-01-01','2026-06-30',70,'in_progress'],
      [empByCode['EMP008'].id,'React Native Proficiency',         'Complete React Native course and build 1 production-ready mobile feature', 'learning','2026-01-01','2026-06-30',40,'in_progress'],
      [empByCode['EMP009'].id,'Microservices Architecture',       'Refactor 3 monolithic modules to microservices',                          'technical','2026-01-01','2026-06-30',30,'in_progress'],
      [empByCode['EMP011'].id,'Frontend Performance',             'Reduce bundle size by 30% and improve Lighthouse score to 90+',           'technical','2026-01-01','2026-06-30',65,'in_progress'],
      [empByCode['EMP031'].id,'Employee Engagement',              'Achieve >80% participation in quarterly employee satisfaction survey',     'hr',      '2026-01-01','2026-06-30',100,'completed'],
      [empByCode['EMP035'].id,'GST Compliance',                   'Ensure 100% on-time GST filing and zero penalties for FY2026',            'compliance','2026-01-01','2026-12-31',25,'in_progress'],
    ];
    for (const [empId,title,desc,category,startD,dueD,progress,status] of goalsData) {
      await client.query(`
        INSERT INTO goals (employee_id, title, description, category, start_date, due_date,
          progress_percentage, status, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
        ON CONFLICT DO NOTHING
      `, [empId,title,desc,category,startD,dueD,progress,status]);
    }
    console.log('✅ Seeded goals: 20');

    // ════════════════════════════════════════════════════════════
    // 22. RECRUITMENT
    // ════════════════════════════════════════════════════════════
    const jobOpenings = [
      ['JOB001','Senior Full Stack Developer',  'Engineering','Chennai',5,85000, 120000,'active','2026-03-01','2026-06-30','5+ years exp, React + Node.js, AWS preferred'],
      ['JOB002','DevOps Engineer',              'Engineering','Chennai',2,70000, 100000,'active','2026-03-15','2026-06-30','3+ years, Kubernetes, Terraform, CI/CD'],
      ['JOB003','Sales Manager - North India',  'Sales',      'Delhi',  1,90000, 120000,'active','2026-02-01','2026-05-31','8+ years B2B IT sales experience'],
      ['JOB004','Data Scientist',               'Engineering','Chennai',2,80000, 110000,'active','2026-03-20','2026-07-15','Python, ML, SQL, 3+ years experience'],
      ['JOB005','HR Business Partner',          'HR',         'Chennai',1,55000, 75000, 'active','2026-04-01','2026-07-31','5+ years HRBP experience in IT company'],
    ];
    for (const [code,title,dept,loc,openings,minSal,maxSal,status,postedDate,closeDate,desc] of jobOpenings) {
      await client.query(`
        INSERT INTO job_openings (job_code, job_title, department, location, openings_count,
          min_salary, max_salary, status, posted_date, closing_date, description, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
        ON CONFLICT (job_code) DO NOTHING
      `, [code,title,dept,loc,openings,minSal,maxSal,status,postedDate,closeDate,desc]);
    }

    const { rows: jobRows } = await client.query(`SELECT id, job_code FROM job_openings ORDER BY job_code`);
    const jobByCode = {};
    jobRows.forEach(r => { jobByCode[r.job_code] = r; });

    const candidates = [
      ['CAND001',jobByCode['JOB001']?.id,'Arvind Subramaniam','arvind.sub@gmail.com','9876001234','9 years','Resume Screening','applied'],
      ['CAND002',jobByCode['JOB001']?.id,'Meghna Pillai',    'meghna.p@outlook.com','9876002345','6 years','Phone Screen',     'in_progress'],
      ['CAND003',jobByCode['JOB001']?.id,'Rajan T',         'rajan.t@gmail.com',   '9876003456','5.5 years','Technical Round 1','in_progress'],
      ['CAND004',jobByCode['JOB001']?.id,'Shalini Sharma',  'shalini.s@gmail.com', '9876004567','7 years','Final Round',      'in_progress'],
      ['CAND005',jobByCode['JOB002']?.id,'Kiran Rao',       'kiran.r@gmail.com',   '9876005678','4 years','Technical Round 1','in_progress'],
      ['CAND006',jobByCode['JOB002']?.id,'Pradeep Menon',   'pradeep.m@gmail.com', '9876006789','3 years','Resume Screening','applied'],
      ['CAND007',jobByCode['JOB003']?.id,'Rajiv Kapoor',    'rajiv.k@gmail.com',   '9876007890','10 years','Final Round',     'in_progress'],
      ['CAND008',jobByCode['JOB003']?.id,'Sunaina Verma',   'sunaina.v@gmail.com', '9876008901','8 years','Technical Round 1','in_progress'],
      ['CAND009',jobByCode['JOB004']?.id,'Divya Sharma',    'divya.sharma@gmail.com','9876009012','4 years','Phone Screen',   'in_progress'],
      ['CAND010',jobByCode['JOB004']?.id,'Nikhil Bose',     'nikhil.b@gmail.com',  '9876010123','3.5 years','Resume Screening','applied'],
      ['CAND011',jobByCode['JOB001']?.id,'Aarav Patel',     'aarav.p@gmail.com',   '9876011234','6 years','Offer Extended',  'selected'],
      ['CAND012',jobByCode['JOB005']?.id,'Parvathy Nair',   'parvathy.n@gmail.com','9876012345','6 years','Resume Screening','applied'],
    ];
    for (const [code,jobId,name,email,phone,exp,stage,status] of candidates) {
      if (!jobId) continue;
      await client.query(`
        INSERT INTO candidates (candidate_code, job_id, full_name, email, phone,
          experience, current_stage, status, applied_date, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW() - INTERVAL '7 days',NOW())
        ON CONFLICT (candidate_code) DO NOTHING
      `, [code,jobId,name,email,phone,exp,stage,status]);
    }

    // Interviews
    const { rows: candRows } = await client.query(`SELECT id, candidate_code FROM candidates WHERE status='in_progress' LIMIT 3`);
    for (const cand of candRows) {
      await client.query(`
        INSERT INTO interviews (candidate_id, interview_type, scheduled_date, scheduled_time,
          interviewer_id, status, location, created_at)
        VALUES ($1,'Technical','2026-04-10','10:00:00',$2,'scheduled','Google Meet',NOW())
        ON CONFLICT DO NOTHING
      `, [cand.id, empByCode['EMP004'].id]);
    }
    console.log('✅ Seeded recruitment: 5 jobs, 12 candidates, 3 interviews');

    // ════════════════════════════════════════════════════════════
    // 23. HOLIDAY CALENDAR (2026 - Tamil Nadu)
    // ════════════════════════════════════════════════════════════
    const holidays2026 = [
      ['2026-01-14','Pongal',               'national','Tamil Nadu harvest festival'],
      ['2026-01-15','Thiruvalluvar Day',    'regional', 'Tamil poet & philosopher day'],
      ['2026-01-16','Uzhavar Thirunal',     'regional', 'Farmers Day / Mattu Pongal'],
      ['2026-01-26','Republic Day',         'national','India Republic Day'],
      ['2026-04-14','Tamil New Year',       'regional', 'Tamil New Year / Puthuvarusham'],
      ['2026-04-14','Dr. Ambedkar Jayanti','national','Birthday of Dr. B.R. Ambedkar'],
      ['2026-04-18','Good Friday',          'national','Christian observance'],
      ['2026-05-01','May Day',              'national','International Labour Day'],
      ['2026-08-15','Independence Day',     'national','India Independence Day'],
      ['2026-10-02','Gandhi Jayanti',       'national','Birthday of Mahatma Gandhi'],
      ['2026-10-20','Diwali',               'national','Festival of Lights'],
      ['2026-11-14','Deepavali Holiday',    'regional', 'Day after Diwali'],
      ['2026-12-25','Christmas Day',        'national','Christian observance'],
    ];
    for (const [date,name,type,desc] of holidays2026) {
      await client.query(`
        INSERT INTO holidays (date, name, holiday_type, description, year, created_at)
        VALUES ($1,$2,$3,$4,2026,NOW())
        ON CONFLICT (date) DO NOTHING
      `, [date,name,type,desc]);
    }
    console.log('✅ Seeded holidays: 13 (2026, Tamil Nadu)');

    // ════════════════════════════════════════════════════════════
    // 24. NOTIFICATIONS (for admin user)
    // ════════════════════════════════════════════════════════════
    if (adminId) {
      const notifs = [
        ['Leave approval pending',        'Sathish Kumar has requested 5 days Annual Leave. Please review.',                        'leave',    'pending', false],
        ['Leave approval pending',        'Janani Suresh has requested 3 days Casual Leave. Please review.',                       'leave',    'pending', false],
        ['Leave approval pending',        'Radhika Venkat has requested 2 days Sick Leave. Please review.',                        'leave',    'pending', false],
        ['Invoice overdue',               'Invoice INV-2025-021 (₹5,25,100) from TechSolutions India is 5 days overdue.',          'invoice',  'overdue', false],
        ['Invoice overdue',               'Invoice INV-2025-022 (₹3,77,600) from Sundaram Finance is 1 day overdue.',             'invoice',  'overdue', false],
        ['Invoice overdue',               'Invoice INV-2025-023 (₹2,06,500) from Apollo Hospitals is due today.',                 'invoice',  'warning', false],
        ['Invoice overdue',               'Invoice INV-2025-024 (₹7,25,700) from Ramco Systems is due in 9 days.',               'invoice',  'info',    true],
        ['Payroll processed',             'February 2026 payroll has been processed. 50 payslips generated. Net payout: ₹28.4L.', 'payroll',  'success', true],
        ['Payroll pending',               '5 payslips in February 2026 payroll are pending payment. Please mark as paid.',        'payroll',  'pending', false],
        ['New ticket assigned',           'Ticket TKT-2026-001 (Critical) assigned: Laptop screen flickering - EMP005',           'ticket',   'critical',false],
        ['New ticket assigned',           'Ticket TKT-2026-015 (Critical) assigned: Electricity bill payment issue',              'ticket',   'critical',false],
        ['New ticket raised',             'TKT-2026-006: Internet very slow in conference room 2. Assigned to IT.',               'ticket',   'high',    false],
        ['Inventory alert',               '3 inventory items are below reorder point: Postman Business, DataGrip IDE, Webcam.',   'inventory','warning', false],
        ['Project at risk',               'Project: Data Analytics Dashboard (HDFC Bank) is marked AT RISK. Dashboard blocked.',  'project',  'warning', false],
        ['Project at risk',               'Project: Chatbot Integration (Sundaram Finance) is AT RISK. CRM API blocked.',        'project',  'warning', false],
        ['Bill payment due',              'BILL-2026-010 (AWS March ₹57,820) due on Apr 30. Please initiate payment.',           'finance',  'pending', false],
        ['Bill payment due',              'BILL-2026-011 (Microsoft March ₹33,040) due on Apr 30.',                              'finance',  'pending', false],
        ['Bill payment due',              'BILL-2026-012 (Office Rent March ₹1,00,300) due on Apr 15. Urgent.',                  'finance',  'urgent',  false],
        ['Appraisal reminder',            'Q1 FY2026 appraisal cycle ends April 30. 30 reviews pending manager approval.',       'hr',       'reminder',false],
        ['New candidate shortlisted',     'Candidate Aarav Patel (JOB001) has received an offer. Awaiting acceptance.',          'recruitment','info',  true],
      ];
      for (const [title,message,type,priority,isRead] of notifs) {
        await client.query(`
          INSERT INTO notifications (user_id, title, message, notification_type, priority, is_read, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,NOW())
          ON CONFLICT DO NOTHING
        `, [adminId,title,message,type,priority,isRead]);
      }
      console.log('✅ Seeded notifications: 20');
    }

    // ════════════════════════════════════════════════════════════
    // 25. APPROVALS (central table — pending + history rows)
    // ════════════════════════════════════════════════════════════
    const managerUserId = adminId ?? 1;
    const d = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
    const approvalSeeds = [
      // Pending rows — visible in Approval Center
      { module: 'leave',    refType: 'leave',    title: 'Annual Leave — Sathish Kumar (5 days)',          requestedBy: 'Sathish Kumar',  approverId: managerUserId, status: 'Pending',  comments: null,                       decisionDate: null,  requestDate: d(3) },
      { module: 'leave',    refType: 'leave',    title: 'Casual Leave — Janani Suresh (3 days)',           requestedBy: 'Janani Suresh',  approverId: managerUserId, status: 'Pending',  comments: null,                       decisionDate: null,  requestDate: d(1) },
      { module: 'leave',    refType: 'leave',    title: 'Sick Leave — Radhika Venkat (2 days)',            requestedBy: 'Radhika Venkat', approverId: managerUserId, status: 'Pending',  comments: null,                       decisionDate: null,  requestDate: d(5) },
      { module: 'expense',  refType: 'expense',  title: 'Expense Claim — Travel to Bangalore (₹4,500)',   requestedBy: 'Arun Krishnan',  approverId: managerUserId, status: 'Pending',  comments: null,                       decisionDate: null,  requestDate: d(2) },
      { module: 'expense',  refType: 'expense',  title: 'Expense Claim — Client Dinner Chennai (₹2,800)', requestedBy: 'Kavitha Selvan', approverId: managerUserId, status: 'Pending',  comments: null,                       decisionDate: null,  requestDate: d(6) },
      { module: 'purchase', refType: 'purchase', title: 'Purchase Request — 5x Dell Monitors (₹1,25,000)',requestedBy: 'Vijay Raman',    approverId: managerUserId, status: 'Pending',  comments: null,                       decisionDate: null,  requestDate: d(4) },
      // History rows — Approved / Rejected
      { module: 'leave',    refType: 'leave',    title: 'Annual Leave — Priya Ramasamy (3 days)',          requestedBy: 'Priya Ramasamy', approverId: managerUserId, status: 'Approved', comments: null,                       decisionDate: d(2), requestDate: d(5) },
      { module: 'expense',  refType: 'expense',  title: 'Expense Claim — Laptop Bag (₹1,200)',             requestedBy: 'Deepa Shankar',  approverId: managerUserId, status: 'Approved', comments: null,                       decisionDate: d(3), requestDate: d(7) },
      { module: 'purchase', refType: 'purchase', title: 'Purchase Request — Office Chairs x10 (₹60,000)', requestedBy: 'Rajesh Menon',   approverId: managerUserId, status: 'Rejected', comments: 'Budget exceeded for Q1', decisionDate: d(1), requestDate: d(8) },
    ];
    for (const r of approvalSeeds) {
      await client.query(
        `INSERT INTO approvals
           (module_name, reference_type, title, requester_name, approver_id,
            status, comments, decision_date, request_date, company_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL)
         ON CONFLICT DO NOTHING`,
        [r.module, r.refType, r.title, r.requestedBy, r.approverId,
         r.status, r.comments, r.decisionDate, r.requestDate]
      );
    }
    console.log('✅ Seeded approvals: 9 rows (6 pending, 3 history)');

    // ════════════════════════════════════════════════════════════
    // COMMIT
    // ════════════════════════════════════════════════════════════
    await client.query('COMMIT');
    console.log('\n🎉 All seed data committed successfully!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Company: Manifest Technologies, Chennai');
    console.log('Admin login: admin@manifest.in / Manifest@123');
    console.log('HR login:    hr@manifest.in / Manifest@123');
    console.log('Run testChecklist.js to verify all tables.');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed — rolled back:', err.message);
    console.error(err.stack);
    throw err;
  } finally {
    client.release();
  }
}

// Run directly
runSeed().then(() => process.exit(0)).catch(() => process.exit(1));
