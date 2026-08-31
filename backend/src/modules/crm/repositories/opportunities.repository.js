import pool from '../../shared/db.js';
import {
  sqlOpportunityWon, sqlOpportunityOpen,
} from '../../../shared/statusSets.js';

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

  /**
   * @param company_id  REQUIRED for tenant safety — see the matching note on
   *   leads.repository.update(). Without it PUT /crm/opportunities/:id rewrote
   *   any tenant's row by id (audit C-08).
   */
  async update(id, data, company_id = null) {
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
      const result = await pool.query(
        `SELECT * FROM opportunities
          WHERE id = $1 AND deleted_at IS NULL
            AND ($2::int IS NULL OR company_id = $2)`,
        [id, company_id ?? null]
      );
      return result.rows[0];
    }

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    const idParam = paramCount;
    values.push(company_id ?? null);

    const result = await pool.query(
      `UPDATE opportunities SET ${fields.join(', ')}
        WHERE id = $${idParam} AND deleted_at IS NULL
          AND ($${idParam + 1}::int IS NULL OR company_id = $${idParam + 1})
      RETURNING *`,
      values
    );
    return result.rows[0];
  },

  /** Tenant-scoped soft delete. Returns the row so callers can 404 on a miss. */
  async delete(id, company_id = null) {
    const { rows } = await pool.query(
      `UPDATE opportunities SET deleted_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND deleted_at IS NULL
          AND ($2::int IS NULL OR company_id = $2)
      RETURNING id`,
      [id, company_id ?? null]
    );
    return rows[0] || null;
  },

  async getPipelineValue(company_id = null) {
    const cw = company_id != null ? 'AND company_id = $1' : '';
    const params = company_id != null ? [company_id] : [];
    const result = await pool.query(`
      SELECT o.stage,
        COUNT(*) AS count,
        COALESCE(SUM(o.expected_value), 0) AS total_value,
        COALESCE(AVG(o.expected_value), 0) AS avg_value,
        COALESCE(SUM(o.expected_value * o.probability_percentage / 100.0), 0) AS weighted_value
      FROM opportunities o
      WHERE o.deleted_at IS NULL AND ${sqlOpportunityOpen('o.stage')} ${cw ? cw.replace('company_id', 'o.company_id') : ''}
      GROUP BY o.stage
      ORDER BY COALESCE(
        (SELECT ps.sort_order FROM crm_pipeline_stages ps
          WHERE LOWER(ps.stage_key) = LOWER(o.stage) OR LOWER(ps.name) = LOWER(o.stage)
          LIMIT 1), 999)
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

    // Stage columns come from the per-company `crm_pipeline_stages` master, not
    // from a list hardcoded here and mirrored again in the JSX — the settings
    // screen writes that table and the board never read it (audit C-28).
    const { rows: stageRows } = await pool.query(
      `SELECT name, stage_key, color, probability, is_won, is_lost
         FROM crm_pipeline_stages
        WHERE is_active = true AND ($1::int IS NULL OR company_id = $1)
        ORDER BY sort_order ASC`,
      [company_id ?? null]
    );

    const stages = stageRows.length
      ? stageRows.map(s => ({ key: s.name, match: (s.stage_key || s.name || '').toLowerCase(), meta: s }))
      : ['Prospecting', 'Qualification', 'Proposal', 'Negotiation', 'Won', 'Lost']
          .map(k => ({ key: k, match: k.toLowerCase(), meta: null }));

    const board = {};
    stages.forEach(s => { board[s.key] = []; });

    // Anything whose stage matches no configured column used to be dropped on
    // the floor by a bare `if (matched)`. That silently hid ₹19,89,009 of
    // pipeline sitting in a 'Bidding' stage and made the board's total disagree
    // with /stats by 46.7% (audit C-10). Unmapped stages now surface in their
    // own column so the number reconciles and the misconfiguration is visible.
    const UNMAPPED = 'Unmapped';
    result.rows.forEach(opp => {
      const raw = (opp.stage || '').trim().toLowerCase();
      const hit = stages.find(s => s.match === raw || s.key.toLowerCase() === raw);
      if (hit) {
        board[hit.key].push(opp);
      } else {
        (board[UNMAPPED] ||= []).push(opp);
      }
    });

    return {
      board,
      stages: stages.map(s => ({
        key: s.key,
        label: s.meta?.name ?? s.key,
        color: s.meta?.color ?? null,
        probability: s.meta?.probability ?? null,
        is_won: s.meta?.is_won ?? /^won$/i.test(s.key),
        is_lost: s.meta?.is_lost ?? /^lost$/i.test(s.key),
      })).concat(board[UNMAPPED]?.length
        ? [{ key: UNMAPPED, label: 'Unmapped stage', color: '#B3261E', probability: null, is_won: false, is_lost: false }]
        : []),
    };
  },

  /**
   * Average deal size. `avg_deal_size` is the WON figure — the industry meaning
   * and now consistent with /opportunities/stats, which used to publish the
   * OPEN mean under the same name (audit C-14). The open mean is still returned
   * alongside it, explicitly labelled, because the pipeline view wants it.
   */
  async getAverageDealSize(company_id = null) {
    const cw = company_id != null ? 'AND company_id = $1' : '';
    const params = company_id != null ? [company_id] : [];
    const result = await pool.query(`
      SELECT
        COALESCE(AVG(expected_value) FILTER (WHERE ${sqlOpportunityWon('stage')}), 0)  AS avg_deal_size,
        COALESCE(AVG(expected_value) FILTER (WHERE ${sqlOpportunityOpen('stage')}), 0) AS avg_open_deal_size,
        COUNT(*) FILTER (WHERE ${sqlOpportunityWon('stage')})                          AS won_count
      FROM opportunities
      WHERE deleted_at IS NULL ${cw}
    `, params);
    return result.rows[0];
  }
};

export default opportunitiesRepository;
