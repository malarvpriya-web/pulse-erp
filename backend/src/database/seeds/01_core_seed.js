import bcrypt from 'bcryptjs';

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function seed(knex) {
  console.log('🌱 Seeding database with initial data...');

  // 1. Complaints Seed
  const { rows: complaintsCount } = await knex.raw('SELECT COUNT(*) AS cnt FROM complaints');
  if (parseInt(complaintsCount[0].cnt) === 0) {
    await knex.raw(`
      INSERT INTO complaints (complaint_number, title, description, customer_name, customer_email, customer_phone, category, priority, status, assigned_to_name, created_at)
      VALUES
        ('CMP-2026-0001','Billing overcharge on March invoice','Customer was charged twice for the same service in March 2026.','TechCorp Solutions','billing@techcorp.com','+91 98765 43210','Billing','High','in_progress','Priya S',NOW() - INTERVAL '5 days'),
        ('CMP-2026-0002','Product delivery delayed by 2 weeks','Order #ORD-2024-0045 has not been delivered despite promised date.','Alpha Manufacturing Co','purchase@alphamfg.com','+91 87654 32109','Delivery','Medium','open',NULL,NOW() - INTERVAL '3 days'),
        ('CMP-2026-0003','Software bug in reporting module','The monthly report exports incorrect totals when filtering by department.','BrightFin Ltd','support@brightfin.in','+91 76543 21098','Technical','High','resolved','Anand M',NOW() - INTERVAL '10 days'),
        ('CMP-2026-0004','Customer service response was rude','Representative was dismissive during the support call on 12 Mar.','Global Trade Partners','admin@globaltrade.com','+91 65432 10987','Service Quality','Low','closed',NULL,NOW() - INTERVAL '15 days'),
        ('CMP-2026-0005','Incorrect product shipped','Received 50kg copper wire instead of 50kg aluminium wire.','MediTech Services','ops@meditech.in','+91 54321 09876','Product Quality','High','open',NULL,NOW() - INTERVAL '1 day')
      ON CONFLICT DO NOTHING
    `);
  }

  // 2. Leads Seed
  const { rows: leadsCount } = await knex.raw('SELECT COUNT(*) as cnt FROM leads');
  if (parseInt(leadsCount[0].cnt) === 0) {
    await knex.raw(`
      INSERT INTO leads (company_name, contact_person, email, lead_source, status, value)
      VALUES
        ('Zenith Technologies', 'Rajesh Kumar', 'rajesh@zenith.in', 'Referral', 'Qualified', 2400000),
        ('Alpha Manufacturing', 'Sunita Mehta', 'sunita@alpha.in', 'Website', 'Proposal', 1800000),
        ('BrightFin Ltd', 'Anita Reddy', 'anita@brightfin.in', 'LinkedIn', 'New', 600000),
        ('Global Trade Partners', 'Vijay Nair', 'vijay@gtp.in', 'Cold Call', 'Negotiation', 3200000),
        ('MNO Retail Group', 'Deepa Shetty', 'deepa@mnorg.in', 'Event', 'New', 1200000)
      ON CONFLICT DO NOTHING
    `);
  }

  // 3. Holidays Seed
  const { rows: holRows } = await knex.raw('SELECT COUNT(*) as cnt FROM holidays');
  if (parseInt(holRows[0].cnt) === 0) {
    await knex.raw(`
      INSERT INTO holidays (name, date, type, description) VALUES
        ('New Year''s Day',    '2026-01-01', 'Optional',  'New Year celebration'),
        ('Makar Sankranti',    '2026-01-14', 'Regional',  'Harvest festival'),
        ('Republic Day',       '2026-01-26', 'National',  'India''s Republic Day'),
        ('Maha Shivratri',     '2026-02-26', 'Festival',  'Hindu festival'),
        ('Holi',               '2026-03-04', 'Festival',  'Festival of colours'),
        ('Good Friday',        '2026-04-03', 'National',  'Christian observance'),
        ('Ram Navami',         '2026-04-07', 'Festival',  'Birth of Lord Rama'),
        ('Ambedkar Jayanti',   '2026-04-14', 'National',  'Dr. B. R. Ambedkar birthday'),
        ('Maharashtra Day',    '2026-05-01', 'Regional',  'Maharashtra formation / May Day'),
        ('Buddha Purnima',     '2026-05-24', 'Festival',  'Birth of Gautama Buddha'),
        ('Eid ul-Adha',        '2026-06-17', 'Festival',  'Bakrid / Festival of Sacrifice'),
        ('Muharram',           '2026-07-16', 'Festival',  'Islamic New Year'),
        ('Independence Day',   '2026-08-15', 'National',  'India''s Independence Day'),
        ('Janmashtami',        '2026-08-23', 'Festival',  'Birth of Lord Krishna'),
        ('Gandhi Jayanti',     '2026-10-02', 'National',  'Mahatma Gandhi birthday'),
        ('Dussehra',           '2026-10-20', 'Festival',  'Victory of Rama over Ravana'),
        ('Diwali',             '2026-11-08', 'Festival',  'Festival of Lights'),
        ('Christmas',          '2026-12-25', 'National',  'Birth of Jesus Christ')
      ON CONFLICT DO NOTHING
    `);
  }

  // 4. Users Seed
  const hash = await bcrypt.hash('password123', 10);
  const testUsers = [
    { name: 'Super Admin',       email: 'superadmin@pulse.com',    role: 'super_admin',  dept: null          },
    { name: 'Super Admin',       email: 'superadmin@company.com',  role: 'super_admin',  dept: null          },
    { name: 'Admin User',        email: 'admin@pulse.com',         role: 'super_admin',  dept: null          },
    { name: 'Admin User',        email: 'admin@company.com',       role: 'super_admin',  dept: null          },
    { name: 'Finance Manager',   email: 'finance@pulse.com',       role: 'admin',        dept: 'Finance'     },
    { name: 'HR Manager',        email: 'hr@pulse.com',            role: 'manager',      dept: 'HR'          },
    { name: 'John Employee',     email: 'john@pulse.com',          role: 'employee',     dept: 'Engineering' },
    { name: 'Manager User',      email: 'manager@pulse.com',       role: 'manager',      dept: 'Engineering' },
    { name: 'Manager User',      email: 'manager@company.com',     role: 'manager',      dept: 'Engineering' },
  ];

  for (const u of testUsers) {
    await knex.raw(
      `INSERT INTO users (name, email, password_hash, role, department, is_active)
       VALUES (?, ?, ?, ?, ?, true)
       ON CONFLICT (email) DO UPDATE SET password_hash=?, role=?, is_active=true`,
      [u.name, u.email, hash, u.role, u.dept, hash, u.role]
    );
  }

  console.log('✅ Seeding completed successfully');
}
