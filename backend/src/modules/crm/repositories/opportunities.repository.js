import pool from '../../shared/db.js';

// Whitelist of columns that can be written to the opportunities table.
// Prevents joined columns (company_name, contact_person, assigned_to_name, etc.) reaching UPDATE.
const OPP_COLUMNS = new Set([
  'lead_id', 'opportunity_name', 'expected_value', 'probability_percentage',
  'expected_closing_date', 'stage', 'assigned_to', 'notes',
  'estimate_value', 'held_by', 'follow_up_date',
]);

// Columns the Pursuits grid may sort on. Whitelisted so the client-supplied
// sort key can never reach the query as free text.
const SORTABLE = {
  id:              'o.id',
  opportunity_name:'o.opportunity_name',
  company_name:    'l.company_name',
  expected_value:  'o.expected_value',
  probability_percentage: 'o.probability_percentage',
  estimate_value:  'o.estimate_value',
  stage:           'o.stage',
  follow_up_date:  'o.follow_up_date',
  expected_closing_date: 'o.expected_closing_date',
};

const opportunitiesRepository = {
  async create(data) {
    const {
      lead_id, opportunity_name, expected_value, probability_percentage,
      expected_closing_date, stage, assigned_to, created_by, company_id,
      estimate_value, held_by, follow_up_date,
    } = data;
    // Numeric/date/FK columns reject '' — normalise blanks from the form to NULL.
    const nn = v => (v === '' || v === undefined ? null : v);
    const result = await pool.query(
      `INSERT INTO opportunities
         (lead_id, opportunity_name, expected_value, probability_percentage,
          expected_closing_date, stage, assigned_to, created_by, company_id,
          estimate_value, held_by, follow_up_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        nn(lead_id), opportunity_name, nn(expected_value), nn(probability_percentage),
        nn(expected_closing_date), stage, nn(assigned_to), created_by, nn(company_id),
        nn(estimate_value), nn(held_by), nn(follow_up_date),
      ]
    );
    return result.rows[0];
  },

  async findAll(filters = {}) {
    const cid = filters.company_id != null ? filters.company_id : null;
    let query = `
      SELECT o.*,
        l.company_name,
        l.contact_person,
        l.zone,
        e.name  as assigned_to_name,
        h.name  as held_by_name,
        CASE WHEN o.expected_closing_date < CURRENT_DATE
             AND LOWER(o.stage) NOT IN ('won','lost')
             THEN true ELSE false END AS is_overdue
      FROM opportunities o
      LEFT JOIN leads l ON o.lead_id = l.id
      LEFT JOIN employees e ON e.id = o.assigned_to
        AND e.status IN ('active','probation')
      LEFT JOIN employees h ON h.id = o.held_by
      WHERE o.deleted_at IS NULL
    `;
    const params = [];
    let paramCount = 1;

    if (cid != null) {
      query += ` AND o.company_id = $${paramCount}`;
      params.push(cid);
      paramCount++;
    }

    if (filters.stage) {
      query += ` AND o.stage = $${paramCount}`;
      params.push(filters.stage);
      paramCount++;
    }

    if (filters.assigned_to) {
      query += ` AND o.assigned_to = $${paramCount}`;
      params.push(filters.assigned_to);
      paramCount++;
    }

    // Deal-value band filter (lakh thresholds), for the Pursuits "Value" filter.
    // Coerce to Number — query-string values arrive as text and would make
    // Postgres reject `numeric >= $n`.
    const vMin = filters.value_min != null && filters.value_min !== '' ? Number(filters.value_min) : null;
    const vMax = filters.value_max != null && filters.value_max !== '' ? Number(filters.value_max) : null;
    if (vMin != null && !Number.isNaN(vMin)) {
      query += ` AND COALESCE(o.expected_value,0) >= $${paramCount}`;
      params.push(vMin);
      paramCount++;
    }
    if (vMax != null && !Number.isNaN(vMax)) {
      query += ` AND COALESCE(o.expected_value,0) < $${paramCount}`;
      params.push(vMax);
      paramCount++;
    }

    // Whitelisted sort; default keeps the historic close-date ordering.
    const sortCol = SORTABLE[filters.sort] || 'o.expected_closing_date';
    const dir = String(filters.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    query += ` ORDER BY ${sortCol} ${dir} NULLS LAST`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async findById(id, company_id = null) {
    const result = await pool.query(
      `SELECT o.*,
        l.company_name,
        l.contact_person,
        l.email,
        l.phone,
        e.name as assigned_to_name
       FROM opportunities o
       LEFT JOIN leads l ON o.lead_id = l.id
       LEFT JOIN employees e ON o.assigned_to = e.id
       WHERE o.id = $1 AND o.deleted_at IS NULL
         AND ($2::int IS NULL OR o.company_id = $2)`,
      [id, company_id ?? null]
    );
    return result.rows[0];
  },

  async update(id, data) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    // Numeric/date/FK columns reject '' — a blank from the form clears them.
    const NULLABLE = new Set([
      'estimate_value', 'held_by', 'follow_up_date', 'assigned_to',
      'expected_value', 'expected_closing_date', 'lead_id',
    ]);

    Object.keys(data).forEach(key => {
      if (OPP_COLUMNS.has(key) && data[key] !== undefined) {
        fields.push(`${key} = $${paramCount}`);
        values.push(data[key] === '' && NULLABLE.has(key) ? null : data[key]);
        paramCount++;
      }
    });

    if (fields.length === 0) {
      const result = await pool.query('SELECT * FROM opportunities WHERE id = $1 AND deleted_at IS NULL', [id]);
      return result.rows[0];
    }

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await pool.query(
      `UPDATE opportunities SET ${fields.join(', ')} WHERE id = $${paramCount} AND deleted_at IS NULL RETURNING *`,
      values
    );
    return result.rows[0];
  },

  async delete(id) {
    await pool.query(`UPDATE opportunities SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
  },

  async getPipelineValue(company_id = null) {
    const cw = company_id != null ? 'AND company_id = $1' : '';
    const params = company_id != null ? [company_id] : [];
    const result = await pool.query(`
      SELECT stage,
        COUNT(*) AS count,
        COALESCE(SUM(expected_value), 0) AS total_value,
        COALESCE(AVG(expected_value), 0) AS avg_value
      FROM opportunities
      WHERE deleted_at IS NULL AND LOWER(stage) NOT IN ('won', 'lost') ${cw}
      GROUP BY stage
      ORDER BY CASE LOWER(stage)
        WHEN 'prospecting'   THEN 1
        WHEN 'qualification' THEN 2
        WHEN 'proposal'      THEN 3
        WHEN 'negotiation'   THEN 4
        ELSE 5 END
    `, params);
    return result.rows;
  },

  async getKanbanBoard(company_id = null) {
    const params = [];
    let cidClause = '';
    if (company_id != null) {
      cidClause = ` AND o.company_id = $1`;
      params.push(company_id);
    }
    const result = await pool.query(`
      SELECT o.*,
        l.company_name,
        l.contact_person,
        e.name as assigned_to_name,
        CASE WHEN o.expected_closing_date < CURRENT_DATE
             AND LOWER(o.stage) NOT IN ('won','lost')
             THEN true ELSE false END AS is_overdue
      FROM opportunities o
      LEFT JOIN leads l ON o.lead_id = l.id
      LEFT JOIN employees e ON e.id = o.assigned_to
        AND e.status IN ('active','probation')
      WHERE o.deleted_at IS NULL${cidClause}
      ORDER BY o.expected_closing_date ASC NULLS LAST
    `, params);

    // Title-case keys match the frontend STAGES array.
    // Case-insensitive bucketing so DB values like 'qualification' and 'Qualification' both map correctly.
    const board = {
      Prospecting:   [],
      Qualification: [],
      Proposal:      [],
      Negotiation:   [],
      Won:           [],
      Lost:          [],
    };

    const stageKeys = Object.keys(board);
    result.rows.forEach(opp => {
      const raw = (opp.stage || '').trim();
      const matched = stageKeys.find(k => k.toLowerCase() === raw.toLowerCase());
      if (matched) {
        board[matched].push(opp);
      }
    });

    return board;
  },

  async getAverageDealSize(company_id = null) {
    const cw = company_id != null ? 'AND company_id = $1' : '';
    const params = company_id != null ? [company_id] : [];
    const result = await pool.query(`
      SELECT COALESCE(AVG(expected_value), 0) AS avg_deal_size
      FROM opportunities
      WHERE deleted_at IS NULL AND LOWER(stage) = 'won' ${cw}
    `, params);
    return result.rows[0];
  }
};

export default opportunitiesRepository;
