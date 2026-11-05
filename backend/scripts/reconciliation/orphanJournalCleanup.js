/**
 * orphanJournalCleanup.js — the guarded removal of orphaned journal entries
 * (Phase 3I, stage 1). Library; the CLI is orphan-journals-cleanup.mjs.
 *
 * Nothing here runs on its own. `backup`, `verifyBackup` and `revalidate` are
 * read-only. `execute` deletes, and only:
 *   - the ids of a FROZEN list (the 3H report, orphan-journals-<date>.json),
 *   - after a backup of exactly those headers and lines has been read back and
 *     matched row for row against the live rows,
 *   - in ONE transaction that locks every frozen row and aborts unless EVERY
 *     frozen id still exists and still meets every criterion below, the set is
 *     exactly the frozen set, and the backup still matches,
 *   - with the approver named and the confirmation phrase given.
 * It deletes nothing outside the frozen ids, and never reassigns or reverses.
 *
 * Criteria (each must hold for every id):
 *   C1 its company does not exist
 *   C2 no user, employee or audit-log row names that company id
 *   C3 the record it refers to (invoice / credit note) does not exist
 *   C4 no row of ANY table with a foreign key to journal_entries points at it,
 *      other than its own lines (discovered from pg_constraint, not a list)
 *   C5 its lines, where present, balance
 */
import { createHash } from 'node:crypto';

export const CONFIRM_PHRASE = (n) => `DELETE-${n}-ORPHAN-JOURNALS`;
const LINE_TABLES = new Set(['journal_lines', 'journal_entry_lines']);

/** Every (table, column) with a foreign key to journal_entries.id. */
export async function journalDependents(db) {
  const { rows } = await db.query(`
    SELECT k.conrelid::regclass::text AS tbl, a.attname AS col, k.confdeltype AS on_delete
      FROM pg_constraint k
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
     WHERE k.contype = 'f' AND k.confrelid = 'journal_entries'::regclass
     ORDER BY 1, 2`);
  return rows;
}

/** Re-check every criterion for every id. Returns { ok, failures[], rows }. */
export async function revalidate(db, ids, { lock = false } = {}) {
  const { rows } = await db.query(`
    SELECT je.id, je.entry_number, je.entry_type, je.reference_type, je.reference_id, je.status, je.company_id,
           je.total_debit::float AS total_debit, je.total_credit::float AS total_credit, je.created_at,
           NOT EXISTS (SELECT 1 FROM companies co WHERE co.id = je.company_id) AND je.company_id IS NOT NULL AS c1,
           NOT (EXISTS (SELECT 1 FROM users u WHERE u.company_id = je.company_id)
                OR EXISTS (SELECT 1 FROM employees e WHERE e.company_id = je.company_id)
                OR EXISTS (SELECT 1 FROM audit_logs a WHERE a.company_id = je.company_id)) AS c2,
           CASE je.reference_type
             WHEN 'invoice'     THEN NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id::text = je.reference_id::text)
             WHEN 'credit_note' THEN NOT EXISTS (SELECT 1 FROM credit_notes c WHERE c.id::text = je.reference_id::text)
             ELSE false END AS c3,
           (SELECT COALESCE(SUM(l.debit), 0) FROM journal_lines l WHERE l.entry_id = je.id)::float AS line_debit,
           (SELECT COALESCE(SUM(l.credit), 0) FROM journal_lines l WHERE l.entry_id = je.id)::float AS line_credit,
           (SELECT COUNT(*) FROM journal_lines l WHERE l.entry_id = je.id)::int AS lines,
           (SELECT COUNT(*) FROM journal_entry_lines l WHERE l.journal_entry_id = je.id)::int AS legacy_lines
      FROM journal_entries je
     WHERE je.id = ANY($1::uuid[])
     ORDER BY je.id
     ${lock ? 'FOR UPDATE OF je' : ''}`, [ids]);
  const referenced = new Map();
  for (const d of await journalDependents(db)) {
    if (LINE_TABLES.has(d.tbl)) continue;
    const { rows: hits } = await db.query(
      `SELECT "${d.col}"::text AS id, COUNT(*)::int AS n FROM ${d.tbl} WHERE "${d.col}" = ANY($1::uuid[]) GROUP BY 1`, [ids]);
    for (const h of hits) referenced.set(h.id, [...(referenced.get(h.id) || []), `${d.tbl}.${d.col} (${h.n})`]);
  }
  const failures = [];
  const found = new Set(rows.map(r => r.id));
  for (const id of ids) if (!found.has(id)) failures.push({ id, failed: ['missing — no longer exists'] });
  for (const r of rows) {
    const failed = [];
    if (!r.c1) failed.push('C1 company exists');
    if (!r.c2) failed.push('C2 company id has users/employees/audit rows');
    if (!r.c3) failed.push(`C3 referenced ${r.reference_type ?? 'record'} exists or cannot be checked`);
    if (referenced.has(r.id)) failed.push(`C4 referenced by ${referenced.get(r.id).join(', ')}`);
    if (r.lines > 0 && Math.abs(r.line_debit - r.line_credit) >= 0.005) failed.push('C5 lines unbalanced');
    if (failed.length) failures.push({ id: r.id, entry_number: r.entry_number, failed });
  }
  return { ok: failures.length === 0 && rows.length === ids.length, failures, rows };
}

const canonical = (v) => JSON.stringify(v, Object.keys(v).sort());
const hashRows = (rows) => createHash('sha256').update(rows.map(canonical).join('\n')).digest('hex');

