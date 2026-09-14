/**
 * knowledgeWorkflow.service.js
 *
 * The lifecycle of a knowledge article, and the measurement of whether it works.
 *
 * Pure-ish: every function takes the pool. No express types cross this boundary,
 * so the transitions are unit-testable without a request.
 *
 * WHY A STATE MACHINE AND NOT A `status` COLUMN
 * ---------------------------------------------
 * A free `status` column is what this codebase already had in a dozen places,
 * and the audit kept finding the same two failures: a status nothing validates
 * (so a typo becomes a state), and a status nothing enforces order on (so an
 * article goes straight from draft to published without ever being read by a
 * second person). Both matter more here than usual, because a published article
 * with `visibility='public'` is a statement the business makes to its customers.
 */

/**
 * Legal transitions. Anything not listed is refused.
 *
 * `rejected` returns to the author's court — it is a draft with a reason
 * attached, not a dead end, so it can be resubmitted.
 * `archived` is reachable from published and from approved-but-never-published,
 * and can be revived to draft; nothing is ever deleted, because an article that
 * was public is part of what the business said and when.
 */
export const TRANSITIONS = {
  draft:     ['in_review', 'archived'],
  in_review: ['approved', 'rejected', 'draft'],
  approved:  ['published', 'draft', 'archived'],
  published: ['archived', 'draft'],
  rejected:  ['draft', 'in_review', 'archived'],
  archived:  ['draft'],
};

/** Transitions only these roles may perform. Everything else follows the module permission. */
export const TRANSITION_ROLES = {
  approved:  ['super_admin', 'admin', 'service_manager', 'quality_manager'],
  rejected:  ['super_admin', 'admin', 'service_manager', 'quality_manager'],
  published: ['super_admin', 'admin', 'service_manager'],
};

