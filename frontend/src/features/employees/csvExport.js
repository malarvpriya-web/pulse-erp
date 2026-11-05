/**
 * csvExport.js — the CSV rules every employee-data export shares.
 *
 * These lived inside EmployeesData.jsx. Employee Documents now exports too, and
 * two copies of "how we mask Aadhaar" and "how we stop a cell running as a
 * formula" are two copies that drift — the first one to be fixed and the second
 * one forgotten is the leak.
 */

/**
 * One CSV cell.
 *
 * ⚠ Prefixes a formula-looking value with a single quote. Excel, LibreOffice and
 * Google Sheets all evaluate a cell beginning `=`, `+`, `-`, `@`, TAB or CR as a
 * formula, so an employee whose name or address was typed as `=HYPERLINK(...)`
 * — or set deliberately — becomes executable content in whoever opens the file.
 * The quote is stripped on display by every one of those tools, so the value
 * still reads correctly.
 */
export function csvCell(value) {
  let v = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return `"${v.replace(/"/g, '""')}"`;
}

/**
 * An Aadhaar number as the screen shows it: `****1234`.
 *
 * ⚠ Aadhaar is MASKED on screen and was once exported in FULL. An export that
 * reveals more than the page it came from is a PII leak with a paper trail. The
 * caller decides what a blank renders as; this only ever sees a real value.
 */
export function maskAadhaar(value) {
  return `****${String(value).slice(-4)}`;
}

/**
 * Twelve digits starting 2-9, optionally grouped 4-4-4 by spaces or hyphens —
 * the shape UIDAI issues. Bounded by non-digits so a longer account or phone
 * number is not partially rewritten.
 */
const AADHAAR_IN_TEXT = /(?<!\d)[2-9]\d{3}[\s-]?\d{4}[\s-]?(\d{4})(?!\d)/g;

/**
 * Free text with any Aadhaar-shaped number masked the same way.
 *
 * For columns that are not an Aadhaar field but can contain one because a person
 * typed it there — a document called "Aadhar Card 2345 6789 0123".
 */
export function maskAadhaarInText(value) {
  if (value == null) return value;
  return String(value).replace(AADHAAR_IN_TEXT, (_m, last4) => `****${last4}`);
}

/**
 * Build the file body: header row + data rows, every cell through csvCell.
 * CRLF because that is what Excel writes and expects.
 */
export function buildCsv(headers, rows) {
  return [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
}

/** Trigger a browser download of `headers` + `rows` as `filename`. */
export function downloadCsv(headers, rows, filename) {
  // \uFEFF: without a BOM, Excel on Windows reads the file as the system
  // codepage and mangles every non-ASCII name in it.
  const url = URL.createObjectURL(
    new Blob(['\uFEFF' + buildCsv(headers, rows)], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  // The object URL pins the whole Blob in memory until the document is
  // discarded. Released on the next tick, once the click has been handled.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
