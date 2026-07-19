# Pulse ERP — Project Conventions

Monorepo: `backend/` (Node/Express + Postgres) · `frontend/` (React + Vite).
Frontend pages live in `frontend/src/features/<module>/pages/*.jsx`; routes are
auto-discovered from file names by `config/autoRouter.js` (`/PageName`).

## Frontend UI conventions (enforced 2026-07-06 — see UI_FORMATTING_CONSISTENCY_AUDIT.md)

### Design tokens — single source of truth
Canonical tokens are the `--color-*` set in `src/styles/global-overrides.css`
(brand ramp `--brand-*` in `src/styles/theme.css`). Legacy names in
`components/Layout.css` (`--primary-color`, `--bg-color`, …) are aliases of the
canonical tokens — **re-theme in global-overrides.css only**. Never hardcode:
- Brand purple: `var(--color-primary)` / `#6B3FDB` (hover `#5B35D5`). Never `#7c3aed`.
- Page background: `var(--color-bg-page)` / `#f8f9fc` — the only page grey.
- Status: `--color-success/warning/danger/info` (+`-bg` tints). Blue (`#2563eb`,
  `#dbeafe`) is reserved for semantic info/in-progress states and chart series —
  never for primary buttons, links, or active tabs (those are brand purple).

### Page layout rules
- **New pages use `.pulse-page`** as the root div (defined in Layout.css), or
  match its contract: `padding: 24px`, background `var(--color-bg-page)`.
- **Never set `maxWidth` on a page root** — pages are full-screen. Exception:
  intentionally narrow centered forms/wizards (< 1000px).
- Full-bleed hero pages (root with `margin: -20px`, e.g. ApplyLeave,
  EmployeesDashboard) are an accepted archetype — don't "fix" them.
- Buttons: `.pulse-btn-primary` / `.pulse-btn-secondary` (or `.primary-btn`).
  Don't invent per-module button classes.

### Typography
`src/index.css` must stay free of element-level `font-family`/`font-size` rules
(no Arial, no 18px tables) — typography is owned by global-overrides.css
(inside `.page-content`) and Layout.css (`body`). Anything rendered outside
`.page-content` (portals, Login, public pages) inherits from `body`.

### Locked areas (require explicit user instruction)
- Home page (`pages/Home.*`, role dashboards, dashboard widgets) — layout and
  colors are locked; `styles/tokens.css` exists only for Home.css.
- Topbar logo size (8px `!important` in Topbar.css) — never change.

## Verification
Dev servers: backend :5000, frontend :5173. Playwright is available at the
workspace root (`tests/`). Login as `superadmin@manifest.in` (the old
`superadmin@pulse.com` / `Pulse@123` demo account was deactivated 2026-07-08 in
the canonical-login cleanup — it now fails with "Invalid email or password").
Password is not recorded here; get it from the account owner. To sanity
check page JSX in bulk:
`find src/features -path "*pages*" -name "*.jsx" -print0 | xargs -0 npx esbuild --loader:.jsx=jsx --outdir=/dev/null --log-level=error`
(On Windows esbuild can't write to `/dev/null` — use a temp `--outdir` instead.)
