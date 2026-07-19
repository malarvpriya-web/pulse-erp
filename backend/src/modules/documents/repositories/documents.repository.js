import pool from '../../shared/db.js';
import { pickUpdatable } from '../../../shared/safeUpdate.js';

const documentsRepository = {
  async createTemplate(data) {
    const { template_name, document_type, template_html, variables_json, created_by } = data;
    const result = await pool.query(
      `INSERT INTO document_templates (template_name, document_type, template_html, variables_json, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [template_name, document_type, template_html, JSON.stringify(variables_json), created_by]
    );
    return result.rows[0];
  },

  async findTemplates(filters = {}) {
    let query = `SELECT * FROM document_templates WHERE deleted_at IS NULL`;
    const params = [];
    let paramCount = 1;

    if (filters.document_type) {
      query += ` AND document_type = $${paramCount}`;
      params.push(filters.document_type);
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
      values.push(key === 'variables_json' ? JSON.stringify(safe[key]) : safe[key]);
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
    const { template_id, document_type, reference_id, reference_type, document_data_json, file_path, generated_by } = data;
    const result = await pool.query(
      `INSERT INTO generated_documents (template_id, document_type, reference_id, reference_type, document_data_json, file_path, generated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [template_id, document_type, reference_id, reference_type, JSON.stringify(document_data_json), file_path, generated_by]
    );
    return result.rows[0];
  },

  async findGeneratedDocuments(filters = {}) {
    let query = `SELECT * FROM generated_documents WHERE deleted_at IS NULL`;
    const params = [];
    let paramCount = 1;

    if (filters.reference_id && filters.reference_type) {
      query += ` AND reference_id = $${paramCount} AND reference_type = $${paramCount + 1}`;
      params.push(filters.reference_id, filters.reference_type);
      paramCount += 2;
    }

    if (filters.document_type) {
      query += ` AND document_type = $${paramCount}`;
      params.push(filters.document_type);
      paramCount++;
    }

    query += ` ORDER BY created_at DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  }
};

export default documentsRepository;
