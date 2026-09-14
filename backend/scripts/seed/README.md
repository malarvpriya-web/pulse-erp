# Empty-table seeder

Fills every empty table in the `public` schema with realistic fixture rows, so
that code paths which only run when a table has data actually execute. Built on
2026-08-20, when 358 of the 552 tables held zero rows.

Everything is derived from live schema introspection — there is no hand-written
row template per table. Rows are generated from column types, FKs, CHECK
vocabularies and UNIQUE keys, then inserted in FK-topological order.

## Commands

```bash
node scripts/seed/seed-empty-tables.mjs --rows=5 --topup=4   # seed everything empty
node scripts/seed/seed-empty-tables.mjs --only=a,b --rows=3  # seed named tables
node scripts/seed/seed-empty-tables.mjs --dry                # list what would be seeded
node scripts/seed/unseed.mjs                                 # roll back every seeded row
node scripts/seed/unseed.mjs --only=a,b                      # roll back named tables
node scripts/seed/api-sweep.mjs                              # GET every endpoint, report 5xx
node scripts/seed/rebuild-manifest.mjs --write               # recover a lost manifest
node scripts/seed/seed-auth-tables.mjs --rows=5              # the 7 auth/access tables
```

`--topup=N` also tops thin FK-parent master tables up to N rows, so children
have more than one parent to point at. `companies` is excluded on purpose.

## Files

| file | role |
| --- | --- |
| `seed-empty-tables.mjs` | the seeder |
| `unseed.mjs` | deletes everything in `_manifest.json`, reverse order, FK-aware |
| `lib-schema.mjs` | introspection + topological sort |
| `lib-values.mjs` | value generation, CHECK-constraint parsing |
| `api-sweep.mjs` | hits every paramless GET route and reports failures |
| `rebuild-manifest.mjs` | reconstructs the manifest from `_schema.json` |
| `seed-auth-tables.mjs` | the 7 auth/page-access tables, with inert-by-construction rows |
| `snapshot-baseline.mjs` | writes `_schema.json`, the pre-seed row-count baseline |
| `_manifest.json` | every inserted row's PK — the rollback record |
| `_results.json` / `_api-sweep.json` | last seed run / last sweep results |

**Do not delete `_schema.json`.** It is the pre-seed row-count baseline and the
only way to tell a seeded row from a real one in a table that was empty.

## Things worth knowing

- **Rows are pinned to `company_id = 1`.** A fixture on any other tenant is
  invisible to every scoped user, which defeats the point of seeding it. This
  overrides the FK sampler — do not "fix" it by letting company_id be sampled.
- **Eight tables are skipped by the generic seeder** because a plausible-looking
  row in them changes authentication or page-access behaviour and can lock real
  users out: `ip_whitelist`, `auth_rate_limit`, `revoked_tokens`,
  `active_sessions`, `face_locked_accounts`, `password_reset_otps`,
  `menu_permissions`, `user_menu_permissions`. `--include-unsafe` overrides —
  don't. **Use `seed-auth-tables.mjs` instead**, which writes rows chosen so they
  cannot take effect: sessions already expired, locks already lapsed,
  `ip_whitelist.active = false`, OTPs spent, revocations predating every live
  token, and menu rows only ever `view`/`edit` (a grant) and never `hidden`.
  `menuAccess()` returns null when no row exists, so grants cannot hide a
  section that is visible today. Re-run `rebuild-manifest.mjs --write` after,
  so `unseed.mjs` can roll them back.
- **`deleted_at` and friends are never written** — a soft-deleted fixture is
  invisible in every list screen.
- **The insert loop repairs itself.** On failure it reads the SQLSTATE
  (23502/23514/23503/23505/22001/22003/22P02/42703/23P01) and adapts the row,
  up to 10 attempts. Anything still failing after that is a real schema defect
  and lands in `_results.json` — that is the interesting output, not the rows.
- **A unique-violation repair never perturbs `company_id` or a FK column.** An
  earlier version did, and silently moved rows to tenant 4945.
- **Several FK columns can point at the same parent** (`week_1_shift_id`,
  `week_2_shift_id`). Each FK constraint is offset into the parent so they pick
  different rows, or `CHECK (week_1 <> week_2)` can never be satisfied.
- **json/jsonb shape matters.** A column whose name reads as a collection gets
  an array, because a UI doing `value.map(...)` throws on an object.
- **The manifest merges, it does not clobber** — an `--only` run must not throw
  away the rollback record from a previous full run.
