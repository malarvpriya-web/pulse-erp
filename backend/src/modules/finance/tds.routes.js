// backend/src/modules/finance/tds.routes.js
import express from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';
import { captureBefore } from '../../middlewares/captureBefore.js';

const router = express.Router();

// PC-01 D6 (04 Nov 26): the salary Form 138 / 24Q extract carries every
// employee's salary, PAN and TDS. It has its own narrow right,
// payroll_tds_extract:export, held by exactly the roles that reached it through
// finance:view before. It grants nothing else, and finance:view no longer opens
// it. Every other TDS route keeps the router-wide finance:view gate.
const SALARY_TDS_EXTRACT_PATHS = new Set(['/form24q', '/form24q-download']);
const salaryTdsExtract = requirePermission('payroll_tds_extract', 'export');
const financeView = requirePermission('finance', 'view');
// Express routing ignores case and a trailing slash, so the check does too —
// '/Form24Q/' must not slip past it into the finance:view branch.
const normalisedPath = (p) => (String(p || '').replace(/\/+$/, '') || '/').toLowerCase();
router.use((req, res, next) =>
  (SALARY_TDS_EXTRACT_PATHS.has(normalisedPath(req.path)) ? salaryTdsExtract : financeView)(req, res, next));

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
router.put('/deductees/:id', captureBefore('tds_deductees'), async (req, res) => {
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
      total_tds: totalTds,   // shorthand `total_tds` referenced no such identifier
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
    // Aggregate purchases from bills grouped by supplier (supplier_id) for the FY
    const fyStart = fy.split('-')[0];
    const startDate = `${fyStart}-04-01`;
    const endDate   = `${parseInt(fyStart) + 1}-03-31`;

    const { rows } = await pool.query(`
      SELECT
        b.supplier_id,
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
           JOIN bills tb ON tb.id = t.bill_id
           WHERE tb.supplier_id = b.supplier_id
             AND t.section  = '194Q'
             AND t.financial_year = $2), 0
        )                                                  AS tds_already_deducted
      FROM bills b
      LEFT JOIN parties p ON p.id = b.supplier_id
      WHERE b.bill_date BETWEEN $3 AND $4
        AND COALESCE(b.deleted_at::text, '') = ''
        AND b.supplier_id IS NOT NULL
      GROUP BY b.supplier_id, p.name, b.party_name, p.pan, p.gstin
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

// ── Form 138 (formerly Form 24Q) — quarterly statement of salary TDS ─────────
// Tax years from 2026-27 (Income-tax Act 2025 / Income-tax Rules 2026):
//   the DEDUCTION from salary is made under s.392 (was s.192);
//   the QUARTERLY STATEMENT is Form No. 138, furnished under s.397(3)(b) read
//   with Rule 219 (was Form 24Q under s.200(3) / Rule 31A).
// Earlier years keep the 1961 Act's labels. Protean's RPU/FVU v1.1 note
// ("Key Features", effective FY 2026-27) renames Form 24Q to Form No. 138,
// replaces "Financial Year" with "Tax Year" and drops the "See Sections 192"
// caption. tds_transactions.section stays '192' — it is the stored ledger
// key (payroll.service.js writes it), not a statutory label. Endpoint paths
// keep "form24q" for compatibility. (manual §200)
//
// Built from FINALISED payroll only (approved / paid, is_test = false). The old
// version summed every payroll_runs row in the FY regardless of status, so
// drafts and the seeded Q1 rows (salary ₹175 / ₹200 with TDS ₹3,150 / ₹3,600)
// went into the return; it wrote PANNOTAVBL for a missing PAN, reported
// "TDS deposited" = "TDS deducted" with no challan behind it, and still
// produced the file with "TAN_NOT_CONFIGURED".
//
// The download refuses (422) while any ERROR remains.

const QUARTER_MONTHS = { Q1: [4, 5, 6], Q2: [7, 8, 9], Q3: [10, 11, 12], Q4: [1, 2, 3] };
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const TAN_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;

// Labels that depend on which Act governs the year — see the comment above.
export function salaryTdsLabels(startYear) {
  return startYear >= 2026
    ? { form_type: '138', form_label: 'Form 138 (formerly Form 24Q)', section: '392', period_term: 'Tax Year',
        statute: 'Quarterly statement under s.397(3)(b) of the Income-tax Act 2025 (Rule 219, Income-tax Rules 2026); salary TDS deducted under s.392' }
    : { form_type: '24Q', form_label: 'Form 24Q (Income-tax Rules 1962)', section: '192', period_term: 'FY',
        statute: 'Quarterly statement under s.200(3) of the Income-tax Act 1961 (Rule 31A, Income-tax Rules 1962); salary TDS deducted under s.192' };
}

function parseFY(fy) {
  const [a, b] = String(fy || '').split('-');
  const start = parseInt(a);
  if (!start) return null;
  let end = parseInt(b);
  // '2026-27' used to give endYear 27 — Q4 then read Jan–Mar of year 27.
  if (!end || end < 100) end = start + 1;
  if (end !== start + 1) return null;
  return { start, end, label: `${start}-${end}` };
}

async function buildForm138({ companyId, financial_year, quarter }) {
  const fy = parseFY(financial_year || currentFY());
  if (!fy) return { http: 400, body: { message: 'financial_year must look like 2026-2027 or 2026-27' } };
  if (quarter && !QUARTER_MONTHS[quarter]) return { http: 400, body: { message: 'quarter must be Q1, Q2, Q3 or Q4' } };
  if (companyId == null) return { http: 400, body: { message: 'Company context required' } };

  const labels = salaryTdsLabels(fy.start);
  const yearOf = (mo) => ([1, 2, 3].includes(mo) ? fy.end : fy.start);
  const quarters = quarter ? [quarter] : ['Q1', 'Q2', 'Q3', 'Q4'];
  const keys = quarters.flatMap(q => QUARTER_MONTHS[q].map(mo => yearOf(mo) * 100 + mo));

  const [{ rows: runs }, { rows: [co] }, { rows: excluded }, { rows: deposits }] = await Promise.all([
    pool.query(`
      SELECT pr.id, pr.employee_id, pr.month, pr.year, pr.status, pr.tds, pr.gross, pr.period_label, pr.is_test,
             e.first_name, e.last_name, e.pan_number, e.office_id
        FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
       WHERE e.company_id = $1 AND (pr.year * 100 + pr.month) = ANY($2::int[])
       ORDER BY e.first_name, e.last_name, pr.year, pr.month`, [companyId, keys]),
    pool.query(`SELECT name, tan, pan FROM companies WHERE id = $1`, [companyId]),
    pool.query(`
      SELECT pr.is_test, pr.status, COUNT(*)::int AS n
        FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
       WHERE e.company_id = $1 AND (pr.year * 100 + pr.month) = ANY($2::int[])
         AND (pr.is_test OR pr.status NOT IN ('approved', 'paid'))
       GROUP BY pr.is_test, pr.status`, [companyId, keys]),
    pool.query(`
      SELECT employee_id, payroll_month AS month, payroll_year AS year,
             SUM(total_tds) FILTER (WHERE deposited AND challan_number IS NOT NULL) AS deposited
        FROM tds_transactions
       WHERE section = '192' AND (company_id = $1 OR company_id IS NULL)
         AND (payroll_year * 100 + payroll_month) = ANY($2::int[])
       GROUP BY employee_id, payroll_month, payroll_year`, [companyId, keys]),
  ]);

  const final = runs.filter(r => !r.is_test && ['approved', 'paid'].includes(r.status));
  const depMap = new Map(deposits.map(d => [`${d.employee_id}-${d.year}-${d.month}`, Number(d.deposited || 0)]));
  const errors = [], warnings = [];
  const tan = (co?.tan || process.env.EMPLOYER_TAN || '').trim().toUpperCase();
  if (!TAN_RE.test(tan)) errors.push({ code: 'TAN', message: tan ? `Employer TAN "${tan}" is invalid (format AAAA99999A)` : 'Employer TAN is not configured (Company profile → TAN)' });

  for (const q of quarters) {
    const pend = runs.filter(r => !r.is_test && !['approved', 'paid'].includes(r.status) && QUARTER_MONTHS[q].includes(r.month));
    if (pend.length) errors.push({ code: 'UNAPPROVED', quarter: q, message: `${q}: ${pend.length} payroll record(s) are not approved — approve payroll before filing` });
  }

  const quarterMap = {};
  for (const r of final) {
    const q = Object.keys(QUARTER_MONTHS).find(k => QUARTER_MONTHS[k].includes(r.month));
    quarterMap[q] ??= { quarter: q, deductees: {}, totals: { salary: 0, tds: 0, deposited: 0 } };
    const key = String(r.employee_id);
    const name = `${r.first_name || ''} ${r.last_name || ''}`.trim();
    const pan = String(r.pan_number || '').trim().toUpperCase();
    const d = (quarterMap[q].deductees[key] ??= {
      employee_id: r.employee_id, employee_code: r.office_id || null, employee_name: name,
      employee_pan: pan || null, pan_valid: PAN_RE.test(pan), section: labels.section, months: [],
      total_salary: 0, total_tds: 0, total_deposited: 0,
    });
    const tds = Number(r.tds || 0), gross = Number(r.gross || 0);
    const dep = depMap.get(`${r.employee_id}-${r.year}-${r.month}`) || 0;
    if (tds > gross) errors.push({ code: 'TDS_GT_SALARY', quarter: q, employee_code: r.office_id, message: `${name} (${r.office_id}) ${r.period_label}: TDS ₹${tds} exceeds salary ₹${gross} — invalid record` });
    d.months.push({ month: r.month, year: r.year, period_label: r.period_label, salary_paid: gross, tds_deducted: tds, tds_deposited: dep });
    d.total_salary += gross; d.total_tds += tds; d.total_deposited += dep;
    quarterMap[q].totals.salary += gross; quarterMap[q].totals.tds += tds; quarterMap[q].totals.deposited += dep;
  }
  for (const q of Object.values(quarterMap)) {
    for (const d of Object.values(q.deductees)) {
      if (!d.pan_valid) errors.push({ code: 'PAN', quarter: q.quarter, employee_code: d.employee_code, message: `${d.employee_name} (${d.employee_code}): PAN ${d.employee_pan ? `"${d.employee_pan}" is invalid` : 'is missing'}` });
      if (d.total_tds > 0 && Math.round(d.total_deposited) !== Math.round(d.total_tds)) {
        errors.push({ code: 'CHALLAN', quarter: q.quarter, employee_code: d.employee_code, message: `${d.employee_name} (${d.employee_code}): TDS deducted ₹${Math.round(d.total_tds)} but challan-backed deposit ₹${Math.round(d.total_deposited)}` });
      }
    }
  }
  for (const x of excluded) {
    warnings.push({ code: x.is_test ? 'TEST_EXCLUDED' : 'NOT_FINAL_EXCLUDED', message: `${x.n} ${x.is_test ? 'test' : `"${x.status}"`} payroll record(s) excluded from this return` });
  }

  const qs = Object.values(quarterMap).map(q => ({
    quarter: q.quarter, totals: q.totals,
    deductees: Object.values(q.deductees).map((d, i) => ({ sno: i + 1, ...d })),
  })).sort((a, b) => a.quarter.localeCompare(b.quarter));
  return {
    http: 200,
    body: {
      // Form No. 138 applies from tax year 2026-27 (Income-tax Rules 2026);
      // earlier years are filed as Form 24Q under the 1962 Rules.
      financial_year: fy.label,
      form_type: labels.form_type,
      form_label: labels.form_label,
      salary_tds_section: labels.section,
      period_term: labels.period_term,
      statute: labels.statute,
      source: 'payroll_runs (approved/paid, test excluded)',
      employer: { name: co?.name || null, tan: tan || null },
      quarters: qs,
      grand_total: qs.reduce((a, q) => ({ salary: a.salary + q.totals.salary, tds: a.tds + q.totals.tds, deposited: a.deposited + q.totals.deposited }), { salary: 0, tds: 0, deposited: 0 }),
      validation: { ok: errors.length === 0, errors, warnings },
    },
  };
}

router.get('/form24q', async (req, res) => {
  try {
    const r = await buildForm138({ companyId: companyOf(req), financial_year: req.query.financial_year, quarter: req.query.quarter });
    res.status(r.http).json(r.body);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /form24q-download — data extract for preparing Form 138 in the return
// preparation utility. NOT an FVU file. Refused while validation errors exist.
router.get('/form24q-download', async (req, res) => {
  try {
    const r = await buildForm138({ companyId: companyOf(req), financial_year: req.query.financial_year, quarter: req.query.quarter });
    if (r.http !== 200) return res.status(r.http).json(r.body);
    const b = r.body;
    if (!b.validation.ok) {
      return res.status(422).json({ message: `Form 138 cannot be generated: ${b.validation.errors.length} validation error(s)`, validation: b.validation });
    }
    if (!b.quarters.length) return res.status(404).json({ message: 'No approved salary TDS records for the requested period.' });
    const lines = [
      `${b.form_type === '138' ? 'FORM 138 (formerly FORM 24Q)' : 'FORM 24Q'} - Salary TDS statement data extract | ${b.period_term} ${b.financial_year}${req.query.quarter ? ` | ${req.query.quarter}` : ''}`,
      b.statute,
      `Employer: ${b.employer.name || ''} | TAN: ${b.employer.tan}`,
      `Generated: ${new Date().toISOString()} | Source: approved payroll (Pulse ERP)`,
      '',
      // "Act Section" is the statutory section, NOT an RPU section code.
      'Sl.No|Quarter|Employee Code|Employee PAN|Employee Name|Act Section|Salary Paid|TDS Deducted|TDS Deposited',
    ];
    let n = 0;
    for (const q of b.quarters) for (const d of q.deductees) {
      lines.push([++n, q.quarter, d.employee_code, d.employee_pan, d.employee_name, b.salary_tds_section,
        Math.round(d.total_salary), Math.round(d.total_tds), Math.round(d.total_deposited)].join('|'));
    }
    lines.push('', `TOTAL|||||| ${Math.round(b.grand_total.salary)}|${Math.round(b.grand_total.tds)}|${Math.round(b.grand_total.deposited)}`);
    lines.push('', 'NOTE: This is a validated data extract, not a filed return. "Act Section" is the statutory section, not an RPU section code. Prepare and validate the statement in the official utility (RPU/FVU) before filing.');
    const fileName = `Form${b.form_type}_${b.financial_year.replace('-', '_')}${req.query.quarter ? `_${req.query.quarter}` : ''}.txt`;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(lines.join('\n'));
  } catch (err) { res.status(500).json({ error: err.message }); }
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
