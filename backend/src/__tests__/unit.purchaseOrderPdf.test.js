/**
 * unit.purchaseOrderPdf.test.js
 *
 * The PO PDF is a VENDOR-FACING document: it leaves the building, it is what a
 * supplier files, and it is what gets quoted back in a dispute. So these assert
 * on the BYTES of the rendered PDF — the text actually drawn on the page — not
 * on the arguments handed to the builder. A test that checked the inputs would
 * pass against every defect below.
 *
 * Runner: Vitest | npx vitest run src/__tests__/unit.purchaseOrderPdf.test.js
 */
import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { buildPurchaseOrderPdf } from '../utils/purchaseOrderPdf.js';

/** Every text run drawn in the document, in no particular order. */
function textOf(buf) {
  const raw = buf.toString('latin1');
  const out = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    let d;
    try { d = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { continue; }
    for (const t of d.matchAll(/\[(.*?)\]\s*TJ/gs)) {
      const parts = [...t[1].matchAll(/<([0-9a-fA-F]*)>/g)]
        .map(h => Buffer.from(h[1], 'hex').toString('latin1'));
      if (parts.length) out.push(parts.join(''));
    }
  }
  return out.join('\n');
}

const lines = (n) => Array.from({ length: n }, (_, i) => ({
  item_name: `Component ${i + 1}`, quantity: i + 1, unit_of_measure: 'Nos',
  rate: 100, total_amount: 100 * (i + 1),
}));

const BASE = {
  poNumber: 'PO/2026/00417',
  vendorName: 'Sundaram Fasteners Ltd',
  items: lines(3),
  totalAmount: 600,
  expectedDeliveryDate: '30 Sep 26',
};

describe('the PO renders as a real PDF', () => {
  it('produces a PDF buffer carrying the order identity', async () => {
    const buf = await buildPurchaseOrderPdf(BASE);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = textOf(buf);
    expect(text).toContain('PURCHASE ORDER');
    expect(text).toContain('PO/2026/00417');
    expect(text).toContain('Sundaram Fasteners Ltd');
    expect(text).toContain('30 Sep 26');
  });

  it('draws every line item, and the total', async () => {
    const text = textOf(await buildPurchaseOrderPdf(BASE));
    for (const it of BASE.items) expect(text).toContain(it.item_name);
    expect(text).toContain('Rs.600.00');
  });

  /**
   * ⚠ A dropped line on a purchase order is an under-delivery the buyer pays
   * for, so pagination is asserted on the CONTENT, not on the page count.
   */
  it('carries all of a long order across pages, with the total still on it', async () => {
    const items = lines(60);
    const text = textOf(await buildPurchaseOrderPdf({
      ...BASE, items, totalAmount: items.reduce((s, i) => s + i.total_amount, 0),
    }));
    for (const it of items) expect(text, `${it.item_name} is missing`).toContain(it.item_name);
    expect(text).toContain('Rs.1,83,000.00');
    // The column heading is redrawn, so a continuation page is still readable.
    expect(text.match(/Amount/g).length).toBeGreaterThan(1);
  });
});

describe('the figures are legible on a vendor desktop', () => {
  /**
   * ⚠⚠ pdfkit's built-in fonts are WinAnsi and CANNOT encode U+20B9 (₹): it does
   * not throw, it draws a DIFFERENT glyph, so every amount on the document would
   * be wrong in a way that reads as a font bug. `Rs.` is the deliberate choice,
   * matching the payslip PDF. If someone "fixes" this to ₹ without embedding a
   * Unicode font, this test is what catches it.
   */
  it('writes EVERY amount as Rs., never as the rupee sign', async () => {
    // Counted, not merely present. BASE draws 3 rates + 3 line amounts + 1
    // total, so a prefix that changed on only some of them still fails here.
    //
    // ⚠ Do not "strengthen" this with `expect(text).not.toContain('₹')` — that
    // assertion cannot fail. textOf() decodes the content stream as latin1, so a
    // ₹ that pdfkit mangled into a WinAnsi byte never comes back as U+20B9, and
    // the check passes while the document is wrong. Verified by mutation: with
    // money() switched to ₹, the ₹-absence assertion stayed green and these
    // counted `Rs.` assertions are what went red.
    const text = textOf(await buildPurchaseOrderPdf(BASE));
    const amounts = text.match(/Rs\.[\d,]+\.\d{2}/g) || [];
    expect(amounts).toHaveLength(BASE.items.length * 2 + 1);
  });

  it('formats in the Indian grouping a supplier here expects', async () => {
    const text = textOf(await buildPurchaseOrderPdf({
      ...BASE, items: [{ item_name: 'Bulk', quantity: 1, rate: 1234567.5, total_amount: 1234567.5 }],
      totalAmount: 1234567.5,
    }));
    expect(text).toContain('Rs.12,34,567.50');
  });

  it('degrades a character the font cannot draw instead of drawing the wrong one', async () => {
    const text = textOf(await buildPurchaseOrderPdf({
      ...BASE, vendorName: '大同機械 Co., Ltd', items: lines(1),
    }));
    expect(text).toContain('Co., Ltd');
    expect(text).not.toContain('大');
  });
});

describe('a rendering problem must never cost the order', () => {
  /**
   * The caller is fire-and-forget: the PO is already approved and committed by
   * the time the mail is built. Hostile or absent data has to yield a thinner
   * document, never a rejected promise.
   */
  it('renders with no items, no number and no vendor', async () => {
    const buf = await buildPurchaseOrderPdf({});
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(textOf(buf)).toContain('Rs.0.00');
  });

  it('renders when called with nothing at all', async () => {
    await expect(buildPurchaseOrderPdf()).resolves.toBeInstanceOf(Buffer);
  });

  it('survives null rates and missing names inside the lines', async () => {
    const buf = await buildPurchaseOrderPdf({
      ...BASE,
      items: [{ quantity: null, rate: null, total_amount: null }, { item_code: 'CMP-1' }],
    });
    const text = textOf(buf);
    expect(text).toContain('Item');     // the row fell back to the default label
    expect(text).toContain('CMP-1');    // item_code is used when item_name is absent
  });
});
