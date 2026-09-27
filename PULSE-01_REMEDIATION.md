# PULSE-01 — Integration configuration authorization & arbitrary environment mutation

**Severity:** CRITICAL · **Audit:** 20–21 September 2026 (Asia/Kolkata) · **Remediated:** 26 September 2026
**Baseline:** OWASP ASVS 5.0.0, proposed L2 + privileged/financial controls
**Branch:** `security/pulse-01-integration-config-authz` (changes are **uncommitted** — see §14)
**Passes:** Pass 1 closed PULSE-01. **Pass 2 closed the nine residual risks** it recorded, finding six further defects — three critical, two reachable unauthenticated (§12a). **Pass 3 reviewed my own diff against the three decisions §15 flagged: one did not survive, and pushing on another found a hole in the PULSE-01 gate itself** (§12b).
**Status:** reproducer denied, regression green, live before/after on a running server, browser verification — all agree. **Remaining: independent code review and a controlled staging deployment** (§15).

---

## 1. Root cause analysis

One function, `applyToEnv()` in `integrations-config.routes.js`:

```js
function applyToEnv(key, creds) {
  for (const [envKey, val] of Object.entries(creds)) {
    if (val && String(val).trim()) process.env[envKey] = String(val).trim();
  }
}
```

`creds` was the request body merged over the stored row, **with no allowlist**. The body's *keys* therefore became environment variable *names*. Three independent defects compounded:

| # | Defect | Why it was exploitable |
|---|---|---|
| 1 | **No authorization.** Mounted `verifyToken` only (`server.js:903`). `auditMutations('admin')` is a *logger*, not a gate — the module name reads like one. | Any authenticated user, including `employee`. |
| 2 | **Arbitrary `process.env` write.** | `auth.middleware.js:325` reads `PERMISSION_FAIL_OPEN` **per request**, not at boot. Setting it `true` makes `requirePermission()` pass for any module with no permission row. |
| 3 | **No schema.** Unknown field names persisted; values never validated. | `SMTP_PORT='not-a-port'` accepted; `SMTP_HOST='http://evil/?x='` accepted. |

A fourth, structural problem sat underneath: **`process.env` is process-global**, so even a correctly-authorized write by tenant A changed behaviour for every other tenant. A per-tenant encrypted row cannot express that bug; an env export always can.

**The deepest cause** is that a *security* control (`PERMISSION_FAIL_OPEN`) and *tenant* data (`SMTP_HOST`) shared one namespace with one writer. The fix separates those namespaces rather than filtering the writes.

---

## 2. Vulnerable files and routes

| Route | File | Gate before | Defect |
|---|---|---|---|
| `PUT /api/v1/integrations/config/:key` | `integrations-config.routes.js:149` | `verifyToken` | **Primary.** Arbitrary env write + no authz + no schema |
| `GET /api/v1/integrations/config/all` | same:72 | `verifyToken` | Reported another tenant's env-derived status as this tenant's |
| `GET /api/v1/integrations/config/:key` | same:120 | `verifyToken` | Credential-store reconnaissance for any user |
| `POST /api/v1/integrations/zoho-sign/refresh-token` | `zoho-sign.routes.js:233` | `verifyToken` | Wrote `process.env.ZOHO_SIGN_ACCESS_TOKEN` — one tenant's token became every tenant's fallback |
| `POST /api/v1/integrations/zoho-sign/test-connection` | same:119 | `verifyToken` | Accepted credentials in body from any user |
| `PUT /api/v1/integrations/tally/config` | `tally.routes.js:83` | `verifyToken` | Any user could repoint the tenant's outbound gateway; no URL validation |
| `POST /api/v1/settings/tally` | `settings-status.routes.js:171` | `verifyToken` | **Alias to the same `tally_config` row.** Found in the Phase-7 alternate-path sweep; gating only the other path would have left this open. |

**Consumers that read the poisoned environment:** `payment.routes.js` (×4, Razorpay), `email.routes.js` (×3), `whatsapp.routes.js`, `zoho-books.routes.js`, `zoho-sign.routes.js`, `tally.routes.js`.

---

## 3. Vulnerable execution flow

```
employee JWT
  → PUT /api/v1/integrations/config/smtp   { "PERMISSION_FAIL_OPEN": "true" }
  → verifyToken                            ✓ (valid token — that was the only check)
  → auditMutations('admin')                (logs; does not authorize)
  → handler: merged = {...prev, ...body}   (no allowlist)
  → INSERT company_integrations            (persisted at rest)
  → applyToEnv(key, merged)                → process.env.PERMISSION_FAIL_OPEN = 'true'
  → 200 { success: true }

any later request
  → requirePermission(<module with no row>)
  → reads process.env.PERMISSION_FAIL_OPEN → 'true'
  → next()                                 ← gate open, process-wide, no restart
```

---

## 4. Security impact

All of the following were **reproduced**, not inferred (§10).

- **Privilege escalation to the whole RBAC matrix.** `PERMISSION_FAIL_OPEN=true` opens every `requirePermission` gate whose module has no row. Measured: an `employee` went **403 → 200** on a fail-closed gate.
- **Account takeover path.** `NODE_ENV=development` makes `auth.service.js:242` return the password-reset OTP in the response body (`dev_otp`) for *any* email, including `super_admin`. It also disables `errorSanitizer` (stack traces to clients).
- **Credential compromise + destruction.** `derivedKey()` reads `ENCRYPTION_KEY` per call. Setting it makes all later credential writes decryptable by the attacker, while every existing row silently decrypts to `{}` — `decrypt()` swallows the failure, so the loss looks like "never configured".
- **Cross-tenant financial redirection.** `RAZORPAY_KEY_ID`/`_SECRET` in `process.env` are what all four payment handlers read. One tenant's keys became every tenant's checkout — customers paying into another company's account — and `/verify` then checked HMAC signatures with the wrong secret.
- **Outbound interception.** `SMTP_*`, `SENDGRID_API_KEY`, `WHATSAPP_TOKEN`, `TALLY_GATEWAY_URL` process-wide: mail and messages for all tenants routed through an attacker-chosen host.
- **Persistence.** Values survived in `company_integrations` and were re-applied on the next save.

**ASVS 5.0.0 mappings:** V1.2.2 (enforce authorization server-side), V1.4.x (least privilege), V4.1.x (input validation / mass assignment), V6.x (secret management), V8.3.x (sensitive config protection), V10.4.x (unsafe configuration mutation).

---

## 5. Proposed solution (as implemented)

Four controls, each independently sufficient against a different mistake:

