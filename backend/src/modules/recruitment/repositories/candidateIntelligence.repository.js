/**
 * candidateIntelligence.repository.js
 *
 * The SQL for everything the Recruitment redesign added: the activity timeline,
 * recruiter notes, Stage-1 screening, role suitability, Future Opportunity
 * recontacts, the Talent Bank, similar-candidate search, bulk actions and the
 * recruiter work queue.
 *
 * A separate file from recruitment.repository.js on purpose. That one is 2124
 * lines and every line of it is load-bearing for screens that work today; adding
 * another eight hundred to it would make the redesign unreviewable and would put
 * new code in the same blast radius as the pipeline board. Nothing here rewrites
 * anything there — the two are composed at the route layer.
 *
 * ── CONVENTIONS THIS FILE FOLLOWS ───────────────────────────────────────────
 * • company_id is a parameter on every function and every WHERE clause. It comes
 *   from companyOf(req) at the route, never from the body. `($n::int IS NULL OR
 *   x.company_id = $n)` is the house predicate, and null means a genuine global
 *   scope (super admin), not "unfiltered by accident".
 * • Functions that mutate take a `ctx` of { company_id, actor_user_id,
 *   actor_name } and write BOTH the row and its activity event. A mutation that
 *   does not appear on the timeline is a mutation the recruiter cannot account
 *   for later, which is what §21 and §34 are about.
 * • Every transaction passes its `client` down. Asking the pool for a second
 *   connection while holding one is how this codebase produced a bare 500 after
 *   a four-second stall that read like a flake — under concurrency the pool
 *   (max 6) is exhausted by handlers waiting on themselves.
 */

import pool from '../../shared/db.js';

// ── §14's scorecard ─────────────────────────────────────────────────────────
/**
 * The 100-point weighting, verbatim from §14.
 *
 * Adaptability is rated (§12 lists it) but carries NO weight, because §14's
 * table does not include it. That is not an oversight being papered over: the
 * rating is recorded and shown, it simply does not move the number. Inventing a
 * weight for it would mean the score printed on screen is not the score the
 * brief specifies.
 */
export const SCORE_WEIGHTS = {
  eligibility:       10,
  relevant_knowledge: 15,
  learning_mindset:   15,
  problem_solving:    15,
  ownership:          10,
  teamwork:           10,
  patience:           10,
  communication:       5,
  career_alignment:    5,
  location_alignment:  5,
};

// A 1-5 rating, as a fraction of its section weight. Null = not rated, which
// contributes nothing AND counts nothing towards the assessed weight, so a
// half-finished screening reports "31 / 100, 55 points assessed" rather than
// looking like a candidate who scored 31 out of a full assessment.
const ratingFraction = (r) => (r == null ? null : Math.max(0, Math.min(5, Number(r))) / 5);

// §11's four eligibility verdicts, each worth a quarter of the 10 points.
// 'partial' is worth half — a candidate who partially meets the requirement has
// not failed it, and scoring it zero would make "partially meets" and "does not
// meet" the same answer, which is the drift this codebase keeps finding.
const FIT_FRACTION = { meets: 1, partial: 0.5, does_not_meet: 0, not_assessed: null };

const NOTICE_FRACTION = {
  acceptable: 1, needs_discussion: 0.5, not_acceptable: 0, not_assessed: null,
};

// §11's location verdicts mapped onto §14's "Location / Role Alignment 5".
// relocation_possible scores the same as regional: both mean the candidate can
// be at Durganagar, which is the only thing this section is asking.
const LOCATION_FRACTION = {
  local: 1,
  regional: 0.8,
  relocation_possible: 0.8,
  relocation_support_required: 0.6,
  not_willing: 0,
  not_assessed: null,
};

/**
 * Score a screening. Pure — no database, no clock — so it is directly testable
 * and so the same arithmetic runs on the server and in the API response rather
 * than being re-implemented in the browser.
 *
 * @returns {{ total: number, assessed_weight: number, breakdown: object }}
 */
export function computeScreeningScore(s = {}) {
  const breakdown = {};
  let total = 0;
  let assessed = 0;

  const section = (key, fraction) => {
    const weight = SCORE_WEIGHTS[key];
    if (fraction == null) {
      breakdown[key] = { weight, scored: null, assessed: false };
      return;
    }
    const scored = Math.round(weight * fraction * 10) / 10;
    breakdown[key] = { weight, scored, assessed: true };
    total    += scored;
    assessed += weight;
  };

  // Basic eligibility — the average of the four verdicts that have been given.
  // Averaging only the ANSWERED ones matters: if a recruiter has judged
  // qualification and experience but not skills or notice period, the section
  // reports what they did judge instead of silently halving it.
  const fits = [
    FIT_FRACTION[s.qualification_fit] ?? null,
    FIT_FRACTION[s.experience_fit]    ?? null,
    FIT_FRACTION[s.skills_fit]        ?? null,
    NOTICE_FRACTION[s.notice_fit]     ?? null,
  ].filter(v => v != null);
  section('eligibility', fits.length ? fits.reduce((a, b) => a + b, 0) / fits.length : null);

  section('relevant_knowledge', ratingFraction(s.relevant_knowledge));
  section('learning_mindset',   ratingFraction(s.learning_mindset));
  section('problem_solving',    ratingFraction(s.problem_solving));
  section('ownership',          ratingFraction(s.ownership));
  section('teamwork',           ratingFraction(s.teamwork));
  section('patience',           ratingFraction(s.patience));
  section('communication',      ratingFraction(s.communication));
  section('career_alignment',   ratingFraction(s.career_alignment));
  section('location_alignment', LOCATION_FRACTION[s.location_fit] ?? null);

  return {
    total: Math.round(total),
    assessed_weight: assessed,
    breakdown,
  };
}

/**
 * What the score suggests. §14: "The score is decision support" and "Do NOT make
 * the system automatically reject candidates only because of a numerical score."
 *
 * So this function can return `proceed`, `hold` or `not_suitable_current_role`
 * and NOTHING ELSE. `reject_from_manifest` is never recommended by arithmetic —
 * rejecting a person from the company is a human act that §15 requires a reason
 * for. The recruiter can always choose it; the machine never proposes it.
 *
 * Returns null when too little has been assessed to have an opinion, rather than
 * treating an empty screening as a low-scoring one.
 */
export function recommendationFor({ total, assessed_weight }) {
  if (!assessed_weight || assessed_weight < 50) return null;
  // Normalised to the part actually assessed, so a screening that skipped
  // sections is not penalised for the skipping.
  const pct = (total / assessed_weight) * 100;
  if (pct >= 70) return 'proceed';
  if (pct >= 50) return 'hold';
  return 'not_suitable_current_role';
}

// ── Activity timeline ───────────────────────────────────────────────────────

