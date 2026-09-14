# Go-live checklist — Pulse ERP

Everything in this file is **configuration or data**, not engineering. The code
side is finished and gated; see `MODULE_FEATURE_CONNECTION_MANUAL.md` §153–§158
for what was built and how each item was verified.

Run the gates first. If any fails, stop — they are cheap and they fail loudly.

```bash
cd Pulse/backend
npm run check:schema     # SQL refs · status vocabulary (both directions) · module graph
npx vitest run           # 48 files · 1093 tests

# Needs a running server (or PROBE_RESTART=1 to start its own).
# Re-asserts the authorization decisions §154-§157 recorded: 16 routes an
# employee must be refused, 2 that must return ONLY their own record, and 8 that
# the owning role must still reach — a gate that blocks everyone is an outage,
# not a fix.
npm run check:authz      # 27 assertions

# Also needs a running server. Drives a real update + delete and asserts the
# audit row records what the value changed FROM, that a create records null
# (not {}), and that a delete captures the row it destroyed.
npm run check:audit      # 11 assertions

cd ../..
npx playwright test --project=crm-mobile   # 12 browser tests at 390px
```

---

## 1. Two capabilities are inert until you connect them

Both were built this pass and both **say so on their own screens** rather than
rendering an empty state. Neither is a defect; neither can be finished without
credentials only you hold.

### 1a. Marketing journeys — needs SMTP

Set in `backend/.env`:

```
SMTP_HOST=smtp.yourprovider.com
SMTP_PORT=587
SMTP_SECURE=false          # true only for port 465
SMTP_USER=bot@yourcompany.com
SMTP_PASS=<app password>
SMTP_FROM=Pulse ERP <noreply@yourcompany.com>
```

The runner (`jobs/marketingJourney.cron.js`) picks this up on its next 15-minute
tick. Until then it refuses to advance any enrolment and records
`smtp_not_configured` against it — deliberately, so an un-run journey looks
un-run instead of accumulating a delivery history that never happened.

**Verify after setting it:** Marketing → Journeys. The amber "no mail transport"
banner disappears, and *Run due steps* reports `sent`, not `failed`.

### 1b. Email-to-case — needs a mailbox and a provider webhook

1. Service Desk → **Email to Case** → *Connect a Mailbox*. Enter the address
   customers already write to (e.g. `support@yourcompany.com`).
2. **Copy the ingest secret shown once.** It is not retrievable afterwards —
   use *Rotate* if you lose it, which invalidates the old one immediately.
3. Point your provider's inbound-mail webhook at:

   ```
   POST https://<your-host>/api/support-mail/ingest
   Header: X-Ingest-Secret: <the secret>
   Body:   { to, from, subject, text, html, message_id, in_reply_to, references, headers }
   ```

   Mailgun *Routes*, SendGrid *Inbound Parse* and Postmark *Inbound* all post a
   superset of these; field names are read leniently.

**Verify after setting it:** send a real email to the address. It should appear
under *Everything that arrived* within seconds, and open a case with an
`IPS-#####` number. Reply to the case notification and confirm the reply
**threads onto the same case** rather than opening a second one.

> The endpoint is unauthenticated by necessity — a webhook has no ERP login — so
> it is protected by that per-mailbox secret, compared in constant time. A
> mailbox with no secret refuses ingestion outright, and an unknown address and
> a wrong secret return the *same* 401 so nobody can enumerate your addresses.

---

## 2. Set before exposing the system publicly

| Variable | Why it matters |
|---|---|
| `PUBLIC_BASE_URL` | Already set. Must be the externally reachable origin — email open-tracking pixels and e-signature links are built from it. |
| `JWT_SECRET` | Must be a strong value that is **not** the development one. |
| `GLOBAL_RL_MAX` | Defaults to 300 req/min. Raise deliberately; a low value makes legitimate bulk work look like an attack, and a high one removes the brake. |
| `PERMISSION_FAIL_OPEN` | **Leave unset.** Setting it to `true` allows any request against a module with no permission row. It exists only as an emergency escape hatch and logs loudly. |

Per-company privacy switches stay **off** until the business decides:

- **Email open tracking** (`crm_settings.email_open_tracking`) is opt-in and
  defaults false. Deployment configuration must not silently switch on a
  customer-facing behaviour.

---

## 3. Data readiness — not a code issue

This system holds **no closed business**. Won value is `₹0` after the test
records were quarantined in §155.

Consequently: **win rate, forecast accuracy and sales-cycle length have nothing
to compute from** and will read as unmeasurable until real deals close. That is
the correct behaviour — the code returns `null` rather than `0` in every one of
these cases, because "unmeasured" and "bad" must not render identically.

The same applies to the new capabilities: an unrated knowledge article reports
`helpful_pct: null`, and a partner with nothing closed reports `win_rate: null`.

**Nothing to fix. Do not treat a blank metric here as a bug** — check whether
the underlying event has happened yet.

---

## 4. Known and accepted

- **Live chat is absent.** Email-to-case covers the asynchronous half of
  omnichannel; chat needs presence and routing and is a separate product.
- **`email_sequence_steps` is superseded** by `crm_email_sequence_steps` and
  carries a SQL `COMMENT` saying so. Retained read-only pending confirmation
  nothing reads it — a "dead" twin has been dropped here before and been wrong.
- **169 routes remain readable by an ordinary employee**, none exposing another
  person's records; they are self-service surfaces (leave, travel, L&D). The
  `check:authz` gate above re-asserts the specific decisions rather than the
  count, so a regression shows up as a failing assertion. Re-run it after any
  change to `server.js` mounts or `role_permissions`.
- **Before-image coverage is 68%** of UPDATE/DELETE handlers (up from 9%). The
  remaining 190 write to several tables at once, or are addressed by a key that
  is not the mutated row's — capturing those automatically would have recorded
  the *wrong* row, so they need a decision per handler rather than a codemod.
  Every mutation is still recorded; what varies is whether the previous value
  is recorded alongside it.
- **`/auth` has no `auditMutations` floor**, deliberately: `auth_audit_log`
  already records sign-in, sign-out, lockout and password events, and routing
  credential-bearing bodies into `audit_logs` would be a liability rather than a
  control. User *creation* is now recorded in both logs.

---

## 5. First-week checks

| Check | Where | Healthy |
|---|---|---|
| Journeys are sending | Marketing → Journeys | `emails sent` climbing; `failed` at 0 |
| Mail is arriving | Service Desk → Email to Case | `created` and `appended` climbing |
| Threading is reliable | same screen | `threaded by a guess` staying near 0 — a high count means replies are arriving without the case token, and outbound subjects need checking |
| Nothing is stalling | Journeys → any enrolment → Timeline | no repeated `failed` on one enrolment (5 attempts marks it failed and stops) |
| Audit is recording | Admin → Audit | rows appearing for every module people are working in |
