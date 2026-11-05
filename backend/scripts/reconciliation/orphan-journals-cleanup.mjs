#!/usr/bin/env node
/**
 * orphan-journals-cleanup.mjs — guarded cleanup of the frozen orphan-journal
 * list (Phase 3I, stage 1). See orphanJournalCleanup.js for the rules.
 *
 *   node scripts/reconciliation/orphan-journals-cleanup.mjs backup        --frozen F --out B
 *   node scripts/reconciliation/orphan-journals-cleanup.mjs verify-backup --frozen F --backup B
 *   node scripts/reconciliation/orphan-journals-cleanup.mjs dry-run       --frozen F
 *   node scripts/reconciliation/orphan-journals-cleanup.mjs execute       --frozen F --backup B \
 *        --approved-by "<name>" --confirm DELETE-<n>-ORPHAN-JOURNALS [--log L]
 *
 * backup / verify-backup / dry-run run in a READ ONLY transaction, rolled
 * back. execute is the only mode that writes, and only in one all-or-nothing
 * transaction.
 */
import pg from 'pg';
import dotenv from 'dotenv';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { backup, verifyBackup, revalidate, execute, CONFIRM_PHRASE } from './orphanJournalCleanup.js';

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(here, '../../.env'), quiet: true });
const [mode, ...rest] = process.argv.slice(2);
const arg = (k) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
const need = (k) => { const v = arg(k); if (!v) { console.error(`--${k} is required`); process.exit(2); } return v; };

const frozen = JSON.parse(readFileSync(need('frozen'), 'utf8'));
const ids = frozen.entries.map(e => e.id);
if (new Set(ids).size !== ids.length || ids.length !== frozen.total) {
  console.error(`frozen list is inconsistent: total ${frozen.total}, ${ids.length} entries, ${new Set(ids).size} unique`); process.exit(2);
}

const client = new pg.Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME,
                               user: process.env.DB_USER, password: process.env.DB_PASSWORD });
await client.connect();
let code = 0;
try {
  if (mode === 'backup' || mode === 'verify-backup' || mode === 'dry-run') {
    await client.query('BEGIN READ ONLY');
    if (mode === 'backup') {
      const bk = await backup(client, ids);
      writeFileSync(need('out'), JSON.stringify(bk, null, 1));
      console.log(JSON.stringify({ written: arg('out'), totals: bk.totals, checksums: bk.checksums }, null, 2));
    } else if (mode === 'verify-backup') {
      const r = await verifyBackup(client, JSON.parse(readFileSync(need('backup'), 'utf8')), ids);
      console.log(JSON.stringify(r, null, 2)); code = r.ok ? 0 : 1;
    } else {
      const v = await revalidate(client, ids);
      const sum = (k) => Math.round(v.rows.reduce((t, r) => t + r[k], 0) * 100) / 100;
      console.log(JSON.stringify({
        mode: 'dry-run — nothing deleted', frozen_ids: ids.length, found: v.rows.length, all_qualify: v.ok, failures: v.failures,
        would_delete: { headers: v.rows.length, lines: v.rows.reduce((t, r) => t + r.lines, 0),
                        legacy_lines: v.rows.reduce((t, r) => t + r.legacy_lines, 0) },
        totals: { header_debit: sum('total_debit'), header_credit: sum('total_credit'),
                  line_debit: sum('line_debit'), line_credit: sum('line_credit') },
        confirm_phrase: CONFIRM_PHRASE(ids.length),
      }, null, 2));
      code = v.ok ? 0 : 1;
    }
    await client.query('ROLLBACK');
  } else if (mode === 'execute') {
    const bk = JSON.parse(readFileSync(need('backup'), 'utf8'));
    const result = await execute(client, ids, bk, { approvedBy: need('approved-by'), confirm: need('confirm') });
    if (arg('log')) writeFileSync(arg('log'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error('mode must be backup | verify-backup | dry-run | execute'); code = 2;
  }
} catch (e) {
  console.error(e.message, e.failures || e.problems || '');
  code = 1;
} finally {
  await client.end();
}
process.exit(code);
