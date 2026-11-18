/**
 * learning-center-seed-cleanup.mjs — empty every Learning Center table.
 *
 * Owner instruction 2026-11-18 ("clear the test data — yes"): the Learning
 * Center audit found no real record in any L&D table. Programmes were six
 * 2026-04 demo rows, enrolments pointed at employees that do not exist (4, 539,
 * 548…), certifications / assessments / trainers were 'SEED …' rows, the nine
 * learning paths were QA test rows ('Test Value QA' ×7), and skills were
 * placeholder values. The module starts empty.
 *
 *   node scripts/cleanup/learning-center-seed-cleanup.mjs          dry run (counts)
 *   node scripts/cleanup/learning-center-seed-cleanup.mjs --apply  backup + delete
 *
 * lnd_settings (configuration, not records) is kept. performance_competencies
 * belongs to Performance reviews and is not touched.
 *
 * The backup (full rows, JSON + sha256) goes to ../_backups; each deleted row
 * writes one audit_logs row. Restore: INSERT the JSON rows back, parents first
 * (reverse of TABLES below), ids included.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '../../.env'), quiet: true });
const apply = process.argv.includes('--apply');

// Children before parents.
const TABLES = [
  'training_attendance', 'training_sessions', 'training_costs',
  'assessment_attempts', 'assessment_questions', 'assessments',
  'employee_learning_paths', 'learning_path_items', 'learning_paths',
  'training_enrollments', 'training_programs', 'trainers',
  'employee_certifications', 'certifications',
  'skill_matrix', 'employee_skills',
  'employee_competency_assessments', 'role_competencies', 'competency_framework',
  'competency_definitions',
];

const client = new pg.Client({
  host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
});
await client.connect();
try {
  await client.query('BEGIN');
  const snapshot = {};
  for (const t of TABLES) {
    const exists = await client.query(`SELECT to_regclass($1) AS r`, [`public.${t}`]);
    if (!exists.rows[0].r) { console.log(`${t.padEnd(34)} (table absent — skipped)`); continue; }
    const { rows } = await client.query(`SELECT * FROM ${t} ORDER BY id FOR UPDATE`);
    snapshot[t] = rows;
    console.log(`${t.padEnd(34)} ${rows.length} row(s)`);
  }
  if (!apply) { await client.query('ROLLBACK'); console.log('Dry run — pass --apply to back up and delete.'); process.exit(0); }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(here, '../../../../_backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `learning_center_seed_${stamp}.json`);
  const body = JSON.stringify({ taken_at: new Date().toISOString(), database: process.env.DB_NAME, tables: snapshot }, null, 2);
  fs.writeFileSync(file, body);
  fs.writeFileSync(`${file}.sha256`, `${crypto.createHash('sha256').update(body).digest('hex')}  ${path.basename(file)}\n`);

  const audit = [];
  const reason = JSON.stringify({ reason: 'Learning Center test/seed data removed on owner instruction 2026-11-18', backup: path.basename(file) });
  for (const t of TABLES) {
    const rows = snapshot[t] || [];
    // One statement per table: learning_path_items references itself
    // (prerequisite_item_id), so row-by-row deletion trips its own FK.
    if (rows.length) await client.query(`DELETE FROM ${t} WHERE id = ANY($1::int[])`, [rows.map(r => r.id)]);
    for (const r of rows) {
      const { rows: [a] } = await client.query(
        `INSERT INTO audit_logs (user_id, module_name, action_type, reference_type, reference_id, old_data_json, new_data_json)
         VALUES (NULL, 'training', 'delete', $1, $2, $3, $4) RETURNING id`,
        [t, String(r.id), JSON.stringify(r), reason]);
      audit.push(a.id);
    }
  }
  await client.query('COMMIT');
  console.log(`Deleted ${audit.length} row(s). Backup ${file}`);
  if (audit.length) console.log(`Audit rows ${audit[0]}–${audit[audit.length - 1]}`);
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Nothing deleted:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
