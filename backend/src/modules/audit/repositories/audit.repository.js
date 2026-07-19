import pool from '../../shared/db.js';

const auditRepository = {
  async create(data) {
    const { user_id, module_name, action_type, reference_id, reference_type, old_data_json, new_data_json, ip_address, user_agent, company_id } = data;
    const result = await pool.query(
      `INSERT INTO audit_logs (user_id, module_name, action_type, reference_id, reference_type, old_data_json, new_data_json, ip_address, user_agent, company_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [user_id, module_name, action_type, reference_id, reference_type,
       old_data_json ? JSON.stringify(old_data_json) : null,
       new_data_json ? JSON.stringify(new_data_json) : null,
       ip_address, user_agent, company_id ?? null]
    );
    return result.rows[0];
  },

  async findAll(filters = {}) {
    const conditions = [];
    const params     = [];
    let   p          = 1;

    if (filters.company_id != null) {
      conditions.push(`al.company_id = $${p++}`);
      params.push(filters.company_id);
    }
    if (filters.module_name) {
      conditions.push(`LOWER(al.module_name) = LOWER($${p++})`);
      params.push(filters.module_name);
    }
    if (filters.action_type) {
      conditions.push(`LOWER(al.action_type) = LOWER($${p++})`);
      params.push(filters.action_type);
    }
    if (filters.search) {
      conditions.push(`(
        al.module_name    ILIKE $${p} OR
        al.action_type    ILIKE $${p} OR
        al.reference_type ILIKE $${p} OR
        CONCAT(e.first_name,' ',e.last_name) ILIKE $${p}
      )`);
      params.push(`%${filters.search}%`);
      p++;
    }
    if (filters.start_date) {
      conditions.push(`al.created_at >= $${p++}::timestamptz`);
      params.push(filters.start_date);
    }
    if (filters.end_date) {
      conditions.push(`al.created_at < ($${p++}::date + interval '1 day')`);
      params.push(filters.end_date);
    }

    const where  = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const limit  = Math.min(parseInt(filters.limit  || 50, 10), 200);
    const offset = parseInt(filters.offset || 0, 10);

    const [dataRes, countRes] = await Promise.all([
      pool.query(`
        SELECT al.*,
               NULLIF(TRIM(CONCAT(e.first_name,' ',e.last_name)),'') AS user_name
        FROM audit_logs al
        LEFT JOIN employees e ON al.user_id = e.id
        ${where}
        ORDER BY al.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `, params),
      pool.query(`
        SELECT COUNT(*) FROM audit_logs al
        LEFT JOIN employees e ON al.user_id = e.id
        ${where}
      `, params),
    ]);

    const total = parseInt(countRes.rows[0].count, 10);
    const page  = Math.floor(offset / limit) + 1;
    return {
      logs   : dataRes.rows,
      total,
      limit,
      offset,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  },

  async getStats(filters = {}) {
    const conditions = [];
    const params     = [];
    let   p          = 1;

    if (filters.company_id != null) {
      conditions.push(`company_id = $${p++}`);
      params.push(filters.company_id);
    }
    if (filters.start_date) {
      conditions.push(`created_at >= $${p++}::timestamptz`);
      params.push(filters.start_date);
    }
    if (filters.end_date) {
      conditions.push(`created_at < ($${p++}::date + interval '1 day')`);
      params.push(filters.end_date);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [totals, byModule, byAction] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)                                                         AS total,
          COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)              AS today,
          COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL)      AS unique_users,
          COUNT(DISTINCT module_name) FILTER (WHERE module_name IS NOT NULL) AS modules
        FROM audit_logs ${where}
      `, params),
      pool.query(`
        SELECT COALESCE(module_name,'Unknown') AS module, COUNT(*) AS count
        FROM audit_logs ${where}
        GROUP BY module_name ORDER BY count DESC LIMIT 10
      `, params),
      pool.query(`
        SELECT UPPER(action_type) AS action, COUNT(*) AS count
        FROM audit_logs ${where}
        GROUP BY UPPER(action_type) ORDER BY count DESC LIMIT 10
      `, params),
    ]);

    return {
      total      : parseInt(totals.rows[0].total,        10),
      today      : parseInt(totals.rows[0].today,        10),
      uniqueUsers: parseInt(totals.rows[0].unique_users, 10),
      modules    : parseInt(totals.rows[0].modules,      10),
      byModule   : byModule.rows.map(r => ({ module: r.module, count: parseInt(r.count, 10) })),
      byAction   : byAction.rows.map(r => ({ action: r.action, count: parseInt(r.count, 10) })),
    };
  },

  async findByReference(reference_id, reference_type) {
    const result = await pool.query(
      `SELECT al.*, NULLIF(TRIM(CONCAT(e.first_name,' ',e.last_name)),'') AS user_name
       FROM audit_logs al
       LEFT JOIN employees e ON al.user_id = e.id
       WHERE al.reference_id = $1 AND al.reference_type = $2
       ORDER BY al.created_at DESC`,
      [reference_id, reference_type]
    );
    return result.rows;
  },

  async logCreate(user_id, module_name, reference_id, reference_type, new_data, ip_address) {
    return this.create({ user_id, module_name, action_type:'create', reference_id, reference_type, new_data_json: new_data, ip_address });
  },
  async logUpdate(user_id, module_name, reference_id, reference_type, old_data, new_data, ip_address) {
    return this.create({ user_id, module_name, action_type:'update', reference_id, reference_type, old_data_json: old_data, new_data_json: new_data, ip_address });
  },
  async logDelete(user_id, module_name, reference_id, reference_type, old_data, ip_address) {
    return this.create({ user_id, module_name, action_type:'delete', reference_id, reference_type, old_data_json: old_data, ip_address });
  },
};

export default auditRepository;
