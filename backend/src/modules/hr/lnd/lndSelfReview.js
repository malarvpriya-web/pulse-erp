/**
 * Before / after self-review (2026-11-18).
 *
 * Each participant rates themselves 1–5 before the training ('pre') and again
 * after it ('post'): knowledge of the topic, confidence applying it at work,
 * and each statement the training lists (self_review_items). The pair gives
 * the before / after comparison per person, per training and in the report.
 *
 *   pre   while enrolled / in progress, until the after-review is in
 *   post  once the enrolment is completed (or the training is closed and the
 *         person attended — status in_progress)
 */
import { httpError, strOrNull, intOrNull, EMP_NAME } from './lndShared.js';

export const DEFAULT_ITEMS = [];   // knowledge + confidence are always asked
export const MAX_ITEMS = 10;

export function cleanItems(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw httpError(400, 'Self-review statements must be a list');
  const items = [...new Set(list.map(s => String(s ?? '').trim()).filter(Boolean))];
  if (items.length > MAX_ITEMS) throw httpError(400, `Up to ${MAX_ITEMS} self-review statements`);
  if (items.some(s => s.length > 200)) throw httpError(400, 'A self-review statement is too long (200 characters)');
  return items;
}

/** Which phase an enrolment may submit now: 'pre', 'post' or null. */
export function openPhase(en, program, reviews) {
  if (!program.self_review_enabled) return null;
  const has = (p) => reviews.some(r => r.phase === p);
  if (['withdrawn', 'no_show'].includes(en.status) || program.status === 'cancelled') return null;
  if (en.status === 'completed' || (program.status === 'completed' && en.status === 'in_progress')) return has('post') ? null : 'post';
  return has('post') ? null : 'pre';
}

export function validateReview(body, items) {
  const knowledge = intOrNull(body.knowledge);
  const confidence = intOrNull(body.confidence);
  if (!knowledge || knowledge < 1 || knowledge > 5) throw httpError(400, 'Rate your knowledge from 1 to 5');
  if (!confidence || confidence < 1 || confidence > 5) throw httpError(400, 'Rate your confidence from 1 to 5');
  const given = body.item_ratings && typeof body.item_ratings === 'object' ? body.item_ratings : {};
  const item_ratings = {};
  for (const it of items) {
    const v = intOrNull(given[it]);
    if (!v || v < 1 || v > 5) throw httpError(400, `Rate “${it}” from 1 to 5`);
    item_ratings[it] = v;
  }
  const comments = strOrNull(body.comments);
  if (comments && comments.length > 2000) throw httpError(400, 'Comments are too long');
  return { knowledge, confidence, item_ratings, comments };
}

const avg = (xs) => (xs.length ? Math.round(10 * xs.reduce((a, b) => a + b, 0) / xs.length) / 10 : null);
const diff = (a, b) => (a == null || b == null ? null : Math.round(10 * (b - a)) / 10);

/** Per-person before / after and the averages for one training. */
export async function programSelfReviews(db, program) {
  const { rows } = await db.query(
    `SELECT te.id AS enrollment_id, te.employee_id, ${EMP_NAME} AS employee_name, e.department, te.status,
            pre.knowledge AS pre_knowledge, pre.confidence AS pre_confidence, pre.item_ratings AS pre_items, pre.comments AS pre_comments, pre.submitted_at AS pre_at,
            post.knowledge AS post_knowledge, post.confidence AS post_confidence, post.item_ratings AS post_items, post.comments AS post_comments, post.submitted_at AS post_at
       FROM training_enrollments te JOIN employees e ON e.id = te.employee_id
       LEFT JOIN training_self_reviews pre ON pre.enrollment_id = te.id AND pre.phase = 'pre'
       LEFT JOIN training_self_reviews post ON post.enrollment_id = te.id AND post.phase = 'post'
      WHERE te.program_id = $1 AND te.status <> 'withdrawn' ORDER BY 3`, [program.id]);
  const items = Array.isArray(program.self_review_items) ? program.self_review_items : [];
  const people = rows.map(r => ({
    ...r,
    knowledge_change: diff(r.pre_knowledge, r.post_knowledge),
    confidence_change: diff(r.pre_confidence, r.post_confidence),
  }));
  const both = people.filter(p => p.pre_knowledge != null && p.post_knowledge != null);
  const summary = {
    enrolled: people.length,
    pre_done: people.filter(p => p.pre_knowledge != null).length,
    post_done: people.filter(p => p.post_knowledge != null).length,
    both_done: both.length,
    knowledge: { before: avg(both.map(p => p.pre_knowledge)), after: avg(both.map(p => p.post_knowledge)) },
    confidence: { before: avg(both.map(p => p.pre_confidence)), after: avg(both.map(p => p.post_confidence)) },
    items: items.map(it => {
      const b = both.map(p => p.pre_items?.[it]).filter(Number.isFinite);
      const a = both.map(p => p.post_items?.[it]).filter(Number.isFinite);
      return { item: it, before: avg(b), after: avg(a), change: diff(avg(b), avg(a)) };
    }),
  };
  // Average of each person's own change — the same figure the report shows.
  summary.knowledge.change = avg(both.map(p => p.knowledge_change));
  summary.confidence.change = avg(both.map(p => p.confidence_change));
  return { enabled: program.self_review_enabled, items, people, summary };
}
