import pool from '../../shared/db.js';
import { nextQuotationNumber } from '../../../shared/docNumber.js';

const QUOTATION_COLUMNS = new Set([
  'company_id', 'customer_id', 'customer_name', 'opportunity_id',
  'quotation_date', 'validity_date', 'status', 'notes',
  'subtotal', 'tax_amount', 'total_amount',
]);

const quotationsRepository = {
  async create(data) {
    const {
      quotation_number, company_id = null, customer_id = null, customer_name = null,
      opportunity_id = null, quotation_date, validity_date,
      status = 'draft', notes = null, created_by,
      version = 1, parent_id = null, original_id = null,
      subtotal = 0, tax_amount = 0, total_amount = 0,
    } = data;
    const result = await pool.query(
      `INSERT INTO quotations
         (quotation_number, company_id, customer_id, customer_name, opportunity_id,
          quotation_date, validity_date, status, notes, created_by,
          version, parent_id, original_id, subtotal, tax_amount, total_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [quotation_number, company_id, customer_id, customer_name, opportunity_id,
       quotation_date, validity_date, status, notes, created_by,
       version, parent_id, original_id, subtotal, tax_amount, total_amount]
    );
    return result.rows[0];
  },

  async findAll(filters = {}) {
    // Show latest revision per quotation family (grouped by original_id or id for v1).
    // Each row includes total_revisions count so the UI can show a badge.
    let query = `
      WITH family AS (
        SELECT
          COALESCE(original_id, id)         AS family_id,
          MAX(COALESCE(version, 1))         AS max_ver,
          COUNT(*)::int                     AS total_revisions
        FROM quotations WHERE deleted_at IS NULL
        GROUP BY COALESCE(original_id, id)
      )
      SELECT q.*,
             COALESCE(p.name, q.customer_name) AS customer_name,
             f.total_revisions,
             COALESCE(q.version, 1)             AS version
      FROM quotations q
      JOIN family f
        ON  COALESCE(q.original_id, q.id) = f.family_id
        AND COALESCE(q.version, 1)        = f.max_ver
      LEFT JOIN parties p ON q.customer_id = p.id
      WHERE q.deleted_at IS NULL
    `;
    const params = [];
    let n = 1;
    if (filters.company_id)  { query += ` AND q.company_id = $${n++}`;  params.push(filters.company_id); }
    if (filters.status && filters.status !== 'all') {
      query += ` AND q.status = $${n++}`;
      params.push(filters.status);
    }
    if (filters.search) {
      query += ` AND (q.quotation_number ILIKE $${n} OR COALESCE(p.name, q.customer_name) ILIKE $${n})`;
      params.push(`%${filters.search}%`);
      n++;
    }
    if (filters.customer_id) { query += ` AND q.customer_id = $${n++}`; params.push(filters.customer_id); }
    query += ` ORDER BY q.created_at DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  },

  async findById(id, company_id = null) {
    const result = await pool.query(
      `SELECT q.*, p.name AS customer_name, COALESCE(q.version, 1) AS version
       FROM quotations q
       LEFT JOIN parties p ON q.customer_id = p.id
       WHERE q.id = $1 AND q.deleted_at IS NULL
         AND ($2::int IS NULL OR q.company_id = $2)`,
      [id, company_id ?? null]
    );
    return result.rows[0];
  },

  // All revisions in the same family, oldest-first.
  async getRevisions(quotationId) {
    const result = await pool.query(`
      SELECT q.*, p.name AS customer_name, COALESCE(q.version, 1) AS version
      FROM quotations q
      LEFT JOIN parties p ON q.customer_id = p.id
      WHERE COALESCE(q.original_id, q.id) = (
        SELECT COALESCE(original_id, id) FROM quotations WHERE id = $1
      )
      AND q.deleted_at IS NULL
      ORDER BY COALESCE(q.version, 1) ASC
    `, [quotationId]);
    return result.rows;
  },

  // Create a new revision: copy header + items from current, bump version.
  async createRevision(id, userId) {
    const current = await this.findById(id);
    if (!current) throw new Error('Quotation not found');

    const familyId    = current.original_id || current.id;
    const newVersion  = (current.version || 1) + 1;
    const baseNum     = (current.quotation_number || '').replace(/-v\d+$/, '');
    const newNumber   = `${baseNum}-v${newVersion}`;

    const result = await pool.query(`
      INSERT INTO quotations
        (quotation_number, customer_id, quotation_date, validity_date,
         status, notes, version, parent_id, original_id, created_by,
         subtotal, tax_amount, total_amount)
      VALUES ($1,$2,CURRENT_DATE,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [
      newNumber, current.customer_id, current.validity_date,
      current.notes, newVersion, current.id, familyId, userId,
      current.subtotal || 0, current.tax_amount || 0, current.total_amount || 0,
    ]);
    const newQ = result.rows[0];

    // Copy items from current version to the new revision
    const items = await pool.query(
      `SELECT * FROM quotation_items WHERE quotation_id = $1 ORDER BY id`,
      [id]
    );
    for (const item of items.rows) {
      await pool.query(`
        INSERT INTO quotation_items
          (quotation_id, item_description, quantity, rate, tax_percentage, tax_amount, total)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [newQ.id, item.item_description, item.quantity, item.rate,
          item.tax_percentage, item.tax_amount, item.total]);
    }

    // Mark the superseded version as 'revised' (only if still in a mutable state)
    await pool.query(
      `UPDATE quotations SET status = 'revised', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status IN ('draft','sent','rejected')`,
      [id]
    );

    return this.findById(newQ.id);
  },

  async update(id, data) {
    const fields = [];
    const values = [];
    let n = 1;
    Object.keys(data).forEach(key => {
      if (QUOTATION_COLUMNS.has(key) && data[key] !== undefined) {
        fields.push(`${key} = $${n++}`);
        values.push(data[key]);
      }
    });
    if (fields.length === 0) {
      const result = await pool.query('SELECT * FROM quotations WHERE id = $1 AND deleted_at IS NULL', [id]);
      return result.rows[0];
    }
    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    const result = await pool.query(
      `UPDATE quotations SET ${fields.join(', ')} WHERE id = $${n} AND deleted_at IS NULL RETURNING *`,
      values
    );
    return result.rows[0];
  },

  async delete(id) {
    await pool.query(`UPDATE quotations SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
  },

  async getNextQuotationNumber(client) {
    return nextQuotationNumber(client);
  },

  async addItem(data) {
    const { quotation_id, item_description, quantity, rate, tax_percentage } = data;
    const tax_amount = (quantity * rate * tax_percentage) / 100;
    const total      = quantity * rate + tax_amount;
    const result = await pool.query(
      `INSERT INTO quotation_items
         (quotation_id, item_description, quantity, rate, tax_percentage, tax_amount, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [quotation_id, item_description, quantity, rate, tax_percentage, tax_amount, total]
    );
    await this.updateTotals(quotation_id);
    return result.rows[0];
  },

  async getItems(quotation_id) {
    const result = await pool.query(
      `SELECT * FROM quotation_items WHERE quotation_id = $1 ORDER BY id`,
      [quotation_id]
    );
    return result.rows;
  },

  async updateTotals(quotation_id) {
    const result = await pool.query(`
      SELECT
        COALESCE(SUM(total - tax_amount), 0) AS subtotal,
        COALESCE(SUM(tax_amount),         0) AS tax_amount,
        COALESCE(SUM(total),              0) AS total_amount
      FROM quotation_items WHERE quotation_id = $1
    `, [quotation_id]);
    const { subtotal, tax_amount, total_amount } = result.rows[0];
    await pool.query(
      `UPDATE quotations SET subtotal=$1, tax_amount=$2, total_amount=$3 WHERE id=$4`,
      [subtotal, tax_amount, total_amount, quotation_id]
    );
  },
};

export default quotationsRepository;
