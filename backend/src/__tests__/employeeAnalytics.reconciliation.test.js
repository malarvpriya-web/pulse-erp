/**
 * "No dashboard should display contradictory numbers."
 *
 * Every breakdown on the Employees Dashboard is drawn from the same
 * population, so each one must sum to the same Total Employees. Before this
 * endpoint was rebuilt, three of them did not:
 *
 *   - statusBreakdown  included exited + unbucketed rows the total excluded
 *                      (Total 32, donut 34)
 *   - deptBreakdown    carried LIMIT 12 against 14 live departments (sum 30)
 *   - tenureGroups     silently dropped anyone with no joining_date (sum 31)
 *
 * These assertions are shape invariants, not golden numbers, so they hold as
 * the seed data changes. They run against the real database — a mocked pool
 * would not have caught any of the three.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// setup.js pins DB_PASSWORD to a placeholder so unit suites cannot reach a real
// database by accident. Suites that need one recover the real password the same
// way — see integration.inventoryKpi.test.js, which established the pattern.
if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const pw = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const { getEmployeeAnalytics } = await import('../employees/employee.service.js');

const sum = (rows, key = 'count') => (rows || []).reduce((n, r) => n + (Number(r[key]) || 0), 0);

const COMPANY_ID = 1;
const PERIODS = ['fytd', 'all', 'mtd', 'last12m'];

describe('employee analytics reconciliation', () => {
  const byPeriod = {};

  beforeAll(async () => {
    for (const period of PERIODS) {
      byPeriod[period] = await getEmployeeAnalytics({ period, company_id: COMPANY_ID });
    }
  }, 30000);

  afterAll(async () => {
    // Not pool.end() — the pool is shared across suites, and ending it here
    // makes every later suite in the same worker skip silently.
  });

  for (const period of PERIODS) {
    describe(`period=${period}`, () => {
      it('status, department, gender, skill and tenure each sum to Total Employees', () => {
        const d = byPeriod[period];
        expect(sum(d.statusBreakdown)).toBe(d.summary.total);
        expect(sum(d.deptBreakdown)).toBe(d.summary.total);
        expect(sum(d.genderBreakdown)).toBe(d.summary.total);
        expect(sum(d.skillBreakdown)).toBe(d.summary.total);
        expect(sum(d.tenureGroups)).toBe(d.summary.total);
      });

      it('active + probation + notice + other equals total', () => {
        const { active, probation, notice, other, total } = byPeriod[period].summary;
        expect(active + probation + notice + other).toBe(total);
      });

      it('each department stack sums to that department headcount', () => {
        for (const row of byPeriod[period].deptBreakdown) {
          expect(row.active + row.probation + row.notice + row.other).toBe(row.count);
        }
      });

      it('the status donut carries no exited employees', () => {
        const labels = byPeriod[period].statusBreakdown.map(s => s.status);
        expect(labels).not.toContain('Exited');
      });

      it('the trend series sums to the hires and exits KPIs', () => {
        const d = byPeriod[period];
        // Only when the chart covers the whole window. Past MAX_TREND_MONTHS
        // the chart is trimmed to the most recent months while the KPIs keep
        // counting all of it, and that difference is deliberate.
        if (d.period.trendTruncated) return;
        expect(sum(d.hiringTrend, 'hires')).toBe(d.summary.newHires);
        expect(sum(d.hiringTrend, 'exits')).toBe(d.summary.exits);
      });

      it('the month axis is continuous and covers the resolved period', () => {
        const d = byPeriod[period];
        const keys = d.hiringTrend.map(m => m.monthKey);
        // Every month present exactly once, in ascending order, with no gap.
        expect(keys).toEqual([...keys].sort());
        expect(new Set(keys).size).toBe(keys.length);
        for (let i = 1; i < keys.length; i += 1) {
          const [py, pm] = keys[i - 1].split('-').map(Number);
          const [cy, cm] = keys[i].split('-').map(Number);
          expect(cy * 12 + cm).toBe(py * 12 + pm + 1);
        }
        if (keys.length) {
          // The series always ends at the window's last month; it starts at
          // the first unless the window is longer than the chart's cap.
          expect(keys[keys.length - 1]).toBe(d.period.to.slice(0, 7));
          if (!d.period.trendTruncated) expect(keys[0]).toBe(d.period.from.slice(0, 7));
        }
      });

      it('the legacy monthly arrays stay in step with the paired series', () => {
        const d = byPeriod[period];
        expect(d.newHiresMonthly.map(m => m.month)).toEqual(d.hiringTrend.map(m => m.month));
        expect(d.attritionMonthly.map(m => m.month)).toEqual(d.hiringTrend.map(m => m.month));
      });

      it('the attrition rate is exits over average headcount', () => {
        const { exits, avgHeadcount, attritionRate } = byPeriod[period].summary;
        const expected = avgHeadcount > 0 ? Number(((exits / avgHeadcount) * 100).toFixed(1)) : 0;
        expect(attritionRate).toBe(expected);
      });

      it('tenure bucket labels are plain ASCII', () => {
        for (const g of byPeriod[period].tenureGroups) {
           
          expect(/[^\x00-\x7F]/.test(g.bucket)).toBe(false);
        }
      });
    });
  }

  it('population figures do not move when the period does', () => {
    // The whole point of the activity/population split. If a future change
    // wires the period into a headcount query, this is what catches it.
    const base = byPeriod.fytd;
    for (const period of PERIODS) {
      const d = byPeriod[period];
      expect(d.summary.total).toBe(base.summary.total);
      expect(d.summary.active).toBe(base.summary.active);
      expect(d.summary.probation).toBe(base.summary.probation);
      expect(d.summary.notice).toBe(base.summary.notice);
      expect(d.deptBreakdown).toEqual(base.deptBreakdown);
      expect(d.genderBreakdown).toEqual(base.genderBreakdown);
      expect(d.tenureGroups).toEqual(base.tenureGroups);
    }
  });

  it('a narrower period cannot report more hires than a wider one', () => {
    expect(byPeriod.mtd.summary.newHires).toBeLessThanOrEqual(byPeriod.all.summary.newHires);
    expect(byPeriod.fytd.summary.newHires).toBeLessThanOrEqual(byPeriod.all.summary.newHires);
    expect(byPeriod.mtd.summary.exits).toBeLessThanOrEqual(byPeriod.all.summary.exits);
  });

  it('period=all resolves to real data bounds, not an epoch', async () => {
    const d = byPeriod.all;
    expect(d.period.isAll).toBe(true);
    expect(d.period.from).toBeTruthy();
    // A 1970 lower bound would emit ~670 months of zeros into the chart.
    expect(Number(d.period.from.slice(0, 4))).toBeGreaterThan(1990);
    expect(d.hiringTrend.length).toBeLessThanOrEqual(120);
  });

  it('a department dimension narrows every breakdown consistently', async () => {
    const all = byPeriod.fytd;
    if (!all.deptBreakdown.length) return;
    const target = all.deptBreakdown[0];
    const d = await getEmployeeAnalytics({
      period: 'fytd', company_id: COMPANY_ID, department: target.department,
    });
    expect(d.summary.total).toBe(target.count);
    expect(sum(d.statusBreakdown)).toBe(target.count);
    expect(sum(d.genderBreakdown)).toBe(target.count);
    expect(sum(d.tenureGroups)).toBe(target.count);
    expect(d.deptBreakdown.map(x => x.department)).toEqual([target.department]);
  }, 20000);

  it('the legacy fy_start/fy_end params still resolve, and still label as an FY', async () => {
    const d = await getEmployeeAnalytics({
      fy_start: '2026-04-01', fy_end: '2027-03-31', company_id: COMPANY_ID,
    });
    expect(d.period.from).toBe('2026-04-01');
    expect(d.period.to).toBe('2027-03-31');
    expect(d.period.label).toBe('FY27');
    // The full FY is 12 months whether or not anyone was hired in them — the
    // defect that made FY27 render as a three-point Jun–Aug chart.
    expect(d.hiringTrend).toHaveLength(12);
    expect(d.hiringTrend[0].month).toBe('Apr 26');
    expect(d.hiringTrend[11].month).toBe('Mar 27');
  }, 20000);

  it('an unscoped call does not leak other tenants into a scoped one', async () => {
    const scoped = byPeriod.all;
    const unscoped = await getEmployeeAnalytics({ period: 'all', company_id: null });
    expect(unscoped.summary.total).toBeGreaterThanOrEqual(scoped.summary.total);
  }, 20000);
});
