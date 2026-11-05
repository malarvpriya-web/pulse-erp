import pool from '../../shared/db.js';
import { nextRmIssueNumber } from '../../../shared/docNumber.js';
import stockLedgerRepo from './stockLedger.repository.js';

// Tenant scope for the reads below. An issue belongs to the company of the
// warehouse it was issued from. create() now writes rm_issues.company_id, but
// every issue made before that has it NULL, so filtering on it would hide each
// company's own older issues.
//
// undefined (a caller that forgot the scope) THROWS rather than reading every
// tenant; an explicit null is a deliberate global scope, which the routes pass
// only for a super admin. Same contract as advancedInventory.repository.js.
function requireScope(companyId, fnName) {
  if (companyId === undefined) {
    throw Object.assign(
      new Error(`${fnName}() was called without a company scope. Pass the caller's company, ` +
                `or an explicit null for a deliberate global scope.`),
      { status: 500 });
  }
  if (companyId === null) return null;
  const v = parseInt(String(companyId), 10);
  if (Number.isNaN(v)) {
    throw Object.assign(new Error(`${fnName}() was given an invalid company scope.`), { status: 500 });
  }
  return v;
}

class RMIssueRepository {
  // company_id is the issuing warehouse's company, resolved by
  // resolveIssueOwnership() in the same transaction. It used to be left out, so
  // every issue made through the app had a NULL company.
  async create(client, data) {
    const { issue_number, department_id, issued_by, issue_date, warehouse_id, purpose, notes, company_id } = data;
    const result = await client.query(
      `INSERT INTO rm_issues (issue_number, department_id, issued_by, issue_date, warehouse_id, purpose, notes, company_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [issue_number, department_id, issued_by, issue_date, warehouse_id, purpose, notes, company_id]
    );
    return result.rows[0];
  }

  // The company a new issue belongs to: the issuing warehouse's, with every
  // item checked against it. One rule for every stock writer, so it lives in
  // stockLedger.repository (resolveStockOwnership).
  async resolveIssueOwnership(client, { warehouseId, itemIds, companyId }) {
    requireScope(companyId, 'resolveIssueOwnership');
    return stockLedgerRepo.resolveStockOwnership(client, { warehouseId, itemIds, companyId });
  }

  // department_id and issued_by, checked against the issue's company (the one
  // resolveIssueOwnership() returned). Both are optional: absent, null or ''
  // stores NULL, as before. Returns the values to store.
  //   - issued_by is an employee of that company, not deleted (the rule
  //     exit.routes.js applies). A NULL-company employee is not shared.
  //   - department_id is a master_departments id. That master is SHARED — no
  //     company column — so there is no other company's department to refuse;
  //     it must exist and be active, as departmentHeads.service and
  //     validateMasterValue() require of a new reference.
  // A foreign or missing row gets the same 404.
  async resolveIssueParties(client, { departmentId, issuedBy, companyId }) {
    const toId = (v, field) => {
      if (v === undefined || v === null || v === '') return null;
      const s = String(v).trim();
      if (!/^\d+$/.test(s) || Number(s) < 1 || Number(s) > 2147483647) {
        throw Object.assign(new Error(`${field} must be a positive whole number`), { status: 422 });
      }
      return Number(s);
    };
    const department = toId(departmentId, 'department_id');
    const employee = toId(issuedBy, 'issued_by');
    const scope = requireScope(companyId, 'resolveIssueParties');
    if (scope === null) throw Object.assign(new Error('resolveIssueParties() needs the issue\'s company'), { status: 500 });

    if (employee !== null) {
      const { rows } = await client.query(
        `SELECT 1 FROM employees WHERE id = $1 AND deleted_at IS NULL AND company_id = $2`,
        [employee, scope]);
      if (!rows[0]) throw Object.assign(new Error(`Employee ${employee} not found`), { status: 404 });
    }
    if (department !== null) {
      const { rows: [d] } = await client.query(
        `SELECT name, is_active FROM master_departments WHERE id = $1`, [department]);
      if (!d) throw Object.assign(new Error(`Department ${department} not found`), { status: 404 });
      if (!d.is_active) {
        throw Object.assign(new Error(`Department "${d.name}" is inactive in Master Data`), { status: 422 });
      }
    }
    return { department_id: department, issued_by: employee };
  }

  async createItem(client, data) {
    const { issue_id, item_id, quantity, rate, remarks } = data;
    const result = await client.query(
      `INSERT INTO rm_issue_items (issue_id, item_id, quantity, rate, remarks) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [issue_id, item_id, quantity, rate, remarks]
    );
    return result.rows[0];
  }

  async findAll(filters = {}, companyId) {
    let query = `SELECT ri.*, w.warehouse_name 
                 FROM rm_issues ri
                 JOIN warehouses w ON ri.warehouse_id = w.id
                 WHERE ri.deleted_at IS NULL
                   AND ($1::int IS NULL OR w.company_id = $1)`;
    const params = [requireScope(companyId, 'findAll')];
    
    if (filters.department_id) {
      params.push(filters.department_id);
      query += ` AND ri.department_id = $${params.length}`;
    }
    
    query += ' ORDER BY ri.issue_date DESC';
    const result = await pool.query(query, params);
    return result.rows;
  }

  // Absent and foreign issues look the same (undefined), so a route turns both
  // into a 404 and never reaches getItems() for another company's issue.
  async findByIdInCompany(id, companyId) {
    const result = await pool.query(
      `SELECT ri.*, w.warehouse_name 
       FROM rm_issues ri
       JOIN warehouses w ON ri.warehouse_id = w.id
       WHERE ri.id = $1 AND ri.deleted_at IS NULL
         AND ($2::int IS NULL OR w.company_id = $2)`,
      [id, requireScope(companyId, 'findByIdInCompany')]
    );
    return result.rows[0];
  }

  async getItems(issueId) {
    const result = await pool.query(
      `SELECT rii.*, ii.item_code, ii.item_name, ii.unit_of_measure 
       FROM rm_issue_items rii
       JOIN inventory_items ii ON rii.item_id = ii.id
       WHERE rii.issue_id = $1 ORDER BY rii.created_at`,
      [issueId]
    );
    return result.rows;
  }

  async getNextNumber(client) {
    return nextRmIssueNumber(client);
  }

  // LEFT JOIN so a global scope still counts an issue whose warehouse was
  // removed (warehouse_id is ON DELETE SET NULL), as it did before; a company
  // scope cannot claim such an issue, so it drops out there.
  async getConsumptionTrends(startDate, endDate, companyId) {
    const result = await pool.query(
      `SELECT 
        ii.item_code, ii.item_name, ii.item_type,
        SUM(rii.quantity) as total_consumed,
        COUNT(DISTINCT ri.id) as issue_count,
        AVG(rii.quantity) as avg_quantity
       FROM rm_issue_items rii
       JOIN rm_issues ri ON rii.issue_id = ri.id
       JOIN inventory_items ii ON rii.item_id = ii.id
       LEFT JOIN warehouses w ON w.id = ri.warehouse_id
       WHERE ri.issue_date BETWEEN $1 AND $2
       AND ri.deleted_at IS NULL
       AND ($3::int IS NULL OR w.company_id = $3)
       GROUP BY ii.item_code, ii.item_name, ii.item_type
       ORDER BY total_consumed DESC`,
      [startDate, endDate, requireScope(companyId, 'getConsumptionTrends')]
    );
    return result.rows;
  }
}

export default new RMIssueRepository();
