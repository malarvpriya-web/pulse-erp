import pool from '../../shared/db.js';

const orgChartRepository = {
  async upsert(data) {
    const { employee_id, manager_id, department, position_level } = data;
    const result = await pool.query(
      `INSERT INTO org_relationships (employee_id, manager_id, department, position_level)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (employee_id)
       DO UPDATE SET 
         manager_id = $2,
         department = $3,
         position_level = $4,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [employee_id, manager_id, department, position_level]
    );
    return result.rows[0];
  },

  async getHierarchy() {
    const result = await pool.query(`
      SELECT 
        e.id,
        e.name,
        e.email,
        e.designation,
        e.department,
        e.photo,
        org.manager_id,
        org.position_level,
        m.name as manager_name
      FROM employees e
      LEFT JOIN org_relationships org ON e.id = org.employee_id
      LEFT JOIN employees m ON org.manager_id = m.id
      WHERE e.deleted_at IS NULL AND e.status = 'active'
      ORDER BY org.position_level ASC NULLS LAST, e.name
    `);
    return result.rows;
  },

  async getByDepartment(department) {
    const result = await pool.query(`
      SELECT 
        e.id,
        e.name,
        e.email,
        e.designation,
        e.department,
        org.manager_id,
        org.position_level,
        m.name as manager_name
      FROM employees e
      LEFT JOIN org_relationships org ON e.id = org.employee_id
      LEFT JOIN employees m ON org.manager_id = m.id
      WHERE e.deleted_at IS NULL 
        AND e.status = 'active'
        AND e.department = $1
      ORDER BY org.position_level ASC NULLS LAST, e.name
    `, [department]);
    return result.rows;
  },

  async getDirectReports(manager_id) {
    const result = await pool.query(`
      SELECT 
        e.id,
        e.name,
        e.email,
        e.designation,
        e.department,
        org.position_level
      FROM employees e
      JOIN org_relationships org ON e.id = org.employee_id
      WHERE org.manager_id = $1 
        AND e.deleted_at IS NULL 
        AND e.status = 'active'
      ORDER BY e.name
    `, [manager_id]);
    return result.rows;
  },

  async buildTree() {
    const employees = await this.getHierarchy();
    
    // Build tree structure
    const employeeMap = {};
    const tree = [];

    // Create map
    employees.forEach(emp => {
      employeeMap[emp.id] = { ...emp, children: [] };
    });

    // Build tree
    employees.forEach(emp => {
      if (emp.manager_id && employeeMap[emp.manager_id]) {
        employeeMap[emp.manager_id].children.push(employeeMap[emp.id]);
      } else {
        tree.push(employeeMap[emp.id]);
      }
    });

    return tree;
  }
};

export default orgChartRepository;
