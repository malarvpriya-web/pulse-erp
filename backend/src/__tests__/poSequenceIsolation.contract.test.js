/**
 * poSequenceIsolation.contract.test.js — §218: no vitest run may consume the
 * live purchase-order sequence (seq_po_purch).
 *
 * The isolation is a test-only mock in setup.js. These checks keep it honest:
 *   1. The app has exactly ONE caller of nextval('seq_po_purch') — the
 *      generator setup.js replaces. A second, direct caller would bypass the
 *      mock and start leaking values again; this fails the moment one appears.
 *   2. The function every route imports IS the test generator here.
 *   3. Calling it does not move the sequence (read-only check of last_value).
 * The live sequence itself is never written, reset or decremented by this file.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (pw) process.env.DB_PASSWORD = pw;
}

const SRC = resolve(here, '..');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '__tests__' || e.name === 'migrations') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(m?js|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('PO sequence isolation', () => {
  it('only shared/docNumber.js reads seq_po_purch', () => {
    const callers = walk(SRC).filter((f) => /seq_po_purch/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f).replace(/\\/g, '/'));
    expect(callers).toEqual(['shared/docNumber.js']);
  });

  it('nextPurchaseOrderNumber is the test generator under vitest', async () => {
    const { nextPurchaseOrderNumber } = await import('../shared/docNumber.js');
    const a = await nextPurchaseOrderNumber(null, 1);
    const b = await nextPurchaseOrderNumber(null, 1);
    expect(a).toMatch(/^ZZT-PO-\d+-[0-9a-z]+-\d+$/);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(50);
  });

  it('generating PO numbers in a test does not move the live sequence', async () => {
    const { default: pool } = await import('../config/db.js');
    const { nextPurchaseOrderNumber } = await import('../shared/docNumber.js');
    const read = async () => (await pool.query(`SELECT last_value::text AS v FROM seq_po_purch`)).rows[0].v;
    const before = await read();
    for (let i = 0; i < 3; i++) await nextPurchaseOrderNumber(pool, 1);
    expect(await read()).toBe(before);
  });
});
