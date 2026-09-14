/**
 * documents.repository.js
 *
 * Column names here drifted from the schema: the repository wrote
 * name/content/variables/category on
 * `document_templates` and content/file_url/category on
 * `generated_documents`. None of those columns exist, so every template create
 * and every document generation threw 42703. Mapped to the real names below;
 * only reference_id/reference_type were genuinely missing and are added by
 * migration 20260819000009.
 */
import pool from '../../shared/db.js';
import { pickUpdatable } from '../../../shared/safeUpdate.js';

const documentsRepository = {
  async createTemplate(data) {
    const { name, category, content, variables, created_by } = data;
    const result = await pool.query(
      `INSERT INTO document_templates (name, category, content, variables, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, category, content, JSON.stringify(variables), created_by]
    );
    return result.rows[0];
  },

  async findTemplates(filters = {}) {
    let query = `SELECT * FROM document_templates WHERE deleted_at IS NULL`;
    const params = [];
    let paramCount = 1;

    if (filters.category) {
      query += ` AND category = $${paramCount}`;
      params.push(filters.category);
      paramCount++;
    }

    if (filters.is_active !== undefined) {
      query += ` AND is_active = $${paramCount}`;
      params.push(filters.is_active);
      paramCount++;
    }

    query += ` ORDER BY created_at DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async findTemplateById(id) {
    const result = await pool.query(
      `SELECT * FROM document_templates WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    return result.rows[0];
  },

  async updateTemplate(id, data) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    // The route calls updateTemplate(req.params.id, req.body), and `key` is
    // interpolated into the SET clause below rather than bound — so unfiltered it
    // allows both mass assignment (company_id, created_by, deleted_at) and
    // injection of extra assignments. pickUpdatable validates every key against
    // the live `document_templates` columns minus the protected set.
    const safe = await pickUpdatable('document_templates', data);

    Object.keys(safe).forEach(key => {
      fields.push(`${key} = $${paramCount}`);
      values.push(key === 'variables' ? JSON.stringify(safe[key]) : safe[key]);
      paramCount++;
    });

    // Every key was rejected — don't emit `SET updated_at=…` alone, which would
    // report success for a write that changed nothing.
    if (!fields.length) return this.findTemplateById(id);

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await pool.query(
      `UPDATE document_templates SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0];
  },

  async deleteTemplate(id) {
    await pool.query(`UPDATE document_templates SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
  },

  async saveGeneratedDocument(data) {
    const { template_id, category, reference_id, reference_type, content, file_url, generated_by } = data;
    const result = await pool.query(
      `INSERT INTO generated_documents (template_id, category, reference_id, reference_type, content, file_url, generated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [template_id, category, reference_id, reference_type, JSON.stringify(content), file_url, generated_by]
    );
    return result.rows[0];
  },

  /**
   * @param {object} filters
   *   company_id  — tenant scope. The query had NO company predicate at all, so
   *                 every tenant's generated documents were returned to anyone.
   *   self_only   — narrow to documents ABOUT the caller (employee_id) or made
   *                 BY them (generated_by). Set by the route for callers who are
   *                 not document approvers; `documents`.`view` is granted to 24
   *                 of 26 roles, so the permission gate cannot do this.
   *
   * ⚠ These keys used to be accepted and silently dropped — the route could pass
   * a scope and the repository would ignore it, which is worse than no scope at
   * all because the call site looks correct.
   */
  async findGeneratedDocuments(filters = {}) {
    let query = `SELECT * FROM generated_documents WHERE deleted_at IS NULL`;
    const params = [];
    let paramCount = 1;

    if (filters.company_id != null) {
      query += ` AND company_id = $${paramCount}`;
      params.push(filters.company_id);
      paramCount++;
    }

    if (filters.self_only) {
      // OR, not AND: a document is the caller's business if it is about them or
      // if they produced it.
      const clauses = [];
      if (filters.employee_id != null) {
        clauses.push(`employee_id = $${paramCount}`);
        params.push(filters.employee_id);
        paramCount++;
      }
      if (filters.generated_by != null) {
        clauses.push(`generated_by = $${paramCount}`);
        params.push(filters.generated_by);
        paramCount++;
      }
      // No identity resolved means nothing of the caller's own to show. FALSE
      // rather than an open query — the fail-open here is the whole defect.
      query += ` AND (${clauses.length ? clauses.join(' OR ') : 'FALSE'})`;
    }

    if (filters.reference_id && filters.reference_type) {
      query += ` AND reference_id = $${paramCount} AND reference_type = $${paramCount + 1}`;
      params.push(filters.reference_id, filters.reference_type);
      paramCount += 2;
    }

    if (filters.category) {
      query += ` AND category = $${paramCount}`;
      params.push(filters.category);
      paramCount++;
    }

    query += ` ORDER BY created_at DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  }
};

export default documentsRepository;
