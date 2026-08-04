import pool from '../../shared/db.js';
import { createEmployeeLogin } from '../../../employees/employee.service.js';
import { pickUpdatable } from '../../../shared/safeUpdate.js';

const recruitmentRepository = {
  // ==================== JOB REQUISITIONS ====================
  async createRequisition(data) {
    const {
      job_title, department_id, employment_type, number_of_positions,
      job_description, skills_required, experience_required, location,
      salary_range, requested_by_employee_id, company_id,
    } = data;
    const result = await pool.query(
      `INSERT INTO job_requisitions
         (job_title, department, employment_type, number_of_positions, job_description,
          skills_required, experience_required, location, salary_range, requested_by,
          company_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft') RETURNING *`,
      [job_title, department_id, employment_type, number_of_positions, job_description,
       skills_required, experience_required, location, salary_range,
       requested_by_employee_id, company_id]
    );
    return result.rows[0];
  },

  async findRequisitions(filters = {}) {
    let query = `SELECT jr.*, e.name AS requested_by_name
                 FROM job_requisitions jr
                 LEFT JOIN employees e ON jr.requested_by = e.id
                 WHERE jr.deleted_at IS NULL`;
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
      `SELECT jr.*, e.name AS requested_by_name
       FROM job_requisitions jr
       LEFT JOIN employees e ON jr.requested_by = e.id
       WHERE jr.id = $1 AND jr.deleted_at IS NULL${extra}`,
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
    const safe = await pickUpdatable('job_requisitions', data);
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
        RETURNING *`,
      values
    );
    return result.rows[0];
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

  // ==================== JOB OPENINGS ====================
  async createOpening(data) {
    const {
      requisition_id, job_title, department, location, employment_type,
      experience_min, experience_max, salary_min, salary_max,
      closing_date, company_id, status,
      // form-field aliases from JobOpenings.jsx
      description: _desc, job_description,
      requirements: _req, skills_required,
      experience_required,
      salary_range,
      benefits,
    } = data;

    const description = _desc || job_description || null;
    // store skills + experience hint together in requirements when no structured fields
    const requirementsText = [
      _req || skills_required || null,
      experience_required ? `Experience: ${experience_required}` : null,
      salary_range ? `Salary: ${salary_range}` : null,
    ].filter(Boolean).join(' | ') || null;

    const result = await pool.query(
      `INSERT INTO job_openings
         (requisition_id, job_title, department, location, employment_type,
          experience_min, experience_max, salary_min, salary_max,
          description, requirements, benefits, closing_date, company_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [requisition_id || null, job_title, department, location, employment_type,
       experience_min || null, experience_max || null, salary_min || null, salary_max || null,
       description, requirementsText, benefits || null, closing_date || null, company_id,
       status || 'open']
    );
    if (requisition_id) {
      await pool.query(`UPDATE job_requisitions SET status = 'open' WHERE id = $1`, [requisition_id]);
    }
    return result.rows[0];
  },

  async findOpenings(filters = {}) {
    let query = `
      SELECT jo.*,
             jr.job_title AS req_job_title, jr.department AS req_department,
             jr.number_of_positions, jr.employment_type AS req_employment_type,
             jr.location AS req_location, jr.salary_range,
             (SELECT COUNT(*)::int FROM candidates c WHERE c.applied_job_id = jo.id AND c.deleted_at IS NULL) AS applicants_count
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
              jr.number_of_positions, jr.employment_type AS req_employment_type,
              jr.location AS req_location, jr.salary_range,
              jr.job_description, jr.skills_required, jr.experience_required,
              (SELECT COUNT(*)::int FROM candidates c WHERE c.applied_job_id = jo.id AND c.deleted_at IS NULL) AS applicants_count
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
    const safe = await pickUpdatable('job_openings', data);
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
  async createCandidate(data) {
    const {
      full_name, email, phone, resume_file_url, source, applied_job_id, company_id, source_agency_id,
      current_company, current_designation, experience_years, notice_period_days, expected_ctc, skills, notes,
    } = data;
    const result = await pool.query(
      `INSERT INTO candidates
         (full_name, email, phone, resume_file_url, source, applied_job_id,
          company_id, source_agency_id, current_company, current_designation,
          experience_years, notice_period_days, expected_ctc, skills, notes,
          current_stage, overall_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,'applied','active') RETURNING *`,
      [full_name, email, phone, resume_file_url, source, applied_job_id || null, company_id, source_agency_id || null,
       current_company || null, current_designation || null,
       experience_years ?? null, notice_period_days ?? null, expected_ctc ?? null,
       skills ? JSON.stringify(skills) : '[]', notes || null]
    );
    await pool.query(
      `INSERT INTO candidate_stage_history (candidate_id, stage, notes)
       VALUES ($1, 'applied', 'Application received')`,
      [result.rows[0].id]
    );
    return result.rows[0];
  },

  async bulkCreateCandidates(candidates) {
    if (!candidates.length) return [];

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

    return inserted.rows;
  },

  async findCandidates(filters = {}) {
    let query = `
      SELECT c.*, jo.id AS job_opening_id,
             COALESCE(jo.job_title, jr.job_title) AS job_title
      FROM candidates c
      LEFT JOIN job_openings jo ON c.applied_job_id = jo.id
      LEFT JOIN job_requisitions jr ON jo.requisition_id = jr.id
      WHERE c.deleted_at IS NULL`;
    const params = [];
    let n = 1;
    if (filters.company_id)    { query += ` AND c.company_id = $${n++}`;    params.push(filters.company_id); }
    if (filters.applied_job_id){ query += ` AND c.applied_job_id = $${n++}`; params.push(filters.applied_job_id); }
    if (filters.current_stage) { query += ` AND c.current_stage = $${n++}`; params.push(filters.current_stage); }
    if (filters.overall_status){ query += ` AND c.overall_status = $${n++}`; params.push(filters.overall_status); }
    if (filters.search) {
      query += ` AND (c.full_name ILIKE $${n} OR c.email ILIKE $${n})`;
      params.push(`%${filters.search}%`);
      n++;
    }
    query += ` ORDER BY c.created_at DESC`;
    const result = await pool.query(query, params);
    return result.rows;
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
  async moveCandidateStage(candidate_id, new_stage, moved_by, notes, company_id = null) {
    const extra = new_stage === 'hired'
      ? ', overall_status = \'hired\', hired_at = NOW()'
      : new_stage === 'rejected' || new_stage === 'not_suitable'
        ? ', overall_status = \'rejected\''
        : '';

    const result = await pool.query(
      `UPDATE candidates SET current_stage = $1, updated_at = CURRENT_TIMESTAMP ${extra}
        WHERE id = $2 AND ($3::int IS NULL OR company_id = $3)`,
      [new_stage, candidate_id, company_id]
    );
    if (result.rowCount === 0) throw new Error('Candidate not found');
    await pool.query(
      `INSERT INTO candidate_stage_history (candidate_id, stage, moved_by, notes)
       VALUES ($1, $2, $3, $4)`,
      [candidate_id, new_stage, moved_by, notes]
    );
  },

  async getCandidateStageHistory(candidate_id) {
    const result = await pool.query(
      `SELECT csh.*, TRIM(CONCAT(e.first_name, ' ', COALESCE(e.last_name, ''))) AS moved_by_name
       FROM candidate_stage_history csh
       LEFT JOIN employees e ON csh.moved_by = e.id
       WHERE csh.candidate_id = $1
       ORDER BY csh.moved_date DESC`,
      [candidate_id]
    );
    return result.rows;
  },

  async getCandidatesByStage(job_opening_id, stage, company_id = null) {
    const params = [job_opening_id, stage];
    let extra = '';
    if (company_id) { extra = ` AND c.company_id = $3`; params.push(company_id); }
    const result = await pool.query(
      `SELECT c.* FROM candidates c
       WHERE c.applied_job_id = $1 AND c.current_stage = $2 AND c.deleted_at IS NULL${extra}
       ORDER BY c.created_at DESC`,
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
    const { candidate_id, interviewer_id, interview_round, rating, comments, recommendation } = data;
    if (company_id) {
      const owns = await pool.query(
        `SELECT 1 FROM candidates WHERE id = $1 AND company_id = $2`,
        [candidate_id, company_id]
      );
      if (!owns.rows.length) throw new Error('Candidate not found');
    }
    const result = await pool.query(
      `INSERT INTO interview_notes
         (candidate_id, interviewer_id, interview_round, rating, comments, recommendation)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [candidate_id, interviewer_id, interview_round, rating, comments, recommendation]
    );
    return result.rows[0];
  },

  async findInterviewNotes(candidate_id, company_id = null) {
    const params = [candidate_id];
    let extra = '';
    if (company_id) { extra = ` AND c.company_id = $2`; params.push(company_id); }
    const result = await pool.query(
      `SELECT n.*, e.name AS interviewer_name
       FROM interview_notes n
       JOIN candidates c ON c.id = n.candidate_id
       LEFT JOIN employees e ON n.interviewer_id = e.id
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
    } = data;
    const result = await pool.query(
      `INSERT INTO interview_schedules
         (candidate_id, interview_date, interview_time, interview_mode,
          meeting_link, interviewer_id, notes, company_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'scheduled') RETURNING *`,
      [candidate_id, interview_date, interview_time, interview_mode,
       meeting_link, interviewer_id, notes, company_id]
    );
    return result.rows[0];
  },

  async findInterviews(filters = {}) {
    let query = `
      SELECT s.*, c.full_name AS candidate_name, c.email AS candidate_email,
             e.name AS interviewer_name, e.company_email AS interviewer_email
      FROM interview_schedules s
      LEFT JOIN candidates c ON c.id::text = s.candidate_id::text
      LEFT JOIN employees e ON e.id = s.interviewer_id
      WHERE s.deleted_at IS NULL`;
    const params = [];
    let n = 1;
    if (filters.company_id)    { query += ` AND s.company_id = $${n++}`;     params.push(filters.company_id); }
    if (filters.interviewer_id){ query += ` AND s.interviewer_id = $${n++}`; params.push(filters.interviewer_id); }
    if (filters.candidate_id)  { query += ` AND s.candidate_id = $${n++}`;   params.push(filters.candidate_id); }
    if (filters.interview_date){ query += ` AND s.interview_date = $${n++}`; params.push(filters.interview_date); }
    if (filters.status)        { query += ` AND s.status = $${n++}`;         params.push(filters.status); }
    query += ` ORDER BY s.interview_date, s.interview_time`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  // Same key-interpolation mass-assignment/injection issue as updateRequisition
  // above — see that comment.
  async updateInterview(id, data, company_id = null) {
    const safe = await pickUpdatable('interview_schedules', data);
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
  async createEmailTemplate(data) {
    const { template_name, template_type, subject, body_html, variables_json } = data;
    const result = await pool.query(
      `INSERT INTO email_templates (template_name, template_type, subject, body_html, variables_json)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [template_name, template_type, subject, body_html, variables_json]
    );
    return result.rows[0];
  },

  async findEmailTemplates(filters = {}) {
    let query = `SELECT * FROM email_templates WHERE is_active IS NOT FALSE`;
    const params = [];
    let n = 1;
    if (filters.template_type) { query += ` AND template_type = $${n++}`; params.push(filters.template_type); }
    if (filters.is_active !== undefined) { query += ` AND is_active = $${n++}`; params.push(filters.is_active); }
    query += ` ORDER BY template_name`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  async findEmailTemplateById(id) {
    const result = await pool.query(
      `SELECT * FROM email_templates WHERE id = $1`, [id]
    );
    return result.rows[0];
  },

  // Same key-interpolation mass-assignment/injection issue as updateRequisition
  // above — see that comment. `email_templates` has no `company_id` column
  // (confirmed: unscoped everywhere else in this file too), so no tenant
  // scoping to add here, unlike the other five update*() functions.
  async updateEmailTemplate(id, data) {
    const safe = await pickUpdatable('email_templates', data);
    const fields = [];
    const values = [];
    let paramCount = 1;
    Object.keys(safe).forEach(key => {
      fields.push(`${key} = $${paramCount}`);
      values.push(safe[key]);
      paramCount++;
    });
    if (!fields.length) return this.findEmailTemplateById(id);
    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    const result = await pool.query(
      `UPDATE email_templates SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0];
  },

  async deleteEmailTemplate(id) {
    await pool.query(`UPDATE email_templates SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
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
    const { candidate_id, job_opening_id, offered_salary, joining_date, notes, company_id } = data;
    const result = await pool.query(
      `INSERT INTO offer_letters
         (candidate_id, job_opening_id, offered_salary, joining_date, notes, company_id, offer_status)
       VALUES ($1,$2,$3,$4,$5,$6,'draft') RETURNING *`,
      [candidate_id, job_opening_id, offered_salary, joining_date, notes, company_id]
    );
    await this.moveCandidateStage(candidate_id, 'offer', null, 'Offer created');
    return result.rows[0];
  },

  async findOffers(filters = {}) {
    let query = `
      SELECT ol.*, c.full_name AS candidate_name, c.email AS candidate_email,
             COALESCE(jo.job_title, jr.job_title) AS job_title
      FROM offer_letters ol
      JOIN candidates c ON ol.candidate_id = c.id
      LEFT JOIN job_openings jo ON ol.job_opening_id = jo.id
      LEFT JOIN job_requisitions jr ON jo.requisition_id = jr.id
      WHERE ol.deleted_at IS NULL`;
    const params = [];
    let n = 1;
    if (filters.company_id)   { query += ` AND ol.company_id = $${n++}`;   params.push(filters.company_id); }
    if (filters.offer_status) { query += ` AND ol.offer_status = $${n++}`; params.push(filters.offer_status); }
    if (filters.candidate_id) { query += ` AND ol.candidate_id = $${n++}`; params.push(filters.candidate_id); }
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
    const safe = await pickUpdatable('offer_letters', data);
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
  async acceptOffer(offer_id, company_id = null) {
    const result = await pool.query(
      `UPDATE offer_letters
       SET offer_status = 'accepted', response_date = CURRENT_DATE, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)
       RETURNING *`,
      [offer_id, company_id]
    );
    const offer = result.rows[0];
    if (!offer) throw new Error('Offer not found');
    await pool.query(
      `UPDATE candidates SET overall_status = 'hired', current_stage = 'hired', hired_at = NOW()
       WHERE id = $1`,
      [offer.candidate_id]
    );
    await pool.query(
      `UPDATE job_openings SET positions_filled = COALESCE(positions_filled, 0) + 1 WHERE id = $1`,
      [offer.job_opening_id]
    );
    return offer;
  },

  // ==================== ANALYTICS & DASHBOARD ====================

  async getDashboard(company_id) {
    const safeQ = async (sql, params = []) => {
      try { return (await pool.query(sql, params)).rows[0] || {}; } catch { return {}; }
    };

    const [positions, active, interviews, offers, hired] = await Promise.all([
      safeQ(`SELECT COUNT(*) AS cnt FROM job_openings jo
             WHERE jo.status = 'open' AND jo.company_id = $1 AND jo.deleted_at IS NULL`, [company_id]),
      safeQ(`SELECT COUNT(*) AS cnt FROM candidates
             WHERE overall_status = 'active' AND company_id = $1 AND deleted_at IS NULL`, [company_id]),
      safeQ(`SELECT COUNT(*) AS cnt FROM interview_schedules
             WHERE interview_date = CURRENT_DATE AND status = 'scheduled'
               AND company_id = $1 AND deleted_at IS NULL`, [company_id]),
      safeQ(`SELECT COUNT(*) AS cnt FROM offer_letters
             WHERE offer_status = 'sent' AND company_id = $1 AND deleted_at IS NULL`, [company_id]),
      safeQ(`SELECT COUNT(*) AS cnt FROM candidates
             WHERE overall_status = 'hired'
               AND DATE_TRUNC('month', updated_at) = DATE_TRUNC('month', CURRENT_DATE)
               AND company_id = $1 AND deleted_at IS NULL`, [company_id]),
    ]);

    return {
      open_positions:    parseInt(positions.cnt)  || 0,
      active_candidates: parseInt(active.cnt)     || 0,
      interviews_today:  parseInt(interviews.cnt) || 0,
      pending_offers:    parseInt(offers.cnt)     || 0,
      hired_this_month:  parseInt(hired.cnt)      || 0,
    };
  },

  // Single source of truth for candidate-pipeline-by-stage counts, used by
  // /pipeline-summary (company-wide), /pipeline/:job_opening_id (scoped to one
  // opening — previously a separate getCandidatePipeline() with its own SQL
  // and a fixed-key-object shape instead of this array-of-{stage,count}
  // shape), and /talent/recruiter-dashboard (previously its own third copy).
  async getPipelineSummary(company_id, job_opening_id = null) {
    const STAGE_ORDER = {
      applied: 1, screening: 2, '1st_level': 3, '2nd_level': 4,
      offer: 5, hired: 6, not_suitable: 7, maybe: 8, future_use: 9, rejected: 10,
    };
    const STAGE_COLORS = {
      applied:    '#64748b',
      screening:  '#3b82f6',
      '1st_level':'#8b5cf6',
      '2nd_level':'#a855f7',
      offer:      '#f59e0b',
      hired:      '#22c55e',
      not_suitable:'#ef4444',
      maybe:      '#06b6d4',
      future_use: '#6366f1',
      rejected:   '#dc2626',
    };
    let query = `
      SELECT current_stage AS stage, COUNT(*) AS count
      FROM candidates
      WHERE current_stage IS NOT NULL AND deleted_at IS NULL`;
    const params = [];
    let n = 1;
    if (company_id)     { query += ` AND company_id = $${n++}`;     params.push(company_id); }
    if (job_opening_id) { query += ` AND applied_job_id = $${n++}`; params.push(job_opening_id); }
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

  async getSourceAnalytics(company_id) {
    let query = `SELECT source, COUNT(*) AS count FROM candidates WHERE deleted_at IS NULL`;
    const params = [];
    if (company_id) { query += ` AND company_id = $1`; params.push(company_id); }
    query += ` GROUP BY source ORDER BY count DESC`;
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
  async getTimeToHire(company_id) {
    let query = `
      SELECT
        ROUND(AVG(EXTRACT(DAY FROM (ol.offer_sent_date - c.created_at)))) AS avg_days,
        ROUND(MIN(EXTRACT(DAY FROM (ol.offer_sent_date - c.created_at)))) AS min_days,
        ROUND(MAX(EXTRACT(DAY FROM (ol.offer_sent_date - c.created_at)))) AS max_days,
        COUNT(*) AS matched
      FROM offer_letters ol
      LEFT JOIN candidates c ON c.id::text = ol.candidate_id::text
      WHERE ol.offer_status = 'accepted' AND ol.deleted_at IS NULL`;
    const params = [];
    if (company_id) { query += ` AND ol.company_id = $1`; params.push(company_id); }
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
  async getOfferAcceptanceRate(company_id) {
    let query = `
      SELECT
        COUNT(CASE WHEN offer_status IN ('sent','accepted','declined') THEN 1 END) AS offered,
        COUNT(CASE WHEN offer_status = 'accepted' THEN 1 END) AS accepted,
        COUNT(CASE WHEN offer_status = 'declined' THEN 1 END) AS declined
      FROM offer_letters WHERE deleted_at IS NULL`;
    const params = [];
    if (company_id) { query += ` AND company_id = $1`; params.push(company_id); }
    const result = await pool.query(query, params);
    const row = result.rows[0];
    const offered  = parseInt(row.offered)  || 0;
    const accepted = parseInt(row.accepted) || 0;
    const declined = parseInt(row.declined) || 0;
    const rate = offered > 0 ? (accepted / offered * 100).toFixed(2) : 0;
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
    const query = `
      SELECT COUNT(DISTINCT s.candidate_id) AS interviewed,
             (SELECT COUNT(*) FROM candidates WHERE ${candFilter}) AS hired
      FROM interview_schedules s WHERE ${schedFilter}`;
    const result = await pool.query(query, params);
    const row = result.rows[0];
    const ratio = row.interviewed > 0 ? (row.hired / row.interviewed * 100).toFixed(2) : 0;
    return { interviewed: parseInt(row.interviewed), hired: parseInt(row.hired), ratio: parseFloat(ratio) };
  },

  // ==================== HIRE CANDIDATE (full transaction) ====================
  // Single employee-creation path for /candidates/:id/hire (direct hire, no
  // options) and /auto-creation/:candidateId/trigger (passes employmentType/
  // offeredSalary/sourceCandidateId — that route previously reimplemented all
  // of this separately). `options` fields are all optional so the direct-hire
  // caller's behavior is unchanged.
  async hireCandidate(candidateId, companyId, dbClient, options = {}) {
    const client = dbClient || pool;
    const { employmentType = null, offeredSalary = null, sourceCandidateId = null } = options;

    // 1. Load candidate + job title — scoped to companyId so a candidate id
    // belonging to another company can't be hired into this one (it wasn't
    // scoped here before, despite companyId being passed in).
    const candResult = await client.query(
      `SELECT c.*, COALESCE(jo.job_title, jr.job_title) AS job_title,
              jo.id AS job_opening_id, jo.department
       FROM candidates c
       LEFT JOIN job_openings jo ON c.applied_job_id = jo.id
       LEFT JOIN job_requisitions jr ON jo.requisition_id = jr.id
       WHERE c.id = $1 AND ($2::int IS NULL OR c.company_id = $2)`,
      [candidateId, companyId]
    );
    const cand = candResult.rows[0];
    if (!cand) throw new Error('Candidate not found');

    // 2. Generate sequential Employee ID for this company
    const idResult = await client.query(
      `SELECT COALESCE(MAX(CAST(REGEXP_REPLACE(office_id,'[^0-9]','','g') AS INT)), 0) AS max_num
       FROM employees WHERE company_id = $1 AND office_id ~ '^EMP-[0-9]+'`,
      [companyId]
    );
    const nextNum = (idResult.rows[0].max_num || 0) + 1;
    const employeeId = `EMP-${String(nextNum).padStart(4, '0')}`;

    // 3. Split full_name
    const nameParts = (cand.full_name || '').trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName  = nameParts.slice(1).join(' ') || '';

    // 4. Create employee record (column names match actual employees table schema)
    const empResult = await client.query(
      `INSERT INTO employees
         (company_id, office_id, first_name, last_name, company_email, phone,
          department, designation, employment_type, status, joining_date,
          source_candidate_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Active', CURRENT_DATE, $10) RETURNING *`,
      [companyId, employeeId, firstName, lastName, cand.email, cand.phone,
       cand.department, cand.job_title, employmentType, sourceCandidateId]
    );
    const employee = empResult.rows[0];

    // 4b. Auto-enroll into payroll — same pattern as employee.service.js's
    // addEmployee (direct HR "Add Employee" flow already does this). This is
    // the recruitment→hire flow, the more common path new hires actually
    // come through; without this, payroll.service.js's LEFT JOIN LATERAL
    // returns NULL basic_salary/structure_id for every recruitment-sourced
    // hire until someone manually adds a salary assignment.
    let payrollEnrolled = false;
    try {
      const { rows: defStruct } = await client.query(
        `SELECT id FROM salary_structures WHERE is_default = true ORDER BY id LIMIT 1`
      );
      const effectiveFrom = employee.joining_date || new Date().toISOString().slice(0, 10);
      // offeredSalary (from the accepted offer letter, when the caller has
      // one — see auto-creation/:candidateId/trigger) seeds a real
      // basic_salary instead of the column default.
      const validSalary = Number.isFinite(offeredSalary) && offeredSalary > 0 ? offeredSalary : null;
      if (validSalary != null) {
        await client.query(
          `INSERT INTO employee_salary_assignments (employee_id, structure_id, effective_from, basic_salary)
           VALUES ($1, $2, $3, $4)`,
          [employee.id, defStruct[0]?.id ?? null, effectiveFrom, validSalary]
        );
      } else {
        await client.query(
          `INSERT INTO employee_salary_assignments (employee_id, structure_id, effective_from)
           VALUES ($1, $2, $3)`,
          [employee.id, defStruct[0]?.id ?? null, effectiveFrom]
        );
      }
      payrollEnrolled = true;
    } catch (e) {
      console.error('[hireCandidate] payroll auto-enrollment failed:', e.message);
    }

    // 4c. Provision a login — this is the more common real-world hire path
    // (per the comment above) but was the one employee-creation path that
    // never called anything equivalent to employee.service.js's own
    // createEmployeeLogin/INSERT INTO users. A recruitment-sourced hire had
    // an employee record but no way to actually sign in. Reuses the same
    // helper the direct "Add Employee" flow uses (email fallback,
    // existing-account skip, role sync, primary scope).
    let loginProvisioned = false;
    try {
      await createEmployeeLogin(client, employee);
      loginProvisioned = true;
    } catch (e) {
      console.error('[hireCandidate] login provisioning failed:', e.message);
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
      `INSERT INTO candidate_stage_history (candidate_id, stage, notes)
       VALUES ($1, 'hired', 'Converted to employee')`,
      [candidateId]
    );

    // 6. Mark job opening as filled
    await client.query(
      `UPDATE job_openings
       SET status = 'closed', positions_filled = COALESCE(positions_filled,0) + 1,
           updated_at = NOW()
       WHERE id = $1`,
      [cand.job_opening_id]
    );

    return { employee, employeeId, payrollEnrolled, loginProvisioned };
  },

  // ==================== REPORTS ====================
  async getReportsSummary({ company_id, from_date, to_date, department }) {
    const params = [];
    let n = 1;
    let cFilter = `c.deleted_at IS NULL`;
    let oFilter = `ol.deleted_at IS NULL`;
    if (company_id) { cFilter += ` AND c.company_id = $${n}`; oFilter += ` AND ol.company_id = $${n}`; params.push(company_id); n++; }
    if (from_date)  { cFilter += ` AND c.created_at >= $${n++}`; params.push(from_date); }
    if (to_date)    { cFilter += ` AND c.created_at <= $${n++}`; params.push(to_date); }
    if (department) { cFilter += ` AND jo.department = $${n++}`; params.push(department); }

    const result = await pool.query(`
      SELECT
        COUNT(DISTINCT c.id) AS total_candidates,
        COUNT(DISTINCT c.id) FILTER (WHERE c.overall_status = 'hired') AS total_hired,
        COUNT(DISTINCT c.id) FILTER (WHERE c.overall_status = 'rejected') AS total_rejected,
        COUNT(DISTINCT c.id) FILTER (WHERE c.overall_status = 'active') AS active_pipeline,
        AVG(EXTRACT(DAY FROM (ol.offer_sent_date - c.created_at)))
          FILTER (WHERE ol.offer_status = 'accepted') AS avg_time_to_hire,
        COUNT(DISTINCT c.id) FILTER (WHERE c.source = 'referral') AS referral_hires,
        COUNT(DISTINCT c.id) FILTER (WHERE c.source = 'linkedin') AS linkedin_hires,
        COUNT(DISTINCT c.id) FILTER (WHERE c.source = 'website') AS website_hires,
        COUNT(DISTINCT c.id) FILTER (WHERE c.source = 'job_portal') AS job_portal_hires
      FROM candidates c
      LEFT JOIN job_openings jo ON c.applied_job_id = jo.id
      LEFT JOIN offer_letters ol ON ol.candidate_id = c.id AND ${oFilter}
      WHERE ${cFilter}
    `, params);
    return result.rows[0];
  },

  async getVacancyAging({ company_id, from_date, to_date }) {
    const params = [];
    let n = 1;
    let filter = `jo.deleted_at IS NULL AND jo.status = 'open'`;
    if (company_id) { filter += ` AND jo.company_id = $${n++}`; params.push(company_id); }
    if (from_date)  { filter += ` AND jo.created_at >= $${n++}`; params.push(from_date); }
    if (to_date)    { filter += ` AND jo.created_at <= $${n++}`; params.push(to_date); }
    const result = await pool.query(`
      SELECT jo.id, jo.job_title, jo.department, jo.status,
             jo.created_at,
             EXTRACT(DAY FROM NOW() - jo.created_at) AS days_open,
             COALESCE(jo.positions_filled, 0) AS positions_filled,
             jr.number_of_positions,
             COUNT(c.id) AS applicant_count
      FROM job_openings jo
      LEFT JOIN job_requisitions jr ON jo.requisition_id = jr.id
      LEFT JOIN candidates c ON c.applied_job_id = jo.id AND c.deleted_at IS NULL
      WHERE ${filter}
      GROUP BY jo.id, jr.number_of_positions
      ORDER BY days_open DESC
    `, params);
    return result.rows;
  },

  async getSourceEffectiveness({ company_id, from_date, to_date }) {
    const params = [];
    let n = 1;
    let filter = `c.deleted_at IS NULL`;
    if (company_id) { filter += ` AND c.company_id = $${n++}`; params.push(company_id); }
    if (from_date)  { filter += ` AND c.created_at >= $${n++}`; params.push(from_date); }
    if (to_date)    { filter += ` AND c.created_at <= $${n++}`; params.push(to_date); }
    const result = await pool.query(`
      SELECT c.source,
             COUNT(*) AS total_applications,
             COUNT(*) FILTER (WHERE c.overall_status = 'hired') AS hires,
             COUNT(*) FILTER (WHERE c.overall_status = 'rejected') AS rejections,
             ROUND(
               100.0 * COUNT(*) FILTER (WHERE c.overall_status = 'hired') / NULLIF(COUNT(*), 0), 1
             ) AS hire_rate_pct
      FROM candidates c
      WHERE ${filter}
      GROUP BY c.source
      ORDER BY hires DESC
    `, params);
    return result.rows;
  },

  async getDepartmentPipeline({ company_id, from_date, to_date }) {
    const params = [];
    let n = 1;
    let filter = `c.deleted_at IS NULL`;
    if (company_id) { filter += ` AND c.company_id = $${n++}`; params.push(company_id); }
    if (from_date)  { filter += ` AND c.created_at >= $${n++}`; params.push(from_date); }
    if (to_date)    { filter += ` AND c.created_at <= $${n++}`; params.push(to_date); }
    const result = await pool.query(`
      SELECT COALESCE(jo.department, jr.department, 'Unassigned') AS department,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE c.current_stage = 'applied')    AS applied,
             COUNT(*) FILTER (WHERE c.current_stage = 'screening')  AS screening,
             COUNT(*) FILTER (WHERE c.current_stage = '1st_level')  AS first_level,
             COUNT(*) FILTER (WHERE c.current_stage = '2nd_level')  AS second_level,
             COUNT(*) FILTER (WHERE c.current_stage = 'offer')      AS offer,
             COUNT(*) FILTER (WHERE c.overall_status = 'hired')     AS hired
      FROM candidates c
      LEFT JOIN job_openings jo ON c.applied_job_id = jo.id
      LEFT JOIN job_requisitions jr ON jo.requisition_id = jr.id
      WHERE ${filter}
      GROUP BY 1
      ORDER BY total DESC
    `, params);
    return result.rows;
  },
};

export default recruitmentRepository;
