#!/usr/bin/env node
/**
 * orphan-journals-report.mjs — READ-ONLY report of journal entries whose
 * company no longer exists (Phase 3H, item 4).
 *
 *   node scripts/reconciliation/orphan-journals-report.mjs [--json out.json]
 *
 * Runs inside a READ ONLY transaction that is rolled back; it cannot change a
 * row. It classifies each orphan by the evidence the database holds and
 * prints counts, totals and the evidence; with --json it also writes the full
 * per-entry list (the frozen id list a cleanup would have to match).
 *
 * Why they exist: journal_entries has no foreign key to companies, and test
 * teardowns deleted journal entries before the invoices that reference them
 * (invoices_journal_entry_id_fkey), so the journal delete failed while the
 * company delete succeeded. Fixed in the Phase 3C–3G suites (2026-10-28).
 *
 * Classification (an entry is TEST_ARTEFACT only if EVERY criterion holds):
 *   C1  its company does not exist
 *   C2  no live company record references that company id anywhere the
 *       report checks (users, employees, audit_logs)
 *   C3  the record it refers to (invoice / credit note) no longer exists
 *   C4  nothing references the entry (invoices, credit notes, payments,
 *       reversals)
 *   C5  its lines, where present, balance
 * Anything failing one criterion is NEEDS_REVIEW, with the criteria it fails.
 */
import pg from 'pg';
import dotenv from 'dotenv';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(here, '../../.env'), quiet: true });
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;

const client = new pg.Client({
  host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
});

const SQL = `
  WITH orph AS (
    SELECT je.* FROM journal_entries je
     WHERE je.company_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM companies co WHERE co.id = je.company_id)
  )
  SELECT o.id, o.entry_number, o.entry_type, o.reference_type, o.reference_id, o.status, o.company_id,
         o.total_debit::float AS total_debit, o.total_credit::float AS total_credit,
         o.created_at, o.description,
         (SELECT COUNT(*) FROM journal_lines l WHERE l.entry_id = o.id)::int AS lines,
         (SELECT COALESCE(SUM(l.debit), 0) FROM journal_lines l WHERE l.entry_id = o.id)::float AS line_debit,
         (SELECT COALESCE(SUM(l.credit), 0) FROM journal_lines l WHERE l.entry_id = o.id)::float AS line_credit,
         (EXISTS (SELECT 1 FROM users u WHERE u.company_id = o.company_id)
          OR EXISTS (SELECT 1 FROM employees e WHERE e.company_id = o.company_id)
          OR EXISTS (SELECT 1 FROM audit_logs a WHERE a.company_id = o.company_id)) AS company_has_footprint,
         CASE o.reference_type
           WHEN 'invoice'     THEN EXISTS (SELECT 1 FROM invoices i WHERE i.id::text = o.reference_id::text)
           WHEN 'credit_note' THEN EXISTS (SELECT 1 FROM credit_notes c WHERE c.id::text = o.reference_id::text)
           ELSE NULL END AS referenced_record_exists,
         (EXISTS (SELECT 1 FROM invoices i WHERE i.journal_entry_id = o.id)
          OR EXISTS (SELECT 1 FROM credit_notes c WHERE c.posted_journal_entry_id = o.id)
          OR EXISTS (SELECT 1 FROM payments p WHERE p.journal_entry_id = o.id)
          OR EXISTS (SELECT 1 FROM journal_entries r WHERE r.reversal_of_id = o.id)) AS is_referenced
    FROM orph o
   ORDER BY o.created_at, o.id`;

await client.connect();
try {
  await client.query('BEGIN READ ONLY');
  const { rows } = await client.query(SQL);
  const entries = rows.map(e => {
    const fails = [];
    if (e.company_has_footprint) fails.push('C2 company id has users/employees/audit rows');
    if (e.referenced_record_exists !== false) fails.push(`C3 referenced ${e.reference_type ?? 'record'} ${e.referenced_record_exists ? 'still exists' : 'cannot be checked'}`);
    if (e.is_referenced) fails.push('C4 entry is referenced');
    if (e.lines > 0 && Math.abs(e.line_debit - e.line_credit) >= 0.005) fails.push('C5 lines unbalanced');
    return { ...e, classification: fails.length ? 'NEEDS_REVIEW' : 'TEST_ARTEFACT', failed_criteria: fails };
  });
  const by = (k) => entries.reduce((m, e) => { const key = k(e); (m[key] ||= { entries: 0, header_debit: 0, line_debit: 0 });
    m[key].entries++; m[key].header_debit += e.total_debit; m[key].line_debit += e.line_debit; return m; }, {});
  const round = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) =>
    [k, { ...v, header_debit: Math.round(v.header_debit * 100) / 100, line_debit: Math.round(v.line_debit * 100) / 100 }]));
  const report = {
    generated_at: new Date().toISOString(),
    total: entries.length,
    companies: new Set(entries.map(e => e.company_id)).size,
    company_id_range: entries.length ? [Math.min(...entries.map(e => e.company_id)), Math.max(...entries.map(e => e.company_id))] : null,
    created_range: entries.length ? [entries[0].created_at, entries.at(-1).created_at] : null,
    by_classification: round(by(e => e.classification)),
    by_type: round(by(e => `${e.entry_type}/${e.reference_type}/${e.status}`)),
    entries_with_lines: entries.filter(e => e.lines > 0).length,
    needs_review: entries.filter(e => e.classification === 'NEEDS_REVIEW').map(e => ({ id: e.id, entry_number: e.entry_number, failed: e.failed_criteria })),
  };
  console.log(JSON.stringify(report, null, 2));
  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({ ...report, entries: entries.map(e => ({
      id: e.id, entry_number: e.entry_number, entry_type: e.entry_type, reference_type: e.reference_type,
      reference_id: e.reference_id, company_id: e.company_id, status: e.status, created_at: e.created_at,
      total_debit: e.total_debit, lines: e.lines, line_debit: e.line_debit, line_credit: e.line_credit,
      classification: e.classification, failed_criteria: e.failed_criteria })) }, null, 2));
    console.error(`full list written to ${jsonOut}`);
  }
} finally {
  await client.query('ROLLBACK').catch(() => {});
  await client.end();
}
