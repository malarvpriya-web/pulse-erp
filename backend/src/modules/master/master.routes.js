import express from 'express';
import pool from '../../config/db.js';
import { allowRoles } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';
import { respondError } from '../../shared/pgErrors.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { REGISTRY, BY_KEY, RESERVED_TYPES, writeRoles } from './vocabularies.js';
import { USAGE, usageForVocab, countUsage, countUsageBulk, describeUsage } from './usage.js';
import { invalidateVocabularyCache } from '../../shared/masterVocabulary.js';

const router = express.Router();

/**
 * Every successful write through this router clears the server-side vocabulary
 * cache (shared/masterVocabulary.js) BEFORE the response is sent.
 *
 * That cache holds each (type, company) list for 60s, and complaints /
 * servicedesk / delivery-tracker validate against it with canonicalValue() /
 * vocabularyValues(). Nothing ever invalidated it on a write, so a zone or
 * project type created through "+ Add new" was refused (or written as NULL) by
 * the very save that followed it, for up to a minute — and a renamed or retired
 * value kept validating for the same window.
 *
 * Router-level rather than a call in each handler: there are ~20 write handlers
 * here (master_values, the master_* tables, bulk imports, reactivate) and a
 * per-handler call is one a future handler forgets. Hooked on res.json because
 * every handler in this file answers with it; clearing before the bytes go out
 * means a client cannot receive "created" and then race a stale cache.
 * Clearing the whole cache is deliberate — it is a handful of small lists and
 * writes are rare, so precision would buy nothing.
 *
 * ⚠ Per process. With several backend instances, another instance still serves
 * its own copy until its TTL expires; the TTL is the bound there.
 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
router.use((req, res, next) => {
  if (!WRITE_METHODS.has(req.method)) return next();
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 400) invalidateVocabularyCache();
    return json(body);
  };
  next();
});

const ADMIN_ROLES = ['super_admin', 'admin'];
// `hr` and `payroll_admin` are in HR_ROLES on employee.routes.js — they are the
// roles allowed to CREATE an employee — but were absent here, so the moment
// GET /master/:type acquired a role gate they would have lost the Department
// and Designation pickers on the form they are the intended users of.
const READ_ROLES  = ['super_admin', 'admin', 'hr', 'hr_manager', 'hr_exec', 'payroll_admin',
                     'finance_manager', 'accounts_exec',
                     'procurement_manager', 'procurement_exec', 'production_manager',
                     'production_engineer', 'qc_manager', 'store_keeper', 'manager',
                     'sales_manager', 'sales_exec', 'project_manager', 'department_head'];

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS master_departments (
        id        SERIAL PRIMARY KEY,
        name      VARCHAR(100) NOT NULL UNIQUE,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS master_zones (
        id        SERIAL PRIMARY KEY,
        name      VARCHAR(100) NOT NULL UNIQUE,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS master_designations (
        id        SERIAL PRIMARY KEY,
        name      VARCHAR(100) NOT NULL UNIQUE,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS master_uom (
        id           SERIAL PRIMARY KEY,
        code         VARCHAR(20)  NOT NULL UNIQUE,
        name         VARCHAR(100) NOT NULL,
        category     VARCHAR(50)  NOT NULL DEFAULT 'General',
        is_active    BOOLEAN      NOT NULL DEFAULT true,
        created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS master_hsn_sac (
        id           SERIAL PRIMARY KEY,
        code         VARCHAR(20)  NOT NULL UNIQUE,
        description  VARCHAR(255) NOT NULL,
        gst_rate     NUMERIC(5,2) NOT NULL DEFAULT 0,
        type         VARCHAR(3)   NOT NULL DEFAULT 'HSN' CHECK (type IN ('HSN','SAC')),
        is_active    BOOLEAN      NOT NULL DEFAULT true,
        created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS master_grades (
        id         SERIAL PRIMARY KEY,
        company_id INTEGER REFERENCES companies(id),
        name       VARCHAR(50) NOT NULL,
        is_active  BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (company_id, name)
      );
      CREATE TABLE IF NOT EXISTS master_bands (
        id         SERIAL PRIMARY KEY,
        company_id INTEGER REFERENCES companies(id),
        name       VARCHAR(50) NOT NULL,
        is_active  BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (company_id, name)
      );
    `);
  } catch (e) {
    console.error('[master] table init failed:', e.message);
  }
})();

// The employee fallback in GET /:type surfaces legacy free-text values as rows
// with id: null, so clients can hand us "null" here. Postgres answers that with
// a 22P02 500 ("invalid input syntax for type integer"); reject it up front.
const numericId = (raw) => {
  const t = String(raw ?? '').trim();
  if (!/^[0-9]+$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
};

/**
 * The company-scoped rows this caller may read or modify.
 *
 * A super admin with no company assignment carries `req.scope.isGlobal`, which
 * means "every company" — not "no company". companyOf() returns null for that
 * caller *and* for an unscoped one, so the two have to be told apart here: fed
 * straight into `(company_id IS NULL OR company_id = $1)` a global admin sees
 * only the shared rows, and the same null in a write predicate matches nothing.
 *
 * Global scope → no filter. Everyone else → their own company's rows plus the
 * shared (company_id IS NULL) ones, which is what the reads always returned.
 */
const companyScope = (req, startAt, col = 'company_id') =>
  req.scope?.isGlobal === true
    ? { where: '', params: [] }
    : { where: ` AND (${col} IS NULL OR ${col} = $${startAt})`, params: [companyOf(req)] };

/**
 * Management views ask for retired rows; pickers must never get them.
 *
 * ⚠ The DEFAULT is active-only, and it has to stay that way. Every
 * <MasterSelect> in the app calls these endpoints with no query string, and a
 * retired department appearing in the Add Employee dropdown is the exact
 * failure deactivation exists to prevent. `?include_inactive=1` is opt-in and
 * only Master Data Setup sends it.
 */
