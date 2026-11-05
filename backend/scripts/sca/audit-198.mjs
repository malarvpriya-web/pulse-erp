#!/usr/bin/env node
// backend/scripts/sca/audit-198.mjs
/**
 * Scores the 198 supply-chain components against the running system.
 *
 *   node scripts/sca/audit-198.mjs            full report
 *   node scripts/sca/audit-198.mjs --gaps     only the rows that are not full
 *   node scripts/sca/audit-198.mjs --json     machine-readable
 *
 * Exit code is 0 only when all 198 are FULL. That is the point: "100/100" is a
 * command that either passes or does not, not a number written in a report.
 *
 * Every probe is defined in sca-registry.mjs and implemented in sca-probe.mjs.
 * A probe that cannot be evaluated counts as a failure - an unverifiable claim
 * is not a passing one.
 */
import 'dotenv/config';
import pg from 'pg';
import { COMPONENTS, GROUP_NAMES } from './sca-registry.mjs';

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, max: 4,
});
const q = async (text, params) => (await pool.query(text, params)).rows;

const argv     = process.argv.slice(2);
const gapsOnly = argv.includes('--gaps');
const asJson   = argv.includes('--json');

const results = [];
for (const c of COMPONENTS) {
  const probes = [];
  for (const probe of c.p) {
    const out = await probe.run(q);
    probes.push({ kind: probe.kind, label: probe.label, ok: out.ok, evidence: out.evidence });
  }
  const passed = probes.filter(p => p.ok).length;
  const status = passed === probes.length ? 'full' : passed === 0 ? 'missing' : 'partial';
  results.push({ group: c.g, groupName: GROUP_NAMES[c.g], name: c.n, status, probes });
}
await pool.end();

const tally = results.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {});
const full = tally.full || 0;

if (asJson) {
  console.log(JSON.stringify({ total: results.length, tally, results }, null, 2));
} else {
  let lastGroup = null;
  for (const r of results) {
    if (gapsOnly && r.status === 'full') continue;
    if (r.group !== lastGroup) {
      console.log('\n── ' + r.group + ' · ' + r.groupName + ' ' + '─'.repeat(Math.max(0, 50 - r.groupName.length)));
      lastGroup = r.group;
    }
    const mark = r.status === 'full' ? 'PASS' : r.status === 'partial' ? 'PART' : 'MISS';
    console.log(`  [${mark}] ${r.name}`);
    for (const p of r.probes) {
      if (r.status === 'full' && !gapsOnly) continue;
      if (p.ok && r.status !== 'full') continue;
      console.log(`         ${p.ok ? 'ok  ' : 'FAIL'} ${p.kind}: ${p.label}`);
      if (!p.ok) console.log(`              ${p.evidence}`);
    }
  }
  console.log('\n' + '='.repeat(70));
  console.log(`SCA scorecard: ${full} / ${results.length} full`
    + `  (partial ${tally.partial || 0}, missing ${tally.missing || 0})`);
  console.log('='.repeat(70));
}

process.exit(full === results.length ? 0 : 1);
