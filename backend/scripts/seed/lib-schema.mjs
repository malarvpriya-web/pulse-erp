// Schema introspection helpers for the empty-table seeder.
import pg from 'pg';

export function makePool() {
  return new pg.Pool({
    host: process.env.DB_HOST, port: process.env.DB_PORT,
    database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    max: 4,
  });
}

export async function introspect(pool) {
  const q = (s, p) => pool.query(s, p).then(r => r.rows);

  const rels = await q(`
    select c.relname as name, c.relkind,
           (select count(*)::int from pg_inherits i where i.inhrelid = c.oid) as is_partition,
           (select pg_get_expr(c.relpartbound, c.oid)) as part_bound,
           (select p.relname from pg_inherits i join pg_class p on p.oid = i.inhparent
             where i.inhrelid = c.oid limit 1) as part_parent
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p') and c.relpersistence = 'p'
    order by 1`);

  const cols = await q(`
    select table_name, column_name, ordinal_position, data_type, udt_name, is_nullable,
           column_default, character_maximum_length, numeric_precision, numeric_scale,
           is_identity, identity_generation, is_generated
    from information_schema.columns where table_schema = 'public'
    order by table_name, ordinal_position`);

  // pg_catalog (not information_schema) so composite FKs keep their column pairing
  const fks = await q(`
    select con.conname, rel.relname as tbl, frel.relname as ref_table,
      (select array_agg(a.attname order by k.ord) from unnest(con.conkey) with ordinality k(attnum,ord)
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum)::text[] as cols,
      (select array_agg(a.attname order by k.ord) from unnest(con.confkey) with ordinality k(attnum,ord)
        join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum)::text[] as ref_cols
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_class frel on frel.oid = con.confrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname = 'public' and con.contype = 'f'`);

  const cons = await q(`
    select con.conname, rel.relname as tbl, con.contype, pg_get_constraintdef(con.oid) as def,
      (select array_agg(a.attname) from unnest(con.conkey) k(attnum)
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum)::text[] as cols
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname = 'public' and con.contype in ('c','u','p')`);

  const uidx = await q(`
    select tablename as tbl, indexname, indexdef from pg_indexes
    where schemaname = 'public' and indexdef like 'CREATE UNIQUE INDEX%'`);

  const enums = await q(`
    select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as vals
    from pg_type t join pg_enum e on e.enumtypid = t.oid group by 1`);

  const T = new Map();
  for (const r of rels) {
    T.set(r.name, {
      name: r.name, relkind: r.relkind, isPartition: r.is_partition > 0,
      partBound: r.part_bound, partParent: r.part_parent,
      cols: [], fks: [], checks: [], uniques: [], pk: null,
    });
  }
  for (const c of cols) T.get(c.table_name)?.cols.push(c);
  for (const f of fks) T.get(f.tbl)?.fks.push(f);
  for (const c of cons) {
    const t = T.get(c.tbl); if (!t) continue;
    if (c.contype === 'c') t.checks.push(c);
    else { t.uniques.push(c.cols || []); if (c.contype === 'p') t.pk = c.cols; }
  }
  for (const i of uidx) {
    const t = T.get(i.tbl); if (!t) continue;
    const m = /\(([^)]+)\)\s*$/.exec(i.indexdef.replace(/ WHERE .*$/, ''));
    if (m) t.uniques.push(m[1].split(',').map(s => s.trim().replace(/"/g, '').split(' ')[0]));
  }
  const enumMap = new Map(enums.map(e => [e.typname, e.vals]));
  return { T, enumMap };
}

export async function rowCounts(pool, names) {
  const out = {};
  for (const n of names) {
    try { out[n] = (await pool.query(`select count(*)::int n from "${n}"`)).rows[0].n; }
    catch { out[n] = -1; }
  }
  return out;
}

// Kahn topological sort over FK edges; edges that would close a cycle are dropped
// (those FK columns get NULL or a self-reference instead).
export function topoSort(T, targets) {
  const set = new Set(targets);
  const deps = new Map(targets.map(t => [t, new Set()]));
  for (const t of targets) {
    for (const f of T.get(t).fks) {
      if (f.ref_table !== t && set.has(f.ref_table)) deps.get(t).add(f.ref_table);
    }
  }
  const out = [], done = new Set();
  let guard = 0;
  while (out.length < targets.length && guard++ < targets.length + 5) {
    let progress = false;
    for (const t of targets) {
      if (done.has(t)) continue;
      if ([...deps.get(t)].every(d => done.has(d))) { out.push(t); done.add(t); progress = true; }
    }
    if (!progress) { // cycle: emit the remaining in fewest-unmet-deps order
      const rest = targets.filter(t => !done.has(t))
        .sort((a, b) => [...deps.get(a)].filter(d => !done.has(d)).length
                      - [...deps.get(b)].filter(d => !done.has(d)).length);
      out.push(rest[0]); done.add(rest[0]);
    }
  }
  for (const t of targets) if (!done.has(t)) out.push(t);
  return out;
}
