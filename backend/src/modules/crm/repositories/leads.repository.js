import pool from '../../shared/db.js';

// Whitelist of columns that can be written to the leads table.
// Prevents joined columns (assigned_to_name, etc.) from reaching UPDATE/INSERT.
// iem_no is deliberately absent — it is assigned once on create and must never be
// reassigned by an edit, or exported enquiry numbers stop reconciling.
const LEAD_COLUMNS = new Set([
  'lead_source', 'company_name', 'contact_person', 'email', 'phone',
  'industry', 'location', 'assigned_to', 'status', 'notes', 'lead_score',
  'zone', 'estimated_value', 'partner_id', 'probability',
]);

// The IEM number: fiscal year (Apr-Mar) of creation + zero-padded id. Must stay
// identical to the backfill in 20260717000002 — see that migration for why this is
// derived from the row id rather than drawn from a sequence.
//
// `id` is pre-allocated from the sequence so the number can be built in the same
// INSERT. The obvious-looking alternative — INSERT in a CTE, then UPDATE the row
// to stamp the number — silently does not work: a data-modifying CTE is not
// visible to the rest of the statement, so the UPDATE matches zero rows and the
// enquiry is created with a NULL iem_no.
//
// NOW() rather than created_at: created_at defaults to CURRENT_TIMESTAMP, and both
// resolve to the same transaction timestamp.
const IEM_NO_SQL = `
  'IEM/' ||
    CASE WHEN EXTRACT(MONTH FROM NOW()) >= 4
         THEN EXTRACT(YEAR FROM NOW())::int
         ELSE EXTRACT(YEAR FROM NOW())::int - 1 END
    || '/' || LPAD(s.new_id::text, 4, '0')`;

// '' from a form means "cleared" on a nullable column; numerics reject ''.
const asNum = v => (v === '' || v == null ? null : v);

