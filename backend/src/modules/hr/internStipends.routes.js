/**
 * Intern stipend payments — HR audit 2026-11-16 (11-03 F-22).
 * Mounted at /intern-stipends. Table: intern_stipend_payments (migration 20261116000009).
 *
 * An intern's stipend was stored and never paid: nothing read it. The flow now:
 *   GET    /?month=YYYY-MM          the month's dues and payments
 *                                   internships:view, or payroll_payment:approve (Finance)
 *   POST   /generate {month}        raise the dues for every intern who worked
 *                                   that month (internships:edit). Idempotent:
 *                                   an intern already raised for the month is skipped.
 *   PATCH  /:id {amount, reason}    correct a due amount, with a reason (internships:edit)
 *   POST   /:id/cancel {reason}     cancel a due (internships:edit)
 *   POST   /:id/pay {utr, value_date, bank_account_id}
 *                                   Finance records the payment (payroll_payment:approve),
 *                                   never the person who raised the due.
 *
 * Amount for a month (pro-rated by calendar days the internship covers in it):
 *   Monthly  stipend × covered days / days in month
 *   Weekly   stipend × covered days / 7
 *   One-time stipend, in the month the internship starts, once
 *   Unpaid / no stipend → nothing raised
 * Rounded to whole rupees. The window is start_date … end_date (completed_on
 * when completed); interns Active, Completed or Terminated are counted.
 *
 * NOT done here: no accounting journal is posted. Finance books the stipend
 * expense in Accounting; this register is the payment record (UTR, date, bank).
 */
import express from 'express';
import pool from '../../config/db.js';
import { requirePermission, can } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';
import { logAudit } from '../../services/AuditService.js';

const router = express.Router();

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const UTR_RE = /^[A-Za-z0-9]{6,35}$/;
const PAID_STATUSES = ['Active', 'Completed', 'Terminated'];

function company(req, res) {
  const cid = companyOf(req);
  if (cid == null) { res.status(403).json({ error: 'No company context for this login' }); return null; }
  return cid;
}
const monthStart = (m) => `${m}-01`;

async function canRead(req) {
  return (await can(req, 'internships', 'view')) || (await can(req, 'payroll_payment', 'approve'));
}

/** The due for one intern in one month, or null when nothing is owed. Pure. */
export function stipendDue(intern, month) {
  const stipend = Number(intern.stipend);
  const freq = intern.stipend_frequency;
  if (!(stipend > 0) || !freq || freq === 'Unpaid') return null;
  const [y, m] = month.split('-').map(Number);
  const first = Date.UTC(y, m - 1, 1);
  const last = Date.UTC(y, m, 0);
  const daysInMonth = new Date(last).getUTCDate();
  const day = (d) => (d ? Date.UTC(Number(String(d).slice(0, 4)), Number(String(d).slice(5, 7)) - 1, Number(String(d).slice(8, 10))) : null);
  const start = day(intern.start_date);
  const end = day(intern.status === 'Completed' && intern.completed_on ? intern.completed_on : intern.end_date);
  if (start == null) return null;
  const from = Math.max(first, start);
  const to = Math.min(last, end ?? last);
  if (to < from) return null;
  const covered = Math.round((to - from) / 86400000) + 1;
  if (freq === 'One-time') {
    if (start < first || start > last) return null;
    return { amount: Math.round(stipend), basis: `One-time stipend ₹${stipend}` };
  }
  if (freq === 'Weekly') {
    return { amount: Math.round(stipend * covered / 7), basis: `₹${stipend}/week × ${covered} days ÷ 7` };
  }
  // Monthly
  return covered === daysInMonth
    ? { amount: Math.round(stipend), basis: `₹${stipend}/month, full month` }
    : { amount: Math.round(stipend * covered / daysInMonth), basis: `₹${stipend}/month × ${covered} of ${daysInMonth} days` };
}

