/**
 * seed-engineering-development.js — demo data for the Engineering Development
 * (IPD) grid.
 *
 * DEV ONLY. This is sample data, deliberately NOT a migration: migrations run in
 * production, and invented development records must never land there.
 *
 *   node dev-tools/seed-engineering-development.js          # seed (no-op if rows exist)
 *   node dev-tools/seed-engineering-development.js --force  # wipe + reseed
 *
 * Every record uses a REAL product line from the live catalogue (ASTRA, LEONINE,
 * APFC, RTPFC, ACB, MBheem AHF, MV-VAJRA) rather than invented names, and
 * `category` matches that line's voltage_class so the grid never contradicts
 * Product Setup. The one HV row has no product line on purpose — an HV
 * feasibility study that predates any catalogue entry, which is exactly why
 * category is stored per record instead of read through the product line.
 *
 * ipd_number is drawn from seq_ipd, NOT hardcoded: hardcoding the strings would
 * leave the sequence at 1 and the next record created in the UI would collide on
 * the UNIQUE constraint.
 */

import pool from '../src/config/db.js';

// Resolved by display_name so the seed survives id churn in product_lines.
const ROWS = [
  {
    title: 'ASTRA 415V rack module — thermal rework',
    description: 'Redesign of the rack module heatsink after field temperature rise on high-ambient sites.',
    product: 'ASTRA - 415V', dev_type: 'Improvement', assembly_type: 'Sub Part',
    status: 'closed', owner: 'R. Kumar', priority: 'high',
    started: '2026-01-12', target: '2026-03-31', actual: '2026-03-24',
  },
  {
    title: 'MBheem AHF — 100A active harmonic filter',
    description: 'New active harmonic filter variant for the 100A band.',
    product: 'MBheem AHF', dev_type: 'New Product', assembly_type: 'Main Part',
    status: 'testing', owner: 'S. Priya', priority: 'critical',
    started: '2026-02-03', target: '2026-08-30',
  },
  {
    title: 'APFC 440V — contactor cost-down',
    description: 'Alternate contactor vendor qualification to reduce BOM cost.',
    product: 'APFC - 440V', dev_type: 'Cost Reduction', assembly_type: 'Sub Part',
    status: 'assembly', owner: 'A. Natarajan', priority: 'medium',
    started: '2026-03-16', target: '2026-07-31',
  },
  {
    title: 'MV-VAJRA — 11kV switching module',
    description: 'Medium-voltage switching module for the VAJRA platform.',
    product: 'MV-VAJRA', dev_type: 'New Product', assembly_type: 'Main Part',
    status: 'design', owner: 'K. Venkatesh', priority: 'high',
    started: '2026-05-04', target: '2027-01-29',
  },
  {
    title: 'RTPFC 690V — Coimbatore site customization',
    description: 'Enclosure and busbar changes for the Coimbatore SST installation.',
    product: 'RTPFC - 690V', dev_type: 'Customization', assembly_type: 'Main Part',
    status: 'procurement', owner: 'M. Iqbal', priority: 'high',
    started: '2026-06-01', target: '2026-09-15', link_ipp: true,
  },
  {
    title: 'ACB — legacy trip unit phase-out',
    description: 'Replacement of the end-of-life trip unit; last-time-buy assessed.',
    product: 'ACB', dev_type: 'Obsolescence', assembly_type: 'Sub Part',
    status: 'validation', owner: 'D. Ravi', priority: 'medium',
    started: '2026-04-20', target: '2026-07-25',
  },
  {
    title: 'LEONINE 415V — busbar clearance revision',
    description: 'Creepage/clearance revision following the IEC review.',
    product: 'LEONINE - 415V', dev_type: 'Improvement', assembly_type: 'Sub Part',
    status: 'closed', owner: 'R. Kumar', priority: 'medium',
    started: '2025-11-10', target: '2026-02-27', actual: '2026-03-06',
  },
  {
    title: 'ASTRA 690V — marine variant',
    description: 'Salt-fog hardened variant. Dropped: the opportunity did not convert.',
    product: 'ASTRA - 690V', dev_type: 'Customization', assembly_type: 'Main Part',
    status: 'cancelled', owner: 'S. Priya', priority: 'low',
    started: '2026-02-17', target: '2026-06-30', actual: '2026-04-09',
  },
  {
    title: 'APFC 690V — capacitor bank derating',
    description: 'Derating study after repeat capacitor failures in the field.',
    product: 'APFC - 690V', dev_type: 'Improvement', assembly_type: 'Sub Part',
    status: 'procurement', owner: 'A. Natarajan', priority: 'critical',
    started: '2026-03-02', target: '2026-06-12', // deliberately overdue
  },
  {
    title: 'RTPFC 440V — controller firmware v3',
    description: 'Firmware refresh with faster switching response.',
    product: 'RTPFC - 440V', dev_type: 'Cost Reduction', assembly_type: 'Sub Part',
    status: 'testing', owner: 'K. Venkatesh', priority: 'medium',
    started: '2026-05-18', target: '2026-08-14',
  },
  {
    title: 'HV STATCOM valve module — feasibility',
    description: 'Feasibility for an HV valve module. No catalogue product line yet.',
    product: null, dev_type: 'New Product', assembly_type: 'Main Part',
    category: 'HV', status: 'design', owner: 'K. Venkatesh', priority: 'high',
    started: '2026-06-22', target: '2027-03-31',
  },
  {
    title: 'ASTRA 415V — Gen-2 control card',
    description: 'Second-generation control card; feeds the Coimbatore build.',
    product: 'ASTRA - 415V', dev_type: 'New Product', assembly_type: 'Main Part',
    status: 'assembly', owner: 'D. Ravi', priority: 'high',
    started: '2026-04-06', target: '2026-10-30', link_ipp: true,
  },
];

