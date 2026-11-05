/**
 * eInvoice.service.js — IRP (e-invoice) and e-way-bill payload construction.
 *
 * Finance audit finding F15.
 *
 * ── WHAT THE ROUTES USED TO DO ──────────────────────────────────────────────
 * POST /gst/e-invoice/generate assembled an object it described as "payload
 * ready for IRP submission" and returned it with `stub: true`, or HTTP 501 once
 * credentials were set. Setting credentials would not have made it work, and
 * the payload was not ready:
 *
 *   - NO ItemList. The IRP schema requires one line per item; a payload without
 *     it is rejected outright. Nothing in the object carried any invoice line.
 *   - Dt used `toLocaleDateString('en-IN')`, which yields 1/4/2026 for the 1st
 *     of April. The schema requires DD/MM/YYYY, zero padded.
 *   - SellerDtls read `inv.supplier_gstin` and `inv.company_name`, neither of
 *     which is a column on invoices, so it always fell through to the literal
 *     strings 'SELLER_GSTIN' and 'Seller Name'.
 *   - AssVal took `inv.subtotal`, with a comment in the code conceding the
 *     figure was always 0.
 *   - Pos defaulted to the hardcoded string '29' (Karnataka) for any invoice
 *     without a place of supply.
 *   - Nothing was validated, so none of the above surfaced as an error.
 *
 * ── WHAT THIS DOES ──────────────────────────────────────────────────────────
 * Builds the payload properly — seller from the companies row, buyer from the
 * party, one ItemList entry per invoice line with HSN and per-line tax, correct
 * date format — and validates it, returning every problem at once rather than
 * failing on the first.
 *
 * ── WHAT IS STILL NOT DONE, AND WHY ─────────────────────────────────────────
 * The HTTP call to the IRP is NOT implemented. It needs a chosen provider (NIC
 * directly, or a GSP), production and sandbox credentials, and a sandbox run to
 * verify — none of which can be supplied or tested from here. Writing an
 * untested network integration and reporting it as working would be worse than
 * this: `submitToIrp` throws a clearly-coded error, so the endpoint reports
 * honestly that the payload is valid and submission is unconfigured, instead of
 * claiming readiness it has not earned.
 */

