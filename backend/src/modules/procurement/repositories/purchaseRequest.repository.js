import pool from '../../shared/db.js';
import { nextPurchaseRequestNumber } from '../../../shared/docNumber.js';

// The requisition screen offers exactly these four; anything else is a client
// that has drifted from the UI and must not reach the column, which is a bare
// varchar with no check constraint to catch it.
export const PR_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

/**
 * The status a new requisition is born with.
 *
 * `purchase_requests.status` DEFAULTS to 'pending', but nothing in the product
 * reads that value: the KPI strip, the approvals dashboard count, the status
 * filter and STATUS_META in PurchaseRequest.jsx are all keyed on
 * 'pending_approval'. Leaving the column default to decide meant every
 * requisition raised through the UI landed in a status no screen counted —
 * "Pending Approval: 0" beside a queue that had just been added to, and the row
 * itself rendering under the grey "Draft" chip. Set it explicitly at the
 * INSERT so the column default can never quietly define the workflow again.
 */
export const PR_INITIAL_STATUS = 'pending_approval';

class PurchaseRequestRepository {
  async create(client, data) {
    const {
      request_number, requested_by_employee_id, department_id, department,
      request_date, required_date, notes, company_id, priority, status,
    } = data;
    // priority was collected by the drawer and dropped on the floor here — the
    // column exists, so every "Urgent" request was silently filed as 'medium'.
    const pr = String(priority || 'medium').toLowerCase();
    const result = await client.query(
      `INSERT INTO purchase_requests (request_number, requested_by_employee_id, department_id, department,
                                      request_date, required_date, notes, company_id, priority, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [request_number, requested_by_employee_id ?? null, department_id ?? null, department ?? null,
       request_date, required_date, notes, company_id ?? null,
       PR_PRIORITIES.includes(pr) ? pr : 'medium',
       status || PR_INITIAL_STATUS]
    );
    return result.rows[0];
  }

  /**
   * Raise a requisition on behalf of the system (MRP shortfall, reorder point,
   * BOM explosion) rather than a person filling in the drawer.
   *
   * Four code paths were writing into `purchase_requests` directly and each got
   * the register wrong in its own way:
   *
   *   - production/mrp.routes.js (x2) put the document number in `pr_number`,
   *     the LEGACY column. Procurement reads `request_number`, so those
   *     requisitions appeared in the register with a blank PR number — nothing
   *     to quote in an approval, nothing to search by, nothing to reconcile.
   *   - production/bom.routes.js and production/execution.routes.js minted no
   *     number at all, leaving both columns NULL.
   *   - execution.routes.js additionally passed `actor(req).id`, a users.id,
   *     into `requested_by_employee_id`, which FKs employees(id). Verified live:
   *     that INSERT raises a foreign key violation for any account whose users.id
   *     is not coincidentally a valid employees.id — 55 of the 62 accounts in
   *     this database, including every admin. It sits inside a bare
   *     `catch { /* non-fatal *\/ }`, so the "raise PRs for shortages" action
   *     reported success and created nothing at all.
   *
   * One entry point so a system-raised requisition is a first-class row: a real
   * request_number from the sequence, the canonical initial status, a request
   * date, and a requester that is either a genuine employees.id or NULL. It
   * never invents an actor — `requestedByEmployeeId` must already be an
   * employees.id (use employeeOf()), and NULL is the correct, honest value for
   * something a machine raised.
   */
  async createSystemRequest(client, {
    company_id, item_id = null, item_name, quantity, unit = null,
    estimated_cost = null, required_date = null, notes = null,
    priority = 'medium', requested_by_employee_id = null, status = 'draft',
  }) {
    const requestNumber = await this.getNextNumber(client, company_id ?? null);
    const pr = String(priority || 'medium').toLowerCase();
    const { rows } = await client.query(
      `INSERT INTO purchase_requests
         (request_number, company_id, item_id, item_name, quantity, unit, estimated_cost,
          status, requested_by_employee_id, notes, priority, request_date, required_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CURRENT_DATE,$12) RETURNING *`,
      [requestNumber, company_id ?? null, item_id, item_name, quantity, unit, estimated_cost,
       status, requested_by_employee_id, notes,
       PR_PRIORITIES.includes(pr) ? pr : 'medium', required_date]
    );
    return rows[0];
  }

  async createItem(client, data) {
    const { pr_id, item_id, item_name, quantity, expected_price, required_date, remarks } = data;
    const result = await client.query(
      `INSERT INTO purchase_request_items (pr_id, item_id, item_name, quantity, expected_price, required_date, remarks)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [pr_id, item_id, item_name, quantity, expected_price, required_date, remarks]
    );
    return result.rows[0];
  }

  // Recompute and persist the header total from the current line items.
  // The header total drives amount-based approval routing (L1/L2/CFO) and all
  // PR value reporting — it MUST reflect SUM(quantity * expected_price), never
  // be left at the column default of 0. Call inside the create/edit transaction
  // after the line items have been written.
  async recomputeTotal(client, prId) {
    const db = client ?? pool;
    const result = await db.query(
      `UPDATE purchase_requests
       SET total_amount = COALESCE((
             SELECT SUM(COALESCE(quantity, 0) * COALESCE(expected_price, 0))
             FROM purchase_request_items WHERE pr_id = $1
           ), 0),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING total_amount`,
      [prId]
    );
    return parseFloat(result.rows[0]?.total_amount ?? 0);
  }

  async findAll(filters = {}) {
    const cid = filters.company_id != null ? filters.company_id : null;
    let query = `SELECT pr.*, e.first_name, e.last_name
                 FROM purchase_requests pr
                 LEFT JOIN employees e ON pr.requested_by_employee_id = e.id
                 WHERE pr.deleted_at IS NULL`;
    const params = [];

    // Scope on the requisition's OWN company_id, never on the requester's.
    // `e.company_id` came off a LEFT JOIN, so any PR whose requested_by_employee_id
    // was NULL evaluated `NULL = $1` — false — and vanished from the list. Every
    // PR the app created had a NULL requester (the create route never set one),
    // so the screen showed 4 of 12 rows and a request raised through the drawer
    // was never visible again. pr.company_id is NOT NULL-populated and FKs
    // companies(id), which is what the tenant boundary actually means here.
    if (cid != null) {
      params.push(cid);
      query += ` AND pr.company_id = $${params.length}`;
    }

    if (filters.status) {
      params.push(filters.status);
      query += ` AND pr.status = $${params.length}`;
    }

    if (filters.requested_by) {
      params.push(filters.requested_by);
      query += ` AND pr.requested_by_employee_id = $${params.length}`;
    }

    query += ' ORDER BY pr.request_date DESC';
    const result = await pool.query(query, params);
    return result.rows;
  }

  // companyId is required of every HTTP caller — see the note on
  // purchaseOrder.repository.findById. null means a genuinely global scope.
  async findById(id, companyId = null, client = null) {
    const db = client ?? pool;
    const result = await db.query(
      `SELECT pr.*, e.first_name, e.last_name
       FROM purchase_requests pr
       LEFT JOIN employees e ON pr.requested_by_employee_id = e.id
       WHERE pr.id = $1 AND pr.deleted_at IS NULL
         AND ($2::int IS NULL OR pr.company_id = $2)`,
      [id, companyId]
    );
    return result.rows[0];
  }

  // Pass the active transaction client when reading inside a transaction (e.g.
  // convert-to-po); a pool read would use a different connection/snapshot and
  // silently miss uncommitted rows.
  async getItems(prId, client = null, companyId = null) {
    const db = client ?? pool;
    const result = await db.query(
      `SELECT pri.*, ii.item_code, ii.unit_of_measure
       FROM purchase_request_items pri
       JOIN purchase_requests pr ON pr.id = pri.pr_id
       LEFT JOIN inventory_items ii ON pri.item_id = ii.id
       WHERE pri.pr_id = $1 AND ($2::int IS NULL OR pr.company_id = $2)
       ORDER BY pri.created_at`,
      [prId, companyId]
    );
    return result.rows;
  }

  /**
   * Move a requisition to a new status.
   *
   * `employeeId` must be an employees.id — approved_by FKs employees(id), not
   * users(id) (the recurring stock_ledger.created_by trap). Callers pass
   * req.user.employee_id, never userId.
   *
   * A rejection now persists as much as an approval did. Previously the branch
   * fired only for 'approved', so the userId a rejecting caller passed was
   * silently discarded and `rejection_reason` — a real column — was never
   * written by anything: the register recorded that a PR was rejected but not by
   * whom or why, and the requester had no way to see the reason. approved_by /
   * approved_at are the decision columns the table has; `status` disambiguates
   * which decision they record.
   */
  async updateStatus(client, id, status, employeeId = null, { reason = null, companyId = null } = {}) {
    const sets = ['status = $1', 'updated_at = CURRENT_TIMESTAMP'];
    const params = [status, id];

    if ((status === 'approved' || status === 'rejected') && employeeId) {
      params.push(employeeId);
      sets.push(`approved_by = $${params.length}`, 'approved_at = CURRENT_TIMESTAMP');
    }
    if (status === 'rejected') {
      params.push(reason || null);
      sets.push(`rejection_reason = $${params.length}`);
    }
    params.push(companyId);
    const result = await client.query(
      `UPDATE purchase_requests SET ${sets.join(', ')}
        WHERE id = $2 AND ($${params.length}::int IS NULL OR company_id = $${params.length})
        RETURNING *`,
      params
    );
    return result.rows[0];
  }

  async getNextNumber(client, companyId = null) {
    return nextPurchaseRequestNumber(client, companyId);
  }
}

export default new PurchaseRequestRepository();