async function seed() {
  const force = process.argv.includes('--force');

  const { rows: existing } = await pool.query(`SELECT COUNT(*)::int AS n FROM eng_development WHERE deleted_at IS NULL`);
  if (existing[0].n > 0 && !force) {
    console.log(`⏭  eng_development already has ${existing[0].n} record(s) — nothing to do. Re-run with --force to wipe and reseed.`);
    return;
  }
  if (force && existing[0].n > 0) {
    await pool.query(`DELETE FROM eng_development`);
    await pool.query(`ALTER SEQUENCE seq_ipd RESTART WITH 1`);
    console.log(`🧹 Cleared ${existing[0].n} existing record(s) and reset seq_ipd.`);
  }

  // Resolve the catalogue + a project to hang the IPD->IPP link off.
  const { rows: lines } = await pool.query(
    `SELECT id, display_name, voltage_class FROM product_lines WHERE deleted_at IS NULL`
  );
  const byName = Object.fromEntries(lines.map(l => [l.display_name, l]));

  const { rows: projects } = await pool.query(
    `SELECT id, project_number FROM projects
      WHERE deleted_at IS NULL AND project_number IS NOT NULL
      ORDER BY id DESC LIMIT 1`
  );
  const ipp = projects[0] ?? null;
  if (!ipp) console.warn('⚠  No project found — the IPD->IPP link will be left null.');

  let n = 0;
  for (const r of ROWS) {
    const line = r.product ? byName[r.product] : null;
    if (r.product && !line) {
      console.warn(`⚠  Skipped "${r.title}" — product line "${r.product}" is not in the catalogue.`);
      continue;
    }
    // Category follows the product line, so the grid can never disagree with
    // Product Setup. Only the catalogue-less HV row carries an explicit one.
    const category = r.category ?? line?.voltage_class ?? null;

    const { rows } = await pool.query(
      `INSERT INTO eng_development
         (ipd_number, title, description, product_line_id, dev_type, assembly_type,
          category, status, priority, owner_name, started_date, target_close_date,
          actual_close_date, project_id, company_id)
       VALUES ('IPD-' || LPAD(nextval('seq_ipd')::text, 5, '0'),
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1)
       RETURNING ipd_number`,
      [
        r.title, r.description, line?.id ?? null, r.dev_type, r.assembly_type,
        category, r.status, r.priority, r.owner, r.started, r.target,
        r.actual ?? null, r.link_ipp && ipp ? ipp.id : null,
      ]
    );
    console.log(`  ✅ ${rows[0].ipd_number}  ${r.status.padEnd(11)} ${r.title}`);
    n++;
  }
  console.log(`\n🌱 Seeded ${n} development record(s).`);
}

seed()
  .catch(e => { console.error('❌ Seed failed:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
