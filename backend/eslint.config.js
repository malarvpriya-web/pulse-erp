/**
 * eslint.config.js — backend static analysis.
 *
 * WHY THIS EXISTS
 * ---------------
 * The backend had no linter and no type check at all. It was recorded as
 * remaining risk 7 of the PULSE-01 remediation and closed here. The only static
 * check in place was `src/__tests__/sourceParses.contract.test.js`, which proves
 * every file PARSES — valuable (a backtick in a SQL comment has broken the boot
 * twice) but it says nothing about whether the code is right.
 *
 * ⚠ WARN, NOT ERROR, for style. This is being switched on over ~1,000 existing
 * files; a config that fails the build on day one gets `--no-verify`d and then
 * ignored. The rules that catch REAL BUGS are errors, and there are only a few of
 * them on purpose so that a red line means something.
 *
 * WHAT IT FOUND ON ITS FIRST RUN
 * ------------------------------
 * Eleven live bugs, all fixed in the same change, none of which any test covered:
 *
 *  - `no-undef` x6 — identifiers CALLED but never imported, i.e. a guaranteed
 *    ReferenceError the moment the endpoint is hit:
 *      gst.routes.js        buildIrpPayload / buildEwbPayload / irpConfigured /
 *                           submitToIrp — every e-invoice and e-way-bill endpoint
 *      tds.routes.js        `total_tds` shorthand for a variable named totalTds —
 *                           Form 16A generation
 *      projects.routes.js   deriveResponseFields — project closure with a rating
 *      servicedesk.routes.js deriveResponseFields — ticket feedback
 *  - `no-constant-binary-expression` x5 — `Number(x) ?? fallback`, which NEVER
 *    falls through because `Number(undefined)` is NaN and NaN is not nullish. So
 *    omitting the field wrote NaN to a numeric column instead of preserving the
 *    stored value: four leave-type fields and `service_contracts.value`.
 *
 * That is the argument for this file. A parse check could not see any of them.
 *
 * WHICH RULES ARE ERRORS
 * ----------------------
 * Only those where a finding is a defect with no valid intent: `no-undef`,
 * `no-dupe-keys`/`-args`/`-else-if`, `no-unsafe-finally`, `no-unsafe-negation`,
 * `no-unreachable`, `no-self-assign`, `no-self-compare`,
 * `no-async-promise-executor`, `no-fallthrough`, `no-cond-assign`,
 * `no-constant-condition`, and `no-constant-binary-expression` (from
 * js.configs.recommended). Everything stylistic is a warning, so a red line means
 * something is broken.
 *
 * Run: `npm run lint` (all findings) or `npm run lint:errors` (errors only —
 * what CI should gate on; currently zero).
 */
import js from '@eslint/js';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores([
    'node_modules',
    'uploads',
    'backups',
    'logs',
    'coverage',
    // Generated or vendored SQL/JS snapshots, not hand-written source.
    'src/database/baseline.sql',
  ]),
  {
    files: ['**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2024,
      },
    },
    rules: {
      // ── Real bugs: errors ────────────────────────────────────────────────
      // ⚠ require-await is a WARNING, not an error, and the distinction matters.
      // It flags the DECLARATION (an `async` function with no `await`), which is
      // untidy but harmless — the function still returns a promise and callers
      // still await it. 94 pre-existing instances proved that. The bug I actually
      // wanted to catch is on the CALL side (an un-awaited async call, whose
      // Promise is truthy), and that needs type information core ESLint does not
      // have. `asyncContract.test.js` covers the specific functions that matter.
      'require-await':                'warn',
      'no-dupe-keys':                 'error',
      'no-dupe-args':                 'error',
      'no-dupe-else-if':              'error',
      'no-unsafe-finally':            'error',
      'no-unsafe-negation':           'error',
      'no-unreachable':               'error',
      'no-self-assign':               'error',
      'no-self-compare':              'error',
      'no-async-promise-executor':    'error',
      // Warning: every instance is `new Promise(r => setTimeout(r, n))` in a test
      // or script, where the returned timer id is simply unused. Harmless.
      'no-promise-executor-return':   'warn',
      'no-fallthrough':               'error',
      // Default 'except-parens' — `while ((m = re.exec(s)) !== null)` is the
      // idiomatic regex loop and appears throughout this codebase. 'always' would
      // flag every one of them and teach people to ignore the linter.
      'no-cond-assign':               'error',
      'no-constant-condition':        ['error', { checkLoops: false }],
      'no-undef':                     'error',
      // An `await` inside a loop over tenants is deliberate here — see the pool
      // connection budget in vitest.config.js — so it is NOT flagged.

      // ── Style and incomplete work: warn ──────────────────────────────────
      'no-unused-vars': ['warn', {
        varsIgnorePattern: '^_|^[A-Z_]',
        argsIgnorePattern: '^_|^(req|res|next)$',
        caughtErrorsIgnorePattern: '^_|^e$|^err$',
        destructuredArrayIgnorePattern: '^_',
      }],
      // Empty catches are an established idiom in this codebase for
      // fire-and-forget side effects (audit, push, email mirrors).
      'no-empty':               ['warn', { allowEmptyCatch: true }],
      'no-prototype-builtins':  'warn',
      'no-useless-escape':      'warn',
      'no-control-regex':       'off',   // fires on legitimate sanitisers
      'no-irregular-whitespace': ['warn', { skipStrings: true, skipTemplates: true, skipComments: true }],
    },
  },
  {
    // swaggerSetup.js builds a <script> the BROWSER runs, so `window` is correct
    // there and only there.
    files: ['src/docs/swaggerSetup.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // Tests legitimately reach for globals the runner injects and keep
    // deliberately-unused fixtures around.
    files: ['src/__tests__/**/*.js', '**/*.test.js'],
    languageOptions: { globals: { ...globals.node, ...globals.vitest } },
    rules: {
      'no-unused-vars': 'off',
      'require-await':  'off',   // `async` test bodies with no await are normal
    },
  },
  {
    // Migrations receive a `knex` shim they may not use, and seeds are scripts.
    files: ['src/database/migrations/**/*.js', 'src/database/seeds/**/*.js', 'scripts/**/*.{js,mjs}'],
    rules: {
      'no-unused-vars': 'off',
      'require-await':  'off',
    },
  },
]);
