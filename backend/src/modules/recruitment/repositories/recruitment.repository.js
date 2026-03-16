import pool from '../../shared/db.js';

const recruitmentRepository = {
  // ==================== JOB REQUISITIONS ====================
  async createRequisition(data) {
    const { job_title, department_id, employment_type, number_of_positions, job_description, skills_required, experience_required, location, salary_range, requested_by_employee_id } = data;
    const result = await pool.query(
      `INSERT INTO job_requisitions (job_title, department, employment_type, number_of_positions, job_description, skills_required, experience_required, location, salary_range, requested_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft') RETURNING *`,
      [job_title, department_id, employment_type, number_of_positions, job_description, skills_required, experience_required, location, salary_range, requested_by_employee_id]
    );
    return result.rows[0];
  },

  async findRequisitions(filters = {}) {
    let query = `SELECT jr.*, e.name as requested_by_name FROM job_requisitions jr
                 LEFT JOIN employees e ON jr.requested_by = e.id
                 WHERE jr.deleted_at IS NULL`;
    const params = [];
    let paramCount = 1;

    if (filters.status) {
      query += ` AND jr.status = $${paramCount}`;
      params.push(filters.status);
      paramCount++;
    }
    if (filters.department) {
      query += ` AND jr.department = $${paramCount}`;
      params.push(filters.department);
      paramCount++;
    }

    query += ` ORDER BY jr.created_at DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  async findRequisitionById(id) {
    const result = await pool.query(
      `SELECT jr.*, e.name as requested_by_name FROM job_requisitions jr
       LEFT JOIN employees e ON jr.requested_by = e.id
       WHERE jr.id = $1 AND jr.deleted_at IS NULL`,
      [id]
    );
    return result.rows[0];
  },

  async updateRequisition(id, data) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    Object.keys(data).forEach(key => {
      if (data[key] !== undefined) {
        fields.push(`${key} = $${paramCount}`);
        values.push(data[key]);
        paramCount++;
      }
    });

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await pool.query(
      `UPDATE job_requisitions SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0];
  },

  async deleteRequisition(id) {
    await pool.query(`UPDATE job_requisitions SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
  },

  // ==================== JOB OPENINGS ====================
  async createOpening(data) {
    const { requisition_id, opening_date, closing_date } = data;
    const result = await pool.query(
      `INSERT INTO job_openings (requisition_id, opening_date, closing_date, status)
       VALUES ($1, $2, $3, 'open') RETURNING *`,
      [requisition_id, opening_date, closing_date]
    );
    
    await pool.query(`UPDATE job_requisitions SET status = 'open' WHERE id = $1`, [requisition_id]);
    
    return result.rows[0];
  },

  async findOpenings(filters = {}) {
    let query = `
      SELECT jo.*, jr.job_title, jr.department, jr.number_of_positions, jr.employment_type, jr.location, jr.salary_range
      FROM job_openings jo
      JOIN job_requisitions jr ON jo.requisition_id = jr.id
      WHERE jo.deleted_at IS NULL
    `;
    const params = [];
    let paramCount = 1;

    if (filters.status) {
      query += ` AND jo.status = $${paramCount}`;
      params.push(filters.status);
      paramCount++;
    }

    query += ` ORDER BY jo.created_at DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  async findOpeningById(id) {
    const result = await pool.query(
      `SELECT jo.*, jr.job_title, jr.department, jr.number_of_positions, jr.employment_type, jr.location, jr.salary_range, jr.job_description, jr.skills_required, jr.experience_required
       FROM job_openings jo
       JOIN job_requisitions jr ON jo.requisition_id = jr.id
       WHERE jo.id = $1 AND jo.deleted_at IS NULL`,
      [id]
    );
    return result.rows[0];
  },

  async updateOpening(id, data) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    Object.keys(data).forEach(key => {
      if (data[key] !== undefined) {
        fields.push(`${key} = $${paramCount}`);
        values.push(data[key]);
        paramCount++;
      }
    });

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await pool.query(
      `UPDATE job_openings SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0];
  },

  // ==================== CANDIDATES ====================
  async createCandidate(data) {
    const { full_name, email, phone, resume_file_url, source, applied_job_id } = data;
    const result = await pool.query(
      `INSERT INTO candidates (full_name, email, phone, resume_file_url, source, applied_job_id, current_stage, overall_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'applied', 'active') RETURNING *`,
      [full_name, email, phone, resume_file_url, source, applied_job_id]
    );
    
    await pool.query(
      `INSERT INTO candidate_stage_history (candidate_id, stage, notes)
       VALUES ($1, 'applied', 'Application received')`,
      [result.rows[0].id]
    );
    
    return result.rows[0];
  },

  async bulkCreateCandidates(candidates) {
    const results = [];
    for (const candidate of candidates) {
      const result = await this.createCandidate(candidate);
      results.push(result);
    }
    return results;
  },

  async findCandidates(filters = {}) {
    let query = `
      SELECT c.*, jo.id as job_opening_id, jr.job_title
      FROM candidates c
      LEFT JOIN job_openings jo ON c.applied_job_id = jo.id
      LEFT JOIN job_requisitions jr ON jo.requisition_id = jr.id
      WHERE c.deleted_at IS NULL
    `;
    const params = [];
    let paramCount = 1;

    if (filters.applied_job_id) {
      query += ` AND c.applied_job_id = $${paramCount}`;
      params.push(filters.applied_job_id);
      paramCount++;
    }
    if (filters.current_stage) {
      query += ` AND c.current_stage = $${paramCount}`;
      params.push(filters.current_stage);
      paramCount++;
    }
    if (filters.overall_status) {
      query += ` AND c.overall_status = $${paramCount}`;
      params.push(filters.overall_status);
      paramCount++;
    }
    if (filters.search) {
      query += ` AND (c.full_name ILIKE $${paramCount} OR c.email ILIKE $${paramCount})`;
      params.push(`%${filters.search}%`);
      paramCount++;
    }

    query += ` ORDER BY c.created_at DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  async findCandidateById(id) {
    const result = await pool.query(
      `SELECT c.*, jo.id as job_opening_id, jr.job_title
       FROM candidates c
       LEFT JOIN job_openings jo ON c.applied_job_id = jo.id
       LEFT JOIN job_requisitions jr ON jo.requisition_id = jr.id
       WHERE c.id = $1 AND c.deleted_at IS NULL`,
      [id]
    );
    return result.rows[0];
  },

  async updateCandidate(id, data) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    Object.keys(data).forEach(key => {
      if (data[key] !== undefined) {
        fields.push(`${key} = $${paramCount}`);
        values.push(data[key]);
        paramCount++;
      }
    });

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await pool.query(
      `UPDATE candidates SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0];
  },

  async moveCandidateStage(candidate_id, new_stage, moved_by, notes) {
    await pool.query(
      `UPDATE candidates SET current_stage = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [new_stage, candidate_id]
    );

    await pool.query(
      `INSERT INTO candidate_stage_history (candidate_id, stage, moved_by, notes)
       VALUES ($1, $2, $3, $4)`,
      [candidate_id, new_stage, moved_by, notes]
    );

    if (new_stage === 'rejected') {
      await pool.query(`UPDATE candidates SET overall_status = 'rejected' WHERE id = $1`, [candidate_id]);
    } else if (new_stage === 'hired') {
      await pool.query(`UPDATE candidates SET overall_status = 'hired' WHERE id = $1`, [candidate_id]);
    }
  },

  async getCandidateStageHistory(candidate_id) {
    const result = await pool.query(
      `SELECT csh.*, e.name as moved_by_name
       FROM candidate_stage_history csh
       LEFT JOIN employees e ON csh.moved_by = e.id
       WHERE csh.candidate_id = $1
       ORDER BY csh.moved_date DESC`,
      [candidate_id]
    );
    return result.rows;
  },

  async getCandidatePipeline(job_opening_id) {
    const result = await pool.query(`
      SELECT c.current_stage, COUNT(*) as count
      FROM candidates c
      WHERE c.applied_job_id = $1 AND c.deleted_at IS NULL AND c.overall_status = 'active'
      GROUP BY c.current_stage
    `, [job_opening_id]);
    
    const pipeline = {
      applied: 0, screening: 0, hr_round: 0, technical_round: 0, final_round: 0, offer: 0, hired: 0, rejected: 0
    };
    
    result.rows.forEach(row => {
      pipeline[row.current_stage] = parseInt(row.count);
    });
    
    return pipeline;
  },

  async getCandidatesByStage(job_opening_id, stage) {
    const result = await pool.query(
      `SELECT c.* FROM candidates c
       WHERE c.applied_job_id = $1 AND c.current_stage = $2 AND c.deleted_at IS NULL
       ORDER BY c.created_at DESC`,
      [job_opening_id, stage]
    );
    return result.rows;
  },

  // ==================== INTERVIEW NOTES ====================
  async createInterviewNote(data) {
    const { candidate_id, interviewer_id, interview_round, rating, comments, recommendation } = data;
    const result = await pool.query(
      `INSERT INTO interview_notes (candidate_id, interviewer_id, interview_round, rating, comments, recommendation)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [candidate_id, interviewer_id, interview_round, rating, comments, recommendation]
    );
    return result.rows[0];
  },

  async findInterviewNotes(candidate_id) {
    const result = await pool.query(
      `SELECT in_notes.*, e.name as interviewer_name
       FROM interview_notes in_notes
       LEFT JOIN employees e ON in_notes.interviewer_id = e.id
       WHERE in_notes.candidate_id = $1 AND in_notes.deleted_at IS NULL
       ORDER BY in_notes.created_at DESC`,
      [candidate_id]
    );
    return result.rows;
  },

  // ==================== INTERVIEW SCHEDULING ====================
  async scheduleInterview(data) {
    const { candidate_id, interview_date, interview_time, interview_mode, meeting_link, interviewer_id, notes } = data;
    const result = await pool.query(
      `INSERT INTO interview_schedules (candidate_id, interview_date, interview_time, interview_mode, meeting_link, interviewer_id, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled') RETURNING *`,
      [candidate_id, interview_date, interview_time, interview_mode, meeting_link, interviewer_id, notes]
    );
    return result.rows[0];
  },

  async findInterviews(filters = {}) {
    let query = `
      SELECT is_sched.*, c.full_name as candidate_name, c.email as candidate_email, e.name as interviewer_name, e.email as interviewer_email
      FROM interview_schedules is_sched
      JOIN candidates c ON is_sched.candidate_id = c.id
      LEFT JOIN employees e ON is_sched.interviewer_id = e.id
      WHERE is_sched.deleted_at IS NULL
    `;
    const params = [];
    let paramCount = 1;

    if (filters.interviewer_id) {
      query += ` AND is_sched.interviewer_id = $${paramCount}`;
      params.push(filters.interviewer_id);
      paramCount++;
    }
    if (filters.candidate_id) {
      query += ` AND is_sched.candidate_id = $${paramCount}`;
      params.push(filters.candidate_id);
      paramCount++;
    }
    if (filters.interview_date) {
      query += ` AND is_sched.interview_date = $${paramCount}`;
      params.push(filters.interview_date);
      paramCount++;
    }
    if (filters.status) {
      query += ` AND is_sched.status = $${paramCount}`;
      params.push(filters.status);
      paramCount++;
    }

    query += ` ORDER BY is_sched.interview_date, is_sched.interview_time`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  async updateInterview(id, data) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    Object.keys(data).forEach(key => {
      if (data[key] !== undefined) {
        fields.push(`${key} = $${paramCount}`);
        values.push(data[key]);
        paramCount++;
      }
    });

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await pool.query(
      `UPDATE interview_schedules SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0];
  },

  // ==================== EMAIL TEMPLATES ====================
  async createEmailTemplate(data) {
    const { template_name, template_type, subject, body_html, variables_json } = data;
    const result = await pool.query(
      `INSERT INTO email_templates (template_name, template_type, subject, body_html, variables_json)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [template_name, template_type, subject, body_html, variables_json]
    );
    return result.rows[0];
  },

  async findEmailTemplates(filters = {}) {
    let query = `SELECT * FROM email_templates WHERE deleted_at IS NULL`;
    const params = [];
    let paramCount = 1;

    if (filters.template_type) {
      query += ` AND template_type = $${paramCount}`;
      params.push(filters.template_type);
      paramCount++;
    }
    if (filters.is_active !== undefined) {
      query += ` AND is_active = $${paramCount}`;
      params.push(filters.is_active);
      paramCount++;
    }

    query += ` ORDER BY template_name`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  async findEmailTemplateById(id) {
    const result = await pool.query(`SELECT * FROM email_templates WHERE id = $1 AND deleted_at IS NULL`, [id]);
    return result.rows[0];
  },

  async updateEmailTemplate(id, data) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    Object.keys(data).forEach(key => {
      if (data[key] !== undefined) {
        fields.push(`${key} = $${paramCount}`);
        values.push(data[key]);
        paramCount++;
      }
    });

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
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [candidate_id, template_id, sent_to, subject, body_html, status || 'sent']
    );
  },

  // ==================== OFFER MANAGEMENT ====================
  async createOffer(data) {
    const { candidate_id, job_opening_id, offered_salary, joining_date, notes } = data;
    const result = await pool.query(
      `INSERT INTO offer_letters (candidate_id, job_opening_id, offered_salary, joining_date, notes, offer_status)
       VALUES ($1, $2, $3, $4, $5, 'draft') RETURNING *`,
      [candidate_id, job_opening_id, offered_salary, joining_date, notes]
    );
    
    await this.moveCandidateStage(candidate_id, 'offer', null, 'Offer created');
    
    return result.rows[0];
  },

  async findOffers(filters = {}) {
    let query = `
      SELECT ol.*, c.full_name as candidate_name, c.email as candidate_email, jr.job_title
      FROM offer_letters ol
      JOIN candidates c ON ol.candidate_id = c.id
      JOIN job_openings jo ON ol.job_opening_id = jo.id
      JOIN job_requisitions jr ON jo.requisition_id = jr.id
      WHERE ol.deleted_at IS NULL
    `;
    const params = [];
    let paramCount = 1;

    if (filters.offer_status) {
      query += ` AND ol.offer_status = $${paramCount}`;
      params.push(filters.offer_status);
      paramCount++;
    }
    if (filters.candidate_id) {
      query += ` AND ol.candidate_id = $${paramCount}`;
      params.push(filters.candidate_id);
      paramCount++;
    }

    query += ` ORDER BY ol.created_at DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  async findOfferById(id) {
    const result = await pool.query(
      `SELECT ol.*, c.full_name as candidate_name, c.email as candidate_email, jr.job_title
       FROM offer_letters ol
       JOIN candidates c ON ol.candidate_id = c.id
       JOIN job_openings jo ON ol.job_opening_id = jo.id
       JOIN job_requisitions jr ON jo.requisition_id = jr.id
       WHERE ol.id = $1 AND ol.deleted_at IS NULL`,
      [id]
    );
    return result.rows[0];
  },

  async updateOffer(id, data) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    Object.keys(data).forEach(key => {
      if (data[key] !== undefined) {
        fields.push(`${key} = $${paramCount}`);
        values.push(data[key]);
        paramCount++;
      }
    });

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await pool.query(
      `UPDATE offer_letters SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0];
  },

  async acceptOffer(offer_id) {
    const result = await pool.query(
      `UPDATE offer_letters SET offer_status = 'accepted', response_date = CURRENT_DATE, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [offer_id]
    );

    const offer = result.rows[0];
    
    await pool.query(`UPDATE candidates SET overall_status = 'hired', current_stage = 'hired' WHERE id = $1`, [offer.candidate_id]);
    await pool.query(`UPDATE job_openings SET positions_filled = positions_filled + 1 WHERE id = $1`, [offer.job_opening_id]);

    return offer;
  },

  // ==================== ANALYTICS & DASHBOARD ====================
  async getDashboard() {
    const openPositions = await pool.query(`SELECT COUNT(*) as count FROM job_openings WHERE status = 'open' AND deleted_at IS NULL`);
    const activeCandidates = await pool.query(`SELECT COUNT(*) as count FROM candidates WHERE overall_status = 'active' AND deleted_at IS NULL`);
    const totalCandidates = await pool.query(`SELECT COUNT(*) as count FROM candidates WHERE deleted_at IS NULL`);
    const offersAccepted = await pool.query(`SELECT COUNT(*) as count FROM offer_letters WHERE offer_status = 'accepted' AND deleted_at IS NULL`);
    const offersPending = await pool.query(`SELECT COUNT(*) as count FROM offer_letters WHERE offer_status = 'sent' AND deleted_at IS NULL`);
    const interviewsScheduled = await pool.query(`SELECT COUNT(*) as count FROM interview_schedules WHERE status = 'scheduled' AND deleted_at IS NULL`);

    return {
      open_positions: parseInt(openPositions.rows[0].count),
      active_candidates: parseInt(activeCandidates.rows[0].count),
      total_candidates: parseInt(totalCandidates.rows[0].count),
      offers_accepted: parseInt(offersAccepted.rows[0].count),
      offers_pending: parseInt(offersPending.rows[0].count),
      interviews_scheduled: parseInt(interviewsScheduled.rows[0].count)
    };
  },

  async getSourceAnalytics() {
    const result = await pool.query(`
      SELECT source, COUNT(*) as count
      FROM candidates
      WHERE deleted_at IS NULL
      GROUP BY source
      ORDER BY count DESC
    `);
    return result.rows;
  },

  async getTimeToHire() {
    const result = await pool.query(`
      SELECT 
        AVG(EXTRACT(DAY FROM (ol.offer_sent_date - c.created_at))) as avg_days
      FROM offer_letters ol
      JOIN candidates c ON ol.candidate_id = c.id
      WHERE ol.offer_status = 'accepted' AND ol.deleted_at IS NULL
    `);
    return result.rows[0];
  },

  async getOfferAcceptanceRate() {
    const result = await pool.query(`
      SELECT 
        COUNT(CASE WHEN offer_status = 'accepted' THEN 1 END) as accepted,
        COUNT(CASE WHEN offer_status IN ('sent', 'accepted', 'declined') THEN 1 END) as total
      FROM offer_letters
      WHERE deleted_at IS NULL
    `);
    const row = result.rows[0];
    const rate = row.total > 0 ? (row.accepted / row.total * 100).toFixed(2) : 0;
    return { accepted: parseInt(row.accepted), total: parseInt(row.total), rate: parseFloat(rate) };
  },

  async getInterviewToHireRatio() {
    const result = await pool.query(`
      SELECT 
        COUNT(DISTINCT is_sched.candidate_id) as interviewed,
        (SELECT COUNT(*) FROM candidates WHERE overall_status = 'hired' AND deleted_at IS NULL) as hired
      FROM interview_schedules is_sched
      WHERE is_sched.deleted_at IS NULL
    `);
    const row = result.rows[0];
    const ratio = row.interviewed > 0 ? (row.hired / row.interviewed * 100).toFixed(2) : 0;
    return { interviewed: parseInt(row.interviewed), hired: parseInt(row.hired), ratio: parseFloat(ratio) };
  }
};

export default recruitmentRepository;
