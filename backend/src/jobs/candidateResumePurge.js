/**
 * candidateResumePurge.js — remove an anonymised candidate's résumé file, only
 * when it is provably theirs alone.
 *
 * Called by candidateRetention after each run (and on every later run, which is
 * the retry). The queue is `candidate_resume_purges`, filled in the SAME
 * transaction that anonymises the candidate, so nothing here can run for an
 * anonymisation that rolled back, and nothing queued can be forgotten.
 *
 * For each queued reference:
 *
 *   1. It must be a LOCAL upload: '/uploads/<name>' where <name> is a plain file
 *      name (letters, digits, '.', '_', '-'), resolves directly inside the
 *      upload directory, and is a regular file — not a symlink or directory.
 *      Anything else is never touched: S3/R2 URLs and Google Drive ids are
 *      `skipped_external`; traversal or sub-paths are `unsafe_path`.
 *   2. NO other record may reference it. Every text / varchar / json / jsonb /
 *      array column of every table is searched for the file name — not a list
 *      of "known" columns, which is how a new table holding a copy would be
 *      missed. A candidate copied into another candidate (bulk import), or a
 *      résumé carried into an employee record, keeps the file
 *      (`retained_shared`, with where it was found). The anonymised candidate's
 *      own columns are already NULL when this runs. Log tables are excluded
 *      (LOG_TABLES): a download audit or a retention log naming a file is a
 *      record ABOUT the file, not a use of it.
 *   3. Delete, then confirm it is gone. Anything else is `failed` with the
 *      error, retried on later runs up to MAX_ATTEMPTS, and counted in the
 *      result — never reported as deleted.
 *
 * Each row is processed under `FOR UPDATE SKIP LOCKED`, so overlapping runs
 * cannot both act on one file.
 *
 * Known window: a new reference created between the scan and the unlink would
 * not be seen. The file belongs to a candidate whose own row no longer points to
 * it, so nothing in the application can produce such a reference.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import pool from '../config/db.js';
import { LOCAL_UPLOAD_DIR } from '../services/StorageService.js';

const { escapeIdentifier } = pg;

export const MAX_ATTEMPTS = 5;

/** Records ABOUT files, not uses of them. Never block a deletion. */
export const LOG_TABLES = new Set([
  'candidate_resume_purges', 'candidate_retention_log', 'audit_logs', 'access_denials',
]);

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/**
 * Classify one stored reference.
 * @returns {{ kind: 'local', name: string } | { kind: 'external' } | { kind: 'unsafe', why: string }}
 */