const wantsInactive = (req) => req.query.include_inactive === '1' || req.query.include_inactive === 'true';
const activeClause  = (req, alias = '') =>
  (wantsInactive(req) ? '' : ` AND ${alias}is_active = true`);

/** Usage counting is a multi-table scan, so it is opt-in too. */
const wantsUsage = (req) => req.query.usage === '1' || req.query.usage === 'true';

/** users.id of the caller, for created_by / updated_by. NOT employees.id. */
const actorOf = (req) => req.user?.userId ?? req.user?.id ?? null;

/**
 * Normalised duplicate check for the five organisation masters.
 *
 * `ux_master_*_name_norm` enforces this at the database — this exists to turn
 * the 23505 into a sentence that names the value that already exists, which an
 * index cannot do. Both halves are needed: the index closes the race, the
 * lookup explains the refusal.
 */
const findDuplicateName = async (table, name, { companyId, scoped, excludeId }) => {
  const params = [String(name).trim()];
  let scope = '';
  if (scoped) { params.push(companyId ?? null); scope = ` AND COALESCE(company_id, 0) = COALESCE($2::int, 0)`; }
  const { rows } = await pool.query(
    `SELECT id, name FROM ${table}
      WHERE LOWER(BTRIM(name)) = LOWER(BTRIM($1)) AND is_active = true${scope}`,
    params);
  return rows.find(r => String(r.id) !== String(excludeId ?? '')) || null;
};

const dupNameMessage = (label, existing) =>
  `"${existing}" is already ${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label.toLowerCase()}. ` +
  `Names are compared ignoring case and spacing, so "Engineering" and "engineering" are the same value.`;

/**
 * Attach a usage count to every row of a list, in ONE query, only when asked.
 *
 * Master Data Setup draws "8 employees" beside each row. Doing that per row
 * would be 24 designations x 3 references = 72 round trips for one page.
 */
const withUsage = async (req, rows, refs) => {
  if (!wantsUsage(req) || !rows.length || !refs.length) return rows;
  const counts = await countUsageBulk(
    refs, rows.map(r => r.name), companyOf(req), req.scope?.isGlobal === true);
  return rows.map(r => {
    const u = counts[String(r.name ?? '').trim().toLowerCase()] || { total: 0, breakdown: [] };
    return { ...r, usage_count: u.total, usage: u.breakdown };
  });
};

/**
 * Delete or deactivate?
 *
 * ⚠ These masters are referenced BY NAME, not by foreign key, so a hard delete
 * cannot orphan a row or violate a constraint — the employee keeps the string
 * 'Engineering' either way. See modules/master/usage.js. The rule is therefore
 * about intent, and about one concrete surprise: GET /master/:type unions the
 * master list with the DISTINCT values on employees, so hard-deleting a value
 * people are filed under makes it reappear immediately as an `unmanaged` row
 * with no id, which cannot be renamed or retired. Deleting it would not remove
 * it; it would only make it unmanageable.
 *
 *   referenced      -> refuse a hard delete, say by what, deactivate instead
 *   not referenced  -> `?hard=1` permanently deletes; without it, deactivate
 *
 * Deactivation is always available and always lossless.
 */
const deleteVerdict = async (req, refs, name) => {
  const usage = await countUsage(refs, name, companyOf(req), req.scope?.isGlobal === true);
  const askedHard = req.query.hard === '1' || req.query.hard === 'true';
  if (askedHard && usage.total > 0) {
    return {
      refuse: true,
      usage,
      body: {
        error: `"${name}" is in use by ${describeUsage(usage.breakdown)}, so it cannot be deleted. ` +
               `Deactivate it instead — it will stop being offered on new records and every existing one keeps it.`,
        usage_count: usage.total,
        usage: usage.breakdown,
        remedy: 'deactivate',
      },
    };
  }
  return { refuse: false, hard: askedHard && usage.total === 0, usage: usage.breakdown };
};

const TABLES = {
  departments:  'master_departments',
  zones:        'master_zones',
  designations: 'master_designations',
  uom:          'master_uom',
  hsn:          'master_hsn_sac',
};

// Grades and bands are company-scoped (different CRUD from generic TABLES)
const COMPANY_TABLES = {
  grades: 'master_grades',
  bands:  'master_bands',
};

/**
 * captureBefore() for a table that is only known once the request arrives.
 *
 * The UOM and HSN handlers below name their table at mount time and so take
 * `captureBefore('master_uom')` directly. The generic `/:type` handlers cannot:
 * the table comes out of TABLES[req.params.type]. Without this, a rename or a
 * retire on departments/zones/designations/grades/bands reached the audit log
 * with `old_data_json: null` — the entry recorded that a name was changed but
 * not what it was changed FROM, which for a vocabulary every employee row and
 * report filter references is the only question worth asking afterwards.
 *
 * Middlewares are memoised per table: captureBefore() validates the identifier
 * and closes over a scope cache, so rebuilding one per request would throw away
 * the information_schema lookup it exists to amortise.
 */
const beforeByTable = new Map();
const captureBeforeParam = (lookup) => (req, res, next) => {
  const table = lookup[req.params.type];
  if (!table) return next();
  if (!beforeByTable.has(table)) beforeByTable.set(table, captureBefore(table));
  return beforeByTable.get(table)(req, res, next);
};

