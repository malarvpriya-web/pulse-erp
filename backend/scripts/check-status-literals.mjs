#!/usr/bin/env node
/**
 * check-status-literals.mjs
 *
 * The INVERSE of check-status-vocabulary.mjs.
 *
 * That script asks "does the database hold a status value no vocabulary covers?"
 * — database → code. It passed for months while the most expensive defect of the
 * CRM audit sat in plain sight, because nothing asked the other direction:
 *
 *   "does the CODE compare against a literal that is neither a declared status
 *    nor a value the column has ever held?"
 *
 * Six files filtered opportunities with
 *   LOWER(stage) NOT IN ('closed_won','closed_lost')
 * against a column whose values are won / lost / proposal / negotiation /
 * qualification. The literal matched ZERO rows, so "open pipeline" excluded
 * nothing and reported ₹5.43Cr against a true ₹2.09Cr, and the win-rate
 * numerator counted 0 permanently. Nothing errored; both endpoints returned 200.
 *
 * WHAT COUNTS AS VALID
 * --------------------
 * A literal passes if it is EITHER
 *   (a) a member of the column's declared vocabulary in statusSets.js — this is
 *       what makes a legitimate state that no row has reached yet (an employee
 *       status of 'terminated' in a company with no leavers) pass cleanly; or
 *   (b) a value the column currently holds — which covers vocabularies that have
 *       not been declared yet.
 *
 * Failing both means the literal names a state this system has no concept of,
 * which is the `closed_won` shape exactly.
 *
 * PRECISION
 * ---------
 * Only QUALIFIED references are scanned (`o.stage`, `opportunities.stage`) plus
 * a bare column name when the same file mentions the table. An earlier version
 * matched any bare `stage` and reported 125 findings, nearly all of them a
 * different table's column — a checker that noisy gets ignored, which is worse
 * than not having one.
 *
 * Usage:
 *   node backend/scripts/check-status-literals.mjs
 *   node backend/scripts/check-status-literals.mjs --json
 */
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env'), quiet: true });

const pool = (await import('../src/config/db.js')).default;
const sets = await import('../src/shared/statusSets.js');
const JSON_OUT = process.argv.includes('--json');

/**
 * Columns under test.
 *   vocab   — statusSets exports that describe this column, unioned.
 *   qualified — fully-qualified forms that can only mean this column.
 *   scoped    — short aliases (`e.status`, `l.status`) that mean this column
 *               ONLY in a file that queries this table. A single-letter alias is
 *               reused freely across tables, so `l.status` in a warehouse query
 *               is a different column entirely; without this gate the checker
 *               attributed every table's literals to whichever table the file
 *               also happened to mention, and reported 733 findings that were
 *               almost all wrong.
 *   bare      — whether an UNQUALIFIED reference is trustworthy. True only for a
 *               distinctive column name. `status` exists on dozens of tables;
 *               `stage` and `order_status` do not — and `stage` is the one that
 *               matters, because the closed_won defect this script exists to
 *               catch was written as a bare `LOWER(stage)`.
 */
const COLUMNS = [
  {
    table: 'opportunities', column: 'stage',
    vocab: ['OPPORTUNITY_WON', 'OPPORTUNITY_LOST', 'OPPORTUNITY_CLOSED', 'OPPORTUNITY_OPEN_STAGES'],
    qualified: ['opportunities.stage'], scoped: ['o.stage', 'opp.stage'], bare: true,
  },
  {
    table: 'leads', column: 'status',
    vocab: ['LEAD_CONVERTED', 'LEAD_LOST', 'LEAD_CLOSED', 'LEAD_UNWORKED', 'LEAD_QUALIFIED', 'LEAD_DISQUALIFIED', 'LEAD_SHELVED'],
    qualified: ['leads.status'], scoped: ['l.status', 'lead.status'],
  },
  {
    table: 'employees', column: 'status',
    vocab: ['EMPLOYEE_ACTIVE', 'EMPLOYEE_EXITED', 'EMPLOYEE_VOLUNTARY_EXIT'],
    qualified: ['employees.status'], scoped: ['e.status', 'emp.status'],
  },
  {
    table: 'support_tickets', column: 'status',
    vocab: ['TICKET_CLOSED', 'TICKET_CRITICAL', 'TICKET_ESCALATED'],
    qualified: ['support_tickets.status'], scoped: ['t.status', 'st.status', 'ticket.status'],
  },
  {
    table: 'projects', column: 'status',
    vocab: ['PROJECT_OPEN', 'PROJECT_ACTIVE', 'PROJECT_CLOSED'],
    qualified: ['projects.status'], scoped: ['p.status', 'proj.status'],
  },
  {
    table: 'sales_orders', column: 'order_status',
    vocab: ['SALES_ORDER_VOID', 'SALES_ORDER_INVOICED', 'SALES_ORDER_LIFECYCLE'],
    qualified: ['sales_orders.order_status'], scoped: ['so.order_status'], bare: true,
  },
];

/**
 * Literals judged acceptable despite matching nothing, each with its reason.
 *
 * Two kinds live here: a state the application can legitimately write that no
 * row currently holds, and a short-alias collision the scanner cannot resolve
 * (`e.status` in hr/training.routes.js is the ENROLMENT status, in a query that
 * also joins employees).
 */
