import express from 'express';
import pool from '../db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import bankAccountRepo, { hasChartAccountLink } from '../repositories/bankAccount.repository.js';
import paymentBatchRepo from '../repositories/paymentBatch.repository.js';
import paymentBatchService from '../services/paymentBatch.service.js';
import ticketRepo from '../repositories/ticket.repository.js';
import financialRatiosService from '../services/financialRatios.service.js';
import { companyOf } from '../../../shared/scope.js';
import {
  getJournalEntries,
  createJournalEntry,
  getPeriods,
  closePeriod,
  reopenPeriod,
  getCFODashboard,
} from '../finance.controller.js';

const router = express.Router();

// Bootstrap missing bank_accounts columns
pool.query(`
  ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS current_balance NUMERIC(14,2) DEFAULT 0;
  ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ;
  ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS company_id INTEGER;
`).catch(() => {});

// =====================================================
// BANK ACCOUNTS
// =====================================================
router.post('/bank-accounts', requirePermission('finance', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cid = getCompanyId(req);
    const uid = req.user?.userId ?? req.user?.id ?? null;

    // Store last 4 digits for display; backend never returns the raw account_number
    const rawNum = (req.body.account_number || '').replace(/\D/g, '');
    const last4  = rawNum.length >= 4 ? rawNum.slice(-4) : rawNum || null;

    const account = await bankAccountRepo.create({
      ...req.body,
      company_id:          cid,
      account_number_last4: last4,
    });

    // Create opening balance journal entry if opening_balance > 0
    const openingBalance = parseFloat(req.body.opening_balance || 0);
    if (openingBalance > 0) {
      // Look up CoA accounts: Bank (1002) and Opening Balance Equity (3001)
      const { rows: coaRows } = await client.query(
        `SELECT id, code FROM chart_of_accounts WHERE code IN ('1002','3001') AND is_active = true`
      );
      const coaMap = Object.fromEntries(coaRows.map(r => [r.code, r.id]));
      const bankCoaId   = coaMap['1002'] ?? null;
      const equityCoaId = coaMap['3001'] ?? null;

      if (bankCoaId && equityCoaId) {
        const year = new Date().getFullYear();
        // Derive the next JE number from MAX(id)+1 (same pattern as credit/debit
        // note posting). The previous code referenced a non-existent sequence
        // (seq_accounting_je) with a .catch() fallback that never worked — inside
        // an open transaction the failed statement poisons it, so the fallback
        // query errored too and the whole save rolled back with a 500.
        const { rows: [{ nextval }] } = await client.query(
          `SELECT COALESCE(MAX(id),0)+1 AS nextval FROM journal_entries`
        );
        const entryNumber = `JE-${year}-${String(nextval).padStart(5, '0')}`;
        const entryDate   = req.body.opening_date || new Date().toISOString().split('T')[0];

        const { rows: [je] } = await client.query(
          `INSERT INTO journal_entries
             (entry_number, entry_date, entry_type, description, reference_type, reference_id,
              status, total_debit, total_credit, company_id, created_by)
           VALUES ($1, $2, 'OpeningBalance', $3, 'bank_account', $4, 'posted', $5, $5, $6, $7)
           RETURNING id`,
          [
            entryNumber,
            entryDate,
            `Opening balance — ${account.account_name}`,
            account.id,
            openingBalance,
            cid,
            uid,
          ]
        );

        await client.query(
          `INSERT INTO journal_lines
             (entry_id, account_id, account_code, account_name, debit, credit, narration, company_id)
           VALUES
             ($1, $2, '1002', 'Bank Accounts',          $3,  0, $4, $5),
             ($1, $6, '3001', 'Opening Balance Equity', 0,  $3, $4, $5)`,
          [
            je.id,
            bankCoaId,
            openingBalance,
            `Opening balance — ${account.account_name}`,
            cid,
            equityCoaId,
          ]
        );
      }
    }

    await client.query('COMMIT');

    // Return account without raw account_number
    const { account_number: _omit, ...safeAccount } = account;
    res.status(201).json(safeAccount);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

router.get('/bank-accounts', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const accounts = await bankAccountRepo.findAll({ ...req.query, company_id: getCompanyId(req) });
    res.json(accounts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// KPI summary — must be registered before /:id to avoid route conflict
router.get('/bank-accounts/summary', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const params    = companyId != null ? [companyId] : [];
    const cidSQL    = companyId != null ? 'AND ba.company_id = $1' : '';

    // Derive the ledger book balance only when the schema supports the GL link;
    // otherwise sum the stored current_balance (legacy schema).
    const linked = await hasChartAccountLink();
    const totalCashExpr = linked
      ? `COALESCE(SUM(
            CASE WHEN ba.chart_account_id IS NOT NULL
                 THEN COALESCE(coa.opening_balance, 0) + COALESCE(glm.mv, 0)
                 ELSE COALESCE(ba.current_balance, 0) END
          ), 0)::numeric`
      : `COALESCE(SUM(ba.current_balance), 0)::numeric`;
    const totalCashJoins = linked
      ? `LEFT JOIN chart_of_accounts coa ON coa.id = ba.chart_account_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS mv
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id
           WHERE jl.account_id = ba.chart_account_id
             AND je.status = 'posted'
             AND je.entry_date <= CURRENT_DATE
         ) glm ON true`
      : '';

    const [acctRow, txnRow] = await Promise.all([
      pool.query(`
        SELECT
          ${totalCashExpr}                           AS total_cash_bank,
          COUNT(*)::int                              AS account_count,
          COUNT(CASE WHEN last_reconciled_at IS NULL
                       OR last_reconciled_at < CURRENT_DATE - 30 THEN 1 END)::int AS unreconciled_count
        FROM bank_accounts ba
        ${totalCashJoins}
        WHERE ba.is_active = true AND ba.deleted_at IS NULL ${cidSQL}
      `, params),
      pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN bt.transaction_type = 'Credit' THEN bt.amount ELSE 0 END), 0)::numeric AS inflow_mtd,
          COALESCE(SUM(CASE WHEN bt.transaction_type = 'Debit'  THEN bt.amount ELSE 0 END), 0)::numeric AS outflow_mtd
        FROM bank_transactions bt
        JOIN bank_accounts ba ON ba.id = bt.bank_account_id
        WHERE ba.is_active = true AND ba.deleted_at IS NULL
          AND DATE_TRUNC('month', bt.transaction_date) = DATE_TRUNC('month', CURRENT_DATE)
          ${cidSQL}
      `, params),
    ]);

    res.json({ ...acctRow.rows[0], ...txnRow.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/bank-accounts/:id', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const account = await bankAccountRepo.findById(req.params.id);
    if (!account) return res.status(404).json({ error: 'Bank account not found' });
    res.json(account);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/bank-accounts/:id', requirePermission('finance', 'edit'), async (req, res) => {
  try {
    const account = await bankAccountRepo.update(req.params.id, req.body);
    if (!account) return res.status(404).json({ error: 'Bank account not found' });
    res.json(account);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/bank-accounts/:id', requirePermission('finance', 'delete'), async (req, res) => {
  try {
    const account = await bankAccountRepo.softDelete(req.params.id);
    res.json({ success: true, account });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/bank-accounts/:id/transactions', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const end = req.query.end_date || new Date().toISOString().split('T')[0];
    const start = req.query.start_date || new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];
    const transactions = await bankAccountRepo.getTransactions(req.params.id, start, end);
    res.json(transactions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/bank-accounts/:id/unreconciled', async (req, res) => {
  try {
    const transactions = await bankAccountRepo.getUnreconciledTransactions(req.params.id);
    res.json(transactions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/bank-accounts/:id/statement-lines', async (req, res) => {
  try {
    const lines = await bankAccountRepo.getStatementLines(req.params.id);
    res.json(lines);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/bank-accounts/:id/statement-lines', async (req, res) => {
  try {
    const lines = await bankAccountRepo.importStatementLines(req.params.id, req.body.lines || []);
    res.status(201).json(lines);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/bank-accounts/:id/auto-match', async (req, res) => {
  try {
    const result = await bankAccountRepo.autoMatch(req.params.id);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/bank-accounts/:id/manual-match', async (req, res) => {
  try {
    const { statement_line_id, transaction_id } = req.body;
    const result = await bankAccountRepo.manualMatch(statement_line_id, transaction_id);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/bank-accounts/:id/reconcile', async (req, res) => {
  try {
    const account = await bankAccountRepo.completeReconciliation(req.params.id);
    res.json(account);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// PAYMENT BATCHES
// =====================================================
router.post('/payment-batches', requirePermission('finance', 'write'), async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const uid = req.user?.userId ?? req.user?.id;
    const batch = await paymentBatchService.createBatch({ ...req.body, company_id: cid }, uid);
    res.status(201).json(batch);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/payment-batches', async (req, res) => {
  try {
    const batches = await paymentBatchService.getBatches({
      ...req.query,
      company_id: getCompanyId(req),
    });
    res.json(batches);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/payment-batches/summary', async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const cidFilter = cid != null ? `AND pb.company_id = ${parseInt(cid, 10)}` : '';
    const result = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN pb.status = 'processed'
          AND EXTRACT(YEAR FROM pb.processed_at) = EXTRACT(YEAR FROM CURRENT_DATE)
          THEN pb.total_amount END), 0)  AS processed_ytd,
        COUNT(CASE WHEN pb.status = 'processed'
          AND EXTRACT(YEAR FROM pb.processed_at) = EXTRACT(YEAR FROM CURRENT_DATE)
          THEN 1 END)                    AS processed_ytd_count,
        COALESCE(SUM(CASE WHEN pb.status = 'pending_approval'
          THEN pb.total_amount END), 0)  AS pending_approval,
        COUNT(CASE WHEN pb.status = 'pending_approval' THEN 1 END) AS pending_count,
        COALESCE(SUM(CASE WHEN pb.status = 'approved'
          THEN pb.total_amount END), 0)  AS approved_ready,
        COUNT(CASE WHEN pb.status = 'approved'  THEN 1 END) AS approved_count,
        COUNT(CASE WHEN pb.status = 'draft'     THEN 1 END) AS draft_count
      FROM payment_batches pb
      WHERE 1=1 ${cidFilter}
    `);
    const row = result.rows[0] || {};
    res.json({
      processed_ytd:       parseFloat(row.processed_ytd       || 0),
      processed_ytd_count: parseInt(row.processed_ytd_count   || 0),
      pending_approval:    parseFloat(row.pending_approval     || 0),
      pending_count:       parseInt(row.pending_count          || 0),
      approved_ready:      parseFloat(row.approved_ready       || 0),
      approved_count:      parseInt(row.approved_count         || 0),
      draft_count:         parseInt(row.draft_count            || 0),
    });
  } catch (error) {
    res.json({ processed_ytd: 0, processed_ytd_count: 0, pending_approval: 0, pending_count: 0, approved_ready: 0, approved_count: 0, draft_count: 0 });
  }
});

router.get('/payment-batches/:id', async (req, res) => {
  try {
    const batch = await paymentBatchService.getBatchById(req.params.id);
    if (!batch) return res.status(404).json({ error: 'Payment batch not found' });
    res.json(batch);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/payment-batches/:id/submit', requirePermission('finance', 'write'), async (req, res) => {
  try {
    const batch = await paymentBatchService.submitForApproval(req.params.id);
    res.json(batch);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/payment-batches/:id/approve', requirePermission('finance', 'approve'), async (req, res) => {
  try {
    const uid = req.user?.userId ?? req.user?.id;
    const batch = await paymentBatchService.approveBatch(req.params.id, uid);
    res.json(batch);
  } catch (error) {
    res.status(error.message.includes('not awaiting') ? 400 : 500).json({ error: error.message });
  }
});

router.post('/payment-batches/:id/reject', requirePermission('finance', 'approve'), async (req, res) => {
  try {
    const uid = req.user?.userId ?? req.user?.id;
    const batch = await paymentBatchService.rejectBatch(req.params.id, uid, req.body.reason || '');
    res.json(batch);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/payment-batches/:id/process', requirePermission('finance', 'approve'), async (req, res) => {
  try {
    const batch = await paymentBatchService.processBatch(req.params.id, req.body);
    res.json(batch);
  } catch (error) {
    res.status(error.message.includes('must be approved') ? 400 : 500).json({ error: error.message });
  }
});

// Bank file download for NEFT/RTGS bulk payment upload
router.get('/payment-batches/:id/bank-file', async (req, res) => {
  try {
    const { format = 'generic' } = req.query;
    const { batch, items } = await paymentBatchService.getBankFileData(req.params.id);

    // Check for missing bank details
    const missing = items.filter(it => !it.account_number || !it.ifsc_code);
    if (missing.length > 0) {
      return res.status(422).json({
        error: 'Some suppliers are missing bank details',
        missing_suppliers: missing.map(m => m.party_name || m.supplier_name),
      });
    }

    // Build CSV rows per bank format
    let header, rows;
    if (format === 'sbi') {
      header = 'PRODUCT_CODE,PAYMENT_AMT,BENE_ACC_NO,BENE_IFSC_CODE,BENE_NAME,PAYMENT_REF,REMARKS';
      rows = items.map(it =>
        `NEFT,${it.amount},${it.account_number},${it.ifsc_code},"${it.party_name}",${batch.batch_number},${it.bill_number || ''}`
      );
    } else if (format === 'hdfc') {
      header = 'PAYMENT TYPE,AMOUNT,BENE ACCOUNT,IFSC,BENE NAME,EMAIL,MOBILE,PAYMENT REF';
      rows = items.map(it =>
        `NEFT,${it.amount},${it.account_number},${it.ifsc_code},"${it.party_name}",,${it.mobile || ''},${batch.batch_number}`
      );
    } else if (format === 'icici') {
      header = 'Beneficiary Name,Beneficiary Account No,Beneficiary IFSC,Amount,Payment Mode,Remarks';
      rows = items.map(it =>
        `"${it.party_name}",${it.account_number},${it.ifsc_code},${it.amount},NEFT,${batch.batch_number}`
      );
    } else {
      // Generic CSV
      header = 'Party Name,Account Number,IFSC Code,Amount,Payment Mode,Reference,Bill Number';
      rows = items.map(it =>
        `"${it.party_name}",${it.account_number},${it.ifsc_code},${it.amount},${it.payment_method || 'NEFT'},${batch.batch_number},${it.bill_number || ''}`
      );
    }

    const csv = [header, ...rows].join('\n');
    const filename = `batch-${batch.batch_number}-${format}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// PDC REGISTER
// =====================================================

// Helper: get company_id from request
function getCompanyId(req) {
  return req.scope?.company_id ?? companyOf(req);
}

// Summary KPIs for PDC Outstanding tab
router.get('/pdc/summary', async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const cidFilter = cid != null ? `AND p.company_id = ${parseInt(cid, 10)}` : '';

    const today = new Date().toISOString().split('T')[0];
    const weekEnd = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

    const [receivable, payable, dueWeek, bounced] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS total
         FROM pdc_register p
         WHERE cheque_type='receivable' AND status IN ('pending','deposited') ${cidFilter}`
      ).catch(() => ({ rows: [{ cnt: 0, total: 0 }] })),
      pool.query(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS total
         FROM pdc_register p
         WHERE cheque_type='payable' AND status IN ('pending','deposited') ${cidFilter}`
      ).catch(() => ({ rows: [{ cnt: 0, total: 0 }] })),
      pool.query(
        `SELECT COALESCE(SUM(amount),0) AS total
         FROM pdc_register p
         WHERE status = 'pending' AND cheque_date BETWEEN $1 AND $2 ${cidFilter}`,
        [today, weekEnd]
      ).catch(() => ({ rows: [{ total: 0 }] })),
      pool.query(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS total
         FROM pdc_register p
         WHERE status = 'bounced' ${cidFilter}`
      ).catch(() => ({ rows: [{ cnt: 0, total: 0 }] })),
    ]);

    res.json({
      receivable_total:  parseFloat(receivable.rows[0]?.total || 0),
      receivable_count:  parseInt(receivable.rows[0]?.cnt || 0),
      payable_total:     parseFloat(payable.rows[0]?.total || 0),
      payable_count:     parseInt(payable.rows[0]?.cnt || 0),
      due_week:          parseFloat(dueWeek.rows[0]?.total || 0),
      bounced_amount:    parseFloat(bounced.rows[0]?.total || 0),
      bounced_count:     parseInt(bounced.rows[0]?.cnt || 0),
    });
  } catch (e) {
    res.json({ receivable_total: 0, receivable_count: 0, payable_total: 0, payable_count: 0, due_week: 0, bounced_amount: 0, bounced_count: 0 });
  }
});

router.post('/pdc', async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const { cheque_type, cheque_number, cheque_date, amount, party_id, bank_account_id, bank_name, reference_type, reference_id, notes } = req.body;

    if (!cheque_date || new Date(cheque_date) <= new Date()) {
      return res.status(400).json({ error: 'Cheque date must be a future date for PDC' });
    }

    const result = await pool.query(
      `INSERT INTO pdc_register (company_id, cheque_type, cheque_number, cheque_date, amount, party_id, bank_account_id, bank_name, reference_type, reference_id, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending') RETURNING *`,
      [cid, cheque_type, cheque_number, cheque_date, amount, party_id || null, bank_account_id || null, bank_name, reference_type, reference_id, notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/pdc', async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const params = [];
    let where = '1=1';

    if (cid != null) {
      params.push(parseInt(cid, 10));
      where += ` AND p.company_id = $${params.length}`;
    }
    if (req.query.cheque_type) {
      params.push(req.query.cheque_type);
      where += ` AND p.cheque_type = $${params.length}`;
    }
    if (req.query.status) {
      params.push(req.query.status);
      where += ` AND p.status = $${params.length}`;
    }
    if (req.query.from_date) {
      params.push(req.query.from_date);
      where += ` AND p.cheque_date >= $${params.length}`;
    }
    if (req.query.to_date) {
      params.push(req.query.to_date);
      where += ` AND p.cheque_date <= $${params.length}`;
    }
    if (req.query.party_id) {
      params.push(req.query.party_id);
      where += ` AND p.party_id = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT p.*,
              pt.name AS party_name,
              ba.account_name,
              (p.cheque_date::date - CURRENT_DATE) AS days_until_due
       FROM pdc_register p
       LEFT JOIN parties pt ON p.party_id = pt.id
       LEFT JOIN bank_accounts ba ON p.bank_account_id = ba.id
       WHERE ${where}
       ORDER BY p.cheque_date ASC`,
      params
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/pdc/:id/status', async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const { status, cleared_date, bounce_reason, bounce_charges } = req.body;
    const cidFilter = cid != null ? ` AND company_id = ${parseInt(cid, 10)}` : '';
    const result = await pool.query(
      `UPDATE pdc_register
       SET status = $1, cleared_date = $2, bounce_reason = $3, bounce_charges = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5${cidFilter} RETURNING *`,
      [status, cleared_date || null, bounce_reason || null, bounce_charges || 0, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'PDC not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark PDC as deposited
router.post('/pdc/:id/deposit', async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const cidFilter = cid != null ? ` AND company_id = ${parseInt(cid, 10)}` : '';
    const { deposit_date } = req.body;
    const result = await pool.query(
      `UPDATE pdc_register
       SET status = 'deposited', deposit_date = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND status = 'pending'${cidFilter} RETURNING *`,
      [deposit_date || new Date().toISOString().split('T')[0], req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'PDC not found or already deposited' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark PDC as cleared (after bank confirms)
router.post('/pdc/:id/clear', async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const cidFilter = cid != null ? ` AND company_id = ${parseInt(cid, 10)}` : '';
    const { cleared_date } = req.body;
    const result = await pool.query(
      `UPDATE pdc_register
       SET status = 'cleared', cleared_date = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND status = 'deposited'${cidFilter} RETURNING *`,
      [cleared_date || new Date().toISOString().split('T')[0], req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'PDC not found or not in deposited state' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark PDC as bounced
router.post('/pdc/:id/bounce', async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const cidFilter = cid != null ? ` AND company_id = ${parseInt(cid, 10)}` : '';
    const { bounce_reason, bounce_charges } = req.body;
    const result = await pool.query(
      `UPDATE pdc_register
       SET status = 'bounced', bounce_reason = $1, bounce_charges = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND status IN ('deposited','pending')${cidFilter} RETURNING *`,
      [bounce_reason || '', bounce_charges || 0, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'PDC not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cancel PDC
router.post('/pdc/:id/cancel', async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const cidFilter = cid != null ? ` AND company_id = ${parseInt(cid, 10)}` : '';
    const result = await pool.query(
      `UPDATE pdc_register
       SET status = 'cancelled', notes = COALESCE(notes,'') || ' [Cancelled: ' || $1 || ']', updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND status = 'pending'${cidFilter} RETURNING *`,
      [req.body.reason || '', req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'PDC not found or already processed' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PDC History/Report — cleared, bounced, cancelled cheques
router.get('/pdc/history', async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const { from_date, to_date, cheque_type, status, party_id } = req.query;
    const params = [];
    let where = `p.status IN ('cleared','bounced','cancelled')`;

    if (cid != null) {
      params.push(parseInt(cid, 10));
      where += ` AND p.company_id = $${params.length}`;
    }
    if (from_date)   { params.push(from_date);              where += ` AND p.cheque_date >= $${params.length}`; }
    if (to_date)     { params.push(to_date);                where += ` AND p.cheque_date <= $${params.length}`; }
    if (cheque_type) { params.push(cheque_type);            where += ` AND p.cheque_type = $${params.length}`; }
    if (status)      { params.push(status);                 where += ` AND p.status = $${params.length}`; }
    if (party_id)    { params.push(parseInt(party_id, 10)); where += ` AND p.party_id = $${params.length}`; }

    const { rows } = await pool.query(
      `SELECT p.*,
              pt.name AS party_name,
              ba.account_name,
              ba.bank_name AS account_bank
       FROM pdc_register p
       LEFT JOIN parties pt ON p.party_id = pt.id
       LEFT JOIN bank_accounts ba ON p.bank_account_id = ba.id
       WHERE ${where}
       ORDER BY p.cheque_date DESC`,
      params
    );

    const cleared = rows.filter(r => r.status === 'cleared');
    const bounced = rows.filter(r => r.status === 'bounced');
    const cleared_total = cleared.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
    const bounced_total = bounced.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
    const bounce_rate = rows.length > 0
      ? ((bounced.length / rows.length) * 100).toFixed(1)
      : '0.0';
    const clearable = cleared.filter(r => r.cleared_date && r.cheque_date);
    const avg_days_to_clear = clearable.length > 0
      ? Math.round(
          clearable.reduce((s, r) => s + Math.abs((new Date(r.cleared_date) - new Date(r.cheque_date)) / 86400000), 0)
          / clearable.length
        )
      : 0;

    res.json({
      cheques: rows,
      stats: { cleared_total, bounced_total, bounce_rate, avg_days_to_clear },
    });
  } catch (e) {
    res.json({ cheques: [], stats: { cleared_total: 0, bounced_total: 0, bounce_rate: '0.0', avg_days_to_clear: 0 } });
  }
});

// =====================================================
// EXPENSE CATEGORIES
// =====================================================
router.get('/expense-categories', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM expense_categories WHERE is_active = true ORDER BY name'
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// COMPLIANCE ANALYTICS
// =====================================================
router.get('/analytics/without-bill', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const result = await pool.query(
      `SELECT 
        ec.name as category,
        COUNT(*) as count,
        SUM(eci.amount) as total_amount
       FROM expense_claim_items eci
       JOIN expense_categories ec ON eci.category_id = ec.id
       JOIN expense_claims ecl ON eci.expense_claim_id = ecl.id
       WHERE eci.bill_status = 'without_bill'
       AND ecl.claim_date BETWEEN $1 AND $2
       GROUP BY ec.name
       ORDER BY total_amount DESC`,
      [start_date, end_date]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics/gst-claimable', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const result = await pool.query(
      `SELECT 
        SUM(CASE WHEN is_gst_claimable = true THEN gst_amount ELSE 0 END) as claimable_gst,
        SUM(CASE WHEN is_gst_claimable = false THEN gst_amount ELSE 0 END) as non_claimable_gst,
        SUM(gst_amount) as total_gst
       FROM expense_claim_items eci
       JOIN expense_claims ecl ON eci.expense_claim_id = ecl.id
       WHERE ecl.claim_date BETWEEN $1 AND $2`,
      [start_date, end_date]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// FINANCIAL RATIOS
// =====================================================
router.get('/ratios', async (req, res) => {
  try {
    const { as_of_date } = req.query;
    const ratios = await financialRatiosService.calculateRatios(as_of_date || new Date().toISOString().split('T')[0]);
    res.json(ratios);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/ratios/comparative', async (req, res) => {
  try {
    const { current_date, previous_date } = req.query;
    const comparison = await financialRatiosService.getComparativeRatios(current_date, previous_date);
    res.json(comparison);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// BUDGETS
// =====================================================
router.post('/budgets', async (req, res) => {
  try {
    const { budget_name, fiscal_year, account_id, period_type, monthly_amounts, notes } = req.body;
    const total = Object.values(monthly_amounts).reduce((sum, val) => sum + parseFloat(val), 0);
    
    const result = await pool.query(
      `INSERT INTO budgets (budget_name, fiscal_year, account_id, period_type, jan_amount, feb_amount, mar_amount, apr_amount, may_amount, jun_amount, jul_amount, aug_amount, sep_amount, oct_amount, nov_amount, dec_amount, total_amount, notes) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING *`,
      [budget_name, fiscal_year, account_id, period_type, monthly_amounts.jan, monthly_amounts.feb, monthly_amounts.mar, monthly_amounts.apr, monthly_amounts.may, monthly_amounts.jun, monthly_amounts.jul, monthly_amounts.aug, monthly_amounts.sep, monthly_amounts.oct, monthly_amounts.nov, monthly_amounts.dec, total, notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/budgets', async (req, res) => {
  try {
    const { fiscal_year } = req.query;
    let query = `SELECT b.*, c.code, c.name as account_name 
                 FROM budgets b
                 JOIN chart_of_accounts c ON b.account_id = c.id
                 WHERE 1=1`;
    const params = [];
    
    if (fiscal_year) {
      params.push(fiscal_year);
      query += ` AND b.fiscal_year = $${params.length}`;
    }
    
    query += ' ORDER BY b.fiscal_year DESC, c.code';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/budgets/vs-actual', async (req, res) => {
  try {
    const { fiscal_year, month } = req.query;
    // This would compare budget vs actual spending
    // Implementation depends on specific requirements
    res.json({ message: 'Budget vs Actual comparison' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// TICKETING SYSTEM
// =====================================================
router.post('/tickets', async (req, res) => {
  try {
    const ticketNumber = await ticketRepo.getNextTicketNumber();
    const ticket = await ticketRepo.create({
      ...req.body,
      ticket_number: ticketNumber
    });
    res.status(201).json(ticket);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/tickets', async (req, res) => {
  try {
    const tickets = await ticketRepo.findAll(req.query);
    res.json(tickets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/tickets/:id', async (req, res) => {
  try {
    const ticket = await ticketRepo.findById(req.params.id);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    ticket.conversations = await ticketRepo.getConversations(req.params.id);
    res.json(ticket);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/tickets/:id/status', async (req, res) => {
  try {
    const ticket = await ticketRepo.updateStatus(req.params.id, req.body.status, req.user.userId ?? req.user.id);
    res.json(ticket);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/tickets/:id/assign', async (req, res) => {
  try {
    const ticket = await ticketRepo.assignTicket(req.params.id, req.body.assigned_to);
    res.json(ticket);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/tickets/:id/conversations', async (req, res) => {
  try {
    const conversation = await ticketRepo.addConversation({
      ticket_id: req.params.id,
      ...req.body,
      created_by: req.user.userId ?? req.user.id
    });
    res.status(201).json(conversation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/tickets/dashboard/stats', async (req, res) => {
  try {
    const stats = await ticketRepo.getDashboardStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/ticket-categories', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM ticket_categories WHERE is_active = true ORDER BY name'
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/sla-policies', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM sla_policies WHERE is_active = true ORDER BY priority'
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Credit limits compat (main table lives in sales module) ──────────────────
router.get('/credit-limits', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT cl.*, p.name AS customer_name
       FROM credit_limits cl
       LEFT JOIN parties p ON cl.customer_id = p.id
       ORDER BY COALESCE(cl.customer_name, p.name)`
    ).catch(() => ({ rows: [] }));
    res.json(rows);
  } catch { res.json([]); }
});

// ── Journal entries (migrated from financeNewRoutes) ─────────────────────────
router.get('/journal-entries',  getJournalEntries);
router.post('/journal-entries', createJournalEntry);

// ── Accounting periods (migrated from financeNewRoutes) ───────────────────────
router.get('/periods',              getPeriods);
router.post('/periods/:id/close',   requirePermission('finance', 'approve'), closePeriod);
router.post('/periods/:id/reopen',  requirePermission('finance', 'approve'), reopenPeriod);

// ── CFO dashboard (migrated from financeNewRoutes) ────────────────────────────
router.get('/cfo-dashboard', getCFODashboard);

// ── PDC Outstanding (legacy compat — redirects to /pdc?status=pending) ───────
router.get('/pdc-outstanding', async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const cidFilter = cid != null ? ` AND p.company_id = ${parseInt(cid, 10)}` : '';
    const { rows } = await pool.query(
      `SELECT p.*, pt.name AS party_name, ba.account_name,
              (p.cheque_date::date - CURRENT_DATE) AS days_until_due
       FROM pdc_register p
       LEFT JOIN parties pt ON p.party_id = pt.id
       LEFT JOIN bank_accounts ba ON p.bank_account_id = ba.id
       WHERE p.status IN ('pending','deposited')${cidFilter}
       ORDER BY p.cheque_date`
    ).catch(() => ({ rows: [] }));
    res.json(rows);
  } catch { res.json([]); }
});

// ── Purchase Dashboard / Payables ─────────────────────────────────────────────
router.get('/purchase-dashboard/payable', async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const params    = companyId != null ? [companyId] : [];
    const cidSQL    = companyId != null ? ' AND b.company_id = $1' : '';

    const amtCol = `COALESCE(b.total_amount, b.net_payable, b.amount, 0)`;

    const [totalRow, overdueRow, dueRow, recentRows] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(${amtCol}),0) AS total FROM bills b WHERE b.status NOT IN ('paid','cancelled','void') AND b.deleted_at IS NULL${cidSQL}`,
        params
      ).catch(() => ({ rows: [{ total: 0 }] })),
      pool.query(
        `SELECT COALESCE(SUM(${amtCol}),0) AS total FROM bills b WHERE b.status NOT IN ('paid','cancelled','void') AND b.deleted_at IS NULL AND b.due_date < CURRENT_DATE${cidSQL}`,
        params
      ).catch(() => ({ rows: [{ total: 0 }] })),
      pool.query(
        `SELECT COALESCE(SUM(${amtCol}),0) AS total FROM bills b WHERE b.status NOT IN ('paid','cancelled','void') AND b.deleted_at IS NULL AND b.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30${cidSQL}`,
        params
      ).catch(() => ({ rows: [{ total: 0 }] })),
      pool.query(
        `SELECT b.id, b.bill_number, b.bill_date, b.due_date, b.status,
                ${amtCol} AS amount,
                COALESCE(p.name, b.party_name) AS vendor_name
         FROM bills b LEFT JOIN parties p ON b.supplier_id = p.id
         WHERE b.status NOT IN ('paid','cancelled','void') AND b.deleted_at IS NULL${cidSQL}
         ORDER BY b.due_date NULLS LAST LIMIT 20`,
        params
      ).catch(() => ({ rows: [] })),
    ]);
    res.json({
      total_payable:  parseFloat(totalRow.rows[0]?.total || 0),
      overdue:        parseFloat(overdueRow.rows[0]?.total || 0),
      due_in_30_days: parseFloat(dueRow.rows[0]?.total || 0),
      bills:          recentRows.rows,
    });
  } catch (e) { res.json({ total_payable: 0, overdue: 0, due_in_30_days: 0, bills: [] }); }
});

// ── Report PDC (legacy compat — history tab uses /pdc with status filter) ────
router.get('/report-pdc', async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const { cheque_type, status, from_date, to_date } = req.query;
    const params = [];
    let where = '1=1';
    if (cid != null) { params.push(parseInt(cid, 10)); where += ` AND p.company_id=$${params.length}`; }
    if (cheque_type) { params.push(cheque_type); where += ` AND p.cheque_type=$${params.length}`; }
    if (status)      { params.push(status);       where += ` AND p.status=$${params.length}`; }
    if (from_date)   { params.push(from_date);    where += ` AND p.cheque_date>=$${params.length}`; }
    if (to_date)     { params.push(to_date);      where += ` AND p.cheque_date<=$${params.length}`; }
    const { rows } = await pool.query(
      `SELECT p.*, pt.name AS party_name, ba.account_name
       FROM pdc_register p
       LEFT JOIN parties pt ON p.party_id = pt.id
       LEFT JOIN bank_accounts ba ON p.bank_account_id = ba.id
       WHERE ${where} ORDER BY p.cheque_date DESC`,
      params
    ).catch(() => ({ rows: [] }));
    res.json(rows);
  } catch { res.json([]); }
});

// ── Report Purchase ──────────────────────────────────────────────────────────
router.get('/report-purchase', async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const { date_from, date_to, supplier_id, status } = req.query;
    const params = [];
    let where = '1=1';

    if (cid != null) {
      params.push(parseInt(cid, 10));
      where += ` AND b.company_id=$${params.length}`;
    }
    if (date_from) { params.push(date_from); where += ` AND b.bill_date>=$${params.length}`; }
    if (date_to)   { params.push(date_to);   where += ` AND b.bill_date<=$${params.length}`; }
    if (supplier_id) { params.push(supplier_id); where += ` AND b.supplier_id=$${params.length}`; }
    if (status === 'overdue') {
      where += ` AND b.due_date < CURRENT_DATE AND LOWER(b.status) NOT IN ('paid','cancelled')`;
    } else if (status) {
      params.push(status);
      where += ` AND LOWER(b.status)=$${params.length}`;
    }

    const [rowsRes, summaryRes] = await Promise.all([
      pool.query(
        `SELECT
           b.id,
           b.bill_number,
           b.bill_date,
           b.due_date,
           p.name                                                         AS supplier_name,
           p.gstin                                                        AS supplier_gstin,
           COALESCE(b.subtotal, b.total_amount, b.amount, 0)             AS taxable_amount,
           COALESCE(b.tax_amount, 0)                                      AS gst_amount,
           COALESCE(b.total_amount, b.amount, 0)                          AS total_amount,
           COALESCE(b.balance, 0)                                         AS balance,
           b.status,
           CASE
             WHEN LOWER(b.status) = 'paid'                                         THEN 'paid'
             WHEN b.due_date IS NOT NULL
               AND b.due_date < CURRENT_DATE
               AND LOWER(b.status) NOT IN ('paid','cancelled')            THEN 'overdue'
             ELSE LOWER(b.status)
           END                                                            AS display_status
         FROM bills b
         LEFT JOIN parties p ON b.supplier_id = p.id
         WHERE ${where}
         ORDER BY b.bill_date DESC NULLS LAST
         LIMIT 1000`,
        params
      ).catch(() => ({ rows: [] })),

      pool.query(
        `SELECT
           COUNT(*)                                                                                    AS total_bills,
           COUNT(DISTINCT b.supplier_id)                                                                AS unique_suppliers,
           COALESCE(SUM(COALESCE(b.total_amount, b.amount, 0)), 0)                                     AS total_purchase_value,
           COALESCE(SUM(COALESCE(b.tax_amount, 0)), 0)                                                 AS total_gst_paid,
           COALESCE(AVG(COALESCE(b.total_amount, b.amount, 0)), 0)                                     AS avg_bill_value,
           COALESCE(SUM(
             CASE
               WHEN b.due_date < CURRENT_DATE
                 AND LOWER(b.status) NOT IN ('paid','cancelled')
               THEN COALESCE(b.balance, b.total_amount, b.amount, 0)
               ELSE 0
             END
           ), 0)                                                                                       AS overdue_amount
         FROM bills b
         WHERE ${where}`,
        params
      ).catch(() => ({ rows: [{}] })),
    ]);

    res.json({
      rows:    rowsRes.rows,
      summary: summaryRes.rows[0] || null,
    });
  } catch { res.json({ rows: [], summary: null }); }
});

export default router;