const repo = {
  /**
   * Append one event to a candidate's timeline, and stamp
   * candidates.last_activity_at in the same statement pair.
   *
   * Those two things are one operation and must not drift apart: the work queue
   * reads last_activity_at to answer "waiting more than 3 days", and before this
   * column existed it measured from created_at while its own comment claimed
   * otherwise (a candidate moved yesterday reported 30 days waiting). Any future
   * mutation that records an event therefore also refreshes the clock, without
   * the caller having to remember.
   *
   * `client` is optional and is passed when the caller already holds a
   * transaction — never acquire a second connection here.
   */
  async recordActivity(event, client = null) {
    const q = client || pool;
    const {
      company_id, candidate_id, application_id = null,
      event_type, summary, detail = {},
      actor_user_id = null, actor_name = null,
    } = event;

    if (!candidate_id || !event_type || !summary) return null;

    // candidate_activity.company_id is NOT NULL, but a super admin operating in a
    // global scope has companyOf(req) === null. Resolving it from the candidate
    // rather than refusing the write is the right way round: the alternative is
    // that an admin's actions are the ones missing from the audit trail.
    let cid = company_id;
    if (cid == null) {
      const { rows: owner } = await q.query(`SELECT company_id FROM candidates WHERE id = $1`, [candidate_id]);
      cid = owner[0]?.company_id ?? null;
      if (cid == null) return null;
    }

    const { rows } = await q.query(
      `INSERT INTO candidate_activity
         (company_id, candidate_id, application_id, event_type, summary, detail,
          actor_user_id, actor_name)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING *`,
      [cid, candidate_id, application_id, event_type, summary,
       JSON.stringify(detail || {}), actor_user_id, actor_name]
    );

    await q.query(
      `UPDATE candidates SET last_activity_at = NOW() WHERE id = $1`,
      [candidate_id]
    );

    return rows[0];
  },

  /**
   * The timeline, newest first, with stage moves folded in.
   *
   * candidate_stage_history predates candidate_activity and holds real history
   * that would otherwise be invisible on the new timeline, so it is UNIONed in
   * rather than migrated: migrating it would mean rewriting rows whose actor
   * column points at `employees` while the new table's points at `users`, and a
   * best-effort identity remap across two identity tables is exactly the kind of
   * silent data change an audit trail must not contain. Old rows are labelled
   * `stage_change` and carry the actor name the history itself recorded.
   */
  async listActivity(candidate_id, company_id = null, { limit = 200 } = {}) {
    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT a.id::text AS id, 'activity' AS row_source,
                a.event_type, a.summary, a.detail,
                a.actor_user_id, a.actor_name, a.application_id, a.created_at
           FROM candidate_activity a
          WHERE a.candidate_id = $1
            AND ($2::int IS NULL OR a.company_id = $2)

         UNION ALL

         SELECT 'h' || h.id::text AS id, 'stage_history' AS row_source,
                'stage_change' AS event_type,
                'Stage set to ' || REPLACE(h.stage, '_', ' ') AS summary,
                jsonb_build_object('stage', h.stage, 'notes', h.notes) AS detail,
                h.moved_by_user_id AS actor_user_id,
                COALESCE(e.name, u.email) AS actor_name,
                NULL::int AS application_id,
                h.moved_date AS created_at
           FROM candidate_stage_history h
           LEFT JOIN employees e ON e.id = h.moved_by
           LEFT JOIN users     u ON u.id = h.moved_by_user_id
          WHERE h.candidate_id = $1
            AND ($2::int IS NULL OR h.company_id IS NULL OR h.company_id = $2)
            -- Stage moves made through the new code path already wrote a
            -- candidate_activity row. Excluding those avoids every recent move
            -- appearing twice on the timeline.
            AND NOT EXISTS (
              SELECT 1 FROM candidate_activity a2
               WHERE a2.candidate_id = h.candidate_id
                 AND a2.event_type   = 'stage_change'
                 AND a2.created_at BETWEEN h.moved_date - INTERVAL '2 seconds'
                                       AND h.moved_date + INTERVAL '2 seconds'
            )
       ) t
       ORDER BY t.created_at DESC
       LIMIT $3`,
      [candidate_id, company_id, Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500)]
    );
    return rows;
  },

  // ── Notes (§9) ────────────────────────────────────────────────────────────

  /**
   * Notes for a candidate, pinned first.
   *
   * `viewer_user_id` is required rather than optional: a 'private' note is
   * visible only to its author, and a function that could be called without a
   * viewer would default to showing them to everybody. Callers that genuinely
   * have no viewer (a cron) pass null and see no private notes, which is the
   * safe direction.
   */
  async listNotes(candidate_id, company_id = null, { viewer_user_id = null } = {}) {
    const { rows } = await pool.query(
      `SELECT n.*,
              COALESCE(e.name, u.email) AS author_name,
              ca.job_opening_id,
              jo.job_title AS application_job_title
         FROM candidate_notes n
         LEFT JOIN users u  ON u.id  = n.author_user_id
         LEFT JOIN employees e ON e.id = u.employee_id
         LEFT JOIN candidate_applications ca ON ca.id = n.application_id
         LEFT JOIN job_openings jo ON jo.id = ca.job_opening_id
        WHERE n.candidate_id = $1
          AND n.deleted_at IS NULL
          AND ($2::int IS NULL OR n.company_id = $2)
          AND (n.visibility <> 'private' OR n.author_user_id = $3::int)
        ORDER BY n.is_pinned DESC, n.created_at DESC`,
      [candidate_id, company_id, viewer_user_id]
    );
    return rows;
  },

  async createNote(data, ctx = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `INSERT INTO candidate_notes
           (company_id, candidate_id, application_id, note_type, body, visibility,
            is_pinned, author_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          ctx.company_id, data.candidate_id, data.application_id || null,
          data.note_type || 'recruiter', String(data.body || '').trim(),
          data.visibility || 'internal',
          data.is_pinned === true || data.is_pinned === 'true',
          ctx.actor_user_id || null,
        ]
      );
      const note = rows[0];

      await repo.recordActivity({
        company_id: ctx.company_id,
        candidate_id: data.candidate_id,
        application_id: data.application_id || null,
        event_type: 'note_added',
        // The note TYPE goes in the summary but the body does not: a private note
        // must not be legible to somebody who can read the timeline but not the
        // note. detail carries the id so the UI can link to it and re-check
        // visibility when it does.
        summary: `${note.note_type.replace(/^./, c => c.toUpperCase())} note added`,
        detail: { note_id: note.id, note_type: note.note_type, visibility: note.visibility },
        actor_user_id: ctx.actor_user_id || null,
        actor_name: ctx.actor_name || null,
      }, client);

      await client.query('COMMIT');
      return note;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  },

  /**
   * Edit a note. Only the author may change the text; anybody with edit rights
   * may pin or unpin one, because pinning is a statement about which note
   * matters to the TEAM, not about what the note says.
   *
   * @returns the updated row, or null when the note does not exist in this
   *          company — the caller turns that into a 404, never a silent no-op.
   */
  async updateNote(id, data, ctx = {}) {
    const { rows: existing } = await pool.query(
      `SELECT * FROM candidate_notes
        WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
      [id, ctx.company_id]
    );
    if (!existing.length) return null;
    const note = existing[0];

    const wantsTextChange = data.body != null && String(data.body).trim() !== note.body;
    if (wantsTextChange && note.author_user_id && note.author_user_id !== ctx.actor_user_id) {
      const err = new Error('Only the author can change a note’s text. You can still pin it or add your own note.');
      err.status = 403;
      throw err;
    }

    const { rows } = await pool.query(
      `UPDATE candidate_notes
          SET body       = COALESCE($2, body),
              note_type  = COALESCE($3, note_type),
              visibility = COALESCE($4, visibility),
              is_pinned  = COALESCE($5, is_pinned),
              -- Stamped only when the TEXT changed. Pinning is not editing, and
              -- marking a note "edited" because someone pinned it would make the
              -- one signal that says "this wording was changed after the fact"
              -- meaningless.
              edited_at  = CASE WHEN $6::bool THEN NOW() ELSE edited_at END,
              edited_by  = CASE WHEN $6::bool THEN $7::int ELSE edited_by END,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [
        id,
        wantsTextChange ? String(data.body).trim() : null,
        data.note_type || null,
        data.visibility || null,
        data.is_pinned === undefined ? null : (data.is_pinned === true || data.is_pinned === 'true'),
        wantsTextChange,
        ctx.actor_user_id || null,
      ]
    );
    return rows[0];
  },

  /**
   * Soft-delete a note. §34 wants an immutable audit history, and §35's
   * never-throw-away principle applies to the record of a judgement as much as
   * to the candidate: the row stays, the timeline keeps its note_added event, and
   * a deletion event is appended.
   */
  async deleteNote(id, ctx = {}) {
    const { rows } = await pool.query(
      `UPDATE candidate_notes SET deleted_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)
        RETURNING *`,
      [id, ctx.company_id]
    );
    if (!rows.length) return null;
    await repo.recordActivity({
      company_id: ctx.company_id,
      candidate_id: rows[0].candidate_id,
      event_type: 'note_removed',
      summary: `${rows[0].note_type} note removed`,
      detail: { note_id: rows[0].id },
      actor_user_id: ctx.actor_user_id || null,
      actor_name: ctx.actor_name || null,
    });
    return rows[0];
  },

  // ── Screening (§10–§15) ───────────────────────────────────────────────────

  /**
   * The question set for a company: its own overrides, then the platform
   * defaults for any code it has not overridden.
   *
   * DISTINCT ON (code) with company_id NULLS LAST is what picks the company's own
   * wording of Q4 over the seeded one while still returning the other eight.
   */
  async listScreeningQuestions(company_id = null) {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (code) *
         FROM screening_questions
        WHERE is_active = TRUE
          AND (company_id IS NULL OR company_id = $1::int)
        ORDER BY code, company_id NULLS LAST`,
      [company_id]
    );
    // Re-sorted in JS because the DISTINCT ON above dictates the ORDER BY, and
    // sort_order is what the recruiter should see them in.
    return rows.sort((a, b) => (a.sort_order - b.sort_order) || String(a.code).localeCompare(b.code));
  },

  /**
   * The screening for one application (or the speculative one for a candidate
   * with no application), with its responses.
   */
  async getScreening({ candidate_id, application_id = null, company_id = null }) {
    const { rows } = await pool.query(
      `SELECT s.*, COALESCE(e.name, u.email) AS screened_by_name
         FROM candidate_screenings s
         LEFT JOIN users u     ON u.id = s.screened_by
         LEFT JOIN employees e ON e.id = u.employee_id
        WHERE s.candidate_id = $1
          AND ($2::int IS NULL OR s.company_id = $2)
          AND ($3::int IS NULL AND s.application_id IS NULL
               OR s.application_id = $3::int)
        LIMIT 1`,
      [candidate_id, company_id, application_id]
    );
    if (!rows.length) return null;
    const screening = rows[0];

    /**
     * `screening_responses` carries NO company_id, deliberately.
     *
     * Every other table this redesign added has one, and `candidate_stage_history`
     * lacking one was a real finding in the audit. The difference is reachability:
     * that table had its own read endpoint and was genuinely cross-tenant, whereas
     * this one is a pure child of `candidate_screenings` (ON DELETE CASCADE) and is
     * touched in exactly two places — this SELECT, which runs only after the parent
     * screening has been company-scoped, and the INSERT in upsertScreening(), which
     * runs inside a transaction that has already scoped and locked the candidate.
     * There is no path to it that does not pass through a scoped parent.
     *
     * Adding a denormalised tenant column nothing filters on would be the "not yet
     * load-bearing" column this work flagged elsewhere. Noted here so the next
     * schema audit sees the reasoning rather than filing it as a defect.
     */
    const { rows: responses } = await pool.query(
      `SELECT r.*, q.code, q.prompt, q.answer_type, q.options, q.competency, q.sort_order
         FROM screening_responses r
         JOIN screening_questions q ON q.id = r.question_id
        WHERE r.screening_id = $1
        ORDER BY q.sort_order, q.code`,
      [screening.id]
    );
    return { ...screening, responses };
  },

  /**
   * Save a screening, whole or in part. §31 asks for incremental saves, so this
   * is an upsert over every field and the caller may send two of them.
   *
   * COALESCE($n, column) on every field is what makes a partial save partial: an
   * absent field keeps its stored value instead of being nulled. This is the
   * pickUpdatable() principle from shared/safeUpdate.js applied to a fixed column
   * list — a generic spread here would be a mass-assignment hole, since the body
   * would otherwise be able to set total_score or screened_by directly.
   */
  async upsertScreening({ candidate_id, application_id = null, ...data }, ctx = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the candidate row for the duration. Two recruiters saving the same
      // screening concurrently would otherwise both read "no screening exists"
      // and both insert — and the partial unique index would turn the loser's
      // save into a 500 rather than merging it.
      await client.query(`SELECT id FROM candidates WHERE id = $1 FOR UPDATE`, [candidate_id]);

      const { rows: found } = await client.query(
        `SELECT * FROM candidate_screenings
          WHERE candidate_id = $1
            AND ($2::int IS NULL AND application_id IS NULL OR application_id = $2::int)
          LIMIT 1`,
        [candidate_id, application_id]
      );

      let screening = found[0] || null;

      if (!screening) {
        const { rows } = await client.query(
          `INSERT INTO candidate_screenings
             (company_id, candidate_id, application_id, screened_by)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [ctx.company_id, candidate_id, application_id, ctx.actor_user_id || null]
        );
        screening = rows[0];

        await repo.recordActivity({
          company_id: ctx.company_id, candidate_id, application_id,
          event_type: 'screening_started',
          summary: 'Stage 1 screening started',
          detail: { screening_id: screening.id },
          actor_user_id: ctx.actor_user_id || null,
          actor_name: ctx.actor_name || null,
        }, client);
      }

      /**
       * Clearing a field, which COALESCE alone cannot express.
       *
       * Every column below is written as `COALESCE($n, column)` so that an absent
       * field keeps its stored value — that is what makes a partial save partial.
       * The cost is that there is no way to say "set this back to nothing": an
       * empty string is dropped by pickScreeningFields and a null means "unchanged".
       *
       * So the UI could offer un-rating a competency (click the active dot again)
       * and the server would silently ignore it — the recruiter clicks, the dot
       * goes out, and the next save puts it straight back. §12's ratings are
       * optional and NULL means "not yet rated", so clearing has to be a real
       * operation. `clear: ['learning_mindset']` names the fields to null, checked
       * against the same allowlist as every other write.
       */
      const clearing = (Array.isArray(data.clear) ? data.clear : [])
        .filter(f => SCREENING_FIELDS.includes(f));
      if (clearing.length) {
        // The column names are concatenated into the SQL, so the filter above is
        // load-bearing security, not tidiness: SCREENING_FIELDS is a literal
        // allowlist, and anything not in it never reaches this string. Same
        // discipline as the allowlisted ORDER BY column in findCandidates().
        await client.query(
          `UPDATE candidate_screenings
              SET ${clearing.map(f => `${f} = NULL`).join(', ')}, updated_at = NOW()
            WHERE id = $1`,
          [screening.id]
        );
        for (const f of clearing) screening[f] = null;
      }

      // The merged view is what gets scored — the stored row overlaid with
      // whatever this request supplied. Scoring `data` alone would compute a
      // score for the two fields in this one request. Cleared fields are removed
      // from the overlay, so the score drops to match what is now stored.
      const merged = { ...screening, ...pickScreeningFields(data) };
      for (const f of clearing) merged[f] = null;
      const score  = computeScreeningScore(merged);
      const recommendation = recommendationFor(score);

      const { rows: updated } = await client.query(
        `UPDATE candidate_screenings SET
           qualification_fit = COALESCE($2,  qualification_fit),
           experience_fit    = COALESCE($3,  experience_fit),
           skills_fit        = COALESCE($4,  skills_fit),
           notice_fit        = COALESCE($5,  notice_fit),
           location_fit      = COALESCE($6,  location_fit),
           salary_fit        = COALESCE($7,  salary_fit),

           learning_mindset  = COALESCE($8,  learning_mindset),
           ownership         = COALESCE($9,  ownership),
           teamwork          = COALESCE($10, teamwork),
           patience          = COALESCE($11, patience),
           problem_solving   = COALESCE($12, problem_solving),
           communication     = COALESCE($13, communication),
           adaptability      = COALESCE($14, adaptability),
           relevant_knowledge= COALESCE($15, relevant_knowledge),
           career_alignment  = COALESCE($16, career_alignment),

           learning_mindset_evidence = COALESCE($17, learning_mindset_evidence),
           ownership_evidence        = COALESCE($18, ownership_evidence),
           teamwork_evidence         = COALESCE($19, teamwork_evidence),
           patience_evidence         = COALESCE($20, patience_evidence),
           problem_solving_evidence  = COALESCE($21, problem_solving_evidence),
           communication_evidence    = COALESCE($22, communication_evidence),
           adaptability_evidence     = COALESCE($23, adaptability_evidence),
           role_alignment_note       = COALESCE($24, role_alignment_note),
           summary_note              = COALESCE($25, summary_note),

           total_score      = $26,
           score_breakdown  = $27::jsonb,
           recommendation   = $28,
           updated_at       = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          screening.id,
          data.qualification_fit ?? null, data.experience_fit ?? null,
          data.skills_fit ?? null, data.notice_fit ?? null,
          data.location_fit ?? null, data.salary_fit ?? null,
          nn(data.learning_mindset), nn(data.ownership), nn(data.teamwork),
          nn(data.patience), nn(data.problem_solving), nn(data.communication),
          nn(data.adaptability), nn(data.relevant_knowledge), nn(data.career_alignment),
          data.learning_mindset_evidence ?? null, data.ownership_evidence ?? null,
          data.teamwork_evidence ?? null, data.patience_evidence ?? null,
          data.problem_solving_evidence ?? null, data.communication_evidence ?? null,
          data.adaptability_evidence ?? null, data.role_alignment_note ?? null,
          data.summary_note ?? null,
          score.total,
          JSON.stringify({ ...score.breakdown, _assessed_weight: score.assessed_weight }),
          recommendation,
        ]
      );

      // Answers, if any came with this save.
      if (Array.isArray(data.responses) && data.responses.length) {
        for (const r of data.responses) {
          const qid = parseInt(r.question_id, 10);
          if (!Number.isInteger(qid)) continue;
          await client.query(
            `INSERT INTO screening_responses (screening_id, question_id, answer_text, answer_choice)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (screening_id, question_id) DO UPDATE
               SET answer_text   = EXCLUDED.answer_text,
                   answer_choice = EXCLUDED.answer_choice,
                   updated_at    = NOW()`,
            [screening.id, qid, r.answer_text ?? null, r.answer_choice ?? null]
          );
        }

        // Q9's answer IS the relocation field. Writing it through means the
        // recruiter answers the location question once instead of answering it and
        // then separately setting a dropdown that can disagree with the answer.
        const q9 = data.responses.find(r => r.code === 'Q9' && r.answer_choice);
        if (q9) {
          await client.query(
            // $2 cast on both mentions. It works uncast here today, but it is the
            // same assignment-target-plus-comparison shape that fails outright a
            // few functions down (see completeScreening), and the difference is
            // only which side happens to pin the type first. Not worth relying on.
            //
            // The IN list is a guard, not validation: a Q9 option value that is
            // not a relocation vocabulary member updates nothing rather than
            // violating the column CHECK and failing the whole screening save.
            `UPDATE candidates SET willing_to_relocate = $2::varchar, updated_at = NOW()
              WHERE id = $1
                AND $2::varchar IN ('unknown','already_local','willing','willing_with_support',
                                    'needs_information','not_currently','no')`,
            [candidate_id, q9.answer_choice]
          );
        }
      }

      // A candidate being actively screened is 'in_screening' — but only from a
      // state that screening can legitimately move (§35: a Talent Bank or
      // blacklisted candidate is not silently reclassified by opening their
      // screening form).
      await client.query(
        `UPDATE candidates SET disposition = 'in_screening', updated_at = NOW()
          WHERE id = $1 AND disposition IN ('new','active')`,
        [candidate_id]
      );

      await client.query('COMMIT');
      return { ...updated[0], score };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  },

  /**
   * Record the Stage-1 outcome (§15) and apply its consequences.
   *
   * This is the one function in the module that turns a judgement into state
   * changes across several tables, and it does all of them in ONE transaction,
   * because the half-applied version of "not suitable here, add to Talent Bank,
   * consider Testing and Service" is worse than the failure.
   *
   * What each decision does — and what it deliberately does NOT do:
   *
   *   proceed                     → application stage advances to assessment
   *   hold                        → stage 'maybe'; nothing else changes
   *   not_suitable_current_role   → THIS application's stage becomes
   *                                 'not_suitable'. The candidate's disposition
   *                                 stays 'active'. §15: "do NOT remove the
   *                                 candidate from the system", and §2's whole
   *                                 point is that being wrong for one role is not
   *                                 being wrong for Manifest.
   *   consider_other_roles        → as above, plus the departments in
   *                                 `suitable_departments` become suitability rows
   *   talent_bank                 → disposition 'talent_bank' + pool membership
   *   future_opportunity          → disposition 'future_opportunity' + a recontact
   *                                 row, which is what makes it a reminder rather
   *                                 than a label
   *   reject_from_manifest        → the ONLY decision that sets a negative
   *                                 candidate-level disposition, and the API
   *                                 requires a reason for it
   */
  async completeScreening(screening_id, decisionData, ctx = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: found } = await client.query(
        `SELECT s.*, c.full_name, c.company_id AS candidate_company_id
           FROM candidate_screenings s
           JOIN candidates c ON c.id = s.candidate_id
          WHERE s.id = $1 AND ($2::int IS NULL OR s.company_id = $2)
          FOR UPDATE OF s`,
        [screening_id, ctx.company_id]
      );
      if (!found.length) {
        await client.query('ROLLBACK');
        return null;
      }
      const s = found[0];
      const decision = decisionData.decision;

      const { rows: updated } = await client.query(
        `UPDATE candidate_screenings
            SET status          = 'completed',
                decision        = $2,
                override_reason = $3,
                reject_reason   = $4,
                summary_note    = COALESCE($5, summary_note),
                completed_at    = NOW(),
                screened_by     = COALESCE(screened_by, $6),
                updated_at      = NOW()
          WHERE id = $1
          RETURNING *`,
        [
          screening_id, decision,
          decisionData.override_reason || null,
          decisionData.reject_reason || null,
          decisionData.summary_note || null,
          ctx.actor_user_id || null,
        ]
      );

      const stageFor = {
        proceed: 'assessment',
        hold: 'maybe',
        not_suitable_current_role: 'not_suitable',
        consider_other_roles: 'not_suitable',
        talent_bank: 'future_use',
        future_opportunity: 'future_use',
        reject_from_manifest: 'rejected',
      };
      const newStage = stageFor[decision];

      // The application's stage, not the candidate's, when there is one — that
      // separation IS §3.
      if (s.application_id && newStage) {
        await client.query(
          // $2 is cast explicitly on EVERY mention. It appears as an assignment
          // target (varchar) and inside CASE comparisons against text literals,
          // and without the cast Postgres refuses the whole statement at parse
          // time with "inconsistent types deduced for parameter $2 — text versus
          // character varying". moveCandidateStage() in recruitment.repository.js
          // carries the same note for the same statement shape.
          `UPDATE candidate_applications
              SET stage = $2::varchar,
                  status = CASE WHEN $2::varchar IN ('rejected','not_suitable') THEN 'rejected'
                                WHEN $2::varchar = 'hired' THEN 'hired' ELSE status END,
                  updated_at = NOW()
            WHERE id = $1`,
          [s.application_id, newStage]
        );
        // The primary application is the one the pipeline board follows, so its
        // stage writes through to the candidate exactly as moveApplicationStage()
        // already does. A secondary one does not.
        await client.query(
          `UPDATE candidates c SET current_stage = $2, updated_at = NOW()
             FROM candidate_applications a
            WHERE a.id = $1 AND a.candidate_id = c.id AND a.is_primary = TRUE`,
          [s.application_id, newStage]
        );
      } else if (newStage) {
        await client.query(
          `UPDATE candidates SET current_stage = $2, updated_at = NOW() WHERE id = $1`,
          [s.candidate_id, newStage]
        );
      }

      const dispositionFor = {
        talent_bank: 'talent_bank',
        future_opportunity: 'future_opportunity',
        reject_from_manifest: 'rejected_from_manifest',
        // proceed / hold / not_suitable_current_role / consider_other_roles all
        // leave the person ACTIVE. That is the §2 principle in one line.
        proceed: 'active',
        hold: 'active',
        not_suitable_current_role: 'active',
        consider_other_roles: 'active',
      };
      await client.query(
        `UPDATE candidates SET disposition = $2, updated_at = NOW() WHERE id = $1`,
        [s.candidate_id, dispositionFor[decision] || 'active']
      );

      // Alternative departments, when the decision named any.
      const departments = Array.isArray(decisionData.suitable_departments)
        ? decisionData.suitable_departments : [];
      const savedDepartments = [];
      for (const d of departments) {
        const dept = typeof d === 'string' ? { department: d } : (d || {});
        if (!dept.department) continue;
        savedDepartments.push(await repo._upsertSuitabilityRow(client, {
          company_id: ctx.company_id,
          candidate_id: s.candidate_id,
          department: dept.department,
          role_title: dept.role_title || null,
          suitability: dept.suitability || 'potential',
          reason: dept.reason || decisionData.summary_note || null,
          // The opening they were assessed FOR is the context that makes the
          // judgement legible later ("we thought this while interviewing them for
          // Power Quality"). Resolved from the application rather than left null.
          identified_from_job_id: s.application_id
            ? (await client.query(
                `SELECT job_opening_id FROM candidate_applications WHERE id = $1`,
                [s.application_id]
              )).rows[0]?.job_opening_id ?? null
            : null,
          identified_by: ctx.actor_user_id || null,
        }));
      }

      // Its OWN timeline event, not only a field inside screening_completed.
      //
      // saveSuitability() (the standalone "Consider other roles" endpoint) records
      // `suitability_recorded`, and without this the same outcome produced a
      // different timeline depending on which screen the recruiter reached it
      // from — a recruiter looking for "when did we decide they suited Testing"
      // would find it on one candidate and not another. One fact, one event,
      // whichever path wrote it.
      if (savedDepartments.length) {
        await repo.recordActivity({
          company_id: ctx.company_id,
          candidate_id: s.candidate_id,
          application_id: s.application_id,
          event_type: 'suitability_recorded',
          summary: `Identified as suitable for ${savedDepartments.map(r => r.department).join(', ')}`,
          detail: {
            departments: savedDepartments.map(r => ({ department: r.department, suitability: r.suitability })),
            from: 'screening',
          },
          actor_user_id: ctx.actor_user_id || null,
          actor_name: ctx.actor_name || null,
        }, client);
      }

      // Talent Bank membership. Pools are verified to belong to this company
      // before anything is written — a pool id from another tenant would otherwise
      // accept a member row and leak a candidate across the boundary, exactly as
      // addToTalentBank() guards against.
      const requestedPools = (Array.isArray(decisionData.pool_ids) ? decisionData.pool_ids : [])
        .map(n => parseInt(n, 10)).filter(Number.isInteger);
      const { rows: pools } = requestedPools.length
        ? await client.query(
            `SELECT id, pool_name FROM talent_pools
              WHERE id = ANY($1::int[]) AND ($2::int IS NULL OR company_id = $2)`,
            [requestedPools, ctx.company_id]
          )
        : { rows: [] };

      for (const p of pools) {
        await repo._addPoolMemberRow(client, {
          company_id: ctx.company_id, pool_id: p.id, candidate_id: s.candidate_id,
          reason: decisionData.summary_note || null,
          source_stage: newStage || null,
          added_by_user_id: ctx.actor_user_id || null,
          tags: decisionData.tags || [],
        });
      }

      // Its own timeline event, for the same reason suitability gets one:
      // addToTalentBank() records `talent_bank_added`, and without this the same
      // fact produced a different timeline depending on whether the recruiter
      // banked the candidate from the screening form or from the candidate list.
      if (pools.length) {
        await repo.recordActivity({
          company_id: ctx.company_id,
          candidate_id: s.candidate_id,
          application_id: s.application_id,
          event_type: 'talent_bank_added',
          summary: `Added to the Talent Bank: ${pools.map(p => p.pool_name).join(', ')}`,
          detail: {
            pool_ids: pools.map(p => p.id),
            tags: decisionData.tags || [],
            from: 'screening',
          },
          actor_user_id: ctx.actor_user_id || null,
          actor_name: ctx.actor_name || null,
        }, client);
      }

      // Future Opportunity becomes a dated reminder, not just a label.
      let recontact = null;
      if (decision === 'future_opportunity' && decisionData.recontact_on) {
        const { rows: rc } = await client.query(
          `INSERT INTO candidate_recontact
             (company_id, candidate_id, reason, reason_note, potential_role, department,
              preferred_location, recontact_on, owner_user_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
           RETURNING *`,
          [
            ctx.company_id, s.candidate_id,
            decisionData.recontact_reason || 'screening_outcome',
            decisionData.summary_note || null,
            decisionData.potential_role || null,
            decisionData.department || null,
            decisionData.preferred_location || null,
            decisionData.recontact_on,
            ctx.actor_user_id || null,
          ]
        );
        recontact = rc[0];
      }

      const DECISION_LABELS = {
        proceed: 'Proceed to Stage 2',
        hold: 'Hold / Review',
        not_suitable_current_role: 'Not suitable for the current role',
        consider_other_roles: 'Not suitable here — consider other roles',
        talent_bank: 'Added to the Talent Bank',
        future_opportunity: 'Future opportunity',
        reject_from_manifest: 'Rejected from Manifest',
      };
      await repo.recordActivity({
        company_id: ctx.company_id,
        candidate_id: s.candidate_id,
        application_id: s.application_id,
        event_type: 'screening_completed',
        summary: `Stage 1 screening completed — ${DECISION_LABELS[decision] || decision}`
               + (s.total_score != null ? ` (${s.total_score}/100)` : ''),
        detail: {
          screening_id: s.id, decision,
          total_score: s.total_score,
          recommendation: s.recommendation,
          // Recorded explicitly, because "did a human overrule the scorecard" is
          // a question somebody will ask about this hire in a year.
          overridden: Boolean(s.recommendation && s.recommendation !== decision),
          override_reason: decisionData.override_reason || null,
          departments: departments.map(d => (typeof d === 'string' ? d : d?.department)).filter(Boolean),
          pool_ids: pools.map(p => p.id),
        },
        actor_user_id: ctx.actor_user_id || null,
        actor_name: ctx.actor_name || null,
      }, client);

      await client.query('COMMIT');
      return { ...updated[0], recontact };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  },

  // ── Role suitability (§16, §27) ───────────────────────────────────────────

  /** Shared by completeScreening and the standalone endpoint. Client-bound. */
  async _upsertSuitabilityRow(client, row) {
    const { rows } = await client.query(
      `INSERT INTO candidate_role_suitability
         (company_id, candidate_id, department, role_title, job_opening_id,
          suitability, reason, notes, identified_from_job_id, identified_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (candidate_id, LOWER(department)) DO UPDATE SET
         -- A re-assessment REPLACES the previous opinion rather than adding to
         -- it. Two rows saying "Testing: potential" and "Testing: not suitable"
         -- would leave the UI to pick one arbitrarily.
         suitability   = EXCLUDED.suitability,
         role_title    = COALESCE(EXCLUDED.role_title, candidate_role_suitability.role_title),
         reason        = COALESCE(EXCLUDED.reason, candidate_role_suitability.reason),
         notes         = COALESCE(EXCLUDED.notes, candidate_role_suitability.notes),
         job_opening_id= COALESCE(EXCLUDED.job_opening_id, candidate_role_suitability.job_opening_id),
         identified_by = EXCLUDED.identified_by,
         identified_at = NOW(),
         status        = 'open',
         updated_at    = NOW()
       RETURNING *`,
      [
        row.company_id, row.candidate_id, row.department, row.role_title || null,
        row.job_opening_id || null, row.suitability || 'potential',
        row.reason || null, row.notes || null,
        row.identified_from_job_id || null, row.identified_by || null,
      ]
    );
    return rows[0];
  },

  async listSuitability(candidate_id, company_id = null) {
    const { rows } = await pool.query(
      `SELECT rs.*,
              jo.job_title  AS opening_title,
              jo.status     AS opening_status,
              src.job_title AS identified_from_title,
              COALESCE(e.name, u.email) AS identified_by_name,
              -- Is there an open vacancy in this department right now? This is
              -- what turns a dormant suitability record into an action: "suited
              -- to Testing" plus "Testing is hiring" is the moment to act.
              (SELECT COUNT(*)::int FROM job_openings o
                WHERE o.deleted_at IS NULL AND o.status = 'open'
                  AND LOWER(o.department) = LOWER(rs.department)
                  AND ($2::int IS NULL OR o.company_id = $2)) AS open_openings
         FROM candidate_role_suitability rs
         LEFT JOIN job_openings jo  ON jo.id  = rs.job_opening_id
         LEFT JOIN job_openings src ON src.id = rs.identified_from_job_id
         LEFT JOIN users u          ON u.id   = rs.identified_by
         LEFT JOIN employees e      ON e.id   = u.employee_id
        WHERE rs.candidate_id = $1
          AND ($2::int IS NULL OR rs.company_id = $2)
        ORDER BY
          CASE rs.suitability WHEN 'strong' THEN 0 WHEN 'potential' THEN 1 ELSE 2 END,
          rs.identified_at DESC`,
      [candidate_id, company_id]
    );
    return rows;
  },

  /** Record suitability for several departments in one action (§16's checkbox list). */
  async saveSuitability(candidate_id, entries, ctx = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const saved = [];
      for (const e of entries) {
        const department = typeof e === 'string' ? e : e?.department;
        if (!department) continue;
        saved.push(await repo._upsertSuitabilityRow(client, {
          company_id: ctx.company_id,
          candidate_id,
          department,
          role_title: e?.role_title || null,
          suitability: e?.suitability || 'potential',
          reason: e?.reason || ctx.reason || null,
          notes: e?.notes || null,
          identified_from_job_id: ctx.identified_from_job_id || null,
          identified_by: ctx.actor_user_id || null,
        }));
      }

      if (saved.length) {
        await repo.recordActivity({
          company_id: ctx.company_id, candidate_id,
          event_type: 'suitability_recorded',
          summary: `Identified as suitable for ${saved.map(r => r.department).join(', ')}`,
          detail: { departments: saved.map(r => ({ department: r.department, suitability: r.suitability })) },
          actor_user_id: ctx.actor_user_id || null,
          actor_name: ctx.actor_name || null,
        }, client);
      }

      await client.query('COMMIT');
      return saved;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  },

  /**
   * Departments a candidate could be put forward to: §16's list, taken from the
   * company's own openings and requisitions rather than hardcoded, so it reflects
   * what Manifest actually has. Falls back to the master vocabulary when the
   * company has posted nothing yet — an empty checkbox list would make the
   * feature look broken on a new install.
   */
  async listDepartments(company_id = null) {
    const { rows } = await pool.query(
      `SELECT DISTINCT department FROM (
         SELECT department FROM job_openings
          WHERE department IS NOT NULL AND deleted_at IS NULL
            AND ($1::int IS NULL OR company_id = $1)
         UNION
         SELECT department FROM job_requisitions
          WHERE department IS NOT NULL AND deleted_at IS NULL
            AND ($1::int IS NULL OR company_id = $1)
         UNION
         SELECT department FROM talent_pools
          WHERE department IS NOT NULL
            AND ($1::int IS NULL OR company_id = $1)
       ) d
       WHERE TRIM(department) <> ''
       ORDER BY department`,
      [company_id]
    );
    return rows.map(r => r.department);
  },

  /**
   * Turn a suitability record into a real application against a now-open
   * vacancy, without creating a second candidate (§3, §16).
   */
  async convertSuitability(suitability_id, job_opening_id, ctx = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: found } = await client.query(
        `SELECT * FROM candidate_role_suitability
          WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) FOR UPDATE`,
        [suitability_id, ctx.company_id]
      );
      if (!found.length) { await client.query('ROLLBACK'); return null; }
      const rs = found[0];

      const { rows: opening } = await client.query(
        `SELECT id, job_title, status FROM job_openings
          WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
        [job_opening_id, ctx.company_id]
      );
      if (!opening.length) {
        await client.query('ROLLBACK');
        const err = new Error('That opening no longer exists.');
        err.status = 404;
        throw err;
      }
      if (opening[0].status !== 'open') {
        await client.query('ROLLBACK');
        const err = new Error(`${opening[0].job_title} is not open for applications.`);
        err.status = 409;
        throw err;
      }

      // ON CONFLICT DO NOTHING against the unique index added by migration
      // 20260927000001 — if they are already up for this opening, converting is a
      // no-op rather than a duplicate or an error.
      const { rows: app } = await client.query(
        `INSERT INTO candidate_applications
           (company_id, candidate_id, job_opening_id, stage, status, origin,
            is_primary, recommended_by, notes)
         VALUES ($1,$2,$3,'applied','active','recommended',FALSE,$4,$5)
         ON CONFLICT (candidate_id, job_opening_id) DO NOTHING
         RETURNING *`,
        [ctx.company_id, rs.candidate_id, job_opening_id, ctx.actor_user_id || null, rs.reason || null]
      );

      const application = app[0] || (await client.query(
        `SELECT * FROM candidate_applications WHERE candidate_id = $1 AND job_opening_id = $2`,
        [rs.candidate_id, job_opening_id]
      )).rows[0];

      await client.query(
        `UPDATE candidate_role_suitability
            SET status = 'actioned', converted_application_id = $2,
                job_opening_id = COALESCE(job_opening_id, $3), updated_at = NOW()
          WHERE id = $1`,
        [suitability_id, application?.id || null, job_opening_id]
      );

      // Coming back into play from the Talent Bank is the §2 loop closing, so the
      // disposition follows.
      await client.query(
        `UPDATE candidates SET disposition = 'active', updated_at = NOW()
          WHERE id = $1 AND disposition IN ('talent_bank','future_opportunity','inactive')`,
        [rs.candidate_id]
      );

      await repo.recordActivity({
        company_id: ctx.company_id, candidate_id: rs.candidate_id,
        application_id: application?.id || null,
        event_type: 'suitability_converted',
        summary: `Put forward for ${opening[0].job_title} from the ${rs.department} suitability record`,
        detail: { suitability_id, job_opening_id, department: rs.department },
        actor_user_id: ctx.actor_user_id || null,
        actor_name: ctx.actor_name || null,
      }, client);

      await client.query('COMMIT');
      return { application, suitability_id, job_title: opening[0].job_title, created: Boolean(app[0]) };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  },

  // ── Talent Bank (§17, §19) ────────────────────────────────────────────────

  /** Client-bound pool insert, shared with completeScreening. */
  async _addPoolMemberRow(client, row) {
    const { rows } = await client.query(
      `INSERT INTO talent_pool_members
         (company_id, pool_id, candidate_id, tags, reason, source_stage, added_by_user_id, added_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,NOW())
       ON CONFLICT (pool_id, candidate_id) DO UPDATE SET
         -- Tags are UNIONed, not replaced: adding a candidate to the Power
         -- Electronics pool a second time with the tag 'STATCOM' should not
         -- erase the 'AHF' tag somebody else put there. jsonb_agg over a
         -- DISTINCT union rather than concatenation, which would duplicate.
         tags = COALESCE((
           SELECT jsonb_agg(DISTINCT v) FROM (
             SELECT jsonb_array_elements_text(COALESCE(talent_pool_members.tags,'[]'::jsonb)) AS v
             UNION
             SELECT jsonb_array_elements_text(COALESCE(EXCLUDED.tags,'[]'::jsonb)) AS v
           ) u
         ), '[]'::jsonb),
         reason = COALESCE(EXCLUDED.reason, talent_pool_members.reason)
       RETURNING *`,
      [
        row.company_id, row.pool_id, row.candidate_id,
        JSON.stringify(Array.isArray(row.tags) ? row.tags : []),
        row.reason || null, row.source_stage || null, row.added_by_user_id || null,
      ]
    );
    return rows[0];
  },

  /**
   * Make sure this company has §17's standard categories.
   *
   * Called by the Talent Bank list endpoint rather than done once in a migration,
   * because a migration cannot seed a company that does not exist yet — a tenant
   * onboarded next month would otherwise open an empty Talent Bank. Idempotent
   * and cheap: the NOT EXISTS makes the second call a no-op, and it only runs on
   * a screen a recruiter has to open deliberately.
   */
  async ensureStandardTalentPools(company_id) {
    if (!company_id) return 0;
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM talent_pools WHERE company_id = $1 AND is_seeded = TRUE`,
      [company_id]
    );
    if (rows[0].n >= STANDARD_POOLS.length) return 0;

    let created = 0;
    for (const [name, category, department] of STANDARD_POOLS) {
      const { rowCount } = await pool.query(
        `INSERT INTO talent_pools
           (company_id, pool_name, description, category, department, skill_focus,
            is_active, is_seeded, created_at, updated_at)
         SELECT $1, $2, $3, $4, $5, $6, TRUE, TRUE, NOW(), NOW()
          WHERE NOT EXISTS (
            SELECT 1 FROM talent_pools WHERE company_id = $1 AND LOWER(pool_name) = LOWER($7)
          )`,
        [company_id, name,
         `Talent Bank — ${name}. Candidates retained for current and future ${name} openings.`,
         category, department, name, name]
      );
      created += rowCount;
    }
    return created;
  },

  async addToTalentBank(candidate_id, data, ctx = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const poolIds = (Array.isArray(data.pool_ids) ? data.pool_ids : [data.pool_ids])
        .map(n => parseInt(n, 10)).filter(Number.isInteger);

      // Pools are verified to belong to this company before anything is written.
      // Without this, a pool id from another tenant would happily accept a
      // member row and leak a candidate across the boundary.
      const { rows: pools } = await client.query(
        `SELECT id, pool_name FROM talent_pools
          WHERE id = ANY($1::int[]) AND ($2::int IS NULL OR company_id = $2)`,
        [poolIds, ctx.company_id]
      );
      if (poolIds.length && !pools.length) {
        await client.query('ROLLBACK');
        const err = new Error('None of those talent pools exist in this company.');
        err.status = 404;
        throw err;
      }

      const { rows: cand } = await client.query(
        `SELECT id, full_name, current_stage FROM candidates
          WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
        [candidate_id, ctx.company_id]
      );
      if (!cand.length) { await client.query('ROLLBACK'); return null; }

      for (const p of pools) {
        await repo._addPoolMemberRow(client, {
          company_id: ctx.company_id, pool_id: p.id, candidate_id,
          tags: data.tags || [], reason: data.reason || null,
          source_stage: cand[0].current_stage,
          added_by_user_id: ctx.actor_user_id || null,
        });
      }

      // The disposition is the point. A candidate in a pool whose disposition
      // still says 'new' is not in the Talent Bank in any sense a recruiter can
      // search for. 'hired' and 'blacklisted' are left alone — banking a hired
      // employee or a blacklisted person would be wrong in opposite directions.
      await client.query(
        `UPDATE candidates SET disposition = 'talent_bank', updated_at = NOW()
          WHERE id = $1 AND disposition NOT IN ('hired','blacklisted')`,
        [candidate_id]
      );
      // The stage follows too, so the pipeline board stops showing them as live
      // for a role they are no longer being considered for — unless they are
      // genuinely still in play somewhere, which is what the EXISTS protects.
      await client.query(
        `UPDATE candidates SET current_stage = 'future_use'
          WHERE id = $1 AND current_stage NOT IN ('hired','offer','selected')
            AND NOT EXISTS (
              SELECT 1 FROM candidate_applications a
               WHERE a.candidate_id = $1 AND a.status = 'active'
                 AND a.stage IN ('screening','shortlisted','assessment','1st_level','2nd_level','offer','selected')
            )`,
        [candidate_id]
      );

      await repo.recordActivity({
        company_id: ctx.company_id, candidate_id,
        event_type: 'talent_bank_added',
        summary: pools.length
          ? `Added to the Talent Bank: ${pools.map(p => p.pool_name).join(', ')}`
          : 'Added to the Talent Bank',
        detail: { pool_ids: pools.map(p => p.id), tags: data.tags || [], reason: data.reason || null },
        actor_user_id: ctx.actor_user_id || null,
        actor_name: ctx.actor_name || null,
      }, client);

      await client.query('COMMIT');
      return { candidate_id, pools: pools.map(p => ({ id: p.id, pool_name: p.pool_name })) };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  },

  /**
   * §19's Talent Bank search. The brief's worked example — "Power electronics +
   * 2-5 years + Tamil Nadu + willing to relocate" — is four predicates that all
   * have to reach the database, which is why none of this is filtered in the
   * browser.
   */
  async searchTalentBank(filters = {}) {
    const where = [`c.deleted_at IS NULL`];
    const params = [];
    let n = 1;
    const add = (clause, ...values) => { where.push(clause); params.push(...values); };

    if (filters.company_id) add(`c.company_id = $${n++}`, filters.company_id);

    // What makes a candidate "in the Talent Bank": an explicit disposition, OR
    // membership of a pool. Both, because a recruiter who adds someone to the
    // Power Electronics pool has banked them whatever the disposition column
    // says, and a candidate dispositioned to the bank is banked even before
    // anybody picked a category for them.
    if (filters.scope !== 'all') {
      add(`(c.disposition IN ('talent_bank','future_opportunity')
            OR EXISTS (SELECT 1 FROM talent_pool_members m WHERE m.candidate_id = c.id))`);
    }

    if (filters.pool_id)     add(`EXISTS (SELECT 1 FROM talent_pool_members m WHERE m.candidate_id = c.id AND m.pool_id = $${n++})`, parseInt(filters.pool_id, 10));
    if (filters.department)   add(`EXISTS (SELECT 1 FROM candidate_role_suitability rs WHERE rs.candidate_id = c.id AND LOWER(rs.department) = LOWER($${n++}) AND rs.suitability <> 'not_suitable')`, filters.department);
    if (filters.disposition) add(`c.disposition = $${n++}`, filters.disposition);
    if (filters.classification) add(`c.classification = $${n++}`, filters.classification);

    // State and city each reuse one placeholder across two columns, so `n` is
    // advanced once after the call, not once per mention.
    if (filters.state) {
      add(`(c.current_state ILIKE $${n} OR c.location ILIKE $${n})`, `%${filters.state}%`);
      n++;
    }
    if (filters.city) {
      add(`(c.current_city ILIKE $${n} OR c.location ILIKE $${n})`, `%${filters.city}%`);
      n++;
    }

    // "willing to relocate" is a question about four of the seven stored values,
    // not one. Asking for `= 'willing'` would hide every candidate who said
    // "yes, with support" — which is most of them for a Srivilliputtur site.
    if (filters.willing_to_relocate === 'true' || filters.willing_to_relocate === true) {
      add(`c.willing_to_relocate IN ('already_local','willing','willing_with_support')`);
    } else if (filters.willing_to_relocate) {
      add(`c.willing_to_relocate = $${n++}`, filters.willing_to_relocate);
    }

    if (filters.experience_min != null && filters.experience_min !== '') add(`c.experience_years >= $${n++}`, Number(filters.experience_min));
    if (filters.experience_max != null && filters.experience_max !== '') add(`c.experience_years <= $${n++}`, Number(filters.experience_max));
    if (filters.qualification) add(`c.qualification = $${n++}`, filters.qualification);
    if (filters.specialisation) add(`c.specialisation ILIKE $${n++}`, `%${filters.specialisation}%`);
    if (filters.previous_company) add(`c.current_company ILIKE $${n++}`, `%${filters.previous_company}%`);
    if (filters.current_role) add(`c.current_designation ILIKE $${n++}`, `%${filters.current_role}%`);
    if (filters.notice_period_max != null && filters.notice_period_max !== '') {
      add(`(c.notice_period_days IS NULL OR c.notice_period_days <= $${n++})`, Number(filters.notice_period_max));
    }
    if (filters.expected_ctc_max != null && filters.expected_ctc_max !== '') {
      add(`(c.expected_ctc IS NULL OR c.expected_ctc <= $${n++})`, Number(filters.expected_ctc_max));
    }
    // §19 "Previous screening score".
    if (filters.min_screening_score != null && filters.min_screening_score !== '') {
      add(`EXISTS (SELECT 1 FROM candidate_screenings s
                    WHERE s.candidate_id = c.id AND s.total_score >= $${n++})`,
          Number(filters.min_screening_score));
    }
    if (filters.has_previous_application === 'true') {
      add(`EXISTS (SELECT 1 FROM candidate_applications a WHERE a.candidate_id = c.id)`);
    }

    const skills = normaliseList(filters.skills);
    if (skills.length) {
      add(`EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(COALESCE(c.skills,'[]'::jsonb)) AS s(v)
              WHERE LOWER(s.v) = ANY($${n++}::text[])
             HAVING COUNT(DISTINCT LOWER(s.v)) = $${n++}
           )`, skills.map(s => s.toLowerCase()), skills.length);
    }

    const tags = normaliseList(filters.tags);
    if (tags.length) {
      add(`EXISTS (
             SELECT 1 FROM talent_pool_members m,
                          jsonb_array_elements_text(COALESCE(m.tags,'[]'::jsonb)) AS t(v)
              WHERE m.candidate_id = c.id AND LOWER(t.v) = ANY($${n++}::text[])
           )`, tags.map(t => t.toLowerCase()));
    }

    if (filters.search) {
      add(`(c.full_name ILIKE $${n} OR c.email ILIKE $${n} OR c.phone ILIKE $${n}
            OR c.candidate_code ILIKE $${n} OR c.current_company ILIKE $${n}
            OR c.current_designation ILIKE $${n})`, `%${filters.search}%`);
      n++;
    }
    if (filters.resume_text) {
      add(`to_tsvector('english', COALESCE(c.resume_text,'')) @@ plainto_tsquery('english', $${n++})`,
          filters.resume_text);
    }

    const whereSql = where.join(' AND ');
    const SORTABLE = {
      last_activity_at: 'c.last_activity_at', full_name: 'c.full_name',
      experience_years: 'c.experience_years', created_at: 'c.created_at',
      expected_ctc: 'c.expected_ctc',
    };
    const sortCol = SORTABLE[filters.sort_by] || 'c.last_activity_at';
    const sortDir = String(filters.sort_dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const limit  = Math.min(Math.max(parseInt(filters.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM candidates c WHERE ${whereSql}`, params
    );
    const rowsRes = await pool.query(
      `SELECT c.id, c.candidate_code, c.full_name, c.email, c.phone, c.photo_url,
              c.experience_years, c.relevant_experience_years, c.current_company,
              c.current_designation, c.location, c.current_city, c.current_state,
              c.willing_to_relocate, c.qualification, c.specialisation, c.skills,
              c.expected_ctc, c.notice_period_days, c.disposition, c.classification,
              c.current_stage, c.last_activity_at, c.created_at, c.source,
              (SELECT MAX(s.total_score) FROM candidate_screenings s WHERE s.candidate_id = c.id) AS best_screening_score,
              (SELECT COUNT(*)::int FROM candidate_applications a WHERE a.candidate_id = c.id) AS application_count,
              (SELECT COALESCE(jsonb_agg(DISTINCT tp.pool_name), '[]'::jsonb)
                 FROM talent_pool_members m JOIN talent_pools tp ON tp.id = m.pool_id
                WHERE m.candidate_id = c.id) AS pools,
              (SELECT COALESCE(jsonb_agg(DISTINCT rs.department), '[]'::jsonb)
                 FROM candidate_role_suitability rs
                WHERE rs.candidate_id = c.id AND rs.suitability <> 'not_suitable') AS suitable_departments,
              (SELECT MIN(rc.recontact_on) FROM candidate_recontact rc
                WHERE rc.candidate_id = c.id AND rc.status = 'pending') AS recontact_on
         FROM candidates c
        WHERE ${whereSql}
        ORDER BY ${sortCol} ${sortDir} NULLS LAST, c.id DESC
        LIMIT $${n++} OFFSET $${n++}`,
      [...params, limit, offset]
    );
    return { rows: rowsRes.rows, total: countRes.rows[0].total, limit, offset };
  },

  // ── Future Opportunity / recontact (§18) ──────────────────────────────────

  async createRecontact(candidate_id, data, ctx = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: cand } = await client.query(
        `SELECT id, full_name, recruiter_id FROM candidates
          WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
        [candidate_id, ctx.company_id]
      );
      if (!cand.length) { await client.query('ROLLBACK'); return null; }

      const { rows } = await client.query(
        `INSERT INTO candidate_recontact
           (company_id, candidate_id, reason, reason_note, potential_role, department,
            preferred_location, recontact_on, owner_user_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          ctx.company_id, candidate_id,
          data.reason || null, data.reason_note || null,
          data.potential_role || null, data.department || null,
          data.preferred_location || null, data.recontact_on,
          // Whoever is asked for, else the candidate's recruiter, else the person
          // creating it. A reminder with no owner is a reminder nobody gets.
          data.owner_user_id || cand[0].recruiter_id || ctx.actor_user_id || null,
          ctx.actor_user_id || null,
        ]
      );

      await client.query(
        `UPDATE candidates
            SET disposition = 'future_opportunity',
                current_stage = CASE WHEN current_stage IN ('hired','offer','selected')
                                     THEN current_stage ELSE 'future_use' END,
                updated_at = NOW()
          WHERE id = $1 AND disposition NOT IN ('hired','blacklisted')`,
        [candidate_id]
      );

      await repo.recordActivity({
        company_id: ctx.company_id, candidate_id,
        event_type: 'future_opportunity_created',
        summary: `Future opportunity — recontact on ${String(data.recontact_on).slice(0, 10)}`
               + (data.potential_role ? ` for ${data.potential_role}` : ''),
        detail: {
          recontact_id: rows[0].id, reason: data.reason || null,
          potential_role: data.potential_role || null,
          recontact_on: data.recontact_on,
        },
        actor_user_id: ctx.actor_user_id || null,
        actor_name: ctx.actor_name || null,
      }, client);

      await client.query('COMMIT');
      return rows[0];
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  },

  async listRecontacts(filters = {}) {
    const where = [];
    const params = [];
    let n = 1;
    if (filters.company_id)   { where.push(`rc.company_id = $${n++}`); params.push(filters.company_id); }
    if (filters.candidate_id) { where.push(`rc.candidate_id = $${n++}`); params.push(filters.candidate_id); }
    if (filters.owner_user_id){ where.push(`rc.owner_user_id = $${n++}`); params.push(filters.owner_user_id); }
    where.push(`rc.status = $${n++}`); params.push(filters.status || 'pending');
    if (filters.due_before)   { where.push(`rc.recontact_on <= $${n++}::date`); params.push(filters.due_before); }
    if (filters.due_only === 'true' || filters.due_only === true) {
      where.push(`rc.recontact_on <= CURRENT_DATE`);
    }

    const { rows } = await pool.query(
      `SELECT rc.*, c.full_name, c.candidate_code, c.email, c.phone, c.disposition,
              c.current_designation, c.experience_years, c.location,
              COALESCE(e.name, u.email) AS owner_name,
              (rc.recontact_on - CURRENT_DATE) AS days_until_due
         FROM candidate_recontact rc
         JOIN candidates c  ON c.id = rc.candidate_id AND c.deleted_at IS NULL
         LEFT JOIN users u  ON u.id = rc.owner_user_id
         LEFT JOIN employees e ON e.id = u.employee_id
        WHERE ${where.join(' AND ')}
        ORDER BY rc.recontact_on ASC, rc.id ASC
        LIMIT $${n++}`,
      [...params, Math.min(Math.max(parseInt(filters.limit, 10) || 100, 1), 500)]
    );
    return rows;
  },

  /**
   * Mark a recontact done. §35 again: completing a reminder does NOT close the
   * candidate — it records that the conversation happened. Whether they come back
   * into play is a separate, explicit act (`reengage: true`).
   */
  async completeRecontact(id, data, ctx = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE candidate_recontact
            SET status = $2, completed_at = NOW(), completed_by = $3,
                outcome_note = $4, updated_at = NOW()
          WHERE id = $1 AND status = 'pending' AND ($5::int IS NULL OR company_id = $5)
          RETURNING *`,
        [id, data.status === 'cancelled' ? 'cancelled' : 'done',
         ctx.actor_user_id || null, data.outcome_note || null, ctx.company_id]
      );
      if (!rows.length) { await client.query('ROLLBACK'); return null; }
      const rc = rows[0];

      if (data.reengage === true || data.reengage === 'true') {
        await client.query(
          `UPDATE candidates SET disposition = 'active', updated_at = NOW()
            WHERE id = $1 AND disposition = 'future_opportunity'`,
          [rc.candidate_id]
        );
      }

      await repo.recordActivity({
        company_id: ctx.company_id, candidate_id: rc.candidate_id,
        event_type: rc.status === 'cancelled' ? 'recontact_cancelled' : 'recontacted',
        summary: rc.status === 'cancelled'
          ? 'Recontact reminder cancelled'
          : `Recontacted${data.reengage ? ' — back in active consideration' : ''}`,
        detail: { recontact_id: rc.id, outcome_note: data.outcome_note || null },
        actor_user_id: ctx.actor_user_id || null,
        actor_name: ctx.actor_name || null,
      }, client);

      await client.query('COMMIT');
      return rc;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  },

  // ── Similar candidates (§20) ──────────────────────────────────────────────

  /**
   * "Find Similar Candidates", with the reasons spelled out.
   *
   * §20 is explicit: "Do NOT show an unexplained AI score as the only
   * information." So this is not an embedding or a model — it is a set of named,
   * inspectable attribute matches, each contributing a stated number of points,
   * and every row comes back with the list of reasons it matched. A recruiter can
   * disagree with a match and see exactly why the system made it.
   *
   * The weights are deliberately blunt and readable rather than tuned: a shared
   * qualification is worth less than shared skills, because two BE Electrical
   * graduates with nothing else in common are not similar candidates.
   */
  async findSimilar(candidate_id, company_id = null, { limit = 8 } = {}) {
    const { rows: base } = await pool.query(
      `SELECT id, company_id, qualification, specialisation, skills, experience_years,
              current_company, current_designation, current_city, current_state, location,
              applied_job_id
         FROM candidates
        WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
      [candidate_id, company_id]
    );
    if (!base.length) return null;
    const c = base[0];

    const skills = Array.isArray(c.skills) ? c.skills.map(s => String(s).toLowerCase()) : [];
    const expLow  = c.experience_years != null ? Number(c.experience_years) - 2 : null;
    const expHigh = c.experience_years != null ? Number(c.experience_years) + 2 : null;

    const { rows } = await pool.query(
      `WITH scored AS (
         SELECT o.id, o.candidate_code, o.full_name, o.email, o.photo_url,
                o.qualification, o.specialisation, o.skills, o.experience_years,
                o.current_company, o.current_designation, o.location, o.current_city,
                o.current_state, o.disposition, o.current_stage, o.last_activity_at,
                (SELECT MAX(s.total_score) FROM candidate_screenings s WHERE s.candidate_id = o.id) AS best_screening_score,

                -- Named, additive components. Each is also returned on its own
                -- below so the UI states the reason rather than the total.
                (CASE WHEN $3::text IS NOT NULL AND o.qualification = $3 THEN 12 ELSE 0 END) AS pt_qualification,
                (CASE WHEN $4::text IS NOT NULL AND o.specialisation ILIKE '%' || $4 || '%' THEN 15 ELSE 0 END) AS pt_specialisation,
                (SELECT COUNT(*)::int FROM jsonb_array_elements_text(COALESCE(o.skills,'[]'::jsonb)) AS s(v)
                  WHERE LOWER(s.v) = ANY($5::text[])) AS skill_matches,
                (CASE WHEN $6::numeric IS NOT NULL AND o.experience_years BETWEEN $6 AND $7 THEN 12 ELSE 0 END) AS pt_experience,
                (CASE WHEN $8::text  IS NOT NULL AND o.current_company    ILIKE $8  THEN 8  ELSE 0 END) AS pt_company,
                (CASE WHEN $9::text  IS NOT NULL AND o.current_designation ILIKE '%' || $9 || '%' THEN 14 ELSE 0 END) AS pt_role,
                (CASE WHEN $10::text IS NOT NULL AND (o.current_city ILIKE $10 OR o.location ILIKE '%' || $10 || '%') THEN 10 ELSE 0 END) AS pt_city,
                (CASE WHEN $11::text IS NOT NULL AND o.current_state ILIKE $11 THEN 6 ELSE 0 END) AS pt_state,
                (SELECT COUNT(*)::int FROM candidate_role_suitability r1
                  JOIN candidate_role_suitability r2
                    ON LOWER(r2.department) = LOWER(r1.department) AND r2.candidate_id = $1
                 WHERE r1.candidate_id = o.id) AS shared_departments
           FROM candidates o
          WHERE o.id <> $1
            AND o.deleted_at IS NULL
            AND o.anonymised_at IS NULL
            AND ($2::int IS NULL OR o.company_id = $2)
       )
       SELECT *, (pt_qualification + pt_specialisation + LEAST(skill_matches, 5) * 5
                  + pt_experience + pt_company + pt_role + pt_city + pt_state
                  + LEAST(shared_departments, 3) * 4) AS match_points
         FROM scored
        WHERE (pt_qualification + pt_specialisation + LEAST(skill_matches, 5) * 5
               + pt_experience + pt_company + pt_role + pt_city + pt_state
               + LEAST(shared_departments, 3) * 4) > 0
        ORDER BY match_points DESC, last_activity_at DESC NULLS LAST
        LIMIT $12`,
      [
        candidate_id, company_id,
        c.qualification || null,
        c.specialisation || null,
        skills,
        expLow, expHigh,
        c.current_company ? `%${c.current_company}%` : null,
        c.current_designation || null,
        c.current_city ? `%${c.current_city}%` : null,
        c.current_state ? `%${c.current_state}%` : null,
        Math.min(Math.max(parseInt(limit, 10) || 8, 1), 25),
      ]
    );

    // The explanation is built here rather than in SQL so the sentences live next
    // to the weights that produced them and cannot drift from them.
    return rows.map(r => {
      const reasons = [];
      if (r.pt_qualification)  reasons.push(`Same qualification (${r.qualification})`);
      if (r.pt_specialisation) reasons.push(`Related specialisation (${r.specialisation})`);
      if (r.skill_matches)     reasons.push(`${r.skill_matches} shared skill${r.skill_matches === 1 ? '' : 's'}`);
      if (r.pt_experience)     reasons.push(`Comparable experience (${r.experience_years} yrs)`);
      if (r.pt_role)           reasons.push(`Similar current role (${r.current_designation})`);
      if (r.pt_company)        reasons.push(`Same employer (${r.current_company})`);
      if (r.pt_city)           reasons.push(`Same city (${r.current_city || r.location})`);
      else if (r.pt_state)     reasons.push(`Same state (${r.current_state})`);
      if (r.shared_departments) reasons.push(`Considered for ${r.shared_departments} of the same department${r.shared_departments === 1 ? '' : 's'}`);
      return { ...r, reasons };
    });
  },

  // ── Bulk actions (§22) ────────────────────────────────────────────────────

  /**
   * One transaction for the whole selection, so a bulk action either applies to
   * every candidate the recruiter selected or to none. A partial bulk update is
   * the worst outcome: the recruiter has no way to tell which half went through.
   *
   * Every candidate id is re-checked against the caller's company inside the
   * transaction. Trusting the ids in the body is how a bulk endpoint becomes a
   * cross-tenant write.
   */
  async bulkUpdate({ candidate_ids, action, value }, ctx = {}) {
    const ids = (Array.isArray(candidate_ids) ? candidate_ids : [candidate_ids])
      .map(v => parseInt(v, 10)).filter(Number.isInteger);
    if (!ids.length) {
      const err = new Error('Select at least one candidate.');
      err.status = 400;
      throw err;
    }
    if (ids.length > 200) {
      const err = new Error('Bulk actions are limited to 200 candidates at a time.');
      err.status = 400;
      throw err;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: scoped } = await client.query(
        `SELECT id, full_name, current_stage, disposition FROM candidates
          WHERE id = ANY($1::int[]) AND deleted_at IS NULL
            AND ($2::int IS NULL OR company_id = $2)
          FOR UPDATE`,
        [ids, ctx.company_id]
      );
      if (!scoped.length) { await client.query('ROLLBACK'); return { updated: 0, skipped: ids.length }; }
      const scopedIds = scoped.map(r => r.id);

      let summary = '';
      let eventType = 'bulk_update';

      switch (action) {
        case 'stage': {
          await client.query(
            `UPDATE candidates SET current_stage = $2, updated_at = NOW() WHERE id = ANY($1::int[])`,
            [scopedIds, value]
          );
          // The primary application follows the candidate, exactly as the single
          // move-stage path does — otherwise a bulk move leaves the board and the
          // list disagreeing.
          await client.query(
            `UPDATE candidate_applications SET stage = $2, updated_at = NOW()
              WHERE candidate_id = ANY($1::int[]) AND is_primary = TRUE`,
            [scopedIds, value]
          );
          // Stage history, one row per candidate, so a bulk move is as accountable
          // as a single one.
          await client.query(
            `INSERT INTO candidate_stage_history (company_id, candidate_id, stage, moved_by_user_id, notes)
             SELECT $3, id, $2, $4, 'Bulk stage change' FROM candidates WHERE id = ANY($1::int[])`,
            [scopedIds, value, ctx.company_id, ctx.actor_user_id || null]
          );
          eventType = 'stage_change';
          summary   = `Stage set to ${String(value).replace(/_/g, ' ')} (bulk)`;
          break;
        }
        case 'disposition': {
          await client.query(
            `UPDATE candidates SET disposition = $2, updated_at = NOW()
              WHERE id = ANY($1::int[]) AND disposition <> 'hired'`,
            [scopedIds, value]
          );
          eventType = 'disposition_change';
          summary   = `Candidate status set to ${String(value).replace(/_/g, ' ')} (bulk)`;
          break;
        }
        case 'recruiter': {
          const recruiterId = value == null || value === '' ? null : parseInt(value, 10);
          await client.query(
            `UPDATE candidates SET recruiter_id = $2, updated_at = NOW() WHERE id = ANY($1::int[])`,
            [scopedIds, recruiterId]
          );
          eventType = 'recruiter_assigned';
          summary   = recruiterId ? 'Recruiter assigned (bulk)' : 'Recruiter cleared (bulk)';
          break;
        }
        case 'add_tag':
        case 'remove_tag': {
          const tag = String(value || '').trim();
          if (!tag) { await client.query('ROLLBACK'); const e = new Error('Provide a tag.'); e.status = 400; throw e; }
          if (action === 'add_tag') {
            // jsonb_agg over a DISTINCT union rather than `tags || '["x"]'`, which
            // appends a second copy every time the same tag is applied.
            await client.query(
              `UPDATE candidates c SET tags = COALESCE((
                 SELECT jsonb_agg(DISTINCT v) FROM (
                   SELECT jsonb_array_elements_text(COALESCE(c.tags,'[]'::jsonb)) AS v
                   UNION SELECT $2::text AS v
                 ) u), '[]'::jsonb), updated_at = NOW()
                WHERE c.id = ANY($1::int[])`,
              [scopedIds, tag]
            );
          } else {
            await client.query(
              `UPDATE candidates c SET tags = COALESCE((
                 SELECT jsonb_agg(v) FROM
                   jsonb_array_elements_text(COALESCE(c.tags,'[]'::jsonb)) AS s(v)
                  WHERE LOWER(v) <> LOWER($2)
                ), '[]'::jsonb), updated_at = NOW()
                WHERE c.id = ANY($1::int[])`,
              [scopedIds, tag]
            );
          }
          eventType = action === 'add_tag' ? 'tag_added' : 'tag_removed';
          summary   = `Tag "${tag}" ${action === 'add_tag' ? 'added' : 'removed'} (bulk)`;
          break;
        }
        case 'talent_bank': {
          const poolIds = (Array.isArray(value) ? value : [value])
            .map(v => parseInt(v, 10)).filter(Number.isInteger);
          const { rows: pools } = await client.query(
            `SELECT id, pool_name FROM talent_pools
              WHERE id = ANY($1::int[]) AND ($2::int IS NULL OR company_id = $2)`,
            [poolIds, ctx.company_id]
          );
          for (const cand of scoped) {
            for (const p of pools) {
              await repo._addPoolMemberRow(client, {
                company_id: ctx.company_id, pool_id: p.id, candidate_id: cand.id,
                tags: [], reason: 'Bulk add to Talent Bank',
                source_stage: cand.current_stage, added_by_user_id: ctx.actor_user_id || null,
              });
            }
          }
          await client.query(
            `UPDATE candidates SET disposition = 'talent_bank', updated_at = NOW()
              WHERE id = ANY($1::int[]) AND disposition NOT IN ('hired','blacklisted')`,
            [scopedIds]
          );
          eventType = 'talent_bank_added';
          summary   = pools.length
            ? `Added to the Talent Bank: ${pools.map(p => p.pool_name).join(', ')} (bulk)`
            : 'Added to the Talent Bank (bulk)';
          break;
        }
        default: {
          await client.query('ROLLBACK');
          const err = new Error(`Unknown bulk action "${action}".`);
          err.status = 400;
          throw err;
        }
      }

      // One activity row per candidate. A single "bulk action" event would mean a
      // candidate's own timeline does not show what happened to them.
      for (const cand of scoped) {
        await repo.recordActivity({
          company_id: ctx.company_id, candidate_id: cand.id,
          event_type: eventType, summary,
          detail: { bulk: true, action, value, selection_size: scoped.length },
          actor_user_id: ctx.actor_user_id || null,
          actor_name: ctx.actor_name || null,
        }, client);
      }

      await client.query('COMMIT');
      return { updated: scoped.length, skipped: ids.length - scoped.length, action };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  },

  // ── Work queue (§23) ──────────────────────────────────────────────────────

  /**
   * "My Recruitment Work" — counts, each of which the UI turns into a link.
   *
   * Every count here is a question a recruiter can act on this morning, which is
   * why none of them is a chart. `mine` scopes to the caller's own candidates
   * when they own any; a recruiter with nothing assigned sees the whole company's
   * queue rather than an empty screen that looks broken.
   *
   * The staleness counts measure from `last_activity_at`, which is the whole
   * reason that column was added — the previous implementation measured from
   * created_at and so reported a candidate moved yesterday as waiting 30 days.
   */
  async getWorkQueue(company_id, user_id = null) {
    const LIVE = `('applied','screening','shortlisted','assessment','1st_level','2nd_level','offer','selected')`;

    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM candidates c
           WHERE c.deleted_at IS NULL AND ($1::int IS NULL OR c.company_id = $1)
             AND c.current_stage IN ('applied','screening')
             AND NOT EXISTS (SELECT 1 FROM candidate_screenings s
                              WHERE s.candidate_id = c.id AND s.status = 'completed')
         ) AS needs_screening,

         (SELECT COUNT(*)::int FROM interview_schedules i
           WHERE i.interview_date = CURRENT_DATE AND i.status <> 'cancelled'
             AND ($1::int IS NULL OR i.company_id = $1)
         ) AS interviews_today,

         -- An interview that has happened and has no feedback row. Measured on
         -- the SCHEDULE, not the candidate, because feedback is owed per
         -- interview.
         (SELECT COUNT(*)::int FROM interview_schedules i
           WHERE i.interview_date < CURRENT_DATE AND i.status NOT IN ('cancelled','completed')
             AND ($1::int IS NULL OR i.company_id = $1)
             AND NOT EXISTS (SELECT 1 FROM interview_notes n WHERE n.candidate_id = i.candidate_id)
         ) AS feedback_pending,

         (SELECT COUNT(*)::int FROM candidates c
           WHERE c.deleted_at IS NULL AND ($1::int IS NULL OR c.company_id = $1)
             AND c.current_stage IN ${LIVE}
             AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '3 days'
         ) AS waiting_over_3_days,

         (SELECT COUNT(*)::int FROM offer_letters o
           WHERE o.deleted_at IS NULL AND o.offer_status IN ('draft','sent')
             AND ($1::int IS NULL OR o.company_id = $1)
         ) AS offers_pending,

         (SELECT COUNT(*)::int FROM candidates c
           WHERE c.deleted_at IS NULL AND ($1::int IS NULL OR c.company_id = $1)
             AND c.current_stage IN ('selected','offer') AND c.disposition <> 'hired'
         ) AS joining_pending,

         (SELECT COUNT(*)::int FROM candidate_recontact rc
           JOIN candidates c ON c.id = rc.candidate_id AND c.deleted_at IS NULL
           WHERE rc.status = 'pending' AND rc.recontact_on <= CURRENT_DATE
             AND ($1::int IS NULL OR rc.company_id = $1)
         ) AS recontact_due,

         (SELECT COUNT(DISTINCT rs.candidate_id)::int FROM candidate_role_suitability rs
           JOIN candidates c ON c.id = rs.candidate_id AND c.deleted_at IS NULL
           WHERE rs.status = 'open' AND rs.suitability <> 'not_suitable'
             AND ($1::int IS NULL OR rs.company_id = $1)
             -- Only worth surfacing when there is somewhere to put them.
             AND EXISTS (SELECT 1 FROM job_openings o
                          WHERE o.status = 'open' AND o.deleted_at IS NULL
                            AND LOWER(o.department) = LOWER(rs.department)
                            AND ($1::int IS NULL OR o.company_id = $1))
         ) AS recommended_for_other_roles,

         (SELECT COUNT(*)::int FROM candidates c
           WHERE c.deleted_at IS NULL AND ($1::int IS NULL OR c.company_id = $1)
             AND c.disposition IN ('talent_bank','future_opportunity')
         ) AS talent_bank_size,

         (SELECT COUNT(*)::int FROM candidate_screenings s
           WHERE s.status = 'draft' AND ($1::int IS NULL OR s.company_id = $1)
             AND ($2::int IS NULL OR s.screened_by = $2)
         ) AS my_draft_screenings,

         (SELECT COUNT(*)::int FROM candidates c
           WHERE c.deleted_at IS NULL AND ($1::int IS NULL OR c.company_id = $1)
             AND c.recruiter_id = $2::int AND c.current_stage IN ${LIVE}
         ) AS assigned_to_me,

         (SELECT COUNT(*)::int FROM candidates c
           WHERE c.deleted_at IS NULL AND ($1::int IS NULL OR c.company_id = $1)
             AND c.recruiter_id IS NULL AND c.current_stage IN ${LIVE}
         ) AS unassigned`,
      [company_id, user_id]
    );
    return rows[0];
  },

  // ── Quick view (§8) ───────────────────────────────────────────────────────

  /**
   * Everything the quick-view drawer shows, in ONE round trip.
   *
   * §31's performance requirement is the reason this is a single function rather
   * than the drawer calling six endpoints: a recruiter arrowing through eighty
   * candidates would otherwise fire ~480 requests.
   */
  async getQuickView(candidate_id, company_id = null, { viewer_user_id = null } = {}) {
    const { rows } = await pool.query(
      `SELECT c.*,
              jo.job_title  AS applied_job_title,
              jo.department  AS applied_department,
              COALESCE(re.name, ru.email) AS recruiter_name,
              (SELECT COUNT(*)::int FROM candidate_applications a WHERE a.candidate_id = c.id) AS application_count,
              (SELECT COUNT(*)::int FROM candidate_notes nt
                WHERE nt.candidate_id = c.id AND nt.deleted_at IS NULL
                  AND (nt.visibility <> 'private' OR nt.author_user_id = $3::int)) AS note_count
         FROM candidates c
         LEFT JOIN job_openings jo ON jo.id = c.applied_job_id
         LEFT JOIN users ru        ON ru.id = c.recruiter_id
         LEFT JOIN employees re    ON re.id = ru.employee_id
        WHERE c.id = $1 AND c.deleted_at IS NULL AND ($2::int IS NULL OR c.company_id = $2)`,
      [candidate_id, company_id, viewer_user_id]
    );
    if (!rows.length) return null;
    const candidate = rows[0];

    const [applications, screening, notes, activity, suitability, pools, recontact] = await Promise.all([
      pool.query(
        `SELECT a.*, jo.job_title, jo.department
           FROM candidate_applications a JOIN job_openings jo ON jo.id = a.job_opening_id
          WHERE a.candidate_id = $1 ORDER BY a.is_primary DESC, a.applied_at DESC`,
        [candidate_id]
      ),
      pool.query(
        `SELECT id, application_id, status, total_score, score_breakdown, recommendation,
                decision, learning_mindset, ownership, teamwork, patience,
                problem_solving, communication, adaptability, summary_note, completed_at
           FROM candidate_screenings
          WHERE candidate_id = $1 ORDER BY updated_at DESC LIMIT 1`,
        [candidate_id]
      ),
      pool.query(
        `SELECT n.id, n.note_type, n.body, n.is_pinned, n.created_at,
                COALESCE(e.name, u.email) AS author_name
           FROM candidate_notes n
           LEFT JOIN users u ON u.id = n.author_user_id
           LEFT JOIN employees e ON e.id = u.employee_id
          WHERE n.candidate_id = $1 AND n.deleted_at IS NULL
            AND (n.visibility <> 'private' OR n.author_user_id = $2::int)
          ORDER BY n.is_pinned DESC, n.created_at DESC LIMIT 4`,
        [candidate_id, viewer_user_id]
      ),
      pool.query(
        `SELECT event_type, summary, actor_name, created_at
           FROM candidate_activity WHERE candidate_id = $1
          ORDER BY created_at DESC LIMIT 6`,
        [candidate_id]
      ),
      pool.query(
        `SELECT department, role_title, suitability, reason, status
           FROM candidate_role_suitability WHERE candidate_id = $1
          ORDER BY CASE suitability WHEN 'strong' THEN 0 WHEN 'potential' THEN 1 ELSE 2 END`,
        [candidate_id]
      ),
      pool.query(
        `SELECT tp.id, tp.pool_name, tp.category, m.tags
           FROM talent_pool_members m JOIN talent_pools tp ON tp.id = m.pool_id
          WHERE m.candidate_id = $1 ORDER BY tp.pool_name`,
        [candidate_id]
      ),
      pool.query(
        `SELECT id, recontact_on, potential_role, reason, status
           FROM candidate_recontact WHERE candidate_id = $1 AND status = 'pending'
          ORDER BY recontact_on LIMIT 1`,
        [candidate_id]
      ),
    ]);

    return {
      candidate,
      applications: applications.rows,
      screening: screening.rows[0] || null,
      notes: notes.rows,
      activity: activity.rows,
      suitability: suitability.rows,
      pools: pools.rows,
      recontact: recontact.rows[0] || null,
    };
  },
};

// ── Local helpers ───────────────────────────────────────────────────────────

/** Null unless a real number was supplied. '' from an untouched form input is not a 0. */
function nn(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normaliseList(v) {
  if (v == null || v === '') return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr.map(x => String(x).trim()).filter(Boolean);
}

/**
 * The ONLY screening columns a request may set.
 *
 * An allowlist, not a denylist, and the reason is shared/safeUpdate.js's:
 * spreading the body would let a caller write total_score, recommendation,
 * status, completed_at or screened_by directly — i.e. mark their own screening
 * completed with a score of 100 without answering anything.
 */
const SCREENING_FIELDS = [
  'qualification_fit', 'experience_fit', 'skills_fit', 'notice_fit', 'location_fit', 'salary_fit',
  'learning_mindset', 'ownership', 'teamwork', 'patience', 'problem_solving',
  'communication', 'adaptability', 'relevant_knowledge', 'career_alignment',
  'learning_mindset_evidence', 'ownership_evidence', 'teamwork_evidence',
  'patience_evidence', 'problem_solving_evidence', 'communication_evidence',
  'adaptability_evidence', 'role_alignment_note', 'summary_note',
];

function pickScreeningFields(data = {}) {
  const out = {};
  for (const f of SCREENING_FIELDS) {
    if (data[f] !== undefined && data[f] !== null && data[f] !== '') out[f] = data[f];
  }
  return out;
}

/** §17's categories. Mirrors migration 20260927000002 — see ensureStandardTalentPools. */
const STANDARD_POOLS = [
  ['Electrical', 'engineering', 'Electrical'],
  ['Electronics', 'engineering', 'Electronics'],
  ['Power Electronics', 'engineering', 'Power Electronics'],
  ['SST', 'product', null],
  ['STATCOM', 'product', null],
  ['AHF', 'product', null],
  ['SVG', 'product', null],
  ['HV', 'product', null],
  ['MV', 'product', null],
  ['Embedded', 'engineering', 'Embedded'],
  ['Controls', 'engineering', 'Controls'],
  ['Testing', 'engineering', 'Testing'],
  ['Service', 'operations', 'Service'],
  ['Production', 'operations', 'Production'],
  ['Quality', 'operations', 'Quality'],
  ['Application Engineering', 'engineering', 'Application Engineering'],
  ['Mechanical', 'engineering', 'Mechanical'],
  ['Supply Chain', 'operations', 'Supply Chain'],
  ['Sales', 'commercial', 'Sales'],
  ['Finance', 'corporate', 'Finance'],
  ['HR', 'corporate', 'HR'],
  ['Fresh Graduate', 'pipeline', null],
  ['Future Leadership', 'pipeline', null],
];

export default repo;
