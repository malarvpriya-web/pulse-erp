import pool from '../../shared/db.js';
import { authorizeIssue } from './stockAvailability.service.js';
import rmIssueRepo from '../repositories/rmIssue.repository.js';
import stockLedgerRepo from '../repositories/stockLedger.repository.js';

class RMIssueService {
  // employeeId feeds stock_ledger.created_by, which FKs to employees(id) — not users(id).
  async createIssue(data, employeeId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const issueNumber = await rmIssueRepo.getNextNumber();
      const issue = await rmIssueRepo.create(client, {
        ...data,
        issue_number: issueNumber
      });

      for (const item of data.items) {
        // Availability within the transaction, and reservations respected: a
        // raw-material issue draws on free stock unless the line names the
        // reservation it is spending. This used to read the bare ledger
        // balance, so an issue could take stock another order had claimed.
        await authorizeIssue(client, {
          itemId: item.item_id,
          warehouseId: data.warehouse_id,
          qty: item.quantity,
          reservationId: item.reservation_id ?? null,
        });

        await rmIssueRepo.createItem(client, {
          issue_id: issue.id,
          ...item
        });

        // Create stock ledger entry (consumption)
        await stockLedgerRepo.createEntry(client, {
          item_id: item.item_id,
          warehouse_id: data.warehouse_id,
          transaction_type: 'consumption',
          quantity_in: 0,
          quantity_out: item.quantity,
          rate: item.rate,
          reference_type: 'rm_issue',
          reference_id: issue.id,
          transaction_date: data.issue_date,
          remarks: `RM Issue ${issueNumber}`,
          created_by: employeeId
        });
      }

      await client.query('COMMIT');
      return await rmIssueRepo.findById(issue.id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getIssues(filters) {
    return await rmIssueRepo.findAll(filters);
  }

  async getIssueById(id) {
    const issue = await rmIssueRepo.findById(id);
    if (issue) {
      issue.items = await rmIssueRepo.getItems(id);
    }
    return issue;
  }

  async getConsumptionTrends(startDate, endDate) {
    return await rmIssueRepo.getConsumptionTrends(startDate, endDate);
  }
}

export default new RMIssueService();
