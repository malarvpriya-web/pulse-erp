# BGV — retention policy and open handoffs

Written for: whoever owns the BGV module next, and whoever signs off its data
retention. It records one thing this pass deliberately did **not** decide (§1,
which needs a policy owner, not code), and one unrelated defect that was found
while testing and has since been fixed (§2).

---

## 1. Retention: what the code does today

**Nothing in the BGV module physically deletes a stored file, and nothing purges
a document record.** That is the whole of the policy as implemented.

| Action | What happens to the row | What happens to the file on disk |
|---|---|---|
| `DELETE /bgv/documents/:id` | `deleted_at` / `deleted_by` stamped. The row stays, with its `file_url` intact. | Untouched. |
| `DELETE /bgv/checks/:id` | Refused (`HAS_EVIDENCE`) while the check has a **live** document. | Untouched. |
| Case closed / reopened | No effect on documents. | Untouched. |
| Any cron, sweep or scheduled job | **There is none.** | — |

Consequences that are deliberate, not oversights:

- **A removed report is still downloadable** under exactly the grants that
  applied before removal — `bgv` to see it at all, `bgv_sensitive` if the check
  it hangs off returned a Discrepancy. Removal takes it out of the folder view;
  it does not widen or narrow who may read it. `bgvDocumentOwner()` in
  `secureFiles.routes.js` does **not** filter `deleted_at`, and that is the line
  that makes this true. A future change that adds the filter would silently
  break audit access to retired evidence.
- **Storage grows without bound.** Accepted for now. BGV reports are small and
  low-volume; the alternative — a purge job — is the thing that must not be
  written without a policy to implement.

### What is still needed, and is NOT in this codebase

A formal retention policy, owned by whoever owns the Manifest / compliance side.
It has to answer, in writing, before any purge code is written:

1. **How long** a BGV report is kept after the employee leaves. Indian practice
   varies by sector and by what the agency's own contract requires; the ERP
   cannot invent a number.
2. **Whether the retention clock starts** at the check's completion, at case
   closure, or at separation. These give materially different dates.
3. **What "purge" means** — destroy the file and keep the metadata row as proof
   a verification happened, or destroy both. The first is almost always what
   audit wants; the second is what a data-subject erasure request asks for, and
   they conflict.
4. **Who may trigger one**, and whether it is reviewable before it runs.
5. **How a legal hold suspends it.** A purge with no hold mechanism destroys
   evidence in the one situation where it is most needed.

Until all five are answered, the correct behaviour is the current one: keep
everything, delete nothing automatically. **No retention period is invented
anywhere in this module** — grep for one and you will not find it.

The recruitment module's consent/retention work took the same line and is worth
reading first: it **anonymises and never deletes**, and sets `email` to
`anonymised+<id>@…` rather than NULL. If BGV ever gets a policy, that is the
precedent to follow rather than a new mechanism.

---

## 2. RESOLVED — biometric reads had no view tier

**Fixed 2026-10-12. Kept here because the obvious fix was wrong, and the reason
is worth not rediscovering.**

### The failure

```
FAIL  src/__tests__/integration.biometricAuthz.test.js
      payroll_admin GET /api/biometric/devices  →  expected 200, got 403
```

### Root cause

`biometric.routes.js` defined three attendance gates — `attendanceAdd`,
`attendanceAdmin` (= `attendance:edit`), `attendanceDelete` — and **no view
gate at all**. The GETs took `attendanceAdmin` because it was the closest one to
hand. `payroll_admin` holds `attendance: can_view=true, can_edit=false`, so a
role the HR menu lists as a user of BiometricAccess was refused every read on it.
This file's own header said it "gets a read-only page"; it had no page.

### ⚠⚠ Why `attendance:view` is the WRONG fix

An earlier version of this document recommended exactly that. Measuring the
matrix killed it:

| role | attendance v/a/e/d | hr v/a/e/d |
|---|---|---|
| `employee` | **Y/-/-/-** | *(no row)* |
| `payroll_admin` | **Y/-/-/-** | Y/-/-/- |

`employee` and `payroll_admin` hold **identical** attendance permissions, so no
attendance action separates them. Gating the device reads on `attendance:view`
would have handed every employee the device inventory — names, IP addresses and
ports. The two audiences differ only in `hr`.

### The fix as shipped

A local `requireAnyPermission([[module, action], …])` that allows if ANY grant
holds and fails closed otherwise, used as:

```js
const biometricRead = requireAnyPermission([['hr', 'view'], ['attendance', 'edit']]);
```

— "an HR-page user, **or** an attendance administrator". It covers both real
audiences and excludes `employee`:

- BiometricAccess (HR → Gate Pass & Visitors): hr, hr_manager, hr_exec,
  payroll_admin, admin, super_admin — all hold `hr:view`.
- DeviceManagement (Attendance → Configuration → Devices): manager,
  department_head — no `hr` row at all, but they hold `attendance:edit`.

Applied to `GET /biometric/devices`, `/devices/stats`, `/devices/:id/punches`,
`/logs` and `/dashboard`. All writes keep `attendanceAdd` / `attendanceAdmin` /
`attendanceDelete` unchanged.

**`GET /biometric/devices/:id/users` deliberately stays on `attendanceAdmin`.**
It is not a read of our tables: it opens a TCP socket to the device's own IP and
asks the hardware to enumerate enrolled fingerprints. No page calls it. A
read-only dashboard user has no reason to dial a device on a 10-second connect
timeout. (The test that probes it uses an impossible device id so it answers 404
from the scoped lookup and never reaches the hardware — the first version used a
real id and timed out, which is the same fact arriving as a test failure.)

### A second defect found while checking the first

`GET /biometric/devices/:id/users` looked its device up with
`WHERE id=$1` — **no tenant filter**. Any caller holding the gate could name
another tenant's device id and have the server connect to that tenant's hardware
and read back its enrolled users. Now scoped like every other device route.

Found by asking, before loosening any gate, whether each read was tenant-scoped.
The four pure-DB reads were; this one was not. **A scope predicate is a
precondition for a looser gate, not a separate concern** — widening who can
reach a route is exactly when a missing filter starts to matter.

### Coverage

`integration.biometricAuthz.test.js` is 33 → **55 tests**, and the new ones are
mutation-proved in three directions:

| mutation | result |
|---|---|
| reads back on `attendanceAdmin` (the original defect) | 3 fail |
| reads on `attendance:view` (the naive fix) | **6 fail**, incl. every "employee is denied" |
| tenant filter dropped from `/users` or `/punches` | 2 fail each |

⚠ The two foreign-tenant tests were **vacuous** when written: every row in
`biometric_devices` belongs to company 1, so each hit its `if (!rows.length)
return` and passed without probing anything — only the source-level assertion
caught the mutation. The suite now provisions its own foreign-tenant device
(company `999920`, per the 9999xx convention) and deletes it by captured id.

## 3. HR role tiers

Documented separately in [`HR_ROLE_TIERS.md`](./HR_ROLE_TIERS.md), including the
measured permission matrix and two landmines (`hr_manager` / `hr_exec` hold no
`employees` row at all; `hr_exec`'s payroll permissions are seeded all-false
rather than absent, which reads identically through the API and does not through
the database). No `user_roles` migration was performed, and the three HR roles
were not merged.
