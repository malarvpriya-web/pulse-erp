import PDFDocument from 'pdfkit';
import { RATING_FIELDS, RATING_SCALE, RECOMMENDATIONS } from '../shared/internship.js';

/**
 * Internship documents as PDF buffers: the Completion Certificate and the
 * Mentor Evaluation Letter. Wording comes from the company's template
 * (shared/internshipTemplates.js); layout is drawn here.
 *
 * Same conventions as utils/purchaseOrderPdf.js: pdfkit's built-in WinAnsi
 * fonts, so text outside Latin-1 degrades to "?" instead of a wrong glyph, and
 * no logo (brand assets are not placed without an explicit instruction).
 */

const ACCENT = '#1e3a8a';
const LEFT = 60;
const RIGHT = 535;
const WIDTH = RIGHT - LEFT;

const safe = (v, fallback = '') => {
  const s = v == null ? '' : String(v);
  const cleaned = s.replace(/—|–/g, '-').replace(/[^\x20-\x7E\xA0-\xFF\n]/g, '?');
  return cleaned.trim() ? cleaned : fallback;
};

function toBuffer(draw, options) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50, ...options });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      draw(doc);
      doc.end();
    } catch (err) { reject(err); }
  });
}

/** Paragraphs separated by blank lines; single newlines kept as line breaks. */
function body(doc, text, { size = 11.5, align = 'justify', gap = 0.6 } = {}) {
  for (const para of safe(text).split(/\n{2,}/)) {
    doc.font('Helvetica').fontSize(size).fillColor('#111')
      .text(para, LEFT, doc.y, { width: WIDTH, align, lineGap: 3 });
    doc.moveDown(gap);
  }
}

/**
 * Certificate. `heading`, `text` (already rendered), number, issue date,
 * company, signatory. A border and a centred title; the body is the template.
 */
export function buildCertificatePdf({ heading, text, certificateNumber, issueDate, companyName, signatoryName, signatoryTitle }) {
  return toBuffer((doc) => {
    const { width: pw, height: ph } = doc.page;
    doc.lineWidth(3).strokeColor(ACCENT).rect(25, 25, pw - 50, ph - 50).stroke();
    doc.lineWidth(0.8).rect(33, 33, pw - 66, ph - 66).stroke();

    doc.y = 80;
    doc.font('Helvetica-Bold').fontSize(16).fillColor(ACCENT)
      .text(safe(companyName, ' '), LEFT, doc.y, { width: WIDTH, align: 'center' });
    doc.moveDown(1.6);
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#111')
      .text(safe(heading, 'CERTIFICATE'), LEFT, doc.y, { width: WIDTH, align: 'center' });
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(10).fillColor('#555')
      .text(`Certificate No: ${safe(certificateNumber, '-')}      Date of Issue: ${safe(issueDate, '-')}`,
        LEFT, doc.y, { width: WIDTH, align: 'center' });
    doc.moveDown(2);
    body(doc, text, { size: 12.5, align: 'justify', gap: 0.8 });

    const y = Math.max(doc.y + 60, ph - 200);
    doc.moveTo(RIGHT - 190, y).lineTo(RIGHT, y).strokeColor('#333').lineWidth(0.8).stroke();
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111')
      .text(safe(signatoryName, ' '), RIGHT - 190, y + 6, { width: 190, align: 'center' });
    doc.font('Helvetica').fontSize(10).fillColor('#555')
      .text(safe(signatoryTitle, 'Authorized Signatory'), RIGHT - 190, doc.y + 2, { width: 190, align: 'center' });
    doc.font('Helvetica').fontSize(10).fillColor('#555')
      .text(safe(companyName, ' '), RIGHT - 190, doc.y + 2, { width: 190, align: 'center' });
  }, { layout: 'portrait' });
}

const box = (doc, x, y, checked) => {
  doc.lineWidth(0.8).strokeColor('#333').rect(x, y, 10, 10).stroke();
  if (checked) doc.font('Helvetica-Bold').fontSize(9).fillColor('#111').text('X', x + 2, y + 1, { lineBreak: false });
};

/**
 * Mentor evaluation letter / form. With `evaluation` filled (ratings,
 * recommendation, comments, dates) it is the completed evaluation document;
 * blank, it is the form the mentor fills by hand.
 */
