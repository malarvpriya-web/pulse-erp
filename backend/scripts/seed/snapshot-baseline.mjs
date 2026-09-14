import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
const pool = new pg.Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
});
const q = (s,p)=>pool.query(s,p).then(r=>r.rows);

// live row counts (exact) for all public tables
const tables = await q(`
  select c.relname as t, c.relkind,
         (select count(*) from pg_inherits i where i.inhrelid=c.oid) as is_partition
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind in ('r','p') order by 1`);

const counts = {};
for (const {t} of tables) {
  try { counts[t] = (await q(`select count(*)::int n from "${t}"`))[0].n; }
  catch(e){ counts[t] = 'ERR:'+e.code; }
}

const cols = await q(`
  select table_name, column_name, ordinal_position, data_type, udt_name,
         is_nullable, column_default, character_maximum_length, numeric_precision, numeric_scale,
         is_identity, identity_generation, is_generated, generation_expression
  from information_schema.columns where table_schema='public' order by table_name, ordinal_position`);

const fks = await q(`
  select tc.table_name, kcu.column_name, ccu.table_name as ref_table, ccu.column_name as ref_column, tc.constraint_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu on kcu.constraint_name=tc.constraint_name and kcu.table_schema=tc.table_schema
  join information_schema.constraint_column_usage ccu on ccu.constraint_name=tc.constraint_name and ccu.table_schema=tc.table_schema
  where tc.constraint_type='FOREIGN KEY' and tc.table_schema='public'`);

const checks = await q(`
  select rel.relname as table_name, con.conname, pg_get_constraintdef(con.oid) as def
  from pg_constraint con join pg_class rel on rel.oid=con.conrelid
  join pg_namespace n on n.oid=rel.relnamespace
  where n.nspname='public' and con.contype='c'`);

const uniques = await q(`
  select rel.relname as table_name, con.conname, pg_get_constraintdef(con.oid) as def, con.contype
  from pg_constraint con join pg_class rel on rel.oid=con.conrelid
  join pg_namespace n on n.oid=rel.relnamespace
  where n.nspname='public' and con.contype in ('u','p')`);

const uidx = await q(`
  select tablename as table_name, indexname, indexdef from pg_indexes
  where schemaname='public' and indexdef like 'CREATE UNIQUE%'`);

const enums = await q(`
  select t.typname, array_agg(e.enumlabel order by e.enumsortorder) vals
  from pg_type t join pg_enum e on e.enumtypid=t.oid group by 1`);

fs.writeFileSync(new URL('_schema.json', import.meta.url), JSON.stringify({tables,counts,cols,fks,checks,uniques,uidx,enums},null,1));
const empty = Object.entries(counts).filter(([k,v])=>v===0).map(([k])=>k);
console.log('tables:',tables.length,'empty:',empty.length,'errs:',Object.entries(counts).filter(([k,v])=>typeof v==='string').length);
await pool.end();
