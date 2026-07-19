// backend/src/modules/finance/costCenters.routes.js
import express from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';

const router = express.Router();
router.use(requirePermission('finance', 'view'));

const cid = req => companyOf(req) ?? req.scope?.company_id ?? null;

// ── GET /cost-centers ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        cc.*,
        p.name AS parent_name,
        (SELECT COUNT(*) FROM journal_lines jl WHERE jl.cost_center_id = cc.id) AS journal_line_count,
        (SELECT COALESCE(SUM(jl.debit - jl.credit), 0)
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         WHERE jl.cost_center_id = cc.id AND je.status = 'posted'
           AND DATE_TRUNC('month', je.entry_date) = DATE_TRUNC('month', CURRENT_DATE)
        ) AS mtd_net
      FROM cost_centers cc
      LEFT JOIN cost_centers p ON p.id = cc.parent_id
      WHERE cc.company_id = $1
      ORDER BY cc.code
    `, [cid(req)]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /cost-centers ────────────────────────────────────────────────────────
router.post('/', requirePermission('finance', 'add'), async (req, res) => {
  const { code, name, description, parent_id } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'code and name are required' });
  try {
    const { rows: [row] } = await pool.query(`
      INSERT INTO cost_centers (company_id, code, name, description, parent_id)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [cid(req), code.toUpperCase().trim(), name.trim(), description || null, parent_id || null]);
    res.status(201).json(row);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `Cost center code '${code}' already exists` });
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /cost-centers/:id ─────────────────────────────────────────────────────
router.put('/:id', requirePermission('finance', 'edit'), async (req, res) => {
  const { name, description, parent_id, is_active } = req.body;
  try {
    const { rows: [row] } = await pool.query(`
      UPDATE cost_centers
      SET name=$1, description=$2, parent_id=$3, is_active=$4, updated_at=NOW()
      WHERE id=$5 AND company_id=$6 RETURNING *
    `, [name, description || null, parent_id || null,
        is_active !== undefined ? is_active : true,
        req.params.id, cid(req)]);
    if (!row) return res.status(404).json({ error: 'Cost center not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /cost-centers/:id ──────────────────────────────────────────────────
router.delete('/:id', requirePermission('finance', 'delete'), async (req, res) => {
  try {
    const { rows: [linked] } = await pool.query(
      'SELECT COUNT(*) FROM journal_lines WHERE cost_center_id = $1', [req.params.id]
    );
    if (parseInt(linked.count) > 0) {
      return res.status(409).json({ error: 'Cannot delete cost center with existing journal entries. Deactivate instead.' });
    }
    await pool.query('DELETE FROM cost_centers WHERE id=$1 AND company_id=$2', [req.params.id, cid(req)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /cost-centers/:id/pl — Cost Center P&L Report ────────────────────────
router.get('/:id/pl', async (req, res) => {
  const { from_date, to_date } = req.query;
  const now = new Date();
  const fyStart = from_date || `${now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1}-04-01`;
  const fyEnd   = to_date   || `${now.getMonth() >= 3 ? now.getFullYear() + 1 : now.getFullYear()}-03-31`;

  try {
    const { rows: [cc] } = await pool.query(
      'SELECT * FROM cost_centers WHERE id=$1 AND company_id=$2', [req.params.id, cid(req)]
    );
    if (!cc) return res.status(404).json({ error: 'Cost center not found' });

    const { rows } = await pool.query(`
      SELECT
        coa.code,
        coa.name        AS account_name,
        coa.account_type,
        coa.sub_type,
        COALESCE(SUM(jl.debit),  0) AS total_debit,
        COALESCE(SUM(jl.credit), 0) AS total_credit,
        COALESCE(SUM(jl.debit - jl.credit), 0) AS net
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      JOIN chart_of_accounts coa ON coa.id = jl.account_id
      WHERE jl.cost_center_id = $1
        AND je.status = 'posted'
        AND DATE(je.entry_date) BETWEEN $2 AND $3
        AND jl.company_id = $4
      GROUP BY coa.code, coa.name, coa.account_type, coa.sub_type
      ORDER BY coa.account_type, coa.code
    `, [req.params.id, fyStart, fyEnd, cid(req)]);

    const income  = rows.filter(r => r.account_type === 'income');
    const expense = rows.filter(r => r.account_type === 'expense');
    const cogs    = rows.filter(r => r.sub_type === 'cogs');

    const totalIncome  = income.reduce((s, r) => s + parseFloat(r.net), 0);
    const totalCogs    = cogs.reduce((s, r) => s + parseFloat(r.net), 0);
    const totalExpense = expense.reduce((s, r) => s + parseFloat(r.net), 0);
    const grossProfit  = totalIncome - Math.abs(totalCogs);
    const netProfit    = grossProfit - Math.abs(totalExpense);

    res.json({
      cost_center: cc,
      period: { from_date: fyStart, to_date: fyEnd },
      summary: { totalIncome, totalCogs, grossProfit, totalExpense, netProfit },
      income,
      cogs,
      expense,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /cost-centers/pl-summary — All cost centers P&L comparison ────────────
router.get('/pl-summary', async (req, res) => {
  const { from_date, to_date } = req.query;
  const now = new Date();
  const fyStart = from_date || `${now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1}-04-01`;
  const fyEnd   = to_date   || `${now.getMonth() >= 3 ? now.getFullYear() + 1 : now.getFullYear()}-03-31`;
  const companyId = cid(req);

  try {
    const { rows } = await pool.query(`
      SELECT
        cc.id,
        cc.code,
        cc.name,
        COALESCE(SUM(CASE WHEN coa.account_type='income'  THEN jl.credit - jl.debit ELSE 0 END), 0) AS income,
        COALESCE(SUM(CASE WHEN coa.account_type='expense' THEN jl.debit - jl.credit ELSE 0 END), 0) AS expense,
        COALESCE(SUM(CASE WHEN coa.account_type='income'  THEN jl.credit - jl.debit ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN coa.account_type='expense' THEN jl.debit - jl.credit ELSE 0 END), 0) AS net_profit
      FROM cost_centers cc
      LEFT JOIN journal_lines jl ON jl.cost_center_id = cc.id
      LEFT JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'posted'
        AND DATE(je.entry_date) BETWEEN $1 AND $2
      LEFT JOIN chart_of_accounts coa ON coa.id = jl.account_id
      WHERE cc.company_id = $3 AND cc.is_active = true
      GROUP BY cc.id, cc.code, cc.name
      ORDER BY cc.code
    `, [fyStart, fyEnd, companyId]);

    res.json({ period: { from_date: fyStart, to_date: fyEnd }, cost_centers: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
