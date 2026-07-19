// __fixtures__.js — CRM sample/mock data for DEV-only usage.
// All constants here are re-exported from components that originally defined them inline.
// Do NOT import this file in production paths; always guard usage with import.meta.env.DEV.

// ─── Accounts.jsx ────────────────────────────────────────────────────────────
export const SAMPLE_ACCOUNTS = [
  { id: 1, name: 'TechCorp Solutions',    industry: 'Technology',    account_type: 'Customer',   annual_revenue: 5000000,  employee_count: 250, website: 'techcorp.com',    phone: '+91 98765 43210', status: 'Active',   contacts_count: 4, created_at: '2024-01-15' },
  { id: 2, name: 'Alpha Manufacturing Co',industry: 'Manufacturing', account_type: 'Customer',   annual_revenue: 12000000, employee_count: 800, website: 'alphamfg.com',    phone: '+91 87654 32109', status: 'Active',   contacts_count: 6, created_at: '2024-03-20' },
  { id: 3, name: 'Global Trade Partners', industry: 'Logistics',     account_type: 'Partner',    annual_revenue: 8000000,  employee_count: 120, website: 'globaltrade.com', phone: '+91 76543 21098', status: 'Active',   contacts_count: 3, created_at: '2024-02-10' },
  { id: 4, name: 'BrightFin Ltd',         industry: 'Finance',       account_type: 'Prospect',   annual_revenue: 3000000,  employee_count: 80,  website: 'brightfin.in',    phone: '+91 65432 10987', status: 'Prospect', contacts_count: 2, created_at: '2024-04-05' },
  { id: 5, name: 'MediTech Services',     industry: 'Healthcare',    account_type: 'Prospect',   annual_revenue: 6500000,  employee_count: 340, website: 'meditech.in',     phone: '+91 54321 09876', status: 'Prospect', contacts_count: 1, created_at: '2024-05-01' },
];

// ─── Contacts.jsx ─────────────────────────────────────────────────────────────
export const SAMPLE_CONTACTS = [
  { id: 1, first_name: 'Rajesh',  last_name: 'Kumar',  title: 'Mr',  designation: 'CEO',               department: 'Executive', email: 'rajesh@techcorp.com',   phone: '+91 98765 43210', account_name: 'TechCorp Solutions',    linkedin: '', is_primary: true,  created_at: '2024-01-15' },
  { id: 2, first_name: 'Priya',   last_name: 'Sharma', title: 'Ms',  designation: 'Procurement Head',  department: 'Operations', email: 'priya@alphamfg.com',    phone: '+91 87654 32109', account_name: 'Alpha Manufacturing Co', linkedin: '', is_primary: true,  created_at: '2024-03-20' },
  { id: 3, first_name: 'Vijay',   last_name: 'Nair',   title: 'Mr',  designation: 'MD',                department: 'Executive', email: 'vijay@globaltrade.com', phone: '+91 76543 21098', account_name: 'Global Trade Partners', linkedin: '', is_primary: true,  created_at: '2024-02-10' },
  { id: 4, first_name: 'Anita',   last_name: 'Reddy',  title: 'Ms',  designation: 'CFO',               department: 'Finance',   email: 'anita@brightfin.com',   phone: '+91 65432 10987', account_name: 'BrightFin Ltd',         linkedin: '', is_primary: true,  created_at: '2024-04-05' },
  { id: 5, first_name: 'Suresh',  last_name: 'Pillai', title: 'Mr',  designation: 'IT Manager',        department: 'IT',        email: 'suresh@meditech.in',    phone: '+91 54321 09876', account_name: 'MediTech Services',     linkedin: '', is_primary: false, created_at: '2024-05-01' },
  { id: 6, first_name: 'Kavitha', last_name: 'Menon',  title: 'Mrs', designation: 'Sales Director',    department: 'Sales',     email: 'kavitha@techcorp.com',  phone: '+91 43210 98765', account_name: 'TechCorp Solutions',    linkedin: '', is_primary: false, created_at: '2024-06-12' },
];

export const SAMPLE_ACCOUNTS_CONTACTS = [
  { id: 1, name: 'TechCorp Solutions' },
  { id: 2, name: 'Alpha Manufacturing Co' },
  { id: 3, name: 'Global Trade Partners' },
  { id: 4, name: 'BrightFin Ltd' },
  { id: 5, name: 'MediTech Services' },
];

