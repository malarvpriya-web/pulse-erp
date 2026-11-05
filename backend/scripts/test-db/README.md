# Isolated test database (§220)

Some test tools **write numbered documents**: requisitions, POs, GRNs, invoices, tickets and so on. Each one permanently consumes a value of a global PostgreSQL sequence, and sequences ignore rollback. Run against the developer database, these tools left gaps in live numbering and wrote rows into company 1. They now run **only** against a separate, explicitly recognised test database, and they refuse everything else.

## What "recognised" means (all must hold — `guard.mjs`)
1. `PULSE_TEST_DB=1` is set explicitly.
2. `current_database()` matches `^pulse_e2e(_[a-z0-9]+)?$`.
3. It is not the developer database named in `backend/.env`. This is read from the file, so an environment override cannot disguise it.
4. It holds the marker row `pulse_test_environment(id=1)`, and the marker **names this database**. A copy restored under another name is refused.
5. For tools that call a server, the server must also **prove** it serves this database. The tool plants a one-off vendor and reads it back over the API. The test backend signs tokens with its own secret, so the developer server rejects test tokens outright.

There is no fallback. A refusal exits non-zero before the tool's first write.

## One-time setup
```bash
cd Pulse/backend
node scripts/test-db/setup.mjs            # creates pulse_e2e (or: setup.mjs pulse_e2e_<name>)
```
`setup.mjs` does the following:
- refuses any name outside the allowlist, and the developer DB;
- refuses an existing database that does not carry its marker;
- builds the schema with the normal migration runner (baseline bootstrap, then all migrations), with `DATABASE_URL` removed so it cannot reach anything else;
- writes the marker;
- seeds the CI fixture users and the **E2ETEST** company: super admin `e2e.superadmin@pulse-e2e.test` (no password — tools mint tokens), a warehouse (also the main receiving point), an item, and a rated vendor.

It is idempotent: re-run it after pulling new migrations.

## Browser specs that write
```bash
cd Pulse
npx playwright test -c playwright.testdb.config.ts
```
Playwright starts **its own** servers and never reuses a running one:
- backend on **:5100** (`scripts/test-db/start-backend.mjs`, guarded, test JWT secret);
- frontend on **:5174** (Vite with `VITE_API_URL=http://localhost:5100/api`).

The developer servers on :5000 and :5173 are not contacted.

Session state goes to `tests/.auth/testdb-user.json`, never to the developer session file.

Specs run this way:
- `tests/suites/03-crud/procurement-hardening.spec.ts`

It is also excluded from `playwright.config.ts`. Run any other way, it throws in `beforeAll` before writing.

## Scripts that write
Start the test backend, then run the tool through the wrapper:
```bash
cd Pulse/backend
node scripts/test-db/start-backend.mjs                 # terminal 1 (port 5100)
node scripts/test-db/run.mjs scripts/procurement-lifecycle-probe.mjs
node scripts/test-db/run.mjs scripts/sca/exercise-chain.mjs
node scripts/test-db/run.mjs scripts/smoke-employee-access.js
node scripts/test-db/run.mjs scripts/sca/rebuild-supply-chain-data.mjs --company <id>
node scripts/test-db/run.mjs scripts/sca/seed-traceable-chain.mjs
node scripts/test-db/run.mjs scripts/seed-recruitment-demo.js
```
`run.mjs` sets `DB_NAME`, `PULSE_TEST_DB=1`, the test JWT secret and the test base URLs, and removes `DATABASE_URL`. Each script still runs the guard itself.

Note: the two SCA writers and `exercise-chain` were written against company 1's SCA reference dataset. In a fresh test database they run against the baseline copy of company 1 and may find little data to work on.

## Removing the test database
```sql
-- as a superuser, from any database except pulse_e2e
DROP DATABASE pulse_e2e;
```
There is deliberately no script for this. Re-create the database with `setup.mjs`.

