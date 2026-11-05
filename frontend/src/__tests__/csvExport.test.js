/**
 * csvExport — the CSV rules shared by All Employees and Employee Documents.
 *
 * Both exports go through these functions, so these tests cover both files'
 * formula-injection and Aadhaar behaviour. The last block pins that All
 * Employees still uses them rather than a private copy that could drift.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  csvCell, maskAadhaar, maskAadhaarInText, buildCsv,
} from '../features/employees/csvExport';

const here = dirname(fileURLToPath(import.meta.url));

describe('csvCell — formula injection', () => {
  it.each(['=HYPERLINK("http://x","y")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd'])(
    'quotes a cell starting with a formula trigger: %j', (v) => {
      expect(csvCell(v)).toBe(`"'${v.replace(/"/g, '""')}"`);
    });

  it('leaves ordinary text alone', () => {
    expect(csvCell('Aadhar Card')).toBe('"Aadhar Card"');
    expect(csvCell('a=b')).toBe('"a=b"');      // a trigger only matters in first position
  });

  it('escapes embedded quotes and renders null/undefined as empty', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });

  it('keeps numbers as plain values', () => {
    expect(csvCell(42)).toBe('"42"');
    expect(csvCell(-3)).toBe(`"'-3"`);        // a negative number starts with '-', so it is quoted too
  });
});

describe('Aadhaar masking', () => {
  it('maskAadhaar shows only the last four digits', () => {
    expect(maskAadhaar('234567890123')).toBe('****0123');
  });

  it.each([
    ['Aadhar Card 2345 6789 0123', 'Aadhar Card ****0123'],
    ['Aadhar Card 2345-6789-0123', 'Aadhar Card ****0123'],
    ['234567890123',               '****0123'],
    ['two: 234567890123 and 9876 5432 1098', 'two: ****0123 and ****1098'],
  ])('masks an Aadhaar-shaped number in free text: %j', (input, expected) => {
    expect(maskAadhaarInText(input)).toBe(expected);
  });

  it.each([
    'Phone 9876543210',             // 10 digits — a mobile number
    'Account 12345678901234',       // 14 digits — longer than Aadhaar
    'Ref 123456789012',             // starts with 1 — not an issuable Aadhaar
    'Offer_Letter_2025',
  ])('leaves non-Aadhaar text untouched: %j', (v) => {
    expect(maskAadhaarInText(v)).toBe(v);
  });

  it('passes null/undefined through', () => {
    expect(maskAadhaarInText(null)).toBeNull();
    expect(maskAadhaarInText(undefined)).toBeUndefined();
  });
});

describe('buildCsv', () => {
  it('quotes every cell, joins rows with CRLF, and guards formulas', () => {
    expect(buildCsv(['A', 'B'], [['=1+1', 'ok']])).toBe('"A","B"\r\n"\'=1+1","ok"');
  });
});

describe('All Employees uses the shared rules, not a private copy', () => {
  const src = readFileSync(resolve(here, '../features/employees/pages/EmployeesData.jsx'), 'utf8');

  it('imports maskAadhaar and downloadCsv from csvExport', () => {
    expect(src).toMatch(/import\s*{[^}]*maskAadhaar[^}]*downloadCsv[^}]*}\s*from\s*'\.\.\/csvExport'/);
  });

  it('no longer defines its own csvCell or Blob download', () => {
    expect(src).not.toMatch(/function csvCell\s*\(/);
    expect(src).not.toMatch(/new Blob\(/);
  });
});
