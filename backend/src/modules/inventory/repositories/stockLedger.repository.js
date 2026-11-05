import pool from '../../shared/db.js';

class StockLedgerRepository {
  // The company a stock posting belongs to, with its warehouse and every item
  // checked against it — the rule assertParentsInCompany() applies in
  // advancedInventory.repository. Shared by every writer that posts through
  // createEntry() on a caller's behalf (RM issue, stock movement).
  //   companyId: the caller's company, or null for a super admin's global
  //   scope. undefined (a caller that forgot it) throws.
  //   - the warehouse must be in that scope; a global caller gets the
  //     warehouse's own company, and a warehouse with none is refused, because
  //     the posting could not be attributed;
  //   - every item must belong to THAT company. Items are never shared across
  //     companies — a NULL-company item is refused, as it is invisible to
  //     company-scoped reads everywhere else.
  // A foreign row gets the same 404 as a missing one. Items are locked in id
  // order so concurrent postings of the same item serialise on the stock check.
  async resolveStockOwnership(client, { warehouseId, itemIds, companyId }) {
    if (companyId === undefined) {
      throw Object.assign(new Error("resolveStockOwnership() was called without a company scope. Pass the caller's company, or an explicit null for a deliberate global scope."), { status: 500 });
    }
    let scope = null;
    if (companyId !== null) {
      scope = parseInt(String(companyId), 10);
      if (Number.isNaN(scope)) throw Object.assign(new Error('resolveStockOwnership() was given an invalid company scope.'), { status: 500 });
    }
    const wh = parseInt(warehouseId, 10);
    if (!Number.isInteger(wh)) throw Object.assign(new Error('warehouse_id is required'), { status: 422 });
    const ids = [...new Set(itemIds.map(i => parseInt(i, 10)))];
    if (ids.some(i => !Number.isInteger(i))) throw Object.assign(new Error('Every line needs an item_id'), { status: 422 });

    const { rows: [w] } = await client.query(
      `SELECT id, company_id FROM warehouses
        WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
      [wh, scope]);
    if (!w) throw Object.assign(new Error(`Warehouse ${wh} not found`), { status: 404 });
    if (w.company_id == null) {
      throw Object.assign(new Error(`Warehouse ${wh} has no company, so stock posted to it cannot be attributed`), { status: 422 });
    }

    const { rows: found } = await client.query(
      `SELECT id FROM inventory_items
        WHERE id = ANY($1::int[]) AND deleted_at IS NULL AND company_id = $2
        ORDER BY id FOR UPDATE`,
      [ids, w.company_id]);
    const ok = new Set(found.map(r => r.id));
    const missing = ids.find(i => !ok.has(i));
    if (missing !== undefined) throw Object.assign(new Error(`Item ${missing} not found`), { status: 404 });

    return w.company_id;
  }

  getHoldingRate() {
    const parsed = Number.parseFloat(process.env.INVENTORY_HOLDING_COST_RATE ?? '0.18');
    if (!Number.isFinite(parsed) || parsed < 0) return 0.18;
    return parsed;
  }
  async createEntry(client, data) {
    // company_id is optional: a caller that knows the posting's company passes
    // it (the RM issue does); the others still write NULL, as before.
    const { item_id, warehouse_id, transaction_type, quantity_in, quantity_out, rate, reference_type, reference_id, transaction_date, remarks, created_by, company_id = null } = data;
    
    // Get current balance
    const balanceResult = await client.query(
      `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) as balance 
       FROM stock_ledger 
       WHERE item_id = $1 AND warehouse_id = $2`,
      [item_id, warehouse_id]
    );
    
    const currentBalance = parseFloat(balanceResult.rows[0].balance);
    const newBalance = currentBalance + parseFloat(quantity_in || 0) - parseFloat(quantity_out || 0);
    const value = (parseFloat(quantity_in || 0) - parseFloat(quantity_out || 0)) * parseFloat(rate || 0);
    
    const result = await client.query(
      `INSERT INTO stock_ledger (item_id, warehouse_id, transaction_type, quantity_in, quantity_out, balance_qty, rate, value, reference_type, reference_id, transaction_date, remarks, created_by, company_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [item_id, warehouse_id, transaction_type, quantity_in, quantity_out, newBalance, rate, value, reference_type, reference_id, transaction_date, remarks, created_by, company_id]
    );
    
    return result.rows[0];
  }

