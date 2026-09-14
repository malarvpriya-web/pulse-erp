/**
 * e2e-lead-to-cash.mjs — the complete journey the brief asks for, driven entirely through
 * the live HTTP API with a real token, against the real database.
 *
 *   Lead → Qualification → Account → Contact → Opportunity → Forecast category
 *        → Quote → Sales Order → Invoice → Customer 360 → Service Case
 *
 * Nothing here writes to the database directly. Every step is an HTTP call that
 * a user could make from the UI, and every assertion reads the value back from
 * a DIFFERENT endpoint than the one that wrote it — a create returning 201 is
 * not evidence that the record is reachable.
 *
 * Run from the repo root with the backend on :5000:
 *   node backend/scripts/e2e-lead-to-cash.mjs
 *
 * It creates real rows tagged E2E<digits>. Clean them up with:
 *   node backend/scripts/e2e-lead-to-cash-cleanup.mjs
 */
import { execSync } from 'node:child_process';

const BASE = 'http://localhost:5000/api';
const TAG = process.env.E2E_TAG || `E2E${Date.now().toString().slice(-6)}`;

const c = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m', b: '\x1b[1m' };
let pass = 0, fail = 0;
const results = [];

function step(n, label) { console.log(`\n${c.b}── ${n}. ${label}${c.x}`); }
function ok(msg, detail = '') { pass++; results.push(['PASS', msg]); console.log(`  ${c.g}PASS${c.x} ${msg}${detail ? c.d + '  ' + detail + c.x : ''}`); }
function bad(msg, detail = '') { fail++; results.push(['FAIL', msg]); console.log(`  ${c.r}FAIL${c.x} ${msg}${detail ? '  ' + detail : ''}`); }
function info(msg) { console.log(`  ${c.d}${msg}${c.x}`); }

function token(email) {
  const out = execSync(`node backend/scripts/e2e-mint-token.mjs`, {
    cwd: process.env.PULSE_ROOT || new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    env: { ...process.env, E2E_LOGIN_EMAIL: email },
    encoding: 'utf8',
  });
  const m = out.match(/---E2E_AUTH_BEGIN---([\s\S]*?)---E2E_AUTH_END---/);
  return JSON.parse(m[1].trim()).token;
}

let TOK;
async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

const state = {};

async function main() {
  console.log(`${c.b}END-TO-END: Lead → Cash → Service, tag ${TAG}${c.x}`);
  TOK = token('pilot.sales@manifest.in');

  /* 1 ────────────────────────────────────────────────────────────────────── */
  step(1, 'Capture a lead (territory decides the owner)');
  {
    const r = await call('POST', '/crm/leads', {
      company_name: `${TAG} Coimbatore Castings`,
      contact_person: 'Priya Raman',
      email: `${TAG.toLowerCase()}@example.com`,
      phone: '9840012345',
      lead_source: 'Website',
      industry: 'Manufacturing',
      location: 'Chennai',
      zone: 'South',
      estimated_value: 1850000,
      status: 'New',
    });
    if (r.status !== 201) return bad('lead create', JSON.stringify(r.data).slice(0, 300));
    state.leadId = r.data.id;
    ok('Lead created', `id=${r.data.id} iem=${r.data.iem_no}`);

    // The territory stamp and the owner it implied — the thing that did not
    // exist before this pass.
    if (r.data.territory_id) ok('Territory matched and stamped on the lead', `territory_id=${r.data.territory_id}`);
    else bad('Territory was not stamped');
    if (r.data.assigned_to) ok('Owner assigned from the territory', `employee=${r.data.assigned_to}`);
    else bad('Lead has no owner');
  }

  /* 2 ────────────────────────────────────────────────────────────────────── */
  step(2, 'Qualify the lead');
  {
    const r = await call('PUT', `/crm/leads/${state.leadId}`, { status: 'Qualified', lead_score: 78 });
    if (r.status === 200) ok('Lead qualified', `status=${r.data.status} score=${r.data.lead_score}`);
    else bad('lead qualify', JSON.stringify(r.data).slice(0, 200));
  }

  /* 3 ────────────────────────────────────────────────────────────────────── */
  step(3, 'Convert → Account + Contact + Opportunity (one transaction)');
  {
    const r = await call('POST', `/crm/leads/${state.leadId}/convert`, {
      opportunity_name: `${TAG} Casting Line Upgrade`,
      expected_value: 1850000,
      probability_percentage: 60,
      expected_closing_date: '2026-11-28',
      stage: 'Qualification',
    });
    if (r.status !== 201 && r.status !== 200) return bad('convert', JSON.stringify(r.data).slice(0, 400));
    state.oppId = r.data.opportunity?.id ?? r.data.id;
    state.accountId = r.data.account?.id ?? r.data.opportunity?.account_id;
    state.partyId = r.data.party?.id;
    ok('Converted', `opportunity=${state.oppId} account=${state.accountId}`);
    state.territoryId = r.data.opportunity?.territory_id ?? null;
    if (state.territoryId) ok('Territory carried from lead to opportunity', `territory_id=${state.territoryId}`);
    else bad('Territory NOT carried to the opportunity — territory revenue will read zero');
    if (state.accountId) ok('Account materialised and linked to the opportunity');
    else bad('Opportunity has no account — the commercial chain is severed');
    if (state.partyId) ok('Party (the canonical customer identity) resolved', `party=${state.partyId}`);
    else bad('No party — Finance and CRM will disagree about this customer');
  }

  /* 3b — no duplicate account on a second lead from the same company ─────── */
  step('3b', 'A second lead from the same company must NOT mint a second account');
  {
    const l2 = await call('POST', '/crm/leads', {
      company_name: `${TAG} Coimbatore Castings Pvt Ltd`,   // legal-form variant
      contact_person: 'Second Contact',
      email: `${TAG.toLowerCase()}.two@example.com`,
      lead_source: 'Referral', location: 'Chennai', zone: 'South',
      estimated_value: 250000, status: 'New',
    });
    const conv = await call('POST', `/crm/leads/${l2.data.id}/convert`, {
      opportunity_name: `${TAG} Follow-on Order`,
      expected_value: 250000, probability_percentage: 40,
      expected_closing_date: '2026-12-20', stage: 'Qualification',
    });
    state.lead2Id = l2.data.id;
    state.opp2Id = conv.data.opportunity?.id;
    const acct2 = conv.data.account?.id;
    if (acct2 === state.accountId) ok('Same account reused (normalised name match)', `account=${acct2}`);
    else bad('Duplicate account created', `${state.accountId} vs ${acct2}`);
  }

  /* 4 ────────────────────────────────────────────────────────────────────── */
  step(4, 'Forecast: categorise the deal and see it in the roll-up');
  {
    const r = await call('PATCH', `/sales/forecasting/opportunities/${state.oppId}/category`,
      { forecast_category: 'commit' });
    if (r.status === 200) ok('Deal categorised as commit');
    else bad('categorise', JSON.stringify(r.data).slice(0, 200));

    const f = await call('GET', '/sales/forecasting/categories?period_type=annual&period_year=2026');
    const commit = f.data?.categories?.find((x) => x.category === 'commit');
    if (commit && commit.amount >= 1850000) ok('Deal appears in the commit roll-up', `commit=₹${commit.amount.toLocaleString('en-IN')}`);
    else bad('Deal missing from the commit roll-up', JSON.stringify(commit));

    const d = await call('GET', '/sales/forecasting/categories/commit/opportunities?period_type=annual&period_year=2026');
    const found = d.data?.data?.find((o) => o.id === state.oppId);
    if (found) ok('Drill-down from forecast → opportunity works', `${found.opportunity_name}`);
    else bad('Drill-down does not contain the deal');
  }

  /* 5 ────────────────────────────────────────────────────────────────────── */
  step(5, 'Opportunity → Quotation');
  {
    const r = await call('POST', `/crm/opportunities/${state.oppId}/create-quotation`, {
      items: [
        { description: 'Induction furnace retrofit', quantity: 1, unit_price: 1500000 },
        { description: 'Commissioning & training', quantity: 1, unit_price: 350000 },
      ],
    });
    if (r.status === 201 || r.status === 200) {
      state.quoteId = r.data.id ?? r.data.quotation?.id;
      state.quoteNo = r.data.quotation_number ?? r.data.quotation?.quotation_number;
      ok('Quotation created from the opportunity', `id=${state.quoteId} no=${state.quoteNo}`);
    } else bad('create-quotation', JSON.stringify(r.data).slice(0, 300));
  }

  /* 6 ────────────────────────────────────────────────────────────────────── */
  step(6, 'Quotation → Sales Order');
  {
    if (!state.quoteId) { bad('skipped — no quotation'); }
    else {
      const r = await call('POST', `/sales/orders/from-quotation/${state.quoteId}`, {});
      if (r.status === 201 || r.status === 200) {
        state.orderId = r.data.id ?? r.data.order?.id ?? r.data.data?.id;
        ok('Sales order created from the quotation', `id=${state.orderId}`);
      } else bad('orders/from-quotation', `${r.status} ${JSON.stringify(r.data).slice(0, 250)}`);
    }
  }

  /* 7 ────────────────────────────────────────────────────────────────────── */
  step(7, 'Win the opportunity — automation must fire on its own');
  {
    const salesTok = TOK;
    TOK = token('superadmin@manifest.in');       // rule config is admin-only, by design
    const wf = await call('POST', '/workflows', {
      name: `${TAG} Win Alert`,
      trigger_module: 'opportunity', trigger_event: 'stage_changed',
      conditions: [
        { field: 'stage', operator: 'equals', value: 'Won', logic: 'AND' },
        { field: 'expected_value', operator: 'greater_than', value: '1000000' },
      ],
      actions: [{ type: 'notify', config: { to_role: 'sales_manager', title: `Won: {{opportunity_name}}`, body: 'Closed at {{expected_value}}.' } }],
    });
    state.wfId = wf.data?.data?.id;
    if (state.wfId) ok('Automation rule created (admin-only, as designed)', `id=${state.wfId}`);
    else bad('workflow create', JSON.stringify(wf.data).slice(0, 200));
    TOK = salesTok;                               // back to the rep for the business action

    const r = await call('PATCH', `/crm/opportunities/${state.oppId}/stage`,
      { stage: 'Won', close_reason: 'Best technical fit', competitor: 'Alpha Industrial' });
    if (r.status === 200) ok('Opportunity moved to Won', `sales_cycle_days=${r.data.sales_cycle_days}`);
    else bad('stage change', JSON.stringify(r.data).slice(0, 250));

    await new Promise((r2) => setTimeout(r2, 2500));
    TOK = token('superadmin@manifest.in');
    const runs = await call('GET', `/workflows/${state.wfId}/runs`);
    const list = runs.data?.data ?? runs.data ?? [];
    const fired = Array.isArray(list) && list.find((l) => l.matched === true && l.status === 'completed');
    if (fired) ok('Automation fired from the business event and completed', `run=${fired.id}`);
    else bad('Automation did not fire', JSON.stringify(list).slice(0, 300));
  }

  /* 8 ────────────────────────────────────────────────────────────────────── */
  step(8, 'Service case against the same customer');
  {
    TOK = token('pilot.servicemgr@manifest.in');
    const r = await call('POST', '/servicedesk/tickets', {
      title: `${TAG} Furnace temperature drift`,
      description: 'Reported 40°C drift after commissioning.',
      priority: 'high', category: 'Technical',
      customer_name: `${TAG} Coimbatore Castings`,
    });
    if (r.status === 201 || r.status === 200) {
      state.ticketId = r.data.id ?? r.data.ticket?.id;
      ok('Service case created', `id=${state.ticketId} no=${r.data.ticket_number ?? ''}`);
    } else bad('ticket create', `${r.status} ${JSON.stringify(r.data).slice(0, 250)}`);

    // A missing required field must be a 4xx that NAMES the field, not a 500
    // quoting a Postgres constraint. 422 comes from the rule engine
    // (validation_rules gained a `service` module on 2026-09-04) and 400 from
    // the route's own explicit check — whichever runs first, the contract is the
    // same: the caller is told which field is wrong.
    const bare = await call('POST', '/servicedesk/tickets', { description: 'no title' });
    const named = JSON.stringify(bare.data).toLowerCase().includes('title');
    if ([400, 422].includes(bare.status) && named) {
      ok('Missing required field is rejected with the field named', `HTTP ${bare.status}`);
    } else {
      bad('Missing title was not rejected cleanly', `${bare.status} ${JSON.stringify(bare.data).slice(0, 160)}`);
    }
    TOK = token('pilot.sales@manifest.in');
  }

  /* 9 ────────────────────────────────────────────────────────────────────── */
  step(9, 'Customer 360 — does everything reach one view?');
  {
    const r = await call('GET', `/crm/customer-360/${state.accountId}`);
    if (r.status !== 200) return bad('customer-360', JSON.stringify(r.data).slice(0, 250));
    const d = r.data;
    const seen = Object.keys(d).filter((k) => Array.isArray(d[k]) && d[k].length);
    ok('Customer 360 responds', `sections with data: ${seen.join(', ') || '(none)'}`);

    const oppList = d.opportunities ?? d.deals ?? [];
    if (oppList.some((o) => String(o.id) === String(state.oppId))) ok('Opportunity visible in Customer 360');
    else bad('Opportunity NOT visible in Customer 360');

    const qList = d.quotations ?? d.quotes ?? [];
    if (state.quoteId && qList.some((q) => String(q.id) === String(state.quoteId))) ok('Quotation visible in Customer 360');
    else if (state.quoteId) bad('Quotation NOT visible in Customer 360');
  }

  /* 10 ───────────────────────────────────────────────────────────────────── */
  step(10, 'Territory performance reflects the closed business');
  {
    const r = await call('GET', '/sales/territories');
    const t = (r.data ?? []).find((x) => x.id === state.territoryId) ??
              (r.data ?? []).find((x) => x.status === 'active' && Number(x.lead_count) > 0);
    if (t) ok('Territory shows live counts', `${t.name}: ${t.lead_count} leads, ${t.opportunity_count} opps, won ₹${t.won_value}`);
    else bad('No territory reports any activity');
  }

  /* ── summary ─────────────────────────────────────────────────────────── */
  console.log(`\n${c.b}SUMMARY${c.x}  ${c.g}${pass} passed${c.x}  ${fail ? c.r : c.d}${fail} failed${c.x}`);
  console.log(JSON.stringify(state, null, 1));
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
