/**
 * BGV — the frontend rules that only break in the browser.
 *
 * Four things, each chosen because it is invisible in review:
 *
 * 1. MONEY. `money(null)` must be an em-dash, never ₹0. "Not billed yet" and
 *    "no charge" are different facts and a spend screen that renders both as ₹0
 *    cannot be reconciled — [[project_tco_freight_inputs_never_captured]].
 *
 * 2. THE ROUTE GATE. Both BGV pages must be registered with `module: 'bgv'`,
 *    not 'employees'. Auto-discovery would have inferred 'employees' from the
 *    folder, which every manager and employee can view — and the whole reason
 *    this module has its own permission row is that it holds criminal-record and
 *    reference findings.
 *
 * 3. NO COMPONENT DECLARED INSIDE A RENDER. A `const Row = …` inside a component
 *    body is a new component TYPE every render, so React remounts the subtree on
 *    each keystroke. In AddEmployee that stole focus from every field and made
 *    MasterSelect refetch — and the jsdom test passed.
 *    [[project_employee_foundation_final_audit_2026-09-29]]
 *
 * 4. THE PAGE STYLESHEET STAYS IN ITS LANE. A page rule that reaches into a
 *    shared component broke MasterSelect's popup on three pages
 *    ([[project_add_employee_dropdown_rootcause]]), and `.tb-` collided app-wide
 *    because it is Topbar's prefix ([[project_recruitment_redesign_2026-09-27]]).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  CHECK_STATUSES, CHECK_RESULTS, PAYMENT_STATUSES, CASE_STATUSES,
  APPLICABILITY, APPLICABLE, isOutstanding, blocksClosure,
  money, shortDate, monthLabel, progressLabel, needsReport, badgeFor,
  requiredProgressLabel, requiredPct,
} from '@/features/employees/bgv';
import { ROUTES, NAV_ITEMS } from '@/config/routes';

const SRC = path.resolve(__dirname, '../features/employees');
const readPage = (f) => fs.readFileSync(path.join(SRC, 'pages', f), 'utf8');
const BGV_PAGE = readPage('BackgroundVerification.jsx');
const EMP_PAGE = readPage('EmployeeBGV.jsx');
const CSS      = readPage('BackgroundVerification.css');
const PROFILE  = readPage('EmployeeProfile.jsx');

describe('money keeps "not captured" distinct from "free"', () => {
  it('null and undefined render as an em-dash, not ₹0', () => {
    expect(money(null)).toBe('—');
    expect(money(undefined)).toBe('—');
    expect(money('')).toBe('—');
  });

  it('a genuine zero renders as ₹0', () => {
    // A check the agency did not charge for is a real, different answer.
    expect(money(0)).toBe('₹0');
    expect(money('0')).toBe('₹0');
  });

  it('numbers render in the Indian grouping', () => {
    expect(money(4500)).toBe('₹4,500');
    expect(money(125000)).toBe('₹1,25,000');
  });

  it('a non-numeric value is an em-dash, never NaN on screen', () => {
    expect(money('abc')).toBe('—');
    expect(money(NaN)).toBe('—');
  });

  it('no BGV screen formats money with utils/format.js', () => {
    // fmt() is `₹${Number(v ?? 0)}` and would undo all of the above.
    for (const [name, src] of [['BackgroundVerification', BGV_PAGE], ['EmployeeBGV', EMP_PAGE]]) {
      expect(src, `${name} must use money() from features/employees/bgv.js`)
        .not.toMatch(/from '@\/utils\/format'/);
    }
  });
});

describe('dates and labels never print a sentinel', () => {
  it('the STRING "null" is treated as absent', () => {
    // The four-character string "null" is truthy and beats every falsy guard —
    // it is what an older Add Employee revision wrote into live columns.
    expect(shortDate('null')).toBe('—');
    expect(shortDate('undefined')).toBe('—');
    expect(shortDate('')).toBe('—');
    expect(shortDate(null)).toBe('—');
  });

  it('a date-only string is not shifted by a timezone', () => {
    // `new Date('2026-09-18')` is UTC midnight, which in IST renders as the 17th.
    // [[project_pg_date_parser_fix]]
    // ⚠ Assert the DAY and the YEAR, not the exact month abbreviation: Node's
    // en-IN renders September as "Sept" while some ICU builds say "Sep". The bug
    // this guards against shifts the DAY (to the 17th), so that is what is pinned.
    expect(shortDate('2026-09-18')).toMatch(/^18 Sept? 2026$/);
  });

  it('monthLabel turns a YYYY-MM bucket into a month name', () => {
    expect(monthLabel('2026-09')).toMatch(/^Sept? 2026$/);
    expect(monthLabel('nonsense')).toBe('nonsense');
  });

  it('progressLabel is the one phrasing for "3/5 checks completed"', () => {
    expect(progressLabel({ checks_completed: 3, checks_total: 5 })).toBe('3/5 checks completed');
    expect(progressLabel(null)).toBe('0/0 checks completed');
  });

  it('a cancelled check does not count as missing its report', () => {
    expect(needsReport({ applicability: 'Required', status: 'Cancelled', document_count: 0 })).toBe(false);
    expect(needsReport({ applicability: 'Required', status: 'Completed', document_count: 0 })).toBe(true);
    expect(needsReport({ applicability: 'Required', status: 'Completed', document_count: 1 })).toBe(false);
    // A payload with no applicability at all is treated as applicable — the
    // fail-safe direction is to show the outstanding report, not hide it.
    expect(needsReport({ status: 'Completed', document_count: 0 })).toBe(true);
  });

  it('every vocabulary value has a badge colour', () => {
    // A value with no entry falls back to grey, which silently loses the
    // distinction between Clear and Discrepancy on screen.
    const FALLBACK = badgeFor('__no_such_value__');
    for (const v of [...CHECK_STATUSES, ...CHECK_RESULTS, ...PAYMENT_STATUSES, ...CASE_STATUSES]) {
      expect(badgeFor(v), `${v} has no badge colour of its own`).not.toBe(FALLBACK);
    }
  });

  it('Clear and Discrepancy are not the same colour', () => {
    expect(badgeFor('Clear').bg).not.toBe(badgeFor('Discrepancy').bg);
  });
});

describe('both BGV pages are gated on bgv, not on employees', () => {
  for (const key of ['BackgroundVerification', 'EmployeeBGV']) {
    it(`${key} is registered with module 'bgv'`, () => {
      expect(ROUTES[key], `${key} is not in ROUTES — auto-discovery would gate it on 'employees'`)
        .toBeTruthy();
      expect(ROUTES[key].module,
        `${key} gated on '${ROUTES[key].module}'. BGV holds criminal-record findings; ` +
        `'employees' is held by every manager and employee.`)
        .toBe('bgv');
    });

    it(`${key} receives setPage and urlParams`, () => {
      // A route with no props function gets the default context; one WITH a props
      // function gets only what it names. A missing setPage is a dead button
      // rather than an error. [[project_layout_route_prop_delivery]]
      const props = ROUTES[key].props?.({ setPage: 'SP', urlParams: 'UP', selectedEmployee: null });
      expect(props?.setPage).toBe('SP');
      expect(props?.urlParams).toBe('UP');
    });
  }

  it('the sidebar row carries its own bgv module, so the group gate cannot leak it', () => {
    const employees = NAV_ITEMS.find(i => i.name === 'Employees');
    expect(employees).toBeTruthy();
    const row = employees.submenu.find(s => s.page === 'BackgroundVerification');
    expect(row, 'Employees → Background Verification is missing from the sidebar').toBeTruthy();
    expect(row.module,
      "without its own module the row inherits Employees' gate and shows for every manager")
      .toBe('bgv');
  });
});

describe('no component is declared inside another render', () => {
  for (const [name, src] of [['BackgroundVerification', BGV_PAGE], ['EmployeeBGV', EMP_PAGE]]) {
    it(`${name} declares every component at module level`, () => {
      // An INDENTED `const Xyz = (` or `function Xyz(` whose name is
      // PascalCase is a component inside another function body.
      const offenders = [];
      for (const line of src.split('\n')) {
        const m = /^\s+(?:const|let|function)\s+([A-Z][A-Za-z0-9]*)\s*[=(]/.exec(line);
        if (m) offenders.push(m[1]);
      }
      expect(offenders,
        `${offenders.join(', ')} is declared inside a render. React treats it as a new ` +
        'component type each time, remounting the subtree on every keystroke.')
        .toEqual([]);
    });
  }
});

describe('the page stylesheet cannot escape into a shared component', () => {
  /** Every selector in the stylesheet, comments and at-rules stripped. */
  const selectors = CSS
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .map(block => block.split('{')[0].trim())
    .filter(Boolean)
    .flatMap(s => s.split(',').map(x => x.trim()))
    .filter(s => s && !s.startsWith('@') && !/^\d+%$/.test(s) && !s.startsWith('from') && !s.startsWith('to'));

  it('found the selectors (sanity check)', () => {
    expect(selectors.length).toBeGreaterThan(20);
  });

  it('every selector is anchored on a .bgv- class', () => {
    const escapes = selectors.filter(s => !s.includes('.bgv-'));
    expect(escapes,
      `${escapes.join(' | ')} — an unanchored selector reaches into whatever the page renders, ` +
      'including MasterSelect and the portalled menu it puts on <body>.')
      .toEqual([]);
  });

  it('does not use Topbar\'s .tb- prefix', () => {
    // Topbar loads on every page; `.tb-search` collided app-wide.
    //
    // ⚠ Checked against the DECLARATIONS, not the raw file. The stylesheet's own
    // header warns that ".tb- is Topbar's prefix", so a raw match fails on the
    // documentation — and would pass if someone deleted the warning and added a
    // .tb- rule, which is exactly backwards.
    expect(selectors.filter(sel => sel.includes('.tb-'))).toEqual([]);
  });

  it('has no bare element or attribute descendant rule', () => {
    // `.form-grid div > div` was a radio rule no page used, and it turned
    // MasterSelect's popup into a horizontal flex strip.
    const risky = selectors.filter(s => /\.bgv-[\w-]+\s+(div|span|button|table)\b(?!\S)/.test(s) && />/.test(s));
    expect(risky).toEqual([]);
  });
});

