import pool from '../../shared/db.js';
import { QUEUE_PREDICATES, UNANSWERED_OFFERS_SQL } from '../workQueueFilters.js';
import { createEmployeeLogin } from '../../../employees/employee.service.js';
import { nextEmployeeCode, assertCodeAvailable } from '../../../shared/employeeCode.js';
import { getProbationPolicy, probationEndDate, toIsoDate } from '../../../shared/probationDates.js';
import { pickUpdatable } from '../../../shared/safeUpdate.js';
import { nextOfferNumber } from '../../../shared/docNumber.js';
import { triggerEmail } from '../../../services/emailTrigger.js';
import { initOnboardingChecklist } from '../../hr/onboarding.service.js';
// The activity timeline. Imported here rather than called from the route layer so
// that a stage move and its timeline entry are one transaction: a move recorded
// in candidates but missing from the timeline is an unaccountable change, and
// candidates.last_activity_at (which the work queue measures staleness from) is
// written by the same call. candidateIntelligence imports only shared/db.js, so
// there is no cycle.
import candidateIntelligence from './candidateIntelligence.repository.js';

/**
 * The department an interview or an offer belongs to: its own job opening's,
 * else the job the candidate applied to. One rule for the Dashboard numbers
 * and for the Interviews / Offer Management lists their tiles open, so a
 * department-filtered tile and the list behind it agree (Dashboard review
 * 2026-11-17 — interviews were counted company-wide and offers matched on
 * the offer's own job only).
 *
 * @param {string} alias table alias of interview_schedules / offer_letters
 * @returns {string} SQL expression yielding the department (or NULL)
 */
export function recordDepartmentSql(alias) {
  return `COALESCE(
    (SELECT d_jo.department FROM job_openings d_jo WHERE d_jo.id = ${alias}.job_opening_id),
    (SELECT d_cj.department FROM candidates d_c JOIN job_openings d_cj ON d_cj.id = d_c.applied_job_id
      WHERE d_c.id::text = ${alias}.candidate_id::text))`;
}

/**
 * Stage keys → the words a recruiter reads on the timeline.
 *
 * A deliberate duplicate of the frontend's STAGE_LABELS
 * (features/recruitment/shared/constants.js) and the only place the server needs
 * them: activity summaries are composed at WRITE time and stored, so a summary
 * written today must still read correctly after the frontend relabels a stage.
 * That is the point of storing the sentence rather than rebuilding it on read.
 */
const STAGE_DISPLAY = {
  applied: 'Applied',
  screening: 'Screening',
  shortlisted: 'Shortlisted',
  assessment: 'Technical Assessment',
  '1st_level': 'Interview',
  '2nd_level': 'Final Interview',
  offer: 'Offer',
  selected: 'Selected',
  hired: 'Joined',
  not_suitable: 'Not Suitable for Current Role',
  maybe: 'Hold / Review',
  future_use: 'Future Opportunity',
  rejected: 'Rejected from Manifest',
};

/**
 * hireCandidate()'s `loginStatus` → the note on the auto-creation checklist's
 * "Login account created" item. 'created' needs no note; `done` says it.
 */
const LOGIN_STATUS_NOTES = {
  existing_account: 'Not created: an account already exists for this e-mail address. It was left unchanged.',
  no_email:         'Not created: the candidate has no e-mail address to sign in with.',
  failed:           'Not created: login provisioning failed. See the server log.',
};

/** [3, '4', 'x', 4] → [3, 4]. Accepts an array or a JSON/comma string. */
/** Stages the Dept Pipeline report shows as columns, in pipeline order. */
/** Report department filter: null (all), one name, or a list → text[] or null. */
const deptList = (d) => (d == null || d === '' ? null : Array.isArray(d) ? d : [String(d)]);

export const REPORT_PIPELINE_STAGES = ['applied', 'screening', 'shortlisted', 'assessment', '1st_level', '2nd_level', 'offer', 'selected', 'hired'];

export function normaliseIdList(v) {
  let list = v;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { list = list.split(','); }
  }
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map(x => parseInt(x, 10)).filter(x => Number.isInteger(x) && x > 0))];
}

