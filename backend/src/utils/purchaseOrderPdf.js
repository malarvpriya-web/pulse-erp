import PDFDocument from 'pdfkit';

/**
 * A formal Purchase Order document, as a PDF buffer, to attach to the mail that
 * already goes to the vendor on approval.
 *
 * The HTML summary in sendPurchaseOrderToVendor() is what the buyer reads in
 * their client; this is the artefact the vendor files, prints and quotes back in
 * a dispute. It carries the same figures — never a second calculation of them.
 *
 * ⚠⚠ CURRENCY IS `Rs.`, NOT `₹`, AND THAT IS DELIBERATE.
 * pdfkit's 14 built-in fonts are WinAnsi-encoded, and U+20B9 (₹) is not in
 * WinAnsi — it does not throw, it silently renders as a DIFFERENT glyph, so
 * every amount on a vendor-facing document would be wrong in a way that looks
 * like a font problem rather than a data problem. Fixing it properly means
 * shipping and embedding a Unicode TTF; there is none in this repo. Same choice,
 * for the same reason, as the payslip PDF in payroll.controller.js — keep them
 * consistent. The e-mail body stays on ₹: HTML is UTF-8 and has no such limit.
 *
 * No logo: brand assets are locked and must not be placed or resized without an
 * explicit instruction. The company NAME is text, which is enough to make the
 * document formal.
 *
 * Never throws for bad input — a missing item array or a null rate yields a
 * thinner document, not an exception. The caller's contract is fire-and-forget:
 * a PO that is already approved and committed must not be undone by a rendering
 * problem.
 */

const ACCENT = '#7c3aed';
const LEFT = 50;
const RIGHT = 545;

/** Columns: name gets the slack, the three money columns are right-aligned. */
const COLS = {
  name: { x: LEFT, w: 225 },
  qty: { x: 280, w: 75 },
  rate: { x: 360, w: 85 },
  amount: { x: 450, w: 95 },
};