  async getStockBalance(itemId, warehouseId) {
    const result = await pool.query(
      `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) as balance 
       FROM stock_ledger 
       WHERE item_id = $1 AND warehouse_id = $2`,
      [itemId, warehouseId]
    );
    return parseFloat(result.rows[0].balance);
  }

  async getStockSummary(filters = {}) {
    // Same-company pairing, as in getLowStockItems below. This was a CROSS
    // JOIN with the company filter on the item only, so a ledger row placing
    // company A's item in company B's warehouse surfaced to A under B's
    // warehouse name. The HAVING balance > 0 hid the empty pairs, not that one.
    let query = `SELECT
                  ii.id, ii.item_code, ii.item_name, ii.unit_of_measure, ii.reorder_level,
                  w.id as warehouse_id, w.warehouse_name,
                  COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) as balance,
                  COALESCE(AVG(sl.rate), 0) as avg_rate
                 FROM inventory_items ii
                 JOIN warehouses w ON w.company_id IS NOT DISTINCT FROM ii.company_id
                 LEFT JOIN stock_ledger sl ON ii.id = sl.item_id AND w.id = sl.warehouse_id
                 WHERE ii.deleted_at IS NULL AND w.deleted_at IS NULL`;
    const params = [];

    if (filters.company_id != null) {
      params.push(filters.company_id);
      query += ` AND ii.company_id = $${params.length}`;
    }

    if (filters.item_id) {
      params.push(filters.item_id);
      query += ` AND ii.id = $${params.length}`;
    }

    if (filters.warehouse_id) {
      params.push(filters.warehouse_id);
      query += ` AND w.id = $${params.length}`;
    }

    if (filters.item_type) {
      params.push(filters.item_type);
      query += ` AND ii.item_type = $${params.length}`;
    }
    
    query += ' GROUP BY ii.id, ii.item_code, ii.item_name, ii.unit_of_measure, ii.reorder_level, w.id, w.warehouse_name';
    query += ' HAVING COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) > 0';
    query += ' ORDER BY ii.item_code, w.warehouse_name';
    
    const result = await pool.query(query, params);
    return result.rows;
  }

  async getLowStockItems(company_id = null) {
    const params = [];
    let companyFilter = '';
    if (company_id != null) {
      params.push(company_id);
      companyFilter = ` AND ii.company_id = $${params.length}`;
    }
    // Items are paired only with warehouses of the SAME company. This was a
    // CROSS JOIN, and the company filter applies to the item alone, so company
    // A's items were paired with every other tenant's warehouses. No ledger row
    // can join a pair like that, so its balance is 0 and it always passes the
    // <= reorder_level test: the Low Stock count was inflated with other
    // tenants' rows and showed their warehouse names. IS NOT DISTINCT FROM so a
    // NULL-company item pairs only with a NULL-company warehouse (only reachable
    // with a global scope), not with every tenant.
    const result = await pool.query(
      `SELECT
        ii.id, ii.item_code, ii.item_name, ii.reorder_level,
        w.warehouse_name,
        COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) as balance
       FROM inventory_items ii
       JOIN warehouses w ON w.company_id IS NOT DISTINCT FROM ii.company_id
       LEFT JOIN stock_ledger sl ON ii.id = sl.item_id AND w.id = sl.warehouse_id
       WHERE ii.deleted_at IS NULL AND w.deleted_at IS NULL${companyFilter}
       GROUP BY ii.id, ii.item_code, ii.item_name, ii.reorder_level, w.warehouse_name
       HAVING COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) <= ii.reorder_level
       ORDER BY ii.item_code`,
      params
    );
    return result.rows;
  }

