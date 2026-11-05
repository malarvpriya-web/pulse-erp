# HR role tiers — `hr`, `hr_manager`, `hr_exec`

Written 2026-09-30 while gating BGV discrepancy findings. Reflects the live
`roles` / `role_permissions` rows as measured on that date, not an aspiration.

## The decision

**`hr` is manager-tier.** Its `roles.role_name` is literally `"HR Manager"`, and
its permission rows match `hr_manager` almost exactly. Treating it as a junior
role because the code string is short would have silently downgraded the primary
HR account in this deployment.

So there are **two tiers**, not three:

| Tier | Roles | Means |
|---|---|---|
| **Manager** | `hr`, `hr_manager` | Owns the HR function. Payroll, deletions, and the sensitive half of BGV. |
| **Operations** | `hr_exec` | Does the HR work. No payroll, no deletions, and **cannot read BGV findings**. |

`admin` and `super_admin` sit above both and hold everything.

## Why `hr` and `hr_manager` both exist

They are the same tier reached by two routes: `hr` (role id 4) is the original
role from the platform-foundation migration, and `hr_manager` (id 9) came with
the granular role set added 2026-05-30. Neither is redundant in practice —
accounts exist against `hr` — so both are granted manager-tier BGV access.

⚠ **Do not "consolidate" them without migrating user_roles.** Deleting `hr`
would strip the primary HR account in this deployment of every grant it holds.

## Measured permissions (2026-09-30)

`v`=view `a`=add `e`=edit `d`=delete `x`=export

| module | `hr` | `hr_manager` | `hr_exec` |
|---|---|---|---|
| `bgv` | v a e d x | v a e d x | v a e **·** x |
| **`bgv_sensitive`** | **v · · · x** | **v · · · x** | **· · · · ·** |
| `employees` | v a e d x | *(no row)* | *(no row)* |
| `hr` | v a e d · | v a e d x | v a e · · |
| `payroll` | v a e · x | v a e d x | *(all false)* |
| `leaves` | v a e d x | v a e d x | v a **·** · · |
| `attendance` | v a e d x | v a e d x | v a e **·** · |
| `recruitment` | v a e d x | v a e d x | v a e **·** · |
| `documents` | v a e · · | v a e · x | v a e · · |
| `reports` | v · · · x | v · · · x | v · · · · |

### ⚠ Two landmines in that table

1. **`hr_manager` and `hr_exec` hold NO `employees` row at all.** Every employee
   route is gated by `allowRoles(...HR_ROLES)`, a role-name list, which is why
   they work today. Any new route gated on `requirePermission('employees', …)`
   will **403 both of them**, because `requirePermission` fails closed on a
   missing row. This is why the BGV migrations seed every role explicitly
   instead of copying the `employees` matrix.

2. **`hr_exec` has `payroll` seeded all-false, not absent.** That is deliberate
   and better: an explicit deny is a recorded decision, an absent row is
   indistinguishable from an unseeded matrix.

## What `bgv_sensitive` gates, and what it does not

Granted to `super_admin`, `admin`, `hr`, `hr_manager`. **Not** `hr_exec`.

**Gated** — the findings and the settled record:
- `remarks`, `followup_notes`, `cost_remarks` on a check whose result is
  `Discrepancy`
- the contact-history `notes` under such a check
- the report documents attached to such a check, including the bytes served by
  `GET /api/files/:name`
- the Discrepancy Report export
- **reopening a closed case** (plus a mandatory reason)

**Not gated** — the facts an operations user needs to do the job:
- that a check exists, its type, agency, dates and cost
- its `status` **and** its `result`, including the word `Discrepancy`
- the case's derived status and the discrepancy count
- every non-discrepancy check and its reports

That split is the point. An HR executive who cannot see that a check came back
`Discrepancy` would keep chasing the agency as though it were still pending, and
the case would read as unfinished work rather than as a finding awaiting a
decision. They can see **that** there is a finding; they cannot read **what it
says**.

## Adding a new HR-facing permission

1. Seed **every** role explicitly, including the `false` rows —
   `requirePermission` fails closed, and an absent row reads as an unseeded
   matrix rather than as a denial.
2. Do not copy the `employees` matrix: it is incomplete (see landmine 1).
3. If the grant guards sensitive content, mirror `can_export` to `can_view`, or
   the screen is gated and the export is an open alias
   (`project_pulse01_env_write_rbac_killswitch`).
4. Add the module key to `KNOWN_MODULES` in `services/PermissionService.js`, so
   a role without a row gets an explicit deny-all in the login payload.

## Not silently granted

No sensitive BGV access was given to `hr_exec`, and none was inferred from role
names. `bgv_sensitive` is checked with `permissionFor()` — the same
user-override → role-union precedence every other gate uses — so a specific
person can be granted or denied it individually from Access Control without
touching code.
