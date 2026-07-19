/**
 * 20260623000001_asset_maintenance_seed.js
 *
 * Seeds assets_register, maintenance_schedules, and spare_parts for every
 * company that currently has zero assets in assets_register.
 * Assets are themed for Manifest Technologies (Power Quality / Manufacturing).
 *
 * Safe to re-run: guarded by COUNT check per company_id.
 */

const ASSET_DEFS = [
  { asset_code: 'MT-APFC-001', name: 'APFC Panel - Unit 1',           category: 'Power Quality', location: 'Workshop Bay A',  department: 'Engineering', purchase_date: '2022-03-01', purchase_cost: 850000,  current_value: 680000,  manufacturer: 'Manifest Technologies', serial_number: 'MT-APFC-2022-001' },
  { asset_code: 'MT-DSTC-001', name: 'D-STATCOM Test Bench',          category: 'Power Quality', location: 'Lab 2',           department: 'Engineering', purchase_date: '2023-01-15', purchase_cost: 1200000, current_value: 1050000, manufacturer: 'Manifest Technologies', serial_number: 'MT-DSTC-2023-001' },
  { asset_code: 'MT-CNC-001',  name: 'CNC Milling Machine (VMC-500)', category: 'Production',    location: 'Production Floor', department: 'Production',  purchase_date: '2021-06-10', purchase_cost: 3200000, current_value: 2400000, manufacturer: 'Ace Micromatic Group',  serial_number: 'VMC500-ACE-2301'  },
  { asset_code: 'MT-HVTK-001', name: 'High Voltage Test Kit',         category: 'Testing',       location: 'HV Lab',          department: 'Engineering', purchase_date: '2022-09-20', purchase_cost: 480000,  current_value: 360000,  manufacturer: 'Hakel Instruments',     serial_number: 'HV-KIT-2022-001'  },
  { asset_code: 'MT-UPS-001',  name: 'UPS System - Server Room',      category: 'Electrical',    location: 'Server Room',     department: 'IT',          purchase_date: '2020-11-05', purchase_cost: 320000,  current_value: 180000,  manufacturer: 'Emerson Network Power', serial_number: 'UPS-EMR-2020-001' },
  { asset_code: 'MT-COMP-001', name: 'Air Compressor (10 HP)',        category: 'Utilities',     location: 'Workshop',        department: 'Production',  purchase_date: '2021-02-20', purchase_cost: 145000,  current_value: 95000,   manufacturer: 'Elgi Equipments',       serial_number: 'EC-ELGI-2021-001' },
];

// days_offset = days from today (negative = overdue, positive = upcoming)
const SCHEDULE_DEFS = [
  { asset_code: 'MT-APFC-001', maintenance_type: 'preventive', frequency_days: 90,  days_offset: -5,  assigned_to: 'Ramesh Kumar',   standard_ref: 'IEEE 18-2012',  checklist_items: ['Check capacitor banks', 'Inspect contactors', 'Test PF correction'] },
  { asset_code: 'MT-DSTC-001', maintenance_type: 'preventive', frequency_days: 180, days_offset: 7,   assigned_to: 'Suresh Babu',    standard_ref: 'IEC 61000-3-2', checklist_items: ['Calibrate transducers', 'Check firmware', 'Inspect cooling fins', 'Test output waveform'] },
  { asset_code: 'MT-CNC-001',  maintenance_type: 'preventive', frequency_days: 90,  days_offset: 12,  assigned_to: 'Venkat Raman',   standard_ref: 'ISO 10360-2',   checklist_items: ['Lubricate spindle', 'Check tool holders', 'Clean coolant tank', 'Inspect limit switches'] },
  { asset_code: 'MT-HVTK-001', maintenance_type: 'inspection', frequency_days: 365, days_offset: -10, assigned_to: 'Priya Sharma',   standard_ref: 'IS 2516',       checklist_items: ['Calibrate HV probes', 'Check insulation resistance', 'Verify safety interlock'] },
  { asset_code: 'MT-UPS-001',  maintenance_type: 'preventive', frequency_days: 180, days_offset: 20,  assigned_to: 'IT Team',        standard_ref: 'IEC 62040-3',   checklist_items: ['Test battery capacity', 'Check bypass switch', 'Inspect output breaker'] },
  { asset_code: 'MT-COMP-001', maintenance_type: 'preventive', frequency_days: 30,  days_offset: 3,   assigned_to: 'Workshop Staff', standard_ref: 'ISO 8573-1',    checklist_items: ['Drain condensate', 'Check oil level', 'Inspect belt tension', 'Clean air filter'] },
];