  async getStockMovement(itemId, warehouseId, startDate, endDate) {
    const result = await pool.query(
      `SELECT sl.*, ii.item_code, ii.item_name
       FROM stock_ledger sl
       JOIN inventory_items ii ON sl.item_id = ii.id
       WHERE sl.item_id = $1 AND sl.warehouse_id = $2
       AND sl.transaction_date BETWEEN $3 AND $4
       ORDER BY sl.transaction_date DESC, sl.created_at DESC`,
      [itemId, warehouseId, startDate, endDate]
    );
    return result.rows;
  }

  // Flexible movement query used by dashboard and stock movements list.
  // All params optional; returns fields aliased to what both pages expect.
  async getRecentMovements(filters = {}) {
    const { item_id, warehouse_id, start_date, end_date, search, limit = 50 } = filters;
    const params = [];
    let query = `
      SELECT
        sl.id,
        sl.created_at,
        sl.transaction_date,
        CASE WHEN sl.quantity_in > 0 THEN 'IN' ELSE 'OUT' END        AS movement_type,
        CASE WHEN sl.quantity_in > 0 THEN sl.quantity_in
             ELSE sl.quantity_out END                                  AS quantity,
        sl.remarks                                                     AS reference,
        sl.remarks                                                     AS notes,
        sl.balance_qty,
        sl.rate,
        sl.transaction_type,
        sl.created_by,
        ii.item_code,
        ii.item_name,
        ii.unit_of_measure                                             AS unit
      FROM stock_ledger sl
      JOIN inventory_items ii ON sl.item_id = ii.id
      WHERE 1=1
    `;

    if (item_id)    { params.push(item_id);     query += ` AND sl.item_id      = $${params.length}`; }
    if (warehouse_id) { params.push(warehouse_id); query += ` AND sl.warehouse_id = $${params.length}`; }
    if (start_date) { params.push(start_date);  query += ` AND sl.transaction_date >= $${params.length}`; }
    if (end_date)   { params.push(end_date);    query += ` AND sl.transaction_date <= $${params.length}`; }
    if (search) {
      params.push(`%${search}%`);
      const p = params.length;
      query += ` AND (ii.item_name ILIKE $${p} OR ii.item_code ILIKE $${p} OR sl.remarks ILIKE $${p})`;
    }

    params.push(Math.min(parseInt(limit, 10) || 50, 500));
    query += ` ORDER BY sl.created_at DESC, sl.id DESC LIMIT $${params.length}`;

    const result = await pool.query(query, params);
    return result.rows;
  }

