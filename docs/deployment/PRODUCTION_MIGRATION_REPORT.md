# Pulse ERP — Production Migration Report

**Prepared by:** Principal Cloud Architect / DevOps audit
**Date:** 2026-07-25 (audit) · **Implementation started 2026-07-27** · **Second sweep 2026-07-27** (caught 6 doc files the first pass missed — item 12b)
**Scope:** Infrastructure, configuration, networking, URLs, deployment settings only. No business logic reviewed or changed.

> **Implementation status (2026-07-27):** every platform-agnostic item below is
> done (marked ✅). What's left needs a human decision or real credentials this
> report can't supply on its own: **hosting platform** (Render vs. Railway),
> **file storage backend** (S3/R2 bucket, or confirm a persistent volume is
> mounted), **Google OAuth client** (only if Sign-In ships), **DNS records**
> (needs the exact CNAME target from whichever platform's dashboard), and
> **mobile push credentials** (`google-services.json`/APNs, only if push ships).

**Target domains:**

| Purpose | URL |
|---|---|
| Website | `https://manifest-tech.in` |
| ERP (frontend) | `https://erp.manifest-tech.in` |
| API (backend) | `https://api.manifest-tech.in` |
| Docs | `https://docs.manifest-tech.in` |
| Support | `https://support.manifest-tech.in` |
| Status | `https://status.manifest-tech.in` |

**Open decisions confirmed with stakeholder (2026-07-24/25):**
- DNS/registrar: **GoDaddy** — domain already purchased. `manifest-tech.in` currently returns NXDOMAIN (no records at all yet) — clean slate, no legacy records to migrate around.
- Hosting platform: **not yet decided.** The repo contains config for *three* different deployment paths that are not equivalent (see §0). This report covers all three and flags the decision as a blocker for finalizing several sections below.

---

## 0. Critical architectural finding: three competing deployment paths exist

The repo simultaneously contains full configs for three different hosting models, and they are **not interchangeable**:

| Path | Config files | Topology |
|---|---|---|
| **A. Render** | `Pulse/render.yaml` | Frontend and backend are separate managed services on separate `onrender.com` subdomains; frontend calls the API directly cross-origin via `VITE_API_URL`. CORS must allow the frontend origin. |
| **B. Railway** | `Pulse/backend/railway.toml`, `Pulse/frontend/railway.toml` | Same shape as Render — frontend served via `npx serve -s dist`, backend via `node server.js`, both on separate Railway-issued domains. Frontend again calls the API directly via `VITE_API_URL`. |
| **C. Docker Compose / self-managed VM** | `Pulse/docker-compose.yml`, `Pulse/frontend/nginx.conf`, `Pulse/backend/Dockerfile`, `Pulse/frontend/Dockerfile` | Frontend nginx container **same-origin-proxies** `/api/*` to an internal `backend:5000` container on a private Docker network. No separate API subdomain is used internally — `VITE_API_URL` would normally be left unset/relative (`/api`) in this model. Comments in `docker-compose.yml` explicitly say this stack is **not** what production uses today — it's for local pilot demos and the CI "Docker Build & Boot" smoke job only. |

Since the target architecture is **two separate subdomains** (`erp.manifest-tech.in` for the app, `api.manifest-tech.in` for the API), that maps naturally to **Path A or B** (direct cross-origin calls, `VITE_API_URL=https://api.manifest-tech.in/api`), not Path C's same-origin nginx proxy. If Path C is ever used for real production traffic, `nginx.conf`'s `/api` proxy block becomes dead weight and `VITE_API_URL` must still point directly at `api.manifest-tech.in` — or the proxy must be rewritten to reverse-proxy to the real API subdomain instead of a Docker-internal hostname.

**Recommendation:** pick Render or Railway (both are already fully configured and match the two-subdomain target) and treat `docker-compose.yml`/`nginx.conf` as pilot/demo/CI-only, as the repo's own comments already say. This report's Environment Variable and Deployment Checklist sections assume **Path A/B (separate managed services)** unless noted, with Path C called out separately wherever it materially differs.

---

## 1. Every file requiring changes, exact change, and risk level

### 1.1 Must change before go-live (blocking)

| # | File | Exact change | Risk |
|---|---|---|---|
| 1 | `Pulse/frontend/.env.production` | ✅ **Done** — `VITE_API_URL` now `https://api.manifest-tech.in/api`. | **Critical** — this is baked into the JS bundle at build time; it is the single source of truth for where the web app, PWA, and mobile (Capacitor) apps send every API call and where generated QR codes point. |
| 2 | `Pulse/render.yaml` (line ~41) | ✅ **Done** — `FRONTEND_URL` now `https://erp.manifest-tech.in`. | **Critical** — drives backend CORS allow-list and every e-sign email link. |
| 3 | `Pulse/render.yaml` (line ~70, comment + Render dashboard value) | ✅ **Comment done.** Dashboard `sync: false` value still needs to be entered manually once a Render service exists. | **Critical** — same as #1 but for whichever platform actually builds the frontend. |
| 4 | Backend production env (`.env.production` or platform dashboard) | ✅ **Done** — `FRONTEND_URL` now `https://erp.manifest-tech.in`. | **Critical** — duplicate of #2, whichever file/dashboard is actually live. |
| 5 | File storage configuration (`STORAGE_PROVIDER`) | ✅ **Partially done** — `server.js` now refuses to boot in production with `STORAGE_PROVIDER=local` unless `ALLOW_LOCAL_STORAGE_ONLY=true` is explicitly set (mirrors the existing `BACKUP_S3_BUCKET`/`ALLOW_LOCAL_BACKUPS_ONLY` pattern). This converts the failure from silent data loss to a loud startup error — it does **not** pick a backend for you. **Still needs a human decision:** either provision an S3/R2 bucket and set `STORAGE_PROVIDER`+`AWS_*` credentials, or confirm a persistent volume is mounted over `uploads/` and set `ALLOW_LOCAL_STORAGE_ONLY=true`. | **Critical** — real credentials/infra decision, can't be scripted. |
| 6 | `Pulse/electron/main.js` | ✅ **Done** — packaged builds (`app.isPackaged`) now default to `https://erp.manifest-tech.in`; the localhost port-probe only runs for unpackaged dev runs. `PULSE_URL` still overrides either way. | **High** — was: desktop build fails to load anything in production. |
| 7 | Google OAuth (backend env + Google Cloud Console) | Not done — needs real credentials. `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are now documented in both `.env.example` files (with the redirect-URI note), but the actual values must come from a Google Cloud Console OAuth client only you can create. | **High if Google Sign-In is used** — informational only otherwise. |
| 8 | `Pulse/backend/Dockerfile` (only relevant if Path C is used) | ✅ **Done** — healthcheck now reads `process.env.PORT` instead of a literal `5000`. | **Medium** — was: silently misreports health if the platform overrides `PORT`. |

### 1.2 Should change before go-live (non-blocking but recommended)

| # | File | Exact change | Risk |
|---|---|---|---|
| 9 | `Pulse/backend/server.js:335` | ✅ **Done** — dev origins now dropped from the allow-list when `NODE_ENV === 'production'`. | **Medium** — was: dev origins live in the prod CORS allow-list. |
| 10 | `Pulse/docs/deployment/render.yaml` | ✅ **Done** — replaced with a short pointer to the canonical `Pulse/render.yaml`. | **Medium** — was: risk of using stale config during cutover. |
| 11 | `Pulse/docs/deployment/DEPLOYMENT.md` | ✅ **Done** — rewritten to match the real Render/Railway architecture; the stale plaintext demo-credentials table was removed and replaced with a pointer to the login-account policy in `CLAUDE.md`. | **High (documentation-only)** — was: pointed a real cutover at the wrong stack. |
| 12 | `Pulse/docs/deployment/HYPERCARE.md`, `Pulse/docs/deployment/ROLLBACK.md` | ✅ **Done** — all `*.onrender.com` URLs swapped for `erp.`/`api.manifest-tech.in`. | **Low** |
| 12b | `Pulse/docs/ARCHITECTURE.md`, `Pulse/RUNBOOK.md`, `Pulse/backend/docs/runbooks/{security-incident,deployment-rollback,database-failure}.md`, `Pulse/backend/scripts/smoke-prod.js` | ✅ **Done (2026-07-27, second pass)** — these six files were missed by the first implementation pass; found via a repo-wide `onrender.com`/`railway.app` sweep. Stale example URLs (`pulse-frontend.onrender.com`, `pulse-erp.onrender.com`, `your-app.railway.app`) swapped for the real `erp.`/`api.manifest-tech.in` domains. `RUNBOOK.md` also got a banner note flagging that its Render-dashboard-specific steps assume Render is the chosen platform (still undecided, §0) — substitute Railway-equivalent steps if that's picked instead. | **Low** |
| 13 | `Pulse/backend/.env.example` | ✅ **Done** — `FRONTEND_URL` example fixed; `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and the new `ALLOW_LOCAL_STORAGE_ONLY` flag documented. | **Low** |
| 14 | `Pulse/frontend/.env.example` | ✅ **Done** — `VITE_API_URL` example fixed; `VITE_GOOGLE_CLIENT_ID`, `VITE_API_URL_STAGING`, `VITE_API_URL_PRODUCTION` documented. | **Low** |
| 15 | `Pulse/edge-gateway/config.example.json`, `Pulse/edge-gateway/README.md` | ✅ **Done** — placeholder ingest URLs now reference `https://api.manifest-tech.in/api/v1/iot/ingest`. | **Low** |
| 16 | `Pulse/backend/src/docs/swagger.js:11-12` | ✅ **Done** — stale `railway.app` server entry now `https://api.manifest-tech.in/api`. | **Low** |
| 17 | `Pulse/frontend/src/features/admin/pages/APIDocumentation.jsx` | Not changed — reads `VITE_API_URL_STAGING`/`VITE_API_URL_PRODUCTION`, which are now documented (item 14) but still optional/unset by default, so the tabs stay blank until someone sets them. Left alone deliberately: this is an admin-tool UI decision, outside this audit's infra-only scope. | **Low** |
| 18 | Stray duplicate files: `Pulse/frontend/src/vite.config.js`, `Pulse/frontend/src/package.json`, `Pulse/frontend/src/index.html`, `Pulse/frontend/src.zip`, `Pulse/frontend/src (2).zip` | ✅ **Partially done** — the three git-tracked files were removed (`git rm`, reversible via history). The two `.zip` files were left alone: they're deliberately `.gitignore`d (not just untracked), which reads as an intentional local artifact, and deleting an unrecoverable file on a guess is the wrong default — delete them yourself if you confirm they're safe to lose. | **Low** |
| 19 | `Pulse/frontend/public/sw.js` | Not changed — fully implemented but never registered. Left alone deliberately: whether to wire up offline/push support is a product decision, not an infra fix. | **Medium** |

### 1.3 Already production-ready — no change needed

| Area | Why it's fine |
|---|---|
| `server.js` `app.listen(PORT, ...)` | No host bound (listens on all interfaces, required for containers); `PORT` fully env-driven with a dev-only `5000` fallback — works unchanged on Render (`PORT=10000`), Railway, or any platform. |
| JWT secret handling | `JWT_SECRET`/`ENCRYPTION_KEY` are fully env-driven; startup throws if unset or (in production) shorter than 32 chars. No hardcoded secrets anywhere. |
| `GET /api/health` | Host-agnostic, checks DB + migrations + critical tables + memory; exempted from rate limiting so platform health probes never get 429'd. Already referenced correctly by both `render.yaml` and `railway.toml`. |
| E-sign email links (`mailer.js` `APP_BASE()`) | `process.env.FRONTEND_URL || 'http://localhost:5173'` — fully env-driven, becomes `https://erp.manifest-tech.in/sign/<token>` automatically once `FRONTEND_URL` is set (item #2/#4 above). |
| QR code payloads (`QRCodeStudio.jsx`) | Derived from the shared axios client's `baseURL`, itself from `VITE_API_URL` — fixing item #1 fixes this automatically. (Note: QR codes already printed/shared under the old host will keep pointing at it — those need reprinting post-cutover.) |
| Google OAuth redirect URI construction (`Login.jsx`) | `redirect_uri: \`${window.location.origin}/login\`` — dynamically derived, automatically becomes `https://erp.manifest-tech.in/login` with zero code changes. Only the Google Cloud Console registration (§11) and the client ID/secret (#7 above) need action. |
| Google Drive integration (documents) | Service-account based (`googleDrive.service.js`), no OAuth redirect flow, no domain dependency. |
| FCM/APNs push endpoints (`pushSender.js`) | Hardcoded to Google's/Apple's own `https://` endpoints (correct — these should never point at your domain); currently disabled (no keys configured), no migration impact either way. |
| Capacitor config (`capacitor.config.ts`) | Production path (`androidScheme: 'https'`) has no hardcoded domain at all — API target is entirely inherited from the web build's `VITE_API_URL`. |
| Android/iOS native security posture | No `usesCleartextTraffic` override (Android defaults to HTTPS-only on API 28+); no `NSAppTransportSecurity` exceptions in `Info.plist` (iOS ATS fully enforced, no exceptions). Both are already secure-by-default. |
| WebSocket/Socket.io | Does not exist anywhere in the codebase — nothing to migrate. |
| Cookie-based auth flags | Not applicable — auth is Bearer-token-only, zero `res.cookie()` calls found. |
| `package.json` scripts (both frontend and backend) | No hardcoded hosts/ports in any script; everything flows through env vars or `vite.config.js`. |
| `.dockerignore` (both) | Correctly excludes all `.env*` except `.env.example` from build context — no secret-leak-into-image risk. |
| Git secret hygiene | Verified directly: `backend/.gitignore` and `frontend/.gitignore` both exclude all `.env*` variants; only `.env.example` files are tracked in git. Confirmed via `git ls-files` — no real `.env`/`.env.production` secrets are committed to the public GitHub repo (`github.com/malarvpriya-web/pulse-erp`). |
| Edge-gateway IoT agent | Enforces HTTPS-out-only by design; `ingestUrl` fully config-driven, no hardcoded domains in code (only doc/example placeholders, item #15). |
| Tally on-prem integration (`TALLY_GATEWAY_URL` defaulting to `localhost:9000`) | Correct as-is — this is a customer's on-premises Windows service the backend calls out to, not a cloud endpoint. No relationship to the domain migration. |

---

## 2. Deployment Checklist

**Pre-cutover**
- [ ] Decide hosting platform: Render vs. Railway (both fully configured; pick one — see §0). Docker Compose/nginx stays demo/CI-only per repo's own documentation.
- [ ] Decide production database: Render-managed Postgres vs. an external managed Postgres (the repo's `.env.production` currently references a stale Neon.tech placeholder — resolve this as part of the hosting decision).
- [ ] Decide file storage: attach a persistent volume/disk to the chosen platform, **or** provision an S3/R2 bucket and set `STORAGE_PROVIDER=s3`/`r2` with credentials (item #5 — do this before the first real user uploads a file).
- [ ] Decide whether Google Sign-In ships at launch; if yes, create a Google Cloud OAuth 2.0 Client ID (see §11) and set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`VITE_GOOGLE_CLIENT_ID`.
- [ ] Delete or freeze `Pulse/docs/deployment/render.yaml` (stale duplicate) and rewrite/remove `Pulse/docs/deployment/DEPLOYMENT.md` (describes an abandoned stack).
- [ ] Delete stray duplicate frontend files (item #18).
- [ ] Rotate any secret in `backend/.env.production` that isn't a placeholder before it's used for a real deploy (it's git-ignored, but confirm no copy was ever pasted elsewhere).

**DNS**
- [ ] Add DNS records per §7 in GoDaddy (or migrate DNS to the platform's recommended nameservers / Cloudflare if apex-domain CNAME flattening is needed — see §7 note).
- [ ] Verify propagation (`dig`/`nslookup`) before pointing platform custom-domain verification at each subdomain.

**Backend deploy**
- [ ] Set `FRONTEND_URL=https://erp.manifest-tech.in` in the platform's env vars.
- [ ] Set `NODE_ENV=production` (already enforced/guarded — `server.js` will refuse to start in production without `FRONTEND_URL` and a sufficiently long `JWT_SECRET`, which is a good existing safety net).
- [ ] Set `DB_HOST`/`DB_SSL=true` for the real production database.
- [ ] Set `JWT_SECRET`, `ENCRYPTION_KEY` to freshly generated production values (do not reuse the ones in the repo's `.env.production` template).
- [ ] Confirm `TRUST_PROXY_HOPS` matches the real number of proxies in front of the app (Render/Railway edge = 1; add 1 more if Cloudflare is proxying too).
- [ ] Bind custom domain `api.manifest-tech.in` in the platform dashboard; wait for managed TLS cert issuance.
- [ ] Run `scripts/smoke-prod.js` with `BACKEND_URL=https://api.manifest-tech.in` after first deploy.

**Frontend deploy**
- [ ] Set `VITE_API_URL=https://api.manifest-tech.in/api` at **build time** (remember: Vite vars are baked into the bundle, not read at runtime — a container env var alone won't do it).
- [ ] Bind custom domain `erp.manifest-tech.in`; wait for managed TLS.
- [ ] Rebuild and redeploy after any `VITE_*` change — there is no runtime override.

**Mobile (Capacitor)**
- [ ] After the frontend `.env.production` fix (#1), run `npm run build`, then `npx cap sync android` and `npx cap sync ios` to propagate the new API target into the native shells before the next app-store release.
- [ ] If push notifications are wanted, add `google-services.json` (Android) and APNs certs/`GoogleService-Info.plist` (iOS) — **neither currently exists in the repo.**

**Post-cutover**
- [ ] Run `scripts/smoke-prod.js` against both `BACKEND_URL` and `FRONTEND_URL`.
- [ ] Reprint/regenerate any QR codes issued before cutover (they still point at the old host).
- [ ] Update `Pulse/docs/deployment/HYPERCARE.md`/`ROLLBACK.md` URLs (item #12) and follow the Hypercare runbook for the first 48–72h.
- [ ] Verify email deliverability (see §9 — SPF/DKIM/DMARC) so e-sign invite/reminder emails don't land in spam from the new domain.

---

## 3. Environment Variable Matrix — Development → Staging → Production

| Variable | Development | Staging (suggested) | Production |
|---|---|---|---|
| **Backend** | | | |
| `NODE_ENV` | `development` | `staging` (or `production` if no distinct staging code path) | `production` |
| `PORT` | `5000` | platform-injected | platform-injected (Render: `10000`) |
| `FRONTEND_URL` | *(unset — dev CORS regex allows any localhost origin)* | `https://staging.erp.manifest-tech.in` | `https://erp.manifest-tech.in` |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | `localhost` / local Postgres | staging DB instance | production-managed Postgres (decision pending — §2) |
| `DB_SSL` | `false` | `true` | `true` |
| `JWT_SECRET` | dev-only value (in `.env`, git-ignored) | unique staging secret | unique production secret, ≥32 chars, generated fresh |
| `ENCRYPTION_KEY` | dev-only value | unique staging key | unique production key, generated fresh |
| `TRUST_PROXY_HOPS` | `0` | `1` (or `2` if Cloudflare-proxied) | `1` (or `2` if Cloudflare-proxied) |
| `STORAGE_PROVIDER` | `local` | `s3`/`r2` (recommended, matches prod) | `s3`/`r2` **or** platform persistent disk — must not be bare `local` on ephemeral hosts |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | *(unset — feature disabled)* | staging OAuth client | production OAuth client (register redirect URI, §11) |
| `TALLY_GATEWAY_URL` | `http://localhost:9000` | customer's on-prem gateway (per deployment) | customer's on-prem gateway (per deployment) — unrelated to this migration |
| `FCM_*` / `APNS_*` | unset | unset (or test project) | set only if push notifications ship |
| **Frontend (build-time)** | | | |
| `VITE_API_URL` | `http://localhost:5000/api` (or unset, uses dev proxy) | `https://staging-api.manifest-tech.in/api` | `https://api.manifest-tech.in/api` |
| `VITE_GOOGLE_CLIENT_ID` | *(unset)* | staging client ID | production client ID |
| `VITE_DOCUMENTS_BASE_URL` | Google Drive folder link | same or staging folder | production HR documents folder |
| `VITE_API_URL_STAGING` / `VITE_API_URL_PRODUCTION` | unset | *(only used by the internal APIDocumentation admin page — optional)* | optional |
| **Electron** | | | |
| `PULSE_URL` | unset (probes localhost:5173-5176) | *(needs code change first — item #6)* `https://staging.erp.manifest-tech.in` | `https://erp.manifest-tech.in` |
| **Edge gateway (`config.json`, per-device)** | | | |
| `ingestUrl` | `http://localhost:5000/api/v1/iot/ingest` (if testing locally) | `https://staging-api.manifest-tech.in/api/v1/iot/ingest` | `https://api.manifest-tech.in/api/v1/iot/ingest` |

*A distinct staging tier is not currently deployed anywhere in the repo (no `staging` Render/Railway service found) — the middle column is a recommendation, not existing config. If a staging environment isn't planned, skip that column and go straight dev → production.*

---

## 4. DNS Records Required (GoDaddy)

Domain currently has **zero DNS records** (confirmed via live lookup — NXDOMAIN). Records needed:

| Type | Host | Value | Notes |
|---|---|---|---|
| A (or ALIAS/forwarding) | `@` (apex `manifest-tech.in`) | IP of website host, or GoDaddy domain forwarding to `www` | GoDaddy's standard DNS doesn't support CNAME at the apex; most platforms (Render/Vercel/Netlify) want a CNAME instead. Either use GoDaddy's forwarding for the apex, or move DNS management to a provider with CNAME-flattening/ALIAS support (e.g. Cloudflare, free tier) if the chosen host requires it. |
| CNAME | `www` | target given by website host | Only if the marketing site lives at `www.manifest-tech.in`. |
| CNAME | `erp` | target given by Render/Railway for the frontend service (e.g. `pulse-frontend.onrender.com` or Railway's assigned domain) | Exact value only known once hosting (§0) is chosen and the custom domain is added in that platform's dashboard — the platform will display the required CNAME target. |
| CNAME | `api` | target given by Render/Railway for the backend service | Same as above. |
| CNAME | `docs` | target of whatever serves docs (see §9 note — no docs site exists in this repo yet) | Needs a hosting decision (e.g. Docusaurus on Render/Netlify/GitHub Pages, or GoDaddy-hosted static site). |
| CNAME | `support` | target of chosen support/ticketing tool, **or** a route on the existing frontend (the app already has a built-in customer support portal — `Pulse/frontend/src/features/servicedesk/pages/CustomerPortalDashboard.jsx`) | Decide: point at a third-party helpdesk, or reverse-proxy/redirect to `erp.manifest-tech.in/servicedesk`-style route. |
| CNAME | `status` | target of chosen status-page provider (e.g. Instatus, Better Stack, UptimeRobot) | No status-page tooling exists in this repo — needs a third-party service selection; none was found configured anywhere. |
| MX | `@` | Google Workspace MX records (see §9) — only if company email is hosted there | `ASPMX.L.GOOGLE.COM` (priority 1), `ALT1`/`ALT2.ASPMX.L.GOOGLE.COM` (priority 5), `ALT3`/`ALT4.ASPMX.L.GOOGLE.COM` (priority 10) |
| TXT | `@` | `v=spf1 include:_spf.google.com ~all` | SPF — required so backend-sent emails (e-sign invites, notifications) from `@manifest-tech.in` aren't marked as spoofed, *if* outbound mail is sent via Google Workspace/Gmail SMTP relay. If a transactional email provider (SendGrid/SES/etc.) is used instead for `mailer.js`'s SMTP config, use that provider's SPF include instead. |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@manifest-tech.in` | DMARC — add after SPF/DKIM are confirmed working; start with `p=none` for monitoring, then tighten. |
| TXT | (DKIM selector, e.g. `google._domainkey`) | value generated by Google Workspace admin console (or by whichever transactional email provider is used) | Generated only after enabling Workspace/email provider — cannot be filled in until that's set up. |
| CAA | `@` | `0 issue "letsencrypt.org"` (Render/Railway both auto-provision via Let's Encrypt) | Add `pki.goog` too only if any service ends up on Google Cloud/Firebase Hosting. Omit entirely if unsure — no CAA record means any public CA can issue, which is the current (unrestricted) default anyway. |
| AAAA | — | *(not required — none of the candidate hosts require/publish IPv6 glue for custom domains; skip unless a specific platform mandates it)* | |

**Note:** exact CNAME target values for `erp`/`api` are placeholders above — GoDaddy record entry should happen *after* the custom domain is added in the Render/Railway dashboard, which will display the exact target hostname and may also require a TXT verification record.

---

## 5. SSL Requirements

- **Render / Railway path (A/B):** both platforms auto-provision and auto-renew Let's Encrypt TLS certificates for any custom domain once the CNAME is verified — no manual certificate management needed. Nothing in the app needs to change; HTTPS termination happens entirely at the platform edge.
- **Docker Compose / self-managed VM path (C):** **`Pulse/frontend/nginx.conf` currently has zero TLS configuration** — `listen 80;` only, no `listen 443 ssl`, no certificate directives, no HSTS. If this path is ever used for real production traffic (rather than staying demo/CI-only as currently documented), TLS termination must be added — either via Certbot/Let's Encrypt directly in the nginx container, or by putting Cloudflare (orange-cloud proxy) or another load balancer in front of it. This is a genuine gap **only if Path C is chosen**; it is a non-issue on Path A/B.
- **HSTS:** not currently set anywhere (helmet's CSP is intentionally disabled for the API-only backend, and nginx.conf has no `Strict-Transport-Security` header). Recommended to add `Strict-Transport-Security: max-age=31536000; includeSubDomains` at whichever edge terminates TLS, once all subdomains are confirmed HTTPS-only.
- **Mixed-content risk:** none found — no `http://` literal exists in any code path that runs in the deployed frontend bundle (all `http://localhost` fallbacks are dev-only and stripped/unreachable in production).

---

## 6. Google Workspace Requirements

No Google Workspace integration currently exists in this codebase beyond OAuth *sign-in* (client-side login) and a Drive *service account* (document storage) — see §11/§10. If the business wants `@manifest-tech.in` company email:

1. Sign up for Google Workspace with `manifest-tech.in` as the domain.
2. Verify domain ownership (Workspace setup will provide a TXT or CNAME record to add in GoDaddy).
3. Add the MX records from §4 in GoDaddy.
4. Add SPF (§4 TXT record) so mail sent *from* Workspace (e.g., staff email) authenticates correctly.
5. If the backend's own transactional email (e-sign invites/reminders, via `mailer.js`'s SMTP config) should send *as* `@manifest-tech.in`, either route it through Workspace's SMTP relay (requires its own SPF include and app-specific credentials) or keep using a dedicated transactional provider (SendGrid/SES/Postmark) with its own SPF/DKIM — don't mix both without care, or SPF records can conflict/exceed the 10-lookup limit.
6. Generate DKIM in the Workspace admin console and add the TXT record (§4).
7. This is entirely independent of the Google **OAuth** client used for Sign-In (§11) and the Drive **service account** used for document storage (§10) — those are separate Google Cloud project resources, not Workspace itself.

---

## 7. Google Cloud Storage Changes

Two distinct Google-related storage concerns exist:

**a) Google Drive integration (already in use)** — `Pulse/backend/src/services/googleDrive.service.js` uses a **service account** (`GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON`/`_PATH`) plus `GOOGLE_DRIVE_ROOT_FOLDER_ID` to store HR/recruitment documents. This has **no dependency on your web domain** — it authenticates directly to Google's API regardless of what host the backend runs on. No change required for the domain migration itself. Just confirm the service account credentials and root folder ID are set in whatever production environment is chosen.

**b) Google Cloud Storage (GCS) as `STORAGE_PROVIDER`** — **not currently used.** `StorageService.js` only supports `local` (default), `s3`, or `r2` — there is no GCS backend implemented. If GCS is desired for uploaded-file storage (see the Critical persistence finding, item #5), that would require **new code**, not just configuration — out of scope for this infra-only audit, but flagged since item #5 makes some form of durable storage mandatory before go-live. The simplest path with existing code is S3-compatible storage (AWS S3 or Cloudflare R2 — both already supported by `STORAGE_PROVIDER`).

---

## 8. OAuth Callback URLs

Only one OAuth flow exists: **Google Sign-In** (`Pulse/frontend/src/pages/Login.jsx`, `Pulse/backend/src/auth/auth.service.js`).

- Frontend redirect URI is constructed dynamically: `` `${window.location.origin}/login` `` — automatically becomes `https://erp.manifest-tech.in/login` in production with **no code change**.
- **Action required in Google Cloud Console** (OAuth 2.0 Client ID settings, Web application type):
  - **Authorized JavaScript origins:** add `https://erp.manifest-tech.in`
  - **Authorized redirect URIs:** add `https://erp.manifest-tech.in/login`
  - Keep the existing `http://localhost:5173/login` entry for local development.
  - If a staging environment is stood up, add its `/login` URL too.
- Backend needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set (currently undocumented and unset anywhere — item #7). Without them, `auth.service.js`'s `loginWithGoogle()` throws and the frontend shows "Google SSO is not configured on this server."
- No other OAuth callback (e.g., a separate server-side redirect flow) exists — Drive uses a service account, not user OAuth (§10).

---

## 9. Capacitor Mobile Configuration Changes

`Pulse/frontend/capacitor.config.ts` itself needs **no changes** — it has no hardcoded domain:

```ts
server: process.env.CAP_SERVER_URL
  ? { url: process.env.CAP_SERVER_URL, cleartext: true }   // dev live-reload only
  : { androidScheme: 'https' },                              // production: loads bundled dist/, HTTPS-only
```

What *does* need to happen for mobile builds to reach the new API:

1. Fix `Pulse/frontend/.env.production` (item #1) — `VITE_API_URL=https://api.manifest-tech.in/api`.
2. Rebuild the web bundle: `npm run build` (this bakes the new API URL into `dist/`).
3. Sync into native shells: `npx cap sync android` and `npx cap sync ios` — the Android/iOS apps load `dist/` locally, so the API target only changes after this step, not automatically.
4. Android manifest and iOS `Info.plist` already enforce HTTPS-only by default (no cleartext override, no ATS exceptions) — confirmed compatible with `api.manifest-tech.in` as long as it serves valid HTTPS (it will, per §5).
5. Push notifications: `capacitor.config.ts` already configures the `PushNotifications` plugin, but **no `google-services.json` (Android/FCM) or APNs certificate/`GoogleService-Info.plist` (iOS) exists anywhere in the repo.** If mobile push is wanted, these need to be created in Firebase/Apple Developer console and added before the next mobile release — independent of the domain migration, but worth doing in the same release cycle.
6. No changes needed to `AndroidManifest.xml`, `Info.plist`, or `strings.xml` — none hardcode a domain.

---

## 10. Remaining `localhost` References — Full Classification

Every `localhost`/`127.0.0.1`/hardcoded-port occurrence found across the repo (excluding `node_modules` and historical data in `backend/backups/*.sql`), classified per the audit's required taxonomy:

### Already production-ready (env-driven, dev-only fallback — no action needed)
- `Pulse/backend/server.js:337` — dev-only CORS regex branch (only runs when `FRONTEND_URL` is unset).
- `Pulse/backend/src/config/db.js` — `DB_HOST || 'localhost'`.
- `Pulse/backend/src/utils/mailer.js:90` — `FRONTEND_URL || 'http://localhost:5173'` (becomes correct once env var is set, item #2/#4).
- `Pulse/backend/scripts/*.js` (bootstrap-commission, db-restore, pre-deploy, generate-baseline, db-backup, post-deploy) — all `DB_HOST || 'localhost'`.
- `Pulse/backend/dev-tools/knexfile.js`, `src/jobs/backup.cron.js` — same pattern.
- `Pulse/backend/scripts/smoke-employee-access.js` — `BASE_URL || 'http://localhost:5000/api/v1'`, meant to be invoked with an explicit prod `BASE_URL`.
- `Pulse/backend/scripts/smoke-prod.js` — no localhost fallback at all, requires `BACKEND_URL` — the most production-safe script in the repo, already correct.
- `Pulse/frontend/src/services/api/client.js`, `dbConnectionTest.js`, `PublicSigning.jsx`, `CustomerPortalDashboard.jsx`, `APIDocumentation.jsx`, `SmartSearch.jsx` — all `VITE_API_URL || 'http://localhost:5000/api'`.
- `Pulse/frontend/vite.config.js` — dev server `port: 5173` + `proxy.target: 'http://localhost:5000'` (dev-only, not shipped in build).
- `Pulse/frontend/src/utils/devLogin.js` — dev-only helper, git-ignored, actively stripped from the production bundle by a dedicated Vite plugin (`devOnlyExternals()`).
- `Pulse/frontend/src/main.jsx` — unregisters stray service workers in dev only.
- `Pulse/backend/Dockerfile:39`, `Pulse/frontend/Dockerfile:27` — container-internal `HEALTHCHECK` loopback calls (`127.0.0.1`) — correct as-is, not user-facing (though see item #8 for the backend one's port-mismatch risk).
- `Pulse/.github/workflows/ci.yml` — all `localhost` references are inside the ephemeral GitHub Actions runner, never touch production.
- `Pulse/docker-compose.ci.yml` — CI-only override, no URLs at all.
- `Pulse/frontend/src/features/admin/pages/IntegrationsHub.jsx`, `TallyIntegration.jsx`, `SetupWizard.jsx` — `localhost`/`http://localhost:9000` used only as placeholder text in a form field for user-entered on-prem Tally URLs, not live config.
- `Pulse/backend/src/modules/integrations/tally.routes.js`, `settings-status.routes.js`, migration + baseline default — `TALLY_GATEWAY_URL || 'http://localhost:9000'`, correct for an on-prem integration.
- `Pulse/edge-gateway/*` — no hardcoded localhost; `sources/modbus.mjs` config example's `192.168.1.50` is a local Modbus device IP, unrelated to cloud domains.

### Needs configuration (env var must be set; code is already correct)
- `Pulse/frontend/.env.production` → `VITE_API_URL` (item #1, **Critical**).
- `Pulse/render.yaml` → `FRONTEND_URL`, `VITE_API_URL` (items #2/#3, **Critical**).
- Backend production env → `FRONTEND_URL` (item #4, **Critical**).
- `Pulse/.env.docker.example` → `FRONTEND_URL=http://localhost:8080` — only matters if Path C (Docker Compose) is ever used for real traffic; otherwise leave as-is (it's a local demo default).
- `Pulse/docker-compose.yml:47` → same `FRONTEND_URL` default, same caveat.

### Needs code change
- `Pulse/electron/main.js` — no production fallback exists at all (item #6, **High**).
- `Pulse/backend/Dockerfile` healthcheck — hardcoded port doesn't follow `process.env.PORT` (item #8, **Medium**, Path C/Render-with-this-Dockerfile only).
- `Pulse/backend/server.js:335` — dev origins hardcoded into the production CORS array (item #9, **Medium**).

### Unsafe
- None found. No wildcard CORS, no disabled TLS verification on outbound calls, no hardcoded secrets, no `NODE_ENV`-gated security check that fails open. The one borderline item (dev origins in prod CORS list, above) is "needs code change," not unsafe — it doesn't grant cross-origin access to arbitrary third parties.

### Broken
- `Pulse/frontend/src/features/admin/pages/APIDocumentation.jsx` — reads two env vars (`VITE_API_URL_STAGING`, `VITE_API_URL_PRODUCTION`) that are never defined anywhere in the repo, so those tabs render blank. Low-impact (internal admin tool), but technically broken as shipped. (item #17)
- `Pulse/frontend/public/sw.js` — fully written but never registered; offline/push functionality is dead code today. (item #19)
- `Pulse/docs/deployment/DEPLOYMENT.md` — describes an architecture (Railway+Vercel+Neon) and demo credentials that no longer match reality; not "broken" code, but a broken/misleading document. (item #11)

---

## Appendix: Source material

This report synthesizes three parallel file-by-file audits (backend `src/`+`scripts/`, frontend `src/`+`public/`, and infra/mobile/`docs/deployment`) plus direct verification of: `railway.toml` existence (both backend and frontend — confirmed present, contrary to one sub-audit's initial miss), git `.gitignore`/tracked-file status for all `.env*` files (confirmed clean — no secrets committed), live DNS state for `manifest-tech.in` (confirmed NXDOMAIN, no existing records), and the absence of `google-services.json`/`GoogleService-Info.plist` and any GCS storage backend in code.
