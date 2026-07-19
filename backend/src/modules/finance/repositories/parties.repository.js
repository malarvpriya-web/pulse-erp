import pool from '../db.js';
import { nextCustPartyCode, nextSuppPartyCode } from '../../../shared/docNumber.js';

class PartiesRepository {
  async create(data) {
    const {
      party_code, party_type, name, contact_person, designation, email, phone, mobile,
      address, city, state, pincode, country, website,
      gstin, pan, msme_number, industry,
      tax_id, credit_limit, payment_terms, currency,
      bank_name, bank_account, ifsc,
      opening_balance, notes, is_active,
      company_id,
    } = data;

    const result = await pool.query(
      `INSERT INTO parties (
         party_code, party_type, name, contact_person, designation,
         email, phone, mobile, address, city, state, pincode, country, website,
         gstin, pan, msme_number, industry,
         tax_id, credit_limit, payment_terms, currency,
         bank_name, bank_account, ifsc,
         opening_balance, notes, is_active, company_id
       )
       VALUES (
         $1,  $2,  $3,  $4,  $5,
         $6,  $7,  $8,  $9,  $10, $11, $12, $13, $14,
         $15, $16, $17, $18,
         $19, $20, $21, $22,
         $23, $24, $25,
         $26, $27, $28, $29
       ) RETURNING *`,
      [
        party_code, party_type, name, contact_person ?? null, designation ?? null,
        email ?? null, phone ?? null, mobile ?? null, address ?? null,
        city ?? null, state ?? null, pincode ?? null, country ?? 'India', website ?? null,
        gstin ?? null, pan ?? null, msme_number ?? null, industry ?? null,
        tax_id ?? null, credit_limit ?? 0, payment_terms ?? 30, currency ?? 'INR',
        bank_name ?? null, bank_account ?? null, ifsc ?? null,
        opening_balance ?? 0, notes ?? null, is_active !== false,
        company_id ?? null,
      ]
    );
    return result.rows[0];
  }

  async findById(id) {
    const result = await pool.query(
      `SELECT p.*,
              COALESCE((
                SELECT SUM(i.balance) FROM invoices i
                WHERE i.customer_id = p.id
                  AND i.status NOT IN ('Paid','Cancelled')
                  AND (i.deleted_at IS NULL)
              ), 0) AS outstanding_balance
       FROM parties p
       WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [id]
    );
    return result.rows[0];
  }

  async findAll(filters = {}) {
    let query = `
      SELECT p.*,
             COALESCE((
               SELECT SUM(i.balance) FROM invoices i
               WHERE i.customer_id = p.id
                 AND i.status NOT IN ('Paid','Cancelled')
                 AND (i.deleted_at IS NULL)
             ), 0) AS outstanding_balance
      FROM parties p
      WHERE p.deleted_at IS NULL`;
    const params = [];

    if (filters.company_id != null) {
      params.push(filters.company_id);
      query += ` AND (p.company_id = $${params.length} OR p.company_id IS NULL)`;
    }

    if (filters.party_type) {
      params.push(filters.party_type);
      query += ` AND (p.party_type = $${params.length} OR p.party_type = 'Both')`;
    }

    if (filters.is_active !== undefined) {
      params.push(filters.is_active);
      query += ` AND p.is_active = $${params.length}`;
    }

    query += ' ORDER BY p.name';

    const result = await pool.query(query, params);
    return result.rows;
  }

  async update(id, data) {
    const {
      name, contact_person, designation, email, phone, mobile,
      address, city, state, pincode, country, website,
      gstin, pan, msme_number, industry,
      tax_id, credit_limit, payment_terms, currency,
      bank_name, bank_account, ifsc,
      opening_balance, notes, is_active,
    } = data;

    const result = await pool.query(
      `UPDATE parties
       SET name           = $1,
           contact_person = $2,
           designation    = $3,
           email          = $4,
           phone          = $5,
           mobile         = $6,
           address        = $7,
           city           = $8,
           state          = $9,
           pincode        = $10,
           country        = $11,
           website        = $12,
           gstin          = $13,
           pan            = $14,
           msme_number    = $15,
           industry       = $16,
           tax_id         = $17,
           credit_limit   = $18,
           payment_terms  = $19,
           currency       = $20,
           bank_name      = $21,
           bank_account   = $22,
           ifsc           = $23,
           opening_balance= $24,
           notes          = $25,
           is_active      = $26,
           updated_at     = CURRENT_TIMESTAMP
       WHERE id = $27 AND deleted_at IS NULL RETURNING *`,
      [
        name, contact_person ?? null, designation ?? null,
        email ?? null, phone ?? null, mobile ?? null,
        address ?? null, city ?? null, state ?? null, pincode ?? null,
        country ?? 'India', website ?? null,
        gstin ?? null, pan ?? null, msme_number ?? null, industry ?? null,
        tax_id ?? null, credit_limit ?? 0, payment_terms ?? 30, currency ?? 'INR',
        bank_name ?? null, bank_account ?? null, ifsc ?? null,
        opening_balance ?? 0, notes ?? null, is_active !== false,
        id,
      ]
    );
    return result.rows[0];
  }

  async softDelete(id) {
    const result = await pool.query(
      'UPDATE parties SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
      [id]
    );
    return result.rows[0];
  }

  async getOutstandingBalance(partyId, partyType) {
    if (partyType !== 'Supplier') {
      const result = await pool.query(
        `SELECT COALESCE(SUM(balance), 0) AS outstanding
         FROM invoices
         WHERE party_id = $1 AND status NOT IN ('Paid','Cancelled')
           AND (deleted_at IS NULL)`,
        [partyId]
      );
      return parseFloat(result.rows[0].outstanding);
    } else {
      const result = await pool.query(
        `SELECT COALESCE(SUM(balance), 0) AS outstanding
         FROM bills
         WHERE party_id = $1 AND status NOT IN ('Paid','Cancelled')
           AND (deleted_at IS NULL)`,
        [partyId]
      );
      return parseFloat(result.rows[0].outstanding);
    }
  }

  async getNextCode(partyType, client) {
    return partyType === 'Customer'
      ? nextCustPartyCode(client)
      : nextSuppPartyCode(client);
  }
}

export default new PartiesRepository();