const IRP_DATE = (d) => {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(dt.getDate())}/${p(dt.getMonth() + 1)}/${dt.getFullYear()}`;
};

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

/** GSTIN: 2-digit state code, 10-char PAN, entity digit, 'Z', checksum. */
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

/**
 * Assemble the IRP payload for one invoice.
 * @returns {{payload: object, problems: string[], invoice: object}}
 */
export async function buildIrpPayload(executor, { invoiceId, companyId }) {
  const { rows: [inv] } = await executor.query(
    `SELECT i.*,
            p.gstin AS buyer_gstin, p.name AS buyer_name,
            p.address AS buyer_address, p.state AS buyer_state,
            c.gstin AS seller_gstin, c.name AS seller_name,
            c.address AS seller_address, c.state AS seller_state,
            c.state_code AS seller_state_code
       FROM invoices i
       LEFT JOIN parties p   ON p.id = i.customer_id
       LEFT JOIN companies c ON c.id = i.company_id
      WHERE i.id = $1 AND ($2::int IS NULL OR i.company_id = $2::int)`,
    [invoiceId, companyId]
  );
  if (!inv) {
    const e = new Error('Invoice not found');
    e.status = 404;
    throw e;
  }

  const { rows: items } = await executor.query(
    `SELECT description, quantity, unit_price, hsn_code, sac_code,
            gst_rate, cgst_amount, sgst_amount, igst_amount,
            taxable_value, amount
       FROM invoice_items WHERE invoice_id = $1 ORDER BY id`,
    [invoiceId]
  );

  const problems = [];
  if (!inv.seller_gstin) problems.push('Seller GSTIN is not set on the company record.');
  else if (!GSTIN_RE.test(String(inv.seller_gstin).toUpperCase())) {
    problems.push(`Seller GSTIN '${inv.seller_gstin}' is not a valid GSTIN.`);
  }
  // A buyer without a GSTIN is legitimate (unregistered person) and is sent as
  // 'URP', but a malformed one is an error rather than something to pass along.
  if (inv.buyer_gstin && !GSTIN_RE.test(String(inv.buyer_gstin).toUpperCase())) {
    problems.push(`Buyer GSTIN '${inv.buyer_gstin}' is not a valid GSTIN.`);
  }
  if (!inv.invoice_number) problems.push('Invoice number is missing.');
  const docDate = IRP_DATE(inv.invoice_date);
  if (!docDate) problems.push('Invoice date is missing or unparseable.');
  if (items.length === 0) problems.push('Invoice has no line items; the IRP schema requires at least one.');
  if (!inv.place_of_supply && !inv.seller_state_code) {
    problems.push('Place of supply is not set and the company has no state code to fall back on.');
  }

  const itemList = items.map((it, idx) => {
    const hsn = it.hsn_code || it.sac_code;
    if (!hsn) problems.push(`Line ${idx + 1} ("${it.description}") has no HSN or SAC code.`);
    const taxable = it.taxable_value != null ? num(it.taxable_value) : num(it.amount);
    return {
      SlNo: String(idx + 1),
      PrdDesc: it.description,
      IsServc: it.sac_code && !it.hsn_code ? 'Y' : 'N',
      HsnCd: hsn || null,
      Qty: num(it.quantity),
      UnitPrice: num(it.unit_price),
      TotAmt: taxable,
      AssAmt: taxable,
      GstRt: num(it.gst_rate),
      CgstAmt: num(it.cgst_amount),
      SgstAmt: num(it.sgst_amount),
      IgstAmt: num(it.igst_amount),
      TotItemVal: num(taxable + num(it.cgst_amount) + num(it.sgst_amount) + num(it.igst_amount)),
    };
  });

  // Assessable value is the sum of the line taxable values, not invoices.subtotal
  // (which the previous code itself noted was always zero).
  const assVal = num(itemList.reduce((s, i) => s + i.AssAmt, 0));
  const cgst = num(inv.cgst);
  const sgst = num(inv.sgst);
  const igst = num(inv.igst);
  const totInvVal = num(inv.total_amount);

  const computed = num(assVal + cgst + sgst + igst);
  if (totInvVal && Math.abs(computed - totInvVal) > 1) {
    problems.push(
      `Invoice total ${totInvVal.toFixed(2)} does not agree with lines plus tax ` +
      `(${assVal.toFixed(2)} + ${(cgst + sgst + igst).toFixed(2)} = ${computed.toFixed(2)}).`
    );
  }

  const payload = {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', EcmGstin: null },
    DocDtls: { Typ: 'INV', No: inv.invoice_number, Dt: docDate },
    SellerDtls: {
      Gstin: inv.seller_gstin ? String(inv.seller_gstin).toUpperCase() : null,
      LglNm: inv.seller_name || null,
      Addr1: inv.seller_address || null,
      Loc: inv.seller_state || null,
      Stcd: inv.seller_state_code || null,
    },
    BuyerDtls: {
      Gstin: inv.buyer_gstin ? String(inv.buyer_gstin).toUpperCase() : 'URP',
      LglNm: inv.buyer_name || null,
      Addr1: inv.buyer_address || null,
      Loc: inv.buyer_state || null,
      // Place of supply falls back to the SELLER's state code (intra-state),
      // never to a hardcoded '29'.
      Pos: inv.place_of_supply || inv.seller_state_code || null,
    },
    ItemList: itemList,
    ValDtls: {
      AssVal: assVal,
      CgstVal: cgst,
      SgstVal: sgst,
      IgstVal: igst,
      TotInvVal: totInvVal || computed,
    },
  };

  return { payload, problems, invoice: inv };
}

/**
 * Assemble the e-way-bill payload. Shares the invoice/seller/buyer resolution
 * with the IRP payload so the two cannot describe the same invoice differently.
 */
export async function buildEwbPayload(executor, { invoiceId, companyId, vehicleNumber, transporterId, transportMode, distanceKm }) {
  const { payload: irp, problems, invoice } = await buildIrpPayload(executor, { invoiceId, companyId });

  const MODES = { road: '1', rail: '2', air: '3', ship: '4' };
  const mode = MODES[String(transportMode || 'road').toLowerCase()];
  if (!mode) problems.push(`Unknown transport mode '${transportMode}'. Expected road, rail, air or ship.`);
  // Rule 138: a road consignment needs either a vehicle number or a transporter.
  if (mode === '1' && !vehicleNumber && !transporterId) {
    problems.push('A road consignment needs either a vehicle number or a transporter ID.');
  }
  if (distanceKm != null && !(parseFloat(distanceKm) >= 0)) {
    problems.push('Distance must be a non-negative number of kilometres.');
  }

  return {
    payload: {
      ...irp,
      EwbDtls: {
        TransId: transporterId || null,
        TransMode: mode || null,
        Distance: distanceKm != null ? parseInt(distanceKm, 10) : 0,
        VehNo: vehicleNumber || null,
        VehType: 'R',
      },
    },
    problems,
    invoice,
  };
}

/** True when every credential the IRP client would need is present. */
export function irpConfigured() {
  return Boolean(process.env.IRP_API_KEY && process.env.IRP_API_SECRET && process.env.IRP_GSTIN);
}

/**
 * Submit to the IRP. NOT IMPLEMENTED — see the file header.
 *
 * It throws rather than returning a fabricated acknowledgement so that no caller
 * can mistake an unconfigured install for a successful filing, and so the day
 * someone wires a provider in, there is exactly one place to do it.
 */
export async function submitToIrp() {
  const e = new Error(
    'IRP submission is not implemented. The payload is built and validated, but sending it ' +
    'requires a chosen provider (NIC or a GSP), credentials, and a sandbox verification run.'
  );
  e.status = 501;
  e.code = 'IRP_NOT_IMPLEMENTED';
  throw e;
}

export default { buildIrpPayload, buildEwbPayload, irpConfigured, submitToIrp, GSTIN_RE };