// ─── Leads.jsx ────────────────────────────────────────────────────────────────
export const SAMPLE_LEADS = [
  { id: 1, company_name: 'TechCorp Solutions',    contact_person: 'Rajesh Kumar',  email: 'rajesh@techcorp.com',   phone: '+91 98765 43210', lead_source: 'Website',  industry: 'Technology',    status: 'qualified',   lead_score: 82, assigned_to_name: 'Priya S', created_at: '2024-11-01' },
  { id: 2, company_name: 'Alpha Manufacturing Co', contact_person: 'Priya Sharma',  email: 'priya@alphamfg.com',    phone: '+91 87654 32109', lead_source: 'LinkedIn', industry: 'Manufacturing', status: 'contacted',   lead_score: 65, assigned_to_name: 'Anand M', created_at: '2024-11-05' },
  { id: 3, company_name: 'Global Trade Partners',  contact_person: 'Vijay Nair',    email: 'vijay@globaltrade.com', phone: '+91 76543 21098', lead_source: 'Referral', industry: 'Logistics',    status: 'new',         lead_score: 40, assigned_to_name: 'Ravi K',  created_at: '2024-11-08' },
  { id: 4, company_name: 'BrightFin Ltd',          contact_person: 'Anita Reddy',   email: 'anita@brightfin.com',  phone: '+91 65432 10987', lead_source: 'Campaign', industry: 'Finance',       status: 'converted',   lead_score: 95, assigned_to_name: 'Priya S', created_at: '2024-11-10' },
  { id: 5, company_name: 'MediTech Services',      contact_person: 'Suresh Pillai', email: 'suresh@meditech.in',   phone: '+91 54321 09876', lead_source: 'Website',  industry: 'Healthcare',   status: 'unqualified', lead_score: 20, assigned_to_name: 'Anand M', created_at: '2024-11-12' },
];

// ─── OpportunitiesKanban.jsx ──────────────────────────────────────────────────
export const SAMPLE_BOARD = {
  Prospecting:   [{ id: 1, opportunity_name: 'ERP System - RetailCo',      company_name: 'RetailCo Ltd',      expected_value: 320000, probability_percentage: 25, expected_closing_date: '2025-01-31', assigned_to_name: 'Priya S' }],
  Qualification: [{ id: 2, opportunity_name: 'Cloud Infra - TechCorp',     company_name: 'TechCorp Solutions', expected_value: 580000, probability_percentage: 45, expected_closing_date: '2025-01-15', assigned_to_name: 'Anand M' },
                  { id: 3, opportunity_name: 'HR Platform - HealthPlus',    company_name: 'HealthPlus',        expected_value: 240000, probability_percentage: 35, expected_closing_date: '2025-02-10', assigned_to_name: 'Ravi K' }],
  Proposal:      [{ id: 4, opportunity_name: 'Analytics - Alpha Mfg',      company_name: 'Alpha Mfg',         expected_value: 620000, probability_percentage: 60, expected_closing_date: '2024-12-30', assigned_to_name: 'Priya S' }],
  Negotiation:   [{ id: 5, opportunity_name: 'Security Suite - GlobalTrade',company_name: 'Global Trade',     expected_value: 850000, probability_percentage: 75, expected_closing_date: '2024-12-15', assigned_to_name: 'Anand M' }],
  Won:           [{ id: 6, opportunity_name: 'CRM Rollout - BrightFin',    company_name: 'BrightFin Ltd',     expected_value: 410000, probability_percentage: 100, expected_closing_date: '2024-11-30', assigned_to_name: 'Ravi K' }],
};

// ─── SalesDashboard.jsx ───────────────────────────────────────────────────────
export const SAMPLE_STATS = {
  total_leads: 84,
  pipeline_value: 12400000,
  won_deals: 18,
  conversion_rate: 21,
  leads_this_month: 14,
  pipeline_change: 8,
};

export const SAMPLE_FUNNEL = [
  { stage: 'Prospecting',   count: 32, value: 4800000 },
  { stage: 'Qualification', count: 24, value: 3600000 },
  { stage: 'Proposal',      count: 16, value: 2400000 },
  { stage: 'Negotiation',   count: 8,  value: 1600000 },
  { stage: 'Won',           count: 4,  value: 850000  },
];

export const SAMPLE_OPPS = [
  { id: 1, opportunity_name: 'ERP Implementation - TechCorp',   company_name: 'TechCorp Solutions', expected_value: 850000,  probability_percentage: 75, stage: 'Negotiation', expected_closing_date: '2024-12-15' },
  { id: 2, opportunity_name: 'Cloud Migration - Alpha Mfg',     company_name: 'Alpha Manufacturing', expected_value: 620000, probability_percentage: 60, stage: 'Proposal',     expected_closing_date: '2024-12-30' },
  { id: 3, opportunity_name: 'Security Suite - Global Trade',   company_name: 'Global Trade Partners', expected_value: 410000, probability_percentage: 45, stage: 'Qualification', expected_closing_date: '2025-01-15' },
  { id: 4, opportunity_name: 'Analytics Platform - BrightFin',  company_name: 'BrightFin Ltd',      expected_value: 380000,  probability_percentage: 85, stage: 'Negotiation', expected_closing_date: '2024-12-10' },
  { id: 5, opportunity_name: 'CRM Rollout - MediTech',          company_name: 'MediTech Services',  expected_value: 290000,  probability_percentage: 30, stage: 'Proposal',     expected_closing_date: '2025-01-31' },
];
