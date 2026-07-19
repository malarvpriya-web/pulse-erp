# Authorization coverage scripts

Written for the 2026-07-19 H-2 sweep (`SECURITY_AUDIT_2026-07-18.md`). Kept in the repo
because the finding they measure regresses silently — a new route with no guard looks
exactly like a correct one.

```bash
node scripts/security/authz-sweep.mjs       # all mutating routes with no authz guard
node scripts/security/authz-privileged.mjs  # narrowed to approve/reject/cancel/delete on :id
```

Current: **501 / 1261 (39.7%)** mutating routes with no authorization; **76** unguarded
privileged ones; **0 unclassified**. Both should only ever go down.

### Baseline history — do not compare across detector versions

The detector was wrong three times, in both directions, before it was trustworthy:

| Ver | Rule | Failure |
|---|---|---|
| v1 | hardcoded list of guard names | missed every module-specific guard |
| v2 | matched `name(` as a call | missed guards passed by **reference** — how ordinary middleware is used |
| v3 | matched `require\|allow\|can\|verify` | missed `svcAdmin`/`perm`/`engPerm`; counted `verifyToken` (authentication) as authorization |
| v4 | classify explicitly, report unknowns | middleware only — blind to **in-handler** guards |
| v5 | also scans the handler body for `IN_HANDLER_AUTHZ` | — |

v4 flagged procurement's PR/PO approve routes as open when they had enforced value-band
limits all along, because this codebase routinely authorizes *inside* the handler — an
ownership or amount check needs the record loaded, which middleware would have to fetch
twice. v5 also fixed the `ROUTE` regex, which terminated a match at the first comment line
and so truncated the handler body before any guard could be seen.

Published figures over time — only the last is meaningful:

| Reported | Privileged | Total | Status |
|---|---|---|---|
| initial (v1) | 134 | 698 | too pessimistic |
| after v2 fix | 120 | 633 | still wrong |
| after v3 fix | 102 | 580 | still wrong |
| **v4, current** | **83** | **510** | trustworthy |

v4 no longer guesses. Anything it cannot classify is printed as UNCLASSIFIED for a human to
resolve in `authz-config.mjs`. Resolve by reading the definition, never the name: `single`
looks like a guard and is a local variable; `perm` looks like a variable and is
`requirePermission('assets', a)`.

A `0 unclassified` line is what makes the headline number believable. If it is non-zero,
the number is a lower bound, not a measurement.

## Reading the output

Both scripts count a route as guarded if `requirePermission`, `allowRoles`,
`checkPermission`, `verifyPortalToken`, `verifyVendorToken`, or `requireDeviceToken`
appears in its middleware chain, or if the file applies one via `router.use`.

Two caveats, both deliberate:

- **Public-by-design routers are excluded** via the `BY_DESIGN` list (auth, public e-sign,
  customer portal, vendor self-registration, QR scan, IoT ingest). Add to that list rather
  than adding a fake guard, and only when the router really is public.
- **A guarded route is not necessarily a *correctly* guarded route.** These scripts check
  that a check exists, not that it is the right check or that it fails closed. A route
  calling `requirePermission('maintenance', …)` counts as guarded here even though no
  `role_permissions` row exists for `maintenance`, so it fails open at runtime — that is
  failure mode (i) in the audit, which these scripts do not detect. Cross-reference the
  module/role matrix in the audit for that.

Self-service routes (`POST /attendance/clock` for one's own record) legitimately have no
role guard and inflate the `authz-sweep` number. That is why `authz-privileged.mjs` exists:
its 134 hits act on someone else's `:id` and are not explicable as self-service.
