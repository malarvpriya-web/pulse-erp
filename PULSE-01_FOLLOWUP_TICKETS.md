Written for: whoever picks these up — a backend engineer with repo access, not the person who wrote the PULSE-01 fix.

# Tickets arising from PULSE-01

Eight tickets. Each is something the PULSE-01 remediation found and deliberately did **not** fix, with the reason it was left. None of them blocks the PULSE-01 fix; three of them are real defects that will bite on their own schedule.

Source: `PULSE-01_REMEDIATION.md` §12. PULSE-08 and PULSE-09 were found while scoping the commit, not during the remediation itself. Branch: `security/pulse-01-integration-config-authz`.

---

## PULSE-02 — `payment.routes.js` tenant predicates fail OPEN on a null scope

**Priority:** High (money path, cross-tenant read/write) · **Effort:** S, but needs care

`src/modules/integrations/payment.routes.js:9`:

```js
const getCompanyId = (req) => req.scope?.company_id ?? null;
```

That `null` then feeds predicates shaped `($2::int IS NULL OR i.company_id = $2)`, in which **`null` means "no company filter"** — every tenant's rows match. The repo's own helper exists precisely for this: `companyOf(req)` (see `src/shared/scope.js`, whose header documents this exact failure).

Affected handlers: `/unpaid-invoices`, `/kpis`, `/create-order`, `/create-link`, `/verify`, `/mark-paid`, `/history`.

**Why PULSE-01 did not fix it:** changing tenant filtering on money queries is a behaviour change on a financial path and belongs in its own change with its own tests. PULSE-01 only switched *credential resolution* on those handlers to `companyOf`. Bundling the two would have made the security fix unreviewable.

**Acceptance criteria**
- `getCompanyId` replaced by `companyOf(req)`, or the predicates changed so a null scope selects nothing rather than everything.
- A test per handler proving a null-scope caller cannot read or write another tenant's invoices — **paired with a positive** proving a normal caller still can. (An isolation test alone passes when the endpoint is broken for everyone.)
- Confirm the super-admin global case still works, or decide explicitly that it should not.

---

## PULSE-03 — Migrate off the abandoned `xlsx` npm package

**Priority:** Medium (not currently reachable) · **Effort:** M

`xlsx@0.18.5` carries two unfixed high advisories — prototype pollution (GHSA-4r6h-8v6p-xvw6) and ReDoS (GHSA-5pgg-2g8v-p4x9) — and **there is no fix on npm**; the package there is abandoned. The maintained distribution is published by SheetJS directly.

**Assessed as not currently exploitable**, with evidence: both advisories are triggered by *parsing* a workbook, and this codebase only writes them — `XLSX.utils.json_to_sheet` / `book_new` / `book_append_sheet` / `XLSX.write`, with **no `XLSX.read` anywhere** in `src/` (verified by grep). It goes live the moment anyone adds a spreadsheet *import*.

**Acceptance criteria**
- Either migrate to the maintained SheetJS distribution, or replace the three export call sites (`analytics.routes.js`, `crm.routes.js` ×2, `pursuits.routes.js`) with a writer that has no advisories.
- Add a guard test asserting `XLSX.read` is not used, so the risk assessment above cannot silently stop being true.
- ⚠ **Blocks any spreadsheet-import feature.** Link this ticket from any such story.

---

## PULSE-04 — `ENCRYPTION_KEY` rotation routine

**Priority:** Medium · **Effort:** S

Rotation is now *detected* — `decryptStrict()` throws `CredentialDecryptError`, consumers log `credential_decrypt_failed` and degrade to the deployment environment, administration routes return 500 — which was the actual defect (it used to read as "not configured" and silently stop sending). But there is still no way to *perform* a rotation, so rotating the key means every tenant re-enters every credential.

**Acceptance criteria**
- `scripts/rotate-encryption-key.mjs` taking the old and new key, decrypting and re-encrypting every `company_integrations` row **inside one transaction**.
- Refuses to start if any row fails to decrypt with the old key, naming the rows — a partial rotation is worse than none.
- A dry-run mode that reports counts and changes nothing.
- Document it in the runbook next to the `ENCRYPTION_KEY` entry.

---

## PULSE-05 — `integration.supplyChain > MRP` flakes on shared fixture state