  async getInventoryValuation(warehouseId = null, valuationMethod = 'Weighted Average', companyId = null) {
    // FIFO and FEFO are now REAL, and the method asked for is the method used.
    //
    // This used to accept 'FIFO' and silently return weighted average, with a
    // comment explaining that a layer table did not exist. Returning a different
    // number under the requested label is worse than refusing: the caller cannot
    // tell, and inventory value is a reported financial figure.
    //
    // The layers exist as of migration 20260911000014 and are maintained by
    // postStock(). Valuation prices the REMAINING layers, oldest first (FIFO) or
    // nearest-expiry first (FEFO) — which is the point: the two differ only in
    // which layers are left after issues have been drawn in that order.
    const method = String(valuationMethod || 'Weighted Average');
    const isLayered = method === 'FIFO' || method === 'FEFO';

    if (isLayered) {
      // Tenant predicate first, as in the branch below. This branch had none:
      // a company set to FIFO/FEFO valued every tenant's layers. The item is
      // the owner (as in v_stock_summary), and a layer's warehouse must be the
      // item's company's — a layer with no warehouse stays, since postStock()
      // writes and depletes those.
      const params = [companyId ?? null];
      let whFilter = '';
      if (warehouseId) { params.push(warehouseId); whFilter = ` AND l.warehouse_id = $${params.length}`; }
      const { rows } = await pool.query(`
        SELECT ii.id, ii.item_code, ii.item_name, ii.item_type, ii.hsn_code, ii.gst_rate,
               w.warehouse_name,
               SUM(l.qty_remaining)                        AS balance,
               CASE WHEN SUM(l.qty_remaining) > 0
                    THEN SUM(l.qty_remaining * l.unit_cost) / SUM(l.qty_remaining)
                    ELSE 0 END                             AS avg_rate,
               SUM(l.qty_remaining * l.unit_cost)          AS value,
               COUNT(*)::int                               AS layer_count
          FROM inventory_fifo_layers l
          JOIN inventory_items ii ON ii.id = l.item_id
          LEFT JOIN warehouses w  ON w.id = l.warehouse_id
         WHERE l.qty_remaining > 0 AND ii.deleted_at IS NULL
           AND ($1::INTEGER IS NULL OR ii.company_id = $1)
           AND (l.warehouse_id IS NULL OR w.company_id IS NOT DISTINCT FROM ii.company_id)${whFilter}
         GROUP BY ii.id, ii.item_code, ii.item_name, ii.item_type, ii.hsn_code, ii.gst_rate, w.warehouse_name
         ORDER BY value DESC`, params);

      const annualRate = this.getHoldingRate();
      return rows.map((row) => {
        const value = Number.parseFloat(row.value || 0);
        return {
          ...row,
          balance: Number.parseFloat(row.balance || 0),
          avg_rate: Number.parseFloat(row.avg_rate || 0),
          value,
          valuation_method: method,
          annual_holding_cost: Math.round(value * annualRate * 100) / 100,
        };
      });
    }

    // Standard Cost uses item.standard_cost instead of ledger AVG(rate).
    const useStandardCost = method === 'Standard Cost';

    // A weighted average has to be weighted by QUANTITY. This was
    // AVG(NULLIF(sl.rate, 0)) — the unweighted mean of the rates on the ledger
    // rows — which prices a 1-unit receipt at 1,000 and a 1,000-unit receipt
    // at 10 as 505/unit instead of the true 10.99. Receipts are the correct
    // weight: issues leave at the running average, they do not reprice what
    // remains.
    const rateExpr = useStandardCost
      ? 'COALESCE(ii.standard_cost, 0)'
      : 'COALESCE(SUM(sl.quantity_in * sl.rate) / NULLIF(SUM(sl.quantity_in), 0), 0)';

    let query = `SELECT
                  ii.id, ii.item_code, ii.item_name, ii.item_type,
                  ii.hsn_code, ii.gst_rate,
                  w.warehouse_name,
                  COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0)           AS balance,
                  ${rateExpr}                                                   AS avg_rate,
                  COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) * ${rateExpr} AS value
                 FROM inventory_items ii
                 JOIN warehouses w ON w.company_id IS NOT DISTINCT FROM ii.company_id
                 LEFT JOIN stock_ledger sl ON ii.id = sl.item_id AND w.id = sl.warehouse_id
                 WHERE ii.deleted_at IS NULL AND w.deleted_at IS NULL
                   AND ($1::INTEGER IS NULL OR ii.company_id = $1)`;
    // Tenant predicate first, so every later $n stays positional. Without it
    // this priced every company's stock into one caller's valuation.
    // Same-company pairing, as in getStockSummary: the predicate above is on
    // the item only, so a ledger row placing A's item in B's warehouse was
    // valued for A under B's warehouse name.
    const params = [companyId ?? null];

    if (warehouseId) {
      params.push(warehouseId);
      query += ` AND w.id = $${params.length}`;
    }

    query += ` GROUP BY ii.id, ii.item_code, ii.item_name, ii.item_type, ii.hsn_code, ii.gst_rate, ii.standard_cost, w.warehouse_name`;
    query += ' HAVING COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) > 0';
    query += ' ORDER BY value DESC';

    const result = await pool.query(query, params);
    const annualRate = this.getHoldingRate();
    return result.rows.map((row) => {
      const value = Number.parseFloat(row.value || 0);
      const annualHoldingCost = value * annualRate;
      return {
        ...row,
        valuation_method: valuationMethod,
        holding_cost_rate_annual: annualRate,
        holding_cost_annual: annualHoldingCost,
        holding_cost_monthly: annualHoldingCost / 12,
      };
    });
  }
}

export default new StockLedgerRepository();