// GET /master/grades and /master/bands
['grades', 'bands'].forEach(type => {
  const table = COMPANY_TABLES[type];

  router.get(`/${type}`, allowRoles(...READ_ROLES), async (req, res) => {
    const { where, params } = companyScope(req, 1, 'm.company_id');
    try {
      const { rows } = await pool.query(
        `SELECT m.id, m.name, m.is_active, m.created_at, m.updated_at,
                cb.name AS created_by_name, ub.name AS updated_by_name
           FROM ${table} m
           LEFT JOIN users cb ON cb.id = m.created_by
           LEFT JOIN users ub ON ub.id = m.updated_by
          WHERE TRUE${activeClause(req, 'm.')}${where}
          ORDER BY m.name`,
        params
      );
      res.json(await withUsage(req, rows, USAGE[type] || []));
    } catch (err) { respondError(res, err); }
  });

  // Usage detail for ONE row — what the confirm dialog shows before a rename or
  // a retire. Separate from the list so the list stays cheap.
  router.get(`/${type}/:id/usage`, allowRoles(...READ_ROLES), async (req, res) => {
    const id = numericId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const { where, params } = companyScope(req, 2);
    try {
      const { rows } = await pool.query(
        `SELECT name FROM ${table} WHERE id = $1${where}`, [id, ...params]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(await countUsage(USAGE[type] || [], rows[0].name, companyOf(req), req.scope?.isGlobal === true));
    } catch (err) { respondError(res, err); }
  });

  // Bring a retired value back. The unique index is PARTIAL on is_active, so a
  // name freed by retirement can have been taken since — this can legitimately
  // 409, and saying so beats a 23505 from the UPDATE.
  router.post(`/${type}/:id/reactivate`, allowRoles(...ADMIN_ROLES), captureBefore(table), async (req, res) => {
    const id = numericId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const { where, params } = companyScope(req, 2);
    try {
      const { rows } = await pool.query(
        `SELECT name, company_id FROM ${table} WHERE id = $1${where}`, [id, ...params]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      const clash = await findDuplicateName(table, rows[0].name,
        { companyId: rows[0].company_id, scoped: true, excludeId: id });
      if (clash) return res.status(409).json({ error: dupNameMessage(type.slice(0, -1), clash.name) });
      await pool.query(
        `UPDATE ${table} SET is_active = true, updated_at = NOW(), updated_by = $2 WHERE id = $1`,
        [id, actorOf(req)]);
      res.json({ success: true });
    } catch (err) { respondError(res, err); }
  });

  router.post(`/${type}`, allowRoles(...ADMIN_ROLES), async (req, res) => {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    // Who owns the new row. A super admin with a genuinely global scope creates a
    // shared (company_id NULL) row on purpose — it belongs to every tenant. Nobody
    // else may: companyOf() also returns null for an admin whose scope resolved to
    // no company, and letting that through silently publishes the row into every
    // tenant's list. Same "null means two different things" collapse companyScope()
    // handles on the read side, caught here on the write side.
    const cid = companyOf(req);
    if (cid === null && req.scope?.isGlobal !== true) {
      return res.status(400).json({ error: 'No company in scope — cannot create a shared record.' });
    }
    try {
      const dup = await findDuplicateName(table, name, { companyId: cid, scoped: true });
      if (dup) return res.status(409).json({ error: dupNameMessage(type.slice(0, -1), dup.name), existing: dup });
      const { rows } = await pool.query(
        `INSERT INTO ${table} (company_id, name, created_by) VALUES ($1, $2, $3) RETURNING id, name`,
        [cid, name.trim(), actorOf(req)]
      );
      res.json(rows[0]);
    } catch (err) {
      // The index speaks for the race the SELECT above cannot close.
      if (err.code === '23505') return res.status(409).json({ error: dupNameMessage(type.slice(0, -1), name.trim()) });
      respondError(res, err);
    }
  });

  router.put(`/${type}/:id`, allowRoles(...ADMIN_ROLES), captureBefore(table), async (req, res) => {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    const id = numericId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    // Scoped so an admin cannot rename another tenant's row by guessing its id.
    // A row outside the caller's scope is a 404, same as one that doesn't exist.
    const { where, params } = companyScope(req, 4);
    try {
      const dup = await findDuplicateName(table, name, { companyId: companyOf(req), scoped: true, excludeId: id });
      if (dup) return res.status(409).json({ error: dupNameMessage(type.slice(0, -1), dup.name), existing: dup });
      const r = await pool.query(
        `UPDATE ${table} SET name = $1, updated_at = NOW(), updated_by = $3 WHERE id = $2${where}`,
        [name.trim(), id, actorOf(req), ...params]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'Not found' });
      res.json({ success: true });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: dupNameMessage(type.slice(0, -1), name.trim()) });
      respondError(res, err);
    }
  });

  router.delete(`/${type}/:id`, allowRoles(...ADMIN_ROLES), captureBefore(table), async (req, res) => {
    const id = numericId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const { where, params } = companyScope(req, 2);
    try {
      const { rows } = await pool.query(
        `SELECT name FROM ${table} WHERE id = $1${where}`, [id, ...params]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      const verdict = await deleteVerdict(req, USAGE[type] || [], rows[0].name);
      if (verdict.refuse) return res.status(409).json(verdict.body);
      if (verdict.hard) {
        await pool.query(`DELETE FROM ${table} WHERE id = $1${where}`, [id, ...params]);
        return res.json({ success: true, deleted: 'permanently' });
      }
      await pool.query(
        `UPDATE ${table} SET is_active = false, updated_at = NOW(), updated_by = $2 WHERE id = $1${where}`,
        [id, actorOf(req), ...params]);
      res.json({ success: true, deleted: 'deactivated', usage: verdict.usage });
    } catch (err) { respondError(res, err); }
  });
});

