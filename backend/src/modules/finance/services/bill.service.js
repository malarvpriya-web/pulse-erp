import pool from '../db.js';
import billRepo from '../repositories/bill.repository.js';
import { paymentRepository } from '../repositories/payment.repository.js';
import journalRepo from '../repositories/journal.repository.js';

class BillService {
  // TDS sections applicable to common vendor categories (Income Tax Act)
  static TDS_SECTIONS = {
    professional_services: { section: '194J', rate: 10 },
    rent:                  { section: '194I', rate: 10 },
    contract:              { section: '194C', rate: 2  },
    commission:            { section: '194H', rate: 5  },
    interest:              { section: '194A', rate: 10 },
  };

  async createBill(data, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Auto-detect TDS section from vendor category when not explicitly provided
      if (!data.tds_section && data.supplier_id) {
        try {
          const { rows: [vendor] } = await client.query(
            `SELECT category FROM parties WHERE id = $1 LIMIT 1`,
            [data.supplier_id]
          );
          const tdsConfig = BillService.TDS_SECTIONS[vendor?.category];
          if (tdsConfig) {
            const billAmount = parseFloat(data.total_amount || data.amount || 0);
            const tdsAmount  = parseFloat((billAmount * tdsConfig.rate / 100).toFixed(2));
            data = {
              ...data,
              tds_section: tdsConfig.section,
              tds_rate:    tdsConfig.rate,
              tds_amount:  tdsAmount,
              net_payable: parseFloat((billAmount - tdsAmount).toFixed(2)),
            };
          }
        } catch { /* don't block bill creation if TDS auto-detect fails */ }
      }

      // Composition scheme check: if company registered as composition dealer, block ITC claim
      // (Composition dealers cannot claim Input Tax Credit per Section 10 CGST Act)
      if (data.company_id) {
        try {
          const { rows: [settings] } = await client.query(
            `SELECT settings FROM company_settings WHERE company_id = $1 AND module = 'finance' LIMIT 1`,
            [data.company_id]
          );
          const compositionScheme = settings?.settings?.composition_scheme === true
            || settings?.settings?.composition_scheme === 'true';
          if (compositionScheme && (parseFloat(data.cgst || 0) + parseFloat(data.sgst || 0) + parseFloat(data.igst || 0)) > 0) {
            // Zero out ITC fields on the bill — composition dealers expense the GST instead
            data = { ...data, itc_eligible: false };
          }
        } catch { /* don't block bill creation if settings check fails */ }
      }

      const billNumber = await billRepo.getNextNumber();
      const bill = await billRepo.create(client, {
        ...data,
        bill_number: billNumber,
        created_by: userId
      });

      for (const item of data.items) {
        await billRepo.createItem(client, { bill_id: bill.id, ...item });
      }

      await client.query('COMMIT');
      return await billRepo.findById(bill.id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async approveBill(id, userId, accountData = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const bill = await billRepo.approve(client, id, userId);

      // Try to create journal entry — use savepoint so a missing CoA never rolls back the approval
      await client.query('SAVEPOINT je_sp');
      try {
        const expId = accountData.expense_account_id
          || await this._findDefaultAccount(client, bill.company_id, ['5000', '5001', '5100']);
        const apId  = accountData.accounts_payable_id
          || await this._findDefaultAccount(client, bill.company_id, ['2100', '2001', '2000']);
        const taxId = (bill.tax_amount > 0)
          ? (accountData.tax_account_id || await this._findDefaultAccount(client, bill.company_id, ['2300', '1400', '2301']))
          : null;

        if (expId && apId) {
          const tdsAmount  = parseFloat(bill.tds_amount  || 0);
          const netPayable = parseFloat(bill.net_payable || bill.total_amount || 0);

          // Find TDS Payable account (CoA 2002) when TDS is deducted
          let tdsPayableId = null;
          if (tdsAmount > 0) {
            tdsPayableId = await this._findDefaultAccount(client, bill.company_id, ['2002', '2003', '2004']);
          }

          const entryNumber = await journalRepo.getNextEntryNumber();
          const journalEntry = await journalRepo.createEntry(client, {
            entry_number:   entryNumber,
            entry_date:     bill.bill_date,
            entry_type:     'Bill',
            reference_type: 'bill',
            reference_id:   bill.id,
            description:    `Bill ${bill.bill_number}`,
            created_by:     userId
          });

          await journalRepo.createLine(client, {
            journal_entry_id: journalEntry.id,
            account_id:       expId,
            description:      `Bill ${bill.bill_number}`,
            debit:            bill.subtotal,
            credit:           0
          });

          if (bill.tax_amount > 0 && taxId) {
            await journalRepo.createLine(client, {
              journal_entry_id: journalEntry.id,
              account_id:       taxId,
              description:      `Input GST on Bill ${bill.bill_number}`,
              debit:            bill.tax_amount,
              credit:           0
            });
          }

          // TDS Payable credit (if TDS deducted)
          if (tdsAmount > 0 && tdsPayableId) {
            await journalRepo.createLine(client, {
              journal_entry_id: journalEntry.id,
              account_id:       tdsPayableId,
              description:      `TDS ${bill.tds_section || ''} on Bill ${bill.bill_number}`,
              debit:            0,
              credit:           tdsAmount
            });
          }

          // Accounts Payable credit = net payable (after TDS deduction)
          await journalRepo.createLine(client, {
            journal_entry_id: journalEntry.id,
            account_id:       apId,
            description:      `Bill ${bill.bill_number}`,
            debit:            0,
            credit:           tdsAmount > 0 ? netPayable : bill.total_amount
          });

          await journalRepo.postEntry(client, journalEntry.id);
          await billRepo.linkJournalEntry(client, bill.id, journalEntry.id);

          // Record in tds_transactions register when TDS is deducted
          if (tdsAmount > 0) {
            await client.query(
              `INSERT INTO tds_transactions
                 (company_id, bill_id, party_id, section, rate, gross_amount, tds_amount, deduction_date)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT DO NOTHING`,
              [
                bill.company_id, bill.id, bill.supplier_id,
                bill.tds_section, bill.tds_rate,
                bill.total_amount, tdsAmount, bill.bill_date
              ]
            );
          }
        }
        await client.query('RELEASE SAVEPOINT je_sp');
      } catch (jeErr) {
        await client.query('ROLLBACK TO SAVEPOINT je_sp');
        console.warn('[BillService] Journal entry skipped for bill', id, '—', jeErr.message);
      }

      await client.query('COMMIT');
      return await billRepo.findById(bill.id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getBills(filters) {
    return await billRepo.findAll(filters);
  }

  async getBillById(id) {
    const bill = await billRepo.findById(id);
    if (bill) {
      bill.items = await billRepo.getItems(id);
    }
    return bill;
  }

  async getDueSoonBills(days = 7, companyId = null) {
    return await billRepo.getDueSoon(days, companyId);
  }

  // Look up a chart_of_accounts row by code, scoped to the company (falls back to global).
  // chart_of_accounts' code column is `code`, not `account_code` — this query
  // always threw before, so every caller's `|| await this._findDefaultAccount(...)`
  // fallback silently failed and the whole journal-entry attempt was swallowed
  // by the enclosing SAVEPOINT catch (expense/AP/tax/TDS lines on bill creation,
  // and AP/bank lines on payment, never posted).
  async _findDefaultAccount(client, companyId, codes) {
    const { rows } = await client.query(
      `SELECT id FROM chart_of_accounts
       WHERE code = ANY($1)
         AND (company_id = $2 OR company_id IS NULL)
         AND is_active = true
       ORDER BY company_id DESC NULLS LAST LIMIT 1`,
      [codes, companyId ?? null]
    );
    return rows[0]?.id ?? null;
  }
}

class PaymentService {
  async createPayment(data, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const paymentNumber = await paymentRepository.getNextNumber();
      const payment = await paymentRepository.create(client, {
        ...data,
        payment_number: paymentNumber,
        created_by: userId
      });

      // Allocate to bills
      let remainingAmount = data.amount;
      for (const allocation of data.allocations || []) {
        if (remainingAmount <= 0) break;
        const allocAmount = Math.min(allocation.amount, remainingAmount);
        await paymentRepository.createAllocation(client, {
          payment_id:       payment.id,
          bill_id:          allocation.bill_id,
          allocated_amount: allocAmount
        });
        await billRepo.updatePayment(client, allocation.bill_id, allocAmount);
        remainingAmount -= allocAmount;
      }

      // Try to create journal entry — use savepoint so missing accounts never roll back the payment.
      // SupplierBills.jsx never sends accounts_payable_id/bank_account_id, so this
      // used to silently no-op on every payment recorded via the standard UI —
      // AP payments updated the bill/subledger but never posted to the GL.
      // Default to the standard seeded AP (2001) / Bank (1001/1002) accounts,
      // same fallback pattern invoice.service.js uses for its revenue account.
      await client.query('SAVEPOINT je_sp');
      try {
        const apAccountId = data.accounts_payable_id
          || await billService._findDefaultAccount(client, data.company_id ?? null, ['2001']);
        const bankAccountId = data.bank_account_id
          || await billService._findDefaultAccount(client, data.company_id ?? null, ['1002', '1001']);
        if (apAccountId && bankAccountId) {
          const entryNumber = await journalRepo.getNextEntryNumber();
          const journalEntry = await journalRepo.createEntry(client, {
            entry_number:   entryNumber,
            entry_date:     data.payment_date,
            entry_type:     'Payment',
            reference_type: 'payment',
            reference_id:   payment.id,
            description:    `Payment ${paymentNumber}`,
            created_by:     userId
          });

          await journalRepo.createLine(client, {
            journal_entry_id: journalEntry.id,
            account_id:       apAccountId,
            description:      `Payment ${paymentNumber}`,
            debit:            data.amount,
            credit:           0
          });

          await journalRepo.createLine(client, {
            journal_entry_id: journalEntry.id,
            account_id:       bankAccountId,
            description:      `Payment ${paymentNumber}`,
            debit:            0,
            credit:           data.amount
          });

          await journalRepo.postEntry(client, journalEntry.id);
          await paymentRepository.linkJournalEntry(client, payment.id, journalEntry.id);
        }
        await client.query('RELEASE SAVEPOINT je_sp');
      } catch (jeErr) {
        await client.query('ROLLBACK TO SAVEPOINT je_sp');
        console.warn('[PaymentService] Journal entry skipped for payment', payment.id, '—', jeErr.message);
      }

      await client.query('COMMIT');
      return payment;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getPayments(filters) {
    return await paymentRepository.findAll(filters);
  }
}

export const billService = new BillService();
export const paymentService = new PaymentService();
