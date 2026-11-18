import PDFDocument from 'pdfkit';

/**
 * Full & final settlement statement for the leaver (exit review 2026-11-17).
 * Content is one saved settlement version (fnf_settlements), drawn as it was
 * computed; nothing is recalculated here.
 *
 * Same conventions as utils/probationLetterPdf.js: pdfkit's built-in WinAnsi
 * fonts (text outside Latin-1 degrades to "?", so amounts use "Rs."), no logo.
 * A statement of a version that is not approved yet says DRAFT on its face.
 */
const ACCENT = '#4c1d95';
const LEFT = 50;
const RIGHT = 545;
const WIDTH = RIGHT - LEFT;

const safe = (v, fallback = '') => {
  const s = v == null ? '' : String(v);
  const cleaned = s.replace(/—|–|−/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/₹/g, 'Rs.')
    .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, '?');
  return cleaned.trim() ? cleaned : fallback;
};
const money = (n) => `Rs. ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * @param c.company   { name, address }
 * @param c.employee  { name, office_id, designation, department, joining_date, last_working_date, separation }
 * @param c.settlement { version, computed_on, lines[], total_payable, total_recoverable, net_payable }
 * @param c.state     'draft' | 'approved' | 'paid'
 * @param c.payment   { utr, value_date } when paid
 * @param c.issuedOn  date text
 */
export function buildFnfStatementPdf({ company, employee, settlement, state, payment, issuedOn }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: 'Full and Final Settlement Statement', Author: safe(company?.name) } });
      const chunks = [];
      doc.on('data', (b) => chunks.push(b));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.font('Helvetica-Bold').fontSize(16).fillColor(ACCENT).text(safe(company?.name, ' '), LEFT, 50, { width: WIDTH });
      if (company?.address) doc.font('Helvetica').fontSize(9).fillColor('#555').text(safe(company.address), LEFT, doc.y + 2, { width: WIDTH });
      doc.moveDown(0.6);
      doc.lineWidth(1.2).strokeColor(ACCENT).moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).stroke();
      doc.moveDown(1);

      doc.font('Helvetica-Bold').fontSize(13).fillColor('#111').text('Full and Final Settlement Statement', LEFT, doc.y, { width: WIDTH, align: 'center' });
      if (state !== 'approved' && state !== 'paid') {
        doc.moveDown(0.3);
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#b91c1c')
          .text('DRAFT - not yet approved. Figures may change.', LEFT, doc.y, { width: WIDTH, align: 'center' });
      }
      doc.moveDown(1);

      const rows = [
        ['Employee', `${safe(employee.name)}${employee.office_id ? ` (${safe(employee.office_id)})` : ''}`],
        ['Designation / Department', [employee.designation, employee.department].filter(Boolean).map(x => safe(x)).join(' / ') || '-'],
        ['Date of joining', safe(employee.joining_date, '-')],
        ['Last working day', safe(employee.last_working_date, '-')],
        ['Separation', safe(employee.separation, '-')],
        ['Settlement version', `${settlement.version}, computed ${safe(settlement.computed_on, '-')}`],
        ['Status', state === 'paid' ? `Paid on ${safe(payment?.value_date, '-')}, bank reference ${safe(payment?.utr, '-')}` : state === 'approved' ? 'Approved, payment pending' : 'Draft'],
      ];
      doc.fontSize(10);
      for (const [k, v] of rows) {
        const y = doc.y;
        doc.font('Helvetica').fillColor('#555').text(k, LEFT, y, { width: 160 });
        doc.font('Helvetica').fillColor('#111').text(v, LEFT + 170, y, { width: WIDTH - 170 });
        doc.moveDown(0.25);
      }
      doc.moveDown(0.8);

      // Lines
      const colAmt = 110;
      const header = (y) => {
        doc.rect(LEFT, y, WIDTH, 18).fill('#f3f0ff');
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#111')
          .text('Component', LEFT + 6, y + 5, { width: WIDTH - 2 * colAmt - 12 })
          .text('Earnings', RIGHT - 2 * colAmt, y + 5, { width: colAmt - 6, align: 'right' })
          .text('Deductions', RIGHT - colAmt, y + 5, { width: colAmt - 6, align: 'right' });
        return y + 22;
      };
      let y = header(doc.y);
      for (const l of settlement.lines || []) {
        if (!Number(l.amount)) continue;
        const h = Math.max(14, doc.heightOfString(safe(l.label), { width: WIDTH - 2 * colAmt - 12 }) + 4);
        if (y + h > 760) { doc.addPage(); y = header(60); }
        const pay = l.direction === 'payable';
        doc.font('Helvetica').fontSize(9.5).fillColor('#111')
          .text(safe(l.label), LEFT + 6, y, { width: WIDTH - 2 * colAmt - 12 })
          .text(pay ? money(l.amount) : '', RIGHT - 2 * colAmt, y, { width: colAmt - 6, align: 'right' })
          .text(pay ? '' : money(l.amount), RIGHT - colAmt, y, { width: colAmt - 6, align: 'right' });
        y += h;
        doc.lineWidth(0.4).strokeColor('#e5e7eb').moveTo(LEFT, y - 2).lineTo(RIGHT, y - 2).stroke();
      }
      y += 4;
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#111')
        .text('Total', LEFT + 6, y, { width: WIDTH - 2 * colAmt - 12 })
        .text(money(settlement.total_payable), RIGHT - 2 * colAmt, y, { width: colAmt - 6, align: 'right' })
        .text(money(settlement.total_recoverable), RIGHT - colAmt, y, { width: colAmt - 6, align: 'right' });
      y += 24;
      doc.rect(LEFT, y, WIDTH, 26).fill('#4c1d95');
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#fff')
        .text(Number(settlement.net_payable) < 0 ? 'Net recoverable from employee' : 'Net payable to employee', LEFT + 8, y + 8, { width: WIDTH / 2 })
        .text(money(Math.abs(Number(settlement.net_payable))), LEFT + WIDTH / 2, y + 8, { width: WIDTH / 2 - 8, align: 'right' });
      doc.y = y + 40;

      doc.font('Helvetica').fontSize(8.5).fillColor('#555')
        .text(`Issued ${safe(issuedOn)}. This statement shows settlement version ${settlement.version} as computed; zero-value components are not listed. `
          + 'Tax deducted is shown as a deduction and is reported in Form 16. Please raise any question with HR within 30 days.', LEFT, doc.y, { width: WIDTH });
      doc.end();
    } catch (e) { reject(e); }
  });
}
