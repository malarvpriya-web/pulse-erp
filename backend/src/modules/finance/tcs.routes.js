// backend/src/modules/finance/tcs.routes.js
// Tax Collected at Source (TCS, Section 206C). Mirrors the TDS module.
// Seller collects TCS from the buyer (collectee); returns filed via Form 27EQ,
// certificate issued as Form 27D.
import express from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';

const router = express.Router();
router.use(requirePermission('finance', 'view'));

// ── TCS section master (Section 206C sub-sections) ─────────────────────────────
// rate_with_pan / rate_without_pan in percent; threshold = per-buyer annual limit.
const TCS_SECTIONS = {
  '206C(1)-scrap':   { description: 'Sale of scrap',                         rate_with_pan: 1,   rate_without_pan: 2,  threshold: 0 },
  '206C(1)-tendu':   { description: 'Tendu leaves',                          rate_with_pan: 5,   rate_without_pan: 10, threshold: 0 },
  '206C(1)-timber':  { description: 'Timber / forest produce',              rate_with_pan: 2.5, rate_without_pan: 5,  threshold: 0 },
  '206C(1)-minerals':{ description: 'Minerals (coal, lignite, iron ore)',   rate_with_pan: 1,   rate_without_pan: 2,  threshold: 0 },
  '206C(1C)':        { description: 'Parking lot / toll plaza / mining lease', rate_with_pan: 2, rate_without_pan: 4,  threshold: 0 },
  '206C(1F)':        { description: 'Sale of motor vehicle (> ₹10L)',       rate_with_pan: 1,   rate_without_pan: 1,  threshold: 1000000 },
  '206C(1G)':        { description: 'Overseas tour package / LRS remittance', rate_with_pan: 5, rate_without_pan: 10, threshold: 700000 },
  '206C(1H)':        { description: 'Sale of goods (> ₹50L/yr)',            rate_with_pan: 0.1, rate_without_pan: 1,  threshold: 5000000, note: 'Applies when receipts from a single buyer cross ₹50L in an FY; seller turnover must exceed ₹10Cr.' },
};

function currentFY() {
  const now = new Date();
  const yr = now.getFullYear();
  const mo = now.getMonth() + 1;
  return mo >= 4 ? `${yr}-${yr + 1}` : `${yr - 1}-${yr}`;
}

function quarterOf(dateStr) {
  const mo = new Date(dateStr).getMonth() + 1;
  if (mo >= 4 && mo <= 6)   return 'Q1';
  if (mo >= 7 && mo <= 9)   return 'Q2';
  if (mo >= 10 && mo <= 12) return 'Q3';
  return 'Q4';
}

function maskPAN(pan) {
  if (!pan || pan.length < 5) return pan;
  return pan[0] + pan[1] + '*'.repeat(pan.length - 3) + pan[pan.length - 1];
}

const scopeCid = req => companyOf(req) ?? req.scope?.company_id ?? null;

// ── GET /sections ──────────────────────────────────────────────────────────────
router.get('/sections', (req, res) => res.json(TCS_SECTIONS));

