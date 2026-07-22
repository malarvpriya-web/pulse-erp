import express from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';

const router = express.Router();
router.use(requirePermission('finance', 'view'));

// ── GST Rate master ───────────────────────────────────────────────────────────
const GST_RATES = [0, 5, 12, 18, 28];

// ── Helpers ───────────────────────────────────────────────────────────────────

// GSTIN format: 2-digit state code + 10-char PAN + entity code + Z + check digit
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function validateGSTIN(gstin) {
  if (!gstin) return true; // null/empty is allowed (unregistered party)
  return GSTIN_REGEX.test(gstin.trim().toUpperCase());
}

// applyRounding: respects gst_rounding setting from company_settings
// method: 'round' (default) | 'floor' | 'ceil'
function applyRounding(value, method = 'round') {
  const factor = 100; // 2 decimal places
  if (method === 'floor') return Math.floor(value * factor) / factor;
  if (method === 'ceil')  return Math.ceil(value  * factor) / factor;
  return Math.round(value * factor) / factor;
}

function computeGST(amount, rate, isIGST = false, roundingMethod = 'round') {
  const gst = applyRounding(amount * rate / 100, roundingMethod);
  if (isIGST) return { igst: gst, cgst: 0, sgst: 0, total_gst: gst };
  const half = applyRounding(gst / 2, roundingMethod);
  return { igst: 0, cgst: half, sgst: gst - half, total_gst: gst };
}

// Shared helper: read company's gst_rounding setting
async function getGSTRounding(companyId) {
  try {
    const { rows } = await pool.query(
      `SELECT settings->>'gst_rounding' AS m FROM company_settings WHERE company_id=$1 AND module='finance' LIMIT 1`,
      [companyId ?? 0]
    );
    return rows[0]?.m || 'round';
  } catch { return 'round'; }
}

function isIGST(sellerState, buyerState) {
  return sellerState && buyerState && sellerState !== buyerState;
}


// ── Filing status endpoints ───────────────────────────────────────────────────
router.get('/filing-status', async (req, res) => {
  const { period, type = 'gstr1' } = req.query;
  if (!period) return res.status(400).json({ error: 'period required' });
  const company_id = companyOf(req);
  try {
    const { rows } = await pool.query(
      `SELECT status, reference_no, filed_at FROM gst_filings
       WHERE company_id=$1 AND period=$2 AND return_type=$3`,
      [company_id, period, type]
    );
    return res.json(rows[0] || { status: 'draft' });
  } catch {
    return res.json({ status: 'draft' });
  }
});