const money = (n) =>
  `Rs.${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** WinAnsi cannot render every character a user may have typed into a name. */
const safe = (v, fallback = '') => {
  const s = v === null || v === undefined ? '' : String(v);
  // Replace anything outside Latin-1 so a CJK or emoji item name degrades to a
  // visible marker instead of a wrong glyph.
  const cleaned = s.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?').trim();
  return cleaned || fallback;
};

function header(doc, { poNumber, poDate, companyName, companyAddress }) {
  doc.fontSize(18).fillColor(ACCENT).font('Helvetica-Bold')
    .text(safe(companyName, 'Purchase Order'), LEFT, 50, { align: 'center', width: RIGHT - LEFT });
  if (companyAddress) {
    doc.fontSize(10).fillColor('#555').font('Helvetica')
      .text(safe(companyAddress), { align: 'center', width: RIGHT - LEFT });
  }
  doc.moveDown(0.5);
  doc.fontSize(13).fillColor('#111').font('Helvetica-Bold')
    .text('PURCHASE ORDER', { align: 'center', width: RIGHT - LEFT });
  doc.moveTo(LEFT, doc.y + 6).lineTo(RIGHT, doc.y + 6).strokeColor(ACCENT).stroke();
  doc.moveDown(1);

  const top = doc.y;
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#111')
    .text(`PO Number: ${safe(poNumber, '-')}`, LEFT, top);
  if (poDate) {
    doc.font('Helvetica').fillColor('#555')
      .text(`Date: ${safe(poDate)}`, LEFT, doc.y + 2);
  }
  doc.y = Math.max(doc.y, top) + 10;
}

/** Column headings, drawn once per page so a continuation page is readable. */
function tableHead(doc) {
  const y = doc.y;
  doc.rect(LEFT, y - 2, RIGHT - LEFT, 18).fill('#f5f3ff');
  doc.fillColor('#111').fontSize(9).font('Helvetica-Bold');
  doc.text('Item', COLS.name.x + 4, y + 3, { width: COLS.name.w });
  doc.text('Qty', COLS.qty.x, y + 3, { width: COLS.qty.w, align: 'right' });
  doc.text('Rate', COLS.rate.x, y + 3, { width: COLS.rate.w, align: 'right' });
  doc.text('Amount', COLS.amount.x - 4, y + 3, { width: COLS.amount.w, align: 'right' });
  doc.y = y + 20;
}

function lineItems(doc, items) {
  tableHead(doc);
  doc.font('Helvetica').fontSize(9).fillColor('#111');

  for (const it of items) {
    // Reserve room for the row plus the totals block; otherwise a PO whose last
    // line lands at the page edge prints its total on a page of its own.
    if (doc.y > 690) {
      doc.addPage();
      doc.y = 50;
      tableHead(doc);
      doc.font('Helvetica').fontSize(9).fillColor('#111');
    }

    const name = safe(it?.item_name ?? it?.item_code, 'Item');
    const uom = safe(it?.unit_of_measure);
    const y = doc.y;

    doc.text(name, COLS.name.x + 4, y, { width: COLS.name.w, ellipsis: true, height: 22 });
    const nameBottom = doc.y;
    doc.text(`${Number(it?.quantity || 0)}${uom ? ` ${uom}` : ''}`, COLS.qty.x, y, { width: COLS.qty.w, align: 'right' });
    doc.text(money(it?.rate), COLS.rate.x, y, { width: COLS.rate.w, align: 'right' });
    doc.text(money(it?.total_amount), COLS.amount.x - 4, y, { width: COLS.amount.w, align: 'right' });

    doc.y = Math.max(nameBottom, y + 12) + 4;
    doc.moveTo(LEFT, doc.y - 2).lineTo(RIGHT, doc.y - 2).strokeColor('#eee').stroke();
  }
}

function totals(doc, totalAmount) {
  doc.moveDown(0.5);
  const y = doc.y;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111');
  doc.text('Total', COLS.rate.x, y, { width: COLS.rate.w, align: 'right' });
  doc.text(money(totalAmount), COLS.amount.x - 4, y, { width: COLS.amount.w, align: 'right' });
  doc.y = y + 18;
}

/**
 * @returns {Promise<Buffer>} the rendered PO.
 */
export function buildPurchaseOrderPdf({
  poNumber, vendorName, items, totalAmount, expectedDeliveryDate, termsConditions,
  poDate, companyName, companyAddress,
} = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      header(doc, {
        poNumber, poDate,
        companyName: companyName || process.env.COMPANY_NAME || 'Manifest Technologies Pvt. Ltd.',
        companyAddress: companyAddress || process.env.COMPANY_ADDRESS || 'Chennai, Tamil Nadu',
      });

      doc.fontSize(10).font('Helvetica-Bold').fillColor('#111').text('Supplier', LEFT, doc.y);
      doc.font('Helvetica').fillColor('#333').text(safe(vendorName, 'Vendor'), LEFT, doc.y + 2);
      doc.moveDown(1);

      lineItems(doc, Array.isArray(items) ? items : []);
      totals(doc, totalAmount);

      if (expectedDeliveryDate) {
        doc.font('Helvetica').fontSize(10).fillColor('#111')
          .text(`Expected delivery: ${safe(expectedDeliveryDate)}`, LEFT, doc.y + 4);
      }
      if (termsConditions) {
        doc.moveDown(0.8);
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#111').text('Terms & Conditions', LEFT, doc.y);
        doc.font('Helvetica').fontSize(9).fillColor('#555')
          .text(safe(termsConditions), LEFT, doc.y + 2, { width: RIGHT - LEFT });
      }

      doc.moveDown(1.5);
      doc.fontSize(8).fillColor('#9ca3af').font('Helvetica')
        .text('Computer-generated Purchase Order issued from Pulse ERP. No signature required.',
          LEFT, doc.y, { width: RIGHT - LEFT, align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

export default buildPurchaseOrderPdf;