const leadsRepository = {
  async create(data) {
    const {
      lead_source, company_name, contact_person, email, phone,
      industry, location, assigned_to, status, notes, created_by,
      lead_score, company_id, zone, estimated_value, partner_id, probability,
    } = data;
    // The id is drawn from the sequence first so the enquiry and its IEM number
    // are written together — no second statement, nothing to leave half-done.
    const result = await pool.query(
      `WITH s AS (SELECT nextval(pg_get_serial_sequence('leads','id')) AS new_id)
       INSERT INTO leads
         (id, lead_source, company_name, contact_person, email, phone,
          industry, location, assigned_to, status, notes, created_by,
          lead_score, company_id, zone, estimated_value, partner_id, probability,
          iem_no)
       SELECT s.new_id, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
              (${IEM_NO_SQL})
         FROM s
       RETURNING *`,
      [
        lead_source, company_name, contact_person, email, phone,
        industry, location, assigned_to, status ?? 'New', notes,
        created_by, lead_score ?? 0, company_id ?? null,
        zone || null, asNum(estimated_value), asNum(partner_id), asNum(probability),
      ]
    );
    return result.rows[0];
  },

  async findAll(filters = {}) {
    // ROOT FIX: filter on l.company_id (the lead's own column), NOT e.company_id.
    // Filtering via the employee JOIN excluded all leads with NULL assigned_to.
    const cid = filters.company_id != null ? filters.company_id : null;
    let query = `
      SELECT
        l.*,
        e.name  AS assigned_to_name,
        e.id    AS owner_id,
        sp.name AS partner_name,
        -- Value shown on the IEM grid. Prefers the enquiry's own estimate; falls
        -- back to the linked opportunities so converted enquiries still show a
        -- figure. Mirrors the won-lost report's COALESCE so the two agree.
        COALESCE(l.estimated_value, o.opp_value, 0)::numeric AS lead_value
      FROM leads l
      LEFT JOIN employees e
        ON l.assigned_to = e.id
        AND LOWER(e.status) IN ('active','probation')
      LEFT JOIN sales_partners sp ON sp.id = l.partner_id
      LEFT JOIN LATERAL (
             SELECT SUM(o2.expected_value) AS opp_value
               FROM opportunities o2
              WHERE o2.lead_id = l.id AND o2.deleted_at IS NULL
           ) o ON TRUE
      WHERE l.deleted_at IS NULL
    `;
    const params = [];
    let pc = 1;

    if (cid != null) {
      query += ` AND l.company_id = $${pc++}`;
      params.push(cid);
    }

    if (filters.status) {
      query += ` AND LOWER(l.status) = LOWER($${pc++})`;
      params.push(filters.status);
    }

    if (filters.lead_source) {
      query += ` AND l.lead_source = $${pc++}`;
      params.push(filters.lead_source);
    }

    if (filters.assigned_to) {
      query += ` AND l.assigned_to = $${pc++}`;
      params.push(filters.assigned_to);
    }

    if (filters.partner_id) {
      query += ` AND l.partner_id = $${pc++}`;
      params.push(parseInt(filters.partner_id, 10));
    }

    if (filters.zone) {
      query += ` AND l.zone = $${pc++}`;
      params.push(filters.zone);
    }

    // Probability From-To. Applied only to enquiries that carry a probability —
    // a NULL would otherwise be silently dropped by the comparison and make the
    // filter look like it deleted rows.
    if (filters.prob_min !== undefined && filters.prob_min !== '') {
      query += ` AND l.probability >= $${pc++}`;
      params.push(parseInt(filters.prob_min, 10));
    }
    if (filters.prob_max !== undefined && filters.prob_max !== '') {
      query += ` AND l.probability <= $${pc++}`;
      params.push(parseInt(filters.prob_max, 10));
    }

    // Value range, in LAKHS on the wire (matching the won-lost report's contract).
    if (filters.min_value !== undefined && filters.min_value !== '') {
      query += ` AND COALESCE(l.estimated_value, o.opp_value, 0) >= $${pc++}`;
      params.push(parseFloat(filters.min_value) * 100000);
    }
    if (filters.max_value !== undefined && filters.max_value !== '') {
      query += ` AND COALESCE(l.estimated_value, o.opp_value, 0) <= $${pc++}`;
      params.push(parseFloat(filters.max_value) * 100000);
    }

    // Fiscal year (Apr-Mar) of creation.
    if (filters.fy) {
      const y = parseInt(filters.fy, 10);
      query += ` AND l.created_at >= $${pc++} AND l.created_at < $${pc++}`;
      params.push(`${y}-04-01`, `${y + 1}-04-01`);
    }

    if (filters.search) {
      query += ` AND (l.company_name ILIKE $${pc} OR l.contact_person ILIKE $${pc}
                      OR l.email ILIKE $${pc} OR l.iem_no ILIKE $${pc}
                      OR l.phone ILIKE $${pc} OR sp.name ILIKE $${pc})`;
      params.push(`%${filters.search}%`);
      pc++;
    }

    query += ` ORDER BY l.created_at DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async findById(id, company_id = null) {
    const result = await pool.query(
      `SELECT l.*, e.name AS assigned_to_name, sp.name AS partner_name
       FROM leads l
       LEFT JOIN employees e
         ON l.assigned_to = e.id
         AND LOWER(e.status) IN ('active','probation')
       LEFT JOIN sales_partners sp ON sp.id = l.partner_id
       WHERE l.id = $1 AND l.deleted_at IS NULL
         AND ($2::int IS NULL OR l.company_id = $2)`,
      [id, company_id ?? null]
    );
    return result.rows[0];
  },

  async update(id, data) {
    const fields = [];
    const values = [];
    let pc = 1;

    // Nullable columns: an empty string from the form is "cleared", not a value.
    // estimated_value is numeric and would reject ''.
    const NULLABLE = new Set([
      'zone', 'estimated_value', 'assigned_to', 'partner_id', 'probability',
    ]);

    Object.keys(data).forEach(key => {
      if (LEAD_COLUMNS.has(key) && data[key] !== undefined) {
        fields.push(`${key} = $${pc++}`);
        values.push(data[key] === '' && NULLABLE.has(key) ? null : data[key]);
      }
    });

    if (fields.length === 0) {
      const result = await pool.query(
        'SELECT * FROM leads WHERE id = $1 AND deleted_at IS NULL',
        [id]
      );
      return result.rows[0];
    }

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await pool.query(
      `UPDATE leads SET ${fields.join(', ')} WHERE id = $${pc} AND deleted_at IS NULL RETURNING *`,
      values
    );
    return result.rows[0];
  },

  async delete(id) {
    await pool.query(`UPDATE leads SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
  },

  async getStats(company_id = null) {
    const cid = company_id != null ? company_id : null;
    // The per-status counts are built from the status column as it actually is,
    // not from a fixed list: the live data carries Won / Lost / Negotiation, which
    // were absent from the UI's status list, so those enquiries were unreachable
    // through the status tabs. by_status keeps the tabs honest as data drifts.
    const query = `
      SELECT
        COUNT(*)                                                  AS total,
        COUNT(*) FILTER (WHERE LOWER(l.status) = 'new')           AS new,
        COUNT(*) FILTER (WHERE LOWER(l.status) = 'contacted')     AS contacted,
        COUNT(*) FILTER (WHERE LOWER(l.status) = 'qualified')     AS qualified,
        COUNT(*) FILTER (WHERE LOWER(l.status) = 'unqualified')   AS unqualified,
        COUNT(*) FILTER (WHERE LOWER(l.status) = 'converted')     AS converted,
        COUNT(*) FILTER (WHERE LOWER(l.status) = 'shelved')       AS shelved,
        ROUND(AVG(COALESCE(l.lead_score, 0)), 1)                  AS avg_score,
        COALESCE(
          SUM(o.expected_value) FILTER (
            WHERE o.id IS NOT NULL AND LOWER(o.stage) NOT IN ('won','lost')
          ), 0
        )                                                         AS total_pipeline_value,
        (
          SELECT COALESCE(json_object_agg(s.k, s.c), '{}'::json) FROM (
            SELECT LOWER(COALESCE(NULLIF(TRIM(status), ''), 'unknown')) AS k,
                   COUNT(*)::int                                        AS c
              FROM leads
             WHERE deleted_at IS NULL
               AND ($1::int IS NULL OR company_id = $1)
             GROUP BY 1
          ) s
        )                                                         AS by_status
      FROM leads l
      LEFT JOIN opportunities o ON o.lead_id = l.id AND o.deleted_at IS NULL
      WHERE l.deleted_at IS NULL
        AND ($1::int IS NULL OR l.company_id = $1)
    `;
    const result = await pool.query(query, [cid]);
    const r = result.rows[0];
    return {
      total:                parseInt(r.total),
      new:                  parseInt(r.new),
      contacted:            parseInt(r.contacted),
      qualified:            parseInt(r.qualified),
      unqualified:          parseInt(r.unqualified),
      converted:            parseInt(r.converted),
      shelved:              parseInt(r.shelved),
      avg_score:            parseFloat(r.avg_score) || 0,
      total_pipeline_value: parseFloat(r.total_pipeline_value) || 0,
      by_status:            r.by_status || {},
    };
  },

  /**
   * IEM summary matrix: one row per bucket, each with Count / Value / Estimate.
   *
   * Value vs Estimate are genuinely different figures, not a duplicate column:
   *   Estimate — SUM(leads.estimated_value): what sales judged the enquiry to be
   *              worth at entry, before any opportunity existed.
   *   Value    — SUM(COALESCE(opportunity total, estimated_value)): the revalued
   *              figure once the enquiry became a pursuit. The two diverge exactly
   *              where an opportunity was re-priced after conversion, which is the
   *              spread the summary exists to show.
   *
   * Bucket definitions mirror the won-lost report (crm.routes.js) so the two
   * screens cannot disagree about what "won" means:
   *   won    — a linked opportunity reached stage Won, or the lead is marked Won.
   *   lost   — a linked opportunity reached stage Lost, or the lead is Lost/Unqualified.
   *   shelved— the lead is parked (status Shelved); deliberately NOT counted as lost.
   */
  async getSummary(company_id = null, filters = {}) {
    const cid = company_id != null ? company_id : null;
    const params = [cid];
    let extra = '';

    if (filters.assigned_to) {
      params.push(parseInt(filters.assigned_to, 10));
      extra += ` AND COALESCE(l.assigned_to, l.owner_id) = $${params.length}`;
    }
    if (filters.fy) {
      const y = parseInt(filters.fy, 10);
      params.push(`${y}-04-01`); const s = params.length;
      params.push(`${y + 1}-04-01`); const e = params.length;
      extra += ` AND l.created_at >= $${s} AND l.created_at < $${e}`;
    }

    const { rows } = await pool.query(
      `WITH lv AS (
         SELECT l.id,
                LOWER(COALESCE(l.status, '')) AS status,
                l.estimated_value,
                COALESCE(o.opp_value, l.estimated_value, 0)::numeric AS value,
                COALESCE(o.has_won, false)  AS has_won,
                COALESCE(o.has_lost, false) AS has_lost
           FROM leads l
           LEFT JOIN LATERAL (
                  SELECT SUM(o2.expected_value)               AS opp_value,
                         BOOL_OR(LOWER(o2.stage) = 'won')     AS has_won,
                         BOOL_OR(LOWER(o2.stage) = 'lost')    AS has_lost
                    FROM opportunities o2
                   WHERE o2.lead_id = l.id AND o2.deleted_at IS NULL
                ) o ON TRUE
          WHERE l.deleted_at IS NULL
            AND ($1::int IS NULL OR l.company_id = $1)
            ${extra}
       ),
       tagged AS (
         SELECT *,
                (has_won  OR status = 'won')                        AS is_won,
                (has_lost OR status IN ('lost', 'unqualified'))     AS is_lost,
                (status = 'shelved')                                AS is_shelved
           FROM lv
       )
       SELECT
         COUNT(*)::int                                              AS total_count,
         COALESCE(SUM(value), 0)::float8                            AS total_value,
         COALESCE(SUM(estimated_value), 0)::float8                  AS total_estimate,
         COUNT(*) FILTER (WHERE is_won)::int                        AS won_count,
         COALESCE(SUM(value)           FILTER (WHERE is_won), 0)::float8            AS won_value,
         COALESCE(SUM(estimated_value) FILTER (WHERE is_won), 0)::float8            AS won_estimate,
         COUNT(*) FILTER (WHERE is_lost AND NOT is_won)::int        AS lost_count,
         COALESCE(SUM(value)           FILTER (WHERE is_lost AND NOT is_won), 0)::float8 AS lost_value,
         COALESCE(SUM(estimated_value) FILTER (WHERE is_lost AND NOT is_won), 0)::float8 AS lost_estimate,
         COUNT(*) FILTER (WHERE is_shelved)::int                    AS shelved_count,
         COALESCE(SUM(value)           FILTER (WHERE is_shelved), 0)::float8        AS shelved_value,
         COALESCE(SUM(estimated_value) FILTER (WHERE is_shelved), 0)::float8        AS shelved_estimate
       FROM tagged`,
      params
    );

    const r = rows[0];
    const total = r.total_count || 0;
    return {
      conversion_rate: total ? parseFloat(((r.won_count / total) * 100).toFixed(1)) : 0,
      rows: [
        { key: 'total',   label: 'Total Lead',    count: r.total_count,   value: r.total_value,   estimate: r.total_estimate },
        { key: 'won',     label: 'Total Won',     count: r.won_count,     value: r.won_value,     estimate: r.won_estimate },
        { key: 'lost',    label: 'Total Lost',    count: r.lost_count,    value: r.lost_value,    estimate: r.lost_estimate },
        { key: 'shelved', label: 'Total Shelved', count: r.shelved_count, value: r.shelved_value, estimate: r.shelved_estimate },
      ],
    };
  },

  async getLeadsBySource(company_id = null) {
    const cid = company_id != null ? company_id : null;
    const result = await pool.query(
      `SELECT lead_source, COUNT(*) AS count
       FROM leads
       WHERE deleted_at IS NULL
         AND ($1::int IS NULL OR company_id = $1)
       GROUP BY lead_source
       ORDER BY count DESC`,
      [cid]
    );
    return result.rows;
  },

  async getConversionRate(company_id = null) {
    const cid = company_id != null ? company_id : null;
    const result = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE LOWER(status) = 'converted') AS converted,
         COUNT(*) AS total,
         ROUND(
           COUNT(*) FILTER (WHERE LOWER(status) = 'converted')::numeric
             / NULLIF(COUNT(*), 0) * 100,
           2
         ) AS conversion_rate
       FROM leads
       WHERE deleted_at IS NULL
         AND ($1::int IS NULL OR company_id = $1)`,
      [cid]
    );
    return result.rows[0];
  },

  async addActivity(data) {
    const { lead_id, activity_type, activity_date, notes, next_followup_date, created_by } = data;
    // company_id is derived from the parent lead rather than trusted from the
    // caller: a NULL company_id is invisible to every scoped read.
    const result = await pool.query(
      `INSERT INTO lead_activities
         (lead_id, company_id, activity_type, activity_date, notes,
          next_followup_date, created_by)
       SELECT $1::int, l.company_id, $2::varchar, COALESCE($3::timestamptz, NOW()),
              $4::text, $5::date, $6::int
         FROM leads l
        WHERE l.id = $1::int AND l.deleted_at IS NULL
       RETURNING *`,
      [lead_id, activity_type || 'note', activity_date || null, notes,
       next_followup_date || null, created_by ?? null]
    );
    return result.rows[0];
  },

  async getActivities(lead_id) {
    const result = await pool.query(
      `SELECT la.*, e.name AS created_by_name
       FROM lead_activities la
       LEFT JOIN employees e ON la.created_by = e.id
       WHERE la.lead_id = $1 AND la.deleted_at IS NULL
       ORDER BY la.activity_date DESC`,
      [lead_id]
    );
    return result.rows;
  },
};

export default leadsRepository;
