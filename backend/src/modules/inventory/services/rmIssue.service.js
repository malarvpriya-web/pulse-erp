import pool from '../../shared/db.js';
import { authorizeIssue } from './stockAvailability.service.js';
import rmIssueRepo from '../repositories/rmIssue.repository.js';
import stockLedgerRepo from '../repositories/stockLedger.repository.js';

class RMIssueService {
  // employeeId feeds stock_ledger.created_by, which FKs to employees(id) — not users(id).
  // companyId: the caller's company, or null for a super admin's global scope
  // (the issue then takes the warehouse's company). Required.
  async createIssue(data, employeeId, companyId) {
    if (!Array.isArray(data.items) || data.items.length === 0) {
      throw Object.assign(new Error('An RM issue needs at least one item line'), { status: 422 });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Before anything is written: the warehouse and every item must belong
      // to one company, which is the company the issue is filed under.
      const issueCompanyId = await rmIssueRepo.resolveIssueOwnership(client, {
        warehouseId: data.warehouse_id,
        itemIds: data.items.map(i => i.item_id),
        companyId,
      });
      // ...and so must the issuing employee; the department must exist.
      const parties = await rmIssueRepo.resolveIssueParties(client, {
        departmentId: data.department_id,
        issuedBy: data.issued_by,
        companyId: issueCompanyId,
      });

      // Same client as the rest. A sequence is not rolled back, so a failed
      // issue still consumes its number — a gap, never a duplicate.
      const issueNumber = await rmIssueRepo.getNextNumber(client);
      const issue = await rmIssueRepo.create(client, {
        ...data,
        issue_number: issueNumber,
        company_id: issueCompanyId,   // after the spread: the body cannot choose it
        ...parties,                   // the validated department_id / issued_by
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

        // issue_id after the spread: a line naming its own issue_id used to
        // attach itself to that issue, whichever company it belonged to.
        await rmIssueRepo.createItem(client, {
          ...item,
          issue_id: issue.id,
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
          created_by: employeeId,
          company_id: issueCompanyId,
        });
      }

      await client.query('COMMIT');
      return await rmIssueRepo.findByIdInCompany(issue.id, issueCompanyId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // companyId: the caller's company, or null for a super admin's global scope.
  // Required — the repository throws if it is left out.
  async getIssues(filters, companyId) {
    return await rmIssueRepo.findAll(filters, companyId);
  }

  async getIssueById(id, companyId) {
    const issue = await rmIssueRepo.findByIdInCompany(id, companyId);
    if (issue) {
      issue.items = await rmIssueRepo.getItems(id);
    }
    return issue;
  }

  async getConsumptionTrends(startDate, endDate, companyId) {
    return await rmIssueRepo.getConsumptionTrends(startDate, endDate, companyId);
  }
}

export default new RMIssueService();
