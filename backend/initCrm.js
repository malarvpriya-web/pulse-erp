import pool from './src/config/db.js';

async function init() {
  // leads table (matches existing CRM repository schema)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id             SERIAL PRIMARY KEY,
      lead_source    VARCHAR(100),
      company_name   VARCHAR(255),
      contact_person VARCHAR(255),
      email          VARCHAR(255),
      phone          VARCHAR(50),
      industry       VARCHAR(100),
      location       VARCHAR(255),
      status         VARCHAR(50)  DEFAULT 'New',
      assigned_to    INTEGER,
      notes          TEXT,
      lead_score     INTEGER      DEFAULT 0,
      created_by     INTEGER,
      created_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      updated_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      deleted_at     TIMESTAMP
    )
  `).then(() => console.log('leads OK')).catch(e => console.log('leads:', e.message));

  // opportunities table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS opportunities (
      id                     SERIAL PRIMARY KEY,
      lead_id                INTEGER REFERENCES leads(id),
      opportunity_name       VARCHAR(255) NOT NULL,
      expected_value         DECIMAL(15,2) DEFAULT 0,
      probability_percentage INTEGER       DEFAULT 0,
      expected_closing_date  DATE,
      stage                  VARCHAR(50)   DEFAULT 'prospecting',
      assigned_to            INTEGER,
      notes                  TEXT,
      created_by             INTEGER,
      created_at             TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
      updated_at             TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
      deleted_at             TIMESTAMP
    )
  `).then(() => console.log('opportunities OK')).catch(e => console.log('opp:', e.message));

  // accounts table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id               SERIAL PRIMARY KEY,
      account_name     VARCHAR(255) NOT NULL,
      industry         VARCHAR(100),
      website          VARCHAR(255),
      phone            VARCHAR(50),
      email            VARCHAR(255),
      address          TEXT,
      account_type     VARCHAR(50)   DEFAULT 'Customer',
      annual_revenue   DECIMAL(15,2) DEFAULT 0,
      employees_count  INTEGER,
      assigned_to      INTEGER,
      status           VARCHAR(20)   DEFAULT 'Active',
      created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
      updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
      deleted_at       TIMESTAMP
    )
  `).then(() => console.log('accounts OK')).catch(e => console.log('accounts:', e.message));

  // contacts table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id           SERIAL PRIMARY KEY,
      full_name    VARCHAR(255) NOT NULL,
      account_id   INTEGER REFERENCES accounts(id),
      title        VARCHAR(100),
      email        VARCHAR(255),
      phone        VARCHAR(50),
      department   VARCHAR(100),
      lead_source  VARCHAR(100),
      status       VARCHAR(20)  DEFAULT 'Active',
      notes        TEXT,
      created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      deleted_at   TIMESTAMP
    )
  `).then(() => console.log('contacts OK')).catch(e => console.log('contacts:', e.message));

  // Seed leads
  const lc = await pool.query('SELECT COUNT(*) FROM leads');
  if (parseInt(lc.rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO leads (lead_source, company_name, contact_person, email, phone, industry, location, status, lead_score, notes)
      VALUES
        ('Website',    'InfoTech Solutions', 'Rajesh Kumar',  'rajesh@infotech.com',  '9812345678', 'Technology',    'Bangalore', 'Qualified',  85, 'Interested in ERP'),
        ('Referral',   'Global Dynamics',    'Sunita Patel',  'sunita@globaldyn.com', '9823456789', 'Manufacturing', 'Mumbai',    'New',        60, 'Cold outreach'),
        ('LinkedIn',   'TechStart Inc',      'Amir Khan',     'amir@techstart.com',   '9834567890', 'IT Services',   'Delhi',     'Contacted',  72, 'Demo scheduled'),
        ('Exhibition', 'Apex Systems',       'Preethi Nair',  'preethi@apex.com',     '9845678901', 'IT Services',   'Chennai',   'Qualified',  78, 'RFP received'),
        ('Website',    'NextGen Corp',       'Dev Sharma',    'dev@nextgen.com',      '9856789012', 'FMCG',          'Pune',      'New',        45, 'Needs follow-up'),
        ('Referral',   'Precision Ltd',      'Meera Iyer',    'meera@precision.com',  '9867890123', 'Engineering',   'Hyderabad', 'Negotiation',92, 'Proposal sent'),
        ('Cold Call',  'DataFlow Systems',   'Kiran Bose',    'kiran@dataflow.com',   '9878901234', 'Analytics',     'Kolkata',   'Contacted',  55, 'Initial call done'),
        ('Website',    'CloudEdge India',    'Ashish Rao',    'ashish@cloudedge.com', '9889012345', 'Cloud',         'Bangalore', 'Lost',       30, 'Chose competitor')
      ON CONFLICT DO NOTHING
    `);
    console.log('Leads seeded');

    const leads = await pool.query('SELECT id FROM leads ORDER BY id LIMIT 6');
    const ids = leads.rows.map(r => r.id);
    if (ids.length >= 5) {
      await pool.query(
        `INSERT INTO opportunities (lead_id, opportunity_name, expected_value, probability_percentage, expected_closing_date, stage)
         VALUES
           ($1, 'ERP Implementation',       850000, 70, '2026-04-30', 'proposal'),
           ($2, 'Cloud Migration Project',  540000, 85, '2026-03-31', 'negotiation'),
           ($3, 'HR Module Upgrade',        220000, 40, '2026-05-31', 'qualification'),
           ($4, 'Finance Module License',   180000, 20, '2026-06-30', 'prospecting'),
           ($5, 'Annual SaaS Subscription', 360000, 90, '2026-03-25', 'negotiation'),
           ($6, 'Custom Integration Work',  120000, 60, '2026-04-15', 'proposal')`,
        ids
      );
      console.log('Opportunities seeded');
    }
  }

  // Seed accounts
  const ac = await pool.query('SELECT COUNT(*) FROM accounts');
  if (parseInt(ac.rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO accounts (account_name, industry, website, phone, email, account_type, annual_revenue, employees_count, status)
      VALUES
        ('InfoTech Solutions', 'Technology',    'www.infotech.com',  '0441234567', 'info@infotech.com',  'Customer', 25000000, 250, 'Active'),
        ('Global Dynamics',    'Manufacturing', 'www.globaldyn.com', '0442345678', 'info@globaldyn.com', 'Prospect', 45000000, 500, 'Active'),
        ('Apex Systems',       'IT Services',   'www.apex.com',      '0443456789', 'info@apex.com',      'Customer', 18000000, 180, 'Active'),
        ('NextGen Corp',       'FMCG',          'www.nextgen.com',   '0444567890', 'info@nextgen.com',   'Prospect', 60000000, 800, 'Active'),
        ('Precision Ltd',      'Engineering',   'www.precision.com', '0445678901', 'info@precision.com', 'Customer', 32000000, 320, 'Active'),
        ('DataFlow Systems',   'Analytics',     'www.dataflow.com',  '0446789012', 'info@dataflow.com',  'Partner',  12000000, 120, 'Active')
      ON CONFLICT DO NOTHING
    `);
    console.log('Accounts seeded');

    const accs = await pool.query('SELECT id FROM accounts ORDER BY id LIMIT 4');
    const aids = accs.rows.map(r => r.id);
    if (aids.length >= 4) {
      await pool.query(
        `INSERT INTO contacts (full_name, account_id, title, email, phone, department, lead_source, status)
         VALUES
           ('Rajesh Kumar',  $1, 'CTO',         'rajesh@infotech.com',  '9812345678', 'Technology', 'Website',    'Active'),
           ('Sunita Patel',  $2, 'CFO',         'sunita@globaldyn.com', '9823456789', 'Finance',    'Referral',   'Active'),
           ('Preethi Nair',  $3, 'IT Head',     'preethi@apex.com',     '9845678901', 'IT',         'Exhibition', 'Active'),
           ('Dev Sharma',    $4, 'CEO',         'dev@nextgen.com',      '9856789012', 'Management', 'Website',    'Active'),
           ('Meera Iyer',    $1, 'Procurement', 'meera@precision.com',  '9867890123', 'Procurement','Referral',   'Active'),
           ('Kiran Bose',    $2, 'Data Head',   'kiran@dataflow.com',   '9878901234', 'Analytics',  'Cold Call',  'Active')`,
        aids
      );
      console.log('Contacts seeded');
    }
  }

  console.log('✅ CRM init complete');
  process.exit(0);
}

init().catch(e => { console.error('❌', e.message); process.exit(1); });
