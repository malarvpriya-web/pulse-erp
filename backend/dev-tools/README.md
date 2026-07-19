# dev-tools/

Development-only utilities. **Never run these against a production database.**

These scripts were used during initial development and schema bootstrapping.
Production schema changes are handled by the versioned migration system in
`src/database/migrations/` — run with `npm run migrate`.

## Contents

| File | Purpose |
|------|---------|
| `seed*.js` | Seed sample/demo data for local development |
| `setup-*.js` | One-time setup helpers used during early dev |
| `add-*.js` / `create-*.js` | Ad-hoc column / table additions (superseded by migrations) |
| `test-*.js` | Manual DB connectivity tests |
| `init*.js` | Bootstrap scripts for specific modules |
| `*.sql` | SQL snippets used during debugging |
| `knexfile.js` | Legacy Knex config — superseded by `src/config/db.js` |

## Running (local dev only)

```bash
node dev-tools/seed.js          # seed basic data
node dev-tools/seed-complete.js # full demo dataset
```

Always ensure `NODE_ENV=development` is set before running.