// ── UOM-specific routes (override generic — code + name + category) ───────────
router.get('/uom', allowRoles(...READ_ROLES), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, code, name, category FROM master_uom WHERE is_active = true ORDER BY code`
    );
    res.json(rows);
  } catch (err) { respondError(res, err); }
});

router.post('/uom', allowRoles(...ADMIN_ROLES), async (req, res) => {
  const { code, name, category } = req.body;
  if (!code?.trim() || !name?.trim()) return res.status(400).json({ error: 'code and name are required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO master_uom (code, name, category) VALUES ($1, $2, $3) RETURNING id, code, name, category`,
      [code.trim().toUpperCase(), name.trim(), category?.trim() || 'General']
    );
    res.json(rows[0]);
  } catch (err) { respondError(res, err); }
});

router.put('/uom/:id', allowRoles(...ADMIN_ROLES), captureBefore('master_uom'), async (req, res) => {
  const { code, name, category } = req.body;
  try {
    await pool.query(
      `UPDATE master_uom SET code = COALESCE($1, code), name = COALESCE($2, name), category = COALESCE($3, category) WHERE id = $4`,
      [code?.trim().toUpperCase() || null, name?.trim() || null, category?.trim() || null, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { respondError(res, err); }
});

router.delete('/uom/:id', allowRoles(...ADMIN_ROLES), captureBefore('master_uom'), async (req, res) => {
  try {
    await pool.query(`UPDATE master_uom SET is_active = false WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { respondError(res, err); }
});

// ── HSN/SAC-specific routes (code + description + gst_rate + type) ────────────
router.get('/hsn', allowRoles(...READ_ROLES), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, code, description, gst_rate, type FROM master_hsn_sac WHERE is_active = true ORDER BY code`
    );
    res.json(rows);
  } catch (err) { respondError(res, err); }
});

router.post('/hsn', allowRoles(...ADMIN_ROLES), async (req, res) => {
  const { code, description, gst_rate, type } = req.body;
  if (!code?.trim() || !description?.trim()) return res.status(400).json({ error: 'code and description are required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO master_hsn_sac (code, description, gst_rate, type) VALUES ($1, $2, $3, $4) RETURNING id, code, description, gst_rate, type`,
      [code.trim(), description.trim(), parseFloat(gst_rate) || 0, (type || 'HSN').toUpperCase()]
    );
    res.json(rows[0]);
  } catch (err) { respondError(res, err); }
});

router.put('/hsn/:id', allowRoles(...ADMIN_ROLES), captureBefore('master_hsn_sac'), async (req, res) => {
  const { code, description, gst_rate, type } = req.body;
  try {
    await pool.query(
      `UPDATE master_hsn_sac SET code = COALESCE($1, code), description = COALESCE($2, description), gst_rate = COALESCE($3, gst_rate), type = COALESCE($4, type) WHERE id = $5`,
      [code?.trim() || null, description?.trim() || null, (() => { const n = parseFloat(gst_rate); return isNaN(n) ? null : n; })(), type ? type.toUpperCase() : null, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { respondError(res, err); }
});

router.delete('/hsn/:id', allowRoles(...ADMIN_ROLES), captureBefore('master_hsn_sac'), async (req, res) => {
  try {
    await pool.query(`UPDATE master_hsn_sac SET is_active = false WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { respondError(res, err); }
});

// ── /master/v/:vocab — module master vocabularies (master_values) ─────────────
//
// One generic CRUD over `master_values`, keyed by the REGISTRY in
// ./vocabularies.js. Registered BEFORE the generic `/:type` handlers at the
// bottom of this file on purpose: `PUT /:type/:id` would otherwise match
// `PUT /v/industries` and try to rename a table named "v".
//
// Row ownership, which is the whole of the tenant story here:
//   company_id IS NULL  a shared default, seeded by migration, readable by every
//                       tenant. Writable only by a genuinely global super admin
//                       — one tenant must not rename or retire a row the other
//                       tenants are reading. A scoped admin gets 409 with the
//                       reason, not a silent no-op.
//   company_id = <cid>  the tenant's own addition. Theirs to rename and retire.
// Every POST creates the second kind unless the caller is global.

const vocabOf = (req, res) => {
  const entry = BY_KEY[req.params.vocab];
  if (!entry) { res.status(404).json({ error: `Unknown master vocabulary '${req.params.vocab}'` }); return null; }
  if (RESERVED_TYPES.has(entry.type)) { res.status(404).json({ error: 'Not a manageable vocabulary' }); return null; }
  return entry;
};

const article = (label) => (/^[aeiou]/i.test(label) ? 'an' : 'a');
const dupMessage = (entry, value) =>
  `"${value}" is already ${article(entry.label)} ${entry.label.toLowerCase()}.`;

// GET /master/v — the registry itself, so Master Data Setup renders its tabs,
// and <VocabSelect> resolves its label and its addRoles, from the same list the
// API enforces. A second copy in the frontend is how the "+ Add new…" option
// ends up offered to someone whose POST comes back 403.
router.get('/v', (req, res) => {
  res.json(REGISTRY.map((e) => ({
    key: e.key, type: e.type, label: e.label, module: e.module,
    columns: e.columns, roles: writeRoles(e), endpoint: `/master/v/${e.key}`,
    // Present only on a two-level vocabulary. `parentOf` names the vocabulary
    // whose value scopes this one, so a picker knows to cascade rather than
    // offering every child of every parent at once.
    ...(e.parentOf ? { parentOf: e.parentOf, parentLabel: BY_KEY[e.parentOf]?.label ?? null } : {}),
  })));
});

/**
 * The master_values.id of a parent value, for a two-level vocabulary.
 *
 * Callers pass the parent by NAME (`?parent=Travel`), not by id: the page that
 * needs the child list already holds the parent's stored text — it is what is
 * on the record — and asking it to carry an id as well would make the picker's
 * contract depend on a lookup it has no reason to do.
 *
 * Returns undefined for "no such parent", which is deliberately different from
 * null: an unknown parent yields an EMPTY child list, not every child.
 */
const parentIdOf = async (req, entry, parentName) => {
  const parent = BY_KEY[entry.parentOf];
  if (!parent) return undefined;
  const t = String(parentName ?? '').trim();
  if (!t) return undefined;
  const { where, params } = companyScope(req, 2);
  const { rows } = await pool.query(
    `SELECT id FROM master_values
      WHERE type = $1 AND is_active = true
        AND LOWER(BTRIM(value)) = LOWER(BTRIM($${2 + params.length}))${where}
      ORDER BY (company_id IS NULL) ASC LIMIT 1`,
    [parent.type, ...params, t]
  );
  return rows[0]?.id;
};

// GET /master/v/:vocab — reference data, so any authenticated caller. Same
// rationale as GET /:type below: a self-service travel form needs travel types.
//
// `?parent=<name>` narrows a two-level vocabulary to one parent's children.
// Without it a child vocabulary returns EVERY child, which is what Master Data
// Setup wants (the full list, with its parent named) and what a cascading form
// picker does not.
router.get('/v/:vocab', async (req, res) => {
  const entry = vocabOf(req, res);
  if (!entry) return;
  // The query joins master_values to itself for the parent name, so every
  // column reference has to be qualified — hence the explicit 'm.' here rather
  // than the bare default the single-table handlers use.
  const { where, params } = companyScope(req, 2, 'm.company_id');

  let parentClause = '';
  const extra = [];
  if (entry.parentOf && req.query.parent !== undefined) {
    const pid = await parentIdOf(req, entry, req.query.parent);
    // An unknown parent must yield nothing, not everything — a cascading picker
    // showing all children under a parent that does not exist is worse than an
    // empty one, because it invites choosing a value the record cannot mean.
    if (pid === undefined) return res.json([]);
    extra.push(pid);
    parentClause = ` AND m.parent_id = $${1 + params.length + extra.length}`;
  }

  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.value AS name, m.code, m.sort_order, m.parent_id,
              p.value AS parent_name, (m.company_id IS NULL) AS is_shared,
              m.is_active, m.created_at, m.updated_at,
              cb.name AS created_by_name, ub.name AS updated_by_name
         FROM master_values m
         LEFT JOIN master_values p ON p.id = m.parent_id
         LEFT JOIN users cb ON cb.id = m.created_by
         LEFT JOIN users ub ON ub.id = m.updated_by
        WHERE m.type = $1${activeClause(req, 'm.')}${where}${parentClause}
        ORDER BY m.sort_order NULLS LAST, m.value`,
      [entry.type, ...params, ...extra]
    );
    res.json(await withUsage(req, rows, usageForVocab(req.params.vocab)));
  } catch (err) { respondError(res, err); }
});

const duplicateOf = async (req, entry, value, excludeId = null) => {
  const { where, params } = companyScope(req, 2);
  const { rows } = await pool.query(
    `SELECT id, value, (company_id IS NULL) AS is_shared
       FROM master_values
      WHERE type = $1 AND is_active = true
        AND LOWER(BTRIM(value)) = LOWER(BTRIM($${2 + params.length}))${where}`,
    [entry.type, ...params, value]
  );
  return rows.find(r => String(r.id) !== String(excludeId)) || null;
};

// A scoped admin's null company_id means "no company", not "every company" —
// the same collapse companyScope() untangles on the read side. Creating a
// shared row from it would publish one tenant's vocabulary into all of them.
async function createVocabValue(req, res, entry) {
  const value = String(req.body?.name ?? req.body?.value ?? '').trim();
  const code  = String(req.body?.code ?? '').trim().toUpperCase() || null;
  if (!value) return res.status(400).json({ error: `${entry.label} name is required` });
  if (value.length > 100) return res.status(400).json({ error: `${entry.label} name must be 100 characters or fewer` });

  const cid = companyOf(req);
  const isGlobal = req.scope?.isGlobal === true;
  if (cid === null && !isGlobal) {
    return res.status(400).json({ error: 'No company in scope — cannot create a shared record.' });
  }

  // A child vocabulary is meaningless without its parent: an expense category
  // with no expense type is a row no cascading picker will ever show again.
  // Refused up front rather than written and then invisible.
  let parentId = null;
  if (entry.parentOf) {
    const parentLabel = BY_KEY[entry.parentOf]?.label ?? 'parent';
    const given = req.body?.parent;
    if (given === undefined || String(given).trim() === '') {
      return res.status(400).json({
        error: `${article(parentLabel) === 'an' ? 'An' : 'A'} ${parentLabel.toLowerCase()} is required for a new ${entry.label.toLowerCase()}.`,
      });
    }
    parentId = await parentIdOf(req, entry, given);
    if (parentId === undefined) {
      return res.status(400).json({ error: `"${given}" is not ${article(parentLabel)} ${parentLabel.toLowerCase()}.` });
    }
  }

  try {
    const dup = await duplicateOf(req, entry, value);
    if (dup) {
      return res.status(409).json({
        error: dupMessage(entry, dup.value),
        existing: { id: dup.id, name: dup.value },
      });
    }
    const { rows } = await pool.query(
      `INSERT INTO master_values (type, value, code, company_id, parent_id, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, true, $6)
       RETURNING id, value AS name, code, sort_order, parent_id, (company_id IS NULL) AS is_shared`,
      [entry.type, value, code, isGlobal ? null : cid, parentId, actorOf(req)]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    // The unique index speaks for the race the SELECT above cannot close.
    if (err.code === '23505') return res.status(409).json({ error: dupMessage(entry, value) });
    return respondError(res, err);
  }
}

// The row a rename or retire may touch: the caller's own, never a shared one.
// A shared row outside a global scope is a 409 that says why, because a 404
// here would read as "that value does not exist" when the user can plainly see
// it in the list.
const rowById = async (entry, id) => {
  const { rows } = await pool.query(
    `SELECT id, value, company_id FROM master_values WHERE id = $1 AND type = $2`,
    [id, entry.type]
  );
  return rows[0] || null;
};

const guardWrite = (req, res, row) => {
  if (!row) { res.status(404).json({ error: 'Not found' }); return false; }
  const isGlobal = req.scope?.isGlobal === true;
  if (row.company_id === null && !isGlobal) {
    res.status(409).json({
      error: 'This is a built-in value shared across companies. Add your own value instead, or ask a system administrator to change it.',
    });
    return false;
  }
  if (row.company_id !== null && !isGlobal && row.company_id !== companyOf(req)) {
    res.status(404).json({ error: 'Not found' });
    return false;
  }
  return true;
};

// allowRoles is per-vocabulary, so it cannot be a static mount argument — it is
// invoked inside the handler once the registry entry is known. An unknown
// vocabulary is answered 404 before any role is consulted, which is deliberate:
// probing for which vocabularies exist should not depend on who is asking.
const withWriteRole = (handler) => (req, res) => {
  const entry = vocabOf(req, res);
  if (!entry) return;
  allowRoles(...writeRoles(entry))(req, res, () => handler(req, res, entry));
};

router.post('/v/:vocab', withWriteRole(createVocabValue));

/*
 * ⚠ These two sit BELOW withWriteRole / rowById / guardWrite / duplicateOf on
 * purpose, and must stay there.
 *
 * `withWriteRole(...)` is INVOKED when the route is registered, not when it is
 * called. It is a `const`, so registering a route above its declaration is a
 * temporal-dead-zone ReferenceError thrown while the module is being imported —
 * which takes the whole server down at boot, not the one endpoint. (Drafted
 * above the helpers first; the server refused to start.) eslint's no-undef does
 * not flag a TDZ violation on an in-file const, so the only check is that the
 * process actually boots.
 */
// Usage detail for ONE vocabulary value. The reference list comes from the
// registry entry's own `columns`, which is the same declaration the audit
// report and the seeding migration read — not a second copy.
router.get('/v/:vocab/:id/usage', async (req, res) => {
  const entry = vocabOf(req, res);
  if (!entry) return;
  const id = numericId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const row = await rowById(entry, id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(await countUsage(usageForVocab(req.params.vocab), row.value,
                              companyOf(req), req.scope?.isGlobal === true));
  } catch (err) { respondError(res, err); }
});

// Bring a retired vocabulary value back.
router.post('/v/:vocab/:id/reactivate', captureBefore('master_values'), withWriteRole(async (req, res, entry) => {
  const id = numericId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const row = await rowById(entry, id);
    if (!guardWrite(req, res, row)) return;
    // duplicateOf only looks at ACTIVE rows, so this is exactly the question:
    // has the name been taken since this one was retired?
    const clash = await duplicateOf(req, entry, row.value, id);
    if (clash) return res.status(409).json({ error: dupMessage(entry, clash.value) });
    await pool.query(
      `UPDATE master_values SET is_active = true, updated_at = NOW(), updated_by = $2 WHERE id = $1`,
      [id, actorOf(req)]);
    return res.json({ success: true });
  } catch (err) { return respondError(res, err); }
}));

// Does the caller already see this value? Checked against shared + own rows,
// not just own: a tenant adding "Technology" when the shared default already
// says "Technology" would put the same word in the dropdown twice. The unique
// index added by 20260916000010 catches the own-row half of this at the
// database; this catches the shared half, which no index can express.

router.put('/v/:vocab/:id', captureBefore('master_values'), withWriteRole(async (req, res, entry) => {
  const id = numericId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const value = String(req.body?.name ?? req.body?.value ?? '').trim();
  if (!value) return res.status(400).json({ error: `${entry.label} name is required` });
  try {
    const row = await rowById(entry, id);
    if (!guardWrite(req, res, row)) return;
    const dup = await duplicateOf(req, entry, value, id);
    if (dup) return res.status(409).json({ error: dupMessage(entry, dup.value) });
    const { rows } = await pool.query(
      `UPDATE master_values SET value = $1, code = COALESCE($2, code) WHERE id = $3
       RETURNING id, value AS name, code, sort_order, (company_id IS NULL) AS is_shared`,
      [value, String(req.body?.code ?? '').trim().toUpperCase() || null, id]
    );
    return res.json(rows[0]);
  } catch (err) { return respondError(res, err); }
}));

// Soft delete. Rows already written onto transaction records keep their text —
// deactivating a vocabulary entry stops it being offered, it does not rewrite
// history, and MasterSelect still renders an out-of-list stored value.
router.delete('/v/:vocab/:id', captureBefore('master_values'), withWriteRole(async (req, res, entry) => {
  const id = numericId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const row = await rowById(entry, id);
    if (!guardWrite(req, res, row)) return;
    const verdict = await deleteVerdict(req, usageForVocab(req.params.vocab), row.value);
    if (verdict.refuse) return res.status(409).json(verdict.body);
    if (verdict.hard) {
      await pool.query(`DELETE FROM master_values WHERE id = $1`, [id]);
      return res.json({ success: true, deleted: 'permanently' });
    }
    await pool.query(
      `UPDATE master_values SET is_active = false, updated_at = NOW(), updated_by = $2 WHERE id = $1`,
      [id, actorOf(req)]);
    return res.json({ success: true, deleted: 'deactivated', usage: verdict.usage });
  } catch (err) { return respondError(res, err); }
}));

// POST /master/departments/bulk — wizard step 2
router.post('/departments/bulk', allowRoles(...ADMIN_ROLES), async (req, res) => {
  const { departments } = req.body;
  if (!Array.isArray(departments) || departments.length === 0) {
    return res.json({ inserted: 0 });
  }
  try {
    let inserted = 0;
    for (const dept of departments) {
      const name = (dept.name || '').trim();
      if (!name) continue;
      const result = await pool.query(
        // Untargeted ON CONFLICT: the plain unique constraint on `name` was
        // dropped by 20260929000002 for the case-insensitive partial index
        // ux_master_departments_name_norm, so `ON CONFLICT (name)` errored on every
        // call. This skips a name already active in any case or spacing.
        `INSERT INTO master_departments (name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id`,
        [name]
      );
      if (result.rowCount > 0) inserted++;
    }
    res.json({ inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /master/designations/bulk — wizard step 2
router.post('/designations/bulk', allowRoles(...ADMIN_ROLES), async (req, res) => {
  const { designations } = req.body;
  if (!Array.isArray(designations) || designations.length === 0) {
    return res.json({ inserted: 0 });
  }
  try {
    let inserted = 0;
    for (const desig of designations) {
      const name = (desig.name || '').trim();
      if (!name) continue;
      const result = await pool.query(
        // Untargeted ON CONFLICT: the plain unique constraint on `name` was
        // dropped by 20260929000002 for the case-insensitive partial index
        // ux_master_designations_name_norm, so `ON CONFLICT (name)` errored on every
        // call. This skips a name already active in any case or spacing.
        `INSERT INTO master_designations (name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id`,
        [name]
      );
      if (result.rowCount > 0) inserted++;
    }
    res.json({ inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET all active items for a type — reference data (departments/zones/designations)
// needed by self-service forms (travel, expense, leave), so readable by any
// authenticated user. Writes below remain admin-only.
/**
 * The employees-derived fallback, scoped to ONE company.
 *
 * ⚠ This query had no company predicate. `master_departments`,
 * `master_designations` and `master_zones` are genuinely shared tables (no
 * company_id column — verified against information_schema, not the migrations),
 * so the master half of this list is global by design. The EMPLOYEES half is
 * not: `SELECT DISTINCT department FROM employees` with no filter put every
 * other tenant's department and job-title strings into this tenant's dropdown,
 * and — because employee.service.js mirrored the same unscoped fallback on the
 * write side — made them ACCEPTED VALUES on save too. Company structure is not
 * public data, and one tenant's private org chart must not become another
 * tenant's vocabulary.
 *
 * Exported so employee.service.js validates against exactly the list this
 * offers. A picker and its validator that disagree is how "QA Automation" got
 * submitted for a designation the master has never held.
 */
export async function employeeDerivedValues(column, companyId, isGlobal = false) {
  const ALLOWED = { department: 1, zone: 1, designation: 1 };
  if (!ALLOWED[column]) return [];
  const scoped = isGlobal ? '' : ' AND ($1::int IS NULL OR company_id = $1)';
  const { rows } = await pool.query(
    `SELECT DISTINCT ${column} AS name FROM employees
      WHERE ${column} IS NOT NULL AND TRIM(${column}) <> ''
        AND deleted_at IS NULL${scoped}
      ORDER BY ${column}`,
    isGlobal ? [] : [companyId ?? null],
  );
  return rows;
}

const EMPLOYEE_FALLBACK_COLS = { departments: 'department', zones: 'zone', designations: 'designation' };

// Gated, like every other read in this file. It was the one route here with no
// allowRoles at all — reachable by any authenticated caller, including the
// `employee` role, and it is the route that returns the company's department
// and job-title vocabulary.
router.get('/:type', allowRoles(...READ_ROLES), async (req, res) => {
  const table = TABLES[req.params.type];
  if (!table) return res.status(400).json({ error: 'Invalid type' });
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.name, m.is_active, m.created_at, m.updated_at,
              cb.name AS created_by_name, ub.name AS updated_by_name
         FROM ${table} m
         LEFT JOIN users cb ON cb.id = m.created_by
         LEFT JOIN users ub ON ub.id = m.updated_by
        WHERE TRUE${activeClause(req, 'm.')}
        ORDER BY m.name`
    );

    // Departments/zones/designations: the master list is often unseeded, so fall
    // back to the values actually in use on THIS COMPANY's employees. That also
    // makes a legacy free-typed value reappear as an option next time instead of
    // rendering blank and being wiped on the next save.
    const empCol = EMPLOYEE_FALLBACK_COLS[req.params.type];
    if (empCol) {
      const have = new Set(rows.map(r => (r.name || '').trim().toLowerCase()));
      const empRows = await employeeDerivedValues(empCol, companyOf(req), req.scope?.isGlobal === true);
      for (const e of empRows) {
        const key = (e.name || '').trim().toLowerCase();
        // unmanaged: no row in the master table, so it has no id — callers must
        // not offer rename/delete on it, nor use it as a foreign key value.
        if (key && !have.has(key)) { have.add(key); rows.push({ id: null, name: e.name, unmanaged: true, is_active: true }); }
      }
      rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }

    res.json(await withUsage(req, rows, USAGE[req.params.type] || []));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Usage detail for ONE row of departments / designations / zones.
router.get('/:type/:id/usage', allowRoles(...READ_ROLES), async (req, res) => {
  const table = TABLES[req.params.type];
  if (!table) return res.status(400).json({ error: 'Invalid type' });
  const id = numericId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const { rows } = await pool.query(`SELECT name FROM ${table} WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(await countUsage(USAGE[req.params.type] || [], rows[0].name,
                              companyOf(req), req.scope?.isGlobal === true));
  } catch (err) { respondError(res, err); }
});

// Bring a retired value back.
//
// ⚠ These three tables are SHARED (no company_id — verified against
// information_schema, not the migrations), so reactivating one affects every
// tenant. That is the established architecture for departments, designations
// and zones and is not changed here; it is why this is ADMIN_ROLES only.
router.post('/:type/:id/reactivate', allowRoles(...ADMIN_ROLES), captureBeforeParam(TABLES), async (req, res) => {
  const table = TABLES[req.params.type];
  if (!table) return res.status(400).json({ error: 'Invalid type' });
  const id = numericId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const { rows } = await pool.query(`SELECT name FROM ${table} WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    // The unique index is partial on is_active, so the name may have been
    // re-used while this row was retired.
    const clash = await findDuplicateName(table, rows[0].name, { scoped: false, excludeId: id });
    if (clash) {
      return res.status(409).json({
        error: `"${clash.name}" is already active. Reactivating this one would create a duplicate — ` +
               `rename or retire the active value first.`,
      });
    }
    await pool.query(
      `UPDATE ${table} SET is_active = true, updated_at = NOW(), updated_by = $2 WHERE id = $1`,
      [id, actorOf(req)]);
    res.json({ success: true });
  } catch (err) { respondError(res, err); }
});

// POST /master/zones — zones are also creatable by HR (the Zone picker's
// "+ Add new" on Add/Edit Employee), not just admins. Registered before the
// generic /:type so it takes precedence. Idempotent: re-posting an existing name
// (ignoring case and spacing) returns that zone, reviving it if it was retired.
//
// ⚠ This was `INSERT … ON CONFLICT (name) DO UPDATE`, which needs a plain unique
// constraint on `name`. 20260929000002_master_data_governance.js dropped that
// constraint for the case-insensitive partial index ux_master_zones_name_norm,
// so every call failed with "no unique or exclusion constraint matching the ON
// CONFLICT specification" — no zone could be added from the picker at all. The
// lookup below follows that index's rule (LOWER(BTRIM(name)), active rows), and
// a 23505 from a concurrent insert of the same name returns the winner's row.
router.post('/zones', allowRoles(...ADMIN_ROLES, 'hr', 'hr_manager', 'hr_exec'), async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const sameName = `SELECT id, name, is_active FROM master_zones
                     WHERE LOWER(BTRIM(name)) = LOWER(BTRIM($1))
                     ORDER BY is_active DESC, id DESC LIMIT 1`;
  try {
    const { rows: [existing] } = await pool.query(sameName, [name]);
    if (existing?.is_active) return res.json({ id: existing.id, name: existing.name });
    if (existing) {
      const { rows } = await pool.query(
        `UPDATE master_zones SET is_active = true, updated_at = NOW(), updated_by = $2
          WHERE id = $1 RETURNING id, name`,
        [existing.id, actorOf(req)]);
      return res.json(rows[0]);
    }
    const { rows } = await pool.query(
      `INSERT INTO master_zones (name, created_by) VALUES ($1, $2) RETURNING id, name`,
      [name, actorOf(req)]);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      const { rows: [winner] } = await pool.query(sameName, [name]).catch(() => ({ rows: [] }));
      if (winner?.is_active) return res.json({ id: winner.id, name: winner.name });
    }
    respondError(res, err);
  }
});

// POST create item — admin only
router.post('/:type', allowRoles(...ADMIN_ROLES), async (req, res) => {
  const table = TABLES[req.params.type];
  if (!table) return res.status(400).json({ error: 'Invalid type' });
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  try {
    const dup = await findDuplicateName(table, name, { scoped: false });
    if (dup) {
      return res.status(409).json({
        error: dupNameMessage(req.params.type.slice(0, -1), dup.name),
        existing: { id: dup.id, name: dup.name },
      });
    }
    const { rows } = await pool.query(
      `INSERT INTO ${table} (name, created_by) VALUES ($1, $2) RETURNING id, name`,
      [name.trim(), actorOf(req)]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: dupNameMessage(req.params.type.slice(0, -1), name.trim()) });
    }
    respondError(res, err);
  }
});

// PUT update item — admin only
router.put('/:type/:id', allowRoles(...ADMIN_ROLES), captureBeforeParam(TABLES), async (req, res) => {
  const table = TABLES[req.params.type];
  if (!table) return res.status(400).json({ error: 'Invalid type' });
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const id = numericId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const dup = await findDuplicateName(table, name, { scoped: false, excludeId: id });
    if (dup) {
      return res.status(409).json({
        error: dupNameMessage(req.params.type.slice(0, -1), dup.name),
        existing: { id: dup.id, name: dup.name },
      });
    }
    const r = await pool.query(
      `UPDATE ${table} SET name = $1, updated_at = NOW(), updated_by = $3 WHERE id = $2`,
      [name.trim(), id, actorOf(req)]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: dupNameMessage(req.params.type.slice(0, -1), name.trim()) });
    }
    respondError(res, err);
  }
});

/**
 * DELETE — deactivate by default, permanently delete only when nothing uses it.
 *
 * `?hard=1` asks for a permanent delete and is REFUSED with a 409 naming the
 * references when the value is in use. Without it, or when the caller does not
 * want to risk it, the row is deactivated: it stops being offered on new
 * records and every existing record keeps it. See deleteVerdict().
 */
router.delete('/:type/:id', allowRoles(...ADMIN_ROLES), captureBeforeParam(TABLES), async (req, res) => {
  const table = TABLES[req.params.type];
  if (!table) return res.status(400).json({ error: 'Invalid type' });
  const id = numericId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const { rows } = await pool.query(`SELECT name FROM ${table} WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const verdict = await deleteVerdict(req, USAGE[req.params.type] || [], rows[0].name);
    if (verdict.refuse) return res.status(409).json(verdict.body);
    if (verdict.hard) {
      await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
      return res.json({ success: true, deleted: 'permanently' });
    }
    await pool.query(
      `UPDATE ${table} SET is_active = false, updated_at = NOW(), updated_by = $2 WHERE id = $1`,
      [id, actorOf(req)]);
    res.json({ success: true, deleted: 'deactivated', usage: verdict.usage });
  } catch (err) {
    respondError(res, err);
  }
});

export default router;
