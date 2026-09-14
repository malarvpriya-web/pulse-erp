/**
 * PART 34 — independent DB calculation vs live API, metric by metric.
 * Every figure on the left is computed here from SQL; every figure on the right
 * comes from the running server. They must agree where the definition is the same.
 */
import dotenv from 'dotenv'; dotenv.config({ quiet: true });
import pg from 'pg';
import jwt from 'jsonwebtoken';

const pool = new pg.Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
const API = 'http://localhost:5000/api';
const u = await pool.query(`SELECT id, email FROM users WHERE email='superadmin@manifest.in'`);
const tok = jwt.sign({ userId: u.rows[0].id, id: u.rows[0].id, email: u.rows[0].email, company_id: 1, role: 'super_admin' },
  process.env.JWT_SECRET, { expiresIn: '10m' });
const get = async (p) => (await fetch(`${API}${p}`, { headers: { Authorization: `Bearer ${tok}` } })).json();

// Scope every DB figure to the same tenant the token carries. Without this the
// comparison is only accurate while exactly one company exists — and the moment
// an audit fixture adds a second (scripts/audit/tenant-fixture.mjs leaves
// `ZZTENANT Tenant B Ltd` behind), the DB side counts rows the scoped API
// correctly refuses to return, and every metric reads as a divergence. That is
// the instrument being wrong, not the application.
const CO    = `company_id = 1`;
const OPEN  = `stage NOT IN ('Won','Lost','Closed Won','Closed Lost')`;
const one = async (sql) => (await pool.query(sql)).rows[0];

const db = await one(`
  SELECT
    (SELECT count(*) FROM leads WHERE deleted_at IS NULL AND ${CO}) total_leads,
    (SELECT count(*) FROM leads WHERE deleted_at IS NULL AND ${CO} AND status IN ('Won','Converted','converted')) converted_leads,
    (SELECT count(*) FROM leads WHERE deleted_at IS NULL AND ${CO} AND status IN ('Won','Converted','converted','Lost')) decided_leads,
    (SELECT count(*)   FROM opportunities WHERE deleted_at IS NULL AND ${CO}) all_opps,
    (SELECT count(*)   FROM opportunities WHERE deleted_at IS NULL AND ${CO} AND ${OPEN}) open_opps,
    (SELECT COALESCE(sum(expected_value),0) FROM opportunities WHERE deleted_at IS NULL AND ${CO} AND ${OPEN}) pipeline,
    (SELECT COALESCE(sum(expected_value),0) FROM opportunities
      WHERE deleted_at IS NULL AND ${CO} AND ${OPEN} AND account_id IS NOT NULL) pipeline_with_account,
    (SELECT COALESCE(sum(expected_value * COALESCE(probability_percentage,0) / 100.0),0)
       FROM opportunities WHERE deleted_at IS NULL AND ${CO} AND ${OPEN}) weighted,
    (SELECT count(*) FROM opportunities WHERE deleted_at IS NULL AND ${CO} AND stage='Won')  won,
    (SELECT count(*) FROM opportunities WHERE deleted_at IS NULL AND ${CO} AND stage='Lost') lost,
    (SELECT COALESCE(avg(expected_value),0) FROM opportunities WHERE deleted_at IS NULL AND ${CO} AND ${OPEN}) avg_open,
    (SELECT COALESCE(avg(expected_value),0) FROM opportunities WHERE deleted_at IS NULL AND ${CO} AND stage='Won') avg_won,
    (SELECT count(*) FROM accounts   WHERE deleted_at IS NULL AND ${CO}) customers,
    (SELECT count(*) FROM quotations WHERE deleted_at IS NULL AND ${CO}) quotations,
    (SELECT count(*) FROM sales_orders WHERE deleted_at IS NULL AND ${CO}) orders,
    (SELECT count(*) FROM invoices   WHERE deleted_at IS NULL AND ${CO}) invoices
`);

const stats  = await get('/crm/opportunities/stats');
const conv   = await get('/crm/analytics/conversion-rate');
const avg    = await get('/crm/analytics/avg-deal-size');
const kanban = await get('/crm/opportunities/kanban');
const accts  = await get('/crm/accounts');

const boardArr   = Object.values(kanban.board ?? {}).flat();
const boardTotal = boardArr.reduce((s, o) => s + parseFloat(o.expected_value || 0), 0);

const N = (v) => Math.round(parseFloat(v ?? 0) * 100) / 100;
let bad = 0;
const row = (metric, dbv, apiv, note = '') => {
  const ok = N(dbv) === N(apiv);
  if (!ok) bad++;
  console.log(`${ok ? 'MATCH' : 'DIFF '}  ${metric.padEnd(30)} db=${String(N(dbv)).padStart(14)}  api=${String(N(apiv)).padStart(14)}  ${note}`);
};

console.log('\nPART 34 — DB vs API\n' + '='.repeat(86));
row('Total leads',            db.total_leads,     conv.total);
row('Converted leads',        db.converted_leads, conv.converted);
row('Decided leads (denom.)', db.decided_leads,   conv.decided);
row('Conversion rate %',      (db.converted_leads / db.decided_leads * 100).toFixed(2), conv.conversion_rate);
row('Opportunities (all)',    db.all_opps,        stats.total);
row('Open pipeline ₹',        db.pipeline,        stats.open_pipeline_value);
row('Total value ₹',          db.pipeline,        stats.total_value);
row('Weighted pipeline ₹',    db.weighted,        stats.weighted_pipeline_value);
row('Won count',              db.won,             stats.won_count);
row('Lost count',             db.lost,            stats.lost_count);
row('Avg OPEN deal ₹',        db.avg_open,        stats.avg_open_deal_size);
row('Avg WON deal ₹',         db.avg_won,         stats.avg_deal_size);
row('Avg OPEN (analytics)',   db.avg_open,        avg.avg_open_deal_size, 'same figure, second endpoint');
row('Avg WON (analytics)',    db.avg_won,         avg.avg_deal_size,      'same figure, second endpoint');
row('Kanban bucket total ₹',  db.pipeline,        boardTotal,             'PART 14 reconciliation');
row('Kanban card count',      db.all_opps,        boardArr.length,        'PART 14 no silent drops');
row('Customers (accounts)',   db.customers,       (accts.accounts ?? accts).length);

// Account-list pipeline must not be multiplied by contact count (PART 15).
const acctPipeline = (accts.accounts ?? accts).reduce((s, a) => s + parseFloat(a.open_pipeline_value || 0), 0);
// Compared against the account-linked subset, not the grand total: the one
// legacy customer-less opportunity is legitimately absent from a per-account
// list. The original defect was the opposite — a contacts × opportunities join
// multiplied this sum by contact count (₹2L reported as ₹6L).
row('Σ account pipeline ₹',   db.pipeline_with_account, acctPipeline,     'PART 15 fan-out check');
row('  + customer-less opps', db.pipeline,        acctPipeline + parseFloat(db.pipeline) - parseFloat(db.pipeline_with_account), 'accounts for the difference');

console.log('='.repeat(86));
console.log(bad === 0 ? 'ALL METRICS RECONCILE' : `${bad} metric(s) DIVERGE`);

// PART 23 — funnel conversion must be a cohort rate, never above 100%.
const wl = await get('/crm/win-loss-analysis');
const rates = (wl.data?.stage_conversion ?? []).map(s => s.rate);
const over  = rates.filter(r => r > 100);
console.log(`\nPART 23  funnel stage conversion rates: [${rates.join(', ')}]  -> ${over.length ? `${over.length} ABOVE 100%` : 'none above 100%'}`);

await pool.end();
