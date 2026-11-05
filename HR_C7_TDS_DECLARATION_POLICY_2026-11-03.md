# C7 — Should Unreviewed IT Declarations Reduce Monthly TDS? Decision Paper

**Date:** 03 Nov 26 · **Prepared for:** Finance and HR management, with the company's tax adviser
**Status:** ANALYSIS ONLY. Tax calculation behaviour is unchanged. Nothing has been implemented.

**This is not tax advice.** Statements about tax law below are marked ⚖ and must be confirmed by the company's tax adviser. That matters especially because tax year 2026-27 falls under the Income-tax Act 2025, whose section numbers and rules differ from the 1961 Act that most practice guidance still cites.

## 1. The question

An employee files a tax-saving declaration in **Self Service → IT Declaration**. HR can review it in **HR → IT Declaration Review**, where it is approved, rejected or reopened. The question for management: **during the year, should payroll reduce TDS on a declaration HR has not yet approved?**

## 2. What Pulse does today (verified in code)

| | Behaviour |
|---|---|
| Which declarations reduce TDS | Both **submitted (unreviewed)** and **approved** (`payroll.service.js:166-170`). **Rejected** ones are excluded. |
| What HR review changes | Approve: **nothing** for TDS (already counted). Reject: removes it from the next payroll. Reopen: counts it again. |
| Which declaration types are used | Only **80D**, **80CCD (NPS)** and **LTA** (`payroll.service.js:214-216`). Declared **80C** investments, **HRA** and **"other"** never reduce TDS. 80C is fixed at employee PF only (`payrollEngine.js:375`). This is a separate defect (P0-7) whichever policy is chosen here. |
| Regime | Deductions apply only in the **old regime**. Company 1 (Manifest) is set to the **new regime**, so **no declaration affects anyone's TDS today**. |
| Live data | 5 declaration rows, all seed data (`financial_year 'SEED finan'`, status `active`), which neither payroll nor the review screen uses. |
| If the declaration lookup fails | It is treated as "no declarations", silently (`.catch(() => empty)`). TDS goes **up** with no error shown. |
| Proof | A URL text field; no file upload, and no separate proof stage or deadline. |

**So:** the policy question has **no financial effect today**. It becomes live the moment any employee is taxed under the old regime. That will happen if management allows per-employee regime choice (MD-15) or switches the company setting.

## 3. Options

| | A. Current behaviour | B. Approved only | C. Provisional until a proof cut-off (**recommended for decision**) |
|---|---|---|---|
| Rule | Submitted + approved count all year | Only HR-approved amounts count | Submitted + approved count until a configured month (e.g. the January payroll). From then on, only approved, proof-verified amounts count. |
| Employee take-home early in the year | Highest | Lowest until HR approves | Highest |
| Year-end TDS spike if claims fail | Large and late (rejection can come any time, up to the last month) | None from this cause | Bounded: falls in the months after the cut-off, which are known in advance |
| Employer exposure for short deduction ⚖ | Highest: unverified claims reduce tax all year with no deadline | Lowest | Moderate: unverified claims are relied on only until the cut-off |
| HR workload | Low; review has little effect | High; every declaration must be reviewed quickly, or employees are over-taxed | Concentrated around the cut-off |
| Matches common Indian payroll practice ⚖ | Partly (provisional use), but without a proof stage | Stricter than usual | Yes: provisional declarations at the start of the year, proofs collected before year-end, unproved claims disallowed for the remaining months |
| Build effort | None | Small (query filter) | Medium (cut-off setting, proof status, approved amount, release-gate warning) |

## 4. Business and tax implications of counting unreviewed declarations

