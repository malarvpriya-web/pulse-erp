/**
 * loanSchedule.js — employee loan / salary advance arithmetic (pure: no DB).
 *
 * One function decides what a month's recovery is — installmentFor() — and it
 * is used by loan creation (the schedule), the payroll draft (the deduction)
 * and payroll approval (the balance reduction), so the three cannot disagree.
 *
 * Reducing-balance interest: each month interest = outstanding principal ×
 * (annual rate / 12 / 100); the installment pays that interest first and the
 * rest reduces principal. `outstanding_balance` on payroll_loans is PRINCIPAL
 * still owed. An interest-free loan (rate 0) recovers min(EMI, outstanding),
 * exactly as before this file existed.
 *
 * Before 2026-10-21 the Loans screen computed an EMI WITH interest but the
 * server built the schedule as principal ÷ EMI and never stored the rate: a
 * ₹1,00,000 loan at 10% for 12 months (EMI ₹8,792) was recovered in 12
 * installments totalling ₹1,00,000 — the last one ₹3,288 — so the interest the
 * employee agreed to was never charged and the "tenure" shown was not the one
 * chosen. PAYROLL_DATA_FLOW_AUDIT.md Part 11.
 */

const r2 = (v) => Math.round(v * 100) / 100;
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

export const LOAN_TYPES = ['loan', 'advance'];

export class LoanInputError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

/** Standard EMI for principal P, annual rate %, n months (whole rupees, rounded up). */
export function standardEmi(principal, annualRatePct, months) {
  const P = num(principal), n = parseInt(months, 10), r = num(annualRatePct) / 1200;
  if (!(P > 0) || !(n > 0)) return 0;
  if (r === 0) return Math.ceil(P / n);
  // Rounded UP: rounding down would leave a residual that becomes an extra
  // installment beyond the agreed tenure. The last installment is smaller instead.
  return Math.ceil(P * r * (1 + r) ** n / ((1 + r) ** n - 1));
}

/**
 * The recovery for the next installment of a loan.
 * @param loan { outstanding_balance, emi_amount, interest_rate }
 * @returns { amount, interest, principal, balance_after }
 *   amount = what payroll deducts; never more than principal + this month's interest.
 */
export function installmentFor(loan) {
  const outstanding = r2(num(loan.outstanding_balance));
  if (!(outstanding > 0)) return { amount: 0, interest: 0, principal: 0, balance_after: 0 };
  let interest = r2(outstanding * num(loan.interest_rate) / 1200);
  const payoff = r2(outstanding + interest);
  let amount = Math.min(num(loan.emi_amount), payoff);
  // No sub-rupee tail: if less than ₹1 would remain, this is the last installment.
  if (payoff - amount < 1) {
    // Payroll deducts whole rupees (payrollEngine rounds the recovery and net
    // pay has no GL rounding line), so the last installment is the payoff
    // rounded UP and the paise go to interest. It used to be the exact payoff:
    // the payslip deducted ₹3,630 while the ledger recorded ₹3,629.67.
    amount = Math.ceil(payoff);
    interest = r2(amount - outstanding);
  }
  amount = r2(amount);
  const principal = r2(amount - interest);
  return { amount, interest, principal, balance_after: r2(Math.max(0, outstanding - principal)) };
}

/** Full repayment schedule from the first deduction month. */
export function buildSchedule({ principal, emi, interest_rate = 0, startMonth, startYear, maxInstallments = 600 }) {
  const rows = [];
  let loan = { outstanding_balance: num(principal), emi_amount: num(emi), interest_rate: num(interest_rate) };
  let mm = startMonth, yy = startYear;
  while (loan.outstanding_balance > 0) {
    const i = installmentFor(loan);
    if (!(i.principal > 0)) {
      throw new LoanInputError('EMI_BELOW_INTEREST',
        `EMI ₹${num(emi).toLocaleString('en-IN')} does not cover the month's interest (₹${i.interest.toLocaleString('en-IN')}) — the loan would never be repaid`, 422);
    }
    rows.push({ installment: rows.length + 1, month: mm, year: yy, emi: i.amount, interest: i.interest, principal: i.principal, balance: i.balance_after });
    if (rows.length >= maxInstallments) {
      throw new LoanInputError('TENURE_TOO_LONG', `The schedule exceeds ${maxInstallments} installments — check the EMI`, 422);
    }
    loan = { ...loan, outstanding_balance: i.balance_after };
    mm += 1; if (mm === 13) { mm = 1; yy += 1; }
  }
  return rows;
}

