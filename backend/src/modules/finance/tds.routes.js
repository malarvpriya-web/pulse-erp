// backend/src/modules/finance/tds.routes.js
import express from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';

const router = express.Router();
router.use(requirePermission('finance', 'view'));

// ── Dev-only: seed sample TDS deductees — NEVER runs in production ────────────
// Fake PAN numbers (DEFGH5678J, TRNSP1234T, etc.) must not appear in a real
// company's TDS returns. Guard is intentional.
if (process.env.NODE_ENV !== 'production') {
  (async () => {
    try {
      const { rows } = await pool.query('SELECT COUNT(*) FROM tds_deductees');
      if (parseInt(rows[0].count) === 0) {
        await pool.query(`
          INSERT INTO tds_deductees (party_name, pan, deductee_type, section, threshold_limit, rate_with_pan, rate_without_pan)
          VALUES
            ('Tata Consultancy Services', 'AADCT2345K', 'company',    '194C', 30000,  2,  20),
            ('Infosys Ltd',              'AAACI1234C', 'company',     '194J', 30000,  10, 20),
            ('Rajesh Kumar',             'ABCPK1234D', 'individual',  '194J', 30000,  10, 20),
            ('Office Rent Landlord',     'DEFGH5678J', 'individual',  '194I', 240000, 10, 20),
            ('Transport Co',             'TRNSP1234T', 'company',     '194C', 30000,  1,  20)
        `);
      }
    } catch (e) { console.error('[tds.routes] Seed error:', e.message); }
  })();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function currentFY() {
  const now = new Date();
  const yr = now.getFullYear();
  const mo = now.getMonth() + 1;
  return mo >= 4 ? `${yr}-${yr + 1}` : `${yr - 1}-${yr}`;
}

function quarterOf(dateStr) {
  const mo = new Date(dateStr).getMonth() + 1;
  if (mo >= 4 && mo <= 6)  return 'Q1';
  if (mo >= 7 && mo <= 9)  return 'Q2';
  if (mo >= 10 && mo <= 12) return 'Q3';
  return 'Q4';
}

// ── GET /deductees ────────────────────────────────────────────────────────────
// Mask PAN: show first 2 + last 1 chars, rest as asterisks (e.g. AB*****1234K → AB*******K)
function maskPAN(pan) {
  if (!pan || pan.length < 5) return pan;
  return pan[0] + pan[1] + '*'.repeat(pan.length - 3) + pan[pan.length - 1];
}

router.get('/deductees', async (req, res) => {
  const companyId = companyOf(req) ?? req.scope?.company_id ?? null;
  try {
    const { rows } = await pool.query(`
      SELECT d.*,
        COALESCE(SUM(t.total_tds), 0)      AS tds_this_fy,
        COALESCE(SUM(t.payment_amount), 0) AS payments_this_fy,
        COUNT(t.id)                         AS transaction_count
      FROM tds_deductees d
      LEFT JOIN tds_transactions t
        ON t.deductee_id = d.id AND t.financial_year = $1
      WHERE d.is_active = true AND d.company_id = $2
      GROUP BY d.id
      ORDER BY d.party_name
    `, [currentFY(), companyId]);

    if (rows.length === 0) return res.json([]);
    // Mask PAN in list endpoint — full PAN only accessible via individual GET or Form 16A
    return res.json(rows.map(r => ({ ...r, pan: maskPAN(r.pan) })));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /deductees ───────────────────────────────────────────────────────────
router.post('/deductees', async (req, res) => {
  const { party_id, party_name, pan, deductee_type, section, threshold_limit, rate_with_pan, rate_without_pan } = req.body;
  const companyId = companyOf(req) ?? req.scope?.company_id ?? null;
  try {
    const { rows: [row] } = await pool.query(`
      INSERT INTO tds_deductees (party_id, party_name, pan, deductee_type, section, threshold_limit, rate_with_pan, rate_without_pan, company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [party_id || null, party_name, pan || null, deductee_type || 'company', section,
        parseFloat(threshold_limit) || 30000, parseFloat(rate_with_pan) || 10, parseFloat(rate_without_pan) || 20, companyId]);
    return res.status(201).json(row);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── PUT /deductees/:id ────────────────────────────────────────────────────────
router.put('/deductees/:id', async (req, res) => {
  const { party_name, pan, deductee_type, section, threshold_limit, rate_with_pan, rate_without_pan, is_active } = req.body;
  const companyId = companyOf(req) ?? req.scope?.company_id ?? null;
  try {
    const { rows: [row] } = await pool.query(`
      UPDATE tds_deductees
      SET party_name=$1, pan=$2, deductee_type=$3, section=$4,
          threshold_limit=$5, rate_with_pan=$6, rate_without_pan=$7, is_active=$8
      WHERE id=$9 AND company_id=$10 RETURNING *
    `, [party_name, pan, deductee_type, section,
        parseFloat(threshold_limit), parseFloat(rate_with_pan), parseFloat(rate_without_pan),
        is_active !== undefined ? is_active : true, req.params.id, companyId]);
    if (!row) return res.status(404).json({ error: 'Deductee not found' });
    return res.json(row);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /transactions ─────────────────────────────────────────────────────────
router.get('/transactions', async (req, res) => {
  const { deductee_id, quarter, financial_year, deposited } = req.query;
  const companyId = companyOf(req) ?? req.scope?.company_id ?? null;
  try {
    let query = `
      SELECT t.*, d.party_name, d.pan
      FROM tds_transactions t
      LEFT JOIN tds_deductees d ON d.id = t.deductee_id
      WHERE t.company_id = $1
    `;
    const params = [companyId];
    if (deductee_id)    { params.push(deductee_id);    query += ` AND t.deductee_id = $${params.length}`; }
    if (quarter)        { params.push(quarter);        query += ` AND t.quarter = $${params.length}`; }
    if (financial_year) { params.push(financial_year); query += ` AND t.financial_year = $${params.length}`; }
    if (deposited !== undefined && deposited !== '') {
      params.push(deposited === 'true');
      query += ` AND t.deposited = $${params.length}`;
    }
    query += ' ORDER BY t.payment_date DESC';

    const { rows } = await pool.query(query, params);
    if (rows.length === 0) {
      return res.json([]);
    }
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /transactions ────────────────────────────────────────────────────────
router.post('/transactions', async (req, res) => {
  const {
    deductee_id, party_id, section, payment_date, payment_amount,
    tds_rate, tds_amount, surcharge = 0, education_cess = 0,
    challan_number, challan_date, bsr_code, deposited = false,
    financial_year, bill_id,
  } = req.body;

  try {
    const fy = financial_year || currentFY();
    const qtr = quarterOf(payment_date);
    const totalTds = parseFloat(tds_amount) + parseFloat(surcharge) + parseFloat(education_cess);

    const companyId = companyOf(req) ?? req.scope?.company_id ?? null;
    const { rows: [row] } = await pool.query(`
      INSERT INTO tds_transactions
        (deductee_id, party_id, section, payment_date, payment_amount, tds_rate, tds_amount,
         surcharge, education_cess, total_tds, challan_number, challan_date, bsr_code,
         deposited, quarter, financial_year, bill_id, company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING *
    `, [deductee_id, party_id || null, section, payment_date,
        parseFloat(payment_amount), parseFloat(tds_rate), parseFloat(tds_amount),
        parseFloat(surcharge), parseFloat(education_cess), totalTds,
        challan_number || null, challan_date || null, bsr_code || null,
        deposited, qtr, fy, bill_id || null, companyId]);
    return res.status(201).json(row);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /compute ─────────────────────────────────────────────────────────────
router.post('/compute', async (req, res) => {
  const { deductee_id, payment_amount, payment_date } = req.body;
  const companyId = companyOf(req) ?? req.scope?.company_id ?? null;
  try {
    const amount = parseFloat(payment_amount);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: 'Invalid payment_amount. It must be a non-negative number.' });
    }

    const effectiveDate = payment_date || new Date().toISOString().split('T')[0];
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(effectiveDate));
    if (!parts) {
      return res.status(400).json({ error: 'Invalid payment_date. Expected format YYYY-MM-DD.' });
    }
    const y = parseInt(parts[1], 10);
    const m = parseInt(parts[2], 10);
    const d = parseInt(parts[3], 10);
    const dateCheck = new Date(Date.UTC(y, m - 1, d));
    if (dateCheck.getUTCFullYear() !== y || (dateCheck.getUTCMonth() + 1) !== m || dateCheck.getUTCDate() !== d) {
      return res.status(400).json({ error: 'Invalid payment_date. Expected a valid calendar date in YYYY-MM-DD format.' });
    }

    const { rows: [deductee] } = await pool.query(
      'SELECT * FROM tds_deductees WHERE id = $1 AND company_id = $2', [deductee_id, companyId]
    );
    if (!deductee) return res.status(404).json({ error: 'Deductee not found' });

    const fyStartYear = m >= 4 ? y : y - 1;
    const fy = `${fyStartYear}-${fyStartYear + 1}`;
    const { rows: [cumRow] } = await pool.query(`
      SELECT COALESCE(SUM(payment_amount), 0) AS cumulative
      FROM tds_transactions
      WHERE deductee_id = $1 AND financial_year = $2 AND payment_date <= $3 AND company_id = $4
    `, [deductee_id, fy, effectiveDate, companyId]);

    const cumulativeThisFy = parseFloat(cumRow.cumulative);
    const threshold = parseFloat(deductee.threshold_limit);
    const hasPan = !!(deductee.pan && deductee.pan.trim());
    const rateWithPan = parseFloat(deductee.rate_with_pan);
    const rateWithoutPan = parseFloat(deductee.rate_without_pan);
    if (!Number.isFinite(rateWithPan) || rateWithPan < 0 || !Number.isFinite(rateWithoutPan) || rateWithoutPan < 0) {
      return res.status(400).json({ error: 'Invalid deductee TDS rate master data. rate_with_pan and rate_without_pan must be finite non-negative numbers.' });
    }

    let tdsRate = hasPan ? rateWithPan : Math.max(20, rateWithoutPan);

    let taxableBase = amount;
    let breakdownNote = '';

    if (cumulativeThisFy < threshold) {
      const remainingBeforeThreshold = threshold - cumulativeThisFy;
      if (amount <= remainingBeforeThreshold) {
        taxableBase = 0;
        breakdownNote = `Entire payment is within threshold limit. Cumulative (₹${cumulativeThisFy}) + this payment (₹${amount}) = ₹${cumulativeThisFy + amount} which is below threshold of ₹${threshold}. No TDS applicable.`;
      } else {
        taxableBase = amount - remainingBeforeThreshold;
        breakdownNote = `Only ₹${taxableBase} (amount exceeding threshold) is subject to TDS. First ₹${remainingBeforeThreshold} is within remaining threshold.`;
      }
    } else {
      breakdownNote = `Threshold already crossed (cumulative: ₹${cumulativeThisFy}). Entire payment subject to TDS.`;
    }

    const tdsAmount = taxableBase * tdsRate / 100;
    // Surcharge applies when payment exceeds statutory thresholds
    const deducteeType = deductee.deductee_type || 'company';
    let surcharge = 0;
    if (deducteeType === 'individual' || deducteeType === 'huf') {
      if (amount > 10000000) surcharge = Math.round(tdsAmount * 0.15 * 100) / 100;
      else if (amount > 5000000) surcharge = Math.round(tdsAmount * 0.10 * 100) / 100;
    } else {
      if (amount > 100000000) surcharge = Math.round(tdsAmount * 0.12 * 100) / 100;
      else if (amount > 10000000) surcharge = Math.round(tdsAmount * 0.07 * 100) / 100;
    }
    // Education cess is 4% of (TDS + surcharge)
    const educationCess = Math.round((tdsAmount + surcharge) * 0.04 * 100) / 100;
    const totalTds = tdsAmount + surcharge + educationCess;
    const netPayment = amount - totalTds;

    return res.json({
      deductee,
      payment_amount: amount,
      cumulative_this_fy: cumulativeThisFy,
      threshold_limit: threshold,
      taxable_base: taxableBase,
      tds_rate: tdsRate,
      tds_amount: Math.round(tdsAmount * 100) / 100,
      surcharge,
      education_cess: Math.round(educationCess * 100) / 100,
      total_tds: Math.round(totalTds * 100) / 100,
      net_payment: Math.round(netPayment * 100) / 100,
      pan_status: hasPan ? 'available' : 'not_available',
      section: deductee.section,
      breakdown_note: breakdownNote,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /transactions/:id/mark-deposited ─────────────────────────────────────
router.post('/transactions/:id/mark-deposited', async (req, res) => {
  const { challan_number, challan_date, bsr_code } = req.body;
  try {
    const { rows: [row] } = await pool.query(`
      UPDATE tds_transactions
      SET deposited=true, challan_number=$1, challan_date=$2, bsr_code=$3
      WHERE id=$4 RETURNING *
    `, [challan_number, challan_date, bsr_code, req.params.id]);
    if (!row) return res.status(404).json({ error: 'Transaction not found' });
    return res.json(row);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /quarterly-summary ────────────────────────────────────────────────────
router.get('/quarterly-summary', async (req, res) => {
  const fy = req.query.financial_year || currentFY();
  const companyId = companyOf(req) ?? req.scope?.company_id ?? null;
  try {
    const { rows: byQuarter } = await pool.query(`
      SELECT
        quarter,
        COALESCE(SUM(payment_amount), 0)                        AS total_payment,
        COALESCE(SUM(total_tds), 0)                             AS total_tds_deducted,
        COALESCE(SUM(CASE WHEN deposited=true THEN total_tds ELSE 0 END), 0) AS total_deposited,
        COALESCE(SUM(CASE WHEN deposited=false THEN total_tds ELSE 0 END), 0) AS pending_deposit
      FROM tds_transactions
      WHERE financial_year = $1 AND company_id = $2
      GROUP BY quarter
      ORDER BY quarter
    `, [fy, companyId]);

    const { rows: bySection } = await pool.query(`
      SELECT
        section,
        quarter,
        COALESCE(SUM(payment_amount), 0) AS total_payment,
        COALESCE(SUM(total_tds), 0)      AS total_tds
      FROM tds_transactions
      WHERE financial_year = $1 AND company_id = $2
      GROUP BY section, quarter
      ORDER BY section, quarter
    `, [fy, companyId]);

    const totalTdsDeducted = byQuarter.reduce((s, r) => s + parseFloat(r.total_tds_deducted), 0);
    const totalDeposited   = byQuarter.reduce((s, r) => s + parseFloat(r.total_deposited), 0);
    const pendingAmount    = byQuarter.reduce((s, r) => s + parseFloat(r.pending_deposit), 0);

    if (byQuarter.length === 0) {
      return res.json({
        financial_year: fy,
        by_quarter: [],
        by_section: [],
        total_tds_deducted: 0,
        total_deposited: 0,
        pending_amount: 0,
      });
    }

    return res.json({
      financial_year: fy,
      by_quarter: byQuarter,
      by_section: bySection,
      total_tds_deducted: totalTdsDeducted,
      total_deposited: totalDeposited,
      pending_amount: pendingAmount,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /form16a/generate ────────────────────────────────────────────────────
router.post('/form16a/generate', async (req, res) => {
  const { deductee_id, financial_year, quarter } = req.body;
  try {
    const fy = financial_year || currentFY();
    const companyId = companyOf(req) ?? req.scope?.company_id ?? null;

    const { rows: [deductee] } = await pool.query(
      'SELECT * FROM tds_deductees WHERE id = $1', [deductee_id]
    );
    if (!deductee) return res.status(404).json({ error: 'Deductee not found' });

    // Fetch real company details from companies table
    const { rows: [company] } = await pool.query(`
      SELECT
        COALESCE(name, 'Company Name Not Configured') AS name,
        COALESCE(address, '')                          AS address,
        COALESCE(tan, '')                              AS tan,
        COALESCE(pan, '')                              AS pan,
        COALESCE(city, '')                             AS city,
        COALESCE(state, '')                            AS state,
        COALESCE(pincode, '')                          AS pincode
      FROM companies
      WHERE ($1::int IS NULL OR id = $1)
      ORDER BY id LIMIT 1
    `, [companyId]);

    const deductorDetails = {
      name:    company?.name    || 'Company Name Not Configured',
      address: [company?.address, company?.city, company?.state, company?.pincode].filter(Boolean).join(', '),
      tan:     company?.tan     || process.env.EMPLOYER_TAN || 'TAN_NOT_CONFIGURED',
      pan:     company?.pan     || 'PAN_NOT_CONFIGURED',
    };

    const { rows: txns } = await pool.query(`
      SELECT * FROM tds_transactions
      WHERE deductee_id=$1 AND financial_year=$2 AND quarter=$3
      ORDER BY payment_date
    `, [deductee_id, fy, quarter]);

    const totalPayment = txns.reduce((s, t) => s + parseFloat(t.payment_amount || 0), 0);
    const totalTds     = txns.reduce((s, t) => s + parseFloat(t.total_tds || 0), 0);
    const certNumber   = `16A/${fy}/${quarter}/${deductee_id}`;

    const certificateData = {
      certificate_number: certNumber,
      financial_year: fy,
      quarter,
      deductor_details: deductorDetails,
      deductee: {
        name: deductee.party_name,
        pan: deductee.pan,
        address: 'As per records',
      },
      section: deductee.section,
      payment_wise_table: txns.map((t, i) => ({
        sno: i + 1,
        payment_date: t.payment_date,
        amount_paid: parseFloat(t.payment_amount),
        tds_deducted: parseFloat(t.tds_amount),
        tds_deposited: parseFloat(t.total_tds),
        date_of_deposit: t.challan_date,
        challan_number: t.challan_number,
        bsr_code: t.bsr_code,
      })),
      challan_summary: txns.filter(t => t.deposited).map(t => ({
        challan_number: t.challan_number,
        bsr_code: t.bsr_code,
        deposit_date: t.challan_date,
        amount: parseFloat(t.total_tds),
      })),
      total_payment: totalPayment,
      total_tds,
      generated_at: new Date().toISOString(),
    };

    const { rows: [cert] } = await pool.query(`
      INSERT INTO form16a_records
        (deductee_id, financial_year, quarter, certificate_number, issued_date, total_payment, total_tds, status, certificate_data)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'issued',$8)
      ON CONFLICT DO NOTHING
      RETURNING *
    `, [deductee_id, fy, quarter, certNumber, new Date(), totalPayment, totalTds, JSON.stringify(certificateData)]);

    return res.status(201).json({ ...(cert || {}), certificate_data: certificateData });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /form16a ──────────────────────────────────────────────────────────────
router.get('/form16a', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT f.*, d.party_name, d.pan
      FROM form16a_records f
      LEFT JOIN tds_deductees d ON d.id = f.deductee_id
      ORDER BY f.created_at DESC
    `);
    if (rows.length === 0) {
      return res.json([]);
    }
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /26as-summary/:deducteeId ─────────────────────────────────────────────
router.get('/26as-summary/:deducteeId', async (req, res) => {
  const fy = req.query.financial_year || currentFY();
  try {
    const { rows: [deductee] } = await pool.query(
      'SELECT * FROM tds_deductees WHERE id=$1', [req.params.deducteeId]
    );
    const { rows: txns } = await pool.query(`
      SELECT * FROM tds_transactions
      WHERE deductee_id=$1 AND financial_year=$2
      ORDER BY quarter, payment_date
    `, [req.params.deducteeId, fy]);

    const quarterMap = {};
    for (const t of txns) {
      if (!quarterMap[t.quarter]) {
        quarterMap[t.quarter] = { quarter: t.quarter, transactions: [], total_payment: 0, total_tds: 0, deposited_amount: 0 };
      }
      quarterMap[t.quarter].transactions.push(t);
      quarterMap[t.quarter].total_payment   += parseFloat(t.payment_amount || 0);
      quarterMap[t.quarter].total_tds       += parseFloat(t.total_tds || 0);
      if (t.deposited) quarterMap[t.quarter].deposited_amount += parseFloat(t.total_tds || 0);
    }

    return res.json({
      deductee: deductee || { id: req.params.deducteeId, party_name: 'Unknown' },
      financial_year: fy,
      quarters: Object.values(quarterMap),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /compliance-calendar ──────────────────────────────────────────────────
router.get('/compliance-calendar', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const { rows: pending } = await pool.query(`
      SELECT
        EXTRACT(MONTH FROM payment_date)::INT AS payment_month,
        EXTRACT(YEAR  FROM payment_date)::INT AS payment_year,
        section,
        COALESCE(SUM(total_tds), 0) AS amount_due
      FROM tds_transactions
      WHERE deposited = false
      GROUP BY payment_month, payment_year, section
    `);

    const calendar = [];
    const seenMonths = new Set();

    for (const p of pending) {
      const paymentMonth = parseInt(p.payment_month, 10);
      const paymentYear = parseInt(p.payment_year, 10);
      const key = `${paymentYear}-${paymentMonth}-${p.section}`;
      if (seenMonths.has(key)) continue;
      seenMonths.add(key);

      let dueDate;
      if (paymentMonth === 3) {
        dueDate = new Date(paymentYear + 1, 3, 30);
      } else {
        const nextMonth = paymentMonth === 12 ? 1 : paymentMonth + 1;
        const nextYear = paymentMonth === 12 ? paymentYear + 1 : paymentYear;
        dueDate = new Date(nextYear, nextMonth - 1, 7);
      }

      dueDate.setHours(0, 0, 0, 0);
      const diffMs = dueDate.getTime() - today.getTime();
      const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      let status = 'upcoming';
      if (daysRemaining < 0) status = 'overdue';
      if (daysRemaining === 0) status = 'due_today';

      const monthNames = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      calendar.push({
        due_date: dueDate.toISOString().split('T')[0],
        description: `TDS Deposit - Section ${p.section} for ${monthNames[paymentMonth]} ${paymentYear}`,
        amount_due: parseFloat(p.amount_due),
        section: p.section,
        status,
        days_remaining: daysRemaining,
      });
    }

    const fyStartYears = new Set();
    for (const p of pending) {
      const paymentMonth = parseInt(p.payment_month, 10);
      const paymentYear = parseInt(p.payment_year, 10);
      if (!Number.isFinite(paymentMonth) || !Number.isFinite(paymentYear)) continue;
      fyStartYears.add(paymentMonth >= 4 ? paymentYear : paymentYear - 1);
    }
    if (fyStartYears.size === 0) {
      const year = today.getFullYear();
      const month = today.getMonth() + 1;
      fyStartYears.add(month >= 4 ? year : year - 1);
    }

    const quarterlyDueDates = [];
    const sortedFyStartYears = Array.from(fyStartYears).sort((a, b) => a - b);
    for (const fyStartYear of sortedFyStartYears) {
      const fyEndYear = fyStartYear + 1;
      quarterlyDueDates.push(
        { due_date: `${fyStartYear}-07-31`, description: `Form 26Q / 24Q - Q1 (Apr-Jun ${fyStartYear}) Filing Due`, amount_due: 0 },
        { due_date: `${fyStartYear}-10-31`, description: `Form 26Q / 24Q - Q2 (Jul-Sep ${fyStartYear}) Filing Due`, amount_due: 0 },
        { due_date: `${fyEndYear}-01-31`, description: `Form 26Q / 24Q - Q3 (Oct-Dec ${fyStartYear}) Filing Due`, amount_due: 0 },
        { due_date: `${fyEndYear}-05-31`, description: `Form 26Q / 24Q - Q4 (Jan-Mar ${fyEndYear}) Filing Due`, amount_due: 0 }
      );
    }

    for (const qd of quarterlyDueDates) {
      const d = new Date(qd.due_date);
      d.setHours(0, 0, 0, 0);
      const diffMs = d.getTime() - today.getTime();
      const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      let status = 'upcoming';
      if (daysRemaining < 0) status = 'overdue';
      if (daysRemaining === 0) status = 'due_today';
      calendar.push({ ...qd, status, days_remaining: daysRemaining });
    }

    if (calendar.length === 0) {
      return res.json([]);
    }

    return res.json(calendar.sort((a, b) => new Date(a.due_date) - new Date(b.due_date)));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /194q-tracker — cumulative purchase tracking per vendor per FY ────────
// Section 194Q: buyer turnover > ₹10 Cr must deduct 0.1% TDS when purchases
// from a single seller cross ₹50L (5,000,000) in a financial year.
router.get('/194q-tracker', async (req, res) => {
  const fy = req.query.financial_year || currentFY();
  const threshold = 5000000; // ₹50 lakhs
  try {
    // Aggregate purchases from bills grouped by supplier (party_id) for the FY
    const fyStart = fy.split('-')[0];
    const startDate = `${fyStart}-04-01`;
    const endDate   = `${parseInt(fyStart) + 1}-03-31`;

    const { rows } = await pool.query(`
      SELECT
        b.party_id,
        COALESCE(p.name, b.party_name, 'Unknown') AS supplier_name,
        COALESCE(p.pan, '')                              AS pan,
        COALESCE(p.gstin, '')                            AS gstin,
        COUNT(b.id)                                      AS invoice_count,
        COALESCE(SUM(b.subtotal), 0)                     AS taxable_purchases,
        COALESCE(SUM(b.total_amount), 0)                 AS total_purchases,
        CASE WHEN COALESCE(SUM(b.subtotal), 0) >= $1
          THEN true ELSE false END                        AS threshold_crossed,
        CASE WHEN COALESCE(SUM(b.subtotal), 0) >= $1
          THEN ROUND(COALESCE(SUM(b.subtotal), 0) * 0.001, 2)
          ELSE 0 END                                      AS tds_applicable,
        COALESCE(
          (SELECT SUM(t.tds_amount) FROM tds_transactions t
           WHERE t.party_id = b.party_id
             AND t.section  = '194Q'
             AND t.financial_year = $2), 0
        )                                                  AS tds_already_deducted
      FROM bills b
      LEFT JOIN parties p ON p.id::text = b.party_id::text
      WHERE b.bill_date BETWEEN $3 AND $4
        AND COALESCE(b.deleted_at::text, '') = ''
        AND b.party_id IS NOT NULL
      GROUP BY b.party_id, p.name, b.party_name, p.pan, p.gstin
      ORDER BY total_purchases DESC
    `, [threshold, fy, startDate, endDate]);

    return res.json({
      financial_year: fy,
      threshold_limit: threshold,
      vendors: rows.map(r => ({
        ...r,
        taxable_purchases:   parseFloat(r.taxable_purchases),
        total_purchases:     parseFloat(r.total_purchases),
        tds_applicable:      parseFloat(r.tds_applicable),
        tds_already_deducted:parseFloat(r.tds_already_deducted),
        tds_balance_due:     Math.max(0, parseFloat(r.tds_applicable) - parseFloat(r.tds_already_deducted)),
      })),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /form26q — structured data for Form 26Q TRACES filing ─────────────────
// Generates the quarter-wise data in the format required for NSDL RPU software.
// The frontend can use this to pre-fill the TRACES return or export to CSV/Excel.
router.get('/form26q', async (req, res) => {
  const { financial_year, quarter } = req.query;
  const fy  = financial_year || currentFY();
  const qtr = quarter;       // e.g. 'Q1', 'Q2', 'Q3', 'Q4' — if omitted, all quarters
  const companyId = companyOf(req) ?? req.scope?.company_id ?? null;

  try {
    const { rows: txns } = await pool.query(`
      SELECT
        t.id,
        t.section,
        t.payment_date,
        t.payment_amount,
        t.tds_rate,
        t.tds_amount,
        t.surcharge,
        t.education_cess,
        t.total_tds,
        t.challan_number,
        t.challan_date,
        t.bsr_code,
        t.deposited,
        t.quarter,
        t.financial_year,
        d.party_name      AS deductee_name,
        d.pan             AS deductee_pan,
        d.deductee_type,
        d.section         AS master_section
      FROM tds_transactions t
      LEFT JOIN tds_deductees d ON d.id = t.deductee_id
      WHERE t.financial_year = $1
        AND ($2::varchar IS NULL OR t.quarter = $2)
        AND t.section != '192'
        AND t.company_id = $3
      ORDER BY t.quarter, t.section, t.payment_date
    `, [fy, qtr || null, companyId]);

    // Group by quarter → section
    const quarterMap = {};
    for (const t of txns) {
      if (!quarterMap[t.quarter]) quarterMap[t.quarter] = { quarter: t.quarter, sections: {}, totals: { payment: 0, tds: 0 } };
      if (!quarterMap[t.quarter].sections[t.section]) quarterMap[t.quarter].sections[t.section] = [];
      quarterMap[t.quarter].sections[t.section].push({
        sno:            quarterMap[t.quarter].sections[t.section].length + 1,
        deductee_name:  t.deductee_name || 'Unknown',
        deductee_pan:   t.deductee_pan  || 'PANNOTAVBL',
        deductee_type:  t.deductee_type || 'company',
        payment_date:   t.payment_date,
        amount_paid:    parseFloat(t.payment_amount || 0),
        tds_rate:       parseFloat(t.tds_rate || 0),
        tds_amount:     parseFloat(t.tds_amount || 0),
        surcharge:      parseFloat(t.surcharge || 0),
        education_cess: parseFloat(t.education_cess || 0),
        total_tds:      parseFloat(t.total_tds || 0),
        challan_number: t.challan_number || '',
        challan_date:   t.challan_date   || '',
        bsr_code:       t.bsr_code       || '',
        deposited:      t.deposited,
      });
      quarterMap[t.quarter].totals.payment += parseFloat(t.payment_amount || 0);
      quarterMap[t.quarter].totals.tds     += parseFloat(t.total_tds || 0);
    }

    // Summary for each quarter
    const quarters = Object.values(quarterMap).map(q => ({
      ...q,
      sections: Object.entries(q.sections).map(([sec, entries]) => ({
        section: sec,
        entries,
        section_total_payment: entries.reduce((s, e) => s + e.amount_paid, 0),
        section_total_tds:     entries.reduce((s, e) => s + e.total_tds, 0),
      })),
    }));

    return res.json({
      financial_year:  fy,
      form_type:       '26Q',
      quarters,
      grand_total: {
        payment: txns.reduce((s, t) => s + parseFloat(t.payment_amount || 0), 0),
        tds:     txns.reduce((s, t) => s + parseFloat(t.total_tds || 0), 0),
      },
      instructions: 'Use this data to fill NSDL RPU software for Form 26Q quarterly return filing.',
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /form24q — NSDL-compatible salary TDS return (section 192) ────────────
// Sources actuals from payroll_runs. Falls back to employee master for missing periods.
router.get('/form24q', async (req, res) => {
  const { financial_year, quarter } = req.query;
  const fy  = financial_year || currentFY();
  const qtr = quarter; // 'Q1'–'Q4', if omitted all quarters
  const companyId = companyOf(req) ?? req.scope?.company_id ?? null;

  // Derive year range from FY string  "2025-2026" → startYear=2025, endYear=2026
  const fyParts    = fy.split('-');
  const fyStartYr  = parseInt(fyParts[0]) || new Date().getFullYear() - 1;
  const fyEndYr    = parseInt(fyParts[1]) || fyStartYr + 1;

  // Quarter month ranges (Indian financial year: Apr = Q1)
  const QUARTER_MONTHS = {
    Q1: [4, 5, 6],
    Q2: [7, 8, 9],
    Q3: [10, 11, 12],
    Q4: [1, 2, 3],
  };

  function quarterForMonth(mo) {
    if ([4,5,6].includes(mo))  return 'Q1';
    if ([7,8,9].includes(mo))  return 'Q2';
    if ([10,11,12].includes(mo)) return 'Q3';
    return 'Q4';
  }

  function calendarYear(mo) {
    return [1,2,3].includes(mo) ? fyEndYr : fyStartYr;
  }

  try {
    // Fetch all saved payroll_runs for this FY (section 192 = salary TDS)
    const { rows: runs } = await pool.query(`
      SELECT
        pr.employee_id,
        pr.month,
        pr.year,
        pr.tds                 AS tds_amount,
        pr.gross               AS salary_paid,
        pr.period_label,
        e.first_name,
        e.last_name,
        e.pan_number           AS employee_pan,
        e.office_id            AS employee_code
      FROM payroll_runs pr
      JOIN employees e ON e.id = pr.employee_id
      WHERE (
        (pr.year = $1 AND pr.month >= 4)
        OR
        (pr.year = $2 AND pr.month <= 3)
      )
      AND ($3::varchar IS NULL OR (
        CASE
          WHEN pr.month IN (4,5,6)   THEN 'Q1'
          WHEN pr.month IN (7,8,9)   THEN 'Q2'
          WHEN pr.month IN (10,11,12) THEN 'Q3'
          ELSE 'Q4'
        END
      ) = $3)
      AND ($4::int IS NULL OR e.company_id = $4)
      ORDER BY e.last_name, e.first_name, pr.year, pr.month
    `, [fyStartYr, fyEndYr, qtr || null, companyId]);

    // Group into quarters
    const quarterMap = {};
    for (const r of runs) {
      const q = quarterForMonth(r.month);
      if (!quarterMap[q]) quarterMap[q] = { quarter: q, deductees: {}, totals: { salary: 0, tds: 0 } };
      const empKey = String(r.employee_id);
      if (!quarterMap[q].deductees[empKey]) {
        quarterMap[q].deductees[empKey] = {
          employee_id:   r.employee_id,
          employee_code: r.employee_code || `EMP${String(r.employee_id).padStart(4,'0')}`,
          employee_name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
          employee_pan:  r.employee_pan || 'PANNOTAVBL',
          section:       '192',
          months:        [],
          total_salary:  0,
          total_tds:     0,
        };
      }
      const amt_tds    = parseFloat(r.tds_amount || 0);
      const amt_salary = parseFloat(r.salary_paid || 0);
      quarterMap[q].deductees[empKey].months.push({
        month: r.month, year: r.year, period_label: r.period_label,
        salary_paid: amt_salary, tds_deducted: amt_tds,
      });
      quarterMap[q].deductees[empKey].total_salary += amt_salary;
      quarterMap[q].deductees[empKey].total_tds    += amt_tds;
      quarterMap[q].totals.salary += amt_salary;
      quarterMap[q].totals.tds    += amt_tds;
    }

    const quarters = Object.values(quarterMap).map(q => ({
      quarter:   q.quarter,
      deductees: Object.values(q.deductees).map((d, idx) => ({ sno: idx + 1, ...d })),
      totals:    q.totals,
    })).sort((a, b) => a.quarter.localeCompare(b.quarter));

    const grandTotals = quarters.reduce(
      (acc, q) => ({ salary: acc.salary + q.totals.salary, tds: acc.tds + q.totals.tds }),
      { salary: 0, tds: 0 }
    );

    return res.json({
      financial_year:  fy,
      form_type:       '24Q',
      source:          'payroll_runs',
      quarters,
      grand_total:     grandTotals,
      instructions:    'Use this data to fill NSDL RPU software for Form 24Q salary TDS quarterly return (section 192).',
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /form24q-download — Form 24Q text file for NSDL RPU import ────────────
// Generates a structured text file with quarterly TDS data.
// One header line + one detail line per employee per quarter (Annexure I, CD records).
router.get('/form24q-download', async (req, res) => {
  const { financial_year, quarter } = req.query;
  const fy        = financial_year || currentFY();
  const fyParts   = fy.split('-');
  const fyStartYr = parseInt(fyParts[0]) || new Date().getFullYear() - 1;
  const fyEndYr   = parseInt(fyParts[1]) || fyStartYr + 1;
  const qtr       = quarter; // 'Q1'|'Q2'|'Q3'|'Q4'
  const companyId = companyOf(req) ?? req.scope?.company_id ?? null;

  function quarterForMonth(mo) {
    if ([4,5,6].includes(mo))   return 'Q1';
    if ([7,8,9].includes(mo))   return 'Q2';
    if ([10,11,12].includes(mo)) return 'Q3';
    return 'Q4';
  }
  function quarterEndMonth(q) {
    return { Q1: 6, Q2: 9, Q3: 12, Q4: 3 }[q];
  }
  function quarterEndYear(q) {
    return [q === 'Q4' ? fyEndYr : fyStartYr];
  }

  try {
    const { rows: runs } = await pool.query(`
      SELECT
        pr.employee_id,
        pr.month, pr.year,
        pr.tds       AS tds_amount,
        pr.gross     AS salary_paid,
        e.first_name, e.last_name,
        COALESCE(e.pan_number, 'PANNOTAVBL') AS pan,
        e.office_id  AS emp_code
      FROM payroll_runs pr
      JOIN employees e ON e.id = pr.employee_id
      WHERE (
        (pr.year = $1 AND pr.month >= 4)
        OR (pr.year = $2 AND pr.month <= 3)
      )
      AND ($3::varchar IS NULL OR (
        CASE
          WHEN pr.month IN (4,5,6)    THEN 'Q1'
          WHEN pr.month IN (7,8,9)    THEN 'Q2'
          WHEN pr.month IN (10,11,12) THEN 'Q3'
          ELSE 'Q4'
        END
      ) = $3)
      AND ($4::int IS NULL OR e.company_id = $4)
      ORDER BY e.last_name, e.first_name, pr.year, pr.month
    `, [fyStartYr, fyEndYr, qtr || null, companyId]);

    if (!runs.length) return res.status(404).json({ message: 'No payroll TDS data found for the requested period.' });

    // Aggregate per employee per quarter
    const empQuarterMap = {};
    for (const r of runs) {
      const q   = quarterForMonth(r.month);
      const key = `${r.employee_id}_${q}`;
      if (!empQuarterMap[key]) {
        empQuarterMap[key] = {
          quarter: q, employee_id: r.employee_id,
          name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
          pan: r.pan, emp_code: r.emp_code || r.employee_id,
          total_salary: 0, total_tds: 0, month_count: 0,
        };
      }
      empQuarterMap[key].total_salary += parseFloat(r.salary_paid || 0);
      empQuarterMap[key].total_tds    += parseFloat(r.tds_amount  || 0);
      empQuarterMap[key].month_count  += 1;
    }

    const records = Object.values(empQuarterMap).sort((a, b) =>
      a.quarter.localeCompare(b.quarter) || a.name.localeCompare(b.name)
    );

    // Generate structured text (CD record format compatible with NSDL RPU Annexure I)
    // Fields: Sno | Quarter | PAN | Name | Section | Salary | TDS Deducted | TDS Deposited | Date of Deposit
    const lines = [
      `FORM 24Q - Salary TDS Return | FY ${fy}${qtr ? ` | ${qtr}` : ''}`,
      `Generated: ${new Date().toISOString()}`,
      `Source: payroll_runs (Pulse ERP)`,
      ``,
      `Sl.No|Quarter|Employee PAN|Employee Name|Section|Salary Paid|TDS Deducted|TDS Deposited|Remarks`,
    ];

    records.forEach((r, idx) => {
      const tds = Math.round(r.total_tds);
      lines.push([
        idx + 1,
        r.quarter,
        r.pan,
        r.name,
        '192',
        Math.round(r.total_salary),
        tds,
        tds,
        'Salary',
      ].join('|'));
    });

    const grandSalary = records.reduce((s, r) => s + r.total_salary, 0);
    const grandTDS    = records.reduce((s, r) => s + r.total_tds,    0);
    lines.push('');
    lines.push(`TOTAL||||||${Math.round(grandSalary)}|${Math.round(grandTDS)}|${Math.round(grandTDS)}|`);
    lines.push('');
    lines.push('NOTE: Import this file into NSDL RPU software (Annexure I, Section 192) to generate FVU file for e-filing.');
    lines.push(`Employer TAN: ${process.env.EMPLOYER_TAN || 'TAN_NOT_CONFIGURED'}`);

    const fileName = `Form24Q_${fy.replace('-', '_')}${qtr ? `_${qtr}` : ''}.txt`;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(lines.join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /lower-deduction-cert — store 197 certificate for a deductee ─────────
router.post('/lower-deduction-cert', async (req, res) => {
  const {
    deductee_id,
    cert_number,
    applicable_rate,
    valid_from,
    valid_to,
  } = req.body;

  if (!deductee_id || !cert_number || applicable_rate === undefined) {
    return res.status(400).json({ error: 'deductee_id, cert_number, and applicable_rate are required' });
  }

  try {
    const { rows: [row] } = await pool.query(`
      UPDATE tds_deductees
      SET lower_deduction_cert_number = $1,
          lower_deduction_rate        = $2,
          lower_deduction_valid_from  = $3,
          lower_deduction_valid_to    = $4
      WHERE id = $5
      RETURNING *
    `, [cert_number, parseFloat(applicable_rate), valid_from || null, valid_to || null, deductee_id]);

    if (!row) return res.status(404).json({ error: 'Deductee not found' });
    return res.json(row);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
