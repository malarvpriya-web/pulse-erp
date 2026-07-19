/**
 * dbConnectionTest.js
 * Live database health check driven by backend table introspection.
 *
 * Instead of a hardcoded endpoint list, this fetches /system-health/db-tables,
 * which enumerates every table in the database at request time. Any newly-created
 * table therefore appears in the connection test automatically — no manual edits.
 *
 * The result shape is kept identical to the previous endpoint-based test so the
 * SystemHealth UI (status tiers, KPIs, grouping) renders unchanged.
 */

export async function testAllConnections(onProgress) {
  const BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';
  const token = localStorage.getItem('token');
  const headers = token
    ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };

  onProgress?.(15);

  const start = Date.now();
  let res;
  try {
    res = await fetch(`${BASE}/system-health/db-tables`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    onProgress?.(100);
    return [{
      module: 'Database Introspection',
      group: 'Core',
      url: '/system-health/db-tables',
      status: 0,
      ok: false,
      ms: 0,
      records: null,
      dataSnippet: null,
      error: err.name === 'TimeoutError' ? 'Timeout (>20s)' : 'Cannot reach backend',
    }];
  }

  const ms = Date.now() - start;
  onProgress?.(70);

  // Auth or server error — surface a single diagnostic row.
  if (res.status !== 200) {
    const ok = res.status === 401 || res.status === 403;
    onProgress?.(100);
    return [{
      module: 'Database Introspection',
      group: 'Core',
      url: '/system-health/db-tables',
      status: res.status,
      ok,
      ms,
      records: null,
      dataSnippet: null,
      error: ok ? null : `HTTP ${res.status}`,
    }];
  }

  let body;
  try {
    body = await res.json();
  } catch {
    onProgress?.(100);
    return [{
      module: 'Database Introspection',
      group: 'Core',
      url: '/system-health/db-tables',
      status: res.status,
      ok: false,
      ms,
      records: null,
      dataSnippet: null,
      error: 'Malformed response',
    }];
  }

  const tables = Array.isArray(body?.tables) ? body.tables : [];

  const results = tables.map((t, i) => ({
    module: t.label || t.table,
    group: t.group || 'Other',
    url: t.table,
    status: 200,
    ok: true,
    // The catalog read is a single round-trip; attribute the measured latency to
    // the first row rather than fabricating a per-table number for every row.
    ms: i === 0 ? ms : 0,
    records: typeof t.rows === 'number' ? t.rows : 0,
    dataSnippet: t.columns ? `${t.columns} column${t.columns !== 1 ? 's' : ''}` : null,
    error: null,
  }));

  onProgress?.(100);
  return results;
}
