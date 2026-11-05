import { Router } from 'express';
import pool from '../../config/db.js';
import { allowRoles } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';
import { GSTIN_STATE_CODES } from '../../shared/gstinStates.js';

const router = Router();

const ADMIN_ROLES = ['super_admin', 'admin'];
const READ_ROLES  = ['super_admin', 'admin', 'hr_manager', 'finance_manager', 'accounts_exec'];

// GSTIN first 2 digits → Indian state name (shared with the payroll release gate)

// The page's state list spells some states differently from GSTIN_STATE_CODES
// ("Jammu and Kashmir" vs "Jammu & Kashmir", "Andhra Pradesh" vs "Andhra
// Pradesh (New)" for code 37), which made a correct GSTIN fail the state check.
const normState = (s) => String(s || '').toLowerCase()
  .replace(/\(new\)/g, '').replace(/&/g, ' and ').replace(/[^a-z]+/g, ' ').trim();

// VARCHAR limits on companies — reported as a 400 naming the field instead of
// a raw "value too long for type character varying(20)" 500.
const MAX_LEN = { gstin: 15, pan: 10, tan: 10, cin: 21, phone: 20, pincode: 10, city: 100, state: 100, country: 100, email: 255, website: 255, name: 255 };
const LABEL   = { gstin: 'GSTIN', pan: 'PAN', tan: 'TAN', cin: 'CIN', phone: 'Phone', pincode: 'Pincode', city: 'City', state: 'State', country: 'Country', email: 'Email', website: 'Website', name: 'Company name' };

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
       FROM companies WHERE id = $1`, [companyOf(req)]
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
  for (const [field, max] of Object.entries(MAX_LEN)) {
    const v = req.body[field];
    if (v != null && String(v).trim().length > max) {
      return res.status(400).json({ error: `${LABEL[field]} must be at most ${max} characters` });
    }
  }

  // Derive state from GSTIN prefix (e.g. "29" → "Karnataka")
  const gstinClean   = (gstin || '').toUpperCase().trim();
  const derivedState = gstinClean.length >= 2
    ? (GSTIN_STATE_CODES[gstinClean.substring(0, 2)] ?? null)
    : null;
  try {
    // The caller's company (PAYROLL_DATA_FLOW_AUDIT.md Part 9). This used to be
    // "the first row of companies", so an admin of any company edited company 1
    // — the legal name, GSTIN and the state payroll's PT/LWF follow.
    const cid = companyOf(req);
    const { rows: existing } = cid == null
      ? { rows: [] }
      : await pool.query('SELECT id, state FROM companies WHERE id = $1', [cid]);
    const { rows: [anyCompany] } = await pool.query('SELECT 1 AS x FROM companies LIMIT 1');
    if (!existing.length && anyCompany) {
      return res.status(400).json({ error: 'Company context required — the profile is saved for your own company only' });
    }

    // An explicit state wins. Without one (the Setup Wizard's company step sends
    // none) the STORED state is kept; the GSTIN prefix only fills a blank state.
    // It used to overwrite the stored state on every save, so a corrected state
    // reverted to the GSTIN's (29 → Karnataka for company 1's placeholder GSTIN).
    const state = stateInput || existing[0]?.state || derivedState;
    // Same rule as the Company Profile page: a GSTIN registers ONE state.
    if (stateInput && derivedState && normState(derivedState) !== normState(stateInput)) {
      return res.status(422).json({ error: `GSTIN code ${gstinClean.substring(0, 2)} is registered in ${derivedState}, but the state given is ${stateInput}. Correct the GSTIN or the state.` });
    }

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
    if (derivedState && savedRow?.id != null) {
      const cid = savedRow.id;
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
    if (e.code === '22001') {
      return res.status(400).json({ error: 'One of the fields is too long — shorten it and save again' });
    }
    res.status(500).json({ error: e.message });
  }
});

export default router;
