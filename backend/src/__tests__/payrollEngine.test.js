import { describe, it, expect } from 'vitest';
import { computeIncomeTax, computePT } from '../modules/payroll/payrollEngine.js';

describe('computeIncomeTax — new regime FY 2025-26', () => {
  it('zero tax on income below 4L (first slab)', () => {
    expect(computeIncomeTax(300000)).toBe(0);
  });

  it('zero tax up to 12L via rebate 87A (FY 2025-26 new regime)', () => {
    // Budget 2025: rebate u/s 87A raised to ₹60,000 — income up to ₹12L is tax-free
    expect(computeIncomeTax(700000)).toBe(0);
    expect(computeIncomeTax(1200000)).toBe(0);
  });

  it('tax > 0 above 12L (rebate stops applying)', () => {
    expect(computeIncomeTax(1500000)).toBeGreaterThan(0);
  });

  it('applies 4% cess on top of computed tax above 12L', () => {
    // 15L: (4L×5% + 4L×10% + 3L×15%) = 105000 base, +4% cess = 109200
    expect(computeIncomeTax(1500000)).toBe(109200);
  });

  it('handles income of 0', () => {
    expect(computeIncomeTax(0)).toBe(0);
  });
});

describe('computeIncomeTax — old regime', () => {
  it('zero tax up to 2.5L', () => {
    expect(computeIncomeTax(200000, 'old')).toBe(0);
  });

  it('zero tax up to 5L via rebate 87A', () => {
    expect(computeIncomeTax(500000, 'old')).toBe(0);
  });

  it('tax > 0 above 5L', () => {
    expect(computeIncomeTax(600000, 'old')).toBeGreaterThan(0);
  });
});

describe('computePT — Maharashtra slabs', () => {
  it('0 PT for salary ≤ 7500', () => {
    expect(computePT(7500, 'MH')).toBe(0);
    expect(computePT(5000, 'MH')).toBe(0);
  });

  it('175 PT for salary 7501–10000', () => {
    expect(computePT(9000, 'MH')).toBe(175);
  });

  it('200 PT for salary above 10000', () => {
    expect(computePT(10001, 'MH')).toBe(200);
    expect(computePT(50000, 'MH')).toBe(200);
  });
});