const ALLOWLIST = {
  'sales_orders.order_status': {
    closed: 'FALSE POSITIVE: global-search.routes.js aliases several tables inside one UNION; this `closed` belongs to tickets',
  },
  'projects.status': {
    failed: 'FALSE POSITIVE: the remaining hit is the ALIAS `AS failed`, not a compared literal',
  },
  'employees.status': {
    notice_period:   'defensive spelling variant of `notice`, OR-ed alongside it — matching nothing costs nothing',
    'notice period': 'as above, the spaced variant',
    completed:       'FALSE POSITIVE: `e.status` in hr/training.routes.js is the enrolment status; employees is joined separately',
    approved:        'FALSE POSITIVE: `e.status` in timesheets is the timesheet entry status',
    rejected:        'FALSE POSITIVE: as above',
  },
  'support_tickets.status': {
    accepted:  'FALSE POSITIVE: `t.status` in crm/customerHealth.service.js is a quality test result, not a ticket',
    passed:    'FALSE POSITIVE: as above',
    completed: 'FALSE POSITIVE: as above',
    done:      'FALSE POSITIVE: `t.status` in dashboard.controller and intelligence.routes is the TASKS table',
    running:   'FALSE POSITIVE: `t.status` in intelligence.routes is a job/test run, not a ticket',
    pending:   'FALSE POSITIVE: global-search aliases several tables as `t` inside one UNION',
    closed:    'FALSE POSITIVE: as above — and `closed` is a declared ticket state in any case',
  },
};

const SRC = path.resolve(import.meta.dirname, '..', 'src');

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!/node_modules|__tests__|migrations|seeds/.test(e.name)) walk(p, acc);
    } else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

/**
 * Blank out comments while PRESERVING byte offsets, so a reported line number
 * still points at the real line in the file.
 *
 * The first version collapsed each comment to a single space, which shifted
 * every following line: findings were reported dozens of lines away from the
 * code they described (a `stage = 'won'` line got attributed to a field list 50
 * lines below). A checker that points at the wrong line is worse than no
 * checker — it sends the reader to innocent code and costs their trust in the
 * whole report. Each comment character becomes a space and every newline is
 * kept, so every offset is unchanged.
 */
const blank = (m) => m.replace(/[^\n]/g, ' ');
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, blank)
  .replace(/^[ \t]*\/\/.*$/gm, blank)
  .replace(/^[ \t]*--.*$/gm, blank);

const files = walk(SRC);
const findings = [];

for (const col of COLUMNS) {
  const declared = new Set(
    col.vocab.flatMap(name => (Array.isArray(sets[name]) ? sets[name] : []))
      .map(v => String(v).toLowerCase())
  );

  const { rows } = await pool.query(
    `SELECT DISTINCT LOWER(TRIM(${col.column})) AS v FROM ${col.table} WHERE ${col.column} IS NOT NULL`
  );
  const present = new Set(rows.map(r => r.v));

  const allow = ALLOWLIST[`${col.table}.${col.column}`] ?? {};

  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8');
    const src = stripComments(raw);

    // A bare column name counts only for a distinctive column (col.bare), and
    // only when the file is clearly about this table.
    const mentionsTable = new RegExp(`\\b(FROM|JOIN|UPDATE|INTO)\\s+${col.table}\\b`, 'i').test(src);
    const aliases = [...col.qualified];
    if (mentionsTable) aliases.push(...(col.scoped ?? []));
    if (col.bare && mentionsTable && !aliases.includes(col.column)) aliases.push(col.column);

    for (const alias of aliases) {
      const re = new RegExp(
        `(?:LOWER\\s*\\(\\s*)?\\b${alias.replace(/\./g, '\\.')}\\s*\\)?\\s*(?:NOT\\s+)?(?:IN\\s*\\(([^)]*)\\)|(?:=|<>|!=)\\s*('[^']*'))`,
        'gi'
      );
      let m;
      while ((m = re.exec(src))) {
        const blob = m[1] ?? m[2] ?? '';
        for (const lit of blob.matchAll(/'([^']*)'/g)) {
          const value = lit[1].trim().toLowerCase();
          if (!value) continue;
          if (declared.has(value)) continue;   // a declared state, even if unused
          if (present.has(value)) continue;    // a real value, even if undeclared
          if (allow[value]) continue;
          findings.push({
            file: f.replace(SRC, 'src').replace(/\\/g, '/'),
            line: src.slice(0, m.index).split('\n').length,
            key: `${col.table}.${col.column}`,
            literal: lit[1],
            declared: [...declared].sort(),
            present: [...present].sort(),
          });
        }
      }
    }
  }
}

const seen = new Set();
const unique = findings.filter(f => {
  const k = `${f.file}|${f.key}|${f.literal.toLowerCase()}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: unique.length === 0, findings: unique }, null, 2));
} else if (unique.length === 0) {
  console.log('PASS — every status literal names either a declared state or a value the column holds.');
} else {
  console.log(`FAIL — ${unique.length} status literal(s) name a state this system has no concept of.\n`);
  const byKey = {};
  for (const f of unique) (byKey[f.key] ||= []).push(f);
  for (const [key, list] of Object.entries(byKey)) {
    console.log(key);
    console.log(`   declared: ${list[0].declared.join(', ') || '(none)'}`);
    console.log(`   in table: ${list[0].present.join(', ') || '(none)'}`);
    for (const f of list) console.log(`   ✗ '${f.literal}'  ${f.file}:${f.line}`);
    console.log('');
  }
  console.log('Such a literal filters nothing (or everything) and never errors.');
  console.log('Fix it, add the state to statusSets.js, or allowlist it here with a reason.');
}

await pool.end();
process.exit(unique.length === 0 ? 0 : 1);