router.post('/filing-status', async (req, res) => {
  const { period, return_type, status, reference_no, filed_at, notes } = req.body;
  if (!period || !return_type || !status) {
    return res.status(400).json({ error: 'period, return_type, status required' });
  }
  const company_id = companyOf(req);
  try {
    const { rows } = await pool.query(`
      INSERT INTO gst_filings (company_id, period, return_type, status, reference_no, filed_at, notes, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (company_id, period, return_type)
      DO UPDATE SET status=$4, reference_no=$5, filed_at=$6, notes=$7, updated_at=NOW()
      RETURNING *
    `, [company_id, period, return_type, status, reference_no || null, filed_at || null, notes || null]);
    return res.json(rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GSTR-1 Data (Outward Supplies) ────────────────────────────────────────────
router.get('/gstr1', async (req, res) => {
  const { period } = req.query; // format: MMYYYY e.g. "032026"
  if (!period) return res.status(400).json({ error: 'period required (MMYYYY)' });

  try {
    const company_id = companyOf(req);
    const month = parseInt(period.slice(0, 2));
    const year  = parseInt(period.slice(2));

    const { rows } = await pool.query(`
      SELECT
        i.id, i.invoice_number, i.invoice_date, i.total_amount,
        p.name as party_name, p.gstin as party_gstin, p.state as party_state,
        COALESCE(i.cgst, 0) as cgst, COALESCE(i.sgst, 0) as sgst,
        COALESCE(i.igst, 0) as igst,
        i.total_amount - COALESCE(i.cgst,0) - COALESCE(i.sgst,0) - COALESCE(i.igst,0) as taxable_value
      FROM invoices i
      LEFT JOIN parties p ON i.customer_id = p.id
      WHERE EXTRACT(MONTH FROM i.invoice_date) = $1
        AND EXTRACT(YEAR FROM i.invoice_date) = $2
        AND i.company_id = $3
        AND i.status != 'cancelled'
      ORDER BY i.invoice_date
    `, [month, year, company_id]);

    // Categorise into B2B, B2C, exports
    const b2b      = rows.filter(r => r.party_gstin);
    const b2c      = rows.filter(r => !r.party_gstin);

    const summary = {
      period,
      b2b_invoices:       b2b.length,
      b2c_invoices:       b2c.length,
      total_taxable_value: rows.reduce((s, r) => s + parseFloat(r.taxable_value || 0), 0),
      total_igst:         rows.reduce((s, r) => s + parseFloat(r.igst || 0), 0),
      total_cgst:         rows.reduce((s, r) => s + parseFloat(r.cgst || 0), 0),
      total_sgst:         rows.reduce((s, r) => s + parseFloat(r.sgst || 0), 0),
    };

    return res.json({ summary, b2b, b2c, invoices: rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GSTR-3B Summary ───────────────────────────────────────────────────────────
router.get('/gstr3b', async (req, res) => {
  const { period } = req.query;
  if (!period) return res.status(400).json({ error: 'period required (MMYYYY)' });

  try {
    const company_id = companyOf(req);
    const month = parseInt(period.slice(0, 2));
    const year  = parseInt(period.slice(2));

    // Outward supplies (sales)
    const salesRes = await pool.query(`
      SELECT
        COALESCE(SUM(total_amount - COALESCE(cgst,0) - COALESCE(sgst,0) - COALESCE(igst,0)), 0) as taxable_value,
        COALESCE(SUM(igst), 0) as igst,
        COALESCE(SUM(cgst), 0) as cgst,
        COALESCE(SUM(sgst), 0) as sgst
      FROM invoices
      WHERE EXTRACT(MONTH FROM invoice_date) = $1
        AND EXTRACT(YEAR FROM invoice_date) = $2
        AND company_id = $3
        AND status != 'cancelled'
    `, [month, year, company_id]);

    // Inward supplies ITC (purchases)
    const purchaseRes = await pool.query(`
      SELECT
        COALESCE(SUM(total_amount - COALESCE(cgst,0) - COALESCE(sgst,0) - COALESCE(igst,0)), 0) as taxable_value,
        COALESCE(SUM(igst), 0) as igst,
        COALESCE(SUM(cgst), 0) as cgst,
        COALESCE(SUM(sgst), 0) as sgst
      FROM bills
      WHERE EXTRACT(MONTH FROM bill_date) = $1
        AND EXTRACT(YEAR FROM bill_date) = $2
        AND company_id = $3
        AND status != 'cancelled'
    `, [month, year, company_id]).catch(() => ({ rows: [{ taxable_value: 0, igst: 0, cgst: 0, sgst: 0 }] }));

    const sales    = salesRes.rows[0];
    const purchase = purchaseRes.rows[0];

    const outputTax = parseFloat(sales.igst) + parseFloat(sales.cgst) + parseFloat(sales.sgst);
    const itcTax    = parseFloat(purchase.igst) + parseFloat(purchase.cgst) + parseFloat(purchase.sgst);

    // ── ITC set-off per Section 49, CGST Act (cross-utilization rules) ──────────
    // IGST ITC → IGST first, then CGST, then SGST
    // CGST ITC → CGST first, then IGST (NEVER SGST)
    // SGST ITC → SGST first, then IGST (NEVER CGST)
    let igst_itc = parseFloat(purchase.igst);
    let cgst_itc = parseFloat(purchase.cgst);
    let sgst_itc = parseFloat(purchase.sgst);

    let igst_liab = parseFloat(sales.igst);
    let cgst_liab = parseFloat(sales.cgst);
    let sgst_liab = parseFloat(sales.sgst);

    // Step 1 – IGST ITC against IGST
    const used_igst_on_igst = Math.min(igst_liab, igst_itc);
    igst_liab -= used_igst_on_igst; igst_itc -= used_igst_on_igst;
    // Step 2 – remaining IGST ITC against CGST
    const used_igst_on_cgst = Math.min(cgst_liab, igst_itc);
    cgst_liab -= used_igst_on_cgst; igst_itc -= used_igst_on_cgst;
    // Step 3 – remaining IGST ITC against SGST
    const used_igst_on_sgst = Math.min(sgst_liab, igst_itc);
    sgst_liab -= used_igst_on_sgst;

    // Step 4 – CGST ITC against CGST
    const used_cgst_on_cgst = Math.min(cgst_liab, cgst_itc);
    cgst_liab -= used_cgst_on_cgst; cgst_itc -= used_cgst_on_cgst;
    // Step 5 – remaining CGST ITC against IGST
    const used_cgst_on_igst = Math.min(igst_liab, cgst_itc);
    igst_liab -= used_cgst_on_igst;

    // Step 6 – SGST ITC against SGST
    const used_sgst_on_sgst = Math.min(sgst_liab, sgst_itc);
    sgst_liab -= used_sgst_on_sgst; sgst_itc -= used_sgst_on_sgst;
    // Step 7 – remaining SGST ITC against IGST
    const used_sgst_on_igst = Math.min(igst_liab, sgst_itc);
    igst_liab -= used_sgst_on_igst;

    const igst_payable = Math.max(0, igst_liab);
    const cgst_payable = Math.max(0, cgst_liab);
    const sgst_payable = Math.max(0, sgst_liab);
    const netTax = igst_payable + cgst_payable + sgst_payable;

    return res.json({
      period,
      outward_supplies: {
        taxable_value: parseFloat(sales.taxable_value),
        igst: parseFloat(sales.igst),
        cgst: parseFloat(sales.cgst),
        sgst: parseFloat(sales.sgst),
        total_tax: outputTax,
      },
      itc_available: {
        igst: parseFloat(purchase.igst),
        cgst: parseFloat(purchase.cgst),
        sgst: parseFloat(purchase.sgst),
        total_itc: itcTax,
      },
      net_tax_payable: netTax,
      igst_payable,
      cgst_payable,
      sgst_payable,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Compute GST on invoice ────────────────────────────────────────────────────
router.post('/compute', (req, res) => {
  const { amount, gst_rate, seller_state, buyer_state, seller_gstin, buyer_gstin } = req.body;
  if (!amount || gst_rate === undefined) {
    return res.status(400).json({ error: 'amount and gst_rate required' });
  }
  if (seller_gstin && !validateGSTIN(seller_gstin)) {
    return res.status(400).json({ error: `Invalid seller GSTIN format: ${seller_gstin}` });
  }
  if (buyer_gstin && !validateGSTIN(buyer_gstin)) {
    return res.status(400).json({ error: `Invalid buyer GSTIN format: ${buyer_gstin}` });
  }
  const interstate = isIGST(seller_state, buyer_state);
  const result = computeGST(parseFloat(amount), parseFloat(gst_rate), interstate);
  return res.json({
    taxable_amount: parseFloat(amount),
    gst_rate: parseFloat(gst_rate),
    supply_type: interstate ? 'interstate' : 'intrastate',
    ...result,
    invoice_total: parseFloat(amount) + result.total_gst,
  });
});

// ── TDS section master ────────────────────────────────────────────────────────
// rate_with_pan / rate_without_pan in percent.
// threshold = per-transaction limit (annual for 194Q).
const TDS_SECTIONS = {
  '192':  { description: 'Salary',                       rate_with_pan: 0,   rate_without_pan: 0,  threshold: 250000, note: 'Slab-based; computed by payroll engine' },
  '194A': { description: 'Interest (non-bank)',           rate_with_pan: 10,  rate_without_pan: 20, threshold: 40000  },
  '194B': { description: 'Lottery / game show winnings',  rate_with_pan: 30,  rate_without_pan: 30, threshold: 10000  },
  '194C': { description: 'Contractor / sub-contractor',   rate_with_pan: 1,   rate_without_pan: 20, threshold: 30000  },
  '194D': { description: 'Insurance commission',          rate_with_pan: 5,   rate_without_pan: 20, threshold: 15000  },
  '194H': { description: 'Commission / brokerage',        rate_with_pan: 5,   rate_without_pan: 20, threshold: 15000  },
  '194I': { description: 'Rent (land / building)',        rate_with_pan: 10,  rate_without_pan: 20, threshold: 240000 },
  '194IA':{ description: 'Rent (plant / machinery)',      rate_with_pan: 2,   rate_without_pan: 20, threshold: 240000 },
  '194J': { description: 'Professional / technical fees', rate_with_pan: 10,  rate_without_pan: 20, threshold: 30000  },
  '194Q': { description: 'Purchase of goods (>₹50L/yr)', rate_with_pan: 0.1, rate_without_pan: 5,  threshold: 5000000, note: 'Annual cumulative threshold per seller; buyer turnover must exceed ₹10Cr' },
  '194R': { description: 'Perquisites / benefits in kind',rate_with_pan: 10,  rate_without_pan: 20, threshold: 20000  },
  '206C': { description: 'TCS — scrap sales',             rate_with_pan: 1,   rate_without_pan: 1,  threshold: 0, note: 'Tax collected at source; credited to buyer' },
};

// Surcharge rates for TDS (company deductees, section 195/194J etc.)
// Applies when single payment > threshold stated below
function computeSurcharge(section, tdsAmount, paymentAmount, deducteeType = 'company') {
  // Surcharge is rare for most sections; applies mainly for 194J/194C above ₹1Cr
  if (deducteeType === 'individual' || deducteeType === 'huf') {
    if (paymentAmount > 10000000) return Math.round(tdsAmount * 0.15); // >₹1Cr → 15%
    if (paymentAmount > 5000000)  return Math.round(tdsAmount * 0.10); // >₹50L → 10%
  } else {
    if (paymentAmount > 100000000) return Math.round(tdsAmount * 0.12); // >₹10Cr → 12%
    if (paymentAmount > 10000000)  return Math.round(tdsAmount * 0.07); // >₹1Cr  → 7%
  }
  return 0;
}

router.get('/tds/sections', (req, res) => res.json(TDS_SECTIONS));

router.post('/tds/compute', (req, res) => {
  const { section, amount, pan_available = true, deductee_type = 'company' } = req.body;
  const sectionData = TDS_SECTIONS[section];
  if (!sectionData) return res.status(400).json({ error: `Unknown TDS section: ${section}` });

  const amt = parseFloat(amount);
  const rate = pan_available ? sectionData.rate_with_pan : Math.max(20, sectionData.rate_without_pan);
  const tdsAmount  = Math.round(amt * rate / 100 * 100) / 100;
  const surcharge  = computeSurcharge(section, tdsAmount, amt, deductee_type);
  // Education cess is 4% of (TDS + surcharge), not just TDS
  const ec = Math.round((tdsAmount + surcharge) * 0.04 * 100) / 100;

  return res.json({
    section,
    description: sectionData.description,
    payment_amount: amt,
    tds_rate: rate,
    tds_amount: tdsAmount,
    surcharge,
    education_cess: ec,
    total_tds: tdsAmount + surcharge + ec,
    net_payment: Math.round((amt - tdsAmount - surcharge - ec) * 100) / 100,
    threshold: sectionData.threshold,
    tds_applicable: amt >= sectionData.threshold,
    note: sectionData.note,
  });
});

router.get('/tds', async (req, res) => {
  const { quarter, financial_year } = req.query;
  const companyId = companyOf(req) ?? req.scope?.company_id ?? null;
  try {

    const { rows } = await pool.query(`
      SELECT * FROM tds_transactions
      WHERE ($1::varchar IS NULL OR quarter = $1)
        AND ($2::varchar IS NULL OR financial_year = $2)
        AND ($3::int IS NULL OR company_id = $3)
      ORDER BY payment_date DESC
      LIMIT 100
    `, [quarter || null, financial_year || null, companyId]);
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/tds', async (req, res) => {
  const {
    party_id, party_name, party_pan, section,
    payment_date, payment_amount, challan_number,
  } = req.body;

  try {

    const sectionData = TDS_SECTIONS[section];
    const rate = party_pan ? sectionData?.rate || 10 : (sectionData?.rate || 10) * 2;
    const tdsAmount = Math.round(parseFloat(payment_amount) * rate / 100);
    const ec = Math.round(tdsAmount * 0.04);
    const totalTDS = tdsAmount + ec;

    const pDate = new Date(payment_date);
    const month = pDate.getMonth() + 1;
    const year  = pDate.getFullYear();
    const quarter = month <= 6 ? (month <= 3 ? 'Q4' : 'Q1') : (month <= 9 ? 'Q2' : 'Q3');
    const fy = month <= 3
      ? `${year - 1}-${year}`
      : `${year}-${year + 1}`;

    const { rows } = await pool.query(`
      INSERT INTO tds_transactions
        (party_id, section, payment_date, payment_amount,
         tds_rate, tds_amount, education_cess, total_tds, challan_number, quarter, financial_year)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [party_id || null, section, payment_date,
        parseFloat(payment_amount), rate, tdsAmount, ec, totalTDS,
        challan_number || null, quarter, fy]);

    return res.status(201).json(rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── 26AS / TDS summary ────────────────────────────────────────────────────────
router.get('/tds/summary', async (req, res) => {
  const { financial_year } = req.query;
  const fy = financial_year || `${new Date().getFullYear() - 1}-${new Date().getFullYear()}`;
  const companyId = companyOf(req) ?? req.scope?.company_id ?? null;
  try {

    const { rows } = await pool.query(`
      SELECT
        section,
        COUNT(*) as transactions,
        SUM(payment_amount) as total_payments,
        SUM(total_tds) as total_tds,
        SUM(CASE WHEN deposited THEN total_tds ELSE 0 END) as deposited_tds,
        SUM(CASE WHEN NOT deposited THEN total_tds ELSE 0 END) as pending_tds
      FROM tds_transactions
      WHERE financial_year = $1
        AND ($2::int IS NULL OR company_id = $2)
      GROUP BY section
      ORDER BY section
    `, [fy, companyId]);
    return res.json({ financial_year: fy, sections: rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── RCM: list bills pending self-invoice generation ───────────────────────────
// Section 9(3)/9(4) CGST Act: registered buyers must pay GST on purchases from
// unregistered suppliers or notified services on reverse charge basis.
router.get('/rcm/bills', async (req, res) => {
  const { month, year, pending_only } = req.query;
  try {
    let q = `
      SELECT
        b.id, b.bill_number, b.bill_date, b.party_name,
        b.subtotal AS taxable_value,
        COALESCE(b.cgst, 0) AS cgst, COALESCE(b.sgst, 0) AS sgst,
        COALESCE(b.igst, 0) AS igst,
        b.total_amount, b.supply_type, b.is_rcm,
        b.rcm_self_invoice_id,
        rsi.self_invoice_number,
        p.gstin AS supplier_gstin
      FROM bills b
      LEFT JOIN rcm_self_invoices rsi ON rsi.id = b.rcm_self_invoice_id
      LEFT JOIN parties p ON p.id = b.supplier_id
      WHERE b.is_rcm = true
    `;
    const params = [];
    if (month)  { params.push(parseInt(month));  q += ` AND EXTRACT(MONTH FROM b.bill_date) = $${params.length}`; }
    if (year)   { params.push(parseInt(year));   q += ` AND EXTRACT(YEAR  FROM b.bill_date) = $${params.length}`; }
    if (pending_only === 'true') q += ` AND b.rcm_self_invoice_id IS NULL`;
    q += ' ORDER BY b.bill_date DESC';

    const { rows } = await pool.query(q, params);
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── RCM: generate self-invoice for a bill ─────────────────────────────────────
// Creates the self-invoice document and posts the double-sided RCM journal:
//   DR  Input Tax Credit — CGST/SGST/IGST  (1020/1021/1022)
//   CR  GST Payable     — CGST/SGST/IGST  (2010/2011/2012)
// Both legs cancel each other in GSTR-3B Table 3.1(d) vs Table 4(A)(3).
router.post('/rcm/self-invoice', async (req, res) => {
  const { bill_id, invoice_date, gst_rate, supply_type = 'intrastate', notes, created_by } = req.body;
  if (!bill_id || !invoice_date) {
    return res.status(400).json({ error: 'bill_id and invoice_date are required' });
  }

  try {
    const { rows: [bill] } = await pool.query(
      `SELECT b.*, p.name AS p_name, p.gstin AS p_gstin
       FROM bills b LEFT JOIN parties p ON p.id = b.supplier_id
       WHERE b.id = $1`,
      [bill_id]
    );
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    if (!bill.is_rcm) return res.status(400).json({ error: 'This bill is not flagged as RCM.' });
    if (bill.rcm_self_invoice_id) {
      return res.status(409).json({ error: 'Self-invoice already generated for this bill.', self_invoice_id: bill.rcm_self_invoice_id });
    }

    const taxableValue = parseFloat(bill.subtotal || bill.total_amount);
    const rate = parseFloat(gst_rate || 18);
    const roundingMethod = await getGSTRounding(bill.company_id);
    const isIGSTSupply = (supply_type === 'interstate');
    const { cgst, sgst, igst, total_gst: totalGst } = computeGST(taxableValue, rate, isIGSTSupply, roundingMethod);

    // Generate sequential self-invoice number
    const { rows: [{ cnt }] } = await pool.query('SELECT COUNT(*)::int AS cnt FROM rcm_self_invoices');
    const selfInvNumber = `RCM-SI-${String(cnt + 1).padStart(4, '0')}`;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert self-invoice record
      const { rows: [si] } = await client.query(
        `INSERT INTO rcm_self_invoices
           (self_invoice_number, bill_id, invoice_date, supplier_name, supply_type,
            taxable_value, gst_rate, cgst_amount, sgst_amount, igst_amount, total_gst,
            total_amount, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [selfInvNumber, bill_id, invoice_date,
         bill.p_name || bill.party_name || 'Unregistered Supplier',
         supply_type, taxableValue, rate, cgst, sgst, igst, totalGst,
         taxableValue + totalGst, notes || null, created_by || null]
      );

      // Journal entry — DR ITC accounts, CR GST payable accounts
      const { rows: [{ max_num }] } = await client.query(
        `SELECT MAX(REGEXP_REPLACE(entry_number, '[^0-9]', '', 'g')::bigint) AS max_num FROM journal_entries WHERE entry_number LIKE 'JE%'`
      );
      const seq = (max_num || 0) + 1;
      const entryNumber = `JE${String(seq).padStart(4, '0')}`;

      const { rows: [je] } = await client.query(
        `INSERT INTO journal_entries
           (entry_number, entry_date, entry_type, reference_type, reference_id,
            description, is_posted, status, created_by)
         VALUES ($1,$2,'RCM',$3,$4,$5,true,'posted',$6) RETURNING *`,
        [entryNumber, invoice_date, 'rcm_self_invoice', si.id,
         `RCM Self-Invoice ${selfInvNumber} — ${bill.p_name || 'Unregistered Supplier'}`,
         created_by || null]
      );

      // ITC accounts (debit) and GST payable accounts (credit) per supply type
      const itcLines   = isIGSTSupply
        ? [{ code: '1022', amt: igst, desc: 'IGST ITC on RCM' }]
        : [{ code: '1020', amt: cgst, desc: 'CGST ITC on RCM' }, { code: '1021', amt: sgst, desc: 'SGST ITC on RCM' }];
      const taxLines   = isIGSTSupply
        ? [{ code: '2012', amt: igst, desc: 'IGST Payable — RCM' }]
        : [{ code: '2010', amt: cgst, desc: 'CGST Payable — RCM' }, { code: '2011', amt: sgst, desc: 'SGST Payable — RCM' }];

      for (const l of itcLines) {
        if (l.amt <= 0) continue;
        const { rows: [acc] } = await client.query(
          `SELECT id FROM chart_of_accounts WHERE code=$1 LIMIT 1`, [l.code]
        );
        await client.query(
          `INSERT INTO journal_lines (entry_id, account_id, account_code, narration, debit, credit)
           VALUES ($1,$2,$3,$4,$5,0)`,
          [je.id, acc?.id || null, l.code, l.desc, l.amt]
        );
      }
      for (const l of taxLines) {
        if (l.amt <= 0) continue;
        const { rows: [acc] } = await client.query(
          `SELECT id FROM chart_of_accounts WHERE code=$1 LIMIT 1`, [l.code]
        );
        await client.query(
          `INSERT INTO journal_lines (entry_id, account_id, account_code, narration, debit, credit)
           VALUES ($1,$2,$3,$4,0,$5)`,
          [je.id, acc?.id || null, l.code, l.desc, l.amt]
        );
      }

      // Update totals on journal entry
      await client.query(
        `UPDATE journal_entries SET total_debit=$1, total_credit=$2 WHERE id=$3`,
        [totalGst, totalGst, je.id]
      );

      // Link journal entry to self-invoice and self-invoice to bill
      await client.query(`UPDATE rcm_self_invoices SET journal_entry_id=$1 WHERE id=$2`, [je.id, si.id]);
      await client.query(`UPDATE bills SET rcm_self_invoice_id=$1 WHERE id=$2`, [si.id, bill_id]);

      await client.query('COMMIT');
      return res.status(201).json({
        self_invoice: { ...si, journal_entry_id: je.id },
        journal_entry_number: entryNumber,
        cgst, sgst, igst,
        total_gst: totalGst,
        message: `Self-invoice ${selfInvNumber} generated. RCM journal entry posted.`,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── RCM: GSTR-3B Table 3.1(d) — inward supplies under RCM ───────────────────
router.get('/rcm/gstr3b-table', async (req, res) => {
  const { period } = req.query; // MMYYYY
  if (!period) return res.status(400).json({ error: 'period required (MMYYYY)' });
  const month = parseInt(period.slice(0, 2));
  const year  = parseInt(period.slice(2));
  const companyId = companyOf(req) ?? req.scope?.company_id ?? null;
  try {
    const { rows } = await pool.query(`
      SELECT
        COALESCE(SUM(taxable_value), 0)  AS taxable_value,
        COALESCE(SUM(igst_amount), 0)    AS igst,
        COALESCE(SUM(cgst_amount), 0)    AS cgst,
        COALESCE(SUM(sgst_amount), 0)    AS sgst,
        COUNT(*)::int                    AS invoice_count
      FROM rcm_self_invoices
      WHERE EXTRACT(MONTH FROM invoice_date) = $1
        AND EXTRACT(YEAR  FROM invoice_date) = $2
        AND ($3::int IS NULL OR company_id = $3)
    `, [month, year, companyId]);

    const r = rows[0];
    return res.json({
      period,
      table_3_1_d: {
        description:   'Inward supplies liable to reverse charge',
        taxable_value: parseFloat(r.taxable_value),
        igst:          parseFloat(r.igst),
        cgst:          parseFloat(r.cgst),
        sgst:          parseFloat(r.sgst),
        invoice_count: r.invoice_count,
      },
      note: 'ITC on RCM is claimable in Table 4(A)(3) of GSTR-3B only in the month of actual payment to the government.',
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── CSV helpers ───────────────────────────────────────────────────────────────
function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines   = [headers.map(csvEscape).join(',')];
  for (const row of rows) lines.push(headers.map(h => csvEscape(row[h])).join(','));
  return lines.join('\r\n');
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yyyy = dt.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function fmtAmt(v) { return parseFloat(v || 0).toFixed(2); }

// ── GET /gstr1/export?period=MMYYYY ──────────────────────────────────────────
// Generates a GSTN offline-tool compatible B2B CSV for GSTR-1 filing.
router.get('/gstr1/export', async (req, res) => {
  const { period } = req.query;
  if (!period || !/^\d{6}$/.test(period)) {
    return res.status(400).json({ error: 'period required in MMYYYY format (e.g. 032026)' });
  }

  try {
    const company_id = companyOf(req);
    const month = parseInt(period.slice(0, 2));
    const year  = parseInt(period.slice(2));

    const { rows } = await pool.query(`
      SELECT
        i.invoice_number,
        i.invoice_date,
        i.total_amount,
        p.name    AS receiver_name,
        p.gstin         AS receiver_gstin,
        p.state         AS place_of_supply,
        COALESCE(i.cgst, 0)  AS cgst,
        COALESCE(i.sgst, 0)  AS sgst,
        COALESCE(i.igst, 0)  AS igst,
        i.total_amount - COALESCE(i.cgst,0) - COALESCE(i.sgst,0) - COALESCE(i.igst,0) AS taxable_value,
        COALESCE(i.gst_rate, 18)  AS gst_rate,
        COALESCE(i.hsn_sac, '')   AS hsn_sac,
        COALESCE(i.reverse_charge, false) AS reverse_charge
      FROM invoices i
      LEFT JOIN parties p ON i.customer_id = p.id
      WHERE EXTRACT(MONTH FROM i.invoice_date) = $1
        AND EXTRACT(YEAR  FROM i.invoice_date) = $2
        AND i.company_id = $3
        AND i.status != 'cancelled'
      ORDER BY i.invoice_date, i.invoice_number
    `, [month, year, company_id]);

    const b2bRows = rows.filter(r => r.receiver_gstin);
    const b2cRows = rows.filter(r => !r.receiver_gstin);

    // GSTN offline tool B2B CSV format
    const b2bCsv = toCSV(b2bRows.map(r => ({
      'GSTIN of Recipient':  r.receiver_gstin || '',
      'Receiver Name':       r.receiver_name  || 'Unknown',
      'Invoice Number':      r.invoice_number,
      'Invoice Date':        fmtDate(r.invoice_date),
      'Invoice Value':       fmtAmt(r.total_amount),
      'Place of Supply':     r.place_of_supply || '',
      'Reverse Charge':      r.reverse_charge ? 'Y' : 'N',
      'Applicable % of Tax Rate': '',
      'Invoice Type':        'Regular',
      'E-Commerce GSTIN':    '',
      'Rate':                fmtAmt(r.gst_rate),
      'Taxable Value':       fmtAmt(r.taxable_value),
      'Integrated Tax Amt':  fmtAmt(r.igst),
      'Central Tax Amt':     fmtAmt(r.cgst),
      'State/UT Tax Amt':    fmtAmt(r.sgst),
      'Cess Amount':         '0.00',
    })));

    // B2C large (>2.5L) — simplified format for GSTN
    const b2cCsv = toCSV(b2cRows.map(r => ({
      'Type':                parseFloat(r.total_amount) > 250000 ? 'B2CL' : 'B2CS',
      'Place of Supply':     r.place_of_supply || '',
      'Applicable % of Tax Rate': '',
      'Rate':                fmtAmt(r.gst_rate),
      'Taxable Value':       fmtAmt(r.taxable_value),
      'Integrated Tax Amt':  fmtAmt(r.igst),
      'Central Tax Amt':     fmtAmt(r.cgst),
      'State/UT Tax Amt':    fmtAmt(r.sgst),
      'Cess Amount':         '0.00',
      'E-Commerce GSTIN':    '',
    })));

    const filename = `GSTR1_B2B_${period}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Emit both sections in one file, clearly delimited
    const output = [
      `# GSTR-1 Export — Period: ${period.slice(0,2)}/${period.slice(2)} — Generated: ${new Date().toISOString()}`,
      `# B2B Invoices (${b2bRows.length} records)`,
      b2bCsv || '(none)',
      '',
      `# B2C Invoices (${b2cRows.length} records)`,
      b2cCsv || '(none)',
    ].join('\r\n');

    res.send(output);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /gstr3b/export?period=MMYYYY ─────────────────────────────────────────
// Generates a GSTR-3B summary CSV for the period — matches Table 3.1 through 4.
router.get('/gstr3b/export', async (req, res) => {
  const { period } = req.query;
  if (!period || !/^\d{6}$/.test(period)) {
    return res.status(400).json({ error: 'period required in MMYYYY format (e.g. 032026)' });
  }

  try {
    const company_id = companyOf(req);
    const month = parseInt(period.slice(0, 2));
    const year  = parseInt(period.slice(2));

    const salesRes = await pool.query(`
      SELECT
        COALESCE(SUM(total_amount - COALESCE(cgst,0) - COALESCE(sgst,0) - COALESCE(igst,0)), 0) AS taxable_value,
        COALESCE(SUM(igst), 0) AS igst,
        COALESCE(SUM(cgst), 0) AS cgst,
        COALESCE(SUM(sgst), 0) AS sgst
      FROM invoices
      WHERE EXTRACT(MONTH FROM invoice_date) = $1
        AND EXTRACT(YEAR  FROM invoice_date) = $2
        AND company_id = $3
        AND status != 'cancelled'
    `, [month, year, company_id]);

    const purchaseRes = await pool.query(`
      SELECT
        COALESCE(SUM(total_amount - COALESCE(cgst,0) - COALESCE(sgst,0) - COALESCE(igst,0)), 0) AS taxable_value,
        COALESCE(SUM(igst), 0) AS igst,
        COALESCE(SUM(cgst), 0) AS cgst,
        COALESCE(SUM(sgst), 0) AS sgst
      FROM bills
      WHERE EXTRACT(MONTH FROM bill_date) = $1
        AND EXTRACT(YEAR  FROM bill_date) = $2
        AND company_id = $3
        AND status != 'cancelled'
    `, [month, year, company_id]).catch(() => ({ rows: [{ taxable_value: 0, igst: 0, cgst: 0, sgst: 0 }] }));

    const s = salesRes.rows[0];
    const p = purchaseRes.rows[0];

    const outTax = parseFloat(s.igst) + parseFloat(s.cgst) + parseFloat(s.sgst);
    const itcTax = parseFloat(p.igst) + parseFloat(p.cgst) + parseFloat(p.sgst);
    const net    = Math.max(0, outTax - itcTax);

    const mmm  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][month - 1];
    const rows = [
      { Section: '3.1(a)', Description: 'Outward taxable supplies (other than zero rated, nil and exempted)', 'Taxable Value': fmtAmt(s.taxable_value), 'Integrated Tax': fmtAmt(s.igst), 'Central Tax': fmtAmt(s.cgst), 'State/UT Tax': fmtAmt(s.sgst), Cess: '0.00' },
      { Section: '3.1(b)', Description: 'Outward taxable supplies (zero rated)',                               'Taxable Value': '0.00', 'Integrated Tax': '0.00', 'Central Tax': '0.00', 'State/UT Tax': '0.00', Cess: '0.00' },
      { Section: '3.1(c)', Description: 'Other outward supplies (nil rated, exempted)',                        'Taxable Value': '0.00', 'Integrated Tax': '0.00', 'Central Tax': '0.00', 'State/UT Tax': '0.00', Cess: '0.00' },
      { Section: '3.1(d)', Description: 'Inward supplies (liable to reverse charge)',                         'Taxable Value': '0.00', 'Integrated Tax': '0.00', 'Central Tax': '0.00', 'State/UT Tax': '0.00', Cess: '0.00' },
      { Section: '4(A)(5)', Description: 'ITC Available — All other ITC',                                     'Taxable Value': '',     'Integrated Tax': fmtAmt(p.igst), 'Central Tax': fmtAmt(p.cgst), 'State/UT Tax': fmtAmt(p.sgst), Cess: '0.00' },
      { Section: '6.1',    Description: 'Net Tax Payable (Output Tax − ITC)',                                  'Taxable Value': '',     'Integrated Tax': fmtAmt(Math.max(0, parseFloat(s.igst) - parseFloat(p.igst))), 'Central Tax': fmtAmt(Math.max(0, parseFloat(s.cgst) - parseFloat(p.cgst))), 'State/UT Tax': fmtAmt(Math.max(0, parseFloat(s.sgst) - parseFloat(p.sgst))), Cess: '0.00' },
    ];

    const filename = `GSTR3B_${period}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const header = `# GSTR-3B Summary — Period: ${mmm} ${year} — Generated: ${new Date().toISOString()}\r\n`;
    res.send(header + toCSV(rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /gst/e-invoice/generate — E-Invoice (IRN) stub ──────────────────────
// Legal mandate under GST Rule 48(4) for businesses with turnover > ₹5 Cr.
// Stub: validates invoice, returns structured payload ready for IRP API submission.
// Real integration requires NIC IRP API credentials configured in environment.
router.post('/e-invoice/generate', requirePermission('finance', 'add'), async (req, res) => {
  const { invoice_id } = req.body;
  const companyId = companyOf(req) ?? req.scope?.company_id ?? null;
  try {
    const { rows: [inv] } = await pool.query(
      `SELECT i.*, p.gstin AS buyer_gstin, p.name AS buyer_name
       FROM invoices i LEFT JOIN parties p ON p.id = i.customer_id
       WHERE i.id = $1 AND i.company_id = $2`, [invoice_id, companyId]
    );
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (inv.irn) return res.status(409).json({ error: 'IRN already generated for this invoice', irn: inv.irn });

    // Build IRP-compatible payload (NIC API v1.03 format)
    const irpPayload = {
      Version: '1.1',
      TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', EcmGstin: null },
      DocDtls: {
        Typ: 'INV',
        No: inv.invoice_number,
        Dt: new Date(inv.invoice_date).toLocaleDateString('en-IN').replace(/\//g, '/'),
      },
      SellerDtls: { Gstin: inv.supplier_gstin || 'SELLER_GSTIN', LglNm: inv.company_name || 'Seller Name' },
      BuyerDtls: { Gstin: inv.buyer_gstin || 'URP', LglNm: inv.buyer_name, Pos: inv.place_of_supply || '29' },
      ValDtls: {
        AssVal: parseFloat(inv.taxable_amount || 0),
        CgstVal: parseFloat(inv.cgst || 0),
        SgstVal: parseFloat(inv.sgst || 0),
        IgstVal: parseFloat(inv.igst || 0),
        TotInvVal: parseFloat(inv.total_amount || 0),
      },
    };

    // If IRP credentials are configured, submit to NIC; otherwise return stub
    const irpApiKey = process.env.IRP_API_KEY;
    if (!irpApiKey) {
      return res.status(200).json({
        stub: true,
        message: 'E-Invoice integration not configured. Set IRP_API_KEY, IRP_API_SECRET, IRP_GSTIN in environment to activate.',
        irp_payload: irpPayload,
      });
    }

    // Placeholder for real IRP API call
    return res.status(501).json({ error: 'IRP API integration pending. Payload ready for submission.', irp_payload: irpPayload });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /gst/e-way-bill/generate — E-Way Bill stub ──────────────────────────
// Legal mandate under GST Rule 138 for goods movement > ₹50,000.
router.post('/e-way-bill/generate', requirePermission('finance', 'add'), async (req, res) => {
  const { invoice_id, vehicle_number, transporter_id, transport_mode } = req.body;
  const companyId = companyOf(req) ?? req.scope?.company_id ?? null;
  try {
    const { rows: [inv] } = await pool.query(
      `SELECT i.*, p.gstin AS buyer_gstin, p.name AS buyer_name
       FROM invoices i LEFT JOIN parties p ON p.id = i.customer_id
       WHERE i.id = $1 AND i.company_id = $2`, [invoice_id, companyId]
    );
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    const ewaybPayload = {
      supplyType: 'O',
      docType: 'INV',
      docNo: inv.invoice_number,
      docDate: new Date(inv.invoice_date).toLocaleDateString('en-IN'),
      fromGstin: inv.supplier_gstin || 'FROM_GSTIN',
      toGstin: inv.buyer_gstin || 'URP',
      vehicleNo: vehicle_number || '',
      transporterId: transporter_id || '',
      transportMode: transport_mode || '1',
      totValue: parseFloat(inv.total_amount || 0),
      cgstValue: parseFloat(inv.cgst || 0),
      sgstValue: parseFloat(inv.sgst || 0),
      igstValue: parseFloat(inv.igst || 0),
    };

    const ewaybApiKey = process.env.EWAYBILL_API_KEY;
    if (!ewaybApiKey) {
      return res.status(200).json({
        stub: true,
        message: 'E-Way Bill integration not configured. Set EWAYBILL_API_KEY in environment to activate.',
        ewb_payload: ewaybPayload,
      });
    }
    return res.status(501).json({ error: 'E-Way Bill API integration pending.', ewb_payload: ewaybPayload });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /gst/gstr9 — GSTR-9 Annual Return ────────────────────────────────────
// CGST Act Section 44 — annual return; penalty ₹200/day if not filed.
router.get('/gstr9', requirePermission('finance', 'view'), async (req, res) => {
  const { financial_year } = req.query;
  const companyId = companyOf(req) ?? req.scope?.company_id ?? null;
  const now = new Date();
  const fyYear = financial_year || (now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1);
  const fyStart = `${fyYear}-04-01`;
  const fyEnd   = `${parseInt(fyYear) + 1}-03-31`;

  try {
    const [salesRow, purchaseRow, itcRow] = await Promise.all([
      pool.query(`
        SELECT
          COALESCE(SUM(taxable_amount), 0) AS taxable_value,
          COALESCE(SUM(cgst), 0) AS cgst,
          COALESCE(SUM(sgst), 0) AS sgst,
          COALESCE(SUM(igst), 0) AS igst,
          COALESCE(SUM(total_amount), 0) AS total_value
        FROM invoices
        WHERE DATE(invoice_date) BETWEEN $1 AND $2
          AND company_id = $3
          AND status NOT IN ('draft','cancelled')
      `, [fyStart, fyEnd, companyId]),

      pool.query(`
        SELECT
          COALESCE(SUM(taxable_amount), 0) AS taxable_value,
          COALESCE(SUM(cgst), 0) AS cgst,
          COALESCE(SUM(sgst), 0) AS sgst,
          COALESCE(SUM(igst), 0) AS igst,
          COALESCE(SUM(total_amount), 0) AS total_value
        FROM bills
        WHERE DATE(bill_date) BETWEEN $1 AND $2
          AND company_id = $3
          AND status NOT IN ('draft','cancelled')
      `, [fyStart, fyEnd, companyId]),

      pool.query(`
        SELECT
          COALESCE(SUM(jl.debit - jl.credit), 0) AS itc_claimed
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        JOIN chart_of_accounts coa ON coa.id = jl.account_id
        WHERE coa.code IN ('1020','1021','1022')
          AND je.status = 'posted'
          AND DATE(je.entry_date) BETWEEN $1 AND $2
          AND jl.company_id = $3
      `, [fyStart, fyEnd, companyId]),
    ]);

    res.json({
      financial_year: `${fyYear}-${parseInt(fyYear) + 1}`,
      period: { from: fyStart, to: fyEnd },
      outward_supplies: salesRow.rows[0],
      inward_supplies: purchaseRow.rows[0],
      itc_claimed: parseFloat(itcRow.rows[0]?.itc_claimed ?? 0),
      note: 'GSTR-9 summary view. For official filing, verify with GSTN portal and your CA.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /gst/itc-ledger — ITC (Input Tax Credit) Ledger ──────────────────────
router.get('/itc-ledger', requirePermission('finance', 'view'), async (req, res) => {
  const { from_date, to_date } = req.query;
  const companyId = companyOf(req) ?? req.scope?.company_id ?? null;
  const now = new Date();
  const fyStart = from_date || `${now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1}-04-01`;
  const fyEnd   = to_date   || now.toISOString().split('T')[0];

  try {
    const { rows } = await pool.query(`
      SELECT
        DATE(je.entry_date)        AS date,
        je.entry_number,
        je.description,
        coa.code                   AS account_code,
        coa.name                   AS account_name,
        CASE coa.code
          WHEN '1020' THEN 'CGST ITC'
          WHEN '1021' THEN 'SGST ITC'
          WHEN '1022' THEN 'IGST ITC'
        END AS itc_type,
        jl.debit                   AS itc_claimed,
        jl.credit                  AS itc_utilized,
        je.reference_type,
        je.reference_id
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      JOIN chart_of_accounts coa ON coa.id = jl.account_id
      WHERE coa.code IN ('1020','1021','1022')
        AND je.status = 'posted'
        AND DATE(je.entry_date) BETWEEN $1 AND $2
        AND jl.company_id = $3
      ORDER BY je.entry_date, je.entry_number
    `, [fyStart, fyEnd, companyId]);

    const totalClaimed  = rows.reduce((s, r) => s + parseFloat(r.itc_claimed || 0), 0);
    const totalUtilized = rows.reduce((s, r) => s + parseFloat(r.itc_utilized || 0), 0);

    res.json({
      period: { from: fyStart, to: fyEnd },
      summary: { total_claimed: totalClaimed, total_utilized: totalUtilized, balance: totalClaimed - totalUtilized },
      ledger: rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;