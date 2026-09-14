/**
 * Boot shim for sql-failure-probe.mjs — wraps pg.Pool.prototype.query so every
 * rejected statement is recorded, THEN imports server.js. The wrap has to be
 * installed before server.js creates its pool, which is why this is a separate
 * entry point rather than a flag on the probe.
 *
 * SQL_PROBE_LOG names the file to append rejections to (one JSON object a line).
 */
import fs from 'node:fs';
import pg from 'pg';

const LOG = process.env.SQL_PROBE_LOG;
if (!LOG) { console.error('SQL_PROBE_LOG is required'); process.exit(1); }
fs.writeFileSync(LOG, '');

const orig = pg.Pool.prototype.query;
pg.Pool.prototype.query = function (...args) {
  const text = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text) || '<obj>';
  const flat = text.replace(/\s+/g, ' ').trim();
  const record = (e) =>
    fs.appendFileSync(LOG, JSON.stringify({ code: e.code, msg: e.message, sql: flat.slice(0, 500) }) + '\n');
  let p;
  try { p = orig.apply(this, args); } catch (e) { record(e); throw e; }
  if (p && typeof p.then === 'function') p.then(undefined, record);
  return p;
};

await import('../../server.js');
