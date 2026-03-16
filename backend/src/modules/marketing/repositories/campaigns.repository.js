import pool from '../../shared/db.js';

const campaignsRepository = {
  async create(data) {
    const { campaign_name, campaign_type, start_date, end_date, budget, expected_leads, status, description, created_by } = data;
    const result = await pool.query(
      `INSERT INTO campaigns (campaign_name, campaign_type, start_date, end_date, budget, expected_leads, status, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [campaign_name, campaign_type, start_date, end_date, budget, expected_leads, status, description, created_by]
    );
    return result.rows[0];
  },

  async findAll(filters = {}) {
    let query = `SELECT * FROM campaigns WHERE deleted_at IS NULL`;
    const params = [];
    let paramCount = 1;

    if (filters.status) {
      query += ` AND status = $${paramCount}`;
      params.push(filters.status);
      paramCount++;
    }

    if (filters.campaign_type) {
      query += ` AND campaign_type = $${paramCount}`;
      params.push(filters.campaign_type);
      paramCount++;
    }

    query += ` ORDER BY created_at DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  },

  async findById(id) {
    const result = await pool.query(
      `SELECT * FROM campaigns WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    return result.rows[0];
  },

  async update(id, data) {
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
      `UPDATE campaigns SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0];
  },

  async delete(id) {
    await pool.query(`UPDATE campaigns SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
  },

  async linkLead(campaign_id, lead_id) {
    try {
      await pool.query(
        `INSERT INTO campaign_leads (campaign_id, lead_id) VALUES ($1, $2)`,
        [campaign_id, lead_id]
      );
      
      // Update actual leads count
      await pool.query(
        `UPDATE campaigns SET actual_leads = (
          SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = $1
        ) WHERE id = $1`,
        [campaign_id]
      );
    } catch (error) {
      // Ignore duplicate key errors
      if (error.code !== '23505') throw error;
    }
  },

  async getLeads(campaign_id) {
    const result = await pool.query(`
      SELECT l.*, cl.created_at as linked_at
      FROM campaign_leads cl
      JOIN leads l ON cl.lead_id = l.id
      WHERE cl.campaign_id = $1 AND l.deleted_at IS NULL
      ORDER BY cl.created_at DESC
    `, [campaign_id]);
    return result.rows;
  },

  async getMetrics(campaign_id) {
    const result = await pool.query(`
      SELECT 
        c.budget,
        c.actual_spend,
        c.expected_leads,
        c.actual_leads,
        CASE WHEN c.actual_leads > 0 THEN ROUND((c.actual_spend / c.actual_leads)::numeric, 2) ELSE 0 END as cost_per_lead,
        COUNT(DISTINCT CASE WHEN l.status = 'converted' THEN l.id END) as converted_leads,
        CASE WHEN c.actual_leads > 0 THEN 
          ROUND((COUNT(DISTINCT CASE WHEN l.status = 'converted' THEN l.id END)::numeric / c.actual_leads * 100), 2)
        ELSE 0 END as conversion_rate
      FROM campaigns c
      LEFT JOIN campaign_leads cl ON c.id = cl.campaign_id
      LEFT JOIN leads l ON cl.lead_id = l.id
      WHERE c.id = $1
      GROUP BY c.id, c.budget, c.actual_spend, c.expected_leads, c.actual_leads
    `, [campaign_id]);
    return result.rows[0];
  },

  async getLeadsByCampaign() {
    const result = await pool.query(`
      SELECT 
        c.campaign_name,
        c.campaign_type,
        COUNT(cl.lead_id) as lead_count,
        c.budget,
        c.actual_spend
      FROM campaigns c
      LEFT JOIN campaign_leads cl ON c.id = cl.campaign_id
      WHERE c.deleted_at IS NULL
      GROUP BY c.id, c.campaign_name, c.campaign_type, c.budget, c.actual_spend
      ORDER BY lead_count DESC
    `);
    return result.rows;
  },

  async getCampaignROI() {
    const result = await pool.query(`
      SELECT 
        c.campaign_name,
        c.actual_spend,
        COUNT(DISTINCT o.id) as deals_won,
        COALESCE(SUM(o.expected_value), 0) as revenue,
        CASE WHEN c.actual_spend > 0 THEN
          ROUND((((COALESCE(SUM(o.expected_value), 0) - c.actual_spend) / c.actual_spend) * 100)::numeric, 2)
        ELSE 0 END as roi_percentage
      FROM campaigns c
      LEFT JOIN campaign_leads cl ON c.id = cl.campaign_id
      LEFT JOIN leads l ON cl.lead_id = l.id
      LEFT JOIN opportunities o ON l.id = o.lead_id AND o.stage = 'won'
      WHERE c.deleted_at IS NULL
      GROUP BY c.id, c.campaign_name, c.actual_spend
      ORDER BY roi_percentage DESC
    `);
    return result.rows;
  }
};

export default campaignsRepository;
