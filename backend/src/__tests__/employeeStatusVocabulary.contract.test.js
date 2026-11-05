/**
 * The employment-status vocabulary exists in two files by necessity — one on
 * the server, one in the browser. This test is what makes that safe.
 *
 * The bug it exists to prevent already happened: three independent copies of
 * "is this person still employed?" disagreed about the status 'Notice', so the
 * Employees Dashboard reported Total = 32, its own Employment Status donut
 * summed to 34, and the All Employees page it links to reported 33.
 *
 * The frontend file is PARSED, not imported: importing it from a backend
 * vitest run would drag in the browser module graph, and a test that is
 * awkward to run is a test that gets deleted.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as backend from '../shared/employeeStatus.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_FILE = path.resolve(
  here, '../../../frontend/src/features/employees/employeeStatus.js',
);

/** Pull `export const NAME = [ 'a', 'b' ];` out of the frontend source. */
function readArray(src, name) {
  const m = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\];`).exec(src);
  if (!m) return null;
  return m[1]
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.replace(/^['"]|['"]$/g, ''));
}

describe('employee status vocabulary', () => {
  const src = fs.readFileSync(FRONTEND_FILE, 'utf8');

  it('the frontend mirror exists where the backend says it does', () => {
    expect(fs.existsSync(FRONTEND_FILE)).toBe(true);
  });

  for (const name of ['ACTIVE_STATUSES', 'PROBATION_STATUSES', 'NOTICE_STATUSES', 'EXITED_STATUSES']) {
    it(`${name} is identical on both sides`, () => {
      const front = readArray(src, name);
      expect(front, `${name} not found in the frontend mirror`).not.toBeNull();
      expect(front).toEqual(backend[name]);
    });
  }

  it('no status appears in two buckets', () => {
    const all = [
      ...backend.ACTIVE_STATUSES,
      ...backend.PROBATION_STATUSES,
      ...backend.NOTICE_STATUSES,
      ...backend.EXITED_STATUSES,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it('CURRENT and EXITED partition the vocabulary', () => {
    for (const s of backend.CURRENT_STATUSES) expect(backend.isExited(s)).toBe(false);
    for (const s of backend.EXITED_STATUSES) expect(backend.isCurrent(s)).toBe(false);
  });

  it("'Notice' is employed — the reading POST /employees/:id/offboard relies on", () => {
    // offboard() writes the capitalised 'Notice' and documents that it "keeps
    // them counted as active for payroll/attendance". If this flips, headcount
    // silently drops by everyone serving notice.
    expect(backend.bucketOf('Notice')).toBe('Notice');
    expect(backend.isCurrent('Notice')).toBe(true);
    expect(backend.isCurrent('notice_period')).toBe(true);
  });

  it('an unknown status counts as employed, not as a departure', () => {
    // Fail-safe direction: mis-labelling someone as still employed is visible
    // and fixable; dropping them out of headcount is not.
    expect(backend.bucketOf('Sabbatical')).toBe('Other');
    expect(backend.isCurrent('Sabbatical')).toBe(true);
  });

  it('a blank or missing status reads as Active', () => {
    for (const v of [null, undefined, '', '   ']) {
      expect(backend.bucketOf(v)).toBe('Active');
    }
  });

  it('case and surrounding whitespace do not change the bucket', () => {
    expect(backend.bucketOf('  RESIGNED ')).toBe('Exited');
    expect(backend.bucketOf('Probation')).toBe('Probation');
  });

  it('the SQL predicates are exact negations of each other', () => {
    // isCurrentSql is defined as NOT isExitedSql precisely so the two cannot
    // drift; assert the text still reflects that.
    expect(backend.isCurrentSql('status')).toBe(
      backend.isExitedSql('status').replace(' IN (', ' NOT IN ('),
    );
  });

  it('the SQL list escapes quotes rather than concatenating them into the statement', () => {
    expect(backend.sqlList(["o'brien"])).toBe("'o''brien'");
  });

  it('the tenure bucket labels are plain ASCII on both sides', () => {
    // The backend previously shipped double-encoded en dashes as DATA, and the
    // chart axis rendered the mojibake. These labels travel to the browser.
    const front = /export const TENURE_BUCKETS = \[([\s\S]*?)\];/.exec(src);
    expect(front).not.toBeNull();
     
    expect(/[^\x00-\x7F]/.test(front[1])).toBe(false);
  });
});
