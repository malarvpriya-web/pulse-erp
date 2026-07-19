/**
 * Database audit — Phase 1 item 3.
 *
 * Reports against the LIVE schema: unindexed foreign keys, duplicate indexes,
 * never-used indexes, missing foreign keys on *_id columns, soft-delete
 * consistency, and table sizes.
 *
 * Index-usage figures come from pg_stat_user_indexes, which counts since the
 * last stats reset. On a dev database with little traffic "unused" mostly means
 * "not exercised here" — treat it as a prompt to check production, not as
 * permission to drop.
 */
import pool from '../../src/config/db.js';

const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
const h = (t) => console.log(`\n═══ ${t} ═══`);

// ── 1. Foreign keys with no supporting index ─────────────────────────────────
// Postgres indexes the referenced (parent) side via its PK but never the
// referencing (child) side. Without it every parent DELETE/UPDATE scans the
// child table to enforce the constraint, and FK joins cannot use an index.
h('FOREIGN KEYS WITHOUT AN INDEX (join + cascade cost)');
const unindexedFk = await q(`
  SELECT c.conrelid::regclass::text  AS child_table,
         a.attname                   AS fk_column,
         c.confrelid::regclass::text AS parent_table,
         pg_size_pretty(pg_relation_size(c.conrelid)) AS child_size
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
   WHERE c.contype = 'f'
     AND array_length(c.conkey, 1) = 1
     AND NOT EXISTS (
       SELECT 1 FROM pg_index i
        WHERE i.indrelid = c.conrelid AND a.attnum = i.indkey[0])
   ORDER BY pg_relation_size(c.conrelid) DESC, 1`);
console.log(`  ${unindexedFk.length} unindexed foreign keys`);
console.table(unindexedFk.slice(0, 15));

// ── 2. Exact-duplicate indexes ───────────────────────────────────────────────
h('DUPLICATE INDEXES (same table, same column list)');
const dupes = await q(`
  SELECT indrelid::regclass::text AS table_name,
         array_agg(indexrelid::regclass::text ORDER BY indexrelid::regclass::text) AS indexes
    FROM pg_index
   GROUP BY indrelid, indkey, indisunique, indpred
  HAVING COUNT(*) > 1
   ORDER BY 1`);
console.log(`  ${dupes.length} duplicate index groups`);
dupes.slice(0, 12).forEach(d => console.log(`   ${d.table_name}: ${d.indexes.join(' | ')}`));

// ── 3. Never-used indexes ────────────────────────────────────────────────────
h('UNUSED INDEXES (0 scans since stats reset — verify in PRODUCTION before dropping)');
const unused = await q(`
  SELECT relname AS table_name, indexrelname AS index_name,
         pg_size_pretty(pg_relation_size(indexrelid)) AS size
    FROM pg_stat_user_indexes s
    JOIN pg_index i USING (indexrelid)
   WHERE s.idx_scan = 0
     AND NOT i.indisprimary AND NOT i.indisunique
     AND pg_relation_size(indexrelid) > 16384
   ORDER BY pg_relation_size(indexrelid) DESC`);
console.log(`  ${unused.length} unused non-unique indexes > 16 kB`);
console.table(unused.slice(0, 10));

// ── 4. *_id columns with no foreign key ──────────────────────────────────────
h('COLUMNS NAMED *_id WITH NO FOREIGN KEY (referential integrity gaps)');
const orphanCols = await q(`
  SELECT c.table_name, c.column_name, c.data_type
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_name = c.table_name AND t.table_schema = c.table_schema
   WHERE c.table_schema = 'public'
     AND t.table_type = 'BASE TABLE'
     AND c.column_name LIKE '%\\_id'
     AND c.column_name NOT IN ('company_id','branch_id')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint con
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
        WHERE con.contype = 'f'
          AND con.conrelid = (quote_ident(c.table_name))::regclass
          AND a.attname = c.column_name)
   ORDER BY c.table_name, c.column_name`);
console.log(`  ${orphanCols.length} *_id columns with no FK (company_id/branch_id excluded)`);
console.table(orphanCols.slice(0, 15));

// ── 5. Soft-delete consistency ───────────────────────────────────────────────
h('SOFT DELETE: deleted_at WITH NO INDEX REFERENCING IT');
const softDel = await q(`
  SELECT c.table_name,
         EXISTS (SELECT 1 FROM pg_indexes i
                  WHERE i.tablename = c.table_name
                    AND i.indexdef ILIKE '%deleted_at%') AS has_index
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.column_name = 'deleted_at'
   ORDER BY c.table_name`);
const noIdx = softDel.filter(r => !r.has_index);
console.log(`  ${softDel.length} tables use deleted_at; ${noIdx.length} have no index referencing it`);
console.log(`  (every "deleted_at IS NULL" filter scans those tables in full)`);
console.log('   ' + noIdx.slice(0, 18).map(r => r.table_name).join(', '));

// ── 6. Biggest tables ────────────────────────────────────────────────────────
h('LARGEST TABLES');
console.table(await q(`
  SELECT relname AS table_name, n_live_tup AS est_rows,
         pg_size_pretty(pg_total_relation_size(relid)) AS total_size
    FROM pg_stat_user_tables
   ORDER BY pg_total_relation_size(relid) DESC LIMIT 12`));

await pool.end();
