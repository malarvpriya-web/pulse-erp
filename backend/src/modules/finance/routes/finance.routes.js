import express from 'express';
import multer from 'multer';
import pool from '../db.js';
import coaRepo from '../repositories/chartOfAccounts.repository.js';
import partiesRepo from '../repositories/parties.repository.js';
import { billService, paymentService } from '../services/bill.service.js';
import receiptService from '../services/receipt.service.js';
import expenseRepo from '../repositories/expense.repository.js';
import journalRepo from '../repositories/journal.repository.js';
import reportsService from '../services/reports.service.js';
import invoiceController from '../controllers/invoice.controller.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { validate } from '../../../services/ValidationEngineService.js';
import { evaluateRules } from '../../../services/RuleEngineService.js';
import { logAudit } from '../../../services/AuditService.js';
import { getInvoiceStats, getBillStats } from '../finance.controller.js';
import { isDriveConfigured, ensureCustomerDocFolder, DOC_TYPES } from '../../../services/googleDrive.service.js';
import { uploadFile } from '../../../services/StorageService.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Drive subfolder labels for auto-provisioning on customer creation
const CUSTOMER_DRIVE_FOLDERS = [
  '01 Opportunities', '02 Quotations', '03 Purchase Orders', '04 Contracts',
  '05 Drawings', '06 BOM', '07 FAT Reports', '08 SAT Reports',
  '09 Commissioning Reports', '10 Service Reports', '11 AMC',
  '12 Invoices', '13 Travel Claims', '14 Correspondence',
];

async function _autoProvisionDriveForCustomer(party, companyId) {
  if (!isDriveConfigured()) return;
  const customerType = (party.type || party.party_type || '').toLowerCase();
  if (!customerType.includes('customer')) return;

  const cleanName = (party.name || party.party_name || '').replace(/[^a-zA-Z0-9\s\-_.]/g, '').trim();
  if (!cleanName) return;

  for (const label of CUSTOMER_DRIVE_FOLDERS) {
    try {
      const folderId = await ensureCustomerDocFolder(cleanName, label, companyId);
      const folderUrl = `https://drive.google.com/drive/folders/${folderId}`;
      await pool.query(
        `INSERT INTO customer_drive_folders
           (company_id, customer_id, customer_name, doc_type, drive_folder_id, drive_folder_url)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (company_id, customer_name, doc_type)
         DO UPDATE SET drive_folder_id = EXCLUDED.drive_folder_id,
                       drive_folder_url = EXCLUDED.drive_folder_url,
                       customer_id = EXCLUDED.customer_id,
                       updated_at = NOW()`,
        [companyId, party.id, cleanName, label, folderId, folderUrl]
      );
    } catch (_) { /* Drive errors must not affect party creation */ }
  }
}

const router = express.Router();

