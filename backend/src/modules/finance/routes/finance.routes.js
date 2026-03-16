import express from 'express';
import pool from '../db.js';
import coaRepo from '../repositories/chartOfAccounts.repository.js';
import partiesRepo from '../repositories/parties.repository.js';
import { billService, paymentService } from '../services/bill.service.js';
import receiptService from '../services/receipt.service.js';
import expenseRepo from '../repositories/expense.repository.js';
import journalRepo from '../repositories/journal.repository.js';
import reportsService from '../services/reports.service.js';
import invoiceController from '../controllers/invoice.controller.js';

const router = express.Router();

// Chart of Accounts
router.post('/accounts', async (req, res) => {
  try {
    const account = await coaRepo.create(req.body);
    res.status(201).json(account);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/accounts', async (req, res) => {
  try {
    const accounts = await coaRepo.findAll();
    res.json(accounts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/accounts/tree', async (req, res) => {
  try {
    const tree = await coaRepo.findTree();
    res.json(tree);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/accounts/:id', async (req, res) => {
  try {
    const account = await coaRepo.update(req.params.id, req.body);
    res.json(account);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/accounts/:id', async (req, res) => {
  try {
    await coaRepo.softDelete(req.params.id);
    res.json({ message: 'Account deactivated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Parties (Customers & Suppliers)
router.post('/parties', async (req, res) => {
  try {
    const partyCode = await partiesRepo.getNextCode(req.body.party_type);
    const party = await partiesRepo.create({ ...req.body, party_code: partyCode });
    res.status(201).json(party);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/parties', async (req, res) => {
  try {
    const parties = await partiesRepo.findAll(req.query);
    res.json(parties);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/parties/:id', async (req, res) => {
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

router.get('/parties/:id/outstanding', async (req, res) => {
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

router.put('/parties/:id', async (req, res) => {
  try {
    const party = await partiesRepo.update(req.params.id, req.body);
    res.json(party);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Invoices
router.post('/invoices', invoiceController.create.bind(invoiceController));
router.get('/invoices', invoiceController.getAll.bind(invoiceController));
router.get('/invoices/overdue', invoiceController.getOverdue.bind(invoiceController));
router.get('/invoices/due-soon', invoiceController.getDueSoon.bind(invoiceController));
router.get('/invoices/:id', invoiceController.getById.bind(invoiceController));

// Bills
router.post('/bills', async (req, res) => {
  try {
    const bill = await billService.createBill(req.body, req.user.id);
    res.status(201).json(bill);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/bills', async (req, res) => {
  try {
    const bills = await billService.getBills(req.query);
    res.json(bills);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/bills/:id', async (req, res) => {
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

router.post('/bills/:id/approve', async (req, res) => {
  try {
    const bill = await billService.approveBill(req.params.id, req.user.id, req.body);
    res.json(bill);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/bills/due-soon', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const bills = await billService.getDueSoonBills(days);
    res.json(bills);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Payments
router.post('/payments', async (req, res) => {
  try {
    const payment = await paymentService.createPayment(req.body, req.user.id);
    res.status(201).json(payment);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/payments', async (req, res) => {
  try {
    const payments = await paymentService.getPayments(req.query);
    res.json(payments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Receipts
router.post('/receipts', async (req, res) => {
  try {
    const receipt = await receiptService.createReceipt(req.body, req.user.id);
    res.status(201).json(receipt);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/receipts', async (req, res) => {
  try {
    const receipts = await receiptService.getReceipts(req.query);
    res.json(receipts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Expense Claims
router.post('/expenses', async (req, res) => {
  try {    
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claimNumber = await expenseRepo.getNextNumber();
      const claim = await expenseRepo.create(client, { ...req.body, claim_number: claimNumber });
      
      for (const item of req.body.items) {
        await expenseRepo.createItem(client, { expense_claim_id: claim.id, ...item });
      }
      
      await client.query('COMMIT');
      res.status(201).json(claim);
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

router.get('/expenses', async (req, res) => {
  try {
    const expenses = await expenseRepo.findAll(req.query);
    res.json(expenses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/expenses/:id', async (req, res) => {
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

router.post('/expenses/:id/approve', async (req, res) => {
  try {    
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const expense = await expenseRepo.approve(client, req.params.id, req.user.id);
      await client.query('COMMIT');
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

router.post('/expenses/:id/reject', async (req, res) => {
  try {    
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const expense = await expenseRepo.reject(client, req.params.id, req.body.reason);
      await client.query('COMMIT');
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
router.get('/journal/general-ledger', async (req, res) => {
  try {
    const { account_id, start_date, end_date } = req.query;
    const ledger = await journalRepo.getGeneralLedger(account_id, start_date, end_date);
    res.json(ledger);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/journal/trial-balance', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const trialBalance = await journalRepo.getTrialBalance(start_date, end_date);
    res.json(trialBalance);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reports
router.get('/reports/profit-loss', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const report = await reportsService.getProfitAndLoss(start_date, end_date);
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/reports/balance-sheet', async (req, res) => {
  try {
    const { as_of_date } = req.query;
    const report = await reportsService.getBalanceSheet(as_of_date);
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/reports/cash-flow', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const report = await reportsService.getCashFlow(start_date, end_date);
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/reports/customer-outstanding', async (req, res) => {
  try {
    const report = await reportsService.getCustomerOutstanding();
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/reports/supplier-outstanding', async (req, res) => {
  try {
    const report = await reportsService.getSupplierOutstanding();
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/dashboard', async (req, res) => {
  try {
    const dashboard = await reportsService.getFinanceDashboard();
    res.json(dashboard);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
