// Salary TDS form names by tax year. The Income-tax Act 2025 / Income-tax
// Rules 2026 renumbered the forms for tax years from 2026-27; earlier years
// keep the 1962 Rules' names. The server applies the same cut-over:
// tds.routes.js salaryTdsLabels() and payroll.controller.js streamForm16Pdf
// (isNewForms). `fy` is "2026-2027" or "2026-27". (manual §199, §200)
const isNewRules = (fy) => parseInt(fy, 10) >= 2026;

/** Quarterly statement of salary TDS: Form No. 138, formerly Form 24Q. */
export const statementName = (fy) => (isNewRules(fy) ? 'Form 138 (formerly Form 24Q)' : 'Form 24Q');

/** Annual salary TDS certificate: Form No. 130, formerly Form 16. */
export const certificateName = (fy) => (isNewRules(fy) ? 'Form No. 130 (formerly Form 16)' : 'Form 16');

/**
 * What the quarterly statement is filed under, and what the deduction is made
 * under — two different provisions. 2026-27 on: statement s.397(3)(b) /
 * Rule 219, deduction s.392. Before: statement s.200(3) / Rule 31A, deduction s.192.
 */
export const statementBasis = (fy) => (isNewRules(fy)
  ? 'Quarterly statement under s.397(3)(b), Income-tax Act 2025 (Rule 219) — salary TDS deducted under s.392'
  : 'Quarterly statement under s.200(3), Income-tax Act 1961 (Rule 31A) — salary TDS deducted under s.192');

/** The year's name: "Tax Year" under the 2025 Act (RPU/FVU v1.1), "FY" before. */
export const periodTerm = (fy) => (isNewRules(fy) ? 'Tax Year' : 'FY');