const recruitmentRepository = {
  // ==================== JOB REQUISITIONS ====================
  async createRequisition(data) {
    const {
      job_title, department, department_id, employment_type, number_of_positions,
      job_description, skills_required, location, requested_by_employee_id, company_id, priority,
      experience_min, experience_max, salary_min, salary_max,
      hiring_reason, replacing_employee_id, justification,
    } = data;
    // job_requisitions.department stores a department NAME, not an id. The
    // frontend historically sent it as `department_id`, which made every reader
    // of this payload assume it was a foreign key. `department` is the correct
    // field name; `department_id` stays accepted so older callers keep working.
    const departmentName = department ?? department_id ?? null;
    const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
    const reason = hiring_reason || 'new_position';
    const result = await pool.query(
      `INSERT INTO job_requisitions
         (job_title, department, employment_type, number_of_positions, job_description,
          skills_required, location, requested_by, company_id, status, priority,
          experience_min, experience_max, salary_min, salary_max,
          hiring_reason, replacing_employee_id, justification)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
      [job_title, departmentName, employment_type, number_of_positions, job_description || null,
       skills_required || null, location || null, requested_by_employee_id ?? null, company_id,
       priority || 'medium',
       num(experience_min), num(experience_max), num(salary_min), num(salary_max),
       reason, reason === 'replacement' ? num(replacing_employee_id) : null, justification || null]
    );
    return this.findRequisitionById(result.rows[0].id, company_id);
  },

  // Each row carries what the screen needs to follow the job end to end: who
  // raised it, who is being replaced, the opening it became (and how that
  // opening is doing), and the approver's last decision with its comment —
  // the reason it was sent back was recorded but never shown anywhere.
  _requisitionSelect: `
    SELECT jr.*, e.name AS requested_by_name, re.name AS replacing_employee_name,
           jo.id AS opening_id, jo.job_title AS opening_title, jo.status AS opening_status,
           COALESCE(jo.positions_filled, 0) AS positions_filled,
           (SELECT COUNT(*)::int FROM candidate_applications ca JOIN candidates c ON c.id = ca.candidate_id
             WHERE ca.job_opening_id = jo.id AND c.deleted_at IS NULL) AS applicants_count,
           d.status AS last_decision, d.comments AS last_decision_comment,
           d.decision_date AS last_decision_at, du.name AS last_decision_by
      FROM job_requisitions jr
      LEFT JOIN employees e  ON e.id  = jr.requested_by
      LEFT JOIN employees re ON re.id = jr.replacing_employee_id
      LEFT JOIN LATERAL (SELECT id, job_title, status, positions_filled FROM job_openings
                          WHERE requisition_id = jr.id AND deleted_at IS NULL
                          ORDER BY created_at DESC LIMIT 1) jo ON TRUE
      LEFT JOIN LATERAL (SELECT status, comments, decision_date, approver_id FROM approvals
                          WHERE module_name = 'requisition' AND reference_id = jr.id
                          ORDER BY decision_date DESC NULLS LAST, id DESC LIMIT 1) d ON TRUE
      LEFT JOIN users du ON du.id = d.approver_id`,

  async findRequisitions(filters = {}) {
    let query = `${this._requisitionSelect} WHERE jr.deleted_at IS NULL`;
    const params = [];
    let n = 1;
    if (filters.company_id) { query += ` AND jr.company_id = $${n++}`; params.push(filters.company_id); }
    if (filters.status)     { query += ` AND jr.status = $${n++}`;     params.push(filters.status); }
    if (filters.department) { query += ` AND jr.department = $${n++}`; params.push(filters.department); }
    query += ` ORDER BY jr.created_at DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  async findRequisitionById(id, company_id) {
    const params = [id];
    let extra = '';
    if (company_id) { extra = ` AND jr.company_id = $2`; params.push(company_id); }
    const result = await pool.query(
      `${this._requisitionSelect} WHERE jr.id = $1 AND jr.deleted_at IS NULL${extra}`,
      params
    );
    return result.rows[0];
  },

  // `data` was previously spread straight into the SET clause with the key
  // itself interpolated (not bound) — mass assignment (company_id, deleted_at)
  // plus SQL injection via a crafted key. pickUpdatable() validates every key
  // against the live `job_requisitions` columns; company_id scoping in the
  // WHERE clause (not just a check in the route) closes the cross-tenant
  // write this also had no guard against.
  async updateRequisition(id, data, company_id = null) {
    // Empty strings become NULL so a field can be cleared (and numeric columns
    // don't reject '').
    const input = { ...data };
    for (const k of Object.keys(input)) if (input[k] === '') input[k] = null;
    if (input.hiring_reason === 'new_position') input.replacing_employee_id = null;
    const safe = await pickUpdatable('job_requisitions', input);
    const fields = [];
    const values = [];
    let paramCount = 1;
    Object.keys(safe).forEach(key => {
      fields.push(`${key} = $${paramCount}`);
      values.push(safe[key]);
      paramCount++;
    });
    if (!fields.length) return this.findRequisitionById(id, company_id);
    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    values.push(company_id);
    const result = await pool.query(
      `UPDATE job_requisitions SET ${fields.join(', ')}
        WHERE id = $${paramCount}
          AND ($${paramCount + 1}::int IS NULL OR company_id = $${paramCount + 1})
        RETURNING id`,
      values
    );
    return result.rows[0] ? this.findRequisitionById(result.rows[0].id, company_id) : undefined;
  },

  // Previously had no company_id scoping at all — any authenticated user
  // could soft-delete another company's requisition by id.
  async deleteRequisition(id, company_id = null) {
    await pool.query(
      `UPDATE job_requisitions SET deleted_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [id, company_id]
    );
  },

  // ==================== JOB TIMELINE ====================
  /**
   * One step in a job's life (job_requisition_events, migration
   * 20261117000006). Never throws: the step itself has already happened, and a
   * missing timeline line must not turn a saved change into an error.
   * `db` may be a transaction client.
   */
  async recordJobEvent({ company_id = null, requisition_id, job_opening_id = null, event,
                         from_status = null, to_status = null, comment = null, actor_user_id = null }, db = pool) {
    if (!requisition_id || !event) return;
    try {
      await db.query(
        `INSERT INTO job_requisition_events
           (company_id, requisition_id, job_opening_id, event, from_status, to_status, comment, actor_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [company_id, requisition_id, job_opening_id, event, from_status, to_status, comment || null, actor_user_id]);
    } catch (err) {
      console.warn('[job timeline] could not record', event, 'for requisition', requisition_id, '—', err.message);
    }
  },

  /**
   * The whole story of a job, oldest first: the recorded steps, plus every
   * application and hire on the opening it became (read live from the
   * candidate tables, so they are never out of step with the pipeline).
   */
  async getRequisitionTimeline(requisitionId, company_id) {
    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT e.id::text AS key, e.created_at AS at, e.event, e.from_status, e.to_status, e.comment,
                COALESCE(u.name, u.email) AS actor, NULL::text AS candidate, NULL::int AS candidate_id
           FROM job_requisition_events e
           LEFT JOIN users u ON u.id = e.actor_user_id
          WHERE e.requisition_id = $1 AND ($2::int IS NULL OR e.company_id = $2)
         UNION ALL
         SELECT 'app' || ca.id, COALESCE(ca.applied_at, ca.created_at), 'application', NULL, NULL,
                CASE WHEN ca.origin IS NOT NULL AND ca.origin <> 'applied' THEN ca.origin END,
                NULL, c.full_name, c.id
           FROM candidate_applications ca
           JOIN candidates c ON c.id = ca.candidate_id AND c.deleted_at IS NULL
           JOIN job_openings jo ON jo.id = ca.job_opening_id
          WHERE jo.requisition_id = $1 AND ($2::int IS NULL OR jo.company_id = $2)
         UNION ALL
         SELECT 'hire' || c.id, c.hired_at, 'hired', NULL, NULL, NULL, NULL, c.full_name, c.id
           FROM candidates c
           JOIN job_openings jo ON jo.id = c.applied_job_id
          WHERE jo.requisition_id = $1 AND ($2::int IS NULL OR jo.company_id = $2)
            AND c.hired_at IS NOT NULL AND c.deleted_at IS NULL
       ) t
       ORDER BY at ASC NULLS LAST, key ASC`,
      [requisitionId, company_id ?? null]);
    return rows;
  },

  // ==================== JOB OPENINGS ====================
  async createOpening(data) {
    const {
      requisition_id, job_title, department, location, employment_type,
      experience_min, experience_max, salary_min, salary_max,
      closing_date, company_id, status, benefits, requirements,
      number_of_positions, skills_required,
      // older form-field alias
      description: _desc, job_description,
    } = data;

    // Each value goes to its own column. This used to concatenate skills,
    // "Experience: …" and "Salary: …" into `requirements`, so the Edit form
    // could never show them again and no filter could read them.
    const description = _desc || job_description || null;

    // Concurrency: the caller's route-level "is the requisition approved?" check
    // and this insert used to be separate unlocked statements, so two concurrent
    // POST /openings against the same just-approved requisition could both pass
    // the check before either committed — yielding two openings for one approval.
    // The gate now lives inside the transaction and takes a row lock (FOR UPDATE)
    // on the requisition, so the second caller blocks until the first commits and
    // then reads status='open' rather than 'approved'. Same compare-and-swap
    // intent as acceptOffer()/approveSourceItem(), enforced by a lock because the
    // guard and the write target different tables.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let reqRow = null;
      if (requisition_id) {
        const req = await client.query(
          `SELECT id, status, number_of_positions, skills_required FROM job_requisitions
            WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) AND deleted_at IS NULL
            FOR UPDATE`,
          [requisition_id, company_id]
        );
        if (!req.rows.length) {
          throw Object.assign(new Error('Requisition not found.'), { statusCode: 404 });
        }
        const reqStatus = req.rows[0].status;
        if (reqStatus !== 'approved') {
          // 'open' specifically means this requisition was approved but has already
          // been consumed by another opening — including by the request that just
          // won this row lock. Saying "not approved yet" there would be wrong.
          throw reqStatus === 'open'
            ? Object.assign(
                new Error('A job opening has already been created against this requisition.'),
                { statusCode: 409 })
            : Object.assign(
                new Error(`This requisition has not been approved yet (current status: '${reqStatus}'). Job openings can only be created against an approved requisition.`),
                { statusCode: 400 });
        }
        reqRow = req.rows[0];
      }
      const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
      const result = await client.query(
        `INSERT INTO job_openings
           (requisition_id, job_title, department, location, employment_type,
            experience_min, experience_max, salary_min, salary_max,
            description, requirements, benefits, closing_date, company_id, status,
            number_of_positions, skills_required)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [requisition_id || null, job_title, department, location, employment_type,
         num(experience_min), num(experience_max), num(salary_min), num(salary_max),
         description, requirements || null, benefits || null, closing_date || null, company_id,
         status || 'open',
         num(number_of_positions) ?? num(reqRow?.number_of_positions) ?? 1,
         skills_required || reqRow?.skills_required || null]
      );
      if (requisition_id) {
        await client.query(`UPDATE job_requisitions SET status = 'open' WHERE id = $1`, [requisition_id]);
      }
      await client.query('COMMIT');
      return result.rows[0];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },

  async findOpenings(filters = {}) {
    let query = `
      SELECT jo.*,
             jr.job_title AS req_job_title, jr.department AS req_department,
             COALESCE(jo.number_of_positions, jr.number_of_positions, 1) AS number_of_positions,
             jr.status AS requisition_status, jr.priority AS requisition_priority,
             jr.employment_type AS req_employment_type,
             jr.location AS req_location, jr.salary_min AS req_salary_min, jr.salary_max AS req_salary_max,
             -- Counts APPLICATIONS, not candidates-whose-primary-job-is-this-one.
             -- candidates.applied_job_id holds only the primary application, so a
             -- candidate recommended onto this opening was invisible in its own
             -- applicant count — the number on the board disagreed with the list
             -- underneath it.
             (SELECT COUNT(*)::int
                FROM candidate_applications ca
                JOIN candidates c ON c.id = ca.candidate_id
               WHERE ca.job_opening_id = jo.id AND c.deleted_at IS NULL) AS applicants_count
      FROM job_openings jo
      LEFT JOIN job_requisitions jr ON jo.requisition_id = jr.id
      WHERE jo.deleted_at IS NULL`;
    const params = [];
    let n = 1;
    if (filters.company_id) { query += ` AND jo.company_id = $${n++}`; params.push(filters.company_id); }
    if (filters.status)     { query += ` AND jo.status = $${n++}`;     params.push(filters.status); }
    query += ` ORDER BY jo.created_at DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  async findOpeningById(id, company_id) {
    const params = [id];
    let extra = '';
    if (company_id) { extra = ` AND jo.company_id = $2`; params.push(company_id); }
    const result = await pool.query(
      `SELECT jo.*,
              jr.job_title AS req_job_title, jr.department AS req_department,
              COALESCE(jo.number_of_positions, jr.number_of_positions, 1) AS number_of_positions,
              jr.status AS requisition_status, jr.priority AS requisition_priority,
              jr.employment_type AS req_employment_type,
              jr.location AS req_location, jr.salary_min AS req_salary_min, jr.salary_max AS req_salary_max,
              jr.job_description AS req_job_description, jr.experience_min AS req_experience_min, jr.experience_max AS req_experience_max,
              -- Counts APPLICATIONS, not candidates-whose-primary-job-is-this-one.
             -- candidates.applied_job_id holds only the primary application, so a
             -- candidate recommended onto this opening was invisible in its own
             -- applicant count — the number on the board disagreed with the list
             -- underneath it.
             (SELECT COUNT(*)::int
                FROM candidate_applications ca
                JOIN candidates c ON c.id = ca.candidate_id
               WHERE ca.job_opening_id = jo.id AND c.deleted_at IS NULL) AS applicants_count
       FROM job_openings jo
       LEFT JOIN job_requisitions jr ON jo.requisition_id = jr.id
       WHERE jo.id = $1 AND jo.deleted_at IS NULL${extra}`,
      params
    );
    return result.rows[0];
  },

  // Same key-interpolation mass-assignment/injection issue as updateRequisition
  // above — see that comment.
  async updateOpening(id, data, company_id = null) {
    // The older form sent job_description; the column is description. Empty
    // strings become NULL so a field can be cleared (and numeric columns don't
    // reject '').
    const input = { ...data };
    if (input.job_description !== undefined && input.description === undefined) input.description = input.job_description;
    for (const k of Object.keys(input)) if (input[k] === '') input[k] = null;
    const safe = await pickUpdatable('job_openings', input);
    const fields = [];
    const values = [];
    let paramCount = 1;
    Object.keys(safe).forEach(key => {
      fields.push(`${key} = $${paramCount}`);
      values.push(safe[key]);
      paramCount++;
    });
    if (!fields.length) return this.findOpeningById(id, company_id);
    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    values.push(company_id);
    const result = await pool.query(
      `UPDATE job_openings SET ${fields.join(', ')}
        WHERE id = $${paramCount}
          AND ($${paramCount + 1}::int IS NULL OR company_id = $${paramCount + 1})
        RETURNING *`,
      values
    );
    return result.rows[0];
  },

  // ==================== CANDIDATES ====================
  // Single creation path for /recruitment/candidates, /recruitment/candidates/bulk
  // (via bulkCreateCandidates, which batches this same column set for
  // performance), and /talent/resumes (source: 'resume_db', no applied_job_id).
  // The extra profile fields (current_company..notes) were previously only
  // handled by /talent/resumes' own separate INSERT — accepting them here too
  // means a resume-sourced candidate keeps that data once routed through this
  // one method, and the two job-application callers simply leave them null.
  // `skills` must reach the INSERT as a real array. On the multipart path
  // (POST /recruitment/candidates) multer hands every field over as a string, so
  // JSON.stringify() below was stringifying an already-JSON string and storing a
  // jsonb STRING SCALAR rather than an array. One such row was enough to 500
  // GET /talent/resumes/skills for the whole company — jsonb_array_elements_text
  // raises "cannot extract elements from a scalar" and the skill-filter chips die
  // for every user until someone repairs the row by hand. Normalising here covers
  // every caller instead of each one remembering.
  _normaliseSkills(skills) {
    if (skills == null || skills === '') return [];
    if (Array.isArray(skills)) return skills.filter(x => x != null && String(x).trim() !== '');
    if (typeof skills === 'string') {
      const t = skills.trim();
      if (!t) return [];
      try {
        const parsed = JSON.parse(t);
        return Array.isArray(parsed) ? parsed.filter(x => x != null && String(x).trim() !== '')
                                     : [String(parsed)].filter(x => x.trim() !== '');
      } catch {
        // Not JSON — accept the comma-separated form a human would type.
        return t.split(',').map(x => x.trim()).filter(Boolean);
      }
    }
    return [];
  },

  async createCandidate(data) {
    const {
      full_name, email, phone, resume_file_url, source, applied_job_id, company_id, source_agency_id,
      current_company, current_designation, experience_years, notice_period_days, expected_ctc, notes,
      location, qualification, specialisation, institution, graduation_year,
      resume_text, parse_source,
      consent_basis, consent_text, consent_source, retention_months,
    } = data;
    const skills = this._normaliseSkills(data.skills);

    // Duplicate-candidate guard. `candidates_company_email_uniq` (migration
    // 20260812000004) is the real backstop; this check exists so the common case
    // returns an actionable message naming the existing record instead of a raw
    // Postgres unique-violation string. Same normalisation as the index.
    if (email && String(email).trim()) {
      const { rows: dupe } = await pool.query(
        `SELECT id, full_name, current_stage FROM candidates
          WHERE company_id = $1 AND LOWER(TRIM(email)) = LOWER(TRIM($2)) AND deleted_at IS NULL
          LIMIT 1`,
        [company_id, email]
      );
      if (dupe.length) {
        throw Object.assign(
          new Error(`${dupe[0].full_name} is already in the pipeline with this email address (currently at the ${dupe[0].current_stage} stage). Open their existing record instead of creating a second one.`),
          { statusCode: 409, existingCandidateId: dupe[0].id }
        );
      }
    }

    // An opening that is closed/filled should not accept new applicants — the
    // insert previously succeeded silently, so recruiters could keep sourcing
    // against a req that was already closed by someone else.
    if (applied_job_id) {
      const { rows: opening } = await pool.query(
        `SELECT status FROM job_openings WHERE id = $1 AND deleted_at IS NULL`,
        [applied_job_id]
      );
      if (!opening.length) {
        throw Object.assign(new Error('That job opening no longer exists.'), { statusCode: 400 });
      }
      if (['closed', 'cancelled', 'on_hold'].includes((opening[0].status || '').toLowerCase())) {
        throw Object.assign(
          new Error(`This job opening is ${opening[0].status} and is no longer accepting candidates.`),
          { statusCode: 409 }
        );
      }
    }

    const result = await pool.query(
      // `location` is added here because the column has always existed and NO
      // endpoint ever wrote it — which is why filtering candidates by city was
      // impossible despite the field being present in the schema.
      `INSERT INTO candidates
         (full_name, email, phone, resume_file_url, source, applied_job_id,
          company_id, source_agency_id, current_company, current_designation,
          experience_years, notice_period_days, expected_ctc, skills, notes,
          location, qualification, specialisation, institution, graduation_year,
          resume_text, parsed_at, parse_source,
          consent_basis, consent_at, consent_text, consent_source, retain_until,
          current_stage, overall_status)
       -- Every parameter that appears BOTH as an inserted value and inside a
       -- CASE carries the same explicit cast in both places. Mixing a bare $n
       -- with a cast $n::type in one statement is what Postgres rejects as
       -- "inconsistent types deduced for parameter $n" — at parse time, so the
       -- whole insert fails rather than degrading.
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,
               $17,$18,$19,$20,$21::text,
               CASE WHEN $21::text IS NULL THEN NULL ELSE NOW() END, $22,
               $23::varchar,
               -- consent_at and retain_until are DERIVED, never taken from the
               -- caller: a consent timestamp supplied by the client is not
               -- evidence of anything.
               CASE WHEN $23::varchar IS NULL THEN NULL ELSE NOW() END,
               $24, $25,
               CASE WHEN $26::int IS NULL THEN NULL
                    ELSE (CURRENT_DATE + ($26::int * INTERVAL '1 month'))::date END,
               'applied','active') RETURNING *`,
      [full_name, email, phone, resume_file_url, source, applied_job_id || null, company_id, source_agency_id || null,
       current_company || null, current_designation || null,
       experience_years ?? null, notice_period_days ?? null, expected_ctc ?? null,
       JSON.stringify(skills), notes || null, location || null,
       qualification || null, specialisation || null, institution || null, graduation_year ?? null,
       resume_text || null, parse_source || null,
       consent_basis || null, consent_text || null, consent_source || null,
       consent_basis ? (retention_months ?? null) : null]
    );
    await pool.query(
      `INSERT INTO candidate_stage_history (candidate_id, stage, notes)
       VALUES ($1, 'applied', 'Application received')`,
      [result.rows[0].id]
    );
    // Mirror the primary application into candidate_applications so the two
    // representations cannot diverge. A speculative candidate (no opening) gets
    // no row -- they have not applied to anything, which is what the talent
    // pool is for.
    if (applied_job_id) {
      await pool.query(
        `INSERT INTO candidate_applications
           (company_id, candidate_id, job_opening_id, stage, status, origin, is_primary, applied_at)
         VALUES ($1,$2,$3,'applied','active','applied',true, NOW())
         ON CONFLICT (candidate_id, job_opening_id) DO NOTHING`,
        [company_id, result.rows[0].id, applied_job_id]
      );
    }
    return result.rows[0];
  },

  async bulkCreateCandidates(candidates) {
    if (!candidates.length) return [];

    // Same duplicate guard as createCandidate(), applied to the batch: drop rows
    // that collide with an existing candidate OR with an earlier row in this same
    // upload. Without this the whole multi-row INSERT aborts on the first
    // collision with candidates_company_email_uniq, losing every good row with it
    // — a bulk resume import is exactly where duplicates are most likely.
    const norm = (e) => String(e || '').trim().toLowerCase();
    const withEmail = candidates.filter(c => norm(c.email));
    let existingEmails = new Set();
    if (withEmail.length) {
      const { rows } = await pool.query(
        `SELECT company_id, LOWER(TRIM(email)) AS em FROM candidates
          WHERE deleted_at IS NULL AND LOWER(TRIM(email)) = ANY($1::text[])`,
        [withEmail.map(c => norm(c.email))]
      );
      existingEmails = new Set(rows.map(r => `${r.company_id}|${r.em}`));
    }
    const seen = new Set();
    const skipped = [];
    candidates = candidates.filter(c => {
      const key = `${c.company_id}|${norm(c.email)}`;
      if (!norm(c.email)) return true;
      if (existingEmails.has(key) || seen.has(key)) {
        skipped.push({ full_name: c.full_name, email: c.email });
        return false;
      }
      seen.add(key);
      return true;
    });
    if (!candidates.length) {
      const err = new Error('Every candidate in this file is already in the pipeline.');
      return Object.assign([], { skipped, error: err.message });
    }

    // Single multi-row INSERT — avoids N+1 round-trips (was 2× queries per candidate)
    const cols = `(full_name, email, phone, resume_file_url, source, applied_job_id,
                   company_id, source_agency_id, current_stage, overall_status)`;
    const params = [];
    const rows = candidates.map((c, i) => {
      const b = i * 8;
      params.push(
        c.full_name, c.email, c.phone, c.resume_file_url,
        c.source, c.applied_job_id, c.company_id, c.source_agency_id || null
      );
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},'applied','active')`;
    });
    const inserted = await pool.query(
      `INSERT INTO candidates ${cols} VALUES ${rows.join(',')} RETURNING *`,
      params
    );

    // Single INSERT for all stage history rows
    const histParams = [];
    const histRows = inserted.rows.map((row, i) => {
      const b = i * 3;
      histParams.push(row.id, 'applied', 'Application received');
      return `($${b+1},$${b+2},$${b+3})`;
    });
    await pool.query(
      `INSERT INTO candidate_stage_history (candidate_id, stage, notes) VALUES ${histRows.join(',')}`,
      histParams
    );

    // `skipped` rides along on the array so the route can tell the uploader which
    // rows were duplicates without changing the endpoint's array response shape.
    return Object.assign(inserted.rows, { skipped });
  },

  /**
   * Candidate search.
   *
   * This accepted four predicates — job, stage, status, and a name/email ILIKE —
   * and returned every matching row with no LIMIT. Recruiter questions of the
   * ordinary kind ("BE Electrical, 2+ years, power electronics, Bengaluru,
   * notice under 60 days") could not be expressed at all, even where the column
   * existed, so the Candidates page filtered client-side over whatever the
   * unbounded query happened to return.
   *
   * Every filter below reads a column that already exists. Education is still
   * absent — `candidates` has no qualification or specialisation column, and
   * adding one is schema work, not a query change — so that part of the search
   * remains genuinely unavailable rather than quietly approximated.
   *
   * Returns `{ rows, total, limit, offset }`. Callers that want the bare array
   * (the legacy shape) pass `raw: true`.
   */
  async findCandidates(filters = {}) {
    const where = ['c.deleted_at IS NULL'];
    const params = [];
    let n = 1;
    const add = (clause, ...values) => { where.push(clause); params.push(...values); };

    if (filters.company_id)     { add(`c.company_id = $${n++}`, filters.company_id); }
    if (filters.applied_job_id) { add(`c.applied_job_id = $${n++}`, filters.applied_job_id); }
    if (filters.current_stage)  { add(`c.current_stage = $${n++}`, filters.current_stage); }
    // ?queue=<key> — the work queue's own rule for that tile (workQueueFilters.js),
    // so "8 need screening" opens exactly those eight. Unknown keys are ignored.
    if (filters.queue && Object.hasOwn(QUEUE_PREDICATES, filters.queue)) { add(`(${QUEUE_PREDICATES[filters.queue]})`); }
    if (filters.overall_status) { add(`c.overall_status = $${n++}`, filters.overall_status); }
    if (filters.source)         { add(`c.source = $${n++}`, filters.source); }

    // Free text now reaches the fields a recruiter actually searches by —
    // employer and job title included, not just name and email.
    if (filters.search) {
      // §6 requires searching by phone and by candidate ID as well. Both were
      // missing: a recruiter with a phone number in front of them — the most
      // common way a candidate is identified on a call — could not find them at
      // all, and the candidate code did not exist until migration
      // 20260927000001 added it.
      //
      // Two bindings, not one. $like carries the ILIKE wildcards; $raw is the
      // term as typed, because the phone comparison strips it to digits and
      // stripping '%' characters back out inside SQL would be worse. Built with
      // both placeholders from the start rather than rewriting the clause
      // afterwards: a String.replace() over SQL containing '$' has already eaten
      // a '$$' in this codebase once.
      const like = n++;
      const raw  = n++;
      add(
        `(c.full_name ILIKE $${like} OR c.email ILIKE $${like}
          OR c.current_company ILIKE $${like} OR c.current_designation ILIKE $${like}
          OR c.location ILIKE $${like} OR c.current_city ILIKE $${like}
          OR c.candidate_code ILIKE $${like}
          -- Phone matched on DIGITS ONLY on both sides, so "+91 98765 43210",
          -- "919876543210" and "9876543210" all find each other. The 4-digit
          -- floor stops a search for "a" from digit-matching every row.
          --
          -- '[^0-9]', not '\D': this SQL is inside a JS template literal, where a
          -- lone backslash before an unrecognised escape character is silently
          -- DROPPED. '\D' reached Postgres as 'D' and the clause quietly matched
          -- the letter D instead of every non-digit, so phone search returned
          -- nothing while looking correct in the source. A character class has no
          -- backslash to lose. (regexp_replace's own docs use the same form, and
          -- so does generateOfficeId lower down this file.)
          OR (LENGTH(REGEXP_REPLACE($${raw}, '[^0-9]', '', 'g')) >= 4
              AND REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g')
                  LIKE '%' || REGEXP_REPLACE($${raw}, '[^0-9]', '', 'g') || '%'))`,
        `%${filters.search}%`,
        String(filters.search),
      );
    }

    // §6's remaining filters. Each one was listed in the brief and none of them
    // reached the database before.
    if (filters.department) {
      add(`EXISTS (SELECT 1 FROM job_openings d
                   WHERE d.id = c.applied_job_id AND LOWER(d.department) = LOWER($${n++}))`,
          filters.department);
    }
    if (filters.recruiter_id === 'unassigned') {
      add(`c.recruiter_id IS NULL`);
    } else if (filters.recruiter_id) {
      add(`c.recruiter_id = $${n++}`, parseInt(filters.recruiter_id, 10));
    }
    if (filters.disposition) { add(`c.disposition = $${n++}`, filters.disposition); }
    if (filters.classification) { add(`c.classification = $${n++}`, filters.classification); }
    if (filters.willing_to_relocate === 'true') {
      // "Willing to relocate" is a question about three of the seven stored
      // values, not one. Asking for = 'willing' would hide everybody who said
      // "yes, with support" — most of them, for a Srivilliputtur site.
      add(`c.willing_to_relocate IN ('already_local','willing','willing_with_support')`);
    } else if (filters.willing_to_relocate) {
      add(`c.willing_to_relocate = $${n++}`, filters.willing_to_relocate);
    }
    if (filters.pool_id) {
      add(`EXISTS (SELECT 1 FROM talent_pool_members m
                   WHERE m.candidate_id = c.id AND m.pool_id = $${n++})`,
          parseInt(filters.pool_id, 10));
    }
    const tagList = this._normaliseSkills(filters.tags);
    if (tagList.length) {
      add(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(c.tags,'[]'::jsonb)) AS t(v)
                   WHERE LOWER(t.v) = ANY($${n++}::text[]))`,
          tagList.map(t => String(t).toLowerCase()));
    }
    // Applied-date window. ::date on both sides so a same-day `applied_to` includes
    // that whole day — comparing a DATE against a TIMESTAMPTZ would silently mean
    // "up to midnight" and drop everything applied during the day asked for.
    if (filters.applied_from) { add(`c.created_at::date >= $${n++}::date`, filters.applied_from); }
    if (filters.applied_to)   { add(`c.created_at::date <= $${n++}::date`, filters.applied_to); }
    // §6's "waiting more than N days" column, measured from last_activity_at for
    // the reason the work queue is: age is not the same question as staleness.
    if (filters.stale_days != null && filters.stale_days !== '') {
      add(`COALESCE(c.last_activity_at, c.created_at) < NOW() - ($${n++} || ' days')::interval`,
          String(parseInt(filters.stale_days, 10) || 0));
    }

    // Location is a partial match: "Bengaluru" should find "Bengaluru, KA".
    if (filters.location) { add(`c.location ILIKE $${n++}`, `%${filters.location}%`); }

    // Education — the audit's worked example ("BE Electrical") needed both.
    // `qualification` is an exact match against a constrained vocabulary;
    // `specialisation` is partial, because "Electronics" should find
    // "Electronics and Communication".
    if (filters.qualification) {
      const quals = Array.isArray(filters.qualification) ? filters.qualification : [filters.qualification];
      add(`c.qualification = ANY($${n++}::text[])`, quals);
    }
    if (filters.specialisation) { add(`c.specialisation ILIKE $${n++}`, `%${filters.specialisation}%`); }
    if (filters.graduation_year_min != null && filters.graduation_year_min !== '') {
      add(`c.graduation_year >= $${n++}`, Number(filters.graduation_year_min));
    }

    // Full-text over the résumé body, backed by the GIN index. plainto_tsquery
    // (not to_tsquery) because the input is a recruiter's phrase, not tsquery
    // syntax — an unescaped "&" or ":" would otherwise raise a syntax error.
    if (filters.resume_text) {
      add(`to_tsvector('english', COALESCE(c.resume_text, '')) @@ plainto_tsquery('english', $${n++})`,
          filters.resume_text);
    }

    // Experience as a band. Both ends optional so "2+ years" and "under 5" work.
    if (filters.experience_min != null && filters.experience_min !== '') {
      add(`c.experience_years >= $${n++}`, Number(filters.experience_min));
    }
    if (filters.experience_max != null && filters.experience_max !== '') {
      add(`c.experience_years <= $${n++}`, Number(filters.experience_max));
    }

    // "Available within N days". A candidate with no notice period recorded is
    // INCLUDED rather than filtered out — an unknown notice period is not
    // evidence of a long one, and excluding them hides real candidates.
    if (filters.notice_period_max != null && filters.notice_period_max !== '') {
      add(`(c.notice_period_days IS NULL OR c.notice_period_days <= $${n++})`,
          Number(filters.notice_period_max));
    }

    if (filters.expected_ctc_max != null && filters.expected_ctc_max !== '') {
      add(`(c.expected_ctc IS NULL OR c.expected_ctc <= $${n++})`, Number(filters.expected_ctc_max));
    }

    if (filters.min_rating != null && filters.min_rating !== '') {
      add(`c.overall_rating >= $${n++}`, Number(filters.min_rating));
    }

    // Skills: every named skill must be present (AND, not OR) — a search for
    // "Power Electronics, MATLAB" means both, which is the whole point of
    // naming two. Case-insensitive, so the stored casing does not matter.
    const skills = this._normaliseSkills(filters.skills);
    if (skills.length) {
      add(
        `EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(COALESCE(c.skills, '[]'::jsonb)) AS s(v)
            WHERE LOWER(s.v) = ANY($${n++}::text[])
           HAVING COUNT(DISTINCT LOWER(s.v)) = $${n++}
         )`,
        skills.map(x => String(x).toLowerCase()),
        skills.length
      );
    }

    const whereSql = where.join(' AND ');

    // §6's sort list. Every key here is an allowlisted COLUMN NAME, never
    // interpolated from the request — the value below is concatenated into the
    // SQL, so an unknown sort_by must fall back rather than pass through.
    const SORTABLE = {
      created_at: 'c.created_at', full_name: 'c.full_name',
      experience_years: 'c.experience_years', overall_rating: 'c.overall_rating',
      expected_ctc: 'c.expected_ctc', notice_period_days: 'c.notice_period_days',
      last_activity_at: 'COALESCE(c.last_activity_at, c.created_at)',
      current_stage: 'c.current_stage', overall_status: 'c.overall_status',
      disposition: 'c.disposition', location: 'c.location', source: 'c.source',
    };
    // Allowlisted, never interpolated from the request — this string is
    // concatenated into the SQL.
    const sortCol = SORTABLE[filters.sort_by] || 'c.created_at';
    const sortDir = String(filters.sort_dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // Unbounded reads are how a candidate list becomes a slow page and an
    // accidental full-database export. The default is deliberately generous
    // (200) so existing screens that render the whole list are unaffected at
    // realistic data volumes, with a hard ceiling that cannot be raised from
    // the query string.
    const limit  = Math.min(Math.max(parseInt(filters.limit, 10) || 200, 1), 500);
    const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM candidates c WHERE ${whereSql}`, params
    );

    const rowsRes = await pool.query(
      // The extra columns are §6's list columns: Recruiter, Last Activity and
      // Screening Status. All three are computed here rather than fetched
      // per-row by the browser — a list of 200 candidates each asking for its own
      // screening state is 200 requests, which is what §31 is about.
      `SELECT c.*, jo.id AS job_opening_id,
              COALESCE(jo.job_title, jr.job_title) AS job_title,
              jo.department AS job_department,
              COALESCE(re.name, ru.email) AS recruiter_name,
              COALESCE(c.last_activity_at, c.created_at) AS last_activity,
              DATE_PART('day', NOW() - COALESCE(c.last_activity_at, c.created_at))::int AS days_since_activity,
              sc.status      AS screening_status,
              sc.total_score AS screening_score,
              sc.decision    AS screening_decision,
              (SELECT COUNT(*)::int FROM candidate_applications a WHERE a.candidate_id = c.id) AS application_count,
              (SELECT COUNT(*)::int FROM candidate_notes nt
                WHERE nt.candidate_id = c.id AND nt.deleted_at IS NULL AND nt.visibility <> 'private') AS note_count
         FROM candidates c
         LEFT JOIN job_openings jo ON c.applied_job_id = jo.id
         LEFT JOIN job_requisitions jr ON jo.requisition_id = jr.id
         LEFT JOIN users ru     ON ru.id = c.recruiter_id
         LEFT JOIN employees re ON re.id = ru.employee_id
         -- LATERAL, not a plain LEFT JOIN: a candidate can hold several screenings
         -- (one per application), and joining the table directly would multiply
         -- every candidate row by their screening count and silently inflate the
         -- list. This is the multi-child fan-out that has bitten this codebase
         -- before. Most recent screening only.
         LEFT JOIN LATERAL (
           SELECT s.status, s.total_score, s.decision
             FROM candidate_screenings s
            WHERE s.candidate_id = c.id
            ORDER BY s.updated_at DESC
            LIMIT 1
         ) sc ON TRUE
        WHERE ${whereSql}
        ORDER BY ${sortCol} ${sortDir} NULLS LAST, c.id DESC
        LIMIT $${n++} OFFSET $${n++}`,
      [...params, limit, offset]
    );

    if (filters.raw) return rowsRes.rows;
    return { rows: rowsRes.rows, total: countRes.rows[0].total, limit, offset };
  },

  // ==================== APPLICATIONS (candidate x opening) ====================
  // See migration 20260917000034 for why this table exists. In short:
  // candidates.applied_job_id is a scalar, so "recommend this candidate for
  // another opening" had nowhere to record the second consideration without
  // destroying the first.

  /** Every opening this candidate is being considered for. Primary first. */
  async findCandidateApplications(candidate_id, company_id = null) {
    const { rows } = await pool.query(
      `SELECT ca.*,
              jo.job_title, jo.department, jo.location, jo.status AS opening_status,
              src.job_title AS recommended_from_title,
              u.email       AS recommended_by_email
         FROM candidate_applications ca
         JOIN job_openings jo       ON jo.id  = ca.job_opening_id
         LEFT JOIN job_openings src ON src.id = ca.recommended_from_job_id
         LEFT JOIN users u          ON u.id   = ca.recommended_by
        WHERE ca.candidate_id = $1
          AND ($2::int IS NULL OR ca.company_id = $2)
        ORDER BY ca.is_primary DESC, ca.applied_at DESC`,
      [candidate_id, company_id]
    );
    return rows;
  },

  /**
   * Recommend a candidate for one or more other openings.
   *
   * The requirement this satisfies, in the brief's own words: HR assesses
   * someone for Electrical Engineer, decides they suit Service Engineer better,
   * and puts them forward in one action -- without a duplicate profile, without
   * losing the original application, and with the two tracked separately.
   *
   * Every target is validated and inserted in ONE transaction, so a request
   * naming three openings where the second is closed records all three or none.
   * ON CONFLICT DO NOTHING makes a repeated recommendation a no-op rather than
   * an error, and the skipped ones come back so the caller can say which were
   * already there.
   */
  async recommendCandidateForJobs(candidate_id, job_opening_ids, {
    company_id = null, recommended_by = null, notes = null,
  } = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: cand } = await client.query(
        `SELECT id, full_name, applied_job_id, company_id, disposition, current_stage
           FROM candidates
          WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)
          FOR UPDATE`,
        [candidate_id, company_id]
      );
      if (!cand.length) throw Object.assign(new Error('Candidate not found'), { statusCode: 404 });
      const candidate = cand[0];

      // Openings must exist, belong to this company, and still be taking people.
      // Validated as a set so the error names every bad id at once instead of
      // making the recruiter discover them one failed request at a time.
      const { rows: openings } = await client.query(
        `SELECT id, job_title, status
           FROM job_openings
          WHERE id = ANY($1::int[]) AND deleted_at IS NULL
            AND ($2::int IS NULL OR company_id = $2)`,
        [job_opening_ids, company_id]
      );
      const found   = new Set(openings.map(o => o.id));
      const missing = job_opening_ids.filter(id => !found.has(id));
      if (missing.length) {
        throw Object.assign(
          new Error(`These job openings do not exist or belong to another company: ${missing.join(', ')}`),
          { statusCode: 404 }
        );
      }
      const shut = openings.filter(o => ['closed', 'cancelled', 'on_hold'].includes((o.status || '').toLowerCase()));
      if (shut.length) {
        throw Object.assign(
          new Error(`Not accepting candidates: ${shut.map(o => `${o.job_title} (${o.status})`).join(', ')}`),
          { statusCode: 409 }
        );
      }

      const created = [];
      const alreadyThere = [];
      for (const opening of openings) {
        const { rows } = await client.query(
          `INSERT INTO candidate_applications
             (company_id, candidate_id, job_opening_id, stage, status, origin,
              is_primary, recommended_by, recommended_from_job_id, notes)
           VALUES ($1,$2,$3,'applied','active','recommended',false,$4,$5,$6)
           ON CONFLICT (candidate_id, job_opening_id) DO NOTHING
           RETURNING *`,
          [candidate.company_id, candidate_id, opening.id, recommended_by,
           candidate.applied_job_id || null, notes]
        );
        if (rows.length) created.push({ ...rows[0], job_title: opening.job_title });
        else alreadyThere.push({ id: opening.id, job_title: opening.job_title });
      }

      // ── Back from the Talent Bank ─────────────────────────────────────────
      // Putting a kept candidate forward for a new opening is the point of the
      // Talent Bank. Before 2026-11-17 the new application was added but the
      // candidate still read "Talent Bank / Future use": hidden from the live
      // pipeline board (which reads candidates.current_stage) and still due a
      // recontact reminder. Now, when their main application is parked
      // (future_use) or finished, the new application becomes the main one, the
      // candidate's stage follows it, the status goes back to active and any
      // pending reminder is closed as done.
      let broughtBack = false;
      if (created.length) {
        const first = created[0];
        const { rows: prim } = await client.query(
          `SELECT id, stage FROM candidate_applications
            WHERE candidate_id = $1 AND is_primary = TRUE LIMIT 1`,
          [candidate_id]
        );
        const parked = !prim.length || ['future_use', 'rejected', 'not_suitable'].includes(prim[0].stage);
        const banked = ['talent_bank', 'future_opportunity', 'inactive'].includes(candidate.disposition)
          || candidate.current_stage === 'future_use';
        if (parked && banked) {
          if (prim.length) {
            await client.query(`UPDATE candidate_applications SET is_primary = FALSE, updated_at = NOW() WHERE id = $1`, [prim[0].id]);
          }
          await client.query(`UPDATE candidate_applications SET is_primary = TRUE, updated_at = NOW() WHERE id = $1`, [first.id]);
          await client.query(
            `UPDATE candidates
                SET current_stage = 'applied', applied_job_id = $2, updated_at = NOW()
              WHERE id = $1 AND current_stage NOT IN ('hired','offer','selected')`,
            [candidate_id, first.job_opening_id]
          );
          await client.query(
            `INSERT INTO candidate_stage_history (candidate_id, stage, moved_by, notes, moved_by_user_id, company_id)
             VALUES ($1, 'applied', NULL, $2, $3, $4)`,
            [candidate_id, `Back from the Talent Bank — put forward for ${first.job_title}`,
             recommended_by, candidate.company_id]
          );
          first.is_primary = true;
          broughtBack = true;
        }
        await client.query(
          `UPDATE candidates SET disposition = 'active', updated_at = NOW()
            WHERE id = $1 AND disposition IN ('talent_bank','future_opportunity','inactive')`,
          [candidate_id]
        );
        await client.query(
          `UPDATE candidate_recontact
              SET status = 'done', completed_at = NOW(), completed_by = $2,
                  outcome_note = $3, updated_at = NOW()
            WHERE candidate_id = $1 AND status = 'pending'`,
          [candidate_id, recommended_by, `Put forward for ${created.map(a => a.job_title).join(', ')}`]
        );
      }

      await client.query('COMMIT');
      return { candidate, created, alreadyThere, broughtBack };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * Move ONE application through its own pipeline.
   *
   * A secondary application's stage is its own -- "rejected for Electrical
   * Engineer, shortlisted for Service Engineer" is the ordinary case this table
   * exists to express. The PRIMARY application additionally writes through to
   * candidates.current_stage, because that column is what the pipeline board,
   * the dashboard counts and the offer flow all read; letting the two disagree
   * would show a candidate at two different stages depending on the screen.
   */
  async moveApplicationStage(application_id, new_stage, {
    company_id = null, moved_by = null, moved_by_user_id = null, notes = null,
    actor_name = null,
  } = {}) {
    const { rows } = await pool.query(
      `UPDATE candidate_applications
          -- $1 is cast explicitly: it appears as an assignment target AND inside
          -- the CASE comparisons, and without the cast Postgres reports
          -- "inconsistent types deduced for parameter $1" and the whole
          -- statement fails at parse time.
          SET stage = $1::varchar,
              -- Status is DERIVED from the stage, in both directions. Falling
              -- through to the old value left an application reading
              -- "stage=screening, status=rejected" the moment someone moved a
              -- rejected candidate back into the pipeline — two fields
              -- contradicting each other on the same row.
              status = CASE
                         WHEN $1::varchar = 'hired' THEN 'hired'
                         WHEN $1::varchar IN ('rejected', 'not_suitable') THEN 'rejected'
                         ELSE 'active'
                       END,
              updated_at = NOW()
        WHERE id = $2 AND ($3::int IS NULL OR company_id = $3)
        RETURNING *`,
      [new_stage, application_id, company_id]
    );
    if (!rows.length) throw Object.assign(new Error('Application not found'), { statusCode: 404 });
    const app = rows[0];

    if (app.is_primary) {
      await this.moveCandidateStage(app.candidate_id, new_stage, moved_by, notes, company_id, null, moved_by_user_id, { actor_name });
    } else {
      // Secondary applications still deserve a trail. candidate_stage_history
      // has no application_id column, so the job is named in the note instead
      // of silently attributing the move to the primary pipeline.
      await pool.query(
        `INSERT INTO candidate_stage_history (candidate_id, stage, moved_by, notes, moved_by_user_id, company_id)
         VALUES ($1, $2, $3, $4, $5,
                 COALESCE($6::int, (SELECT company_id FROM candidates WHERE id = $1)))`,
        [app.candidate_id, new_stage, moved_by,
         notes || `Application for job opening #${app.job_opening_id} moved to ${new_stage}`,
         moved_by_user_id, company_id]
      );
      // candidate_activity DOES have application_id, which is why a secondary
      // move finally gets a timeline entry that names the role rather than a
      // history note that has to encode the job id into free text.
      await candidateIntelligence.recordActivity({
        company_id,
        candidate_id: app.candidate_id,
        application_id: app.id,
        event_type: 'stage_change',
        summary: `Application stage set to ${STAGE_DISPLAY[new_stage] || String(new_stage).replace(/_/g, ' ')}`,
        detail: { stage: new_stage, job_opening_id: app.job_opening_id, primary: false, notes: notes || null },
        actor_user_id: moved_by_user_id,
        actor_name,
      });
    }
    return app;
  },

  async findCandidateById(id, company_id) {
    const params = [id];
    let extra = '';
    if (company_id) { extra = ` AND c.company_id = $2`; params.push(company_id); }
    const result = await pool.query(
      `SELECT c.*, jo.id AS job_opening_id,
              COALESCE(jo.job_title, jr.job_title) AS job_title
       FROM candidates c
       LEFT JOIN job_openings jo ON c.applied_job_id = jo.id
       LEFT JOIN job_requisitions jr ON jo.requisition_id = jr.id
       WHERE c.id = $1 AND c.deleted_at IS NULL${extra}`,
      params
    );
    return result.rows[0];
  },

  // Same key-interpolation mass-assignment/injection issue as updateRequisition
  // above — see that comment.
  async updateCandidate(id, data, company_id = null) {
    // Normalise before pickUpdatable for the same reason createCandidate() does —
    // this path is reachable with a multipart body, where skills is a string.
    if (data && data.skills !== undefined) {
      data = { ...data, skills: JSON.stringify(this._normaliseSkills(data.skills)) };
    }
    const safe = await pickUpdatable('candidates', data);
    const fields = [];
    const values = [];
    let paramCount = 1;
    Object.keys(safe).forEach(key => {
      fields.push(`${key} = $${paramCount}`);
      values.push(safe[key]);
      paramCount++;
    });
    if (!fields.length) return this.findCandidateById(id, company_id);
    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    values.push(company_id);
    const result = await pool.query(
      `UPDATE candidates SET ${fields.join(', ')}
        WHERE id = $${paramCount}
          AND ($${paramCount + 1}::int IS NULL OR company_id = $${paramCount + 1})
        RETURNING *`,
      values
    );
    return result.rows[0];
  },

  // company_id was previously not threaded through at all — any authenticated
  // user could move another company's candidate through the pipeline by id.
  // Skips the history insert if the scoped UPDATE didn't match a row.
  // Optional dbClient lets callers (e.g. acceptOffer()) fold this into their
  // own transaction instead of running as a standalone pool query.
  // `moved_by_user_id` is the acting LOGIN and is always available; `moved_by` is
  // the employee FK and is NULL for accounts with no employee record — which on
  // this database is both administrators, so every admin stage move used to land
  // in the history with no actor at all. Callers pass the user id through
  // `moved_by_user_id`; the signature keeps its existing positional arguments so
  // no call site breaks.
  /**
   * @param {object} opts  Optional extras added by the 2026-09-27 redesign:
   *   - actor_name: a display name for the activity timeline. Positional
   *     parameters were already at seven, so new inputs go in a bag rather than
   *     as an eighth positional that every existing call site would have to
   *     count past.
   */
  async moveCandidateStage(candidate_id, new_stage, moved_by, notes, company_id = null, dbClient = null, moved_by_user_id = null, opts = {}) {
    const client = dbClient || pool;
    const extra = new_stage === 'hired'
      ? ', overall_status = \'hired\', hired_at = NOW()'
      : new_stage === 'rejected' || new_stage === 'not_suitable'
        ? ', overall_status = \'rejected\''
        : '';

    const result = await client.query(
      `UPDATE candidates SET current_stage = $1, updated_at = CURRENT_TIMESTAMP ${extra}
        WHERE id = $2 AND ($3::int IS NULL OR company_id = $3)`,
      [new_stage, candidate_id, company_id]
    );
    if (result.rowCount === 0) throw new Error('Candidate not found');
    // company_id on the history row: the column was added by migration
    // 20260927000001 so this table can be scoped without a join through
    // candidates. COALESCE with the candidate's own value covers the global-scope
    // (super admin) case, where company_id arrives null.
    await client.query(
      `INSERT INTO candidate_stage_history (candidate_id, stage, moved_by, notes, moved_by_user_id, company_id)
       VALUES ($1, $2, $3, $4, $5,
               COALESCE($6::int, (SELECT company_id FROM candidates WHERE id = $1)))`,
      [candidate_id, new_stage, moved_by, notes, moved_by_user_id, company_id]
    );
    // The primary application mirrors candidates.current_stage. Moving someone
    // through the pipeline board must not leave the two disagreeing.
    await client.query(
      `UPDATE candidate_applications
          -- $1 is cast explicitly: it appears as an assignment target AND inside
          -- the CASE comparisons, and without the cast Postgres reports
          -- "inconsistent types deduced for parameter $1" and the whole
          -- statement fails at parse time.
          SET stage = $1::varchar,
              -- Status is DERIVED from the stage, in both directions. Falling
              -- through to the old value left an application reading
              -- "stage=screening, status=rejected" the moment someone moved a
              -- rejected candidate back into the pipeline — two fields
              -- contradicting each other on the same row.
              status = CASE
                         WHEN $1::varchar = 'hired' THEN 'hired'
                         WHEN $1::varchar IN ('rejected', 'not_suitable') THEN 'rejected'
                         ELSE 'active'
                       END,
              updated_at = NOW()
        WHERE candidate_id = $2 AND is_primary`,
      [new_stage, candidate_id]
    );

    // The activity timeline (§21) and candidates.last_activity_at, which the
    // recruiter work queue measures "waiting more than 3 days" from. Both are
    // written by recordActivity, inside this transaction when there is one, so a
    // stage move can never succeed while leaving the timeline or the staleness
    // clock behind. Awaited, not fire-and-forget: a swallowed history write that
    // still answers HTTP 200 is how this codebase lost ledger rows once already.
    await candidateIntelligence.recordActivity({
      company_id,
      candidate_id,
      event_type: 'stage_change',
      summary: `Stage set to ${STAGE_DISPLAY[new_stage] || String(new_stage).replace(/_/g, ' ')}`,
      detail: { stage: new_stage, notes: notes || null },
      actor_user_id: moved_by_user_id,
      actor_name: opts.actor_name || null,
    }, client);
  },

  // candidate_stage_history has no company_id of its own, so scoping goes through
  // the owning candidate — the same join findInterviewNotes() uses for the same
  // reason. Without it this read was fully cross-tenant: any authenticated user
  // could enumerate another company's candidates by id and see their entire
  // pipeline history, including the notes recorded at each stage move.
  async getCandidateStageHistory(candidate_id, company_id = null) {
    const params = [candidate_id];
    let extra = '';
    if (company_id) { extra = ` AND c.company_id = $2`; params.push(company_id); }
    const result = await pool.query(
      // Fall back to the acting login's own name when there is no employee behind
      // the move, so the history names somebody instead of rendering blank.
      `SELECT csh.*,
              COALESCE(
                NULLIF(TRIM(CONCAT(e.first_name, ' ', COALESCE(e.last_name, ''))), ''),
                NULLIF(TRIM(CONCAT(ue.first_name, ' ', COALESCE(ue.last_name, ''))), ''),
                u.email
              ) AS moved_by_name
       FROM candidate_stage_history csh
       JOIN candidates c ON c.id = csh.candidate_id
       LEFT JOIN employees e ON csh.moved_by = e.id
       LEFT JOIN users     u  ON u.id = csh.moved_by_user_id
       LEFT JOIN employees ue ON ue.id = u.employee_id
       WHERE csh.candidate_id = $1${extra}
       ORDER BY csh.moved_date DESC`,
      params
    );
    return result.rows;
  },

  /**
   * One Kanban column: everyone at `stage` for this opening.
   *
   * Reads candidate_applications, not candidates.applied_job_id. The old query
   * asked "whose PRIMARY job is this, and what is their HEADLINE stage" — two
   * wrong questions for a per-job board. A candidate recommended onto this
   * opening never appeared on it at all, and one who was at Screening here but
   * Offer on their original role showed up in the Offer column of both.
   *
   * `application_id` and `application_stage` are returned alongside the
   * candidate's own fields so the board can move THIS application without
   * touching the other one.
   */
  async getCandidatesByStage(job_opening_id, stage, company_id = null) {
    const params = [job_opening_id, stage];
    let extra = '';
    if (company_id) { extra = ` AND ca.company_id = $3`; params.push(company_id); }
    const result = await pool.query(
      `SELECT c.*,
              ca.id       AS application_id,
              ca.stage    AS application_stage,
              ca.status   AS application_status,
              ca.origin   AS application_origin,
              ca.is_primary,
              ca.applied_at
         FROM candidate_applications ca
         JOIN candidates c ON c.id = ca.candidate_id
        WHERE ca.job_opening_id = $1 AND ca.stage = $2 AND c.deleted_at IS NULL${extra}
        ORDER BY ca.applied_at DESC`,
      params
    );
    return result.rows;
  },

  // ==================== INTERVIEW NOTES ====================
  // interview_notes has no company_id column of its own — scoping is via the
  // candidate it belongs to. Previously unscoped entirely: any authenticated
  // user could read or write interview notes for another company's candidate
  // by guessing/enumerating candidate_id.
  async createInterviewNote(data, company_id = null) {
    const { candidate_id, interviewer_id, interview_round, rating, comments, recommendation, interview_id = null } = data;
    if (company_id) {
      const owns = await pool.query(
        `SELECT 1 FROM candidates WHERE id = $1 AND company_id = $2`,
        [candidate_id, company_id]
      );
      if (!owns.rows.length) throw new Error('Candidate not found');
    }
    const result = await pool.query(
      `INSERT INTO interview_notes
         (candidate_id, interviewer_id, interview_round, rating, comments, recommendation, interview_id, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::int, (SELECT company_id FROM candidates WHERE id = $1))) RETURNING *`,
      [candidate_id, interviewer_id || null, interview_round || null, rating || null, comments || null,
       recommendation || null, interview_id || null, company_id || null]
    );
    await this.refreshOverallRating(candidate_id);
    return result.rows[0];
  },

  // candidates.overall_rating existed but nothing ever wrote it, so "show me
  // candidates rated 4+" was unanswerable without a correlated subquery no
  // caller wrote. Recomputed from the notes rather than incremented, so an
  // edited or deleted note cannot leave the average wrong.
  async refreshOverallRating(candidate_id, dbClient = null) {
    const client = dbClient || pool;
    await client.query(
      `UPDATE candidates c
          SET overall_rating = (
                SELECT ROUND(AVG(n.rating)::numeric, 2)
                  FROM interview_notes n
                 WHERE n.candidate_id = c.id AND n.rating IS NOT NULL
              )
        WHERE c.id = $1`,
      [candidate_id]
    );
  },

  async findInterviewNotes(candidate_id, company_id = null) {
    const params = [candidate_id];
    let extra = '';
    if (company_id) { extra = ` AND c.company_id = $2`; params.push(company_id); }
    const result = await pool.query(
      `SELECT n.*, e.name AS interviewer_name,
              s.interview_date, s.interview_round AS scheduled_round
       FROM interview_notes n
       JOIN candidates c ON c.id = n.candidate_id
       LEFT JOIN employees e ON n.interviewer_id = e.id
       LEFT JOIN interview_schedules s ON s.id = n.interview_id
       WHERE n.candidate_id = $1${extra}
       ORDER BY n.created_at DESC`,
      params
    );
    return result.rows;
  },

  // ==================== INTERVIEW SCHEDULING ====================
  async scheduleInterview(data) {
    const {
      candidate_id, interview_date, interview_time, interview_mode,
      meeting_link, interviewer_id, notes, company_id,
      interview_round = null, job_opening_id = null,
    } = data;
    const panel = JSON.stringify(normaliseIdList(data.panel_employee_ids).filter(id => id !== Number(interviewer_id)));
    const questions = JSON.stringify(normaliseIdList(data.question_ids));
    // A plain INSERT...RETURNING * only has interview_schedules' own columns
    // (candidate_id, interview_mode, ...) — no candidate_name/candidate_email.
    // recruitment.routes.js's POST /interviews handler fires the
    // 'interview_l1_scheduled' email off interview.candidate_email/
    // candidate_name/mode, none of which existed on that raw row, so the
    // email silently no-op'd on every interview scheduled. Join candidates
    // here (same alias shape findInterviews() already uses) so the caller
    // gets real data instead of undefined -> ''.
    const result = await pool.query(
      `WITH ins AS (
         INSERT INTO interview_schedules
           (candidate_id, interview_date, interview_time, interview_mode,
            meeting_link, interviewer_id, notes, company_id, status,
            interview_round, job_opening_id, panel_employee_ids, question_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'scheduled',$9,$10,$11::jsonb,$12::jsonb) RETURNING *
       )
       SELECT ins.*, c.full_name AS candidate_name, c.email AS candidate_email,
              c.current_stage AS candidate_stage,
              COALESCE(jo.job_title, cjo.job_title) AS job_title
       FROM ins
       LEFT JOIN candidates c ON c.id::text = ins.candidate_id::text
       LEFT JOIN job_openings jo ON jo.id = ins.job_opening_id
       LEFT JOIN job_openings cjo ON cjo.id = c.applied_job_id`,
      [candidate_id, interview_date, interview_time || null, interview_mode || null,
       meeting_link || null, interviewer_id || null, notes || null, company_id,
       interview_round, job_opening_id || null, panel, questions]
    );
    return result.rows[0];
  },

  async findInterviews(filters = {}) {
    let query = `
      SELECT s.*, c.full_name AS candidate_name, c.email AS candidate_email,
             c.current_stage AS candidate_stage,
             e.name AS interviewer_name, e.company_email AS interviewer_email,
             COALESCE(jo.job_title, cjo.job_title) AS job_title,
             COALESCE(jo.department, cjo.department) AS department,
             (SELECT COALESCE(json_agg(json_build_object('id', pe.id, 'name', pe.name) ORDER BY pe.name), '[]'::json)
                FROM employees pe
               WHERE pe.id IN (SELECT (jsonb_array_elements_text(s.panel_employee_ids))::int)) AS panel,
             (SELECT COUNT(*)::int FROM interview_notes n WHERE n.interview_id = s.id) AS feedback_count
      FROM interview_schedules s
      LEFT JOIN candidates c ON c.id::text = s.candidate_id::text
      LEFT JOIN employees e ON e.id = s.interviewer_id
      LEFT JOIN job_openings jo ON jo.id = s.job_opening_id
      LEFT JOIN job_openings cjo ON cjo.id = c.applied_job_id
      WHERE s.deleted_at IS NULL`;
    const params = [];
    let n = 1;
    if (filters.company_id)    { query += ` AND s.company_id = $${n++}`;     params.push(filters.company_id); }
    if (filters.interviewer_id){ query += ` AND s.interviewer_id = $${n++}`; params.push(filters.interviewer_id); }
    // "My interviews": lead interviewer or on the panel.
    if (filters.panel_member_id) {
      query += ` AND (s.interviewer_id = $${n} OR s.panel_employee_ids @> to_jsonb($${n}::int))`;
      n++; params.push(filters.panel_member_id);
    }
    if (filters.from_date)     { query += ` AND s.interview_date >= $${n++}`; params.push(filters.from_date); }
    if (filters.candidate_id)  { query += ` AND s.candidate_id = $${n++}`;   params.push(filters.candidate_id); }
    if (filters.interview_date){ query += ` AND s.interview_date = $${n++}`; params.push(filters.interview_date); }
    if (filters.status)        { query += ` AND s.status = $${n++}`;         params.push(filters.status); }
    // ?department= — the Dashboard's department filter, same rule as its tile.
    if (filters.department)    { query += ` AND ${recordDepartmentSql('s')} = $${n++}`; params.push(filters.department); }
    query += ` ORDER BY s.interview_date, s.interview_time`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  // Same key-interpolation mass-assignment/injection issue as updateRequisition
  // above — see that comment.
  async updateInterview(id, data, company_id = null) {
    const input = { ...data };
    for (const k of Object.keys(input)) if (input[k] === '') input[k] = null;
    if (input.panel_employee_ids !== undefined) {
      input.panel_employee_ids = JSON.stringify(normaliseIdList(input.panel_employee_ids)
        .filter(x => input.interviewer_id == null || x !== Number(input.interviewer_id)));
    }
    if (input.question_ids !== undefined) input.question_ids = JSON.stringify(normaliseIdList(input.question_ids));
    const safe = await pickUpdatable('interview_schedules', input);
    const fields = [];
    const values = [];
    let paramCount = 1;
    Object.keys(safe).forEach(key => {
      fields.push(`${key} = $${paramCount}`);
      values.push(safe[key]);
      paramCount++;
    });
    if (!fields.length) {
      const existing = await pool.query(
        `SELECT * FROM interview_schedules WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
        [id, company_id]
      );
      return existing.rows[0];
    }
    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    values.push(company_id);
    const result = await pool.query(
      `UPDATE interview_schedules SET ${fields.join(', ')}
        WHERE id = $${paramCount}
          AND ($${paramCount + 1}::int IS NULL OR company_id = $${paramCount + 1})
        RETURNING *`,
      values
    );
    return result.rows[0];
  },

  // ==================== EMAIL TEMPLATES ====================
  // `email_templates` is shared with CRM (backend/src/modules/crm/routes/email.routes.js),
  // which reads/writes name/category/stage_trigger — different columns than this
  // module's template_name/template_type. The actual send-time lookup,
  // services/emailTrigger.js's triggerEmail(), only ever matches on
  // `stage_trigger`/`category`, so a template created here previously could
  // never be picked up by the code that sends recruitment emails at all.
  // Mirroring template_type/template_name into stage_trigger/category/name on
  // write closes that gap without a schema change or touching CRM's own path.
  //
  // company_id/module (migration 20260812000001) scope every row to a tenant
  // and to the module that owns it — always set here from the server side
  // (cid(req) at the route layer, module hardcoded below), never trusted from
  // request `data`, so a caller can't relabel a row into CRM's module or jump
  // it to another tenant by passing those keys in the body.
  async createEmailTemplate(data, company_id = null) {
    const { template_name, template_type, subject, body_html, variables_json } = data;
    // is_active used to be ignored here, so "Duplicate" (which asks for an
    // inactive copy) made a second ACTIVE template for the same event.
    const isActive = data.is_active !== false;
    if (isActive) await this.deactivateOtherTemplates(template_type, company_id, null);
    const result = await pool.query(
      `INSERT INTO email_templates
         (template_name, template_type, subject, body_html, variables_json, name, category, stage_trigger, company_id, module, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'recruitment',$10) RETURNING *`,
      // name/category/stage_trigger are separately-typed columns (varchar vs
      // text) from template_name/template_type — reusing the same $n for both
      // fails with "inconsistent types deduced for parameter" even though the
      // JS values are identical, so each gets its own placeholder.
      [template_name, template_type, subject, body_html, variables_json, template_name, template_type, template_type, company_id, isActive]
    );
    return result.rows[0];
  },

  /**
   * One template is in use per event per company (the sender takes one row,
   * with no tie-break — migration 20261117000008 now enforces it). Switching a
   * template on switches that event's other company template off.
   */
  async deactivateOtherTemplates(templateType, company_id, keepId) {
    if (company_id == null || !templateType) return;
    await pool.query(
      `UPDATE email_templates SET is_active = false, updated_at = CURRENT_TIMESTAMP
        WHERE module = 'recruitment' AND company_id = $1 AND stage_trigger = $2
          AND is_active AND deleted_at IS NULL AND ($3::int IS NULL OR id <> $3)`,
      [company_id, templateType, keepId]
    );
  },

  async findEmailTemplates(filters = {}, company_id = null) {
    // The company's own templates AND the shared defaults (company_id NULL),
    // which are what actually send until the company writes its own. Listing
    // only company rows hid every default from the page. Switched-off
    // templates are listed too, so they can be switched back on.
    let query = `SELECT t.*, (t.company_id IS NULL) AS is_default,
                        EXISTS (SELECT 1 FROM email_templates o
                                 WHERE t.company_id IS NULL AND o.company_id = $1::int AND o.module = 'recruitment'
                                   AND o.deleted_at IS NULL AND o.is_active
                                   AND o.stage_trigger = t.stage_trigger) AS overridden
                   FROM email_templates t
                  WHERE t.module = 'recruitment' AND t.deleted_at IS NULL`;
    const params = [company_id];
    let n = 2;
    query += ` AND (t.company_id IS NULL OR t.company_id = $1::int)`;
    if (filters.template_type) { query += ` AND t.template_type = $${n++}`; params.push(filters.template_type); }
    if (filters.is_active !== undefined) { query += ` AND t.is_active = $${n++}`; params.push(filters.is_active); }
    query += ` ORDER BY t.stage_trigger, t.company_id NULLS LAST, t.template_name`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  async findEmailTemplateById(id, company_id = null) {
    const result = await pool.query(
      `SELECT * FROM email_templates
        WHERE id = $1 AND module = 'recruitment'
          AND ($2::int IS NULL OR company_id = $2)`,
      [id, company_id]
    );
    return result.rows[0];
  },

  async updateEmailTemplate(id, data, company_id = null) {
    // Keep the CRM-style mirror columns in sync — see createEmailTemplate's
    // comment above for why this matters (triggerEmail() only reads these).
    // company_id/module are deliberately excluded even if present in `data` —
    // pickUpdatable() would otherwise happily let a caller move a row to
    // another tenant or relabel its module, the same class of bug this
    // migration's own comment describes for the rest of the table.
    const { company_id: _ignoredCompanyId, module: _ignoredModule, ...rest } = data;
    const mirrored = { ...rest };
    if (data.template_type !== undefined) {
      mirrored.stage_trigger = data.template_type;
      mirrored.category = data.template_type;
    }
    if (data.template_name !== undefined) {
      mirrored.name = data.template_name;
    }
    const safe = await pickUpdatable('email_templates', mirrored);
    // Becoming (or staying) active while the event may change: free the slot.
    if (rest.is_active === true || (rest.template_type !== undefined && rest.is_active !== false)) {
      const { rows: [cur] } = await pool.query(`SELECT stage_trigger, is_active FROM email_templates WHERE id = $1`, [id]);
      if (cur && (rest.is_active === true || cur.is_active)) {
        await this.deactivateOtherTemplates(rest.template_type ?? cur.stage_trigger, company_id, Number(id));
      }
    }
    const fields = [];
    const values = [];
    let paramCount = 1;
    Object.keys(safe).forEach(key => {
      fields.push(`${key} = $${paramCount}`);
      values.push(safe[key]);
      paramCount++;
    });
    if (!fields.length) return this.findEmailTemplateById(id, company_id);
    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    values.push(company_id);
    const result = await pool.query(
      `UPDATE email_templates SET ${fields.join(', ')}
        WHERE id = $${paramCount}
          AND module = 'recruitment'
          AND ($${paramCount + 1}::int IS NULL OR company_id = $${paramCount + 1})
        RETURNING *`,
      values
    );
    return result.rows[0];
  },

  async deleteEmailTemplate(id, company_id = null) {
    // is_active too: the sender (services/emailTrigger.js) looks at is_active,
    // so a template that was only soft-deleted kept being sent.
    await pool.query(
      `UPDATE email_templates SET deleted_at = CURRENT_TIMESTAMP, is_active = false
        WHERE id = $1 AND module = 'recruitment'
          AND ($2::int IS NULL OR company_id = $2)`,
      [id, company_id]
    );
  },

  async logEmailSent(data) {
    const { candidate_id, template_id, sent_to, subject, body_html, status } = data;
    await pool.query(
      `INSERT INTO recruitment_emails_sent (candidate_id, template_id, sent_to, subject, body_html, status)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [candidate_id, template_id, sent_to, subject, body_html, status || 'sent']
    );
  },

  // ==================== OFFER MANAGEMENT ====================
  async createOffer(data) {
    const {
      candidate_id, job_opening_id, offered_salary, joining_date, notes, company_id,
      // Optional. Normally left NULL here and stamped at send time from the
      // company's Default Offer Validity (approvals.controller.js 'offer' case),
      // but a recruiter may set a deliberate date on the draft — the send path
      // COALESCEs and will not overwrite it.
      offer_expiry_date,
      // Employee id of whoever raised this offer, so approveSourceItem() can refuse
      // to let the same person approve it (migration 20260813000002). NULL for the
      // auto-draft path, which has no human author — a machine-drafted offer has no
      // one to exclude, and still requires a human approver to send.
      created_by,
      designation,
    } = data;
    // Designation defaults to the opening's title; the letter needs one.
    let role = designation || null;
    if (!role && job_opening_id) {
      const { rows } = await pool.query(`SELECT job_title FROM job_openings WHERE id = $1`, [job_opening_id]);
      role = rows[0]?.job_title || null;
    }
    const offerNo = await nextOfferNumber();
    const result = await pool.query(
      `INSERT INTO offer_letters
         (candidate_id, job_opening_id, offered_salary, joining_date, notes, company_id, offer_status, offer_expiry_date, created_by,
          designation, offer_no)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10) RETURNING *`,
      [candidate_id, job_opening_id || null, offered_salary, joining_date || null, notes || null, company_id,
       offer_expiry_date || null, created_by || null, role, offerNo]
    );
    await this.moveCandidateStage(candidate_id, 'offer', null, 'Offer created', company_id);
    return result.rows[0];
  },

  // Auto-drafts an offer_letters row the moment a candidate reaches the Offer
  // stage (called from submit-feedback and move-stage in recruitment.routes.js)
  // instead of leaving recruiters a bare "create offer letter" reminder and a
  // blank form. Reuses createOffer() verbatim — same draft status, same
  // moveCandidateStage('offer') call — so the record is identical to one a
  // human would have created by hand, still requiring review/edit before
  // PUT /offers/:id → Approval Center can ever send it. See
  // AUTOMATION_OPPORTUNITY_AUDIT.md §10.3. Idempotent: a candidate who already
  // has any non-deleted offer (draft or further along) is skipped, so this is
  // safe to call from more than one stage-transition path for the same candidate.
  async autoDraftOfferForCandidate(candidateId, companyId) {
    const { rows: existing } = await pool.query(
      `SELECT id FROM offer_letters WHERE candidate_id = $1 AND company_id = $2 AND deleted_at IS NULL LIMIT 1`,
      [candidateId, companyId]
    );
    if (existing.length) return null;

    const { rows: candRows } = await pool.query(
      `SELECT c.applied_job_id, jo.salary_min, jo.salary_max
         FROM candidates c
         LEFT JOIN job_openings jo ON jo.id = c.applied_job_id
        WHERE c.id = $1 AND c.company_id = $2`,
      [candidateId, companyId]
    );
    const cand = candRows[0];
    if (!cand) return null;

    const offeredSalary = cand.salary_min != null && cand.salary_max != null
      ? (Number(cand.salary_min) + Number(cand.salary_max)) / 2
      : Number(cand.salary_max ?? cand.salary_min ?? 0);

    return this.createOffer({
      candidate_id: candidateId,
      job_opening_id: cand.applied_job_id,
      offered_salary: offeredSalary,
      joining_date: null,
      notes: 'Auto-drafted when candidate reached Offer stage — review salary, joining date and terms before sending.',
      company_id: companyId,
    });
  },

  async findOffers(filters = {}) {
    let query = `
      SELECT ol.*, c.full_name AS candidate_name, c.email AS candidate_email,
             COALESCE(jo.job_title, jr.job_title) AS job_title,
             ${recordDepartmentSql('ol')} AS department,
             -- The approved budget the offer is checked against (requisition).
             COALESCE(jr.salary_min, jo.salary_min) AS budget_min,
             COALESCE(jr.salary_max, jo.salary_max) AS budget_max,
             (ol.offer_status = 'sent' AND ol.offer_expiry_date < CURRENT_DATE) AS is_expired,
             emp.id AS employee_id, emp.employee_id AS employee_code,
             sp.status AS salary_proposal_status,
             last.comments AS last_decision_comment, last.status AS last_decision_status
      FROM offer_letters ol
      JOIN candidates c ON ol.candidate_id = c.id
      LEFT JOIN job_openings jo ON ol.job_opening_id = jo.id
      LEFT JOIN job_requisitions jr ON jo.requisition_id = jr.id
      LEFT JOIN LATERAL (SELECT e.id, e.office_id AS employee_id FROM employees e
                          WHERE e.source_candidate_id = ol.candidate_id AND e.deleted_at IS NULL
                            AND ol.offer_status = 'accepted' LIMIT 1) emp ON TRUE
      LEFT JOIN LATERAL (SELECT p.status FROM salary_revision_proposals p
                          WHERE p.source_type = 'offer' AND p.source_id = ol.id::text
                          ORDER BY p.created_at DESC LIMIT 1) sp ON TRUE
      LEFT JOIN LATERAL (SELECT a.status, a.comments FROM approvals a
                          WHERE a.module_name = 'offer' AND a.title = 'Offer #' || ol.id::text
                          ORDER BY a.decision_date DESC NULLS LAST LIMIT 1) last ON TRUE
      WHERE ol.deleted_at IS NULL`;
    const params = [];
    let n = 1;
    if (filters.company_id)   { query += ` AND ol.company_id = $${n++}`;   params.push(filters.company_id); }
    if (filters.offer_status) { query += ` AND ol.offer_status = $${n++}`; params.push(filters.offer_status); }
    if (filters.candidate_id) { query += ` AND ol.candidate_id = $${n++}`; params.push(filters.candidate_id); }
    // ?department= — the Dashboard's department filter, same rule as its tile.
    // A list (a department head's departments) or one name; [] matches nothing.
    if (filters.departments)  { query += ` AND ${recordDepartmentSql('ol')} = ANY($${n++}::text[])`; params.push(filters.departments); }
    else if (filters.department) { query += ` AND ${recordDepartmentSql('ol')} = $${n++}`; params.push(filters.department); }
    query += ` ORDER BY ol.created_at DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  async findOfferById(id, company_id) {
    const params = [id];
    let extra = '';
    if (company_id) { extra = ` AND ol.company_id = $2`; params.push(company_id); }
    const result = await pool.query(
      `SELECT ol.*, c.full_name AS candidate_name, c.email AS candidate_email,
              COALESCE(jo.job_title, jr.job_title) AS job_title
       FROM offer_letters ol
       JOIN candidates c ON ol.candidate_id = c.id
       LEFT JOIN job_openings jo ON ol.job_opening_id = jo.id
       LEFT JOIN job_requisitions jr ON jo.requisition_id = jr.id
       WHERE ol.id = $1 AND ol.deleted_at IS NULL${extra}`,
      params
    );
    return result.rows[0];
  },

  // Same key-interpolation mass-assignment/injection issue as updateRequisition
  // above — see that comment.
  async updateOffer(id, data, company_id = null) {
    // created_by/company_id are stripped before pickUpdatable() sees them. Both are
    // real columns, so pickUpdatable would otherwise accept them straight from the
    // request body — and created_by is exactly the value the Approval Center reads
    // to block self-approval, so a caller who could rewrite it could approve their
    // own offer by first reassigning its author. Same guard, same reasoning as
    // updateEmailTemplate()'s company_id/module strip.
    const { created_by: _ignoredCreatedBy, company_id: _ignoredCompanyId, offer_no: _ignoredNo, ...rest } = data;
    for (const k of Object.keys(rest)) if (rest[k] === '') rest[k] = null;
    const safe = await pickUpdatable('offer_letters', rest);
    const fields = [];
    const values = [];
    let paramCount = 1;
    Object.keys(safe).forEach(key => {
      fields.push(`${key} = $${paramCount}`);
      values.push(safe[key]);
      paramCount++;
    });
    if (!fields.length) return this.findOfferById(id, company_id);
    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    values.push(company_id);
    const result = await pool.query(
      `UPDATE offer_letters SET ${fields.join(', ')}
        WHERE id = $${paramCount}
          AND ($${paramCount + 1}::int IS NULL OR company_id = $${paramCount + 1})
        RETURNING *`,
      values
    );
    return result.rows[0];
  },

  // Previously had no company_id scoping — any authenticated user could
  // accept another company's offer by id.
  //
  // Concurrency: the status-guard (`AND offer_status = 'sent'`) makes this a
  // compare-and-swap — the same pattern approvals.controller.js uses on the
  // central approvals table. Without it, a double-click/retry/two-approver race
  // re-ran all three writes and incremented job_openings.positions_filled twice
  // for a single hire, silently corrupting every vacancy/open-position number
  // downstream. All three writes now share one transaction so a mid-sequence
  // failure can't leave the offer accepted but the candidate un-hired.
  async acceptOffer(offer_id, company_id = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE offer_letters
         SET offer_status = 'accepted', response_date = CURRENT_DATE, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)
           AND offer_status = 'sent'
         RETURNING *`,
        [offer_id, company_id]
      );
      const offer = result.rows[0];
      if (!offer) {
        // Distinguish "already accepted/withdrawn" from "doesn't exist" so the
        // caller can return 409 vs 404 rather than a blanket 500.
        const current = await client.query(
          `SELECT offer_status FROM offer_letters
            WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) AND deleted_at IS NULL`,
          [offer_id, company_id]
        );
        await client.query('ROLLBACK');
        if (!current.rows.length) {
          throw Object.assign(new Error('Offer not found'), { statusCode: 404 });
        }
        throw Object.assign(
          new Error(`This offer can no longer be accepted — its current status is '${current.rows[0].offer_status}'.`),
          { statusCode: 409 }
        );
      }
      await client.query(
        `UPDATE candidates SET overall_status = 'hired', current_stage = 'hired', hired_at = NOW()
         WHERE id = $1`,
        [offer.candidate_id]
      );
      // The primary application mirrors the candidate (it was left at "offer").
      await client.query(
        `UPDATE candidate_applications SET stage = 'hired', status = 'hired', updated_at = NOW()
          WHERE candidate_id = $1 AND is_primary`,
        [offer.candidate_id]
      );
      // positions_filled is deliberately NOT incremented here — hireCandidate()
      // step 6 owns that counter, and this route triggers it immediately after.
      // Incrementing in both places double-counted every offer-accept hire.
      await client.query('COMMIT');
      return offer;
    } catch (err) {
      // ROLLBACK already issued on the guard-miss path above; safe to repeat.
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },

  // ==================== ANALYTICS & DASHBOARD ====================

  // ── CANONICAL RECRUITMENT KPIs ──────────────────────────────────────────────
  // Single source of truth for every headline recruitment number, consumed by
  // /recruitment/dashboard-summary (exec Dashboard) AND /talent/recruiter-dashboard
  // (My Workbench). Those two endpoints previously ran their own independent
  // SQL for the same-named KPIs and disagreed in three concrete ways:
  //   • open_positions — the Workbench copy omitted `deleted_at IS NULL`, so
  //     soft-deleted openings inflated its count relative to the Dashboard's.
  //   • pending_offers — same missing soft-delete filter.
  //   • avg_time_to_hire — the Workbench used hired_at−created_at while
  //     Dashboard/Reports/Forecast used offer_sent_date−created_at, i.e. two
  //     different questions rendered under one label.
  //
  // Two deliberately DISTINCT open-role metrics are returned, because the module
  // legitimately needs both and conflating them was the root of the "Dashboard
  // says 27, Forecast says 25" split:
  //   • open_positions  — how many roles are open   (count of job_openings rows)
  //   • open_headcount  — how many seats are unfilled (Σ positions still to fill)
  // They are labelled distinctly in the UI ("Open Positions" vs "Vacancies").
  /**
   * Canonical recruitment KPI set. Every dashboard reads these — do not
   * reimplement the counts elsewhere.
   *
   * @param {number|null} company_id tenant scope
   * @param {object} [filters] dashboard filter bar values
   * @param {string|null} [filters.from] inclusive range start (YYYY-MM-DD)
   * @param {string|null} [filters.to]   inclusive range end
   * @param {string|null} [filters.department] matched on job_openings.department
   *   (candidates carry no department of their own, so they match through
   *   applied_job_id)
   *
   * Backlog counts (open positions, active candidates, upcoming interviews,
   * pending offers) are point-in-time and ignore the range — a narrow period
   * must not hide live pipeline. Activity counts (applications, hires, time to
   * hire) follow it.
   */
  async getRecruitmentKpis(company_id, filters = {}) {
    const { from = null, to = null, department = null } = filters;
    const safeQ = async (sql, params = []) => {
      try { return (await pool.query(sql, params)).rows[0] || {}; } catch { return {}; }
    };

    // Each query gets exactly the params it references, numbered from its own
    // list. Postgres infers a parameter's type from its use site, so a supplied
    // but unreferenced $n fails outright with "could not determine data type of
    // parameter" — a shared fixed-position array silently breaks every query
    // that doesn't use all of it.
    const q = () => {
      const params = [company_id];
      return {
        params,
        /** Period predicate on `col` (no-op when the range is unbounded). */
        inRange(col) {
          let sql = '';
          if (from) { params.push(from); sql += ` AND ${col} >= $${params.length}::date`; }
          if (to)   { params.push(to);   sql += ` AND ${col} < ($${params.length}::date + INTERVAL '1 day')`; }
          return sql;
        },
        /** Department held directly on the table. */
        deptOn(alias) {
          if (!department) return '';
          params.push(department);
          return ` AND ${alias}.department = $${params.length}`;
        },
        /** candidates/offers carry no department — reach it via the job opening. */
        deptViaOpening(col) {
          if (!department) return '';
          params.push(department);
          return ` AND ${col} IN (SELECT id FROM job_openings WHERE department = $${params.length})`;
        },
        /** Interviews / offers — see recordDepartmentSql(). */
        deptOfRecord(alias) {
          if (!department) return '';
          params.push(department);
          return ` AND ${recordDepartmentSql(alias)} = $${params.length}`;
        },
      };
    };

    const qPositions = q(); const fPositions = qPositions.deptOn('jo');
    const qHeadcount = q(); const fHeadcount = qHeadcount.deptOn('jo');
    const qActive    = q(); const fActive    = qActive.deptViaOpening('applied_job_id');
    const qTotal     = q(); const fTotal     = qTotal.deptViaOpening('applied_job_id') + qTotal.inRange('created_at');
    const qHired     = q(); const fHired     = qHired.deptViaOpening('applied_job_id') + qHired.inRange('hired_at');
    const qTth       = q(); const fTth       = qTth.deptViaOpening('applied_job_id') + qTth.inRange('hired_at');
    const qOffers    = q(); const fOffers    = qOffers.deptOfRecord('o');
    const qTodayIv   = q(); const fTodayIv   = qTodayIv.deptOfRecord('i');
    const qUpIv      = q(); const fUpIv      = qUpIv.deptOfRecord('i');

    const [positions, headcount, active, total, todayIv, upcomingIv, offers, hired, tth] = await Promise.all([
      safeQ(`SELECT COUNT(*) AS cnt FROM job_openings jo
             WHERE jo.status = 'open' AND jo.company_id = $1 AND jo.deleted_at IS NULL
               ${fPositions}`, qPositions.params),
      // Unfilled seats across open roles: the opening's own head count
      // (migration 20261117000002), else its requisition's, else 1.
      safeQ(`SELECT COALESCE(SUM(GREATEST(COALESCE(jo.number_of_positions, jr.number_of_positions, 1) - COALESCE(jo.positions_filled, 0), 0)), 0) AS cnt
               FROM job_openings jo
               LEFT JOIN job_requisitions jr ON jr.id = jo.requisition_id
              WHERE jo.status = 'open' AND jo.company_id = $1 AND jo.deleted_at IS NULL
                ${fHeadcount}`, qHeadcount.params),
      safeQ(`SELECT COUNT(*) AS cnt FROM candidates
             WHERE overall_status = 'active' AND company_id = $1 AND deleted_at IS NULL
               ${fActive}`, qActive.params),
      // Applications received — activity, so it follows the period.
      safeQ(`SELECT COUNT(*) AS cnt FROM candidates
             WHERE company_id = $1 AND deleted_at IS NULL
               ${fTotal}`, qTotal.params),
      safeQ(`SELECT COUNT(*) AS cnt FROM interview_schedules i
             WHERE i.interview_date = CURRENT_DATE AND i.status = 'scheduled'
               AND i.company_id = $1 AND i.deleted_at IS NULL
               ${fTodayIv}`, qTodayIv.params),
      safeQ(`SELECT COUNT(*) AS cnt FROM interview_schedules i
             WHERE i.interview_date >= CURRENT_DATE AND i.status <> 'cancelled'
               AND i.company_id = $1 AND i.deleted_at IS NULL
               ${fUpIv}`, qUpIv.params),
      // Awaiting an answer (draft, pending approval, sent) — the same set as My
      // Work's "offers pending" and Offer Management's "Awaiting answer". It
      // counted 'sent' only, so the Dashboard said 0 while My Work said 2.
      safeQ(`SELECT COUNT(*) AS cnt FROM offer_letters o
             WHERE o.offer_status IN ${UNANSWERED_OFFERS_SQL} AND o.company_id = $1 AND o.deleted_at IS NULL
               ${fOffers}`, qOffers.params),
      // Keyed on hired_at, not updated_at. updated_at is bumped by ANY later edit
      // to the candidate row (even a note), so a candidate hired months ago moved
      // into "this month" the moment anyone touched their record.
      // The window was hardcoded to the calendar month; it now follows the period.
      safeQ(`SELECT COUNT(*) AS cnt FROM candidates
             WHERE overall_status = 'hired' AND hired_at IS NOT NULL
               AND company_id = $1 AND deleted_at IS NULL
               ${fHired}`, qHired.params),
      safeQ(`SELECT ROUND(AVG(DATE_PART('day', hired_at - created_at)))::int AS cnt
               FROM candidates
              WHERE hired_at IS NOT NULL AND company_id = $1 AND deleted_at IS NULL
                ${fTth}`, qTth.params),
    ]);

    return {
      open_positions:      parseInt(positions.cnt)  || 0,
      open_headcount:      parseInt(headcount.cnt)  || 0,
      active_candidates:   parseInt(active.cnt)     || 0,
      total_candidates:    parseInt(total.cnt)      || 0,
      interviews_today:    parseInt(todayIv.cnt)    || 0,
      upcoming_interviews: parseInt(upcomingIv.cnt) || 0,
      pending_offers:      parseInt(offers.cnt)     || 0,
      // Renamed in meaning: hires within the selected period, not the calendar
      // month. Key kept so existing callers keep rendering.
      hired_this_month:    parseInt(hired.cnt)      || 0,
      hired_in_period:     parseInt(hired.cnt)      || 0,
      avg_time_to_hire:    tth.cnt == null ? null : parseInt(tth.cnt),
    };
  },

  async getDashboard(company_id, filters = {}) {
    return this.getRecruitmentKpis(company_id, filters);
  },

  // Single source of truth for candidate-pipeline-by-stage counts, used by
  // /pipeline-summary (company-wide), /pipeline/:job_opening_id (scoped to one
  // opening — previously a separate getCandidatePipeline() with its own SQL
  // and a fixed-key-object shape instead of this array-of-{stage,count}
  // shape), and /talent/recruiter-dashboard (previously its own third copy).
  async getPipelineSummary(company_id, job_opening_id = null, filters = {}) {
    // All 13 stages of candidates_current_stage_check, in pipeline order.
    const STAGE_ORDER = {
      applied: 1, screening: 2, shortlisted: 3, assessment: 4, '1st_level': 5, '2nd_level': 6,
      offer: 7, selected: 8, hired: 9, maybe: 10, future_use: 11, not_suitable: 12, rejected: 13,
    };
    const STAGE_COLORS = {
      applied:    '#64748b',
      screening:  '#3b82f6',
      '1st_level':'#8b5cf6',
      '2nd_level':'#a855f7',
      shortlisted:'#6d28d9',
      assessment: '#92610a',
      selected:   '#15803d',
      offer:      '#f59e0b',
      hired:      '#22c55e',
      not_suitable:'#ef4444',
      maybe:      '#06b6d4',
      future_use: '#6366f1',
      rejected:   '#dc2626',
    };
    // Company-wide, this counts CANDIDATES by their headline stage — the right
    // question for "how many people are in our pipeline". Scoped to one opening
    // it counts APPLICATIONS instead, because per-job the question is "how many
    // are at each stage FOR THIS ROLE", and a candidate can legitimately sit at
    // different stages on two different roles. Same endpoint, two populations,
    // on purpose.
    if (job_opening_id) {
      const params = [job_opening_id];
      let extra = '';
      if (company_id) { extra = ` AND ca.company_id = $2`; params.push(company_id); }
      const { rows } = await pool.query(
        `SELECT ca.stage, COUNT(*) AS count
           FROM candidate_applications ca
           JOIN candidates c ON c.id = ca.candidate_id
          WHERE ca.job_opening_id = $1 AND c.deleted_at IS NULL${extra}
          GROUP BY ca.stage`,
        params
      );
      return rows
        .map(r => ({
          stage: r.stage,
          count: parseInt(r.count),
          color: STAGE_COLORS[r.stage] || '#94a3b8',
          order: STAGE_ORDER[r.stage] || 99,
        }))
        .sort((a, b) => a.order - b.order);
    }

    let query = `
      SELECT current_stage AS stage, COUNT(*) AS count
      FROM candidates
      WHERE current_stage IS NOT NULL AND deleted_at IS NULL`;
    const params = [];
    let n = 1;
    if (company_id)     { query += ` AND company_id = $${n++}`;     params.push(company_id); }
    if (job_opening_id) { query += ` AND applied_job_id = $${n++}`; params.push(job_opening_id); }
    // Department (Dashboard filter): candidates carry none, so match through
    // the job they applied to. Stage counts are point-in-time — no period.
    if (filters.department) { query += ` AND applied_job_id IN (SELECT id FROM job_openings WHERE department = $${n++})`; params.push(filters.department); }
    query += ` GROUP BY current_stage`;
    const result = await pool.query(query, params);
    return result.rows
      .map(r => ({
        stage: r.stage,
        count: parseInt(r.count),
        color: STAGE_COLORS[r.stage] || '#94a3b8',
        order: STAGE_ORDER[r.stage] || 99,
      }))
      .sort((a, b) => a.order - b.order);
  },

  /**
   * Candidates by sourcing channel.
   *
   * COUNT(*) is cast to int: pg returns bigint as a STRING, and the Dashboard's
   * pie (recharts) skips any non-number value — with "9" it summed to 0 and
   * drew nothing (Dashboard review 2026-11-17).
   *
   * @param {number|null} company_id
   * @param {{from?:string|null,to?:string|null,department?:string|null}} [filters]
   *   period on candidates.created_at (when they came in); department through
   *   the applied job opening.
   */
  async getSourceAnalytics(company_id, filters = {}) {
    const { from = null, to = null, department = null } = filters;
    let query = `SELECT COALESCE(NULLIF(TRIM(source), ''), 'unknown') AS source, COUNT(*)::int AS count
                   FROM candidates WHERE deleted_at IS NULL`;
    const params = [];
    if (company_id) { params.push(company_id); query += ` AND company_id = $${params.length}`; }
    if (from)       { params.push(from);       query += ` AND created_at >= $${params.length}::date`; }
    if (to)         { params.push(to);         query += ` AND created_at < ($${params.length}::date + INTERVAL '1 day')`; }
    if (department) {
      params.push(department);
      query += ` AND applied_job_id IN (SELECT id FROM job_openings WHERE department = $${params.length})`;
    }
    query += ` GROUP BY 1 ORDER BY count DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  // Single source of truth for "time to hire" — also called by the top-level
  // /analytics/time-to-hire (HR Analytics' TimeToHireCard), which used to
  // reimplement this independently against candidates.stage, a column
  // nothing in this codebase ever writes (candidates use current_stage) —
  // confirmed live: that endpoint silently returned zero every time. Fixed
  // 2026-08-04 by pointing it here instead of duplicating a second, broken
  // copy of the same query. min/max/matched added for TimeToHireCard's
  // fastest/longest/sample-size fields; avg_days kept as the pre-existing
  // field name so HiringForecasts.jsx's lookup doesn't need to change.
  // Canonical "time to hire" — application (candidates.created_at) to actual
  // hire (candidates.hired_at), matching getRecruitmentKpis().avg_time_to_hire.
  //
  // This previously measured offer_sent_date − created_at over accepted offers,
  // which is time-to-OFFER, and excluded anyone hired without a formal offer
  // letter. /talent/recruiter-dashboard meanwhile measured hired_at − created_at,
  // so My Workbench and the Dashboard/Reports/Forecast reported different
  // "Average Time to Hire" figures from the same underlying data. One formula now.
  async getTimeToHire(company_id) {
    let query = `
      SELECT
        ROUND(AVG(DATE_PART('day', hired_at - created_at))) AS avg_days,
        ROUND(MIN(DATE_PART('day', hired_at - created_at))) AS min_days,
        ROUND(MAX(DATE_PART('day', hired_at - created_at))) AS max_days,
        COUNT(*) AS matched
      FROM candidates
      WHERE hired_at IS NOT NULL AND deleted_at IS NULL`;
    const params = [];
    if (company_id) { query += ` AND company_id = $1`; params.push(company_id); }
    const result = await pool.query(query, params);
    const row = result.rows[0];
    return {
      avg_days: parseInt(row.avg_days) || 0,
      min_days: parseInt(row.min_days) || 0,
      max_days: parseInt(row.max_days) || 0,
      matched: parseInt(row.matched) || 0,
    };
  },

  // Single source of truth for offer acceptance — also called by the
  // top-level /analytics/offer-acceptance (HR Analytics' OfferAcceptanceCard),
  // which used to reimplement this independently against candidates.status,
  // same dead-column bug as getTimeToHire above (real field is
  // candidates.overall_status; offer status itself lives on offer_letters,
  // not candidates, regardless). Fixed 2026-08-04. `offered`/`declined` added
  // for the card's breakdown row; `total`/`accepted`/`rate` kept as the
  // pre-existing field names for HiringForecasts.jsx.
  /**
   * @param {number|null} company_id
   * @param {{from?: string|null, to?: string|null}} [range] optional issue-date
   *   window, from resolveRange(). Callers that omit it keep the previous
   *   all-time behaviour, so HR Dashboard and Recruitment are unchanged.
   *
   *   HR Benchmarking DOES pass one: its cards sit under a period filter and a
   *   rail that names the window, so an unwindowed "2 accepted of 3 offers"
   *   read as activity inside that window when it was the company's whole
   *   history. Windowed on the date the offer went out — offer_sent_date, with
   *   created_at as the fallback for rows still in draft.
   */
  async getOfferAcceptanceRate(company_id, range = null) {
    let query = `
      SELECT
        COUNT(CASE WHEN offer_status IN ('sent','accepted','declined') THEN 1 END) AS offered,
        COUNT(CASE WHEN offer_status = 'accepted' THEN 1 END) AS accepted,
        COUNT(CASE WHEN offer_status = 'declined' THEN 1 END) AS declined
      FROM offer_letters WHERE deleted_at IS NULL`;
    const params = [];
    if (company_id) { query += ` AND company_id = $1`; params.push(company_id); }
    const issued = `COALESCE(offer_sent_date, created_at::date)`;
    if (range?.from) { params.push(range.from); query += ` AND ${issued} >= $${params.length}::date`; }
    if (range?.to)   { params.push(range.to);   query += ` AND ${issued} <= $${params.length}::date`; }
    const result = await pool.query(query, params);
    const row = result.rows[0];
    const offered  = parseInt(row.offered)  || 0;
    const accepted = parseInt(row.accepted) || 0;
    const declined = parseInt(row.declined) || 0;
    // One decimal place, matching /analytics/hr-benchmarks. The two surfaces
    // previously rounded the same ratio to different precision (66.67 vs 66.7),
    // which reads as two different numbers for one KPI.
    const rate = offered > 0 ? (accepted / offered * 100).toFixed(1) : 0;
    return { offered, accepted, declined, total: offered, rate: parseFloat(rate) };
  },

  async getInterviewToHireRatio(company_id) {
    const params = [];
    let n = 1;
    let candFilter = `overall_status = 'hired' AND deleted_at IS NULL`;
    let schedFilter = `s.deleted_at IS NULL`;
    if (company_id) {
      candFilter  += ` AND company_id = $${n}`;
      schedFilter += ` AND s.company_id = $${n}`;
      params.push(company_id);
      n++;
    }
    // `hired` used to be every hired candidate in the company, while
    // `interviewed` only counted candidates with an interview_schedules row.
    // Those are different populations, so a company that hires anyone without a
    // scheduled interview — a direct hire, a pre-migration record — reported a
    // "ratio" above 100%. This database showed 150%. A conversion rate whose
    // numerator is not a subset of its denominator is not a rate.
    //
    // Both halves now count the SAME population: candidates who were actually
    // interviewed. `hired_total` is kept alongside so the gap stays visible
    // rather than being quietly folded away.
    const query = `
      SELECT COUNT(DISTINCT s.candidate_id) AS interviewed,
             COUNT(DISTINCT s.candidate_id) FILTER (
               WHERE c.overall_status = 'hired' AND c.deleted_at IS NULL
             ) AS hired,
             (SELECT COUNT(*) FROM candidates WHERE ${candFilter}) AS hired_total
      FROM interview_schedules s
      JOIN candidates c ON c.id = s.candidate_id
      WHERE ${schedFilter}`;
    const result = await pool.query(query, params);
    const row = result.rows[0];
    const ratio = row.interviewed > 0 ? (row.hired / row.interviewed * 100).toFixed(2) : 0;
    return {
      interviewed:  parseInt(row.interviewed),
      hired:        parseInt(row.hired),
      hired_total:  parseInt(row.hired_total),
      hired_without_interview: parseInt(row.hired_total) - parseInt(row.hired),
      ratio: parseFloat(ratio),
    };
  },

  // ==================== HIRE CANDIDATE (full transaction) ====================
  // Single employee-creation path for /candidates/:id/hire (direct hire, no
  // options) and /auto-creation/:candidateId/trigger (passes employmentType/
  // offeredSalary/sourceCandidateId — that route previously reimplemented all
  // of this separately). `options` fields are all optional so the direct-hire
  // caller's behavior is unchanged.
  // This is the single chokepoint every hire path funnels through (move-stage →
  // hired, offer-accept, the manual auto-creation trigger, and the direct
  // POST /candidates/:id/hire route). The duplicate guard therefore lives HERE
  // rather than only in autoCreateEmployeeFromCandidate() — that wrapper's
  // creation-log check protected three of those four paths, leaving the direct
  // route able to create a second employee, login and payroll enrolment for a
  // candidate who was already hired.
  async hireCandidate(candidateId, companyId, dbClient, options = {}) {
    const client = dbClient || pool;
    const { employmentType = null, offeredSalary = null, sourceCandidateId = null, joiningDate = null, designation = null } = options;

    // 1. Load candidate + job title — scoped to companyId so a candidate id
    // belonging to another company can't be hired into this one (it wasn't
    // scoped here before, despite companyId being passed in).
    const candResult = await client.query(
      `SELECT c.*, COALESCE(jo.job_title, jr.job_title) AS job_title,
              jo.id AS job_opening_id, jo.department,
              COALESCE(jo.number_of_positions, jr.number_of_positions) AS number_of_positions
       FROM candidates c
       LEFT JOIN job_openings jo ON c.applied_job_id = jo.id
       LEFT JOIN job_requisitions jr ON jo.requisition_id = jr.id
       WHERE c.id = $1 AND ($2::int IS NULL OR c.company_id = $2)`,
      [candidateId, companyId]
    );
    const cand = candResult.rows[0];
    if (!cand) throw Object.assign(new Error('Candidate not found'), { statusCode: 404 });

    // 1b. Idempotency guard — refuse to hire a candidate who already has an
    // employee record. Checked inside the caller's transaction so a concurrent
    // double-submit serialises on the advisory lock below rather than both
    // passing this check.
    const dupe = await client.query(
      `SELECT office_id FROM employees
        WHERE source_candidate_id = $1 AND ($2::int IS NULL OR company_id = $2)
        LIMIT 1`,
      [candidateId, companyId]
    );
    if (dupe.rows.length) {
      throw Object.assign(
        new Error(`This candidate has already been hired as employee ${dupe.rows[0].office_id}.`),
        { statusCode: 409 }
      );
    }

    // 2. Employee ID, from the ONE shared generator — shared/employeeCode.js.
    //
    // This used to hold its own copy of the mint, and it was the origin of a
    // deeper mistake: it produced the hyphenated `EMP-0001`, and because two
    // other (dead) helpers did too, a later pass concluded that was the canonical
    // format and backfilled 35 employees as `EMP-00xx`. The real convention is
    // `EMP001` — company 1's oldest rows, EMP001…EMP012, predate all of it.
    //
    // Its MAX() also read only `^EMP-[0-9]+`, which EMP001…EMP012 do not match,
    // so it saw a max of 2 and would have reissued numbers already in use.
    // nextEmployeeCode() reads the numeric suffix of every EMP-prefixed code in
    // the company, so a candidate hired now gets the next number in that
    // company's own series — EMP039 where the highest is EMP038.
    //
    // assertCodeAvailable is the check-then-act backstop under the advisory
    // lock, for the same reason the direct Add Employee path has it.
    const minted = await nextEmployeeCode(client, companyId ?? null);
    const employeeId = await assertCodeAvailable(client, minted, companyId ?? null);

    // 3. Split full_name
    const nameParts = (cand.full_name || '').trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName  = nameParts.slice(1).join(' ') || '';

    // 4. Create employee record (column names match actual employees table schema)
    // Department and designation are mandatory on an employee master record
    // (see REQUIRED_ON_CREATE in employee.service.js). This path bypasses that
    // service entirely, and both values come from the JOINed job opening /
    // requisition — which are nullable. Live proof: employee 45, hired through
    // here, sits on the All Employees register with Department AND Role blank.
    // Refuse the hire with a message that names what to fix, rather than
    // minting an incomplete master record that HR then has to find.
    const hireDept = String(cand.department ?? '').trim();
    // The designation on the accepted offer letter is what the person signed;
    // the job title is the fallback (it used to be used even when the letter
    // said otherwise, e.g. a "[SAMPLE] …" job title on the employee record).
    const hireRole = String(designation || cand.job_title || '').trim();
    const gaps = [];
    if (!hireDept) gaps.push('department');
    if (!hireRole) gaps.push('job title');
    if (gaps.length) {
      throw Object.assign(
        new Error(
          `Cannot create an employee record: the job opening has no ${gaps.join(' or ')}. ` +
          `Set ${gaps.length === 1 ? 'it' : 'them'} on the job opening or requisition, then hire.`,
        ),
        { statusCode: 400 },
      );
    }

    // 4a. Joining date and probation (§269). A hire used to start 'Active'
    // on CURRENT_DATE with no probation dates, so it never reached Probation
    // Management, the reminder job or a review. Now:
    //   - joining date = the accepted offer's joining date, else today;
    //   - status 'Probation' with the company's default period
    //     (Probation settings) and the end date by the one calendar rule
    //     (shared/probationDates.js), as Add Employee does;
    //   - interns, contract, consultant, temporary and freelance hires have no
    //     probation and start 'Active', as before.
    const { rows: [{ today }] } = await client.query(`SELECT CURRENT_DATE::text AS today`);
    const joining = toIsoDate(joiningDate) ?? today;
    const onProbation = companyId != null
      && !/intern|contract|consult|temporar|freelanc/i.test(String(employmentType ?? ''));
    let probationMonths = null;
    let probationEnd = null;
    if (onProbation) {
      probationMonths = (await getProbationPolicy(client, companyId)).probation_months;
      probationEnd = probationEndDate(joining, probationMonths);
    }

    const empResult = await client.query(
      `INSERT INTO employees
         (company_id, office_id, first_name, last_name, company_email, phone,
          department, designation, employment_type, status, joining_date,
          probation_months, probation_end_date, source_candidate_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12,$13::date,$14) RETURNING *`,
      [companyId, employeeId, firstName, lastName, cand.email, cand.phone,
       hireDept, hireRole, employmentType, onProbation ? 'Probation' : 'Active', joining,
       probationMonths, probationEnd, sourceCandidateId]
    );
    const employee = empResult.rows[0];

    // 4b. Payroll enrolment. A hire does NOT get a salary revision from here.
    //
    // The accepted offer's `offered_salary` is an ANNUAL CTC — both offer
    // forms label it "Annual CTC" and every stored offer is ₹7.5–9 L. It used
    // to be written as the MONTHLY Basic of the first salary revision: EMP038
    // was hired on a ₹7,50,000 annual offer and was then computed at ₹7,50,000
    // Basic a month (₹18.75 L gross). Turning an annual CTC into a monthly
    // Basic depends on the company's CTC definition and the salary structure
    // (PAYROLL_DATA_FLOW_AUDIT.md Part 3), so it is left to HR: payroll lists
    // the hire as "not eligible — no salary revision" with the offer's annual
    // CTC in the reason, and HR records the monthly Basic via Salary
    // Structure → Assign. (Without an offer, the old bare INSERT took the
    // column DEFAULT of 30000; that default is gone, migration 20261020000001.)
    const payrollEnrolled = false;
    void offeredSalary;

    // 4c. Provision a login — this is the more common real-world hire path
    // (per the comment above) but was the one employee-creation path that
    // never called anything equivalent to employee.service.js's own
    // createEmployeeLogin/INSERT INTO users. A recruitment-sourced hire had
    // an employee record but no way to actually sign in. Reuses the same
    // helper the direct "Add Employee" flow uses (email fallback,
    // existing-account skip, role sync, primary scope).
    //
    // ⚠ `loginProvisioned` was set to true whenever the call did not throw —
    // but createEmployeeLogin() returns null WITHOUT throwing when it skips:
    // no e-mail on the record, or an account already exists for the address
    // (that account is deliberately left untouched). Those hires were reported,
    // and logged on the auto-creation checklist, as "Login account created"
    // when no login had been created. Now it is true only when the helper says
    // it created one, and `loginStatus` says which of the other cases applied.
    let loginProvisioned = false;
    let loginStatus = 'failed';
    try {
      const login = await createEmployeeLogin(client, employee);
      loginProvisioned = login?.created === true;
      if (loginProvisioned) {
        loginStatus = 'created';
      } else {
        // The helper's own two skip reasons: no address to key a login on, or
        // an account already holds that address (including the race its
        // ON CONFLICT DO NOTHING absorbs).
        const hasEmail = String(employee.personal_email || employee.company_email || '').trim() !== '';
        loginStatus = hasEmail ? 'existing_account' : 'no_email';
      }
    } catch (e) {
      console.error('[hireCandidate] login provisioning failed:', e.message);
    }

    // 4d. Auto-init the onboarding checklist - covers both callers of this
    // function (POST /candidates/:id/hire and POST /auto-creation/:id/trigger)
    // instead of leaving it as a manual POST /onboarding/progress/:id/init
    // call HR had to remember to make. See AUTOMATION_OPPORTUNITY_AUDIT.md
    // section 9.1.
    let onboardingInitialized = false;
    try {
      await initOnboardingChecklist(client, companyId, employee.id);
      onboardingInitialized = true;
    } catch (e) {
      console.error('[hireCandidate] onboarding checklist init failed:', e.message);
    }

    // 5. Mark candidate as hired
    await client.query(
      `UPDATE candidates
       SET overall_status = 'hired', current_stage = 'hired',
           hired_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [candidateId]
    );
    await client.query(
      `UPDATE candidate_applications SET stage = 'hired', status = 'hired', updated_at = NOW()
        WHERE candidate_id = $1 AND is_primary`,
      [candidateId]
    );
    await client.query(
      `INSERT INTO candidate_stage_history (candidate_id, stage, notes)
       VALUES ($1, 'hired', 'Converted to employee')`,
      [candidateId]
    );

    // 6. Record the filled position on the opening.
    //
    // This is the ONLY place positions_filled is incremented. acceptOffer() used
    // to increment it as well, so the offer-accept path (which then triggers
    // this function) counted a single hire twice against the opening's headcount.
    //
    // The opening also used to be closed unconditionally on the first hire — a
    // 5-position requisition closed after one candidate, hiding it from every
    // "open positions" count while four seats were still unfilled. It now closes
    // only once the requisition's full headcount is met (openings with no linked
    // requisition have no headcount to compare against and keep the old
    // close-on-first-hire behaviour).
    if (cand.job_opening_id) {
      await client.query(
        `UPDATE job_openings
            SET positions_filled = COALESCE(positions_filled,0) + 1,
                status = CASE
                  WHEN $2::int IS NULL OR COALESCE(positions_filled,0) + 1 >= $2::int
                    THEN 'closed' ELSE status END,
                updated_at = NOW()
          WHERE id = $1`,
        [cand.job_opening_id, cand.number_of_positions ?? null]
      );
      // Its requisition is fulfilled with it (Jobs review 2026-11-17: the
      // requisition stayed "Open" after the last seat was filled).
      const filled = await client.query(
        `UPDATE job_requisitions jr SET status = 'closed', updated_at = NOW()
           FROM job_openings jo
          WHERE jo.id = $1 AND jr.id = jo.requisition_id AND jo.status = 'closed' AND jr.status = 'open'
          RETURNING jr.id, jr.company_id`,
        [cand.job_opening_id]
      );
      if (filled.rows[0]) {
        await recruitmentRepository.recordJobEvent({
          company_id: filled.rows[0].company_id, requisition_id: filled.rows[0].id,
          job_opening_id: cand.job_opening_id, event: 'filled', from_status: 'open', to_status: 'closed',
          comment: 'Every position is filled — the job and its requisition closed automatically.',
        }, client);
      }
    }

    return { employee, employeeId, payrollEnrolled, loginProvisioned, loginStatus, onboardingInitialized };
  },

  // ==================== AUTO-CREATE EMPLOYEE FROM HIRED CANDIDATE ====================
  // Extracted from the POST /auto-creation/:candidateId/trigger route body so the
  // same logic can run automatically the moment a candidate reaches Hired status
  // (moveCandidateStage / acceptOffer in recruitment.routes.js), not only when a
  // human opens the Auto-Creation queue and clicks Trigger. See
  // AUTOMATION_OPPORTUNITY_AUDIT.md §10.1. Returns a {status, ...} result instead
  // of writing an HTTP response so both the manual route and the fire-and-forget
  // callers can use it; never throws for expected outcomes (not-hired,
  // already-created) — only a genuine hireCandidate() failure is caught and
  // reported via the log row's 'failed' status.
  async autoCreateEmployeeFromCandidate(candidateId, companyId, triggeredBy = null) {
    const { rows: candidates } = await pool.query(`
      SELECT c.*, jo.id AS job_opening_id, jo.job_title, jo.department, jo.location, jo.employment_type,
             o.id AS accepted_offer_id, o.offered_salary, o.joining_date, o.designation AS offer_designation
        FROM candidates c
        LEFT JOIN job_openings jo ON jo.id = c.applied_job_id
        LEFT JOIN offer_letters o ON o.candidate_id = c.id AND o.offer_status = 'accepted'
       WHERE c.id = $1 AND c.company_id = $2
    `, [candidateId, companyId]);

    if (!candidates.length) return { status: 404, error: 'Candidate not found' };
    const c = candidates[0];
    if ((c.current_stage || '').toLowerCase() !== 'hired') {
      return { status: 400, error: 'Candidate must be in Hired stage' };
    }

    const { rows: existing } = await pool.query(
      `SELECT * FROM recruitment_employee_creation_log WHERE candidate_id = $1 AND company_id = $2 AND status = 'completed'`,
      [candidateId, companyId]
    );
    if (existing.length) {
      return { status: 409, error: 'Employee already created for this candidate', employee_code: existing[0].employee_code };
    }

    const { rows: logRows } = await pool.query(`
      INSERT INTO recruitment_employee_creation_log
        (company_id, candidate_id, candidate_name, job_opening_id, job_title, status, triggered_by)
      VALUES ($1,$2,$3,$4,$5,'in_progress',$6)
      ON CONFLICT DO NOTHING
      RETURNING *
    `, [companyId, candidateId, c.full_name, c.job_opening_id, c.job_title, triggeredBy]);
    const logId = logRows[0]?.id;

    // hireCandidate() was previously called with the bare `pool` here, so this —
    // the path every automatic hire actually takes — ran 7+ sequential writes
    // (employee, salary, login, onboarding, candidate, stage history, opening)
    // with no transaction: a failure partway left an orphaned half-provisioned
    // employee. A real client also makes hireCandidate()'s advisory lock
    // effective, since an advisory *xact* lock is a no-op outside a transaction.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { employee, employeeId, payrollEnrolled, loginProvisioned, loginStatus, onboardingInitialized } =
        await this.hireCandidate(candidateId, companyId, client, {
          employmentType: c.employment_type,
          offeredSalary: parseFloat(c.offered_salary),
          sourceCandidateId: candidateId,
          joiningDate: c.joining_date,
          designation: c.offer_designation || null,
        });

      const checklist_items = [
        { task: 'Employee record created', done: true, note: `Code: ${employeeId}` },
        { task: 'Login account created', done: loginProvisioned,
          // Says why when no login was created, so HR is not left to guess.
          ...(LOGIN_STATUS_NOTES[loginStatus] ? { note: LOGIN_STATUS_NOTES[loginStatus] } : {}) },
        { task: 'Official email request pending', done: false },
        { task: 'Onboarding checklist to be created', done: onboardingInitialized },
        { task: 'Attendance profile to be configured', done: false },
        { task: 'Leave profile to be configured', done: false },
        { task: 'Payroll profile configured', done: payrollEnrolled },
        { task: 'Document folder to be created', done: false },
        { task: 'Org chart node to be added', done: false },
      ];

      await client.query(`
        UPDATE recruitment_employee_creation_log
           SET status = 'completed', employee_id = $1, employee_code = $2, completed_at = NOW(),
               checklist_items = $3
         WHERE id = $4
      `, [employee.id, employeeId, JSON.stringify(checklist_items), logId]);

      await client.query('COMMIT');

      // Welcome e-mail. It used to fire only from POST /candidates/:id/hire,
      // which no screen called, so no new joiner ever received it.
      triggerEmail('hired_welcome', {
        candidate_email: c.email || employee.company_email || '',
        candidate_name:  c.full_name || '',
        job_title:       c.offer_designation || c.job_title || '',
        joining_date:    c.joining_date ? toIsoDate(c.joining_date) : (employee.joining_date ? toIsoDate(employee.joining_date) : ''),
        employee_id:     employeeId,
      }, companyId);

      // Agency fee owed for a candidate the agency supplied (missing feature 7).
      if (c.source_agency_id) {
        await pool.query(
          `INSERT INTO recruitment_agency_fees
             (company_id, agency_id, candidate_id, employee_id, offer_id, annual_ctc, fee_percentage, fee_amount)
           SELECT $1, a.id, $2, $3, $4, $5::numeric, a.fee_percentage,
                  CASE WHEN a.fee_percentage IS NULL OR $5::numeric IS NULL THEN NULL
                       ELSE ROUND($5::numeric * a.fee_percentage / 100, 2) END
             FROM recruitment_agencies a
            WHERE a.id = $6 AND a.company_id = $1
           ON CONFLICT DO NOTHING`,
          [companyId, candidateId, employee.id, c.accepted_offer_id || null,
           c.offered_salary != null ? Number(c.offered_salary) : null, c.source_agency_id]
        ).catch(err => console.warn('[Recruitment] agency fee row failed:', err.message));
      }
      return { status: 201, employee, employeeId, candidateName: c.full_name, checklist: checklist_items };
    } catch (empErr) {
      await client.query('ROLLBACK').catch(() => {});
      // The failure log is written on the pool, not the rolled-back client —
      // otherwise it would be discarded along with the failed hire.
      await pool.query(`UPDATE recruitment_employee_creation_log SET status='failed', error_log=$1 WHERE id=$2`, [empErr.message, logId])
        .catch(() => {});
      // A duplicate-hire rejection is an expected outcome, not a failure to
      // report as a 500 — surface hireCandidate()'s own status code.
      return { status: empErr.statusCode || 500, error: empErr.statusCode === 409 ? empErr.message : `Employee creation failed: ${empErr.message}` };
    } finally {
      client.release();
    }
  },

  // ==================== REPORTS ====================
  // Reports & Setup → Reports (review 2026-11-17). Rules shared by every report:
  //  • to_date is INCLUSIVE: `created_at <= '2026-11-17'` stopped at midnight,
  //    so everything that happened on the last day (today, by default) was missing.
  //  • department = the job's department, else its requisition's — the same
  //    rule everywhere. Three of the four reports ignored ?department= entirely.
  //  • COUNT() is cast ::int so the page never sums strings.
  async getReportsSummary({ company_id, from_date, to_date, department }) {
    const params = [company_id ?? null, from_date || null, to_date || null, deptList(department)];
    const { rows: [cand] } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE in_period)::int                                  AS total_candidates,
        COUNT(*) FILTER (WHERE in_period AND overall_status = 'hired')::int     AS total_hired,
        COUNT(*) FILTER (WHERE in_period AND overall_status = 'rejected')::int  AS total_rejected,
        COUNT(*) FILTER (WHERE in_period AND overall_status = 'active')::int    AS active_pipeline,
        -- Hires MADE in the period (by hire date), whenever they applied.
        COUNT(*) FILTER (WHERE hired_in_period)::int                            AS hired_in_period,
        ROUND(AVG(DATE_PART('day', hired_at - created_at)) FILTER (WHERE hired_in_period))::int AS avg_time_to_hire
      FROM (
        SELECT c.overall_status, c.hired_at, c.created_at,
               (($2::date IS NULL OR c.created_at >= $2::date) AND ($3::date IS NULL OR c.created_at < $3::date + 1)) AS in_period,
               (c.hired_at IS NOT NULL AND ($2::date IS NULL OR c.hired_at >= $2::date) AND ($3::date IS NULL OR c.hired_at < $3::date + 1)) AS hired_in_period
          FROM candidates c
          LEFT JOIN job_openings jo ON jo.id = c.applied_job_id
          LEFT JOIN job_requisitions jr ON jr.id = jo.requisition_id
         WHERE c.deleted_at IS NULL
           AND ($1::int IS NULL OR c.company_id = $1)
           AND ($4::text[] IS NULL OR COALESCE(jo.department, jr.department) = ANY($4::text[]))
      ) x`, params);
    const offers = await this.getOffersReport({ company_id, from_date, to_date, department });
    return { ...cand, offers: offers.totals };
  },

  // Point-in-time: every job open RIGHT NOW, however long ago it was posted.
  // It used to keep only jobs CREATED inside the date range, so with the
  // default 60-day window a vacancy could never reach the 60-day "At Risk" line.
  async getVacancyAging({ company_id, department }) {
    const { rows } = await pool.query(`
      SELECT jo.id, jo.job_title, COALESCE(jo.department, jr.department) AS department, jo.status,
             TO_CHAR(COALESCE(jo.posted_date, jo.created_at::date), 'YYYY-MM-DD') AS opened_on,
             (CURRENT_DATE - COALESCE(jo.posted_date, jo.created_at::date))::int AS days_open,
             TO_CHAR(jo.closing_date, 'YYYY-MM-DD') AS closing_date,
             COALESCE(jo.positions_filled, 0)::int AS positions_filled,
             COALESCE(jo.number_of_positions, jr.number_of_positions, 1)::int AS number_of_positions,
             (SELECT COUNT(*) FROM candidate_applications ca JOIN candidates c ON c.id = ca.candidate_id
               WHERE ca.job_opening_id = jo.id AND c.deleted_at IS NULL)::int AS applicant_count,
             (SELECT COUNT(*) FROM candidate_applications ca JOIN candidates c ON c.id = ca.candidate_id
               WHERE ca.job_opening_id = jo.id AND c.deleted_at IS NULL AND ca.status = 'active')::int AS active_applicants
        FROM job_openings jo
        LEFT JOIN job_requisitions jr ON jo.requisition_id = jr.id
       WHERE jo.deleted_at IS NULL AND jo.status IN ('open', 'on_hold')
         AND ($1::int IS NULL OR jo.company_id = $1)
         AND ($2::text[] IS NULL OR COALESCE(jo.department, jr.department) = ANY($2::text[]))
       ORDER BY days_open DESC, jo.id`, [company_id ?? null, deptList(department)]);
    return rows;
  },

  async getSourceEffectiveness({ company_id, from_date, to_date, department }) {
    const { rows } = await pool.query(`
      SELECT COALESCE(NULLIF(c.source, ''), 'unknown') AS source,
             COUNT(*)::int AS total_applications,
             COUNT(*) FILTER (WHERE c.overall_status = 'hired')::int AS hires,
             COUNT(*) FILTER (WHERE c.overall_status = 'rejected')::int AS rejections,
             COUNT(*) FILTER (WHERE c.overall_status = 'active')::int AS in_progress,
             ROUND(100.0 * COUNT(*) FILTER (WHERE c.overall_status = 'hired') / NULLIF(COUNT(*), 0), 1)::float AS hire_rate_pct
        FROM candidates c
        LEFT JOIN job_openings jo ON jo.id = c.applied_job_id
        LEFT JOIN job_requisitions jr ON jr.id = jo.requisition_id
       WHERE c.deleted_at IS NULL
         AND ($1::int IS NULL OR c.company_id = $1)
         AND ($2::date IS NULL OR c.created_at >= $2::date)
         AND ($3::date IS NULL OR c.created_at < $3::date + 1)
         AND ($4::text[] IS NULL OR COALESCE(jo.department, jr.department) = ANY($4::text[]))
       GROUP BY 1
       ORDER BY hires DESC, total_applications DESC`,
      [company_id ?? null, from_date || null, to_date || null, deptList(department)]);
    return rows;
  },

  // Applications (one per candidate per job), so a candidate put forward to a
  // second job counts in that job's department too — the same unit the job
  // boards count. Every stage is listed; shortlisted, assessment and selected
  // were missing, so the columns never added up to Total.
  async getDepartmentPipeline({ company_id, from_date, to_date, department }) {
    const stageCols = REPORT_PIPELINE_STAGES
      .map(st => `COUNT(*) FILTER (WHERE ca.stage = '${st}')::int AS "${st}"`).join(',\n             ');
    const { rows } = await pool.query(`
      SELECT COALESCE(jo.department, jr.department, 'Unassigned') AS department,
             COUNT(*)::int AS total,
             ${stageCols},
             COUNT(*) FILTER (WHERE ca.stage IN ('rejected', 'not_suitable'))::int AS rejected,
             COUNT(*) FILTER (WHERE ca.stage IN ('maybe', 'future_use'))::int AS parked
        FROM candidate_applications ca
        JOIN candidates c ON c.id = ca.candidate_id AND c.deleted_at IS NULL
        LEFT JOIN job_openings jo ON jo.id = ca.job_opening_id
        LEFT JOIN job_requisitions jr ON jr.id = jo.requisition_id
       WHERE ($1::int IS NULL OR ca.company_id = $1)
         AND ($2::date IS NULL OR COALESCE(ca.applied_at, ca.created_at) >= $2::date)
         AND ($3::date IS NULL OR COALESCE(ca.applied_at, ca.created_at) < $3::date + 1)
         AND ($4::text[] IS NULL OR COALESCE(jo.department, jr.department) = ANY($4::text[]))
       GROUP BY 1
       ORDER BY total DESC`,
      [company_id ?? null, from_date || null, to_date || null, deptList(department)]);
    return rows;
  },

  // Offers made in the period (by the day they went out; drafts by creation):
  // the outcome of each, why declined/withdrawn, and how long candidates took.
  async getOffersReport({ company_id, from_date, to_date, department }) {
    const { rows } = await pool.query(`
      SELECT ol.id, ol.offer_no, ol.offer_status, ol.designation, ol.offered_salary::float AS offered_salary,
             c.full_name AS candidate_name,
             ${recordDepartmentSql('ol')} AS department,
             TO_CHAR(ol.offer_sent_date, 'YYYY-MM-DD') AS sent_on,
             TO_CHAR(ol.response_date, 'YYYY-MM-DD') AS answered_on,
             TO_CHAR(ol.offer_expiry_date, 'YYYY-MM-DD') AS valid_until,
             CASE WHEN ol.offer_sent_date IS NOT NULL AND ol.response_date IS NOT NULL
                  THEN (ol.response_date - ol.offer_sent_date)::int END AS days_to_answer,
             ol.close_reason
        FROM offer_letters ol
        JOIN candidates c ON c.id = ol.candidate_id
       WHERE ol.deleted_at IS NULL
         AND ($1::int IS NULL OR ol.company_id = $1)
         AND ($2::date IS NULL OR COALESCE(ol.offer_sent_date, ol.created_at::date) >= $2::date)
         AND ($3::date IS NULL OR COALESCE(ol.offer_sent_date, ol.created_at::date) <= $3::date)
         AND ($4::text[] IS NULL OR ${recordDepartmentSql('ol')} = ANY($4::text[]))
       ORDER BY COALESCE(ol.offer_sent_date, ol.created_at::date) DESC`,
      [company_id ?? null, from_date || null, to_date || null, deptList(department)]);
    const count = (st) => rows.filter(r => r.offer_status === st).length;
    const answered = rows.filter(r => r.days_to_answer != null && ['accepted', 'declined'].includes(r.offer_status));
    const madeToCandidate = count('sent') + count('accepted') + count('declined');
    const totals = {
      total: rows.length,
      awaiting_approval: count('draft') + count('pending_approval'),
      sent: count('sent'),
      accepted: count('accepted'),
      declined: count('declined'),
      withdrawn: count('withdrawn'),
      acceptance_rate: madeToCandidate ? Math.round((count('accepted') / madeToCandidate) * 1000) / 10 : null,
      avg_days_to_answer: answered.length
        ? Math.round(answered.reduce((a, r) => a + r.days_to_answer, 0) / answered.length) : null,
    };
    return { totals, rows };
  },

  // Hiring Forecasts (review 2026-11-17). Demand by department from the
  // requisitions AND the jobs — the page used to read job openings only, so an
  // approved requisition with no job posted yet, or one awaiting approval, was
  // missing from "demand" altogether. Pipeline = ACTIVE applications on open
  // jobs (it counted rejected applicants as pipeline). `within_days` keeps the
  // jobs closing within N days (and the requisitions, which have no date).
  async getHiringForecast({ company_id, department = null, within_days = null }) {
    const days = Number.parseInt(within_days, 10);
    const params = [company_id ?? null, deptList(department), days > 0 && days <= 3650 ? days : null];
    const { rows: jobs } = await pool.query(`
      SELECT COALESCE(jo.department, jr.department, 'Unassigned') AS department,
             COUNT(*)::int AS open_roles,
             SUM(GREATEST(COALESCE(jo.number_of_positions, jr.number_of_positions, 1) - COALESCE(jo.positions_filled, 0), 0))::int AS open_seats,
             SUM((SELECT COUNT(*) FROM candidate_applications ca JOIN candidates c ON c.id = ca.candidate_id
                   WHERE ca.job_opening_id = jo.id AND ca.status = 'active' AND c.deleted_at IS NULL))::int AS pipeline,
             SUM((SELECT COUNT(*) FROM offer_letters ol
                   WHERE ol.job_opening_id = jo.id AND ol.deleted_at IS NULL
                     AND ol.offer_status IN ('draft', 'pending_approval', 'sent')))::int AS offers_out,
             TO_CHAR(MIN(jo.closing_date) FILTER (WHERE jo.closing_date >= CURRENT_DATE), 'YYYY-MM-DD') AS soonest_closing
        FROM job_openings jo
        LEFT JOIN job_requisitions jr ON jr.id = jo.requisition_id
       WHERE jo.deleted_at IS NULL AND jo.status IN ('open', 'on_hold')
         AND ($1::int IS NULL OR jo.company_id = $1)
         AND ($2::text[] IS NULL OR COALESCE(jo.department, jr.department) = ANY($2::text[]))
         AND ($3::int IS NULL OR (jo.closing_date IS NOT NULL AND jo.closing_date <= CURRENT_DATE + $3::int))
       GROUP BY 1`, params);
    const { rows: reqs } = await pool.query(`
      SELECT COALESCE(jr.department, 'Unassigned') AS department,
             COALESCE(SUM(jr.number_of_positions) FILTER (WHERE jr.status = 'approved'), 0)::int AS approved_not_posted,
             COALESCE(SUM(jr.number_of_positions) FILTER (WHERE jr.status = 'pending_approval'), 0)::int AS awaiting_approval
        FROM job_requisitions jr
       WHERE jr.deleted_at IS NULL AND jr.status IN ('approved', 'pending_approval')
         AND NOT EXISTS (SELECT 1 FROM job_openings jo WHERE jo.requisition_id = jr.id AND jo.deleted_at IS NULL
                           AND jo.status IN ('open', 'on_hold'))
         AND ($1::int IS NULL OR jr.company_id = $1)
         AND ($2::text[] IS NULL OR jr.department = ANY($2::text[]))
         AND $3::int IS NULL
       GROUP BY 1`, params);
    const byDept = new Map();
    const blank = (d) => ({ department: d, open_roles: 0, open_seats: 0, pipeline: 0, offers_out: 0, soonest_closing: null, approved_not_posted: 0, awaiting_approval: 0 });
    for (const r of jobs) byDept.set(r.department, { ...blank(r.department), ...r });
    for (const r of reqs) byDept.set(r.department, { ...(byDept.get(r.department) || blank(r.department)), ...r });
    const [tth, offers, i2h] = await Promise.all([
      this.getTimeToHire(company_id), this.getOfferAcceptanceRate(company_id), this.getInterviewToHireRatio(company_id),
    ]);
    return {
      rows: [...byDept.values()].sort((a, b) => (b.open_seats + b.approved_not_posted) - (a.open_seats + a.approved_not_posted)),
      rates: {
        avg_days_to_hire: tth.matched ? tth.avg_days : null,
        hires_measured: tth.matched,
        offer_acceptance_pct: offers.offered ? offers.rate : null,
        interview_to_hire_pct: i2h.interviewed ? i2h.ratio : null,
        interviewed: i2h.interviewed,
      },
    };
  },
};

export default recruitmentRepository;