describe('the View Employee integration is a summary, not a second workspace', () => {
  it('Background Verification is its own tab', () => {
    // "Do not overload the existing Overview/Personal/Job/Payroll/Documents/
    // Assets/Onboarding/History/Notes tabs."
    expect(PROFILE).toMatch(/const BASE_TABS = \[[^\]]*'Background Verification'/);
  });

  it('the tab reads the SUMMARY endpoint rather than recomputing the counts', () => {
    // A second calculation is a second answer waiting to drift — the defect
    // behind three status vocabularies disagreeing about one employee.
    expect(PROFILE).toMatch(/\/bgv\/employees\/\$\{employee\.id\}\/summary/);
  });

  it('the tab uses the shared formatters, not its own', () => {
    expect(PROFILE).toMatch(/from '\.\.\/bgv'/);
    expect(PROFILE).toMatch(/bgvMoney\(/);
    expect(PROFILE).toMatch(/bgvProgress\(/);
  });

  it('a 403 is shown as a permission answer, not as "no checks run"', () => {
    expect(PROFILE).toMatch(/setBgvDenied\(true\)/);
    expect(PROFILE).toMatch(/cannot view background verification records/i);
  });

  it('the tab links to the BGV page instead of editing in place', () => {
    expect(PROFILE).toMatch(/setPage\('EmployeeBGV', \{ employee_id: employee\.id \}\)/);
    expect(PROFILE).toMatch(/This tab is read-only/);
  });
});

describe('reports open through the authenticated route', () => {
  it('a file is fetched as a blob with the JWT, never linked with an <a href>', () => {
    // GET /api/files/:filename requires a Bearer token. A plain link sends no
    // Authorization header and 401s, which on screen looks like a broken file.
    expect(EMP_PAGE).toMatch(/api\.get\(`\/files\/\$\{encodeURIComponent\(filename\)\}`/);
    expect(EMP_PAGE).toMatch(/responseType: 'blob'/);
    expect(EMP_PAGE, 'no BGV report may be reached through /uploads/').not.toMatch(/\/uploads\//);
  });

  it('a missing file says so and disables the open button', () => {
    expect(EMP_PAGE).toMatch(/File not in storage/);
    expect(EMP_PAGE).toMatch(/const missing = file\.file_present === false/);
    expect(EMP_PAGE).toMatch(/disabled=\{missing\}/);
  });

  it('an untouched field is never appended to FormData as the string "null"', () => {
    // formData.append(k, null) sends the four characters "null" — the defect that
    // stopped every employee being saved from the Add Employee form.
    const appends = [...EMP_PAGE.matchAll(/fd\.append\([^)]*\)/g)].map(m => m[0]);
    expect(appends.length).toBeGreaterThan(0);
    for (const a of appends) {
      expect(a, `${a} may append a null`).not.toMatch(/,\s*(null|undefined)\s*\)/);
    }
    // Each optional field is guarded before it is appended.
    expect(EMP_PAGE).toMatch(/if \(name\.trim\(\)\) fd\.append\('document_name'/);
  });
});

describe('the KPI cards and the filter set stay in step', () => {
  it('every filter a KPI can set is in the reset object', () => {
    // A filter the reset object does not know about sticks invisibly, and the
    // list stops matching the card the user just pressed.
    const reset = /const EMPTY_FILTERS = \{([\s\S]*?)\n\};/.exec(BGV_PAGE);
    expect(reset).toBeTruthy();
    for (const key of ['status', 'pending_reports', 'has_checks', 'overdue', 'unpaid']) {
      expect(reset[1], `${key} is settable but not resettable`).toMatch(new RegExp(`\\b${key}:`));
    }
  });

  it('a card applies the filter the API sent, not one the page invents', () => {
    expect(BGV_PAGE).toMatch(/onPick=\{applyKpi\}/);
    expect(BGV_PAGE).toMatch(/setFilters\(\{ \.\.\.EMPTY_FILTERS, \.\.\.\(filter \|\| \{\}\) \}\)/);
  });

  it('blank filters are dropped before the request', () => {
    // An empty string sent as a filter is a filter the API applies.
    expect(BGV_PAGE).toMatch(/const cleanFilters =/);
    expect(BGV_PAGE).toMatch(/v !== '' && v != null/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The four post-pass decisions, on the UI side.
// ═════════════════════════════════════════════════════════════════════════════

describe('1 — HR never retypes the agency contact', () => {
  it('the three contact fields are READ-ONLY and read from the agency master', () => {
    // HR picked the agency two fields above. Asking them to retype its contact
    // card is not merely tedious: a retyped contact is a second copy that goes
    // stale the moment the agency changes hands, and then the record says who we
    // used to call.
    expect(EMP_PAGE).toMatch(/readOnly value=\{agency\.contact_person \|\| '—'\}/);
    expect(EMP_PAGE).toMatch(/readOnly value=\{agency\.email \|\| '—'\}/);
    expect(EMP_PAGE).toMatch(/readOnly value=\{agency\.phone \|\| '—'\}/);
  });

  it('the agency is resolved from the picked id, not held as a separate copy', () => {
    expect(EMP_PAGE).toMatch(/const agency = agencies\.find\(a => String\(a\.id\) === String\(form\.agency_id\)\)/);
  });

  it('there is an explicit per-check override, and a way back', () => {
    expect(EMP_PAGE).toMatch(/Use a different contact for this check/);
    expect(EMP_PAGE).toMatch(/Go back to the agency contact/);
    expect(EMP_PAGE).toMatch(/const startOverride = \(\)/);
    expect(EMP_PAGE).toMatch(/const clearOverride = \(\)/);
  });

  it('the override starts from the agency card rather than three empty boxes', () => {
    expect(EMP_PAGE).toMatch(/contact_person: f\.contact_person \|\| agency\?\.contact_person \|\| ''/);
  });

  it('⚠ dropping the override CLEARS the fields, so nothing is posted back', () => {
    // Leaving the typed values in place would send them, and (but for the
    // server's de-duplication) freeze a copy of the agency's contact.
    expect(EMP_PAGE).toMatch(/contact_person: '', contact_email: '', contact_phone: ''/);
  });

  it('the override state is seeded from the server, not re-derived', () => {
    // `contact_is_override` is computed in SQL. Deriving it again here is how two
    // answers to the same question come to disagree.
    expect(EMP_PAGE).toMatch(/initial\?\.contact_is_override === true/);
  });

  it('the override is described as applying to this check only', () => {
    expect(EMP_PAGE).toMatch(/this check only/);
    expect(EMP_PAGE).toMatch(/The agency master is unchanged/);
  });
});

describe('2 — discrepancy findings are permission-controlled in the UI too', () => {
  it('a restricted folder is not drawn like an empty one', () => {
    // "No report attached yet" is a job to do; "you may not see this" is a
    // permission. Drawn alike, HR chases an agency that already delivered.
    expect(EMP_PAGE).toMatch(/f\.restricted/);
    expect(EMP_PAGE).toMatch(/restricted to HR Manager \/ Admin/);
    expect(EMP_PAGE).toMatch(/No report attached for this check yet/);
  });

  it('a restricted folder still reports its file COUNT', () => {
    // Otherwise it reads as "there are none", which is the misleading answer.
    expect(EMP_PAGE).toMatch(/f\.restricted_file_count/);
  });

  it('⚠⚠ a redacted finding is never editable and never posted back', () => {
    // The modal is seeded from the check row, which for a restricted caller
    // carries the placeholder. Saving would overwrite the real finding with
    // "Restricted — visible to HR Manager / Admin only" — silent destruction of
    // the data the redaction exists to protect.
    expect(EMP_PAGE).toMatch(/const restricted = initial\?\.detail_restricted === true/);
    expect(EMP_PAGE).toMatch(/SENSITIVE_TEXT = \['remarks', 'followup_notes', 'cost_remarks'\]/);
    expect(EMP_PAGE).toMatch(/!\(restricted && SENSITIVE_TEXT\.includes\(k\)\)/);
    // And they render as locked rather than as editable textareas.
    expect(EMP_PAGE).toMatch(/restricted\s*\n\s*\?\s*<input readOnly value="Restricted"/);
  });

  it('the case page says WHY it is showing less', () => {
    // A page that quietly shows fewer files than the check's own count claims
    // reads as a bug.
    expect(EMP_PAGE).toMatch(/data\.restricted_checks/);
    expect(EMP_PAGE).toMatch(/The status and result are shown; the findings, notes and reports are/);
  });

  it('a redacted contact note reads as restricted, not as blank', () => {
    expect(EMP_PAGE).toMatch(/r\.detail_restricted/);
  });

  it('the hub disables the Discrepancy Report rather than letting it 403', () => {
    expect(BGV_PAGE).toMatch(/hasPermission\('bgv_sensitive', 'view'\)/);
    expect(BGV_PAGE).toMatch(/const blocked = !canExport \|\| \(sensitive && !canSeeSensitive\)/);
    expect(BGV_PAGE).toMatch(/Restricted to HR Manager \/ Admin roles/);
  });

  it('only the Discrepancy Report is flagged sensitive among the five exports', () => {
    const block = /\[\s*\n\s*\['employees',[\s\S]*?\]\.map\(/.exec(BGV_PAGE);
    expect(block, 'export list not found').toBeTruthy();
    const sensitiveRows = [...block[0].matchAll(/\['(\w+)',\s*'[^']*',\s*(true|false)\]/g)]
      .filter(m => m[2] === 'true').map(m => m[1]);
    expect(sensitiveRows).toEqual(['discrepancy']);
  });
});

describe('3 — the UI offers no way to close over an open check', () => {
  it('there is no force flag and no "close anyway" path', () => {
    expect(EMP_PAGE).not.toMatch(/closeCase\(true\)/);
    expect(EMP_PAGE).not.toMatch(/Close the case anyway/);
    // ⚠ A WORD BOUNDARY, not `/force/` — the latter matches inside "enforced", which
    // appears in a doc comment about the reopen gate. A negative assertion that
    // fires on an unrelated word gets loosened, and then stops guarding anything.
    expect(EMP_PAGE).not.toMatch(/\bforce\b/);
  });

  it('closeCase takes no argument any more', () => {
    expect(EMP_PAGE).toMatch(/const closeCase = async \(\) =>/);
  });

  it('it names the open checks instead of offering a button that can only fail', () => {
    // ⚠ This asserted the STATUS-ONLY filter `['Pending','Initiated','In
    // Progress'].includes(ch.status)` — which the browser pass then proved was a
    // bug: it ignored applicability, so for a fresher it named Employment
    // Verification (Not Applicable) as a blocker and told HR to resolve a check
    // that cannot be resolved.
    //
    // It then asserted `.filter(isOutstanding)`, which was right until Optional
    // stopped blocking closure. The guard now uses `blocksClosure` (Required and
    // unresolved) — the SAME predicate the close handler issues. Twice over,
    // this assertion has followed the server rather than pinning a UI rule of
    // its own, which is the only way the two stay in agreement.
    expect(EMP_PAGE).toMatch(/\.filter\(blocksClosure\)/);
    expect(EMP_PAGE).toMatch(/Complete or cancel each one before closing the case/);
    expect(EMP_PAGE, 'a status-only filter must not come back')
      .not.toMatch(/ch => \['Pending', 'Initiated', 'In Progress'\]\.includes\(ch\.status\)/);
  });
});

describe('4 — the UI never claims the evidence file was deleted', () => {
  it('the confirmation says the file is retained', () => {
    expect(EMP_PAGE).toMatch(/RETAINED for/);
    expect(EMP_PAGE).toMatch(/nothing is deleted from storage/);
  });

  it('the button tooltip says the same thing', () => {
    expect(EMP_PAGE).toMatch(/the file is retained for audit/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Checklist, applicability and corrected progress — frontend side.
// ═════════════════════════════════════════════════════════════════════════════

describe('progress counts REQUIRED checks, not every check', () => {
  it('⚠ a Not Applicable check is NOT in the denominator', () => {
    // The fresher case: four required checks all done, plus Employment
    // Verification recorded as Not Applicable. The old label said "4/5".
    const fresher = {
      checks_total: 5, checks_completed: 4,
      required_total: 4, required_completed: 4, not_applicable: 1,
      required_completion_pct: 100,
    };
    expect(requiredProgressLabel(fresher)).toBe('4 / 4 required checks completed');
    expect(requiredPct(fresher)).toBe(100);
  });

  it('the brief\'s own example renders as written', () => {
    expect(requiredProgressLabel({ required_completed: 4, required_total: 6 }))
      .toBe('4 / 6 required checks completed');
  });

  it('⚠ a case whose only check is Not Applicable says "No required checks"', () => {
    // This is the misleading "0/1" the brief called out. It must not read as
    // "nothing done" — the truth is "nothing to do".
    const naOnly = { checks_total: 1, checks_completed: 0, required_total: 0, not_applicable: 1 };
    expect(requiredProgressLabel(naOnly)).toBe('No required checks');
    expect(requiredPct(naOnly), 'null, not 0 — a bar at zero would be a lie').toBeNull();
  });

  it('percentage is derived when the server did not send one', () => {
    expect(requiredPct({ required_total: 6, required_completed: 3 })).toBe(50);
  });

  it('a missing case is not a crash', () => {
    expect(requiredProgressLabel(null)).toBe('No required checks');
    expect(requiredPct(null)).toBeNull();
    expect(requiredPct(undefined)).toBeNull();
  });

  it('isOutstanding excludes a Not Applicable check', () => {
    expect(isOutstanding({ applicability: 'Required', status: 'Pending' })).toBe(true);
    expect(isOutstanding({ applicability: 'Optional', status: 'In Progress' })).toBe(true);
    expect(isOutstanding({ applicability: 'Not Applicable', status: 'Pending' }),
      'a recorded decision is not outstanding work').toBe(false);
    expect(isOutstanding({ applicability: 'Required', status: 'Completed' })).toBe(false);
    expect(isOutstanding({ applicability: 'Required', status: 'Cancelled' })).toBe(false);
  });

  it('needsReport ignores a Not Applicable check', () => {
    // Chasing a report for work nobody did.
    expect(needsReport({ applicability: 'Not Applicable', status: 'Pending', document_count: 0 }))
      .toBe(false);
    expect(needsReport({ applicability: 'Required', status: 'Pending', document_count: 0 }))
      .toBe(true);
  });

  it('each applicability has its own badge, distinct from the status palette', () => {
    for (const a of APPLICABILITY) {
      expect(badgeFor(a), `${a} has no badge`).not.toBe(badgeFor('__none__'));
    }
    // Required must not look like a warning, Not Applicable must not look like
    // a failure — they describe scope, not outcome.
    expect(badgeFor('Not Applicable').bg).not.toBe(badgeFor('Discrepancy').bg);
    expect(badgeFor('Required').bg).not.toBe(badgeFor('Pending').bg);
  });

  it('the vocabulary matches what the API accepts', () => {
    expect(APPLICABILITY).toEqual(['Required', 'Optional', 'Not Applicable']);
    expect(APPLICABLE).toEqual(['Required', 'Optional']);
  });
});

describe('the checklist UI', () => {
  it('profiles are fetched, never hardcoded in the page', () => {
    expect(EMP_PAGE).toMatch(/api\.get\('\/bgv\/profiles'\)/);
    expect(EMP_PAGE, 'a copy of the profile table here would drift from the server')
      .not.toMatch(/'Identity Verification':\s*'Required'/);
  });

  it('Start BGV opens the checklist rather than an empty case', () => {
    expect(EMP_PAGE).toMatch(/onClick=\{\(\) => setChecklist\(true\)\}/);
    expect(EMP_PAGE, 'the "open an empty case" action is gone')
      .not.toMatch(/const startCase = async/);
  });

  it('one action creates the case and the checks', () => {
    // /start when there is no case, /checks/bulk when there is — same modal.
    expect(EMP_PAGE).toMatch(/\/bgv\/cases\/\$\{caseId\}\/checks\/bulk/);
    expect(EMP_PAGE).toMatch(/\/bgv\/employees\/\$\{employeeId\}\/start/);
  });

  it('HR can tick, untick and set applicability before creating', () => {
    expect(EMP_PAGE).toMatch(/type="checkbox"/);
    expect(EMP_PAGE).toMatch(/setRow\(r\.check_type, \{ selected: e\.target\.checked \}\)/);
    expect(EMP_PAGE).toMatch(/setRow\(r\.check_type, \{ applicability: e\.target\.value \}\)/);
  });

  it('the applicability control is disabled until the row is ticked', () => {
    expect(EMP_PAGE).toMatch(/disabled=\{!r\.selected \|\| r\.already\}/);
  });

  it('a type already on the case is shown disabled, not hidden', () => {
    // Hiding it makes the list differ from the profile HR chose.
    expect(EMP_PAGE).toMatch(/already on this case/);
    expect(EMP_PAGE).toMatch(/existingTypes/);
  });

  it('the footer says what will be created, including the Not Applicable rows', () => {
    expect(EMP_PAGE).toMatch(/will be created/);
    expect(EMP_PAGE).toMatch(/never counted as pending work/);
  });

  it('Create is disabled when nothing is ticked', () => {
    expect(EMP_PAGE).toMatch(/disabled=\{saving \|\| loading \|\| chosen\.length === 0\}/);
  });

  it('the checklist modal is declared at MODULE level like every other component', () => {
    // A component declared inside a render remounts the subtree on every
    // keystroke — and the jsdom test for that defect passed.
    expect(EMP_PAGE).toMatch(/^function ChecklistModal\(/m);
  });

  it('the single-check form still exists, for a deliberate re-check', () => {
    expect(EMP_PAGE).toMatch(/Add one check/);
  });
});

describe('the page never shows a Not Applicable check as work', () => {
  it('a Not Applicable row is never overdue and never flagged for a report', () => {
    expect(EMP_PAGE).toMatch(/const applies = ch\.applicability !== 'Not Applicable'/);
    expect(EMP_PAGE).toMatch(/const overdue = applies &&/);
    expect(EMP_PAGE).toMatch(/!ch\.detail_restricted && applies &&/);
  });

  it('the checks table has an Applies column', () => {
    expect(EMP_PAGE).toMatch(/<th>Verification<\/th><th>Applies<\/th>/);
    expect(EMP_PAGE).toMatch(/<Badge value=\{ch\.applicability\} \/>/);
  });

  it('the summary tiles report the full breakdown', () => {
    for (const label of ['Required checks', 'Completed', 'In Progress', 'Pending',
      'Not Applicable', 'Discrepancies']) {
      expect(EMP_PAGE, `the summary is missing "${label}"`)
        .toMatch(new RegExp(`label="${label}"`));
    }
  });

  it('there is no progress bar when nothing is required', () => {
    expect(EMP_PAGE).toMatch(/requiredPct\(data\) != null && \(/);
  });

  it('it explains that an open applicable check blocks closure', () => {
    expect(EMP_PAGE).toMatch(/cannot be\s*\n?\s*closed until each is completed or cancelled/);
  });
});

describe('reopening, in the UI', () => {
  it('a reason is asked for and validated before the request', () => {
    expect(EMP_PAGE).toMatch(/Why is this closed BGV case being reopened\?/);
    expect(EMP_PAGE).toMatch(/reason\.trim\(\)\.length < 5/);
  });

  it('the button only appears with the sensitive grant', () => {
    expect(EMP_PAGE).toMatch(/canEdit && closed && canSeeSensitive/);
    expect(EMP_PAGE).toMatch(/Reopening is restricted to HR Manager \/ Admin/);
  });

  it('the reopen reason is shown on the case afterwards', () => {
    expect(EMP_PAGE).toMatch(/data\.reopened_at && !closed/);
    expect(EMP_PAGE).toMatch(/data\.reopen_reason/);
  });
});

/**
 * The two closure questions, and why they need two helpers.
 *
 * `isOutstanding` answers "is this work?" — it drives the progress strip, and
 * Optional counts, because an optional check somebody started really is open
 * work sitting on the case.
 *
 * `blocksClosure` answers "will the server refuse to close?" — Required only.
 *
 * ⚠⚠ The close guard once used the first one for the second question. That is
 * the whole class of bug this module keeps producing: a UI rule that restates
 * the server's rule instead of matching it. The browser pass caught it naming a
 * check as a blocker that the server would have let straight through.
 */
describe('outstanding work and closure blockers are different questions', () => {
  const chk = (applicability, status) => ({ applicability, status });

  it('an Optional check in flight IS outstanding work', () => {
    expect(isOutstanding(chk('Optional', 'In Progress'))).toBe(true);
  });

  it('...but does NOT block closure', () => {
    expect(blocksClosure(chk('Optional', 'In Progress'))).toBe(false);
  });

  it('a Required check in flight is both', () => {
    expect(isOutstanding(chk('Required', 'Pending'))).toBe(true);
    expect(blocksClosure(chk('Required', 'Pending'))).toBe(true);
  });

  it('a Not Applicable check is neither, whatever its status', () => {
    for (const status of ['Pending', 'Initiated', 'In Progress']) {
      expect(isOutstanding(chk('Not Applicable', status))).toBe(false);
      expect(blocksClosure(chk('Not Applicable', status))).toBe(false);
    }
  });

  it('a resolved Required check is neither', () => {
    for (const status of ['Completed', 'Cancelled']) {
      expect(isOutstanding(chk('Required', status))).toBe(false);
      expect(blocksClosure(chk('Required', status))).toBe(false);
    }
  });

  it('⚠ neither helper treats a missing applicability as Required', () => {
    // A check row from an older API shape has no `applicability`. Both helpers
    // return false rather than guessing — the SERVER decides what blocks, and a
    // UI that invents a blocker it cannot clear is unusable. (`needsReport`
    // fails the other way, toward asking for the report, because there the
    // safe answer is to chase evidence.)
    expect(isOutstanding({ status: 'Pending' })).toBe(false);
    expect(blocksClosure({ status: 'Pending' })).toBe(false);
  });

  it('a null check is not a crash', () => {
    expect(isOutstanding(null)).toBe(false);
    expect(blocksClosure(null)).toBe(false);
  });
});

describe('the Skip and Re-verify actions call the real endpoints', () => {
  it('Skip posts to /skip with a reason', () => {
    expect(EMP_PAGE).toMatch(/api\.post\(`\/bgv\/checks\/\$\{row\.id\}\/skip`, \{ reason/);
  });

  it('Re-verify posts to /reverify with a reason', () => {
    expect(EMP_PAGE).toMatch(/api\.post\(`\/bgv\/checks\/\$\{row\.id\}\/reverify`, \{ reason/);
  });

  it('both refuse an empty or too-short reason before calling the server', () => {
    const count = (EMP_PAGE.match(/at least 5 characters is required/g) || []).length;
    expect(count, 'skip and re-verify each validate the reason').toBeGreaterThanOrEqual(2);
  });

  it('both RELAY the server message rather than restating its rules', () => {
    // Every precondition on these actions lives in the handler
    // (CANNOT_SKIP_REQUIRED, PREVIOUS_STILL_OPEN, DUPLICATE_ACTIVE_CHECK) and
    // the page shows what came back. The ABSENCE of those codes here is the
    // point, not an omission: a second copy of the rule in the client is
    // exactly how the close guard came to contradict the server.
    expect(EMP_PAGE).toMatch(/Could not skip the check/);
    expect(EMP_PAGE).toMatch(/Could not start a re-verification/);
    const handlers = /const skipCheck[\s\S]*?const deleteCheck/.exec(EMP_PAGE)[0];
    expect(handlers).toMatch(/err\.response\?\.data\?\.message/);
  });

  it('a re-verification must not claim the previous result is replaced', () => {
    // HR has to know the old attempt is still on file, or they will not use it.
    expect(EMP_PAGE).toMatch(/previous result is kept on file/);
  });
});