router.get('/', async (req, res) => {
  const cid = company(req, res); if (cid == null) return;
  if (!(await canRead(req))) return res.status(403).json({ error: 'You do not have permission to perform this action.' });
  const month = String(req.query.month || '');
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  try {
    const { rows } = await pool.query(
      `SELECT p.*, i.intern_code, TRIM(CONCAT(i.first_name, ' ', COALESCE(i.last_name, ''))) AS intern_name,
              i.department, i.stipend, i.stipend_frequency,
              i.bank_account_holder, i.bank_name, i.bank_ifsc,
              RIGHT(i.bank_account_number, 4) AS account_last4,
              cu.name AS created_by_name, pu.name AS paid_by_name, b.account_name AS paid_from
         FROM intern_stipend_payments p
         JOIN interns i ON i.id = p.intern_id
         LEFT JOIN users cu ON cu.id = p.created_by
         LEFT JOIN users pu ON pu.id = p.paid_by
         LEFT JOIN bank_accounts b ON b.id = p.bank_account_id
        WHERE p.company_id = $1 AND p.period_month = $2::date
        ORDER BY i.intern_code`, [cid, monthStart(month)]);
    res.json({
      month, rows,
      can_raise: await can(req, 'internships', 'edit'),
      can_pay: await can(req, 'payroll_payment', 'approve'),
      me: req.user?.userId ?? null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/generate', requirePermission('internships', 'edit'), async (req, res) => {
  const cid = company(req, res); if (cid == null) return;
  const month = String(req.body?.month || '');
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  try {
    const { rows: interns } = await pool.query(
      `SELECT i.id, i.intern_code, i.stipend, i.stipend_frequency, i.status,
              to_char(i.start_date, 'YYYY-MM-DD') AS start_date, to_char(i.end_date, 'YYYY-MM-DD') AS end_date,
              to_char(i.completed_on, 'YYYY-MM-DD') AS completed_on,
              EXISTS (SELECT 1 FROM intern_stipend_payments x
                       WHERE x.intern_id = i.id AND x.status <> 'cancelled') AS has_any
         FROM interns i
        WHERE i.company_id = $1 AND i.status = ANY($2::text[])`, [cid, PAID_STATUSES]);
    let raised = 0; const skipped = [];
    for (const it of interns) {
      const due = stipendDue(it, month);
      if (!due) continue;
      if (it.stipend_frequency === 'One-time' && it.has_any) { skipped.push(`${it.intern_code}: one-time stipend already raised`); continue; }
      const { rowCount } = await pool.query(
        `INSERT INTO intern_stipend_payments (company_id, intern_id, period_month, amount, computed_amount, basis, created_by)
         VALUES ($1, $2, $3::date, $4, $4, $5, $6)
         ON CONFLICT (intern_id, period_month) DO NOTHING`,
        [cid, it.id, monthStart(month), due.amount, due.basis, req.user?.userId ?? null]);
      if (rowCount) raised += 1; else skipped.push(`${it.intern_code}: already raised for ${month}`);
    }
    logAudit({ userId: req.user?.userId, module: 'internships', recordType: 'intern_stipend', recordId: month,
      action: 'generate', newData: { month, raised, skipped }, req });
    res.json({ month, raised, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function dueRow(client, id, cid, lock = false) {
  const { rows: [row] } = await client.query(
    `SELECT * FROM intern_stipend_payments WHERE id = $1 AND company_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [id, cid]);
  return row || null;
}

router.patch('/:id', requirePermission('internships', 'edit'), async (req, res) => {
  const cid = company(req, res); if (cid == null) return;
  const id = Number(req.params.id);
  const amount = Number(req.body?.amount);
  const reason = String(req.body?.reason || '').trim();
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  if (!Number.isFinite(amount) || amount < 0 || amount > 10000000) return res.status(400).json({ error: 'Amount must be 0 or more.' });
  if (reason.length < 5) return res.status(400).json({ error: 'Give a reason for the change (at least 5 characters).' });
  try {
    const row = await dueRow(pool, id, cid);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.status !== 'due') return res.status(409).json({ error: `This stipend is ${row.status}; it can no longer change.` });
    const { rows: [after] } = await pool.query(
      `UPDATE intern_stipend_payments SET amount = $3, adjust_reason = $4 WHERE id = $1 AND company_id = $2 AND status = 'due' RETURNING *`,
      [id, cid, Math.round(amount * 100) / 100, reason]);
    logAudit({ userId: req.user?.userId, module: 'internships', recordType: 'intern_stipend', recordId: id, action: 'adjust', oldData: row, newData: after, req });
    res.json(after);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/cancel', requirePermission('internships', 'edit'), async (req, res) => {
  const cid = company(req, res); if (cid == null) return;
  const id = Number(req.params.id);
  const reason = String(req.body?.reason || '').trim();
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  if (reason.length < 5) return res.status(400).json({ error: 'Give a reason (at least 5 characters).' });
  try {
    const row = await dueRow(pool, id, cid);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.status !== 'due') return res.status(409).json({ error: `This stipend is ${row.status}.` });
    const { rows: [after] } = await pool.query(
      `UPDATE intern_stipend_payments SET status = 'cancelled', cancel_reason = $3 WHERE id = $1 AND company_id = $2 AND status = 'due' RETURNING *`,
      [id, cid, reason]);
    logAudit({ userId: req.user?.userId, module: 'internships', recordType: 'intern_stipend', recordId: id, action: 'cancel', oldData: row, newData: after, req });
    res.json(after);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/pay', requirePermission('payroll_payment', 'approve'), async (req, res) => {
  const cid = company(req, res); if (cid == null) return;
  const id = Number(req.params.id);
  const utr = String(req.body?.utr || '').trim().toUpperCase();
  const valueDate = String(req.body?.value_date || '');
  const bankId = Number(req.body?.bank_account_id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  if (!UTR_RE.test(utr)) return res.status(400).json({ code: 'UTR_REQUIRED', error: 'A bank transaction reference (UTR) is required: 6-35 letters or digits.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valueDate)) return res.status(400).json({ code: 'VALUE_DATE_REQUIRED', error: 'The bank value date is required.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await dueRow(client, id, cid, true);
    if (!row) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    if (row.status !== 'due') { await client.query('ROLLBACK'); return res.status(409).json({ error: `This stipend is already ${row.status}.` }); }
    if (row.created_by != null && Number(row.created_by) === Number(req.user?.userId)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'SELF_PAYMENT', error: 'The person who raised this stipend cannot record its payment.' });
    }
    if (!(Number(row.amount) > 0)) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Nothing to pay on a zero amount; cancel it instead.' }); }
    const { rows: [today] } = await client.query(`SELECT CURRENT_DATE::text AS d`);
    if (valueDate > today.d) { await client.query('ROLLBACK'); return res.status(400).json({ code: 'VALUE_DATE_FUTURE', error: 'The value date cannot be in the future.' }); }
    const { rows: [bank] } = await client.query(
      `SELECT id FROM bank_accounts WHERE id = $1 AND company_id = $2 AND is_active = true AND deleted_at IS NULL`, [bankId, cid]);
    if (!bank) { await client.query('ROLLBACK'); return res.status(422).json({ code: 'BANK_ACCOUNT_INVALID', error: 'Choose an active bank account of this company.' }); }
    const { rows: [intern] } = await client.query(
      `SELECT bank_account_number, bank_ifsc FROM interns WHERE id = $1`, [row.intern_id]);
    if (!/^\d{9,18}$/.test(intern?.bank_account_number || '') || !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(intern?.bank_ifsc || '')) {
      await client.query('ROLLBACK');
      return res.status(422).json({ code: 'INTERN_BANK_INVALID', error: "The intern's bank account or IFSC is missing or not valid. HR corrects it on the intern record first." });
    }
    const { rows: [dupe] } = await client.query(
      `SELECT 1 FROM intern_stipend_payments WHERE company_id = $1 AND utr = $2 AND id <> $3`, [cid, utr, id]);
    if (dupe) { await client.query('ROLLBACK'); return res.status(409).json({ code: 'UTR_USED', error: 'This bank reference is already recorded against another stipend.' }); }
    const { rows: [after] } = await client.query(
      `UPDATE intern_stipend_payments
          SET status = 'paid', paid_by = $3, paid_at = NOW(), utr = $4, value_date = $5::date, bank_account_id = $6
        WHERE id = $1 AND company_id = $2 RETURNING *`,
      [id, cid, req.user?.userId ?? null, utr, valueDate, bank.id]);
    await client.query('COMMIT');
    logAudit({ userId: req.user?.userId, module: 'internships', recordType: 'intern_stipend', recordId: id, action: 'pay', oldData: row, newData: after, req });
    res.json(after);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

export default router;