## The backend vitest suite (§221)
```bash
cd Pulse/backend
node scripts/test-db/setup.mjs                 # once, and after pulling migrations
npm run test:db                                # whole suite
npm run test:db -- src/__tests__/<file>.js     # one file
npm run test:db -- --maxWorkers=2              # what the full-suite runs used
```
- `npm run test:db` (`scripts/test-db/vitest.mjs`) sets `DB_NAME=pulse_e2e` (or `PULSE_TEST_DB_NAME`) and `PULSE_TEST_DB=1`, and **removes `DATABASE_URL`**, so a connection string left in the shell cannot redirect it.
- The suite's `globalSetup` (`scripts/test-db/vitest.globalSetup.mjs`) runs `assertTestDatabase` once, before any test file loads. It connects through `src/config/db.js`, the same configuration every worker inherits. If it refuses, the run aborts and no test executes.
- **Plain `npm test` / `npx vitest` now refuse** unless that environment points at a marked test database. There is no fallback to the developer DB.

### Reference data
`seed.mjs` adds the reference rows the suite reads. On a fresh database, `baseline-data.sql` carries only companies, roles and role_permissions. Each block comes from a product definition, never from the developer DB:

| Block | Source of the values | Read by |
|---|---|---|
| Chart of accounts (global) | replays migrations 20260603000001, 20260604000007, 20260613000005 (idempotent) | sales invoicing 3F–3I, dispatch, warehouse lifecycle, IoT parts, payroll GL and loans (1013 / 4006) |
| Travel approval workflow (SLA 72 h) | replays migration 20260806000005 | approvalsInbox, approvalsSecurity |
| Departments, designations, ticket categories, leave types (company 1) | the lists in `seeds/defaultSeed.js` (what the setup wizard seeds) | employeeCode.contract ('IT'), biometricWorkflows ('Engineering'), probationReviewStaleness (8 departments), ticketCategoryBreakdown ('Hardware' and others), approvedRunImmutability / encashmentOwnership (a leave type), 06-db-consistency ('Engineering' / 'Engineer') |
| SLA policies (company 1) | the four defaults Settings → Service Desk writes | ticketCategories |
| Zones: 'North' and one retired zone | the product zone vocabulary | employeeAssetScope, masterVocabularies |
| Synthetic biometric device (company 1, 192.0.2.10) | — | biometricAuthz |
| Employee EMP001 in company 1; company 565 with one employee | synthetic names, no personal data | employeeCode.contract; bgvIntegration, employeeTenantScope, viewEmployeeSurface (`FOREIGN = 565`) |
| Five 'SEED Visitors n' hosted by employees 1–5 | synthetic stand-ins for developer-DB residue | biometricAuthz |
| Zero-quantity lot and second warehouse in E2ETEST | — | advancedInventoryInvariants (global scope), inventoryKpi (fan-out) |
| Global attendance setting: 8 h + 30 min | the §198 decision | biometricWorkflows |
| `employees_id_seq` moved past `users_id_seq` + 100000 (test DB only) | — | successionSecurity (look-alike employee id = user id) |

### CI
`.github/workflows/ci.yml` creates the service database as **`pulse_e2e_ci`** and sets `PULSE_TEST_DB=1`. After migrations it runs `node scripts/test-db/mark-ci.mjs pulse_e2e_ci`, then `seed-test-fixtures.mjs` and `test-db/seed.mjs`.

`mark-ci.mjs` refuses in each of these cases:
- when not running in CI (`CI=true`);
- when the name does not match the guard pattern;
- when the connected `current_database()` is not that name;
- when the server is not the job's localhost container.

## What this does NOT cover
- Six assertions in four suites check the *outcome of old migrations over developer history*. They fail on any fresh database by design; see MODULE_FEATURE_CONNECTION_MANUAL.md §221:
  - `advancedInventoryInvariants` ×2 (NOT VALID FK, grandfathered suggestion 9 → PR 1451);
  - `attendanceContract` ×1 (Title-Case rows in the frozen `attendance` table);
  - `traceabilityClosure` ×2 (legacy bins carried into `warehouse_bins`; GRN `quality_status_prior`);
  - `iot.gapclosure` ×1 (`iot_legacy_quarantine` rows).
- Playwright specs other than those listed above still use the developer servers.
