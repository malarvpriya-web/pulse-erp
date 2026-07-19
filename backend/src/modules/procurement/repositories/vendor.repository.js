/**
 * Phase 49C — Vendor Repository
 * All DB access for vendor master, contacts, documents, bank details.
 */
import pool from '../../../config/db.js';

class VendorRepository {
  // ── VENDOR MASTER ──────────────────────────────────────────────────────────

  async findAll({ company_id, status, classification, risk_rating, vendor_type, search, is_critical, page = 1, limit = 50 } = {}) {
    const conds = ['v.deleted_at IS NULL'];
    const params = [];
    let idx = 1;

    if (company_id) { conds.push(`(v.company_id=$${idx++} OR v.company_id IS NULL)`); params.push(company_id); }
    if (status)        { conds.push(`v.status=$${idx++}`); params.push(status); }
    if (classification){ conds.push(`v.classification=$${idx++}`); params.push(classification); }
    if (risk_rating)   { conds.push(`v.risk_rating=$${idx++}`); params.push(risk_rating); }
    if (vendor_type)   { conds.push(`v.vendor_type=$${idx++}`); params.push(vendor_type); }
    if (is_critical === 'true') { conds.push(`v.is_critical_supplier=true`); }
    if (search) {
      conds.push(`(v.vendor_name ILIKE $${idx} OR v.vendor_code ILIKE $${idx} OR v.gstin ILIKE $${idx} OR v.pan ILIKE $${idx} OR v.city ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

    const where = `WHERE ${conds.join(' AND ')}`;
    const offset = (Number(page) - 1) * Number(limit);

    const [{ rows }, { rows: [{ total }] }] = await Promise.all([
      pool.query(`
        SELECT v.*,
               vc.name AS primary_contact, vc.email AS contact_email, vc.phone AS contact_phone,
               vb.bank_name, vb.account_number, vb.ifsc,
               (SELECT overall_score FROM vendor_scorecards WHERE vendor_id=v.id ORDER BY period_year DESC, period_quarter DESC LIMIT 1) AS latest_score
        FROM vendors v
        LEFT JOIN vendor_contacts vc ON vc.vendor_id=v.id AND vc.is_primary=true
        LEFT JOIN vendor_bank_details vb ON vb.vendor_id=v.id AND vb.is_primary=true
        ${where}
        ORDER BY v.vendor_name ASC
        LIMIT $${idx++} OFFSET $${idx++}
      `, [...params, limit, offset]),
      pool.query(`SELECT COUNT(*) AS total FROM vendors v ${where}`, params),
    ]);

    return { vendors: rows, total: Number(total) };
  }

  async findById(id) {
    const { rows: [vendor] } = await pool.query(`SELECT * FROM vendors WHERE id=$1 AND deleted_at IS NULL`, [id]);
    if (!vendor) return null;

    const [
      { rows: contacts },
      { rows: documents },
      { rows: banks },
      { rows: scorecards },
      { rows: risks },
      { rows: ncrs },
    ] = await Promise.all([
      pool.query(`SELECT * FROM vendor_contacts WHERE vendor_id=$1 ORDER BY is_primary DESC, contact_type`, [id]),
      pool.query(`SELECT * FROM vendor_documents WHERE vendor_id=$1 ORDER BY doc_type, created_at DESC`, [id]),
      pool.query(`SELECT * FROM vendor_bank_details WHERE vendor_id=$1 ORDER BY is_primary DESC`, [id]),
      pool.query(`SELECT * FROM vendor_scorecards WHERE vendor_id=$1 ORDER BY period_year DESC, period_quarter DESC LIMIT 8`, [id]),
      pool.query(`SELECT * FROM vendor_risk_assessments WHERE vendor_id=$1 ORDER BY assessment_date DESC LIMIT 4`, [id]),
      pool.query(`SELECT * FROM vendor_ncr WHERE vendor_id=$1 ORDER BY ncr_date DESC LIMIT 10`, [id]),
    ]);

    return { ...vendor, contacts, documents, banks, scorecards, risks, ncrs };
  }

  async create(client, data) {
    const {
      vendor_name, category, vendor_type, vendor_code,
      gstin, pan, udyam_number, msme_status, iec, cin, website,
      address, city, state, country, postal_code,
      contact_person, email, phone,
      annual_turnover, employee_count, year_established,
      bank_name, account_number, ifsc,
      classification, risk_score, risk_rating,
      approved_by, registration_id, company_id,
    } = data;

    const { rows: [v] } = await (client || pool).query(`
      INSERT INTO vendors (
        vendor_name, category, vendor_type, vendor_category, vendor_code,
        gstin, pan, udyam_number, msme_status, iec, cin, website,
        address, city, state, country, postal_code,
        contact_person, email, phone,
        annual_turnover, employee_count, year_established,
        bank_name, account_number, ifsc,
        status, classification,
        risk_score, risk_rating,
        approved_by, approved_at, registration_id, company_id
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
        'Active',$27,$28,$29,$30,NOW(),$31,$32
      ) RETURNING *
    `, [
      vendor_name, category || vendor_type, vendor_type, vendor_type, vendor_code,
      gstin, pan, udyam_number, msme_status || false, iec, cin, website,
      address, city, state, country || 'India', postal_code,
      contact_person, email, phone,
      annual_turnover || null, employee_count || null, year_established || null,
      bank_name, account_number, ifsc,
      classification || 'Approved', risk_score || 0, risk_rating || 'Medium',
      approved_by, registration_id, company_id,
    ]);
    return v;
  }

  async update(id, data) {
    const fields = [];
    const params = [];
    let idx = 1;

    const allowedFields = [
      'vendor_name', 'category', 'vendor_type', 'vendor_category',
      'gstin', 'pan', 'udyam_number', 'msme_status', 'iec', 'cin', 'website',
      'address', 'city', 'state', 'country', 'postal_code',
      'contact_person', 'email', 'phone',
      'annual_turnover', 'employee_count', 'year_established',
      'bank_name', 'account_number', 'ifsc',
      'status', 'classification', 'risk_rating', 'risk_score',
      'is_critical_supplier', 'is_single_source', 'is_long_lead',
      'vendor_folder_id', 'vendor_folder_url',
      'factory_locations', 'office_locations',
    ];

    for (const [key, val] of Object.entries(data)) {
      if (allowedFields.includes(key) && val !== undefined) {
        fields.push(`${key}=$${idx++}`);
        params.push(val);
      }
    }

    if (!fields.length) throw new Error('No updatable fields provided');
    params.push(id);

    const { rows: [v] } = await pool.query(
      `UPDATE vendors SET ${fields.join(', ')}, updated_at=NOW() WHERE id=$${idx} RETURNING *`,
      params
    );
    return v;
  }

  async softDelete(id) {
    await pool.query(`UPDATE vendors SET deleted_at=NOW(), status='Inactive', updated_at=NOW() WHERE id=$1`, [id]);
  }

  // ── STATS ─────────────────────────────────────────────────────────────────

  async getStats(company_id) {
    const cf = company_id ? `WHERE (company_id=$1 OR company_id IS NULL)` : '';
    const params = company_id ? [company_id] : [];
    const { rows: [stats] } = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status='Active') AS active,
        COUNT(*) FILTER (WHERE classification='Preferred') AS preferred,
        COUNT(*) FILTER (WHERE classification='Watchlist') AS watchlist,
        COUNT(*) FILTER (WHERE classification='Blocked' OR status='Blocked') AS blocked,
        COUNT(*) FILTER (WHERE risk_rating IN ('High','Critical')) AS high_risk,
        COUNT(*) FILTER (WHERE is_critical_supplier=true) AS critical_suppliers,
        COUNT(*) FILTER (WHERE is_single_source=true) AS single_source,
        COUNT(*) FILTER (WHERE is_long_lead=true) AS long_lead
      FROM vendors ${cf}
    `, params);
    return stats;
  }

  // ── VENDOR TYPES ──────────────────────────────────────────────────────────

  async getVendorTypes(company_id) {
    const cf = company_id ? `WHERE (company_id=$1 OR company_id IS NULL)` : '';
    const params = company_id ? [company_id] : [];
    const { rows } = await pool.query(
      `SELECT vendor_type AS type, COUNT(*) AS count FROM vendors ${cf} GROUP BY vendor_type ORDER BY count DESC`,
      params
    );
    return rows;
  }

  // ── SEARCH ─────────────────────────────────────────────────────────────────

  async searchByGSTIN(gstin) {
    const { rows } = await pool.query(
      `SELECT id, vendor_name, vendor_code, status FROM vendors WHERE gstin=$1 AND deleted_at IS NULL`,
      [gstin]
    );
    return rows;
  }

  async searchByPAN(pan) {
    const { rows } = await pool.query(
      `SELECT id, vendor_name, vendor_code, status FROM vendors WHERE pan=$1 AND deleted_at IS NULL`,
      [pan]
    );
    return rows;
  }
}

export default new VendorRepository();