/**
 * Validate a new loan / advance and build its schedule.
 * `single_installment` must be true when the whole amount is recovered in one
 * month — an EMI equal to the principal is otherwise a typing error (the five
 * seed loans on the screen had EMI = principal).
 */
export function planLoan(body) {
  const loan_type = body.loan_type ?? 'loan';
  if (!LOAN_TYPES.includes(loan_type)) throw new LoanInputError('LOAN_TYPE', `loan_type must be one of: ${LOAN_TYPES.join(', ')}`);
  const principal = num(body.principal_amount);
  if (!(principal > 0)) throw new LoanInputError('PRINCIPAL', 'principal_amount must be greater than 0');
  // Whole rupees: payroll deducts whole rupees, so a paise principal or EMI
  // would make every payslip deduction differ from the repayment recorded.
  if (!Number.isInteger(principal)) throw new LoanInputError('PRINCIPAL', 'principal_amount must be in whole rupees');
  const rate = body.interest_rate === undefined || body.interest_rate === null || body.interest_rate === '' ? 0 : Number(body.interest_rate);
  if (!Number.isFinite(rate) || rate < 0 || rate >= 100) throw new LoanInputError('INTEREST_RATE', 'interest_rate is an annual percentage from 0 to below 100');
  // Number(), not parseInt(): parseInt('2.5') is 2, silently shortening the loan.
  const tenure = body.tenure_months === undefined || body.tenure_months === null || body.tenure_months === '' ? null : Number(body.tenure_months);
  if (tenure !== null && !(Number.isInteger(tenure) && tenure > 0)) throw new LoanInputError('TENURE', 'tenure_months must be a whole number of months greater than 0');
  if (rate > 0 && tenure === null) throw new LoanInputError('TENURE', 'An interest-bearing loan needs tenure_months — the EMI is derived from rate and tenure');

  let emi = body.emi_amount === undefined || body.emi_amount === null || body.emi_amount === '' ? null : Number(body.emi_amount);
  if (emi === null && tenure !== null) emi = standardEmi(principal, rate, tenure);
  if (!(emi > 0)) throw new LoanInputError('EMI', 'emi_amount must be greater than 0 (or give tenure_months to derive it)');
  if (!Number.isInteger(emi)) throw new LoanInputError('EMI', 'emi_amount must be in whole rupees');
  if (tenure !== null) {
    const expected = standardEmi(principal, rate, tenure);
    if (Math.abs(expected - emi) > 1) {
      throw new LoanInputError('EMI_TENURE_MISMATCH',
        `EMI ₹${emi.toLocaleString('en-IN')} does not match ${tenure} months at ${rate}% (EMI ₹${expected.toLocaleString('en-IN')}). Correct one of them.`, 422);
    }
  }

  const sd = String(body.start_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sd)) throw new LoanInputError('START_DATE', 'start_date (YYYY-MM-DD) is required — payroll deducts from that month');
  const [yy, mm] = sd.split('-').map(Number);
  const schedule = buildSchedule({ principal, emi, interest_rate: rate, startMonth: mm, startYear: yy });
  if (tenure !== null && schedule.length !== tenure) {
    throw new LoanInputError('EMI_TENURE_MISMATCH',
      `EMI ₹${emi.toLocaleString('en-IN')} repays the loan in ${schedule.length} installments, not ${tenure}`, 422);
  }
  if (schedule.length === 1 && body.single_installment !== true) {
    throw new LoanInputError('SINGLE_INSTALLMENT_CONFIRM',
      `EMI ₹${emi.toLocaleString('en-IN')} recovers the whole ₹${principal.toLocaleString('en-IN')} in ONE month. If that is intended, resubmit with single_installment: true; otherwise correct the EMI or tenure.`, 422);
  }
  return {
    loan_type, principal, emi, interest_rate: rate, start_date: sd,
    tenure_months: schedule.length, schedule,
    total_interest: r2(schedule.reduce((s, x) => s + x.interest, 0)),
    total_repayable: r2(schedule.reduce((s, x) => s + x.emi, 0)),
  };
}

/** Installments still to come for an active loan, from its current balance. */
export function remainingInstallments(loan) {
  if (!(num(loan.outstanding_balance) > 0)) return 0;
  try { return buildSchedule({ principal: loan.outstanding_balance, emi: loan.emi_amount, interest_rate: loan.interest_rate, startMonth: 1, startYear: 2000 }).length; }
  catch { return null; }
}
