/**
 * 20260605000021_fixed_assets_seed.js
 *
 * Seeds 10 demo fixed assets for every company that currently has 0 assets.
 * Covers IT Equipment, Vehicles, Machinery and Furniture so all dashboard
 * charts (pie by category, bar by department) render with real data.
 *
 * Safe to re-run: guarded by COUNT check per company_id; uses ON CONFLICT DO NOTHING.
 */

// All values are compile-time constants — safe to inline in SQL literals.
const ASSETS = [
  "('FA-2022-001','Dell PowerEdge R740 Server','IT Equipment','Server Room, HO','IT','2022-04-01',520000,52000,5,'SLM',NULL,312000,208000,'Dell India Pvt Ltd','SRV-DELL-74001','2025-03-31','active','Primary application server')",
  "('FA-2022-002','Toyota Innova Crysta (MH-12-AB-1234)','Vehicles','Garage, HO','Admin','2022-07-15',1850000,185000,8,'WDV',25.89,1136400,713600,'Toyota Kirloskar Motor','INV-MH12AB1234','2025-07-14','active','Company vehicle for executive travel')",
  "('FA-2023-001','CNC Milling Machine (VMC-500)','Machinery','Shop Floor A','Production','2023-01-10',3200000,160000,15,'SLM',NULL,2986667,213333,'Ace Micromatic Group','VMC500-ACE-2301','2026-01-09','active','CNC vertical machining centre, 3-axis')",
  "('FA-2023-002','Office Furniture Set (40 workstations)','Furniture','Floor 2, HO','Admin','2023-06-01',480000,48000,10,'SLM',NULL,432000,48000,'Godrej Interio',NULL,NULL,'active','40-seat open-plan workstation setup')",
  "('FA-2021-001','Hikvision CCTV System (32 cameras)','IT Equipment','All Floors, HO','Admin','2021-09-01',280000,28000,5,'SLM',NULL,56000,224000,'Hikvision India','CCTV-HIK-3201','2024-08-31','active','32-camera IP surveillance with NVR')",
  "('FA-2020-001','Carrier 5-Ton Chiller Unit','Machinery','Basement, HO','Facilities','2020-03-15',620000,62000,10,'SLM',NULL,310000,310000,'Carrier Midea India','CHR-CARR-5T-001','2023-03-14','active','Central air-conditioning chiller')",
  "('FA-2024-001','MacBook Pro M3 (x10 units)','IT Equipment','Floor 3, HO','Engineering','2024-01-20',2100000,210000,3,'SLM',NULL,1750000,350000,'Apple India Pvt Ltd',NULL,'2027-01-19','active','10 MacBook Pro 14in M3 for dev team')",
  "('FA-2019-001','Hydraulic Press (200-Ton)','Machinery','Shop Floor B','Production','2019-04-01',1500000,75000,15,'WDV',18.10,552060,947940,'Hyd-Mech Group','HP200-2019-001',NULL,'active','200-ton hydraulic press, stamping line')",
  "('FA-2023-003','Warehouse Racking System','Furniture','Warehouse, Unit 2','Warehouse','2023-11-01',390000,39000,10,'SLM',NULL,351000,39000,'Mecalux India',NULL,NULL,'active','Heavy-duty pallet racking, 500 bays')",
  "('FA-2018-001','Cisco Catalyst 9300 Network Switch Stack','IT Equipment','Server Room, HO','IT','2018-06-01',340000,34000,5,'SLM',NULL,34000,306000,'Cisco Systems India','CSC-9300-STACK-01','2023-05-31','active','4-switch Catalyst 9300 stack')",
];

const COLUMNS = `(asset_code, name, category, location, department,
  purchase_date, purchase_cost, salvage_value, useful_life_years,
  depreciation_method, wdv_rate, current_book_value, accumulated_depreciation,
  vendor, serial_number, warranty_expiry, status, notes, company_id)`;

export async function up(knex) {
  // Collect company IDs; fall back to [null] so charts work even without tenants
  let companyIds = [null];
  try {
    const { rows } = await knex.raw(`SELECT id FROM companies ORDER BY id LIMIT 10`);
    if (rows.length) companyIds = rows.map(r => r.id);
  } catch { /* companies table may differ */ }

  for (const companyId of companyIds) {
    // Skip if this company already has assets
    const { rows: [{ cnt }] } = await knex.raw(
      companyId != null
        ? `SELECT COUNT(*) AS cnt FROM fixed_assets WHERE company_id = $1`
        : `SELECT COUNT(*) AS cnt FROM fixed_assets WHERE company_id IS NULL`,
      companyId != null ? [companyId] : []
    );
    if (parseInt(cnt) > 0) continue;

    const cidLiteral = companyId != null ? String(companyId) : 'NULL';

    // Append company_id to each row and bulk-insert
    const valueRows = ASSETS.map(row => {
      // row ends with '...')  — strip the trailing ) and append ,company_id)
      return row.slice(0, -1) + `,${cidLiteral})`;
    }).join(',\n      ');

    await knex.raw(`
      INSERT INTO fixed_assets ${COLUMNS}
      VALUES ${valueRows}
      ON CONFLICT (asset_code) DO NOTHING
    `);
  }
}

export async function down(knex) {
  await knex.raw(`
    DELETE FROM fixed_assets WHERE asset_code IN (
      'FA-2022-001','FA-2022-002','FA-2023-001','FA-2023-002','FA-2021-001',
      'FA-2020-001','FA-2024-001','FA-2019-001','FA-2023-003','FA-2018-001'
    )
  `);
}