**For the employer ⚖**
- **Responsibility for TDS.** The employer deducts tax on salary on its own estimate of the employee's income. If deductions it relied on turn out to be unsupported, the shortfall is the employer's problem first. Under the 1961 Act this meant being treated as "assessee in default" for the shortfall, interest for late or short deduction, and possible penalty. The Income-tax Act 2025 equivalents and their current rates must be confirmed by the tax adviser before this paper is used to decide.
- **Evidence.** Practice under the 1961 Rules required the employer to collect evidence of claims from the employee (Form 12BB). The equivalent obligation and form under the 2025 Act's rules must be confirmed.
- **Reporting.** The year's TDS statement (Form 138, which replaces 24Q in Pulse from 2026-27) and the employee certificate (Form 130, which replaces Form 16) must reflect the deductions actually allowed. Counting claims that are later withdrawn means corrections, or a mismatch between monthly deductions and the year-end certificate.

**For employees**
- **Option A** gives the best monthly cash flow, but a rejection late in the year is recovered from the few remaining salaries.
- **Option B** over-deducts until HR approves. The excess is adjusted in later months, not refunded immediately.
- **Option C** gives the cash flow of A with a known deadline.

**For HR**
- **Under A, review is mostly cosmetic.** Approval changes nothing; only rejection has an effect.
- **Under B, review speed directly sets employees' take-home pay.**

**For fraud and error**
- Today a "proof" is a pasted link, and any amount can be declared.
- The engine caps each section (e.g. 80D at ₹25,000), so an inflated claim cannot exceed the cap, but it can reach it.
- An exact duplicate filing is refused (409).

## 5. Worked example (old regime; illustrative)

**Assumptions.** These use the rules currently stored in Pulse (`statutoryRules.js`), which are themselves still marked unverified:
- Slabs: 2.5 L / 5 L / 10 L at nil / 5 / 20 / 30 %; standard deduction ₹50,000; 4 % cess; rebate only up to ₹5 L.
- Projected annual salary ₹9,00,000; employee PF ₹36,000; PT ₹2,500.
- Declarations filed in April: **80C ₹1,00,000** and **80D (health insurance) ₹30,000** (engine cap ₹25,000).

**Annual tax with and without the 80D:**

| 80D counted? | Taxable income | Annual tax |
|---|---|---|
| Yes (25,000 cap) | 6,86,500 | **₹51,792** |
| No | 7,11,500 | **₹56,992** |
| **Difference** | | **₹5,200** |

These figures assume 80C is counted, which needs the separate P0-7 fix. Today's engine ignores declared 80C entirely.

**Scenario: the 80D claim is rejected in January (proof not produced).**

| Option | Monthly TDS effect of the ₹5,200 |
|---|---|
| A. Current | Counted Apr–Dec. On rejection the whole ₹5,200 is recovered over Jan–Mar: **about ₹1,733 extra per month for 3 months**. |
| B. Approved only | Never counted, so about ₹433/month higher all year. Nothing to recover. If it had been approved later, the remaining months would come down instead. |
| C. Cut-off in January | Same as A up to the cut-off. If the proof is missing at the cut-off, the same ₹1,733 × 3 months, but at a date everyone knew in advance and HR can chase proofs before. |

**Same employee under the new regime** (Manifest's current setting): taxable ₹8,25,000, within the ₹12 L rebate, so **tax ₹0**. Declarations are irrelevant.

## 6. Decisions requested

1. **Policy:** A, B or C (or another rule the tax adviser prefers).
2. **If C:** the cut-off payroll month, and the proof deadline communicated to employees.
3. **Regime:** keep the company-wide new regime, or allow each employee to choose (MD-15)? A per-employee choice is what makes this policy live.
4. **Tax adviser confirmation:**
   - employer exposure under the Income-tax Act 2025 for relying on unverified declarations;
   - the evidence form and rule that apply for tax year 2026-27;
   - the section labels to show employees.

## 7. Independent of the choice (recommended in any case)

These are already listed in the remediation design (P0-7) and are **not** being changed now:
- **Fail loudly.** A failed declaration lookup should block payroll generation with a visible error, instead of silently raising TDS.
- **One section vocabulary** shared by Self Service and the engine (80C, 80D, 80CCD(1B), HRA, LTA, other), so a declared 80C or HRA is not silently ignored.
- **Real proof upload** instead of a URL box, and an **approved amount** that can be lower than declared.
