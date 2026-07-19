import pool from '../db.js';
import { nextPaymentBatchNumber } from '../../../shared/docNumber.js';

class PaymentBatchRepository {
  async create(data) {
    const {
      batch_number, batch_date, scheduled_date, bank_account_id, payment_mode,
      notes, created_by, company_id, payment_count, items,
    } = data;

    const result = await pool.query(
      `INSERT INTO payment_batches
         (batch_number, batch_date, scheduled_date, bank_account_id, payment_mode,
          notes, created_by, company_id, payment_count, status, total_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',0)
       RETURNING *`,
      [
        batch_number,
        batch_date || new Date().toISOString().split('T')[0],
        scheduled_date || null,
        bank_account_id || null,
        payment_mode || data.payment_method_default || 'neft',
        notes || null,
        created_by || null,
        company_id || null,
        payment_count || (items ? items.length : 0),
      ]
    );
    return result.rows[0];
  }

  async addItem(client, data) {
    const {
      batch_id, company_id, party_id, supplier_name, bill_id, bill_ref,
      amount, payment_method, reference_number, notes,
    } = data;

    const result = await client.query(
      `INSERT INTO payment_batch_items
         (batch_id, company_id, party_id, supplier_name, bill_id, bill_ref,
          amount, payment_method, reference_number, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        batch_id,
        company_id || null,
        party_id || null,
        supplier_name || null,
        bill_id || null,
        bill_ref || null,
        parseFloat(amount || 0),
        payment_method || 'neft',
        reference_number || null,
        notes || null,
      ]
    );

    await client.query(
      `UPDATE payment_batches
       SET total_amount = total_amount + $1,
           payment_count = payment_count + 1,
           updated_at = NOW()
       WHERE id = $2`,
      [parseFloat(amount || 0), batch_id]
    );

    return result.rows[0];
  }

  async findById(id) {
    const result = await pool.query(
      `SELECT pb.*,
              ba.account_name AS bank_account,
              ba.bank_name,
              ba.account_number
       FROM payment_batches pb
       LEFT JOIN bank_accounts ba ON pb.bank_account_id = ba.id
       WHERE pb.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  }

  async findAll(filters = {}) {
    const params = [];
    const where = ['1=1'];

    if (filters.company_id != null) {
      params.push(filters.company_id);
      where.push(`pb.company_id = $${params.length}`);
    }
    if (filters.status) {
      params.push(filters.status);
      where.push(`pb.status = $${params.length}`);
    }
    if (filters.search) {
      params.push(`%${filters.search}%`);
      const p = params.length;
      where.push(`(pb.batch_number ILIKE $${p} OR ba.account_name ILIKE $${p})`);
    }
    if (filters.from) {
      params.push(filters.from);
      where.push(`pb.batch_date >= $${params.length}`);
    }
    if (filters.to) {
      params.push(filters.to);
      where.push(`pb.batch_date <= $${params.length}`);
    }

    const query = `
      SELECT pb.*,
             ba.account_name AS bank_account,
             ba.bank_name,
             ba.account_number
      FROM payment_batches pb
      LEFT JOIN bank_accounts ba ON pb.bank_account_id = ba.id
      WHERE ${where.join(' AND ')}
      ORDER BY pb.batch_date DESC, pb.created_at DESC
    `;
    const result = await pool.query(query, params);
    return result.rows;
  }

  async getItems(batchId) {
    const result = await pool.query(
      `SELECT pbi.*,
              COALESCE(pbi.supplier_name, p.name) AS supplier,
              COALESCE(pbi.bill_ref, b.bill_number) AS bill_ref,
              pbi.payment_method AS method
       FROM payment_batch_items pbi
       LEFT JOIN parties p ON pbi.party_id = p.id
       LEFT JOIN bills   b ON pbi.bill_id   = b.id
       WHERE pbi.batch_id = $1
       ORDER BY pbi.created_at`,
      [batchId]
    );
    return result.rows;
  }

  async getItemsWithBankDetails(batchId) {
    const result = await pool.query(
      `SELECT pbi.*,
              COALESCE(pbi.supplier_name, p.name)     AS party_name,
              COALESCE(pbi.bill_ref, b.bill_number)   AS bill_number,
              p.bank_account                          AS account_number,
              p.ifsc                                  AS ifsc_code,
              p.bank_name
       FROM payment_batch_items pbi
       LEFT JOIN parties p ON pbi.party_id = p.id
       LEFT JOIN bills   b ON pbi.bill_id   = b.id
       WHERE pbi.batch_id = $1
       ORDER BY pbi.created_at`,
      [batchId]
    );
    return result.rows;
  }

  async updateStatus(client, id, status, userId = null) {
    let query = `UPDATE payment_batches
                 SET status = $1, updated_at = NOW()`;
    const params = [status, id];

    if (status === 'approved' && userId) {
      query += `, approved_by = $3, approved_at = NOW()`;
      params.push(userId);
    } else if (status === 'processed') {
      query += `, processed_at = NOW()`;
    } else if (status === 'rejected' && userId) {
      query += `, rejected_by = $3, rejected_at = NOW()`;
      params.push(userId);
    }

    query += ` WHERE id = $2 RETURNING *`;
    const result = await client.query(query, params);
    return result.rows[0];
  }

  async updateNeftFilePath(batchId, filePath) {
    const result = await pool.query(
      `UPDATE payment_batches SET neft_file_path = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [filePath, batchId]
    );
    return result.rows[0];
  }

  async linkPayment(client, itemId, paymentId) {
    const result = await client.query(
      `UPDATE payment_batch_items
       SET payment_id = $1, status = 'processed', updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [paymentId, itemId]
    );
    return result.rows[0];
  }

  async getNextBatchNumber() {
    return nextPaymentBatchNumber();
  }
}

export default new PaymentBatchRepository();