const SPARE_PARTS = [
  { name: 'IGBT Module (SKM200GB12T4)',  category: 'Power Electronics', unit: 'Nos', unit_cost: 8500,  stock_qty: 12, reorder_level: 4,  part_number: 'SKM200GB12T4',   supplier_name: 'Semikron India',       location: 'Electrical Store - Rack A', lead_time_days: 14, min_level: 4,  max_level: 20  },
  { name: 'Capacitor Bank 30kVAR',       category: 'Power Quality',     unit: 'Nos', unit_cost: 6200,  stock_qty: 8,  reorder_level: 3,  part_number: 'CAP-30KVAR-440', supplier_name: 'Epcos AG',             location: 'Electrical Store - Rack B', lead_time_days: 21, min_level: 3,  max_level: 15  },
  { name: 'CNC Spindle Bearing (7208)',  category: 'Bearings',          unit: 'Nos', unit_cost: 1800,  stock_qty: 6,  reorder_level: 2,  part_number: 'BRG-7208-AC',    supplier_name: 'SKF India',            location: 'Mechanical Store - Bin 12', lead_time_days: 7,  min_level: 2,  max_level: 10  },
  { name: 'Coolant Tank Filter (50 μm)', category: 'Consumables',       unit: 'Nos', unit_cost: 420,   stock_qty: 24, reorder_level: 10, part_number: 'FLT-50MIC-CNC',  supplier_name: 'Filtration Solutions', location: 'Mechanical Store - Bin 3',  lead_time_days: 3,  min_level: 10, max_level: 50  },
  { name: 'MOV (Metal Oxide Varistor)',  category: 'Power Electronics', unit: 'Nos', unit_cost: 180,   stock_qty: 50, reorder_level: 20, part_number: 'MOV-275VAC-14',  supplier_name: 'Epcos AG',             location: 'Electrical Store - Rack A', lead_time_days: 7,  min_level: 20, max_level: 100 },
  { name: 'Air Filter Element (10 HP)', category: 'Consumables',        unit: 'Nos', unit_cost: 350,   stock_qty: 8,  reorder_level: 4,  part_number: 'AF-ELGI-10HP',   supplier_name: 'Elgi Equipments',      location: 'Mechanical Store - Bin 8',  lead_time_days: 10, min_level: 4,  max_level: 20  },
  { name: 'UPS Battery (12V 9Ah)',      category: 'Electrical',         unit: 'Nos', unit_cost: 1200,  stock_qty: 3,  reorder_level: 6,  part_number: 'BAT-12V-9AH',    supplier_name: 'Exide Industries',     location: 'Electrical Store - Rack C', lead_time_days: 5,  min_level: 6,  max_level: 24  },
  { name: 'HV Probe Tip Replacement',   category: 'Testing',            unit: 'Set', unit_cost: 2800,  stock_qty: 4,  reorder_level: 2,  part_number: 'PRB-TIP-HV-SET', supplier_name: 'Tektronix India',      location: 'Lab Store',                 lead_time_days: 30, min_level: 2,  max_level: 8   },
  { name: 'Contactor 40A (3-Phase)',    category: 'Electrical',         unit: 'Nos', unit_cost: 1450,  stock_qty: 10, reorder_level: 4,  part_number: 'CTR-40A-3PH',    supplier_name: 'Schneider Electric',   location: 'Electrical Store - Rack B', lead_time_days: 7,  min_level: 4,  max_level: 20  },
  { name: 'Compressor Oil (SAE 30)',    category: 'Consumables',        unit: 'Ltr', unit_cost: 280,   stock_qty: 2,  reorder_level: 5,  part_number: 'OIL-SAE30-COMP', supplier_name: 'Castrol India',        location: 'Mechanical Store - Bin 15', lead_time_days: 3,  min_level: 5,  max_level: 20  },
];

