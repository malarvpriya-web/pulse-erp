/**
 * unit.deadTableGuard.test.js
 *
 * Pulse carries several pairs of tables that model the same thing, where one is
 * live and the other is frozen history. Every one of them has cost real money
 * at least once, because the failure is silent in both directions:
 *
 *   - Reading the frozen one returns plausible, stale numbers. The dashboard
 *     counted 159 "pending" leave approvals aged 184 days from `leave_requests`
 *     (frozen 2026-03-30) while the workflow wrote `leave_applications`; the
 *     attendance tiles read 0% forever from `attendance` (frozen 2026-03-29)
 *     while every punch went to `attendance_records`.
 *   - Writing the frozen one loses the row. A leave filed over WhatsApp went
 *     into `leave_requests` and never appeared on any approval screen.
 *
 * Both were found by an audit, months late. This guard makes the next one fail
 * in CI instead: if a table listed below acquires a reference in application
 * code, someone has started using a dead table again.
 *
 * ⚠ This is a SOURCE guard, not a schema guard. The tables still exist and still
 * hold history on purpose — the subject-access export in security.routes.js
 * deliberately reads the frozen leave and attendance tables so a GDPR request
 * returns everything held about a person. That file is listed as an allowed
 * reader for exactly that reason. Do not "fix" a failure here by dropping the
 * table; decide first whether the new reference is the mistake.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here    = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');

/**
 * table -> why it is dead, and who may still mention it.
 * Paths are relative to src/ and compared with forward slashes.
 */
const DEAD_TABLES = {
  leave_requests: {
    reason: 'frozen 2026-03-30; the ledger is leave_applications (§174)',
    allowed: [
      'modules/admin/security.routes.js',          // GDPR subject export
      'modules/dashboard/dashboard.controller.js', // explanatory comment only
      'modules/intelligence/ai.routes.js',         // explanatory comment only
    ],
  },
  attendance: {
    reason: 'frozen 2026-03-29, zero writers; the live table is attendance_records',
    allowed: [
      'modules/admin/security.routes.js',          // GDPR subject export
    ],
    // `attendance` is a prefix of attendance_records, attendance_policies and a
    // dozen more, so this one is matched with a stricter pattern below.
    strict: true,
  },
  journal_entry_lines: {
    reason: 'redundant copy of journal_lines — all 4 depreciation entries verified present in both',
    allowed: [],
  },
  stock_movements:        { reason: 'superseded by stock_ledger', allowed: [] },
  payroll_slips:          { reason: 'superseded by payslips',     allowed: [] },
  putaway_tasks:          { reason: 'superseded by put_away_tasks', allowed: [] },
  talent_pool_candidates: { reason: 'superseded by talent_pool_members', allowed: [] },
};

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '__tests__', 'migrations', 'seeds'].includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (name.endsWith('.js')) yield full;
  }
}

/**
 * Does this file reference the table in SQL?
 *
 * Matches the table name only where a table name can appear — after FROM, JOIN,
 * INTO or UPDATE — so a column called `attendance_date` or a variable named
 * `attendance` does not register.
 *
 * Two deliberate narrowings, both of which this guard needed on its first run:
 *
 *  1. Comments are stripped. Several allowed files mention these tables only to
 *     explain why not to use them, and a guard that counted prose would push
 *     people toward deleting the explanation.
 *
 *  2. The SQL keyword must be UPPERCASE. Every query in this repo writes them
 *     that way, and the alternative flagged `reportCatalog.js` for the English
 *     sentence "Per-employee day counts from attendance records, split into…" —
 *     a report description, not a query. A guard with a false positive gets
 *     muted, so it is better for it to miss lowercase SQL (which does not exist
 *     here) than to cry wolf about prose (which does).
 */
function referencesTable(text, table, strict) {
  const noComments = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '').replace(/--.*$/, '')).join('\n');
  const boundary = strict ? '(?![_a-zA-Z])' : '\\b';
  const re = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+"?${table}"?${boundary}`);
  return re.test(noComments);
}

describe('dead tables stay dead', () => {
  for (const [table, spec] of Object.entries(DEAD_TABLES)) {
    it(`nothing new reads or writes ${table} (${spec.reason})`, () => {
      const offenders = [];
      for (const file of walk(srcRoot)) {
        const rel = relative(srcRoot, file).split(sep).join('/');
        if (spec.allowed.includes(rel)) continue;
        if (referencesTable(readFileSync(file, 'utf8'), table, spec.strict)) offenders.push(rel);
      }
      expect(
        offenders,
        `${table} is a dead table (${spec.reason}) but is referenced in:\n  ${offenders.join('\n  ')}\n` +
        `If the reference is deliberate, add it to DEAD_TABLES.${table}.allowed with a note saying why.`
      ).toEqual([]);
    });
  }
});
