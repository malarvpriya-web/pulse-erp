/**
 * Proves the audit trail now records what a value changed FROM.
 *
 * Drives a real UPDATE through a route that had no before-image, then reads the
 * audit row back and asserts old_data_json holds the PREVIOUS value and
 * new_data_json the request that changed it. A middleware that is mounted but
 * captures nothing looks exactly like one that works.
 */
import { execSync } from 'node:child_process';
import fsSync from 'node:fs';

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Resolved from this file so the gate runs from any checkout.
const HERE  = path.dirname(fileURLToPath(import.meta.url));
const ROOT  = path.resolve(HERE, '../../..').split(path.sep).join('/');
const BASE  = process.env.PULSE_API || 'http://localhost:5000/api';
const SCRATCH = fsSync.mkdtempSync(path.join(os.tmpdir(), 'pulse-audit-')).split(path.sep).join('/');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const sql = (q) => {
  fsSync.writeFileSync(`${SCRATCH}/_q.sql`, q, 'utf8');
  const out = execSync(`node "${HERE.split(path.sep).join('/')}/_q-runner.mjs" "${SCRATCH}/_q.sql" "${ROOT}/backend/src/config/db.js"`,
    { cwd: ROOT + '/backend', encoding: 'utf8' });
  return JSON.parse(out.match(/ROWS:(.*)/)[1]);
};

function token(email) {
  const out = execSync('node backend/scripts/e2e-mint-token.mjs',
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, E2E_LOGIN_EMAIL: email } });
  const parsed = JSON.parse(out.split('---E2E_AUTH_BEGIN---')[1].split('---E2E_AUTH_END---')[0].trim());
  if (parsed.user.email !== email) throw new Error('wrong identity');
  return parsed.token;
}

const PS_KILL = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
async function startServer() {
  try { execSync('powershell -NoProfile -Command -', { input: PS_KILL, stdio: ['pipe', 'ignore', 'ignore'] }); }
  catch { /* none */ }
  await sleep(1500);
  const { spawn } = await import('node:child_process');
  spawn('node', ['server.js'], { cwd: ROOT + '/backend', detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    try { if ((await fetch(BASE + '/health')).ok) return; } catch { /* not up */ }
  }
  throw new Error('server did not start');
}

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

async function call(tok, method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json };
}

// Drive whatever server is already running; PROBE_RESTART=1 forces a clean one.
// A gate that kills the developer's server to start its own is worse than the
// bug it looks for.
if (process.env.PROBE_RESTART === '1') await startServer();
else {
  try { if (!(await fetch(BASE + '/health')).ok) throw new Error('unhealthy'); }
  catch { console.error('No server on ' + BASE + ' — start one, or run with PROBE_RESTART=1'); process.exit(2); }
}
const admin = token(process.env.E2E_LOGIN_EMAIL || 'superadmin@manifest.in');

console.log('\n== setup: an HR policy to edit ==');
sql("DELETE FROM hr_policies WHERE title LIKE 'BEFORE-IMAGE-VERIFY%'");
const TAG = 'BEFORE-IMAGE-VERIFY ' + Date.now();
const made = sql(`INSERT INTO hr_policies (title, category, description, company_id)
                  VALUES ('${TAG}', 'Verification', 'ORIGINAL TEXT', 1) RETURNING id, description`);
const id = made[0].id;
check('policy created', !!id, `id=${id}, description="${made[0].description}"`);

console.log('\n== the UPDATE, through a route that had no before-image ==');
const before = sql("SELECT COUNT(*)::int n FROM audit_logs")[0].n;
const upd = await call(admin, 'PUT', `/hr/policies/${id}`, {
  title: TAG, category: 'Verification', description: 'REVISED TEXT',
});
check('the route accepted it', upd.status >= 200 && upd.status < 300, `status=${upd.status}`);

await sleep(900);   // logAudit is fire-and-forget
const rows = sql(`SELECT action_type, old_data_json::text o, new_data_json::text n, user_id
                    FROM audit_logs WHERE reference_id = '${id}'
                   ORDER BY id DESC LIMIT 1`);
const row = rows[0];
check('an audit row was written', !!row, `${before} rows before`);

console.log('\n== THE POINT: it records what the value changed FROM ==');
check('old_data_json is present', !!row?.o && row.o !== 'null', (row?.o || '').slice(0, 80));
check('and holds the PREVIOUS content', /ORIGINAL TEXT/.test(row?.o || ''),
      /ORIGINAL TEXT/.test(row?.o || '') ? 'contains "ORIGINAL TEXT"' : `got ${(row?.o || '').slice(0, 90)}`);
check('new_data_json holds the change', /REVISED TEXT/.test(row?.n || ''),
      /REVISED TEXT/.test(row?.n || '') ? 'contains "REVISED TEXT"' : (row?.n || '').slice(0, 90));
check('the actor is named', row?.user_id != null, `user_id=${row?.user_id}`);

console.log('\n== a CREATE has no before-image, and must not invent one ==');
const b2 = sql("SELECT COUNT(*)::int n FROM audit_logs")[0].n;
const created = await call(admin, 'POST', '/hr/policies', {
  title: TAG + ' second', category: 'Verification', description: 'NEW',
});
await sleep(900);
const newRow = sql(`SELECT old_data_json::text o FROM audit_logs
                     WHERE new_data_json::text LIKE '%${TAG} second%' ORDER BY id DESC LIMIT 1`)[0];
check('create accepted', created.status >= 200 && created.status < 300, `status=${created.status}`);
check('its old_data_json is null, not {}', !newRow || newRow.o === null || newRow.o === 'null',
      `old_data_json=${newRow?.o}`);

console.log('\n== a DELETE captures the row it destroyed ==');
const del = await call(admin, 'DELETE', `/hr/policies/${id}`);
await sleep(900);
const delRow = sql(`SELECT action_type, old_data_json::text o FROM audit_logs
                     WHERE reference_id = '${id}' AND action_type = 'delete'
                     ORDER BY id DESC LIMIT 1`)[0];
check('delete accepted', del.status >= 200 && del.status < 300, `status=${del.status}`);
check('the destroyed row is on the record', /REVISED TEXT/.test(delRow?.o || ''),
      delRow ? (delRow.o || '').slice(0, 80) : 'no delete audit row');

console.log('\n== cleanup ==');
const gone = sql(`DELETE FROM hr_policies WHERE title LIKE 'BEFORE-IMAGE-VERIFY%' RETURNING id`);
sql(`DELETE FROM audit_logs WHERE new_data_json::text LIKE '%BEFORE-IMAGE-VERIFY%'
        OR old_data_json::text LIKE '%BEFORE-IMAGE-VERIFY%'`);
console.log(`  removed ${gone.length} policy row(s) and their audit entries`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
