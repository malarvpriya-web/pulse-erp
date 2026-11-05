// The bank payment file: one rendering, from the release snapshot only
// (PC-02b-0 B-04). A file is rendered once, at release; processing re-renders
// the stored snapshot to prove the stored bytes are that snapshot's. Nothing
// here reads a live vendor record.
import { createHash } from 'node:crypto';
import { csvCell } from '../../../shared/csv.js';

export const BANK_FILE_FORMATS = ['generic', 'sbi', 'hdfc', 'icici'];

export const sha256Of = (content) => createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

// Whole paise, so amounts compare exactly. null when not a valid 2-decimal amount.
export function toPaise(value) {
  const s = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  if (/[1-9]/.test(frac.slice(2))) return null;
  return Number(whole) * 100 + Number(frac.slice(0, 2).padEnd(2, '0'));
}
export const fromPaise = (paise) => `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;

/**
 * @param {string} batchNumber
 * @param {string} format  one of BANK_FILE_FORMATS
 * @param {Array} lines    the release snapshot's beneficiary lines
 */
export function renderBankFile(batchNumber, format, lines) {
  // `nm` keeps the always-quoted fields always quoted and `fl` keeps the bare
  // fields bare, so a bank's parser sees one format. See shared/csv.js.
  const nm = v => csvCell(v);
  const fl = v => csvCell(v, { minimal: true });
  let header, rows;
  if (format === 'sbi') {
    header = 'PRODUCT_CODE,PAYMENT_AMT,BENE_ACC_NO,BENE_IFSC_CODE,BENE_NAME,PAYMENT_REF,REMARKS';
    rows = lines.map(l =>
      `NEFT,${fl(l.amount)},${fl(l.account_number)},${fl(l.ifsc)},${nm(l.beneficiary_name)},${fl(batchNumber)},${fl(l.bill_ref || '')}`);
  } else if (format === 'hdfc') {
    header = 'PAYMENT TYPE,AMOUNT,BENE ACCOUNT,IFSC,BENE NAME,EMAIL,MOBILE,PAYMENT REF';
    rows = lines.map(l =>
      `NEFT,${fl(l.amount)},${fl(l.account_number)},${fl(l.ifsc)},${nm(l.beneficiary_name)},,,${fl(batchNumber)}`);
  } else if (format === 'icici') {
    header = 'Beneficiary Name,Beneficiary Account No,Beneficiary IFSC,Amount,Payment Mode,Remarks';
    rows = lines.map(l =>
      `${nm(l.beneficiary_name)},${fl(l.account_number)},${fl(l.ifsc)},${fl(l.amount)},NEFT,${fl(batchNumber)}`);
  } else {
    header = 'Party Name,Account Number,IFSC Code,Amount,Payment Mode,Reference,Bill Number';
    rows = lines.map(l =>
      `${nm(l.beneficiary_name)},${fl(l.account_number)},${fl(l.ifsc)},${fl(l.amount)},${fl(l.payment_method || 'NEFT')},${fl(batchNumber)},${fl(l.bill_ref || '')}`);
  }
  return [header, ...rows].join('\n');
}