export async function up(knex) {
  let companyIds = [null];
  try {
    const { rows } = await knex.raw(`SELECT id FROM companies ORDER BY id LIMIT 10`);
    if (rows.length) companyIds = rows.map(r => r.id);
  } catch { /* companies table may differ */ }

  for (const companyId of companyIds) {
    const { rows: [{ cnt }] } = await knex.raw(
      companyId != null
        ? `SELECT COUNT(*) AS cnt FROM assets_register WHERE company_id = $1`
        : `SELECT COUNT(*) AS cnt FROM assets_register WHERE company_id IS NULL`,
      companyId != null ? [companyId] : []
    );
    if (parseInt(cnt) > 0) continue;

    // Insert assets and collect id → asset_code map
    const assetIdMap = {};
    for (const def of ASSET_DEFS) {
      const { rows } = await knex.raw(
        `INSERT INTO assets_register
           (asset_code, name, category, location, department, purchase_date,
            purchase_cost, current_value, manufacturer, serial_number, status, company_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11)
         RETURNING id, asset_code`,
        [def.asset_code, def.name, def.category, def.location, def.department,
         def.purchase_date, def.purchase_cost, def.current_value,
         def.manufacturer, def.serial_number, companyId]
      );
      assetIdMap[def.asset_code] = rows[0].id;
    }

    // Insert maintenance schedules
    const today = new Date();
    for (const sched of SCHEDULE_DEFS) {
      const dueDate = new Date(today);
      dueDate.setDate(dueDate.getDate() + sched.days_offset);
      await knex.raw(
        `INSERT INTO maintenance_schedules
           (asset_id, maintenance_type, frequency_days, next_due_date,
            assigned_to, standard_ref, checklist_items, is_active, company_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8)`,
        [assetIdMap[sched.asset_code], sched.maintenance_type, sched.frequency_days,
         dueDate.toISOString().split('T')[0], sched.assigned_to, sched.standard_ref,
         JSON.stringify(sched.checklist_items), companyId]
      );
    }

    // Insert spare parts (no unique constraint assumed — guard is at assets level)
    for (const part of SPARE_PARTS) {
      await knex.raw(
        `INSERT INTO spare_parts
           (name, unit, unit_cost, stock_qty, reorder_level,
            part_number, supplier_name, location, lead_time_days,
            min_level, max_level, company_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [part.name, part.unit, part.unit_cost, part.stock_qty,
         part.reorder_level, part.part_number, part.supplier_name, part.location,
         part.lead_time_days, part.min_level, part.max_level, companyId]
      );
    }
  }
}

export async function down(knex) {
  const codes = ASSET_DEFS.map(a => a.asset_code);
  const partNums = SPARE_PARTS.map(p => p.part_number);
  const codePlaceholders = codes.map((_, i) => `$${i + 1}`).join(',');
  const { rows: assetRows } = await knex.raw(
    `SELECT id FROM assets_register WHERE asset_code IN (${codePlaceholders})`, codes
  );
  const assetIds = assetRows.map(r => r.id);
  if (assetIds.length) {
    const idPlaceholders = assetIds.map((_, i) => `$${i + 1}`).join(',');
    await knex.raw(`DELETE FROM maintenance_schedules WHERE asset_id IN (${idPlaceholders})`, assetIds);
  }
  await knex.raw(`DELETE FROM assets_register WHERE asset_code IN (${codePlaceholders})`, codes);
  const partPlaceholders = partNums.map((_, i) => `$${i + 1}`).join(',');
  await knex.raw(`DELETE FROM spare_parts WHERE part_number IN (${partPlaceholders})`, partNums);
}
