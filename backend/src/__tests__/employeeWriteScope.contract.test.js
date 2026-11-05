/**
 * Every write to `employees` must be tenant-scoped, or be an explicitly
 * documented exception.
 *
 * Two cross-tenant employee writes were found by reading the code, one per pass:
 *
 *   PATCH /employees/:id/status   `UPDATE employees SET status=$1 WHERE id=$2`
 *   POST  /exit/fnf/:id/pay      exit request read by id, then the employee
 *                                flipped to exited by id
 *
 * Both let an HR user in company A change an employee in company B, and both
 * logged as entirely routine. Neither was findable by testing endpoints one at a
 * time, because nothing was obviously wrong with either endpoint on its own —
 * what was wrong was a missing clause in one statement out of twenty.
 *
 * So this test looks at all twenty. It parses the SQL out of the source and
 * requires each statement to either carry a `company_id` predicate or be named
 * below with a reason. The allowlist is the point: an exception has to be argued
 * for in writing, and a new unscoped write fails until someone either scopes it
 * or adds it here deliberately.
 *
 * ⚠ Reads the source as TEXT. It never imports these modules — 17 route files in
 * this repo run top-level DDL at import time (see project notes on
 * import-time DDL), so importing them to inspect them would execute migrations
 * and start crons.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Writes that are legitimately not scoped by a company_id predicate, each with
 * the reason it is safe. Keyed by `file:line-ish` — matched on the file plus a
 * distinctive fragment of the statement, so adding a line above it does not
 * silently move the exemption onto a different statement.
 */
const ALLOWED = [
  {
    file: join('jobs', 'exitStatusSync.cron.js'),
    match: /LOWER\(status\)='notice'/i,
    why:
      'System cron, not a user request: there is no caller and therefore no tenant to ' +
      'scope to. It processes exit_requests that are already due across all companies, ' +
      'which is its whole job. Its guard is the status predicate, not a company one.',
  },
  {
    file: join('modules', 'performance', 'routes', 'promotions.routes.js'),
    match: /SET\s+designation\s+=\s+COALESCE/i,
    why:
      'Transitively scoped: employee_id comes from a promotion_recommendations row ' +
      'selected with `WHERE id = $1 AND company_id = $2 AND status = \'approved\'`.',
  },
];

/** Every .js file under src, excluding tests and migrations. */
function sourceFiles(dir = SRC, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'migrations') sourceFiles(p, out);
    } else if (entry.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * Pull each `UPDATE employees` / `DELETE FROM employees` statement out of a file.
 *
 * Reads to the end of the enclosing template literal rather than guessing a
 * length. An earlier throwaway version cut each statement at a fixed 900
 * characters and reported four false positives — including `updateEmployee`'s
 * main UPDATE, whose company predicate sits on the line AFTER `WHERE id = $62`
 * as a `${...}` interpolation. A scope checker that cries wolf gets ignored, so
 * the extraction has to be right.
 */
function writeStatements(src) {
  const out = [];
  const re = /UPDATE\s+employees\b|DELETE\s+FROM\s+employees\b/gi;
  let m;
  while ((m = re.exec(src))) {
    // Walk back to the opening backtick of the template this sits inside, then
    // forward to its closing one.
    const open = src.lastIndexOf('`', m.index);
    const close = open === -1 ? -1 : src.indexOf('`', m.index);
    const stmt = open !== -1 && close !== -1
      ? src.slice(open + 1, close)
      // Not in a template literal (a plain quoted string) — take to the quote.
      : src.slice(m.index, src.indexOf('\n', m.index));
    out.push({
      sql: stmt,
      line: src.slice(0, m.index).split('\n').length,
    });
  }
  return out;
}

/**
 * Does this statement restrict by company?
 *
 * `company_id` covers both a literal predicate and the conditional
 * `${company_id != null ? 'AND company_id = $2' : ''}` form that several of these
 * use. `scopeClause` covers the variant that hides the column name behind a
 * variable, which `deleteEmployee` does.
 */
const isScoped = (sql) => /company_id/i.test(sql) || /\$\{\s*scopeClause\s*\}/.test(sql);

describe('every employees write is tenant-scoped', () => {
  const findings = [];
  for (const file of sourceFiles()) {
    const src = readFileSync(file, 'utf8');
    for (const { sql, line } of writeStatements(src)) {
      if (isScoped(sql)) continue;
      const rel = relative(SRC, file);
      const exempt = ALLOWED.find(a => rel.endsWith(a.file) && a.match.test(sql));
      findings.push({ rel, line, sql: sql.replace(/\s+/g, ' ').trim().slice(0, 120), exempt: !!exempt });
    }
  }

  it('finds no unscoped write that is not on the allowlist', () => {
    const unexplained = findings.filter(f => !f.exempt)
      .map(f => `${f.rel.split(sep).join('/')}:${f.line}  ${f.sql}`);
    expect(unexplained, [
      'These statements write to `employees` without a company_id predicate and are not',
      'on the documented allowlist in this test. Either add the predicate, or add an',
      'entry to ALLOWED explaining why the id cannot belong to another tenant.',
    ].join('\n')).toEqual([]);
  });

  it('every allowlist entry still matches a real statement', () => {
    // A stale exemption is worse than none: it reads as "this was considered"
    // while protecting a statement that no longer exists, and the next unscoped
    // write in that file may match the pattern by accident.
    for (const entry of ALLOWED) {
      const matched = findings.some(f => f.rel.endsWith(entry.file) && entry.match.test(f.sql)
        || (f.rel.endsWith(entry.file) && f.exempt));
      expect(matched, `allowlist entry for ${entry.file} (${entry.match}) matches nothing — remove it`).toBe(true);
    }
  });

  it('every allowlist entry carries a reason', () => {
    for (const entry of ALLOWED) {
      expect(entry.why?.length ?? 0, String(entry.file)).toBeGreaterThan(40);
    }
  });

  it('the statement extractor reads past a multi-line WHERE clause', () => {
    // Guards the extractor itself. This is updateEmployee's real shape: the
    // company predicate is on the line after `WHERE id = $62`. Extracting only
    // the first line reports it as unscoped, which is the false positive that
    // nearly sent this pass "fixing" a statement that was already correct.
    const sample = [
      'const query = `',
      '  UPDATE employees',
      '  SET first_name = COALESCE($1, first_name)',
      '  WHERE id = $62',
      "    ${company_id != null ? 'AND company_id = $63' : ''}",
      '  RETURNING *;',
      '`;',
    ].join('\n');
    const [stmt] = writeStatements(sample);
    expect(stmt).toBeDefined();
    expect(isScoped(stmt.sql)).toBe(true);
  });
});
