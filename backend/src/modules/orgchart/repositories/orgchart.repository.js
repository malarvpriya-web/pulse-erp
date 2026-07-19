import pool from '../../shared/db.js';

const orgChartRepository = {
  // Cycle detection uses reporting_manager_id (canonical) with fallback to org_relationships
  async wouldCreateCycle(employee_id, proposed_manager_id) {
    if (String(employee_id) === String(proposed_manager_id)) return true;
    const visited = new Set([String(employee_id)]);
    let current = String(proposed_manager_id);
    while (current) {
      if (visited.has(current)) return true;
      visited.add(current);
      const { rows } = await pool.query(
        `SELECT COALESCE(reporting_manager_id::text,
                (SELECT manager_id::text FROM org_relationships WHERE employee_id = e.id LIMIT 1)
               ) AS mgr_id
         FROM employees e WHERE e.id = $1 LIMIT 1`,
        [current]
      );
      current = rows[0]?.mgr_id ? String(rows[0].mgr_id) : null;
    }
    return false;
  },

  // upsert writes to org_relationships AND syncs employees.reporting_manager_id
  async upsert(data) {
    const { employee_id, manager_id, department, position_level } = data;

    if (manager_id && await this.wouldCreateCycle(employee_id, manager_id)) {
      throw new Error('Circular reporting chain detected — this assignment would create a hierarchy loop.');
    }

    // COALESCE on update so assigning a manager from the Org Chart screen cannot
    // wipe department/position_level that the Org Setup screen owns.
    const result = await pool.query(
      `INSERT INTO org_relationships (employee_id, manager_id, department, position_level)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (employee_id)
       DO UPDATE SET
         manager_id = $2,
         department = COALESCE($3, org_relationships.department),
         position_level = COALESCE($4, org_relationships.position_level),
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [employee_id, manager_id ?? null, department ?? null, position_level ?? null]
    );

    // Keep canonical FK in sync so auto-tree and direct-reports agree
    await pool.query(
      `UPDATE employees
          SET reporting_manager_id = $1,
              reporting_manager = COALESCE(
                (SELECT TRIM(first_name || ' ' || COALESCE(last_name,'')) FROM employees WHERE id = $1),
                reporting_manager
              )
        WHERE id = $2`,
      [manager_id ?? null, employee_id]
    );

    return result.rows[0];
  },

  // FIX: added company_id param; fixed e.email→e.company_email, e.photo→e.photo_url
  async getHierarchy(company_id) {
    const result = await pool.query(`
      SELECT
        e.id,
        (e.first_name || ' ' || COALESCE(e.last_name, '')) AS name,
        e.company_email                                      AS email,
        e.designation,
        e.department,
        e.photo_url                                          AS photo,
        COALESCE(e.reporting_manager_id, org.manager_id)    AS manager_id,
        org.position_level,
        (m.first_name || ' ' || COALESCE(m.last_name, ''))  AS manager_name
      FROM employees e
      LEFT JOIN org_relationships org ON e.id = org.employee_id
      LEFT JOIN employees m ON COALESCE(e.reporting_manager_id, org.manager_id) = m.id
      WHERE e.deleted_at IS NULL
        AND LOWER(e.status) IN ('active', 'probation', 'notice')
        AND ($1::int IS NULL OR e.company_id = $1)
      ORDER BY org.position_level ASC NULLS LAST, e.first_name
    `, [company_id]);
    return result.rows;
  },

  // FIX: added company_id param
  async getByDepartment(department, company_id) {
    const result = await pool.query(`
      SELECT
        e.id,
        (e.first_name || ' ' || COALESCE(e.last_name, '')) AS name,
        e.company_email                                      AS email,
        e.designation,
        e.department,
        e.photo_url                                          AS photo,
        org.manager_id,
        org.position_level,
        (m.first_name || ' ' || COALESCE(m.last_name, '')) AS manager_name
      FROM employees e
      LEFT JOIN org_relationships org ON e.id = org.employee_id
      LEFT JOIN employees m ON org.manager_id = m.id
      WHERE e.deleted_at IS NULL
        AND LOWER(e.status) IN ('active', 'probation', 'notice')
        AND e.department = $1
        AND ($2::int IS NULL OR e.company_id = $2)
      ORDER BY org.position_level ASC NULLS LAST, e.first_name
    `, [department, company_id]);
    return result.rows;
  },

  // Uses canonical reporting_manager_id FK — consistent with auto-tree
  async getDirectReports(manager_id, company_id) {
    const result = await pool.query(`
      SELECT
        e.id,
        (e.first_name || ' ' || COALESCE(e.last_name, '')) AS name,
        e.company_email                                      AS email,
        e.designation,
        e.department,
        e.photo_url                                          AS photo,
        (SELECT position_level FROM org_relationships WHERE employee_id = e.id LIMIT 1) AS position_level
      FROM employees e
      WHERE e.reporting_manager_id = $1
        AND e.deleted_at IS NULL
        AND LOWER(e.status) IN ('active', 'probation', 'notice')
        AND ($2::int IS NULL OR e.company_id = $2)
      ORDER BY e.first_name
    `, [manager_id, company_id]);
    return result.rows;
  },

  async buildTree(company_id) {
    const employees = await this.getHierarchy(company_id);

    const nodeMap = {};
    employees.forEach(emp => {
      nodeMap[emp.id] = { ...emp, children: [] };
    });

    const tree = [];
    employees.forEach(emp => {
      const parent = emp.manager_id && nodeMap[emp.manager_id];
      if (parent) {
        parent.children.push(nodeMap[emp.id]);
      } else {
        tree.push(nodeMap[emp.id]);
      }
    });

    return tree;
  },

  // FIX: added company_id param; fixed e.email→e.company_email, e.photo→e.photo_url
  // Hierarchy is driven by reporting_manager_id (which also feeds approval routing);
  // org_relationships.display_order/role only shape sibling ordering and labelling.
  // Members flagged is_active = false are excluded from the rendered chart.
  async buildAutoTree(company_id) {
    const { rows } = await pool.query(`
      SELECT
        e.id,
        (e.first_name || ' ' || COALESCE(e.last_name, '')) AS name,
        e.company_email                                      AS email,
        e.designation,
        e.department,
        e.sub_department,
        e.photo_url                                          AS photo,
        e.reporting_manager_id                              AS manager_id,
        (m.first_name || ' ' || COALESCE(m.last_name, '')) AS manager_name,
        COALESCE(o.role, 'member')                          AS role,
        COALESCE(o.display_order, 0)                        AS display_order
      FROM employees e
      LEFT JOIN employees m ON e.reporting_manager_id = m.id
        AND m.deleted_at IS NULL
        AND LOWER(m.status) IN ('active','probation')
      LEFT JOIN org_relationships o ON o.employee_id = e.id
      WHERE e.deleted_at IS NULL
        AND LOWER(e.status) IN ('active', 'probation', 'notice')
        AND ($1::int IS NULL OR e.company_id = $1)
        AND COALESCE(o.is_active, TRUE) = TRUE
      ORDER BY e.department, COALESCE(o.display_order, 0), e.first_name
    `, [company_id]);

    const nodeMap = {};
    rows.forEach(emp => { nodeMap[emp.id] = { ...emp, children: [] }; });

    const tree = [];
    const placed = new Set();

    rows.forEach(emp => {
      const parent = emp.manager_id && nodeMap[emp.manager_id];
      if (parent && String(emp.manager_id) !== String(emp.id)) {
        parent.children.push(nodeMap[emp.id]);
        placed.add(emp.id);
      }
    });

    rows.forEach(emp => {
      if (!placed.has(emp.id)) tree.push(nodeMap[emp.id]);
    });

    // Siblings under one manager can span departments, so the SQL ordering alone
    // is not enough — order each child list by display_order, heads first.
    const sortSiblings = (nodes) => {
      nodes.sort((a, b) =>
        (a.role === b.role ? 0 : a.role === 'head' ? -1 : 1) ||
        (a.display_order - b.display_order) ||
        String(a.name).localeCompare(String(b.name))
      );
      nodes.forEach(n => sortSiblings(n.children));
      return nodes;
    };

    return sortSiblings(tree);
  },

  // FIX: added company_id param
  async getDepartments(company_id) {
    const { rows } = await pool.query(`
      SELECT DISTINCT department FROM employees
      WHERE deleted_at IS NULL
        AND LOWER(status) IN ('active', 'probation', 'notice')
        AND department IS NOT NULL AND department != ''
        AND ($1::int IS NULL OR company_id = $1)
      ORDER BY department
    `, [company_id]);
    return rows.map(r => r.department);
  },
};

export default orgChartRepository;