1. **Explicit authorization at the router**, not at the mount. `requirePermission('admin','view')` guards the whole router (`router.use`, so it covers routes added later); `admin:edit` guards the write. Placed in the router deliberately: this repo already ships alias mounts (`server.js` "Frontend URL alias mounts"), and a gate at one mount does not travel.
2. **Tenant ownership from the session only.** Company comes from `companyOf(req)`. `company_id`/`companyId`/`company` in body or query is **rejected with 400**, not ignored — a silent drop reads as success.
3. **Allowlist, not denylist.** `INTEGRATION_FIELDS` in the new `integrationConfig.js` enumerates every field a request may name, per integration, each with a validator. Unknown field → 400. A denylist would have to enumerate every env var any dependency ever reads (`NODE_OPTIONS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `PATH`…) and would be wrong on the next feature flag.
4. **No environment mutation anywhere.** Credentials live in `company_integrations`, encrypted per tenant, and consumers resolve them with `resolveConfig(companyOf(req), key)`. `process.env` remains a **read-only fallback** so a single-tenant `.env` deployment is unaffected.

`FORBIDDEN_FIELD_NAMES` + `assertAllowlistIsSafe()` (runs at import) is a **tripwire on future edits of this file**, explicitly *not* the request-path gate — it throws at boot if someone later adds a field colliding with process-wide config.

### Configuration separation

| Category | Store | Who may change it | Examples |
|---|---|---|---|
| **A. Tenant integration settings** | `company_integrations` (AES-256-GCM per tenant) | `admin:edit` via the API | `SMTP_*`, `RAZORPAY_*`, `WHATSAPP_*`, `ZOHO_*`, `TALLY_*` |
| **B. Global application config** | `company_settings` / dedicated tables | out of scope here (§12) | module settings, SLA policies |
| **C. Server secrets** | `.env` / secret manager **only** | operators, via deploy | `JWT_SECRET`, `ENCRYPTION_KEY`, `DB_*`, webhook secrets |
| **D. Security infrastructure** | `.env` **only**, no API path at all | operators, via deploy | `PERMISSION_FAIL_OPEN`, `NODE_ENV`, `AUTH_RL_*` |

C and D are now unreachable from any tenant-facing API: they are simply absent from the allowlist.

---

## 6. Files modified

### Pass 1 — the PULSE-01 fix

**New (3):**
- `backend/src/modules/integrations/integrationConfig.js` — allowlist, validators, encryption, tenant-scoped resolver and store. The single source of truth.
- `backend/src/__tests__/integration.integrationsConfigSecurity.test.js` — 15 tests.
- `backend/src/database/migrations/20260926000014_pulse01_strip_unknown_integration_fields.js`.

**Changed (9):**
| File | Change |
|---|---|
| `integrations-config.routes.js` | Rewritten: authz, tenant ownership, schema validation, masked reads, audit events; `applyToEnv` **deleted**; generic 500s instead of `err.message` |
| `zoho-sign.routes.js` | `process.env.ZOHO_SIGN_ACCESS_TOKEN =` **deleted**; `admin:edit` on `/refresh-token` and `/test-connection`; duplicate crypto removed |
| `tally.routes.js` | `admin:edit` on `PUT /config`, `settings:view` on `GET /config`; URL validation; hub config merged per tenant |
| `settings-status.routes.js` | The same two gates and the same validator on the `/settings/tally` **alias** |
| `payment.routes.js` | Razorpay keys per tenant (4 sites), including the `/verify` HMAC secret |
| `email.routes.js`, `zoho-books.routes.js`, `whatsapp.routes.js` | Status and send paths resolve per tenant |
| `amcRenewal.cron.js` | Passes `contract.company_id` so the owning tenant sends from its own account |

### Pass 2 — closing the residual risks

**New (3):**
- `backend/eslint.config.js` — backend static analysis; errors only for defects with no valid intent (§12a).
- `backend/src/__tests__/integration.pulse01Followups.test.js` — 23 tests over the nine residual risks.
- `backend/src/__tests__/asyncContract.contract.test.js` — 7 tests; guards the specific class of bug Pass 2 created, that ESLint cannot see.
- `tests/suites/30-integrations-authz.spec.ts` — 5 Playwright tests, registered as its own project.

**Changed (16):**
| File | Change |
|---|---|
| `settings-status.routes.js` | `settingsGate(action)` on `GET`/`POST /:module` — per-module, matrix-driven, fails closed on an unknown key. `/settings/integrations` no longer touches `company_settings`: it translates the wizard payload into the encrypted store and reads it back masked, refusing `aws_s3` **out loud** |
| `webhooks.routes.js` | `verifyWebhook()` — fails closed on a missing signature, and in production on a missing secret. `timingSafeEqual`. Per-tenant secret resolved from the referenced row |
| `mailer.js` | `createTransport(companyId)` + optional `companyId` on all 8 senders; `isEmailConfigured` is now async. `sendPasswordResetOTP` deliberately has none |
| `emailTrigger.js` | Uses the `companyId` it was already given |
| `journeyEngine.js` | Per-tenant SMTP from `enrollment.company_id`; **transport cache keyed by company** instead of one module singleton; `resetTransportCache()` |
| `publicSign.routes.js` | Razorpay per tenant via `signing.company_id`, including the verify secret |
| `notifications.repository.js` | Resolves the tenant from the **recipient's** users row |
| `payroll.controller.js`, `interviewReminder.cron.js`, `iot/notify.js`, `iot/routes/service.routes.js` | `await` the now-async `isEmailConfigured` / `channelAvailability`, passing their tenant |
| `integrationConfig.js` | `CredentialDecryptError`, `decryptStrict`, `ENCRYPTION_KEY` floor and production guard, allowlist-filtered reads, optional `executor` |
| `auditMutations.js` | Redaction pattern widened to a bare `key` — it was letting `ENCRYPTION_KEY` and friends through in plaintext |
| `server.js` | Boot fails on an `ENCRYPTION_KEY` under 32 characters in production |
| `gst.routes.js`, `tds.routes.js`, `projects.routes.js`, `servicedesk.routes.js`, `leaves.routes.js` | The 11 live bugs the linter found (§12a) — 6 missing identifiers, 5 `Number(x) ?? y` NaN writes |
| `integration.procurementReverification.test.js` | The D15 global-count flake, scoped and polled |
| `iot.gapclosure.test.js` | `await channelAvailability()` — its contract genuinely changed |
| `package.json` / `package-lock.json` | `eslint` + `@eslint/js` + `globals` devDeps, `lint` / `lint:errors` scripts, `nodemailer` 8 → 10, `qs` advisory fix |
| `playwright.config.ts` | Registers the `integrations-authz` project |

**Not changed, deliberately** — see §12: `WHATSAPP_VERIFY_TOKEN` (unauthenticated handshake), `sendPasswordResetOTP` (account recovery must not ride tenant mail), `payment.routes.js`'s `getCompanyId()` tenant predicates (money queries, own change), `xlsx` (write-only, advisory unreachable).

---

## 7. Database changes

No schema change. One **data** migration, `20260926000014`: decrypts each `company_integrations` row, keeps only allowlisted fields, re-encrypts; deletes rows left empty and rows whose `integration_key` is not a real integration.

- **Applied locally:** `scanned:5, unknownKeyRowsDeleted:5, rowsStripped:0, rowsEmptied:0, undecryptable:0` (the 5 were junk seed rows with random-hex keys).
- **Strip path verified separately** with a planted row: `PERMISSION_FAIL_OPEN`/`NODE_ENV`/`ENCRYPTION_KEY`/`BOGUS_FIELD` removed, `SMTP_PASS='keep-me'` preserved, junk-only row deleted.
- **Safety:** `decrypt()` returns `null` (not `{}`) on failure, so a wrong `ENCRYPTION_KEY` leaves rows **untouched** and logs a warning rather than deleting every credential.
- **Bind style is `$1`** — the runner is a pg shim (`src/config/migrations.js:25`), not knex; `?` binds nothing.
- `down()` is a deliberate no-op (§14).

---

## 8. Configuration changes

**None required.** No new environment variable; nothing must be set for the fix to take effect.

Behaviour clarification for operators: saving credentials in the UI no longer alters `process.env`, so it no longer affects the **process-level** senders (`mailer.js`, `emailTrigger.js`, `journeyEngine.js`). Those remain deploy-level (`.env`) — which is the correct posture (a tenant must not control platform mail) but **is a behaviour change** versus the vulnerable code. Deployments that relied on the UI to configure platform SMTP must set `SMTP_*` in `.env`.

---

## 9. Security tests created

`backend/src/__tests__/integration.integrationsConfigSecurity.test.js` — real router, real middleware chain, real DB, **real role rows from the permission matrix** (nothing about authz stubbed).

| # | Test | Asserts |
|---|---|---|
| 1 | Employee updates config | 403 **and** no row written |
| 2 | No-permission user: write **and** read | 403 on `PUT`, `/all`, `/:key`; no row |
| 3 | **Authorized admin updates config** | 200, values stored (paired positive) |
| 4 | Company B → company A | B confined to B; `company_id`/`companyId`/query override all 400; each tenant resolves its **own** host |
| 5 | Arbitrary env vars | 403 (employee) **and** 400 `UNKNOWN_FIELD` (admin); **whole-environment snapshot unchanged**; escalation probe still 403 |
| 6 | Security-sensitive global config | every `FORBIDDEN_FIELD_NAMES` entry × every integration → 400; env unchanged; allowlist/tripwire disjointness |
| 7 | Unexpected fields | made-up field, cross-integration field, unknown key → 400/404; rejection is atomic |
| 8 | Invalid values | 12 cases (port range, enum, email, `http://` in host field, `user:pass@`, `file://`, object/array coercion) |
| 9 | Credential exposure | canary absent from `PUT`/`GET`/`/all` responses **and** from `audit_logs`; secret masked `***`, non-secret readable; field **names** recorded |
| 10 | **Legitimate ops preserved** | `***` round-trip preserves the stored secret; `resolveConfig()` returns it; per-tenant status correct (paired positive) |
| + | Tally **alias** paths | both write paths 403 for employee, same validator, both 200 for admin, **and `finance_manager` can still read** |
| + | Denials recorded | `access_denials` rows with status 403 and `PERMISSION_DENIED` |
| + | Unauthenticated / malformed token | 401; env unchanged |
| + | **Source guard** | no dynamic `process.env[...] =` anywhere in `src/` outside tests |
| + | **Consumer guard** | no integration consumer reads a credential from env, except the documented `WHATSAPP_VERIFY_TOKEN` |

The last two are source-level on purpose: the behavioural tests can only cover paths they know about, and the next `applyToEnv` will be in a different file.

### Pass 2 suites

`integration.pulse01Followups.test.js` — 23 tests over the nine residual risks: the per-module settings gate (employee denied on 7 modules and 3 reads; unknown module fails closed; the owning role still works); `/settings/integrations` writing to the encrypted store and never to `company_settings`; `aws_s3` refused **and reported**; webhook verification refusing a missing signature, a wrong signature, and an unsigned call in production, with a signed call still accepted; `ENCRYPTION_KEY` strength and rotation detection; and source guards that no consumer reads a credential from the environment.

`asyncContract.contract.test.js` — 7 tests. Three predicates became async in Pass 2, and **an un-awaited Promise is truthy**, so `if (isEmailConfigured())` does not fail after that change — it silently becomes always-true. ESLint cannot catch it (`require-await` checks the declaration; `no-floating-promises` needs type information). This walks the source instead, and it includes a check on itself: every function it guards must still be an exported async function in the file it names, so the guard cannot quietly match nothing. **Verified by deliberately removing an `await` and confirming it failed with the file and line.**

`tests/suites/30-integrations-authz.spec.ts` — 5 Playwright tests. The one that matters is the **round trip**: the API tests prove the GET masks and the PUT validates, but only the real page proves that what the GET hands the form is something the PUT will accept. It also pins that the mask stays **truthy**, because `SetupWizard` derives `configured` from `!!(data.razorpay?.key_id)` and a mask of `''` would make the wizard forget every saved provider.

---

## 10. Test execution results

**Reproduction — before the fix** (`repro.mjs`, `repro-escalation.mjs`, real router + real chain):

| Step | Result |
|---|---|
| Employee `PUT /config/smtp` | **200**, row persisted, `process.env.SMTP_HOST='attacker.example.com'` |
| Employee sets 4 infra vars | **200**; `PERMISSION_FAIL_OPEN: undefined → 'true'`, `NODE_ENV → 'development'`, `ENCRYPTION_KEY`/`JWT_SECRET` overwritten |
| Unknown field injection | **200**, `TOTALLY_MADE_UP_FIELD` in env |
| Company B reads status | **"Connected"** off company A's env write, with no row of its own |
| Invalid `SMTP_PORT='not-a-port'` | **200** |
| **Escalation chain** | employee → `/probe` **403** → one `PUT` → `/probe` **200** `{"secret":"PRIVILEGED DATA"}` |

**Verification — after the fix,** same reproducers unmodified:

| Step | Result |
|---|---|
| Every write/read above | **403**, no row, no env change |
| `PERMISSION_FAIL_OPEN` | remained `undefined` |
| Company B status | **"Not Configured"** |
| **Escalation chain** | 403 → 403 → **403** (`escalation NOT reproduced`) |

**Suites:**

| Suite | Result |
|---|---|
| PULSE-01 security suite (`integration.integrationsConfigSecurity`) | **15/15 PASSED** |
| Same suite vs. the vulnerable code | **12 of 14 FAILED** (the 2 passing are the paired positive and the 401 case) — proves it can fail |
| Alias sub-test vs. ungated code | **FAILED** (`PUT /api/integrations/tally/config was not gated: expected 200 to be 403`) |
| Pass 2 follow-up suite (`integration.pulse01Followups`) | **26/26 PASSED** (23 for the residual risks + 3 for defects found reviewing my own diff) |
| Same suite vs. the un-followed-up code | **13 of 23 FAILED** — proves it can fail |
| Async contract guard (`asyncContract.contract`) | **7/7 PASSED**, and **proven to catch a deliberately removed `await`** by file:line |
| Backend full suite | **89 files, 1960 PASSED, 9 SKIPPED, 0 FAILED** |
| Backend full suite, repeated | **3 consecutive clean runs** at the final state; across the whole pass, clean in 7 of 9 runs, and both failures were `supplyChain > MRP` alone (§12.7) |
| Backend source-parse contract | **4/4 PASSED** (all ~1026 backend files parse) |
| Backend lint (new) | **`lint:errors` → 0 errors.** `lint` → 248 warnings (§12.8). First run found **11 live bugs** (§12a) |
| Migration | **APPLIED** (`scanned:5, unknownKeyRowsDeleted:5`), plus a separate strip-path verification with a planted row |
| Frontend suite | **523 passed, 2 FAILED** — `smoke.leaves.test.jsx` (ApplyLeave). **Pre-existing**: fails identically with my changes stashed |
| Frontend lint | 0 errors, 1 pre-existing warning in a file I did not touch |
| **Playwright — PULSE-01 browser project** | **5/5 PASSED** (`30-integrations-authz.spec.ts`) |
| Playwright — existing `smoke` + `navigation` | **282 passed, 1 FAILED** (34.9 min). The failure is `@P1 HR submenu opens on hover and shows expected items`, which asserts an **`Offboarding`** button in the HR submenu. **Pre-existing and attributable**: uncommitted work in `frontend/src/config/routes.jsx` moved that item into a hub (`inHub: 'ExitCenter'`) and the spec was not updated. I changed no frontend file |
| **Dependency audit** | run; 5 findings → **1 remaining**, assessed unreachable (§12.2) |

**LIVE verification against a running server** — the item Pass 1 left outstanding. A backend was already listening on :5000 with `uptime_s: 34896` (≈9.7 h), i.e. pre-fix code. Probing it, then restarting onto the fixed code and probing again, gives a true before/after:

| Request (as an ordinary `employee`) | Pre-fix server | Post-restart |
|---|---|---|
| `GET /api/v1/integrations/config/all` | **200** | **403** |
| `GET /api/v1/integrations/config/smtp` | — | **403** |
| `GET /api/v1/settings/finance` | **200** | **403** |
| `GET /api/v1/settings/integrations` | — | **403** |
| `GET /api/v1/settings/tally` | — | **403** |
| `PUT /config/smtp {PERMISSION_FAIL_OPEN:"true"}` | — | **403**, and a re-probe still 403 → the kill switch did not flip |

And as an authorized `admin` on the same running server: all five reads **200**; a valid save **200**; the read-back masked (`SMTP_PASS: "***"`, non-secrets readable); `SMTP_PORT: "not-a-port"` → **400 INVALID_VALUE**; `PERMISSION_FAIL_OPEN` → **400 UNKNOWN_FIELD**. The live `audit_logs` row for the successful save recorded `changed_fields: [SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE]` — **names only, no values** — the rejection recorded `unknown_fields: ["PERMISSION_FAIL_OPEN"]` as a `security_denied` event, and all six employee 403s landed in `access_denials` with `PERMISSION_DENIED`. Every row written by this probing was removed afterwards; company 1 is back to 0 integration rows.

**Dependency audit detail:**

| Package | Finding | Action |
|---|---|---|
| `qs` (transitive, express) | array-limit bypass + DoS | **FIXED** by `npm audit fix` (non-breaking) |
| `nodemailer` 8.0.11 | **Recipient-domain validation bypass via RFC 5322 comment mis-parsing → delivery to an attacker-controlled domain**, plus quadratic addressparser DoS | **FIXED** — upgraded to 10.0.10. Directly relevant: this is the library that sends payslips, invoices, offer letters and reset OTPs. API surface verified first (`createTransport`/`sendMail`/`verify` only; no deep imports), Node 24 satisfies `>=20`, full suite green after |
| `xlsx` 0.18.5 | prototype pollution + ReDoS, **no npm fix** | **Assessed unreachable** — write-only usage, no `XLSX.read` (§12.2) |

**SKIPPED (9):** all `phase1.test.js > Migration smoke tests`, pre-existing `test.skipIf(SKIP_DB)` in a file I did not touch.

**Flakes, reported in full.** Before Pass 2, two suites flaked intermittently: `procurementReverification > D15` and `supplyChain > MRP`. Neither touches integrations, and D15 failed **3 of 4 runs with my changes removed** — i.e. more often without the fix than with it. D15 is now **fixed** (§12a); `supplyChain > MRP` remains and is diagnosed in §12.7. ⚠ One measurement of mine was wrong and is worth recording: a removal-baseline also showed `unit.deadTableGuard` failing 4/4, which I briefly attributed to my change. It was my method — `whatsapp.routes.js` carries *pre-existing uncommitted* work fixing a dead-table write, and `git stash` swept it up with mine. **Do not trust a stash-based baseline on a dirty tree.**


---

## 11. Before and after

| Behaviour | Before | After |
|---|---|---|
| Employee updates integration credentials | 200, persisted | **403**, nothing written |
| Employee sets `PERMISSION_FAIL_OPEN` | 200, **RBAC matrix opens process-wide** | **403**, env untouched |
| Admin sets `PERMISSION_FAIL_OPEN` | 200, same | **400 `UNKNOWN_FIELD`**, env untouched |
| Unknown field | persisted **and** exported to env | **400**, listing the rejected names |
| `SMTP_PORT='not-a-port'` | accepted | **400 `INVALID_VALUE`** |
| `SMTP_HOST='http://evil/x'` | accepted | **400** |
| Tenant A's SMTP host | process-global, hit every tenant | **A's row only**; B resolves B's |
| Tenant with no config | "Connected" off a neighbour's env write | **"Not Configured"** |
| Razorpay keys | process-global (cross-tenant payment redirection) | **per tenant**, incl. the `/verify` HMAC secret |
| Zoho Sign token refresh | any user; wrote process-wide env | **`admin:edit`**; per-tenant row only |
| Tally gateway URL | any user, 2 ungated paths, no validation | **`admin:edit` on both**, same validator |
| Secrets in GET | masked `***` (this part was already right) | masked, **and** allowlist-filtered |
| Secrets in audit log | redacted by regex | redacted **and** only field **names** recorded |
| Config-change audit detail | generic "update" | explicit entry naming the **changed fields** |
| Denied attempts | (401/403 → `access_denials`, app-wide) | same, **now asserted by test** |
| 500 responses | `err.message` (DB internals) | generic message; detail server-side only |
| Authorized admin saves config | works | **works** (Tests 3, 10, alias positive) |

---

## 12a. Pass 2 — the residual risks, and what closing them uncovered

Pass 1 listed nine things it had NOT fixed. All nine are now addressed. Closing them surfaced six further defects, none of which any test covered.

### The nine residual risks, now closed

| # | Risk (Pass 1 wording) | How it was closed |
|---|---|---|
| 1 | `POST /settings/:module` is an ungated generic arbitrary-JSON writer | Gated per module **by the matrix itself**: `settingsGate(action)` maps the settings key to its permission module and calls `requirePermission`. An unknown key maps to a module with no rows and therefore **fails closed automatically** — the gate cannot drift out of date as modules are added. Reads are gated too; every frontend caller already `.catch()`es to a default, which was verified before gating rather than assumed. |
| 2 | `publicSign.routes.js` reads `process.env.RAZORPAY_*` on a public route | Now `resolveConfig(signing.company_id, 'razorpay')`. The route is public (token-based, no session), but `document_signings.company_id` names the tenant whose account must be paid — including for the `/verify` HMAC secret. |
| 3 | `mailer` / `emailTrigger` / `journeyEngine` are deployment-only | All three resolve per tenant. `mailer` takes an optional `companyId` on all eight senders (omitted reproduces the previous behaviour exactly, so its eleven callers are unaffected); `emailTrigger` already had `companyId` as a parameter; `journeyEngine` uses `enrollment.company_id`. Notification email resolves the tenant from the **recipient's** users row, which is the correct authority. |
| 4 | Webhook secrets are env-only | Per-tenant with env fallback, resolved from the referenced row — **and two fail-open bugs fixed, below.** |
| 5 | `ENCRYPTION_KEY` has an insecure default and no strength floor | `derivedKey()` throws in production when unset or shorter than 32 characters, and warns loudly in development. Guarded at the point of use as well as at boot, because a cron, migration or seed importing the module never runs `server.js`'s check. Boot now also fails on a short key, matching `JWT_SECRET`. |
| 6 | A key rotation makes every credential read as "not configured" | `decryptStrict()` throws a typed `CredentialDecryptError` on an AES-GCM tag mismatch and `readStored` propagates it. An **absent** ciphertext is still `{}` — that distinction is the whole point. Consumers degrade to the deployment environment with a loud, de-duplicated `credential_decrypt_failed` log; administration routes surface it as a 500, where someone can act on it. |
| 7 | The backend has no lint or type check | `backend/eslint.config.js` plus `npm run lint` / `npm run lint:errors`. Errors only where a finding is a defect with no valid intent; everything stylistic is a warning, so a red line means something. **Currently 0 errors, 248 warnings.** |
| 8 | `getCompanyId()` in `payment.routes.js` fails open on a null scope | **Still open, deliberately** — see §12. |
| 9 | Not verified in a browser or against a running release | Both done: a live before/after against a restarted server, and a five-test Playwright project (§10). |

### Six further defects found while closing them

| Defect | Severity | Found by |
|---|---|---|
| **`/settings/integrations` was a PLAINTEXT credential sink.** `SetupWizard.jsx` collects `razorpay.key_secret`, `whatsapp.api_key`, `sendgrid.api_key`, `zoho_sign.client_secret` and `aws_s3.secret_key`, and POSTed them into `company_settings.settings` — a plain **JSONB** column with no encryption — while the GET returned them **unmasked** to any authenticated user. That is a worse disclosure than the endpoint PULSE-01 was raised against, which at least masked. Now translated into the encrypted per-tenant store through the same allowlist and validators, and read back masked. | **Critical** | Tracing risk 1 |
| **`/webhooks/zoho-sign` verification FAILED OPEN on a missing header.** The check was `if (secret) { if (incomingSig) { … } }`, so omitting the signature skipped verification entirely — anyone could POST a forged `REQUEST_COMPLETED` and mark any document signed, **with a secret correctly configured**. | **Critical** | Tracing risk 4 |
| **Both webhooks trusted unsigned payloads when no secret was configured at all.** A deployment without `RAZORPAY_WEBHOOK_SECRET` accepted any forged `payment.captured` and marked invoices paid — unauthenticated financial fraud, reachable by anyone who knows the URL. Now rejected in production; development warns loudly instead of silently trusting. | **Critical** | Tracing risk 4 |
| **Six identifiers CALLED but never imported**, each a guaranteed `ReferenceError` 500: `gst.routes.js` (`buildIrpPayload`, `buildEwbPayload`, `irpConfigured`, `submitToIrp` — every e-invoice and e-way-bill endpoint), `tds.routes.js` (`total_tds`, Form 16A generation), `projects.routes.js` and `servicedesk.routes.js` (`deriveResponseFields`). | High | `npm run lint` (`no-undef`), first run |
| **Five `Number(x) ?? fallback` expressions that never fall through.** `Number(undefined)` is `NaN`, which is not nullish, so omitting the field wrote **NaN** to a numeric column instead of preserving the stored value: four leave-type fields and `service_contracts.value`, a money column. The line immediately below them already used the correct `!= null ?` idiom. | High | `npm run lint` (`no-constant-binary-expression`) |
| **The audit redaction list missed every key-shaped name.** It spelled out `apikey\|api_key\|private_key`, so `ENCRYPTION_KEY`, `RAZORPAY_KEY_ID`, `AWS_SES_ACCESS_KEY_ID`, `accessKey` and `privateKey` were written to `audit_logs` in **plaintext** — proven by a controlled reproduction that left `{"ENCRYPTION_KEY": "attacker_known_key"}` in the table. Enumerating separators fixed the snake_case names and still missed every camelCase one, so the enumeration itself was the bug; it is now a bare `key`, accepting over-redaction of `keyword` and `key_metrics` as the safe direction. | High | Compromise assessment (§15) |

### Two corrections to my own Pass 2 work, both caught by existing tests

- **`journeyEngine`'s transport cache was itself a cross-tenant channel.** `let _transport = null` meant the first tenant to send pinned its own mail server for every later tenant in the process — a cache keyed by nothing. Keyed by company now, with `resetTransportCache()`.
- **`resolveConfig` broke a caller's dependency-injection contract.** It reached for the module-level pool, so `journeyEngine`'s unit tests — which inject a fake pool on purpose — began opening a real connection and failed on database authentication instead of their assertion. It now takes an optional `executor`, the convention `eInvoice.service.js` already used. **The test was right and my change was wrong.**

### Two defects found reviewing my own Pass 2 diff

Neither was caught by a test, because both were in code the tests exercised only in one direction.

- **An https Tally gateway silently downgraded to http on re-save.** `sendWizardIntegrations` decomposed a stored URL into `{host, port}` for the wizard's field shape, returning a bare hostname and a **synthesised** port (`443` for https). The wizard posts that straight back, and the composer saw a scheme-less host and rebuilt `http://gw.test:443`. So an operator who configured TLS lost it on the next ordinary save, permanently and silently. Found by round-tripping the decompose/compose pair by hand. Both halves now preserve the scheme, and the port is only offered when the stored URL carried one. Pinned by a test **proven to fail against the old code** (`expected 'http://tally.secure.test:443' to be 'https://tally.secure.test'`).
- **The `host` validator refused IPv6 literals.** `::1` and `[2001:db8::1]` are legitimate mail hosts, and the hostname pattern could not express them because of the colons — a functional regression wearing a security control's clothes. Now accepted bare or bracketed, with a paired negative proving a colon does not make `evil.test:25` valid.

The lesson worth keeping: **a validator and a formatter that must agree have to be tested as a round trip, not separately.** Each half passed its own test.

---

### Also fixed: a flaky test that made the evidence untrustworthy

`procurementReverification > D15` read a **global, unfiltered** `SELECT COUNT(*) FROM notifications` before and after an approval and asserted the count had risen. Any concurrent suite sweeping its own rows made it fail, naming a procurement bug that did not exist — 3 of 4 measured runs **before** any of my changes. It is now scoped to the PO's own `reference_id`, and polls instead of sleeping a fixed 1500 ms. ⚠ `notifications.module_name` on that path is `'Purchase Order'` — Capitalised and spaced, not the lowercase module key. `logAudit` normalises module names; notifications never did.

---

## 12b. Pass 3 — reviewing my own diff against the three challenge questions

§15 asked a reviewer to challenge three decisions. I cannot be independent about my own work, so I argued each one down as hard as I could. **One did not survive**, and pushing on the other two surfaced a hole in the PULSE-01 gate itself.

### Decision 1 — `admin:edit` rather than `settings:edit`: SURVIVES, with a caveat

The case against: the IntegrationsHub page sits under the **Settings** nav group, and `settings:view` is held by `finance_manager` and `hr_manager` as well as admin. Gating the API on `admin` while the page is grouped under `settings` is a mismatch, and it *removes* a capability those roles had before the fix (when everyone had it).

Why it survives: `IntegrationsHub` has **no `module` key in `routes.jsx` at all**, so there is no frontend permission gate on that page whatsoever — the API gate is the only real control, which argues for the tighter bar, not the looser one. Both `admin:edit` and `settings:edit` grant to exactly admin and super_admin today, so the choice only matters later: if someone widens `settings:edit` (plausible — it is called "settings"), integration credentials should **not** follow, and with this choice they do not.

⚠ The caveat is real and belongs in the deployment notes: **this is a deliberate reduction in who can manage integrations.** If `finance_manager` was using the page for Tally or Razorpay, they now cannot. The recovery is a matrix grant, not a code change, and §13 step 7 already tells the operator to watch `access_denials` for exactly this signal.

### Decision 2 — rejecting unknown fields rather than ignoring them: SURVIVES

The case against: a newer frontend posting a field an older backend does not know gets a hard 400 and the **whole save fails**, where ignoring would degrade gracefully.

Why it survives: no current client sends anything outside the allowlist — `IntegrationsHub` keys its inputs from the same field list, and `SetupWizard`'s only extra (`configured`) is skipped explicitly. Legacy rows are handled by filtering reads, not by loosening writes. And the failure modes are asymmetric: a rejected save is visible and names the offending fields, whereas silently dropping a **credential** field reports success while the credential is not stored — which is how an administrator comes to believe an integration is configured when it is not.

### Decision 3 — degrading to the environment on a decrypt failure: **DID NOT SURVIVE, for money**

This one was wrong, and the reasoning that broke it is worth keeping.

Degrading is right for mail: a rotated `ENCRYPTION_KEY` should not take every payslip and offer letter down with it, and the worst case is a message sent from the platform's mail server instead of the tenant's.

For **Razorpay** it is not. On a multi-tenant deployment the env fallback holds the **platform's** keys, so degrading would take a tenant's customer payment into the platform's Razorpay account — and `/verify` would then compute the HMAC with that same platform secret, so **the signature verifies and the invoice is marked paid.** The money is in the wrong account and nothing looks wrong. A rotated encryption key would quietly redirect revenue.

Fixed by declaring the property on the integration rather than leaving it to each caller, since a caller can forget:

```js
export const FAIL_CLOSED_ON_DECRYPT = Object.freeze(new Set(['razorpay']));
```

For those keys a decrypt failure yields `{}` — no stored values, no env fallback — and every payment handler's existing `if (!keyId || !keySecret)` guard turns that into a refusal (503 `payment_gateway_not_configured` in production). Refusing a payment is recoverable; taking it into the wrong account is not.

⚠ That fix depended on a guard that **one of the four handlers did not have.** `POST /payments/create-link` returned a **fake payment link** (`https://rzp.io/l/sim_…`) with `success: true` and recorded it as sent, with no production check — so in production a customer would be invoiced a URL that does not exist while the system believed it had chased them. Pre-existing, but "fail closed" routed straight through it, so it is fixed here to match its three siblings.

### And a hole in the PULSE-01 gate itself

Pushing on decision 1 turned up something worse than the decision. `IntegrationsHub.jsx` **catches a 403 from `/integrations/config/all` and falls back** to seven per-provider status endpoints — and all seven were **ungated**:

```
/integrations/sendgrid/status   /integrations/aws-ses/status   /integrations/smtp/status
/integrations/whatsapp/status   /integrations/zoho-books/status
/integrations/zoho-sign/status  /integrations/tally/sync-status
```

So an ordinary employee could still enumerate which providers a tenant uses, and read the **SMTP host and port** and the **SendGrid account email**. Gating the credential endpoints while leaving these open made the gate cosmetic for exactly the reconnaissance §2 listed as a defect on `/config/:key`. All seven are now `settings:view` — the bar that admits the roles which legitimately reach those pages and excludes ordinary employees — pinned by a test **proven to fail against the ungated code**.

**The lesson worth keeping: gating an endpoint is not finished until you check what the UI does when it gets the 403.** A client-side fallback is an alternate path, and the alternate-path sweep in Pass 1 looked at server mounts, not at the caller.

### Two more of my own defects, from the same review

- **An https Tally gateway silently downgraded to http on re-save** — see §12a; found by round-tripping the decompose/compose pair by hand. **A validator and a formatter that must agree have to be tested as a round trip**, not separately. Each half passed its own test.
- **The `host` validator refused IPv6 literals** (`::1`, `[2001:db8::1]`) because the hostname pattern cannot express colons — a functional regression wearing a security control's clothes. Found by attacking my own validators with 35 adversarial inputs; the other 33 held (prototype pollution rejected with `Object.prototype` clean, CRLF injection, null bytes, unicode homoglyph dots, `file://` and `javascript:` schemes, embedded credentials, port bounds, length bounds, the `***` sentinel).

### One of my own tests was flaky, and one sweep was wrong

- My new status-endpoint test flaked on its first full run. Three of those handlers make an **outbound call** — `/tally/sync-status` dials the gateway with a 3 s timeout — so asserting exactly `200` coupled an authorization test to whether a third party is reachable. It now asserts **not 403 / not 401**, which is the property under test, with an explicit 45 s timeout.
- Both new suites' sweeps failed `DELETE FROM companies` on `interview_questions_company_id_fkey` **in a full run only**, because `talent.routes.js` seeds ten rows into **every** company at import time — so another suite importing that router plants them in these test companies without this suite touching recruitment. It reads as "the suite is broken" rather than "the sweep needs one more table". Both sweeps now delete it, matching `integration.crmCustomerIntegrity.test.js`.

---

## 12. Remaining risks

The nine risks Pass 1 recorded are closed (§12a). These are what is left, each with the concrete fix and the reason it was not taken here.

1. **`getCompanyId()` in `payment.routes.js:9`** uses `req.scope?.company_id ?? null` rather than `companyOf(req)`, feeding `($2::int IS NULL OR company_id = $2)` predicates that fail **OPEN** across tenants on a null scope. **Left alone deliberately**: changing tenant filtering on money queries belongs in its own change with its own tests, not bundled into a security fix for a different defect. Credential resolution on those handlers does use `companyOf`. **Recommend a ticket.**

2. **`xlsx@0.18.5` carries two unfixed high advisories** — prototype pollution (GHSA-4r6h-8v6p-xvw6) and ReDoS (GHSA-5pgg-2g8v-p4x9), with **no fix available on npm**. Assessed as **not currently reachable**: both are triggered by *parsing* a workbook, and this codebase only ever writes them — `XLSX.utils.json_to_sheet` / `book_new` / `book_append_sheet` / `XLSX.write`, with **no `XLSX.read` anywhere** (verified by grep across `src/`). It becomes live the moment anyone adds a spreadsheet *import*. **Recommend:** migrate to the maintained SheetJS distribution (the npm `xlsx` package is the abandoned one), and gate any future import behind that migration.

3. **Per-tenant webhook secrets are wired but not yet offerable.** `webhooks.routes.js` resolves `RAZORPAY_WEBHOOK_SECRET` / `ZOHO_SIGN_WEBHOOK_SECRET` through `resolveConfig(<tenant>, …)` and falls back to the deployment environment. `RAZORPAY_WEBHOOK_SECRET` **is** in the allowlist, so a tenant can set it today; `ZOHO_SIGN_WEBHOOK_SECRET` is **not**, so that one still resolves to the deployment value only. Adding it is a one-line change to `INTEGRATION_FIELDS` plus a field in `IntegrationsHub.jsx` — deferred only because no Zoho Sign webhook is configured to test against.

4. **`WHATSAPP_VERIFY_TOKEN` stays deployment-level, correctly.** Meta calls that endpoint unauthenticated during the webhook handshake, so there is no tenant to resolve against and the webhook URL is one per deployment. Documented in the code and asserted by the consumer-guard test so it cannot drift into an accidental exception.

5. **`sendPasswordResetOTP` stays deployment-level, correctly, and this is load-bearing.** It is the one sender with no `companyId` parameter. Routing account recovery over mail infrastructure a tenant administrator controls would hand them the recovery channel for their own users. Asserted by a test that strips comments before matching, so the reason cannot be mistaken for the rule.

6. **`ENCRYPTION_KEY` has no rotation procedure.** Rotation is now *detected* (`CredentialDecryptError`, a loud log, a 500 on the administration routes) rather than silent, which was the actual defect. But there is still no re-encryption routine, so rotating the key means every tenant re-enters its credentials. **Recommend:** a `scripts/rotate-encryption-key.mjs` that decrypts with the old key and re-encrypts with the new one inside one transaction.

7. **`integration.supplyChain > MRP` flakes on shared fixture state.** It runs the real MRP engine over the **shared demo company 1** and asserts a planned order with `safety_stock > 0` exists. The engine emits one only when `net = gross + safety_stock - available > 0` (`mrpEngine.service.js:401`), so any concurrent suite posting stock to company 1's items empties the filter. Observed twice in ~15 full runs, **and it is not caused by this change** — the mechanism is a shared fixture, not a code path I touched. **Not fixed here on purpose:** the correct fix is a dedicated synthetic tenant with deterministic data, which is a fixture redesign across a 46-test suite and does not belong in a security branch. **Recommend a ticket.**

8. **248 lint warnings are unaddressed.** The config deliberately starts with errors-only gating so that switching a linter on over ~1,000 files does not produce a red build that gets ignored. The warnings are mostly `no-unused-vars` (131) and `require-await` (94). **Recommend** burning them down module by module rather than in one sweep.

9. **The test database accumulates and progressively slows the suite.** Wall-clock for a full run went from ~24 s early in this work to ~130 s, and the cause is test-data accumulation rather than any code change: `audit_logs` is at **57,169 rows**, `notifications` **24,893**, `access_denials` **9,494**, database 237 MB, after roughly twenty full runs that each write audit rows for every mutation. It matters because the added contention is what surfaced the latent flakes above — failures scattered across `supplyChain`, `recruitmentRegression` and `analytics.schemaGuards`, never the same test twice, none reproducible in isolation. **Recommend** a dev-only maintenance step that truncates test-generated `audit_logs` / `access_denials` / `notifications`. Not done here: those are rows in someone's development database and deleting them in bulk is not mine to decide.

10. **The `company_id = 0` global bucket remains reachable.** `companyOf(req)` returns `null` for a super admin with no company assignment, and `rowCompanyId()` maps that to the reserved id `0`. That is the column's own `DEFAULT 0` and matches the pre-existing behaviour, but it means a global admin's writes land in a bucket no tenant reads. Harmless today (no such rows exist) and out of scope to redesign; noted so nobody rediscovers it as a bug.

**Explicitly NOT claimed:** that the application is free of other vulnerabilities, compliant with ASVS 5.0.0 as a whole, or production-ready. Two of the items above are open authorization or supply-chain findings.

---

## 13. Deployment instructions

1. Deploy code and run `npm run migrate` (backend). The migration is idempotent and safe to re-run.
2. **Confirm `ENCRYPTION_KEY` matches the value existing rows were written under** before migrating. If it does not, the migration reports `undecryptable > 0` and leaves those rows unchanged — fix the key and re-run rather than proceeding.
3. Capture `SELECT count(*) FROM company_integrations;` beforehand and check it against the migration's logged counts.
4. If the deployment relied on the Integrations UI to configure **platform** SMTP, set `SMTP_*` in `.env` (§8).
5. Smoke-test as `admin`: open Integrations, save one integration, reopen it (secrets show `***`, non-secrets readable), confirm status flips to Connected.
6. Smoke-test as a non-admin: the config endpoints must return 403.
7. Watch `access_denials` for `path LIKE '%/integrations/config%'` — a burst means a legitimate role is missing `admin:view`; seed the row, **do not** set `PERMISSION_FAIL_OPEN`.
8. **Grep production logs, `audit_logs` and `company_integrations` for evidence of prior exploitation** before declaring this closed — the vulnerability was live and persisted values at rest. The query that matters: `SELECT * FROM audit_logs WHERE new_data_json::text ~ '(PERMISSION_FAIL_OPEN|NODE_ENV|ENCRYPTION_KEY|JWT_SECRET)'`. ⚠ Note that before Pass 2 the audit redaction wrote `ENCRYPTION_KEY` values in **plaintext**, so any hit may itself contain a live secret — treat the rows as sensitive and rotate anything found in them.

**Pass 2 additions:**

9. **`ENCRYPTION_KEY` must now be at least 32 characters in production** or the process **will not boot** (`server.js` checkRequiredEnv, and `integrationConfig.derivedKey()` for anything that imports the module without going through `server.js`). Check this before deploying, not after.
10. **Webhooks now fail closed.** If `RAZORPAY_WEBHOOK_SECRET` is not configured, `/api/webhooks/razorpay` answers **503** in production instead of trusting the payload. Set it, per tenant under Integrations or in the environment, **before** deploying — otherwise payment callbacks stop being accepted. The same applies to `ZOHO_SIGN_WEBHOOK_SECRET`.
11. **`nodemailer` moved 8 → 10.** Its RFC 5322 parsing is stricter, which is the point of the fix: a malformed recipient address that previously "worked" may now be rejected. Watch the `email_send_failed` warnings for the first day.
12. ⚠ **Integration management is now admin/super_admin only.** Before this change every authenticated user could reach it; `admin:edit` is held by `admin` and `super_admin` alone. If `finance_manager` was using the Integrations page for Tally or Razorpay, they no longer can — grant them `admin:edit` in the matrix if that is the intent, and **do not** reach for `PERMISSION_FAIL_OPEN`. The status endpoints are deliberately looser (`settings:view`, which finance_manager holds) so the page still reports, it just cannot be edited.
13. **Run `npm run lint:errors` in CI.** It is currently 0 errors, and it found 11 live bugs on its first run — the value is in keeping it at zero.

---

## 14. Rollback plan

- **Code:** revert the branch. Safe and independent of the data migration — the old handler simply re-accepts unknown fields. **Reverting restores the CRITICAL vulnerability**, so treat it as an emergency measure only.
- **Data:** `down()` is a deliberate no-op. The stripped values were attacker-plantable process-wide config; they are unrecoverable once dropped, and "restore the attacker's environment variable" is not a rollback anyone wants. Legitimate credentials are **preserved** by the strip (verified), so nothing an operator wants back is lost.
- **Partial rollback is safe:** keeping the migration while reverting the code, or vice versa, both work.
- ⚠ **The changes are currently UNCOMMITTED** on `security/pulse-01-integration-config-authz`. I did not commit because `whatsapp.routes.js` and `amcRenewal.cron.js` also carry **pre-existing uncommitted work** (a dead-table fix routing WhatsApp leave intake to `leave_applications`), and committing would attribute that work to this security change. Say the word and I will commit either the cleanly-separable files or the whole set.

---

## 15. Evidence required for closure

**Satisfied:**
- [x] Negative reproducer: the original exploit, unmodified, now denied at every step (§10)
- [x] Escalation reproducer: 403 → 403, `escalation NOT reproduced`
- [x] Positive regression: an authorized admin still works (Tests 3, 10, the alias positive, and the live admin probe)
- [x] Automated tests: **15/15 + 23/23 + 7/7**, and each suite **proven to fail against the unfixed code** (12 of 14, and 13 of 23)
- [x] Whole-environment snapshot unchanged across attempted mutation
- [x] Full backend suite green — **89 files, 1960 passed, 0 failed**, three consecutive clean runs; repeated runs, with the one remaining flake diagnosed and attributed (§12.7)
- [x] Migration applied, and its strip path separately verified with a planted row
- [x] Alternate-path sweep: every mount, every writer of `company_integrations`, `tally_config` and `company_settings`. This is how the `/settings/tally` alias, the `/settings/:module` writer and the plaintext `/settings/integrations` sink were found
- [x] Source-level guards against a new dynamic `process.env` write, an env-read credential consumer, and a missing `await` on a newly-async function
- [x] Secret-exposure review of responses, audit log and error paths — **and a real gap found and fixed** in the audit redaction list (§12a)
- [x] **LIVE before/after on a running server**: employee 200 → 403 on a pre-fix vs. restarted instance, with the admin path still working (§10)
- [x] **Browser verification**: `30-integrations-authz.spec.ts`, **5/5 passed** — the GET→form→PUT round trip, which only a real page can prove
- [x] **Compromise assessment**: `audit_logs`, `access_denials`, `company_integrations` and `company_settings` inspected. **No evidence of exploitation.** The single audit row naming a process-wide variable was my own controlled reproduction, identified by its now-deleted synthetic user (id 4346, 2026-09-26T10:55Z) and removed. All probe artifacts cleaned; company 1 is back to 0 integration rows
- [x] **Dependency audit**: run, 5 findings → 1 remaining, assessed unreachable with evidence (§12.2). `nodemailer`'s recipient-domain bypass **fixed**, which matters because it is the library this fix routes tenant mail through
- [x] **Decision recorded** on every Pass 1 residual risk (§12a) and every remaining one (§12)

**Outstanding — PULSE-01 should NOT be marked closed until these are done:**
- [x] **Author review against those three challenge questions** — done in §12b. One decision (degrade-on-decrypt) **did not survive and was changed**; pushing on another found an ungated fallback path in the PULSE-01 gate itself. This is **not** a substitute for the item below
- [ ] **Independent code review** by someone who did not write it. Pass 3 is evidence that review finds things here: reviewing my own diff turned up four defects of my own plus a hole in my own gate. Start at `backend/src/modules/integrations/integrationConfig.js` (the allowlist and the encryption contract), then `integrations-config.routes.js`, `settings-status.routes.js` and `webhooks.routes.js`. Things still worth a second opinion: whether `FAIL_CLOSED_ON_DECRYPT` should include more than `razorpay`; whether `settings:view` is the right bar for the status endpoints; and whether reducing integration management to admin/super_admin is acceptable operationally (§12b decision 1)
- [x] **Deployment-procedure checks** (the mechanics, not a staging deploy): the new `ENCRYPTION_KEY` boot guard **refuses to start** on an 8-character key in production with its own FATAL message, and with a 48-character key it does **not** fire — boot proceeds and stops on a different, pre-existing production requirement (`FRONTEND_URL`), which proves the guard is not over-firing. `npm run migrate` re-run is a clean no-op (`Database schema is up to date`)
- [ ] **Controlled deployment to staging**, then the §13 smoke tests against the deployed release. The live verification here was against a locally restarted dev server, which is evidence that the code works — **not** evidence that the deployment procedure works
- [x] **Tickets written** — `PULSE-01_FOLLOWUP_TICKETS.md`, six of them (PULSE-02 … PULSE-07), each with acceptance criteria and the reason it was left. Still needs someone to put them in the tracker
- [ ] **A decision on committing.** The changes are uncommitted because two files carry unrelated pre-existing work (§14)

---

### Scope statement

This report covers PULSE-01 — integration credential authorization and arbitrary process-environment mutation — and the nine residual risks its first pass recorded. It makes no claim that the application is free of other vulnerabilities, compliant with ASVS 5.0.0 as a whole, or production-ready.

What the work does support: the reported vulnerability is closed, with a reproducer that fails and a regression that passes; six further defects found along the way are fixed, three of them critical and two of those reachable without authentication; and the residual risk list is now nine items, of which one is a pre-existing authorization gap, one a supply-chain advisory assessed as unreachable, one a test-fixture flake, and the rest deliberate design decisions documented in code.