export function classifyRef(ref, uploadDir = LOCAL_UPLOAD_DIR) {
  const raw = String(ref ?? '').trim();
  if (!raw) return { kind: 'unsafe', why: 'empty reference' };
  if (/^gdrive:/i.test(raw) || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return { kind: 'external' };
  if (!raw.startsWith('/uploads/')) return { kind: 'unsafe', why: 'not under /uploads/' };
  let name = raw.slice('/uploads/'.length).split(/[?#]/)[0];
  try { name = decodeURIComponent(name); } catch { return { kind: 'unsafe', why: 'bad encoding' }; }
  if (!SAFE_NAME.test(name) || name.includes('..') || name !== path.basename(name)) {
    return { kind: 'unsafe', why: 'not a plain file name' };
  }
  const root = path.resolve(uploadDir);
  const abs = path.resolve(root, name);
  if (path.dirname(abs) !== root) return { kind: 'unsafe', why: 'resolves outside the upload directory' };
  return { kind: 'local', name };
}

// node-postgres' own identifier quoting (table/column names come from
// information_schema, but are quoted all the same).
const quoteIdent = (s) => escapeIdentifier(String(s));
const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Where else each file name appears. One query per table, all names at once.
 * @returns {Promise<Map<string, string[]>>} name → ['table.column', …]
 */
export async function findFileReferences(db, names) {
  const refs = new Map(names.map((n) => [n, []]));
  if (!names.length) return refs;
  const { rows: cols } = await db.query(`
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public'
       AND (c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb')
            OR (c.data_type = 'ARRAY' AND c.udt_name IN ('_text', '_varchar')))`);
  const byTable = new Map();
  for (const { table_name: t, column_name: c } of cols) {
    if (LOG_TABLES.has(t)) continue;
    if (!byTable.has(t)) byTable.set(t, []);
    byTable.get(t).push(c);
  }
  const patterns = names.map((n) => `%${likeEscape(n)}%`);
  for (const [table, columns] of byTable) {
    const hits = columns.map((c) => `CASE WHEN ${quoteIdent(c)}::text LIKE ANY($1::text[]) THEN ${quoteIdent(c)}::text END`);
    const where = columns.map((c) => `${quoteIdent(c)}::text LIKE ANY($1::text[])`).join(' OR ');
    const { rows } = await db.query(
      `SELECT ${hits.map((h, i) => `${h} AS c${i}`).join(', ')} FROM ${quoteIdent(table)} WHERE ${where}`,
      [patterns]);
    for (const row of rows) {
      columns.forEach((c, i) => {
        const v = row[`c${i}`];
        if (v == null) return;
        for (const n of names) if (v.includes(n)) refs.get(n).push(`${table}.${c}`);
      });
    }
  }
  for (const [n, where] of refs) refs.set(n, [...new Set(where)]);
  return refs;
}

/*
 * The evidence for each file is its candidate_resume_purges row — status,
 * attempts, last_error, referenced_by and timestamps. candidate_retention_log is
 * NOT written per file: its CHECK admits only anonymised / extended / withdrawn /
 * exported, and the anonymisation itself is already logged there.
 */

/**
 * Process queued résumé references.
 * @param {{ companyId?: number|null, uploadDir?: string, unlink?: Function, limit?: number }} opts
 *   `unlink` is injectable so a failed deletion can be tested without breaking the disk.
 */
export async function purgeQueuedResumes({ companyId = null, uploadDir = LOCAL_UPLOAD_DIR, unlink = fs.unlink, limit = 500 } = {}) {
  const out = { processed: 0, deleted: 0, already_absent: 0, retained_shared: 0, skipped_external: 0, unsafe_path: 0, failed: 0, held: 0 };

  // Defence in depth for the legal hold. A held candidate cannot be anonymised,
  // so nothing of theirs should ever be queued — but a queued row whose
  // candidate is under hold is left untouched (still pending) and counted, never
  // processed. Re-checked under the row lock below.
  const HELD = `EXISTS (SELECT 1 FROM candidates hc WHERE hc.id = candidate_resume_purges.candidate_id AND hc.legal_hold)`;
  const { rows: [heldQueued] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM candidate_resume_purges
      WHERE status IN ('pending', 'failed') AND ($1::int IS NULL OR company_id = $1::int) AND ${HELD}`,
    [companyId]);
  out.held = heldQueued.n;

  const { rows: queue } = await pool.query(
    `SELECT id FROM candidate_resume_purges
      WHERE status IN ('pending', 'failed') AND attempts < $1
        AND ($2::int IS NULL OR company_id = $2::int)
        AND NOT ${HELD}
      ORDER BY id LIMIT $3`,
    [MAX_ATTEMPTS, companyId, limit]);
  if (!queue.length) {
    out.failed_permanently = await countStuck(companyId);
    return out;
  }

  // One reference scan for every local file in the queue. It runs AFTER the
  // anonymisations committed, so their own columns are already NULL; two queued
  // sharers of one file therefore see no reference and the file goes once.
  const { rows: refsQueued } = await pool.query(
    `SELECT file_ref FROM candidate_resume_purges WHERE id = ANY($1::int[])`, [queue.map(q => q.id)]);
  const localNames = [...new Set(refsQueued
    .map(r => classifyRef(r.file_ref, uploadDir))
    .filter(r => r.kind === 'local').map(r => r.name))];
  const references = await findFileReferences(pool, localNames);

  for (const { id } of queue) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [row] } = await client.query(
        `SELECT * FROM candidate_resume_purges
          WHERE id = $1 AND status IN ('pending', 'failed') AND attempts < $2
          FOR UPDATE SKIP LOCKED`, [id, MAX_ATTEMPTS]);
      if (!row) { await client.query('ROLLBACK'); continue; }
      // A hold placed since the queue was read: leave the row pending.
      const { rows: [hold] } = await client.query(
        `SELECT legal_hold FROM candidates WHERE id = $1 FOR SHARE`, [row.candidate_id]);
      if (hold?.legal_hold) { await client.query('ROLLBACK'); out.held += 1; continue; }
      out.processed += 1;

      const set = async (status, { error = null, referencedBy = null, done = true } = {}) => {
        await client.query(
          `UPDATE candidate_resume_purges
              SET status = $2, attempts = attempts + 1, last_error = $3, referenced_by = $4,
                  updated_at = NOW(), completed_at = CASE WHEN $5::boolean THEN NOW() ELSE NULL END
            WHERE id = $1`,
          [row.id, status, error, referencedBy, done]);
        out[status] += 1;
      };

      const ref = classifyRef(row.file_ref, uploadDir);
      if (ref.kind === 'external') {
        await set('skipped_external');
      } else if (ref.kind === 'unsafe') {
        await set('unsafe_path', { error: ref.why });
      } else {
        const where = references.get(ref.name) || [];
        if (where.length) {
          await set('retained_shared', { referencedBy: where.join(', ') });
        } else {
          const abs = path.join(path.resolve(uploadDir), ref.name);
          let stat = null;
          try { stat = await fs.lstat(abs); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          if (!stat) {
            await set('already_absent');
          } else if (!stat.isFile()) {
            await set('unsafe_path', { error: 'not a regular file (symlink or directory)' });
          } else {
            let error = null;
            try { await unlink(abs); } catch (e) { error = `${e.code || 'ERROR'}: ${e.message}`; }
            let stillThere = false;
            try { await fs.lstat(abs); stillThere = true; } catch { /* gone */ }
            if (stillThere) {
              await set('failed', { error: error || 'file still present after unlink', done: false });
            } else {
              await set('deleted');
            }
          }
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'ERROR',
        event: 'candidate_resume_purge_failed', purgeId: id, message: err.message }));
      out.failed += 1;
    } finally {
      client.release();
    }
  }

  out.failed_permanently = await countStuck(companyId);
  return out;
}

/** Exhausted retries — reported on every run until someone acts on them. */
async function countStuck(companyId) {
  const { rows: [stuck] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM candidate_resume_purges
      WHERE status = 'failed' AND attempts >= $1 AND ($2::int IS NULL OR company_id = $2::int)`,
    [MAX_ATTEMPTS, companyId]);
  return stuck.n;
}
