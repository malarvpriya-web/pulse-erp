import pool from '../../shared/db.js';
import rmIssueRepo from '../repositories/rmIssue.repository.js';
import stockLedgerRepo from '../repositories/stockLedger.repository.js';

class RMIssueService {
  async createIssue(data, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const issueNumber = await rmIssueRepo.getNextNumber();
      const issue = await rmIssueRepo.create(client, {
        ...data,
        issue_number: issueNumber
      });

      for (const item of data.items) {
        // Check stock availability
        const balance = await stockLedgerRepo.getStockBalance(item.item_id, data.warehouse_id);
        if (balance < item.quantity) {
          throw new Error(`Insufficient stock for item ${item.item_id}. Available: ${balance}, Required: ${item.quantity}`);
        }

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
          created_by: userId
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
