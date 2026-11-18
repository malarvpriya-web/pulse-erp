import PDFDocument from 'pdfkit';

/**
 * Probation letters (Confirmation, Extension) as a PDF buffer. Content comes
 * from probation/probationReviews.service.js letterContent(); layout is drawn
 * here.
 *
 * Same conventions as utils/internshipPdf.js: pdfkit's built-in WinAnsi fonts
 * (text outside Latin-1 degrades to "?"), and no logo — brand assets are not
 * placed without an explicit instruction.
 */
const ACCENT = '#4c1d95';
const LEFT = 60;
const RIGHT = 535;
const WIDTH = RIGHT - LEFT;

const safe = (v, fallback = '') => {
  const s = v == null ? '' : String(v);
  const cleaned = s.replace(/—|–/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, '?');
  return cleaned.trim() ? cleaned : fallback;
};

export function buildProbationLetterPdf({
  companyName, companyAddress, reference, letterDate, recipient = [], subject, body,
  signatoryName, signatoryTitle,
  // 'To,' above the recipient; null for a letter with no addressee
  // ("To whom it may concern" — the experience letter, §276).
  toLabel = 'To,',
}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: safe(subject), Author: safe(companyName) } });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Letterhead
      doc.font('Helvetica-Bold').fontSize(16).fillColor(ACCENT)
        .text(safe(companyName, ' '), LEFT, 56, { width: WIDTH });
      if (companyAddress) {
        doc.font('Helvetica').fontSize(9).fillColor('#555').text(safe(companyAddress), LEFT, doc.y + 2, { width: WIDTH });
      }
      doc.moveDown(0.6);
      doc.lineWidth(1.2).strokeColor(ACCENT).moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).stroke();
      doc.moveDown(1.2);

      // Reference and date
      const y = doc.y;
      doc.font('Helvetica').fontSize(10).fillColor('#333').text(`Ref: ${safe(reference)}`, LEFT, y, { width: WIDTH / 2 });
      doc.text(`Date: ${safe(letterDate)}`, LEFT + WIDTH / 2, y, { width: WIDTH / 2, align: 'right' });
      doc.moveDown(1.5);

      // Recipient
      if (toLabel) doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text(toLabel, LEFT, doc.y);
      doc.fillColor('#111');
      recipient.forEach((line, i) => {
        doc.font(i === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(11).text(safe(line), LEFT, doc.y, { width: WIDTH });
      });
      doc.moveDown(1.2);

      // Subject
      doc.font('Helvetica-Bold').fontSize(11.5).fillColor('#111')
        .text(`Subject: ${safe(subject)}`, LEFT, doc.y, { width: WIDTH, underline: true });
      doc.moveDown(1);

      // Body
      for (const para of safe(body).split(/\n{2,}/)) {
        doc.font('Helvetica').fontSize(11.5).fillColor('#111')
          .text(para, LEFT, doc.y, { width: WIDTH, align: 'justify', lineGap: 3 });
        doc.moveDown(0.7);
      }

      // Signature
      doc.moveDown(1.5);
      doc.font('Helvetica').fontSize(11).text(`For ${safe(companyName, ' ')}`, LEFT, doc.y);
      doc.moveDown(3);
      if (signatoryName) doc.font('Helvetica-Bold').fontSize(11).text(safe(signatoryName), LEFT, doc.y);
      doc.font('Helvetica').fontSize(10).fillColor('#444').text(safe(signatoryTitle, 'Authorized Signatory'), LEFT, doc.y);

      doc.end();
    } catch (err) { reject(err); }
  });
}