**Priority:** Medium (it makes every other suite's evidence less trustworthy) · **Effort:** M

`src/__tests__/integration.supplyChain.test.js:269` runs the real MRP engine over **shared demo company 1** (`const CID = 1`) and asserts that a planned order with `safety_stock > 0` exists. The engine emits one only when

```js
const net = gross[b] + item.safety_stock - available;   // mrpEngine.service.js:401
```

is positive, so **any concurrent suite posting stock to company 1's items raises `available` and empties the filter**. Observed twice in ~15 full runs. Not caused by the PULSE-01 work — the mechanism is the shared fixture.

**Why PULSE-01 did not fix it:** the correct fix is a dedicated synthetic tenant with deterministic data, which is a fixture redesign across a 46-test suite and does not belong in a security branch.

**Acceptance criteria**
- The MRP assertions run against their own tagged company with seeded items, BOM, forecast and stock, swept on the way in as well as out, deleted by exact code rather than a `LIKE 'prefix%'` that would eat a sibling tag.
- 20 consecutive full-suite runs with no failure in this file.
- ⚠ Do **not** "fix" it by asserting `>= 0` or skipping when data is absent. A test that cannot fail is worse than a flaky one, and this repo has shipped that mistake before.

---

## PULSE-06 — Burn down the 248 backend lint warnings

**Priority:** Low · **Effort:** L, but trivially divisible

`npm run lint:errors` is at **0 errors** and should be gated in CI. `npm run lint` reports 248 warnings: mostly `no-unused-vars` (131) and `require-await` (94).

The config starts errors-only on purpose — switching a linter on across ~1,000 files with a red build gets it disabled rather than fixed.

**Acceptance criteria**
- CI runs `npm run lint:errors` and fails the build on a non-zero exit.
- Warnings burned down module by module, not in one sweep.
- ⚠ Do not promote `require-await` to an error. It flags the *declaration* (an `async` function with no `await`), which is harmless — the function still returns a promise and callers still await it. The dangerous case is an un-awaited *call*, which needs type information core ESLint does not have; `src/__tests__/asyncContract.contract.test.js` covers the functions where it actually matters.

---

## PULSE-07 — Make `ZOHO_SIGN_WEBHOOK_SECRET` tenant-configurable

**Priority:** Low · **Effort:** XS

`webhooks.routes.js` already resolves both webhook secrets through `resolveConfig(<tenant>, …)` with the deployment environment as fallback. `RAZORPAY_WEBHOOK_SECRET` **is** in `INTEGRATION_FIELDS`, so a tenant can set its own today. `ZOHO_SIGN_WEBHOOK_SECRET` is **not**, so it still resolves to the deployment value only.

**Why it was left:** no Zoho Sign webhook was configured to test against, and adding an allowlist field that nothing has ever exercised is worse than leaving the working fallback in place.

**Acceptance criteria**
- `ZOHO_SIGN_WEBHOOK_SECRET: F(str(256), true)` added to the `zoho-sign` block of `INTEGRATION_FIELDS`.
- A field added to the Zoho Sign card in `IntegrationsHub.jsx`.
- A test proving a tenant-set secret is preferred over the deployment one, **and** that the deployment one still works when the tenant has none.
- ⚠ `assertAllowlistIsSafe()` will refuse the name if it ever collides with `FORBIDDEN_FIELD_NAMES`. It does not today; do not "fix" a future collision by editing that list.

---

## PULSE-08 — 55 migrations are applied to dev but untracked in git

**Priority:** High (blocks any staging comparison) · **Effort:** S to commit, M to verify

`backend/src/database/migrations` holds **55 files that git does not track and that `schema_migrations` says are already applied** to the development database (55 of 55 applied, 0 pending). Mostly IoT phase 4, finance and recruitment work. Consequences:

- A fresh clone, CI run or staging deploy builds a schema **55 migrations behind development**, so dev-vs-staging comparisons are not like-for-like and a staging failure is uninterpretable.
- `npm run migrate:status` reports `Pending: -6`, a negative number, because more migrations are recorded as applied than exist as files — the status command cannot describe this state honestly.
- It is how `baseline.sql` and the manifest drift apart, which this repo has been bitten by before.

This was found while scoping the PULSE-01 commit. The PULSE-01 work itself does **not** depend on any of the 55 — every table it touches is created by a committed migration, verified individually — so it is safe to deploy independently.

**Acceptance criteria**
- Each of the 55 either committed, or deleted and its effect folded into a committed migration, with a recorded decision per file.
- `npm run migrate:status` reports a non-negative pending count.
- A fresh database built from committed migrations plus `baseline.sql` matches development's `information_schema` — diff it, do not eyeball it.
- ⚠ Do **not** simply `git add` all 55 without reading them. Some may be superseded by others already committed, and the runner's superseded-notice list already names six such cases.

---

## PULSE-09 — `tenant-leaks.json` is a scan artifact that is not gitignored

**Priority:** Low (hygiene) · **Effort:** XS

`tenant-leaks.json` sits untracked at the repo root. It is the output of a cross-tenant probe — company 1 vs 108, both as admin, across 121 endpoints — and its `findings` array is **empty**, so it records a clean result rather than open vulnerabilities. Its contents are endpoint paths and status codes, no tenant data.

It is not in `.gitignore`, so a `git add .` would commit it, and a generated probe result is not source.

**Acceptance criteria**
- Added to `.gitignore` alongside the other generated report paths, or moved under an already-ignored reports directory.
- ⚠ If a future run of that probe produces a **non-empty** `findings` array, that is a security finding and belongs in the tracker, not in an untracked file at the repo root.

---

## Not a ticket: things deliberately left as they are

Recorded so nobody raises them as bugs.

| Thing | Why it stays |
|---|---|
| `WHATSAPP_VERIFY_TOKEN` reads the environment | Meta calls that endpoint unauthenticated during the webhook handshake. There is no tenant to resolve, and the URL is one per deployment. |
| `sendPasswordResetOTP` takes no `companyId` | Routing account recovery over mail infrastructure a tenant administrator controls would hand them the recovery channel for their own users. This is load-bearing and asserted by a test. |
| `company_id = 0` global bucket is reachable | `companyOf(req)` returns null for a super admin with no company, mapped to the column's own `DEFAULT 0`. Pre-existing, no such rows exist, and redesigning it is not in scope. |
| The audit redaction over-redacts `keyword` and `key_metrics` | A redacted field costs a reader one lookup; a credential in a long-lived, widely-readable audit log cannot be un-written. |