// Chart of Accounts
router.post('/accounts/seed-defaults', requirePermission('finance', 'add'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const accounts = await coaRepo.seedDefaults(companyId);
    res.json({ seeded: accounts.length, accounts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/accounts', requirePermission('finance', 'add'), async (req, res) => {
  try {
    const { valid, errors } = await validate('finance', req.body);
    if (!valid) return res.status(422).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', module: 'finance', errors });
    const companyId = req.scope?.company_id ?? null;
    const account = await coaRepo.create({ ...req.body, company_id: companyId });
    res.status(201).json(account);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/accounts', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const accounts = await coaRepo.findAll(companyId);
    res.json(accounts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/accounts/tree', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const tree = await coaRepo.findTree(companyId);
    res.json(tree);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/accounts/:id', requirePermission('finance', 'edit'), async (req, res) => {
  try {
    const { valid, errors } = await validate('finance', req.body);
    if (!valid) return res.status(422).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', module: 'finance', errors });
    const account = await coaRepo.update(req.params.id, req.body);
    res.json(account);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/accounts/:id', requirePermission('finance', 'delete'), async (req, res) => {
  try {
    await coaRepo.softDelete(req.params.id);
    res.json({ message: 'Account deactivated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Parties (Customers & Suppliers)
router.post('/parties', requirePermission('finance', 'add'), async (req, res) => {
  try {
    const { valid, errors } = await validate('finance', req.body);
    if (!valid) return res.status(422).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', module: 'finance', errors });
    const partyCode = await partiesRepo.getNextCode(req.body.party_type);
    const party = await partiesRepo.create({ ...req.body, party_code: partyCode, company_id: req.scope?.company_id ?? null });
    logAudit({ userId: req.user?.userId, module: 'finance', recordId: party.id, recordType: 'party', action: 'create', newData: party, req });
    const ruleResults = await evaluateRules('finance', party).catch(() => []);
    const ruleAlerts = ruleResults.filter(r => r.triggered);
    res.status(201).json({ ...party, ...(ruleAlerts.length ? { rule_alerts: ruleAlerts } : {}) });
    // Fire-and-forget: auto-provision Google Drive folders for new customers
    _autoProvisionDriveForCustomer(party, req.scope?.company_id ?? null).catch(() => {});
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/parties', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const parties = await partiesRepo.findAll({ ...req.query, company_id: req.scope?.company_id ?? null });
    res.json(parties);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/parties/:id', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const party = await partiesRepo.findById(req.params.id);
    if (!party) {
      return res.status(404).json({ error: 'Party not found' });
    }
    res.json(party);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/parties/:id/outstanding', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const party = await partiesRepo.findById(req.params.id);
    if (!party) {
      return res.status(404).json({ error: 'Party not found' });
    }
    const balance = await partiesRepo.getOutstandingBalance(party.id, party.party_type);
    res.json({ outstanding_balance: balance });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/parties/:id', requirePermission('finance', 'edit'), async (req, res) => {
  try {
    const { valid, errors } = await validate('finance', req.body);
    if (!valid) return res.status(422).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', module: 'finance', errors });
    const party = await partiesRepo.update(req.params.id, req.body);
    res.json(party);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/parties/:id/transactions', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const { rows: invoices } = await pool.query(
      `SELECT
         i.id, 'invoice' AS record_type,
         COALESCE(i.invoice_number, i.id::text) AS reference,
         COALESCE(i.invoice_date, i.created_at::date) AS txn_date,
         i.total_amount::NUMERIC AS amount,
         COALESCE(i.paid_amount, 0)::NUMERIC AS paid_amount,
         (i.total_amount - COALESCE(i.paid_amount, 0))::NUMERIC AS balance,
         COALESCE(i.status, 'draft') AS status
       FROM invoices i
       WHERE i.deleted_at IS NULL
         AND (i.party_id = $1 OR i.customer_id = $1)
         AND ($2::int IS NULL OR i.company_id = $2)
       ORDER BY txn_date DESC`,
      [req.params.id, companyId]
    );
    const { rows: bills } = await pool.query(
      `SELECT
         b.id, 'bill' AS record_type,
         COALESCE(b.bill_number, b.id::text) AS reference,
         COALESCE(b.bill_date, b.created_at::date) AS txn_date,
         b.net_payable::NUMERIC AS amount,
         COALESCE(b.paid_amount, 0)::NUMERIC AS paid_amount,
         (b.net_payable - COALESCE(b.paid_amount, 0))::NUMERIC AS balance,
         COALESCE(b.status, 'pending') AS status
       FROM bills b
       WHERE b.deleted_at IS NULL
         AND b.party_id = $1
         AND ($2::int IS NULL OR b.company_id = $2)
       ORDER BY txn_date DESC`,
      [req.params.id, companyId]
    );
    const all = [...invoices, ...bills].sort((a, b) => new Date(b.txn_date) - new Date(a.txn_date));
    res.json(all);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/parties/:id/ageing', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const { rows } = await pool.query(
      `SELECT
         CASE
           WHEN NOW()::date - COALESCE(i.due_date, i.invoice_date) <= 0  THEN 'current'
           WHEN NOW()::date - COALESCE(i.due_date, i.invoice_date) <= 30 THEN '1_30'
           WHEN NOW()::date - COALESCE(i.due_date, i.invoice_date) <= 60 THEN '31_60'
           WHEN NOW()::date - COALESCE(i.due_date, i.invoice_date) <= 90 THEN '61_90'
           ELSE 'over_90'
         END AS bucket,
         COUNT(*) AS count,
         SUM(i.total_amount - COALESCE(i.paid_amount, 0))::NUMERIC AS amount
       FROM invoices i
       WHERE i.deleted_at IS NULL
         AND (i.party_id = $1 OR i.customer_id = $1)
         AND ($2::int IS NULL OR i.company_id = $2)
         AND LOWER(COALESCE(i.status,'draft')) NOT IN ('paid','cancelled','void')
       GROUP BY 1`,
      [req.params.id, companyId]
    );
    const buckets = { current: 0, '1_30': 0, '31_60': 0, '61_90': 0, over_90: 0 };
    rows.forEach(r => { buckets[r.bucket] = parseFloat(r.amount); });
    res.json(buckets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/parties/import', requirePermission('finance', 'add'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const rows = req.body.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(422).json({ error: 'No rows provided' });
    }
    const results = { imported: 0, errors: [] };
    for (const [i, row] of rows.entries()) {
      try {
        if (!row.name?.trim()) throw new Error('name is required');
        const partyType = row.type || row.party_type || 'Customer';
        const partyCode = row.party_code?.trim() || await partiesRepo.getNextCode(partyType);
        await partiesRepo.create({
          party_code: partyCode,
          party_type: partyType,
          name: row.name.trim(),
          email: row.email || null,
          phone: row.phone || null,
          gstin: row.gstin || null,
          pan: row.pan || null,
          address: row.billing_address || row.address || null,
          city: row.city || null,
          state: row.state || null,
          pincode: row.pincode || null,
          payment_terms: parseInt(row.payment_terms) || 30,
          credit_limit: parseFloat(row.credit_limit) || 0,
          bank_name: row.bank_name || null,
          bank_account: row.account_number || null,
          ifsc: row.ifsc_code || null,
          currency: 'INR',
          company_id: companyId,
        });
        results.imported++;
      } catch (err) {
        results.errors.push({ row: i + 1, name: row.name || '—', error: err.message });
      }
    }
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Invoices
router.post('/invoices', requirePermission('finance', 'add'), async (req, res, next) => {
  const { valid, errors } = await validate('finance', req.body).catch(() => ({ valid: true, errors: [] }));
  if (!valid) return res.status(422).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', module: 'finance', errors });
  next();
}, async (req, res, next) => {
  // Credit limit enforcement — block invoice if customer would exceed their credit limit
  const { party_id, total_amount } = req.body;
  if (!party_id || !total_amount) return next();
  try {
    const companyId = req.scope?.company_id ?? null;
    const { rows: [party] } = await pool.query(
      'SELECT credit_limit, name, msme_number FROM parties WHERE id = $1 AND company_id = $2',
      [party_id, companyId]
    );
    if (!party || !party.credit_limit || parseFloat(party.credit_limit) <= 0) return next();

    // Outstanding AR for this customer
    const { rows: [arRow] } = await pool.query(`
      SELECT COALESCE(SUM(total_amount - COALESCE(amount_paid, 0)), 0) AS outstanding
      FROM invoices
      WHERE party_id = $1 AND company_id = $2
        AND status NOT IN ('paid','cancelled','draft')
    `, [party_id, companyId]);

    const outstanding  = parseFloat(arRow?.outstanding ?? 0);
    const thisInvoice  = parseFloat(total_amount);
    const creditLimit  = parseFloat(party.credit_limit);
    const projectedTotal = outstanding + thisInvoice;

    if (projectedTotal > creditLimit) {
      return res.status(422).json({
        error: `Credit limit exceeded for ${party.name}. Limit: ₹${creditLimit.toLocaleString('en-IN')}, Outstanding: ₹${outstanding.toLocaleString('en-IN')}, This Invoice: ₹${thisInvoice.toLocaleString('en-IN')}.`,
        code: 'CREDIT_LIMIT_EXCEEDED',
        credit_limit: creditLimit,
        outstanding,
        this_invoice: thisInvoice,
        projected_total: projectedTotal,
      });
    }
  } catch { /* don't block if credit check fails — log only */ }
  next();
}, invoiceController.create.bind(invoiceController));
router.get('/invoices', requirePermission('finance', 'view'), invoiceController.getAll.bind(invoiceController));

// ── GET /finance/parties/:id/statement — Customer Account Statement ───────────
router.get('/parties/:id/statement', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const partyId   = req.params.id;
    const { from_date, to_date } = req.query;
    const fromDate = from_date || new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];
    const toDate   = to_date   || new Date().toISOString().split('T')[0];

    const { rows: [party] } = await pool.query(
      'SELECT id, name, gstin, phone, email, credit_limit, msme_number FROM parties WHERE id = $1 AND company_id = $2',
      [partyId, companyId]
    );
    if (!party) return res.status(404).json({ error: 'Party not found' });

    const [invoiceRows, receiptRows] = await Promise.all([
      pool.query(`
        SELECT 'invoice' AS type, invoice_number AS ref, invoice_date AS date,
               total_amount AS debit, 0 AS credit, status
        FROM invoices WHERE party_id = $1 AND company_id = $2
          AND DATE(invoice_date) BETWEEN $3 AND $4
        ORDER BY invoice_date
      `, [partyId, companyId, fromDate, toDate]),
      pool.query(`
        SELECT 'receipt' AS type, receipt_number AS ref, receipt_date AS date,
               0 AS debit, amount AS credit, 'received' AS status
        FROM receipts WHERE party_id = $1 AND company_id = $2
          AND DATE(receipt_date) BETWEEN $3 AND $4
        ORDER BY receipt_date
      `, [partyId, companyId, fromDate, toDate]),
    ]);

    // Merge and sort chronologically
    const txns = [...invoiceRows.rows, ...receiptRows.rows]
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    // Running balance
    let balance = 0;
    const ledger = txns.map(t => {
      balance += parseFloat(t.debit) - parseFloat(t.credit);
      return { ...t, balance };
    });

    const totalDebit  = txns.reduce((s, t) => s + parseFloat(t.debit), 0);
    const totalCredit = txns.reduce((s, t) => s + parseFloat(t.credit), 0);

    res.json({
      party,
      period: { from: fromDate, to: toDate },
      summary: { totalDebit, totalCredit, closingBalance: totalDebit - totalCredit },
      ledger,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.get('/invoices/overdue', requirePermission('finance', 'view'), invoiceController.getOverdue.bind(invoiceController));
router.get('/invoices/due-soon', requirePermission('finance', 'view'), invoiceController.getDueSoon.bind(invoiceController));
router.get('/invoices/stats', requirePermission('finance', 'view'), getInvoiceStats);
router.get('/invoices/:id', requirePermission('finance', 'view'), invoiceController.getById.bind(invoiceController));

router.patch('/invoices/:id/send', requirePermission('finance', 'edit'), async (req, res) => {
  try {
    const { rows: [inv] } = await pool.query(
      `UPDATE invoices SET status='sent', updated_at=NOW() WHERE id=$1 AND status NOT IN ('paid','cancelled') RETURNING id, status`,
      [req.params.id]
    );
    if (!inv) return res.status(404).json({ error: 'Invoice not found or already paid/cancelled' });
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'finance', recordId: req.params.id, recordType: 'invoice', action: 'send', newData: { status: 'sent' }, req });
    res.json(inv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/invoices/:id/mark-paid', requirePermission('finance', 'edit'), async (req, res) => {
  try {
    const { rows: [inv] } = await pool.query(
      `UPDATE invoices SET status='paid', paid_amount=total_amount, balance_amount=0, updated_at=NOW()
       WHERE id=$1 AND status NOT IN ('paid','cancelled') RETURNING id, status, total_amount`,
      [req.params.id]
    );
    if (!inv) return res.status(404).json({ error: 'Invoice not found or already paid' });
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'finance', recordId: req.params.id, recordType: 'invoice', action: 'mark_paid', newData: { status: 'paid' }, req });
    res.json(inv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/invoices/:id/attachment', requirePermission('finance', 'edit'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const file_url = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);
    const { rows: [inv] } = await pool.query(
      `UPDATE invoices SET attachment_url=$1, updated_at=NOW() WHERE id=$2 RETURNING id, attachment_url`,
      [file_url, req.params.id]
    );
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    res.json(inv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bills
router.post('/bills', requirePermission('finance', 'add'), async (req, res) => {
  try {
    const { valid, errors } = await validate('finance', req.body);
    if (!valid) return res.status(422).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', module: 'finance', errors });
    const bill = await billService.createBill({ ...req.body, company_id: req.scope?.company_id ?? null }, req.user.userId ?? req.user.id);
    logAudit({ userId: req.user?.userId, module: 'finance', recordId: bill.id, recordType: 'bill', action: 'create', newData: bill, req });
    const ruleResults = await evaluateRules('finance', bill).catch(() => []);
    const ruleAlerts = ruleResults.filter(r => r.triggered);
    res.status(201).json({ ...bill, ...(ruleAlerts.length ? { rule_alerts: ruleAlerts } : {}) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/bills', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const bills = await billService.getBills({ ...req.query, company_id: req.scope?.company_id ?? null });
    res.json(bills);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/bills/stats', requirePermission('finance', 'view'), getBillStats);

router.get('/bills/due-soon', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const bills = await billService.getDueSoonBills(days, req.scope?.company_id ?? null);
    res.json(bills);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/bills/:id', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const bill = await billService.getBillById(req.params.id);
    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }
    res.json(bill);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/bills/:id/approve', requirePermission('finance', 'approve'), async (req, res) => {
  try {
    const oldBill = await billService.getBillById(req.params.id);
    const bill = await billService.approveBill(req.params.id, req.user.userId ?? req.user.id, req.body);
    logAudit({ userId: req.user?.userId, module: 'finance', recordId: req.params.id, recordType: 'bill', action: 'approve', oldData: oldBill ?? null, newData: { ...bill, actor_id: req.user?.userId, approved_at: new Date().toISOString() }, req });
    res.json(bill);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/bills/:id/reject', requirePermission('finance', 'approve'), async (req, res) => {
  try {
    const { reason } = req.body;
    const { rows } = await pool.query(
      `UPDATE bills SET status = 'rejected', updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Bill not found' });
    logAudit({ userId: req.user?.userId, module: 'finance', recordId: req.params.id, recordType: 'bill', action: 'reject', newData: { ...rows[0], reason: reason ?? null }, req });
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/bills/:id/resubmit', requirePermission('finance', 'edit'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE bills SET status = 'pending', approval_status = 'Pending', updated_at = NOW()
       WHERE id = $1 AND LOWER(status) = 'rejected' AND deleted_at IS NULL RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Bill not found or not in rejected status' });
    logAudit({ userId: req.user?.userId, module: 'finance', recordId: req.params.id, recordType: 'bill', action: 'resubmit', newData: rows[0], req });
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Payments
router.post('/payments', requirePermission('finance', 'add'), async (req, res) => {
  try {
    const { valid, errors } = await validate('finance', req.body);
    if (!valid) return res.status(422).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', module: 'finance', errors });
    const payment = await paymentService.createPayment({ ...req.body, company_id: req.scope?.company_id ?? null }, req.user.userId ?? req.user.id);
    logAudit({ userId: req.user?.userId, module: 'finance', recordId: payment.id, recordType: 'payment', action: 'create', newData: payment, req });
    const ruleResults = await evaluateRules('finance', payment).catch(() => []);
    const ruleAlerts = ruleResults.filter(r => r.triggered);
    res.status(201).json({ ...payment, ...(ruleAlerts.length ? { rule_alerts: ruleAlerts } : {}) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/payments', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const payments = await paymentService.getPayments({ ...req.query, company_id: req.scope?.company_id ?? null });
    res.json(payments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Receipts
router.post('/receipts', requirePermission('finance', 'add'), async (req, res) => {
  try {
    const { valid, errors } = await validate('finance', req.body);
    if (!valid) return res.status(422).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', module: 'finance', errors });
    const receipt = await receiptService.createReceipt({ ...req.body, company_id: req.scope?.company_id ?? null }, req.user.userId ?? req.user.id);
    res.status(201).json(receipt);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/receipts', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const receipts = await receiptService.getReceipts({ ...req.query, company_id: req.scope?.company_id ?? null });
    res.json(receipts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Expense Claims
router.post('/expenses', requirePermission('finance', 'add'), async (req, res) => {
  try {
    const { valid, errors } = await validate('finance', req.body);
    if (!valid) return res.status(422).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', module: 'finance', errors });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claimNumber = await expenseRepo.getNextNumber();
      const claim = await expenseRepo.create(client, { ...req.body, claim_number: claimNumber });
      
      for (const item of req.body.items) {
        await expenseRepo.createItem(client, { expense_claim_id: claim.id, ...item });
      }
      
      await client.query('COMMIT');
      logAudit({ userId: req.user?.userId, module: 'finance', recordId: claim.id, recordType: 'expense_claim', action: 'create', newData: claim, req });
      const ruleResults = await evaluateRules('finance', claim).catch(() => []);
      const ruleAlerts = ruleResults.filter(r => r.triggered);
      res.status(201).json({ ...claim, ...(ruleAlerts.length ? { rule_alerts: ruleAlerts } : {}) });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/expenses', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const expenses = await expenseRepo.findAll({ ...req.query, company_id: req.scope?.company_id ?? null });
    res.json(expenses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/expenses/:id', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const expense = await expenseRepo.findById(req.params.id);
    if (!expense) {
      return res.status(404).json({ error: 'Expense claim not found' });
    }
    expense.items = await expenseRepo.getItems(req.params.id);
    res.json(expense);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/expenses/:id/approve', requirePermission('finance', 'approve'), async (req, res) => {
  try {
    const oldExpense = await expenseRepo.findById(req.params.id);
    if (!oldExpense) return res.status(404).json({ error: 'Expense claim not found' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const expense = await expenseRepo.approve(client, req.params.id, req.user.userId ?? req.user.id);

      // Create journal entry: DR Expense accounts / CR Employee Payable (2040)
      const companyId = req.scope?.company_id ?? null;
      const totalAmount = parseFloat(expense.total_amount) || 0;
      if (totalAmount > 0) {
        // Resolve account IDs from COA
        const { rows: accts } = await client.query(
          `SELECT id, code, name FROM chart_of_accounts WHERE code IN ('5022','2040') AND is_active = true`
        );
        const acctMap = accts.reduce((m, a) => { m[a.code] = a; return m; }, {});
        const expAcct = acctMap['5022']; // Office Expenses (fallback if specific category account missing)
        const payAcct = acctMap['2040']; // Employee / Salary Payable
        if (expAcct && payAcct) {
          // Derive the next JE number from MAX(id)+1 (same pattern as credit/debit
          // note posting). The previous code referenced a non-existent sequence
          // (seq_accounting_je) whose .catch() fallback never worked — a failed
          // statement poisons the open transaction, so the fallback errored too.
          const { rows: [{ nextval }] } = await client.query(`SELECT COALESCE(MAX(id),0)+1 AS nextval FROM journal_entries`);
          const entryNumber = `JE-${new Date().getFullYear()}-${String(nextval).padStart(5,'0')}`;
          const { rows: [je] } = await client.query(
            `INSERT INTO journal_entries
               (entry_number, entry_date, entry_type, description, reference_type, reference_id, status, total_debit, total_credit, company_id, created_by)
             VALUES ($1, NOW()::date, 'ExpenseApproval', $2, 'expense_claim', $3, 'posted', $4, $4, $5, $6) RETURNING id`,
            [
              entryNumber,
              `Expense claim approved — ${expense.claim_number || req.params.id}`,
              req.params.id,
              totalAmount,
              companyId,
              req.user?.userId ?? req.user?.id ?? null,
            ]
          );
          await client.query(
            `INSERT INTO journal_lines (entry_id, account_id, account_code, account_name, debit, credit, narration, company_id)
             VALUES ($1,$2,$3,$4,$5,0,$6,$7),
                    ($1,$8,$9,$10,0,$5,$6,$7)`,
            [
              je.id,
              expAcct.id, '5022', expAcct.name, totalAmount,
              `Expense claim — ${expense.claim_number || req.params.id}`,
              companyId,
              payAcct.id, '2040', payAcct.name,
            ]
          );
          // Link journal entry back to expense claim
          await client.query(`UPDATE expense_claims SET journal_entry_id = $1 WHERE id = $2`, [je.id, req.params.id]);
        }
      }

      await client.query('COMMIT');
      logAudit({ userId: req.user?.userId, module: 'finance', recordId: req.params.id, recordType: 'expense_claim', action: 'approve', oldData: oldExpense ?? null, newData: { ...expense, actor_id: req.user?.userId, approved_at: new Date().toISOString() }, req });
      res.json(expense);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/expenses/:id/reject', requirePermission('finance', 'approve'), async (req, res) => {
  try {
    const oldExpense = await expenseRepo.findById(req.params.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const expense = await expenseRepo.reject(client, req.params.id, req.body.reason);
      await client.query('COMMIT');
      logAudit({ userId: req.user?.userId, module: 'finance', recordId: req.params.id, recordType: 'expense_claim', action: 'reject', oldData: oldExpense ?? null, newData: { ...expense, actor_id: req.user?.userId, rejected_at: new Date().toISOString(), reason: req.body.reason }, req });
      res.json(expense);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Journal & Ledger
router.get('/journal/general-ledger', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const { account_id, start_date, end_date } = req.query;
    const ledger = await journalRepo.getGeneralLedger(account_id, start_date, end_date);
    res.json(ledger);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/journal/trial-balance', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const trialBalance = await journalRepo.getTrialBalance(start_date, end_date);
    res.json(trialBalance);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reports
router.get('/reports/profit-loss', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const report = await reportsService.getProfitAndLoss(start_date, end_date);
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/reports/balance-sheet', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const { as_of_date } = req.query;
    const report = await reportsService.getBalanceSheet(as_of_date);
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/reports/cash-flow', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const report = await reportsService.getCashFlow(start_date, end_date);
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const _customerOutstandingHandler = async (req, res) => {
  try {
    const cid        = req.scope?.company_id ?? null;
    const as_of_date = req.query.as_of_date || new Date().toISOString().split('T')[0];

    const params = [as_of_date];
    let companyClause = '';
    if (cid != null) {
      params.push(cid);
      companyClause = `AND i.company_id = $${params.length}`;
    }

    const { rows } = await pool.query(`
      SELECT
        i.id,
        i.invoice_number,
        TO_CHAR(i.invoice_date, 'YYYY-MM-DD')                   AS invoice_date,
        TO_CHAR(i.due_date,     'YYYY-MM-DD')                   AS due_date,
        COALESCE(p.name, i.party_name)                          AS customer_name,
        COALESCE(i.customer_id, i.party_id)                     AS customer_id,
        i.total_amount::NUMERIC                                 AS total_amount,
        COALESCE(i.paid_amount, 0)::NUMERIC                     AS paid_amount,
        (i.total_amount - COALESCE(i.paid_amount, 0))::NUMERIC  AS balance,
        ($1::date - i.due_date)                  AS ageing_days,
        CASE
          WHEN ($1::date - i.due_date) <= 0  THEN 'current'
          WHEN ($1::date - i.due_date) <= 30 THEN '1-30'
          WHEN ($1::date - i.due_date) <= 60 THEN '31-60'
          WHEN ($1::date - i.due_date) <= 90 THEN '61-90'
          ELSE '90+'
        END AS ageing_bucket
      FROM invoices i
      LEFT JOIN parties p ON p.id = COALESCE(i.customer_id, i.party_id)
      WHERE i.deleted_at IS NULL
        AND LOWER(COALESCE(i.status, 'draft')) NOT IN ('paid', 'cancelled', 'void', 'cancel')
        AND i.invoice_date <= $1
        ${companyClause}
        AND (i.total_amount - COALESCE(i.paid_amount, 0)) > 0
      ORDER BY ageing_days DESC
    `, params);

    const summary = rows.reduce((acc, r) => {
      const b = parseFloat(r.balance) || 0;
      const d = parseInt(r.ageing_days)  || 0;
      acc.total      += b;
      if      (d <= 0)  acc.current     += b;
      else if (d <= 30) acc.days_1_30   += b;
      else if (d <= 60) acc.days_31_60  += b;
      else if (d <= 90) acc.days_61_90  += b;
      else              acc.days_90plus += b;
      return acc;
    }, { total: 0, current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, days_90plus: 0 });

    res.json({ rows, summary });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
router.get('/reports/customer-outstanding', requirePermission('finance', 'view'), _customerOutstandingHandler);
router.get('/customer-outstanding',         requirePermission('finance', 'view'), _customerOutstandingHandler);

const _supplierOutstandingHandler = async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const asOfDate  = req.query.as_of_date || new Date().toISOString().split('T')[0];
    const report    = await reportsService.getSupplierOutstanding(companyId, asOfDate);
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
router.get('/reports/supplier-outstanding', requirePermission('finance', 'view'), _supplierOutstandingHandler);
router.get('/supplier-outstanding',         requirePermission('finance', 'view'), _supplierOutstandingHandler);

router.get('/dashboard', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const dashboard = await reportsService.getFinanceDashboard({
      fyStart: req.query.fyStart,
      fyEnd:   req.query.fyEnd,
    });
    res.json(dashboard);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/dashboard/charts', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const cid    = req.scope?.company_id ?? null;
    const cidSQL = cid != null ? ' AND company_id = $1' : '';
    const params = cid != null ? [cid] : [];

    const safeQ = async (sql, p = []) => {
      try { return (await pool.query(sql, p)).rows; } catch { return []; }
    };

    const [revRows, expRows, breakdownRows, cashInRows, cashOutRows] = await Promise.all([
      safeQ(`SELECT TO_CHAR(DATE_TRUNC('month', invoice_date), 'Mon ''YY') AS month,
                    DATE_TRUNC('month', invoice_date) AS month_ts,
                    COALESCE(SUM(total_amount), 0)::numeric AS revenue
             FROM invoices
             WHERE invoice_date >= NOW() - INTERVAL '6 months'
               AND LOWER(COALESCE(status,'')) NOT IN ('cancelled')
               AND deleted_at IS NULL${cidSQL}
             GROUP BY 1,2 ORDER BY 2`, params),

      safeQ(`SELECT TO_CHAR(DATE_TRUNC('month', bill_date), 'Mon ''YY') AS month,
                    DATE_TRUNC('month', bill_date) AS month_ts,
                    COALESCE(SUM(total_amount), 0)::numeric AS expenses
             FROM bills
             WHERE bill_date >= NOW() - INTERVAL '6 months'
               AND LOWER(COALESCE(status,'')) NOT IN ('cancelled')
               AND deleted_at IS NULL${cidSQL}
             GROUP BY 1,2 ORDER BY 2`, params),

      // Expense breakdown: group bill_items by description for current month
      cid != null
        ? safeQ(`SELECT COALESCE(bi.description, 'Other') AS name,
                        COALESCE(SUM(bi.amount), 0)::numeric AS value
                 FROM bill_items bi
                 JOIN bills b ON b.id = bi.bill_id
                 WHERE b.bill_date >= DATE_TRUNC('month', NOW())
                   AND b.deleted_at IS NULL
                   AND b.company_id = $1
                 GROUP BY bi.description ORDER BY value DESC LIMIT 8`, [cid])
        : safeQ(`SELECT COALESCE(bi.description, 'Other') AS name,
                        COALESCE(SUM(bi.amount), 0)::numeric AS value
                 FROM bill_items bi
                 JOIN bills b ON b.id = bi.bill_id
                 WHERE b.bill_date >= DATE_TRUNC('month', NOW())
                   AND b.deleted_at IS NULL
                 GROUP BY bi.description ORDER BY value DESC LIMIT 8`, []),

      // Cash inflow: receipts by month (receipt_date or payment_date column)
      safeQ(`SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon ''YY') AS month,
                    DATE_TRUNC('month', created_at) AS month_ts,
                    COALESCE(SUM(amount), 0)::numeric AS inflow
             FROM receipts
             WHERE created_at >= NOW() - INTERVAL '6 months'
             GROUP BY 1,2 ORDER BY 2`, []),

      // Cash outflow: payments by month
      safeQ(`SELECT TO_CHAR(DATE_TRUNC('month', payment_date), 'Mon ''YY') AS month,
                    DATE_TRUNC('month', payment_date) AS month_ts,
                    COALESCE(SUM(amount), 0)::numeric AS outflow
             FROM payments
             WHERE payment_date >= NOW() - INTERVAL '6 months'
             GROUP BY 1,2 ORDER BY 2`, []),
    ]);

    // Merge revenue + expenses into one array keyed by month label
    const monthMap = new Map();
    for (const r of revRows) {
      monthMap.set(r.month, { month: r.month, revenue: parseFloat(r.revenue) || 0, expenses: 0 });
    }
    for (const r of expRows) {
      const existing = monthMap.get(r.month) || { month: r.month, revenue: 0, expenses: 0 };
      monthMap.set(r.month, { ...existing, expenses: parseFloat(r.expenses) || 0 });
    }
    const revenueExpenses = [...monthMap.values()];

    // Merge inflow + outflow into cash flow array
    const cfMap = new Map();
    for (const r of cashInRows)  cfMap.set(r.month, { month: r.month, inflow: parseFloat(r.inflow) || 0, outflow: 0 });
    for (const r of cashOutRows) {
      const existing = cfMap.get(r.month) || { month: r.month, inflow: 0, outflow: 0 };
      cfMap.set(r.month, { ...existing, outflow: parseFloat(r.outflow) || 0 });
    }
    const cashFlow = [...cfMap.values()];

    // Fallback: if no receipt/payment data, derive cash flow from rev/exp
    const effectiveCashFlow = cashFlow.length > 0 ? cashFlow
      : revenueExpenses.map(m => ({ month: m.month, inflow: m.revenue, outflow: m.expenses }));

    const expBreakdown = breakdownRows.length > 0
      ? breakdownRows.map(r => ({ name: r.name || 'Other', value: parseFloat(r.value) || 0 }))
      : [];

    res.json({ revenueExpenses, expenseBreakdown: expBreakdown, cashFlow: effectiveCashFlow });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Document-number sequences ─────────────────────────────────────────────────
// Create seq_jv once (Journal Vouchers — distinct from accounting JE counter)
(async () => {
  try {
    await pool.query(`CREATE SEQUENCE IF NOT EXISTS seq_jv START 1 INCREMENT BY 1 NO CYCLE`);
  } catch (e) {
    console.error('[finance] seq_jv init failed:', e.message);
  }
})();

router.get('/next-journal-voucher', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT nextval('seq_jv')::INT AS n`);
    const year = new Date().getFullYear();
    res.json({ reference: `JV-${year}-${String(rows[0].n).padStart(4, '0')}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/next-payment-batch-ref', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT nextval('seq_pb')::INT AS n`);
    const year = new Date().getFullYear();
    res.json({ reference: `PB-${year}-${String(rows[0].n).padStart(4, '0')}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
