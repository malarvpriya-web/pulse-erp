/**
 * seedWonLostDemo.mjs — OPTIONAL demo data for the IEM Won/Lost Leads report.
 *
 * Inserts 6 fictional closed leads (4 Won, 2 Lost) into `leads` for company_id=1
 * so the report grid demos fuller. Uses obviously-fictional company names and
 * *-demo.example emails, and tags every row with "[demo-wl]" in notes.
 *
 * Idempotent: re-running first deletes prior [demo-wl] rows, then re-inserts.
 * To remove the demo data entirely:
 *   node dev-tools/seedWonLostDemo.mjs --clean
 *
 * Run:  cd backend && node dev-tools/seedWonLostDemo.mjs
 */
import pool from '../src/modules/shared/db.js';

const clean = process.argv.includes('--clean');

await pool.query(`DELETE FROM leads WHERE company_id = 1 AND notes LIKE '%[demo-wl]%'`);
if (clean) {
  console.log('Removed all [demo-wl] demo leads.');
  process.exit(0);
}

const rows = [
  // company (fictional), contact, email, phone, industry, location, status, assigned_to, score, channel, zone, value(₹), created_at
  ['Northwind Power Systems', 'Rajesh Menon', 'rajesh@northwind-demo.example',    '9820011223 / 022-40011223', 'Manufacturing', 'Mumbai',    'Won',  1, 88, 'Exhibition', 'West',    4500000,  '2026-06-02'],
  ['Zephyr Green Energy',     'Priya Nair',   'priya@zephyr-demo.example',        '9898765432',                'Construction',  'Ahmedabad', 'Won',  2, 82, 'Direct',     'West',    12500000, '2026-05-18'],
  ['Apex Electricals Ltd',    'Suresh Iyer',  'suresh@apex-demo.example',         '9840033445 / 044-28011445', 'Manufacturing', 'Chennai',   'Won',  1, 79, 'Referral',   'South',   7800000,  '2026-05-04'],
  ['Meridian Infra Projects', 'Anita Desai',  null,                               '9930055667',                'Construction',  'Mumbai',    'Won',  2, 74, 'IndiaMart',  'West',    3200000,  '2025-12-11'],
  ['Volt Dynamics Pvt Ltd',   'Vikram Singh', 'vikram@voltdynamics-demo.example', '9827066778',                'Manufacturing', 'Bhopal',    'Lost', 1, 41, 'Website',    'Central', 6000000,  '2026-06-21'],
  ['Helios Switchgear',       'Meera Kapoor', 'meera@helios-demo.example',        '9810077889 / 011-49011889', 'Technology',    'Delhi',     'Lost', 2, 55, 'Phone',      'North',   9500000,  '2025-11-27'],
];

const sql = `INSERT INTO leads
  (company_name, contact_person, email, phone, industry, location, status, assigned_to, lead_score,
   lead_source, zone, estimated_value, notes, company_id, created_by, created_at, updated_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,1,$14,$14)`;

for (const r of rows) {
  await pool.query(sql, [r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], '[demo-wl] fictional seed data', r[12]]);
}

console.log(`Seeded ${rows.length} fictional Won/Lost demo leads (4 Won, 2 Lost) for company_id=1.`);
console.log('Remove later with: node dev-tools/seedWonLostDemo.mjs --clean');
process.exit(0);
