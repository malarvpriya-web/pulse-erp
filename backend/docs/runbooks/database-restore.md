# Database Restore Runbook

**System:** Pulse ERP  
**Purpose:** Recover the PostgreSQL database from a backup after data loss, corruption, or accidental deletion.

---

## When to Use This Runbook

- Data loss or corruption detected
- Accidental `DELETE`/`DROP` with no possibility of row-level undo
- Full environment migration (dev → staging → prod)
- Disaster recovery test (scheduled drills)

---

## Prerequisites

- PostgreSQL client tools (`psql`, `pg_restore`) installed and in `PATH`
- Access to the target database (connection string or individual env vars)
- A valid backup file (local `.sql` or S3 path)
- For S3 downloads: `BACKUP_S3_BUCKET`, `BACKUP_S3_REGION`, and AWS credentials

---

## Step 1 — Stop Application Traffic

Route traffic away before restoring to prevent writes racing the restore.

**Render:** Set the service to "Maintenance Mode" or scale down to 0 instances.  
**Railway:** Disable the service or set `startCommand` to an idle placeholder.  
**Nginx / Load Balancer:** Return 503 for all API requests during the window.

---

## Step 2 — Identify the Target Backup

### List local backups
```bash
npm run backup:list
```

### List S3 backups
```bash
aws s3 ls s3://$BACKUP_S3_BUCKET/pulse-backups/ --recursive | sort -k1,2 -r | head -20
```

Choose the most recent backup **before** the incident timestamp.

---

## Step 3 — Dry Run (mandatory)

Always validate before writing.

```bash
# Validate backup file + DB connectivity without any writes
npm run restore -- --dry-run

# Dry run against a specific file
npm run restore -- --file backups/pulse-2026-05-29_02-00-00.sql --dry-run

# Dry run against S3 key
npm run restore -- --s3 pulse-backups/pulse-2026-05-29_02-00-00.sql --dry-run
```

Expected output:
```
[1/4] Verifying database connectivity... ✅
[2/4] Validating backup...              ✅
[3/4] [DRY-RUN] Skipping restore...     ✅
[4/4] Verifying migration integrity...  ✅
DRY-RUN PASSED — no changes were made
```

If any step fails, do not proceed to live restore. See "Troubleshooting" below.

---

## Step 4 — Live Restore

**Warning:** This overwrites the target database. Confirm you are pointing at the correct DB.

```bash
# Restore latest local backup
npm run restore -- --latest --confirm

# Restore a specific local file
npm run restore -- --file backups/pulse-2026-05-29_02-00-00.sql --confirm

# Download from S3 and restore
npm run restore -- --s3 pulse-backups/pulse-2026-05-29_02-00-00.sql --confirm
```

The script will:
1. Verify DB connectivity
2. Validate the backup file
3. Execute `psql -f <file>` against the target DB
4. Verify migration table integrity post-restore

---

## Step 5 — Post-Restore Verification

```bash
# Run any pending migrations
npm run migrate

# Verify all migrations applied
npm run migrate:status

# Run smoke tests against the live database
npm run smoke:prod
```

Check critical tables exist:
```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('employees','users','audit_logs','schema_migrations','notifications')
ORDER BY table_name;
```

---

## Step 6 — Restore Application Traffic

Once smoke tests pass, re-enable the service:

**Render:** Turn off Maintenance Mode.  
**Railway:** Re-enable the service.  
**Nginx:** Remove the 503 rule.

Verify the `/api/health` endpoint returns `{"status":"ok"}`.

---

## Escalation

| Severity | Contact |
|---|---|
| DB unreachable | Infrastructure on-call |
| Restore fails with auth error | DevOps lead |
| Data loss > 4 hours | Engineering manager + CTO |

---

## Troubleshooting

### "pg_dump not found in PATH"
```bash
# Ubuntu/Debian
apt install postgresql-client

# macOS
brew install postgresql

# Windows
# Install from https://www.postgresql.org/download/windows/
# Add C:\Program Files\PostgreSQL\<version>\bin to PATH
```

### "Cannot connect to database"
- Verify `DATABASE_URL` or `DB_HOST`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`/`DB_PORT`
- Check firewall/VPC rules allow the restore host to reach the DB port
- For Render/Neon/Supabase: use the external (not internal) connection string

### "Backup file does not contain a valid PostgreSQL header"
- The file may have been truncated during transfer — re-download from S3
- Verify with: `head -5 <backup-file>` — should start with `-- PostgreSQL database dump`

### Restore stops mid-way with duplicate key errors
The target DB may already have data. For a clean restore:
```sql
-- DANGER: drops all data. Confirm this is intentional.
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
```
Then re-run the restore.
