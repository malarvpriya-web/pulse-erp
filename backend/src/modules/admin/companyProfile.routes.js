import { Router } from 'express';
import pool from '../../config/db.js';
import { allowRoles } from '../../middlewares/auth.middleware.js';

const router = Router();

const ADMIN_ROLES = ['super_admin', 'admin'];
const READ_ROLES  = ['super_admin', 'admin', 'hr_manager', 'finance_manager', 'accounts_exec'];

// GSTIN first 2 digits → Indian state name
const GSTIN_STATE_CODES = {
  '01': 'Jammu & Kashmir',   '02': 'Himachal Pradesh',  '03': 'Punjab',
  '04': 'Chandigarh',        '05': 'Uttarakhand',        '06': 'Haryana',
  '07': 'Delhi',              '08': 'Rajasthan',          '09': 'Uttar Pradesh',
  '10': 'Bihar',              '11': 'Sikkim',             '12': 'Arunachal Pradesh',
  '13': 'Nagaland',           '14': 'Manipur',            '15': 'Mizoram',
  '16': 'Tripura',            '17': 'Meghalaya',          '18': 'Assam',
  '19': 'West Bengal',        '20': 'Jharkhand',          '21': 'Odisha',
  '22': 'Chhattisgarh',       '23': 'Madhya Pradesh',     '24': 'Gujarat',
  '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra',        '28': 'Andhra Pradesh',     '29': 'Karnataka',
  '30': 'Goa',                '31': 'Lakshadweep',        '32': 'Kerala',
  '33': 'Tamil Nadu',         '34': 'Puducherry',         '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana',          '37': 'Andhra Pradesh (New)',
};

// Ensure companies table has all required columns
(async () => {
  try {
    await pool.query(`
      ALTER TABLE companies
        ADD COLUMN IF NOT EXISTS gstin      VARCHAR(15),
        ADD COLUMN IF NOT EXISTS pan        VARCHAR(10),
        ADD COLUMN IF NOT EXISTS tan        VARCHAR(10),
        ADD COLUMN IF NOT EXISTS cin        VARCHAR(21),
        ADD COLUMN IF NOT EXISTS logo_url   TEXT,
        ADD COLUMN IF NOT EXISTS phone      VARCHAR(20),
        ADD COLUMN IF NOT EXISTS email      VARCHAR(255),
        ADD COLUMN IF NOT EXISTS website    VARCHAR(255),
        ADD COLUMN IF NOT EXISTS pincode    VARCHAR(10)
    `);
  } catch (e) { console.error('[companyProfile] migration error:', e.message); }
})();

// GET /company-profile — admin/finance roles only (contains PAN, TAN, GSTIN, CIN)
router.get('/', allowRoles(...READ_ROLES), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, code, gstin, pan, tan, cin,
              address, city, state, country, pincode,
              phone, email, website, logo_url, is_active,
              created_at, updated_at
       FROM companies ORDER BY id LIMIT 1`
    );
    if (!rows.length) {
      return res.json(null);
    }
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /company-profile — super_admin / admin only
router.put('/', allowRoles(...ADMIN_ROLES), async (req, res) => {
  const {
    name, gstin, pan, tan, cin,
    address, city, state: stateInput, country, pincode,
    phone, email, website, logo_url,
  } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Company name is required' });
  }

  // Derive state from GSTIN prefix (e.g. "29" → "Karnataka")
  const gstinClean   = (gstin || '').toUpperCase().trim();
  const derivedState = gstinClean.length >= 2
    ? (GSTIN_STATE_CODES[gstinClean.substring(0, 2)] ?? null)
    : null;
  const state = stateInput || derivedState;

  try {
    // Check if any company record exists
    const { rows: existing } = await pool.query('SELECT id FROM companies ORDER BY id LIMIT 1');

    let savedRow;
    if (existing.length) {
      const { rows } = await pool.query(
        `UPDATE companies
         SET name       = $1,
             gstin      = NULLIF(UPPER(TRIM($2)), ''),
             pan        = NULLIF(UPPER(TRIM($3)), ''),
             tan        = NULLIF(UPPER(TRIM($4)), ''),
             cin        = NULLIF(UPPER(TRIM($5)), ''),
             address    = $6,
             city       = $7,
             state      = $8,
             country    = COALESCE(NULLIF($9, ''), 'India'),
             pincode    = $10,
             phone      = $11,
             email      = $12,
             website    = $13,
             logo_url   = $14,
             updated_at = NOW()
         WHERE id = $15
         RETURNING *`,
        [
          name.trim(),
          gstinClean || null, pan || null, tan || null, cin || null,
          address || null, city || null, state || null,
          country || 'India', pincode || null,
          phone || null, email || null, website || null, logo_url || null,
          existing[0].id,
        ]
      );
      savedRow = rows[0];
      res.json(savedRow);
    } else {
      // Create initial company record
      const code = (name.trim().substring(0, 6).toUpperCase().replace(/\s+/g, '') || 'COMP') + '001';
      const { rows } = await pool.query(
        `INSERT INTO companies
           (name, code, gstin, pan, tan, cin, address, city, state, country, pincode, phone, email, website, logo_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING *`,
        [
          name.trim(), code,
          gstinClean || null,
          pan ? pan.toUpperCase().trim() : null,
          tan ? tan.toUpperCase().trim() : null,
          cin ? cin.toUpperCase().trim() : null,
          address || null, city || null, state || null,
          country || 'India', pincode || null,
          phone || null, email || null, website || null, logo_url || null,
        ]
      );
      savedRow = rows[0];
      res.status(201).json(savedRow);
    }

    // Auto-sync Finance Settings GST state from GSTIN (fire-and-forget).
    // This fixes "Finance Settings defaulting to Maharashtra" when company
    // is in Karnataka (GSTIN prefix 29).
    if (derivedState) {
      const cid = req.scope?.company_id ?? null;
      pool.query(
        `INSERT INTO company_settings (company_id, module, settings, updated_at)
         VALUES ($1, 'finance', $2::JSONB, NOW())
         ON CONFLICT (company_id, module)
         DO UPDATE SET settings = company_settings.settings || $2::JSONB, updated_at = NOW()`,
        [cid, JSON.stringify({ place_of_supply_state: derivedState })]
      ).catch(() => {});
    }
  } catch (e) {
    if (e.message.includes('chk_companies_gstin_format')) {
      return res.status(400).json({ error: 'Invalid GSTIN format. Expected: 29AAAAA0000A1Z5' });
    }
    res.status(500).json({ error: e.message });
  }
});

export default router;