async function snapshot(db, ids) {
  const { rows: headers } = await db.query(
    `SELECT row_to_json(je)::jsonb AS r FROM journal_entries je WHERE je.id = ANY($1::uuid[]) ORDER BY je.id`, [ids]);
  const { rows: lines } = await db.query(
    `SELECT row_to_json(l)::jsonb AS r FROM journal_lines l WHERE l.entry_id = ANY($1::uuid[]) ORDER BY l.entry_id, l.id`, [ids]);
  const { rows: legacy } = await db.query(
    `SELECT row_to_json(l)::jsonb AS r FROM journal_entry_lines l WHERE l.journal_entry_id = ANY($1::uuid[]) ORDER BY l.journal_entry_id, l.id`, [ids]);
  return { headers: headers.map(x => x.r), lines: lines.map(x => x.r), legacy_lines: legacy.map(x => x.r) };
}
const totals = (snap) => ({
  headers: snap.headers.length, lines: snap.lines.length, legacy_lines: snap.legacy_lines.length,
  header_debit: Math.round(snap.headers.reduce((t, h) => t + Number(h.total_debit || 0), 0) * 100) / 100,
  header_credit: Math.round(snap.headers.reduce((t, h) => t + Number(h.total_credit || 0), 0) * 100) / 100,
  line_debit: Math.round(snap.lines.reduce((t, l) => t + Number(l.debit || 0), 0) * 100) / 100,
  line_credit: Math.round(snap.lines.reduce((t, l) => t + Number(l.credit || 0), 0) * 100) / 100,
});

/** Read-only: the exact rows of the frozen ids, with a checksum per table. */
export async function backup(db, ids) {
  const snap = await snapshot(db, ids);
  return {
    format: 'pulse-orphan-journal-backup/1', taken_at: new Date().toISOString(), frozen_ids: [...ids].sort(),
    totals: totals(snap),
    checksums: { headers: hashRows(snap.headers), lines: hashRows(snap.lines), legacy_lines: hashRows(snap.legacy_lines) },
    ...snap,
  };
}

/** Read the backup back: its own checksums hold, it covers exactly the ids, and the live rows still equal it. */
export async function verifyBackup(db, bk, ids) {
  const problems = [];
  if (bk?.format !== 'pulse-orphan-journal-backup/1') problems.push('not a backup of this format');
  const want = [...ids].sort();
  if (JSON.stringify(bk?.frozen_ids) !== JSON.stringify(want)) problems.push('backup covers a different id set');
  if (new Set((bk?.headers || []).map(h => h.id)).size !== want.length) problems.push(`backup has ${bk?.headers?.length} headers for ${want.length} ids`);
  for (const t of ['headers', 'lines', 'legacy_lines']) {
    if (hashRows(bk?.[t] || []) !== bk?.checksums?.[t]) problems.push(`${t} checksum does not match its rows`);
  }
  const live = await snapshot(db, ids);
  for (const t of ['headers', 'lines', 'legacy_lines']) {
    if (hashRows(live[t]) !== bk?.checksums?.[t]) problems.push(`live ${t} differ from the backup`);
  }
  return { ok: problems.length === 0, problems, totals: bk?.totals };
}

/**
 * The deletion. One transaction on `client`; commits only if everything holds.
 * Returns the before/after evidence. Throws (after rollback) otherwise.
 */
export async function execute(client, ids, bk, { approvedBy, confirm } = {}) {
  if (!String(approvedBy ?? '').trim()) throw new Error('approvedBy is required');
  if (confirm !== CONFIRM_PHRASE(ids.length)) throw new Error(`confirmation phrase must be ${CONFIRM_PHRASE(ids.length)}`);
  await client.query('BEGIN');
  try {
    const v = await revalidate(client, ids, { lock: true });
    if (!v.ok) throw Object.assign(new Error(`${v.failures.length} frozen id(s) no longer qualify; nothing deleted`), { failures: v.failures });
    const b = await verifyBackup(client, bk, ids);
    if (!b.ok) throw Object.assign(new Error(`backup does not match; nothing deleted`), { problems: b.problems });
    const orphanCount = async () => Number((await client.query(`SELECT COUNT(*)::int AS n FROM journal_entries je
       WHERE je.company_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM companies co WHERE co.id = je.company_id)`)).rows[0].n);
    const before = { orphans: await orphanCount(), ...bk.totals };
    const l1 = await client.query(`DELETE FROM journal_lines WHERE entry_id = ANY($1::uuid[])`, [ids]);
    const l2 = await client.query(`DELETE FROM journal_entry_lines WHERE journal_entry_id = ANY($1::uuid[])`, [ids]);
    const h = await client.query(`DELETE FROM journal_entries WHERE id = ANY($1::uuid[])`, [ids]);
    if (h.rowCount !== ids.length || l1.rowCount !== bk.totals.lines || l2.rowCount !== bk.totals.legacy_lines) {
      throw new Error(`deleted ${h.rowCount} headers / ${l1.rowCount} lines / ${l2.rowCount} legacy lines, expected `
        + `${ids.length} / ${bk.totals.lines} / ${bk.totals.legacy_lines}; rolled back`);
    }
    const after = { orphans: await orphanCount() };
    await client.query('COMMIT');
    return { approved_by: approvedBy, executed_at: new Date().toISOString(), deleted: { headers: h.rowCount, lines: l1.rowCount,
      legacy_lines: l2.rowCount }, before, after, backup_checksums: bk.checksums };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}
