import express from 'express';
import pool from '../../config/db.js';
import { allowRoles } from '../../middlewares/auth.middleware.js';

const router = express.Router();

const ADMIN_ROLES = ['super_admin', 'admin'];
const READ_ROLES  = ['super_admin', 'admin', 'hr_manager', 'hr_exec', 'finance_manager',
                     'procurement_manager', 'procurement_exec', 'production_manager',
                     'production_engineer', 'qc_manager', 'store_keeper', 'manager'];

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

// GET /master/grades and /master/bands
['grades', 'bands'].forEach(type => {
  const table = COMPANY_TABLES[type];

  router.get(`/${type}`, allowRoles(...READ_ROLES), async (req, res) => {
    const cid = req.scope?.company_id ?? null;
    try {
      const { rows } = await pool.query(
        `SELECT id, name FROM ${table} WHERE is_active = true AND (company_id IS NULL OR company_id = $1) ORDER BY name`,
        [cid]
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post(`/${type}`, allowRoles(...ADMIN_ROLES), async (req, res) => {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    const cid = req.scope?.company_id ?? null;
    try {
      const { rows } = await pool.query(
        `INSERT INTO ${table} (company_id, name) VALUES ($1, $2) RETURNING id, name`,
        [cid, name.trim()]
      );
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.put(`/${type}/:id`, allowRoles(...ADMIN_ROLES), async (req, res) => {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    try {
      await pool.query(`UPDATE ${table} SET name = $1 WHERE id = $2`, [name.trim(), req.params.id]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete(`/${type}/:id`, allowRoles(...ADMIN_ROLES), async (req, res) => {
    try {
      await pool.query(`UPDATE ${table} SET is_active = false WHERE id = $1`, [req.params.id]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
});

// ── UOM-specific routes (override generic — code + name + category) ───────────
router.get('/uom', allowRoles(...READ_ROLES), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, code, name, category FROM master_uom WHERE is_active = true ORDER BY code`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/uom/:id', allowRoles(...ADMIN_ROLES), async (req, res) => {
  const { code, name, category } = req.body;
  try {
    await pool.query(
      `UPDATE master_uom SET code = COALESCE($1, code), name = COALESCE($2, name), category = COALESCE($3, category) WHERE id = $4`,
      [code?.trim().toUpperCase() || null, name?.trim() || null, category?.trim() || null, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/uom/:id', allowRoles(...ADMIN_ROLES), async (req, res) => {
  try {
    await pool.query(`UPDATE master_uom SET is_active = false WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── HSN/SAC-specific routes (code + description + gst_rate + type) ────────────
router.get('/hsn', allowRoles(...READ_ROLES), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, code, description, gst_rate, type FROM master_hsn_sac WHERE is_active = true ORDER BY code`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/hsn/:id', allowRoles(...ADMIN_ROLES), async (req, res) => {
  const { code, description, gst_rate, type } = req.body;
  try {
    await pool.query(
      `UPDATE master_hsn_sac SET code = COALESCE($1, code), description = COALESCE($2, description), gst_rate = COALESCE($3, gst_rate), type = COALESCE($4, type) WHERE id = $5`,
      [code?.trim() || null, description?.trim() || null, (() => { const n = parseFloat(gst_rate); return isNaN(n) ? null : n; })(), type ? type.toUpperCase() : null, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/hsn/:id', allowRoles(...ADMIN_ROLES), async (req, res) => {
  try {
    await pool.query(`UPDATE master_hsn_sac SET is_active = false WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
        `INSERT INTO master_departments (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id`,
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
        `INSERT INTO master_designations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id`,
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
router.get('/:type', async (req, res) => {
  const table = TABLES[req.params.type];
  if (!table) return res.status(400).json({ error: 'Invalid type' });
  try {
    const { rows } = await pool.query(
      `SELECT id, name FROM ${table} WHERE is_active = true ORDER BY name`
    );

    // Departments/zones/designations: the master list is often unseeded, so fall
    // back to the values actually in use on employees. This also makes free-typed
    // zones on the employee form reappear as dropdown options next time.
    const EMPLOYEE_FALLBACK_COLS = { departments: 'department', zones: 'zone', designations: 'designation' };
    const empCol = EMPLOYEE_FALLBACK_COLS[req.params.type];
    if (empCol) {
      const have = new Set(rows.map(r => (r.name || '').trim().toLowerCase()));
      const { rows: empRows } = await pool.query(
        `SELECT DISTINCT ${empCol} AS name FROM employees
          WHERE ${empCol} IS NOT NULL AND TRIM(${empCol}) <> ''
          ORDER BY ${empCol}`
      );
      for (const e of empRows) {
        const key = (e.name || '').trim().toLowerCase();
        if (key && !have.has(key)) { have.add(key); rows.push({ id: null, name: e.name }); }
      }
      rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /master/zones — zones are also creatable by HR (typed into the employee
// form's Zone field), not just admins. Registered before the generic /:type
// so it takes precedence. Idempotent: re-posting an existing name returns it.
router.post('/zones', allowRoles(...ADMIN_ROLES, 'hr', 'hr_manager', 'hr_exec'), async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO master_zones (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET is_active = true
       RETURNING id, name`,
      [name.trim()]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create item — admin only
router.post('/:type', allowRoles(...ADMIN_ROLES), async (req, res) => {
  const table = TABLES[req.params.type];
  if (!table) return res.status(400).json({ error: 'Invalid type' });
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO ${table} (name) VALUES ($1) RETURNING id, name`,
      [name.trim()]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update item — admin only
router.put('/:type/:id', allowRoles(...ADMIN_ROLES), async (req, res) => {
  const table = TABLES[req.params.type];
  if (!table) return res.status(400).json({ error: 'Invalid type' });
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  try {
    await pool.query(
      `UPDATE ${table} SET name = $1 WHERE id = $2`,
      [name.trim(), req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE (soft delete — set is_active = false) — admin only
router.delete('/:type/:id', allowRoles(...ADMIN_ROLES), async (req, res) => {
  const table = TABLES[req.params.type];
  if (!table) return res.status(400).json({ error: 'Invalid type' });
  try {
    await pool.query(
      `UPDATE ${table} SET is_active = false WHERE id = $1`,
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