export function buildEvaluationLetterPdf({ heading, text, companyName, intern, mentorName, evaluation = null }) {
  return toBuffer((doc) => {
    doc.font('Helvetica-Bold').fontSize(14).fillColor(ACCENT)
      .text(safe(companyName, ' '), LEFT, 50, { width: WIDTH, align: 'center' });
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111')
      .text(safe(heading, 'INTERNSHIP EVALUATION'), { width: WIDTH, align: 'center' });
    doc.moveTo(LEFT, doc.y + 6).lineTo(RIGHT, doc.y + 6).strokeColor(ACCENT).lineWidth(1).stroke();
    doc.moveDown(1.2);

    // Particulars
    const rows = [
      ['Intern Name', intern.intern_name], ['Intern ID', intern.intern_code],
      ['Department', intern.department], ['Internship Role', intern.internship_role],
      ['Internship Period', intern.internship_period], ['Mentor Name', mentorName],
      ['Project / Work Assigned', intern.project_work_area],
    ];
    for (const [k, v] of rows) {
      const y = doc.y;
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#333').text(`${k}:`, LEFT, y, { width: 150 });
      doc.font('Helvetica').fontSize(10).fillColor('#111').text(safe(v, '-'), LEFT + 155, y, { width: WIDTH - 155 });
      doc.y = Math.max(doc.y, y + 14);
    }
    doc.moveDown(0.8);
    body(doc, text, { size: 10.5, align: 'left', gap: 0.5 });

    // Rating grid: one row per area, one column per point on the scale.
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(ACCENT).text('1. Evaluation', LEFT, doc.y);
    doc.moveDown(0.4);
    const labelW = 165;
    const colW = (WIDTH - labelW) / RATING_SCALE.length;
    let y = doc.y;
    doc.rect(LEFT, y - 2, WIDTH, 26).fill('#eef2ff');
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#111').text('Area', LEFT + 4, y + 6, { width: labelW - 8 });
    RATING_SCALE.forEach((s, i) => doc.text(`${s.value} - ${s.label}`, LEFT + labelW + i * colW, y + 2, { width: colW, align: 'center' }));
    y += 28;
    for (const f of RATING_FIELDS) {
      doc.font('Helvetica').fontSize(9.5).fillColor('#111').text(f.label, LEFT + 4, y + 2, { width: labelW - 8 });
      RATING_SCALE.forEach((s, i) => box(doc, LEFT + labelW + i * colW + colW / 2 - 5, y + 1,
        evaluation != null && Number(evaluation[f.key]) === s.value));
      doc.moveTo(LEFT, y + 17).lineTo(RIGHT, y + 17).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
      y += 20;
    }
    doc.y = y + 8;

    doc.font('Helvetica-Bold').fontSize(11).fillColor(ACCENT).text('2. Recommendation', LEFT, doc.y);
    doc.moveDown(0.4);
    y = doc.y;
    RECOMMENDATIONS.forEach((r, i) => {
      const x = LEFT + (i % 2) * (WIDTH / 2);
      const yy = y + Math.floor(i / 2) * 18;
      box(doc, x, yy, evaluation?.recommendation === r);
      doc.font('Helvetica').fontSize(10).fillColor('#111').text(r, x + 16, yy, { lineBreak: false });
    });
    doc.y = y + Math.ceil(RECOMMENDATIONS.length / 2) * 18 + 8;

    doc.font('Helvetica-Bold').fontSize(11).fillColor(ACCENT).text('3. Mentor Comments', LEFT, doc.y);
    doc.moveDown(0.4);
    if (evaluation?.comments) {
      doc.font('Helvetica').fontSize(10).fillColor('#111').text(safe(evaluation.comments), LEFT, doc.y, { width: WIDTH, lineGap: 2 });
      doc.moveDown(0.8);
    } else {
      for (let i = 0; i < 5; i += 1) {
        const ly = doc.y + 16;
        doc.moveTo(LEFT, ly).lineTo(RIGHT, ly).strokeColor('#9ca3af').lineWidth(0.5).stroke();
        doc.y = ly;
      }
      doc.moveDown(1);
    }

    if (doc.y > doc.page.height - 130) doc.addPage();
    y = doc.y + 20;
    const third = WIDTH / 3;
    [['Mentor Name', mentorName], ['Mentor Signature', ''], ['Date', evaluation?.submitted_at ? evaluation.submitted_on : '']]
      .forEach(([label, value], i) => {
        const x = LEFT + i * third;
        doc.font('Helvetica').fontSize(10).fillColor('#111').text(safe(value, ' '), x, y - 14, { width: third - 16 });
        doc.moveTo(x, y).lineTo(x + third - 16, y).strokeColor('#333').lineWidth(0.8).stroke();
        doc.font('Helvetica').fontSize(9).fillColor('#555').text(label, x, y + 4, { width: third - 16 });
      });
    doc.y = y + 30;
    doc.font('Helvetica').fontSize(8).fillColor('#9ca3af')
      .text(evaluation?.submitted_at
        ? 'Completed evaluation generated from Pulse ERP from the mentor\'s submitted ratings.'
        : 'Please complete, sign and return this form to HR.', LEFT, doc.y, { width: WIDTH, align: 'center' });
  });
}