// ── GET /collectees ────────────────────────────────────────────────────────────
router.get('/collectees', async (req, res) => {
  const companyId = scopeCid(req);
  try {
    const { rows } = await pool.query(`
      SELECT c.*,
        COALESCE(SUM(t.total_tcs), 0)       AS tcs_this_fy,
        COALESCE(SUM(t.receipt_amount), 0)  AS receipts_this_fy,
        COUNT(t.id)                          AS transaction_count
      FROM tcs_collectees c
      LEFT JOIN tcs_transactions t
        ON t.collectee_id = c.id AND t.financial_year = $1
      WHERE c.is_active = true AND (c.company_id = $2 OR $2 IS NULL)
      GROUP BY c.id
      ORDER BY c.party_name
    `, [currentFY(), companyId]);
    return res.json(rows.map(r => ({ ...r, pan: maskPAN(r.pan) })));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /collectees ───────────────────────────────────────────────────────────
router.post('/collectees', requirePermission('finance', 'add'), async (req, res) => {
  const { party_id, party_name, pan, collectee_type, section, threshold_limit, rate_with_pan, rate_without_pan } = req.body;
  const companyId = scopeCid(req);
  const secData = TCS_SECTIONS[section] || {};
  try {
    const { rows: [row] } = await pool.query(`
      INSERT INTO tcs_collectees
        (party_id, party_name, pan, collectee_type, section, threshold_limit, rate_with_pan, rate_without_pan, company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [party_id || null, party_name, pan || null, collectee_type || 'company', section,
        parseFloat(threshold_limit) || secData.threshold || 5000000,
        parseFloat(rate_with_pan)    || secData.rate_with_pan || 0.1,
        parseFloat(rate_without_pan) || secData.rate_without_pan || 1, companyId]);
    return res.status(201).json(row);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── PUT /collectees/:id ────────────────────────────────────────────────────────
router.put('/collectees/:id', requirePermission('finance', 'edit'), async (req, res) => {
  const { party_name, pan, collectee_type, section, threshold_limit, rate_with_pan, rate_without_pan, is_active } = req.body;
  const companyId = scopeCid(req);
  try {
    const { rows: [row] } = await pool.query(`
      UPDATE tcs_collectees
      SET party_name=$1, pan=$2, collectee_type=$3, section=$4,
          threshold_limit=$5, rate_with_pan=$6, rate_without_pan=$7, is_active=$8
      WHERE id=$9 AND (company_id=$10 OR $10 IS NULL) RETURNING *
    `, [party_name, pan, collectee_type, section,
        parseFloat(threshold_limit), parseFloat(rate_with_pan), parseFloat(rate_without_pan),
        is_active !== undefined ? is_active : true, req.params.id, companyId]);
    if (!row) return res.status(404).json({ error: 'Collectee not found' });
    return res.json(row);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /transactions ──────────────────────────────────────────────────────────
router.get('/transactions', async (req, res) => {
  const { collectee_id, quarter, financial_year, deposited } = req.query;
  const companyId = scopeCid(req);
  try {
    let query = `
      SELECT t.*, c.party_name, c.pan
      FROM tcs_transactions t
      LEFT JOIN tcs_collectees c ON c.id = t.collectee_id
      WHERE (t.company_id = $1 OR $1 IS NULL)
    `;
    const params = [companyId];
    if (collectee_id)   { params.push(collectee_id);   query += ` AND t.collectee_id = $${params.length}`; }
    if (quarter)        { params.push(quarter);        query += ` AND t.quarter = $${params.length}`; }
    if (financial_year) { params.push(financial_year); query += ` AND t.financial_year = $${params.length}`; }
    if (deposited !== undefined && deposited !== '') {
      params.push(deposited === 'true');
      query += ` AND t.deposited = $${params.length}`;
    }
    query += ' ORDER BY t.receipt_date DESC';
    const { rows } = await pool.query(query, params);
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /compute — threshold-aware TCS calculation ────────────────────────────
router.post('/compute', async (req, res) => {
  const { collectee_id, receipt_amount, receipt_date } = req.body;
  const companyId = scopeCid(req);
  try {
    const amount = parseFloat(receipt_amount);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: 'Invalid receipt_amount. It must be a non-negative number.' });
    }
    const effectiveDate = receipt_date || new Date().toISOString().split('T')[0];
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(effectiveDate));
    if (!parts) return res.status(400).json({ error: 'Invalid receipt_date. Expected YYYY-MM-DD.' });
    const y = parseInt(parts[1], 10), m = parseInt(parts[2], 10);

    const { rows: [collectee] } = await pool.query(
      'SELECT * FROM tcs_collectees WHERE id = $1 AND (company_id = $2 OR $2 IS NULL)', [collectee_id, companyId]
    );
    if (!collectee) return res.status(404).json({ error: 'Collectee not found' });

    const fyStartYear = m >= 4 ? y : y - 1;
    const fy = `${fyStartYear}-${fyStartYear + 1}`;
    const { rows: [cumRow] } = await pool.query(`
      SELECT COALESCE(SUM(receipt_amount), 0) AS cumulative
      FROM tcs_transactions
      WHERE collectee_id = $1 AND financial_year = $2 AND receipt_date <= $3 AND (company_id = $4 OR $4 IS NULL)
    `, [collectee_id, fy, effectiveDate, companyId]);

    const cumulativeThisFy = parseFloat(cumRow.cumulative);
    const threshold = parseFloat(collectee.threshold_limit);
    const hasPan = !!(collectee.pan && collectee.pan.trim());
    const tcsRate = hasPan ? parseFloat(collectee.rate_with_pan) : parseFloat(collectee.rate_without_pan);

    let taxableBase = amount;
    let breakdownNote = '';
    if (cumulativeThisFy < threshold) {
      const remaining = threshold - cumulativeThisFy;
      if (amount <= remaining) {
        taxableBase = 0;
        breakdownNote = `Within threshold. Cumulative (₹${cumulativeThisFy}) + this receipt (₹${amount}) ≤ ₹${threshold}. No TCS.`;
      } else {
        taxableBase = amount - remaining;
        breakdownNote = `Only ₹${taxableBase} (amount exceeding threshold) is subject to TCS.`;
      }
    } else {
      breakdownNote = `Threshold already crossed (cumulative ₹${cumulativeThisFy}). Entire receipt subject to TCS.`;
    }

    const tcsAmount = Math.round(taxableBase * tcsRate / 100 * 100) / 100;
    // Surcharge/cess generally not applicable to resident TCS; kept 0 for parity with return format.
    const surcharge = 0;
    const educationCess = 0;
    const totalTcs = tcsAmount + surcharge + educationCess;

    return res.json({
      collectee,
      receipt_amount: amount,
      cumulative_this_fy: cumulativeThisFy,
      threshold_limit: threshold,
      taxable_base: taxableBase,
      tcs_rate: tcsRate,
      tcs_amount: tcsAmount,
      surcharge,
      education_cess: educationCess,
      total_tcs: Math.round(totalTcs * 100) / 100,
      amount_collectible: Math.round((amount + totalTcs) * 100) / 100,
      pan_status: hasPan ? 'available' : 'not_available',
      section: collectee.section,
      breakdown_note: breakdownNote,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /transactions ─────────────────────────────────────────────────────────
router.post('/transactions', requirePermission('finance', 'add'), async (req, res) => {
  const {
    collectee_id, party_id, invoice_id, section, receipt_date, receipt_amount,
    tcs_rate, tcs_amount, surcharge = 0, education_cess = 0, challan_number,
    challan_date, bsr_code, deposited = false, financial_year,
  } = req.body;
  const companyId = scopeCid(req);
  try {
    const fy = financial_year || currentFY();
    const qtr = quarterOf(receipt_date);
    const totalTcs = parseFloat(tcs_amount) + parseFloat(surcharge) + parseFloat(education_cess);
    const { rows: [row] } = await pool.query(`
      INSERT INTO tcs_transactions
        (collectee_id, party_id, invoice_id, section, receipt_date, receipt_amount, tcs_rate, tcs_amount,
         surcharge, education_cess, total_tcs, challan_number, challan_date, bsr_code,
         deposited, quarter, financial_year, company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING *
    `, [collectee_id, party_id || null, invoice_id || null, section, receipt_date,
        parseFloat(receipt_amount), parseFloat(tcs_rate), parseFloat(tcs_amount),
        parseFloat(surcharge), parseFloat(education_cess), totalTcs,
        challan_number || null, challan_date || null, bsr_code || null,
        deposited, qtr, fy, companyId]);
    return res.status(201).json(row);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /transactions/:id/mark-deposited ──────────────────────────────────────
router.post('/transactions/:id/mark-deposited', requirePermission('finance', 'edit'), async (req, res) => {
  const { challan_number, challan_date, bsr_code } = req.body;
  try {
    const { rows: [row] } = await pool.query(`
      UPDATE tcs_transactions
      SET deposited=true, challan_number=$1, challan_date=$2, bsr_code=$3
      WHERE id=$4 RETURNING *
    `, [challan_number, challan_date, bsr_code, req.params.id]);
    if (!row) return res.status(404).json({ error: 'Transaction not found' });
    return res.json(row);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /quarterly-summary ─────────────────────────────────────────────────────
router.get('/quarterly-summary', async (req, res) => {
  const fy = req.query.financial_year || currentFY();
  const companyId = scopeCid(req);
  try {
    const { rows: byQuarter } = await pool.query(`
      SELECT quarter,
        COALESCE(SUM(receipt_amount), 0) AS total_receipt,
        COALESCE(SUM(total_tcs), 0)      AS total_tcs_collected,
        COALESCE(SUM(CASE WHEN deposited THEN total_tcs ELSE 0 END), 0)  AS total_deposited,
        COALESCE(SUM(CASE WHEN NOT deposited THEN total_tcs ELSE 0 END), 0) AS pending_deposit
      FROM tcs_transactions
      WHERE financial_year = $1 AND (company_id = $2 OR $2 IS NULL)
      GROUP BY quarter ORDER BY quarter
    `, [fy, companyId]);

    const { rows: bySection } = await pool.query(`
      SELECT section, quarter,
        COALESCE(SUM(receipt_amount), 0) AS total_receipt,
        COALESCE(SUM(total_tcs), 0)      AS total_tcs
      FROM tcs_transactions
      WHERE financial_year = $1 AND (company_id = $2 OR $2 IS NULL)
      GROUP BY section, quarter ORDER BY section, quarter
    `, [fy, companyId]);

    return res.json({
      financial_year: fy,
      by_quarter: byQuarter,
      by_section: bySection,
      total_tcs_collected: byQuarter.reduce((s, r) => s + parseFloat(r.total_tcs_collected), 0),
      total_deposited:     byQuarter.reduce((s, r) => s + parseFloat(r.total_deposited), 0),
      pending_amount:      byQuarter.reduce((s, r) => s + parseFloat(r.pending_deposit), 0),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /form27eq — structured data for Form 27EQ quarterly return ─────────────
router.get('/form27eq', async (req, res) => {
  const { financial_year, quarter } = req.query;
  const fy  = financial_year || currentFY();
  const qtr = quarter;
  const companyId = scopeCid(req);
  try {
    const { rows: txns } = await pool.query(`
      SELECT t.*, c.party_name AS collectee_name, c.pan AS collectee_pan, c.collectee_type
      FROM tcs_transactions t
      LEFT JOIN tcs_collectees c ON c.id = t.collectee_id
      WHERE t.financial_year = $1
        AND ($2::varchar IS NULL OR t.quarter = $2)
        AND (t.company_id = $3 OR $3 IS NULL)
      ORDER BY t.quarter, t.section, t.receipt_date
    `, [fy, qtr || null, companyId]);

    const quarterMap = {};
    for (const t of txns) {
      if (!quarterMap[t.quarter]) quarterMap[t.quarter] = { quarter: t.quarter, sections: {}, totals: { receipt: 0, tcs: 0 } };
      if (!quarterMap[t.quarter].sections[t.section]) quarterMap[t.quarter].sections[t.section] = [];
      quarterMap[t.quarter].sections[t.section].push({
        sno:            quarterMap[t.quarter].sections[t.section].length + 1,
        collectee_name: t.collectee_name || 'Unknown',
        collectee_pan:  t.collectee_pan  || 'PANNOTAVBL',
        collectee_type: t.collectee_type || 'company',
        receipt_date:   t.receipt_date,
        amount_received:parseFloat(t.receipt_amount || 0),
        tcs_rate:       parseFloat(t.tcs_rate || 0),
        tcs_amount:     parseFloat(t.tcs_amount || 0),
        total_tcs:      parseFloat(t.total_tcs || 0),
        challan_number: t.challan_number || '',
        challan_date:   t.challan_date   || '',
        bsr_code:       t.bsr_code       || '',
        deposited:      t.deposited,
      });
      quarterMap[t.quarter].totals.receipt += parseFloat(t.receipt_amount || 0);
      quarterMap[t.quarter].totals.tcs     += parseFloat(t.total_tcs || 0);
    }

    const quarters = Object.values(quarterMap).map(q => ({
      ...q,
      sections: Object.entries(q.sections).map(([sec, entries]) => ({
        section: sec,
        entries,
        section_total_receipt: entries.reduce((s, e) => s + e.amount_received, 0),
        section_total_tcs:     entries.reduce((s, e) => s + e.total_tcs, 0),
      })),
    }));

    return res.json({
      financial_year: fy,
      form_type: '27EQ',
      quarters,
      grand_total: {
        receipt: txns.reduce((s, t) => s + parseFloat(t.receipt_amount || 0), 0),
        tcs:     txns.reduce((s, t) => s + parseFloat(t.total_tcs || 0), 0),
      },
      instructions: 'Use this data to fill NSDL RPU software for Form 27EQ quarterly TCS return filing.',
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /form27d/generate — TCS certificate ───────────────────────────────────
router.post('/form27d/generate', requirePermission('finance', 'add'), async (req, res) => {
  const { collectee_id, financial_year, quarter } = req.body;
  const companyId = scopeCid(req);
  try {
    const fy = financial_year || currentFY();
    const { rows: [collectee] } = await pool.query('SELECT * FROM tcs_collectees WHERE id = $1', [collectee_id]);
    if (!collectee) return res.status(404).json({ error: 'Collectee not found' });

    const { rows: [company] } = await pool.query(`
      SELECT COALESCE(name,'Company Name Not Configured') AS name,
             COALESCE(address,'') AS address, COALESCE(tan,'') AS tan, COALESCE(pan,'') AS pan,
             COALESCE(city,'') AS city, COALESCE(state,'') AS state, COALESCE(pincode,'') AS pincode
      FROM companies WHERE ($1::int IS NULL OR id = $1) ORDER BY id LIMIT 1
    `, [companyId]);

    const { rows: txns } = await pool.query(`
      SELECT * FROM tcs_transactions
      WHERE collectee_id=$1 AND financial_year=$2 AND quarter=$3
      ORDER BY receipt_date
    `, [collectee_id, fy, quarter]);

    const totalReceipt = txns.reduce((s, t) => s + parseFloat(t.receipt_amount || 0), 0);
    const totalTcs     = txns.reduce((s, t) => s + parseFloat(t.total_tcs || 0), 0);
    const certNumber   = `27D/${fy}/${quarter}/${collectee_id}`;

    const certificateData = {
      certificate_number: certNumber,
      financial_year: fy,
      quarter,
      collector_details: {
        name:    company?.name    || 'Company Name Not Configured',
        address: [company?.address, company?.city, company?.state, company?.pincode].filter(Boolean).join(', '),
        tan:     company?.tan     || process.env.EMPLOYER_TAN || 'TAN_NOT_CONFIGURED',
        pan:     company?.pan     || 'PAN_NOT_CONFIGURED',
      },
      collectee: { name: collectee.party_name, pan: collectee.pan, address: 'As per records' },
      section: collectee.section,
      receipt_wise_table: txns.map((t, i) => ({
        sno: i + 1,
        receipt_date: t.receipt_date,
        amount_received: parseFloat(t.receipt_amount),
        tcs_collected: parseFloat(t.tcs_amount),
        tcs_deposited: parseFloat(t.total_tcs),
        date_of_deposit: t.challan_date,
        challan_number: t.challan_number,
        bsr_code: t.bsr_code,
      })),
      total_receipt: totalReceipt,
      total_tcs: totalTcs,
      generated_at: new Date().toISOString(),
    };

    const { rows: [cert] } = await pool.query(`
      INSERT INTO form27d_records
        (collectee_id, company_id, financial_year, quarter, certificate_number, issued_date, total_receipt, total_tcs, status, certificate_data)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'issued',$9)
      RETURNING *
    `, [collectee_id, companyId, fy, quarter, certNumber, new Date(), totalReceipt, totalTcs, JSON.stringify(certificateData)]);

    return res.status(201).json({ ...(cert || {}), certificate_data: certificateData });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /form27d ───────────────────────────────────────────────────────────────
router.get('/form27d', async (req, res) => {
  const companyId = scopeCid(req);
  try {
    const { rows } = await pool.query(`
      SELECT f.*, c.party_name, c.pan
      FROM form27d_records f
      LEFT JOIN tcs_collectees c ON c.id = f.collectee_id
      WHERE (f.company_id = $1 OR $1 IS NULL)
      ORDER BY f.created_at DESC
    `, [companyId]);
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /206c1h-tracker — cumulative receipts per buyer for 206C(1H) ───────────
router.get('/206c1h-tracker', async (req, res) => {
  const fy = req.query.financial_year || currentFY();
  const threshold = 5000000; // ₹50 lakhs
  const companyId = scopeCid(req);
  try {
    const fyStart = fy.split('-')[0];
    const startDate = `${fyStart}-04-01`;
    const endDate   = `${parseInt(fyStart) + 1}-03-31`;
    const { rows } = await pool.query(`
      SELECT
        i.customer_id                  AS party_id,
        COALESCE(p.name, 'Unknown')    AS buyer_name,
        COALESCE(p.pan, '')            AS pan,
        COALESCE(p.gstin, '')          AS gstin,
        COUNT(i.id)                    AS invoice_count,
        COALESCE(SUM(i.total_amount), 0) AS total_receipts,
        CASE WHEN COALESCE(SUM(i.total_amount), 0) >= $1 THEN true ELSE false END AS threshold_crossed,
        CASE WHEN COALESCE(SUM(i.total_amount), 0) >= $1
          THEN ROUND((COALESCE(SUM(i.total_amount), 0) - $1) * 0.001, 2) ELSE 0 END AS tcs_applicable,
        COALESCE((SELECT SUM(t.tcs_amount) FROM tcs_transactions t
                  WHERE t.party_id = i.customer_id AND t.section = '206C(1H)' AND t.financial_year = $2), 0) AS tcs_already_collected
      FROM invoices i
      LEFT JOIN parties p ON p.id = i.customer_id
      WHERE i.invoice_date BETWEEN $3 AND $4
        AND i.deleted_at IS NULL
        AND i.customer_id IS NOT NULL
        AND ($5::int IS NULL OR i.company_id = $5)
      GROUP BY i.customer_id, p.name, p.pan, p.gstin
      ORDER BY total_receipts DESC
    `, [threshold, fy, startDate, endDate, companyId]);

    return res.json({
      financial_year: fy,
      threshold_limit: threshold,
      buyers: rows.map(r => ({
        ...r,
        total_receipts:        parseFloat(r.total_receipts),
        tcs_applicable:        parseFloat(r.tcs_applicable),
        tcs_already_collected: parseFloat(r.tcs_already_collected),
        tcs_balance_due:       Math.max(0, parseFloat(r.tcs_applicable) - parseFloat(r.tcs_already_collected)),
      })),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