export function canTransition(from, to) {
  return Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

/**
 * An author may not approve their own article.
 *
 * Without this the approval step is theatre: the whole point of a review gate is
 * that a second person read it. Enforced on the transition rather than in the UI,
 * because the UI is not where authorization lives.
 */
export function isSelfApproval(article, actorEmployeeId) {
  if (!actorEmployeeId) return false;
  const submitter = article.submitted_by ?? article.author_id;
  return String(submitter) === String(actorEmployeeId);
}

const toTags = (tags) =>
  typeof tags === 'string' ? tags.split(',').map(t => t.trim()).filter(Boolean)
  : Array.isArray(tags) ? tags
  : [];

/**
 * Snapshot the article as it stands BEFORE a change, into the version history.
 *
 * Called inside the same transaction as the update, so history and article can
 * never disagree. Returns the version number written.
 */
export async function snapshotVersion(client, article, { changedBy = null, note = null } = {}) {
  await client.query(
    `INSERT INTO knowledge_article_versions
       (article_id, company_id, version, title, summary, content, category, tags,
        visibility, status, changed_by, change_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (article_id, version) DO NOTHING`,
    [article.id, article.company_id, article.version, article.title, article.summary ?? null,
     article.content ?? null, article.category ?? null,
     Array.isArray(article.tags) ? article.tags.join(',') : (article.tags ?? null),
     article.visibility, article.status, changedBy, note]
  );
  return article.version;
}

/**
 * Edit an article's content. Bumps the version and keeps the previous text.
 *
 * Editing a PUBLISHED article returns it to draft. A live customer-facing answer
 * must not change under the reader without passing the review that put it there;
 * the published version stays published until the edit is re-approved... except
 * that this table holds one row per article, so "stays published" means the
 * previous text remains readable in the version history and the article leaves
 * the published set. That is the honest behaviour for a single-row model, and it
 * is why `unpublishedOnEdit` is returned rather than hidden — the caller has to
 * be able to tell the author what just happened.
 */
export async function editArticle(pool, { id, companyId, patch, employeeId, note }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [article] } = await client.query(
      `SELECT * FROM service_knowledge_base
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) FOR UPDATE`,
      [id, companyId]
    );
    if (!article) { await client.query('ROLLBACK'); return { error: 'not_found' }; }

    await snapshotVersion(client, article, { changedBy: employeeId, note });

    const unpublishedOnEdit = article.status === 'published';
    const next = {
      title:      patch.title      ?? article.title,
      summary:    patch.summary    ?? article.summary,
      content:    patch.content    ?? article.content,
      category:   patch.category   ?? article.category,
      tags:       patch.tags !== undefined ? toTags(patch.tags) : article.tags,
      visibility: patch.visibility ?? article.visibility,
    };

    const { rows: [updated] } = await client.query(
      `UPDATE service_knowledge_base
          SET title=$1, summary=$2, content=$3, category=$4, tags=$5, visibility=$6,
              version = version + 1,
              status  = CASE WHEN status = 'published' THEN 'draft' ELSE status END,
              published_at = CASE WHEN status = 'published' THEN NULL ELSE published_at END,
              updated_at = NOW()
        WHERE id = $7
        RETURNING *`,
      [next.title, next.summary, next.content, next.category, next.tags, next.visibility, id]
    );
    await client.query('COMMIT');
    return { article: updated, unpublishedOnEdit, previousVersion: article.version };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Move an article through the lifecycle.
 *
 * Refuses illegal transitions, self-approval, and publishing an article that was
 * never approved. Every refusal is a distinct code so the caller can say WHY
 * rather than "not allowed".
 */
export async function transition(pool, { id, companyId, to, employeeId, roles = [], reason }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [article] } = await client.query(
      `SELECT * FROM service_knowledge_base
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) FOR UPDATE`,
      [id, companyId]
    );
    if (!article) { await client.query('ROLLBACK'); return { error: 'not_found' }; }

    if (!canTransition(article.status, to)) {
      await client.query('ROLLBACK');
      return { error: 'illegal_transition', from: article.status, to,
               allowed: TRANSITIONS[article.status] || [] };
    }

    const needed = TRANSITION_ROLES[to];
    if (needed && !roles.some(r => needed.includes(String(r).toLowerCase()))) {
      await client.query('ROLLBACK');
      return { error: 'role_required', to, roles: needed };
    }

    if ((to === 'approved' || to === 'published') && isSelfApproval(article, employeeId)) {
      await client.query('ROLLBACK');
      return { error: 'self_approval' };
    }

    // Reaching `published` requires having passed through `approved` — the
    // transition table permits published only from approved, so this holds by
    // construction; the explicit check documents it and survives a table edit.
    if (to === 'published' && article.status !== 'approved') {
      await client.query('ROLLBACK');
      return { error: 'not_approved' };
    }

    await snapshotVersion(client, article, { changedBy: employeeId, note: `→ ${to}` });

    const sets = ['status = $1', 'updated_at = NOW()'];
    const params = [to];
    const push = (frag, val) => { params.push(val); sets.push(frag.replace('?', `$${params.length}`)); };

    if (to === 'in_review') { push('submitted_by = ?', employeeId); sets.push('submitted_at = NOW()'); }
    if (to === 'approved')  { push('approved_by = ?', employeeId);  sets.push('approved_at = NOW()', 'rejected_reason = NULL'); }
    if (to === 'rejected')  { push('rejected_reason = ?', reason || null); sets.push('approved_by = NULL', 'approved_at = NULL'); }
    if (to === 'published') sets.push('published_at = NOW()');
    if (to === 'archived')  sets.push('archived_at = NOW()');
    if (to === 'draft')     sets.push('archived_at = NULL');

    params.push(id);
    const { rows: [updated] } = await client.query(
      `UPDATE service_knowledge_base SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    await client.query('COMMIT');
    return { article: updated, from: article.status, to };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The SQL predicate deciding which articles a caller may see.
 *
 * ⚠ Visibility here is TWO independent questions and they are easy to conflate:
 *   - `visibility` = who the article is FOR (internal staff vs customers);
 *   - `status`     = whether it is finished.
 * A portal reader gets published AND public. Staff get everything in their
 * company, because an unpublished draft is exactly what a colleague needs to
 * find before writing the same article again.
 */
export function readScope({ isStaff }) {
  return isStaff
    ? { clause: 'TRUE', params: [] }
    : { clause: `status = 'published' AND visibility = 'public'`, params: [] };
}

/**
 * Record a view / helpful / not-helpful event.
 *
 * Writes BOTH the per-event row and the counter on the article. The counters
 * predate this and something may read them; the rows are what make "is this
 * article getting worse" answerable, which a counter never can.
 */
export async function recordFeedback(pool, { articleId, companyId, event, reason, employeeId, ticketId }) {
  const column = { view: 'views', helpful: 'helpful_yes', not_helpful: 'helpful_no' }[event];
  if (!column) return { error: 'bad_event' };

  const { rows: [article] } = await pool.query(
    `SELECT id, company_id FROM service_knowledge_base
      WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
    [articleId, companyId]
  );
  if (!article) return { error: 'not_found' };

  await pool.query(
    `INSERT INTO knowledge_article_feedback
       (article_id, company_id, event, reason, employee_id, ticket_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [articleId, article.company_id, event, reason || null, employeeId || null, ticketId || null]
  );

  const { rows: [updated] } = await pool.query(
    `UPDATE service_knowledge_base
        SET ${column} = COALESCE(${column}, 0) + 1,
            not_helpful_reasons = CASE WHEN $2::text IS NULL THEN not_helpful_reasons
              ELSE (COALESCE(not_helpful_reasons,'[]'::jsonb)
                    || jsonb_build_array(jsonb_build_object('reason', $2::text, 'at', NOW()))) END
      WHERE id = $1
      RETURNING id, views, helpful_yes, helpful_no`,
    [articleId, event === 'not_helpful' ? (reason || null) : null]
  );
  return { article: updated };
}

/**
 * Effectiveness, per article.
 *
 * ⚠ An article with no feedback is UNMEASURED, not 0% helpful. The two look
 * identical in a naive `helpful_yes / (helpful_yes + helpful_no)` — which
 * divides by zero — and treating unmeasured as zero is the mistake that has
 * shown up repeatedly in this codebase (supplier on_time_pct, defect_rate).
 * `helpful_pct` is NULL when nothing has been rated, and the caller must render
 * that as "—", never as 0.
 */
export async function effectiveness(pool, { companyId, days = 90, limit = 50 }) {
  const { rows } = await pool.query(
    `WITH recent AS (
       SELECT article_id,
              COUNT(*) FILTER (WHERE event = 'view')::int        AS views_window,
              COUNT(*) FILTER (WHERE event = 'helpful')::int     AS yes_window,
              COUNT(*) FILTER (WHERE event = 'not_helpful')::int AS no_window
         FROM knowledge_article_feedback
        WHERE ($1::int IS NULL OR company_id = $1)
          AND created_at >= NOW() - ($2 || ' days')::interval
        GROUP BY article_id
     ),
     cases AS (
       SELECT article_id,
              COUNT(*)::int                                  AS cases_linked,
              COUNT(*) FILTER (WHERE resolved_it)::int        AS cases_resolved
         FROM knowledge_article_cases
        WHERE ($1::int IS NULL OR company_id = $1)
        GROUP BY article_id
     )
     SELECT a.id, a.title, a.category, a.status, a.visibility, a.version,
            a.views, a.helpful_yes, a.helpful_no, a.published_at, a.review_due_date,
            COALESCE(r.views_window, 0) AS views_window,
            COALESCE(r.yes_window,   0) AS yes_window,
            COALESCE(r.no_window,    0) AS no_window,
            COALESCE(c.cases_linked,   0) AS cases_linked,
            COALESCE(c.cases_resolved, 0) AS cases_resolved,
            CASE WHEN COALESCE(a.helpful_yes,0) + COALESCE(a.helpful_no,0) = 0 THEN NULL
                 ELSE ROUND(100.0 * a.helpful_yes / (a.helpful_yes + a.helpful_no), 1)
            END AS helpful_pct,
            (COALESCE(a.helpful_yes,0) + COALESCE(a.helpful_no,0)) AS ratings_total,
            (a.review_due_date IS NOT NULL AND a.review_due_date < CURRENT_DATE) AS review_overdue
       FROM service_knowledge_base a
       LEFT JOIN recent r ON r.article_id = a.id
       LEFT JOIN cases  c ON c.article_id = a.id
      WHERE ($1::int IS NULL OR a.company_id = $1)
        AND a.status <> 'archived'
      ORDER BY COALESCE(r.views_window, 0) DESC, a.views DESC NULLS LAST
      LIMIT $3`,
    [companyId, String(days), limit]
  );

  // pg returns numeric as a string; a percentage that arrives as "66.7" turns
  // every arithmetic use into string concatenation further up.
  return rows.map(r => ({
    ...r,
    helpful_pct: r.helpful_pct === null ? null : Number(r.helpful_pct),
    measured: Number(r.ratings_total) > 0,
  }));
}

/** Roll-up for the workspace header. Counts by state, plus what needs attention. */
export async function summary(pool, { companyId }) {
  const { rows: [row] } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'draft')::int      AS draft,
       COUNT(*) FILTER (WHERE status = 'in_review')::int  AS in_review,
       COUNT(*) FILTER (WHERE status = 'approved')::int   AS approved,
       COUNT(*) FILTER (WHERE status = 'published')::int  AS published,
       COUNT(*) FILTER (WHERE status = 'rejected')::int   AS rejected,
       COUNT(*) FILTER (WHERE status = 'archived')::int   AS archived,
       COUNT(*) FILTER (WHERE status = 'published' AND visibility = 'public')::int AS public_live,
       COUNT(*) FILTER (WHERE review_due_date IS NOT NULL
                          AND review_due_date < CURRENT_DATE
                          AND status <> 'archived')::int  AS review_overdue,
       COUNT(*)::int AS total
     FROM service_knowledge_base
     WHERE ($1::int IS NULL OR company_id = $1)`,
    [companyId]
  );
  return row;
}
