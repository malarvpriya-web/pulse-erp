/**
 * The audit tables are add-only for the application (DB-01C3, manual §251).
 *
 * The application role cannot update or delete these rows, so code that tries fails only
 * at run time, on a host, for whoever hits that path. This fails the build instead.
 * Comments are stripped first. Maintenance scripts run under the owner's login and are
 * not scanned.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPEND_ONLY_TABLES } from '../../scripts/db/app-role-grants.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..');
const BACKEND = path.resolve(SRC, '..');
const SKIP = new Set(['__tests__', 'migrations', 'seeds', 'node_modules']);

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

function sources(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.m?js$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Statements needing UPDATE or DELETE rights on a table, within one SQL literal. */
function needsChangeRights(code, table) {
  const hits = [];
  for (const [sql] of code.matchAll(/`[^`]*`|'[^'\n]*'|"[^"\n]*"/g)) {
    if (!new RegExp(`\\b${table}\\b`).test(sql)) continue;
    if (new RegExp(`\\b(UPDATE|DELETE\\s+FROM|MERGE\\s+INTO|TRUNCATE(\\s+TABLE)?)\\s+(public\\.)?${table}\\b`, 'i').test(sql)) hits.push('write');
    if (new RegExp(`INSERT\\s+INTO\\s+(public\\.)?${table}\\b[\\s\\S]*ON\\s+CONFLICT[\\s\\S]*DO\\s+UPDATE`, 'i').test(sql)) hits.push('upsert');
    if (new RegExp(`\\bFROM\\s+(public\\.)?${table}\\b[\\s\\S]*\\bFOR\\s+(NO\\s+KEY\\s+)?(UPDATE|SHARE|KEY\\s+SHARE)\\b`, 'i').test(sql)) hits.push('row lock');
  }
  return hits;
}

describe('add-only audit tables', () => {
  it('application code never needs to change or remove their rows', () => {
    const offenders = [];
    for (const f of [...sources(SRC), path.join(BACKEND, 'server.js')]) {
      const code = stripComments(readFileSync(f, 'utf8'));
      for (const t of APPEND_ONLY_TABLES) {
        const hits = needsChangeRights(code, t);
        if (hits.length) offenders.push(`${path.relative(BACKEND, f).replace(/\\/g, '/')}: ${t} (${hits.join(', ')})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the check tells a change from an insert or a read', () => {
    const q = (s) => needsChangeRights(s, 'audit_logs');
    expect(q('pool.query(`UPDATE audit_logs SET a = 1 WHERE id = 2`)')).toEqual(['write']);
    expect(q('pool.query(`DELETE FROM audit_logs WHERE id = 2`)')).toEqual(['write']);
    expect(q('pool.query(`INSERT INTO audit_logs (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = 2`)')).toEqual(['upsert']);
    expect(q('pool.query(`SELECT * FROM audit_logs WHERE id = 2 FOR UPDATE`)')).toEqual(['row lock']);
    expect(q('pool.query(`INSERT INTO audit_logs (a) VALUES (1)`)')).toEqual([]);
    expect(q('pool.query(`SELECT * FROM audit_logs`)')).toEqual([]);
  });

  it('the main audit tables are on the list', () => {
    for (const t of ['audit_logs', 'security_events', 'auth_audit_log', 'access_denials']) expect(APPEND_ONLY_TABLES).toContain(t);
  });
});
