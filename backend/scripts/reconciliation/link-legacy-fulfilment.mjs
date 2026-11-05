#!/usr/bin/env node
/**
 * link-legacy-fulfilment.mjs — record which existing stock issue fulfilled each
 * legacy order (decision 2026-10-28, "Link as reconciled").
 *
 *   node scripts/reconciliation/link-legacy-fulfilment.mjs dry-run --company 1 --prefix SO-REF- [--out plan.json]
 *   node scripts/reconciliation/link-legacy-fulfilment.mjs execute --company 1 --prefix SO-REF- --plan plan.json \
 *        --approved-by "<name>" --confirm LINK-<n>-LEGACY-ORDERS [--log L]
 *
 * dry-run is READ ONLY. execute links exactly the plan's candidates or nothing,
 * creates no stock movement, and writes one audit row per order.
 */
import pg from 'pg';
import dotenv from 'dotenv';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { candidates, link } from './legacyFulfilmentLinks.js';

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(here, '../../.env'), quiet: true });
const [mode, ...rest] = process.argv.slice(2);
const arg = (k) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
const need = (k) => { const v = arg(k); if (!v) { console.error(`--${k} is required`); process.exit(2); } return v; };
const companyId = Number(need('company'));
const prefix = arg('prefix') ?? null;

const client = new pg.Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME,
                               user: process.env.DB_USER, password: process.env.DB_PASSWORD });
await client.connect();
let code = 0;
try {
  if (mode === 'dry-run') {
    await client.query('BEGIN READ ONLY');
    const r = await candidates(client, companyId, { orderNumberPrefix: prefix });
    await client.query('ROLLBACK');
    const plan = { company_id: companyId, prefix, generated_at: new Date().toISOString(), ...r,
                   orders: new Set(r.candidates.map(c => c.sales_order_id)).size,
                   quantity: r.candidates.reduce((t, c) => t + c.quantity, 0),
                   confirm_phrase: `LINK-${new Set(r.candidates.map(c => c.sales_order_id)).size}-LEGACY-ORDERS` };
    if (arg('out')) writeFileSync(arg('out'), JSON.stringify(plan, null, 2));
    console.log(JSON.stringify({ mode: 'dry-run — nothing linked', orders: plan.orders, lines: r.candidates.length,
                                 quantity: plan.quantity, rejected: r.rejected, confirm_phrase: plan.confirm_phrase }, null, 2));
  } else if (mode === 'execute') {
    const plan = JSON.parse(readFileSync(need('plan'), 'utf8'));
    const orders = new Set(plan.candidates.map(c => c.sales_order_id)).size;
    if (need('confirm') !== `LINK-${orders}-LEGACY-ORDERS`) throw new Error(`confirmation phrase must be LINK-${orders}-LEGACY-ORDERS`);
    if (plan.company_id !== companyId || (plan.prefix ?? null) !== prefix) throw new Error('the plan is for another company or prefix');
    const result = await link(client, companyId, plan.candidates, { approvedBy: need('approved-by'), orderNumberPrefix: prefix });
    const out = { ...result, approved_by: arg('approved-by'), executed_at: new Date().toISOString() };
    if (arg('log')) writeFileSync(arg('log'), JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.error('mode must be dry-run | execute'); code = 2;
  }
} catch (e) {
  console.error(e.message); code = 1;
} finally {
  await client.end();
}
process.exit(code);
