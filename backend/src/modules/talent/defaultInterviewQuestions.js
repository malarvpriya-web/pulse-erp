/**
 * The default interview-question bank a company starts with.
 *
 * Seeded ON FIRST USE, per company — not at module load (2026-10-20).
 *
 * It used to run inside talent.routes.js's import-time DDL block: every boot of
 * the server (and every process that imported the router) gave EVERY active
 * company with no questions these ten rows. Two consequences:
 *   · a company created after boot had an empty bank until the next restart;
 *   · a nodemon restart during an integration run seeded that run's transient
 *     test companies, whose cleanup then failed on the FK and stranded them
 *     (internConversionWorkflow, 2026-10-19 — every later run failed in setup).
 * No company-id range or naming rule is needed to avoid the second: a company
 * is seeded only when someone actually reads its bank.
 *
 * Rule (unchanged from the boot seeder): an ACTIVE company with no
 * interview_questions rows at all — active or not — gets the ten defaults. A
 * bank HR has emptied by deactivating questions is never refilled.
 */
import pool from '../../config/db.js';

export const DEFAULT_INTERVIEW_QUESTIONS = Object.freeze([
  ['Tell me about yourself and your career journey.',       'HR',           'easy'],
  ['Why do you want to join our company?',                  'HR',           'easy'],
  ['Describe a challenging project you worked on.',         'Behavioural',  'medium'],
  ['How do you handle conflicting priorities?',             'Situational',  'medium'],
  ['Where do you see yourself in 5 years?',                 'HR',           'easy'],
  ['What is your current notice period and expected CTC?',  'HR',           'easy'],
  ['Explain a time you disagreed with your manager.',       'Behavioural',  'hard'],
  ['How do you keep your skills updated?',                  'Cultural Fit', 'easy'],
  ['Describe your ideal work environment.',                 'Cultural Fit', 'medium'],
  ['What motivates you in your work?',                      'HR',           'easy'],
]);

// pg_advisory_xact_lock(int4, int4) namespace for this seed; the second key is
// the company id, so two companies never wait on each other.
const LOCK_NAMESPACE = 470421;

/**
 * Give `companyId` the default bank if it has none. Idempotent and safe under
 * concurrency (one transaction-scoped advisory lock per company).
 * Returns the number of rows inserted (0 or 10). `null`/`undefined` company —
 * a global super-admin view — is never seeded.
 */
export async function ensureDefaultInterviewQuestions(companyId, db = pool) {
  if (companyId == null) return 0;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [LOCK_NAMESPACE, companyId]);
    const { rows: [state] } = await client.query(
      `SELECT EXISTS (SELECT 1 FROM companies WHERE id = $1::int AND is_active = true) AS active,
              EXISTS (SELECT 1 FROM interview_questions WHERE company_id = $1::int) AS has_any`,
      [companyId]
    );
    if (!state.active || state.has_any) { await client.query('COMMIT'); return 0; }
    const values = DEFAULT_INTERVIEW_QUESTIONS.map((_, i) => `($1::int, $${i * 3 + 2}, $${i * 3 + 3}, $${i * 3 + 4}, true)`);
    const params = [companyId, ...DEFAULT_INTERVIEW_QUESTIONS.flat()];
    const { rowCount } = await client.query(
      `INSERT INTO interview_questions (company_id, question, category, difficulty, is_active)
       VALUES ${values.join(', ')}`, params);
    await client.query('COMMIT');
    return rowCount;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
