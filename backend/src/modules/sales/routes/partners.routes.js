/**
 * partners.routes.js — the Partner (IPU) master grid.
 *
 * Mounted at /api/sales/partners (server.js), AHEAD of the general sales router,
 * which still owns /partners' old siblings (/territories, /competitors). Express
 * matches in registration order, so the general router would otherwise shadow
 * this one — same reason engineering/development is mounted first.
 *
 * Replaces the four inline /partners handlers that used to live in
 * sales.routes.js alongside a top-level CREATE TABLE IIFE. See migration
 * 20260717000004 for the full account of why that table had no migration.
 *
 * State is DERIVED from the GSTIN prefix when one is supplied (see setGstinState)
 * rather than typed independently, so the two can never disagree. GSTIN is
 * validated against utils/gst.js — the same validator Finance uses — and is NOT
 * restricted to Karnataka: partners can be based anywhere in India.
 *
 * Every query is company-scoped via req.scope. The routes this replaces read
 * req.user.company_id, which is unset for superadmin — that made the
 * `($1 IS NULL)` escape hatch fire by accident rather than by scope.
 */

import { Router } from 'express';
import pool from '../../../config/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { validateGSTIN } from '../../../utils/gst.js';
import { companyOf } from '../../../shared/scope.js';
import {
  ASSOCIATION_TYPES, DEFAULT_ASSOCIATION_TYPE, PARTNER_STATUSES,
} from '../../../shared/salesPartners.js';

const router = Router();

// Scoped reads. companyOf() already prefers req.scope over req.user and coerces
// to int/null — don't reach past it for req.user.company_id (see shared/scope.js:
// that path fails OPEN across every tenant on an older token).
const cid = (req) => companyOf(req);
const perm = (action) => requirePermission('sales', action);
const nn = (v) => (v === '' || v === undefined ? null : v);

// commission_pct is NUMERIC(5,2), but `COALESCE($n, 0)` makes Postgres infer the
// PARAMETER from the integer literal `0` and then reject 7.5 with
// "invalid input syntax for type integer". The ::numeric cast below pins the
// parameter to the column's real type — don't drop it. (The UPDATE needs no cast:
// COALESCE($n, commission_pct) infers from the column.)

const BASE_FROM = `FROM sales_partners s`;

// Counting leads per partner in the grid query keeps "View Leads" honest: the
// action is disabled when the count is 0 rather than opening an empty panel.
const LEAD_COUNT_SQL = `
  (SELECT COUNT(*)::int FROM leads l
    WHERE l.partner_id = s.id AND l.deleted_at IS NULL)
`;

// The client sends a key; free text can never reach the ORDER BY.
const SORTABLE = {
  ipu_number:       's.ipu_number',
  name:             's.name',
  association_type: 's.association_type',
  email:            's.email',
  phone:            's.phone',
  website:          's.website',
  city:             's.city',
  state:            's.state',
  country:          's.country',
  gstin:            's.gstin',
  status:           's.status',
  commission_pct:   's.commission_pct',
  lead_count:       'lead_count',
  created_at:       's.created_at',
};

function buildWhere(req) {
  const params = [cid(req)];
  const conds = [
    `s.deleted_at IS NULL`,
    `($1::int IS NULL OR s.company_id = $1)`,
  ];
  const { association_type, status, state, country, city, search } = req.query;

  if (association_type) { params.push(association_type); conds.push(`s.association_type = $${params.length}`); }
  if (status)           { params.push(status);           conds.push(`s.status = $${params.length}`); }
  if (state)            { params.push(state);            conds.push(`s.state = $${params.length}`); }
  if (country)          { params.push(country);          conds.push(`s.country = $${params.length}`); }
  if (city)             { params.push(city);             conds.push(`s.city = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    const i = params.length;
    conds.push(`(s.ipu_number ILIKE $${i} OR s.name ILIKE $${i} OR s.email ILIKE $${i}
                 OR s.phone ILIKE $${i} OR s.gstin ILIKE $${i} OR s.city ILIKE $${i}
                 OR s.state ILIKE $${i} OR s.website ILIKE $${i} OR s.contact_name ILIKE $${i})`);
  }
  return { where: `WHERE ${conds.join(' AND ')}`, params };
}

/**
 * Validates the taxonomy + GSTIN. The taxonomies are not DB CHECK constraints by
 * design (see migration header), so this is the only thing standing between a
 * typo and a permanently unfilterable row.
 */
function validate(body, { partial = false } = {}) {
  const errs = [];
  const has = (k) => body[k] !== undefined && body[k] !== null && body[k] !== '';

  if (!partial && !String(body.name ?? '').trim()) errs.push('name is required');
  if (has('association_type') && !ASSOCIATION_TYPES.includes(body.association_type))
    errs.push(`association_type must be one of: ${ASSOCIATION_TYPES.join(', ')}`);
  if (has('status') && !PARTNER_STATUSES.includes(body.status))
    errs.push(`status must be one of: ${PARTNER_STATUSES.join(', ')}`);
  if (has('email') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email).trim()))
    errs.push('email is not a valid address');
  // GSTIN is optional — but if given it must be real. Any state is accepted.
  if (has('gstin')) {
    const r = validateGSTIN(body.gstin);
    if (!r.valid) errs.push(r.error);
  }
  if (has('commission_pct')) {
    const n = Number(body.commission_pct);
    if (Number.isNaN(n) || n < 0 || n > 100) errs.push('commission_pct must be between 0 and 100');
  }
  return errs;
}

/**
 * Normalises GSTIN to upper case and fills State from its prefix.
 *
 * The GSTIN state code is authoritative: it is the state the party is registered
 * in for GST, and Finance already derives intra-/inter-state supply from it. If a
 * user typed a different State by hand, honouring the typed value would let the
 * grid disagree with the tax treatment of the same partner. An explicitly typed
 * State is still kept when there is no GSTIN to derive from.
 */
function setGstinState(body) {
  const out = { ...body };
  if (nn(out.gstin)) {
    const r = validateGSTIN(out.gstin);
    if (r.valid) {
      out.gstin = String(out.gstin).trim().toUpperCase();
      out.state = r.stateName;
    }
  }
  return out;
}

// A duplicate GSTIN trips uq_sales_partners_gstin. Translate the raw driver error
// into something the drawer can show, instead of a 500.
function sendWriteError(res, err) {
  if (err.code === '23505' && /gstin/i.test(err.constraint ?? '')) {
    return res.status(409).json({ error: 'A partner with this GSTIN already exists.' });
  }
  if (err.code === '23505' && /converted_lead/i.test(err.constraint ?? '')) {
    return res.status(409).json({ error: 'This lead has already been converted to a partner.' });
  }
  return res.status(500).json({ error: err.message });
}

// ── grid ──────────────────────────────────────────────────────────────────────
router.get('/', perm('view'), async (req, res) => {
  try {
    const { where, params } = buildWhere(req);
    const sortCol = SORTABLE[req.query.sort] ?? 's.created_at';
    const dir     = String(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const size    = Math.min(200, Math.max(1, parseInt(req.query.page_size) || 20));
    const page    = Math.max(1, parseInt(req.query.page) || 1);

    const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS n ${BASE_FROM} ${where}`, params);
    const total = countRows[0]?.n ?? 0;

    const { rows } = await pool.query(
      `SELECT s.id, s.ipu_number, s.name, s.association_type, s.email, s.phone,
              s.website, s.city, s.state, s.country, s.gstin, s.status,
              s.contact_name, s.region, s.commission_pct, s.address, s.notes,
              s.converted_from_lead_id,
              ${LEAD_COUNT_SQL} AS lead_count,
              s.created_at, s.updated_at
       ${BASE_FROM} ${where}
       ORDER BY ${sortCol} ${dir} NULLS LAST, s.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, size, (page - 1) * size]
    );

    res.json({ data: rows, total, page, page_size: size, total_pages: Math.ceil(total / size) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── filter options ────────────────────────────────────────────────────────────
// Static lists come from the shared constants so a value with no partner yet is
// still selectable; states/cities come from the data because they are free text.
router.get('/filters', perm('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const [states, cities] = await Promise.all([
      pool.query(
        `SELECT DISTINCT state FROM sales_partners
          WHERE state IS NOT NULL AND state <> '' AND deleted_at IS NULL
            AND ($1::int IS NULL OR company_id = $1)
          ORDER BY state`,
        [companyId]
      ),
      pool.query(
        `SELECT DISTINCT city FROM sales_partners
          WHERE city IS NOT NULL AND city <> '' AND deleted_at IS NULL
            AND ($1::int IS NULL OR company_id = $1)
          ORDER BY city`,
        [companyId]
      ),
    ]);
    res.json({
      association_types: ASSOCIATION_TYPES,
      statuses:          PARTNER_STATUSES,
      states:            states.rows.map(r => r.state),
      cities:            cities.rows.map(r => r.city),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── convertible leads ─────────────────────────────────────────────────────────
// Feeds the Convert to Partner picker. Excludes leads already converted to a
// partner; a lead that became an OPPORTUNITY is still offered, because becoming a
// customer and becoming a channel partner are not mutually exclusive.
router.get('/convertible-leads', perm('view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.company_name, l.contact_person, l.email, l.phone,
              l.location, l.lead_source, l.status
         FROM leads l
        WHERE l.deleted_at IS NULL
          AND ($1::int IS NULL OR l.company_id = $1)
          AND NOT EXISTS (
                SELECT 1 FROM sales_partners p
                 WHERE p.converted_from_lead_id = l.id AND p.deleted_at IS NULL)
        ORDER BY l.company_name`,
      [cid(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── leads for one partner (the "View Leads" action) ───────────────────────────
router.get('/:id/leads', perm('view'), async (req, res) => {
  try {
    const owner = await pool.query(
      `SELECT id, ipu_number, name FROM sales_partners
        WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, cid(req)]
    );
    if (!owner.rows[0]) return res.status(404).json({ error: 'Partner not found' });

    const { rows } = await pool.query(
      `SELECT l.id, l.company_name, l.contact_person, l.email, l.phone,
              l.status, l.lead_source, l.estimated_value, l.zone, l.created_at
         FROM leads l
        WHERE l.partner_id = $1 AND l.deleted_at IS NULL
          AND ($2::int IS NULL OR l.company_id = $2)
        ORDER BY l.created_at DESC`,
      [req.params.id, cid(req)]
    );
    res.json({ partner: owner.rows[0], data: rows, total: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── create ────────────────────────────────────────────────────────────────────
router.post('/', perm('add'), async (req, res) => {
  const errs = validate(req.body);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });

  try {
    const b = setGstinState(req.body);
    // IPU-00001, mirroring seq_ips/IPS-00001. Generated in SQL so concurrent
    // creates can never collide on the number.
    const { rows } = await pool.query(
      `INSERT INTO sales_partners
         (ipu_number, name, association_type, email, phone, website, city, state,
          country, gstin, contact_name, region, commission_pct, address, notes,
          status, company_id, created_by)
       VALUES ('IPU-' || LPAD(nextval('seq_ipu')::text, 5, '0'),
               $1, COALESCE($2, $16), $3, $4, $5, $6, $7, COALESCE($8,'India'),
               $9, $10, $11, COALESCE($12::numeric, 0), $13, $14, COALESCE($15,'active'),
               COALESCE($17, 1), $18)
       RETURNING id, ipu_number`,
      [
        String(b.name).trim(), nn(b.association_type), nn(b.email), nn(b.phone),
        nn(b.website), nn(b.city), nn(b.state), nn(b.country), nn(b.gstin),
        nn(b.contact_name), nn(b.region), nn(b.commission_pct), nn(b.address),
        nn(b.notes), nn(b.status), DEFAULT_ASSOCIATION_TYPE,
        cid(req), req.user?.userId ?? req.user?.id ?? null,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) { sendWriteError(res, err); }
});

// ── update ────────────────────────────────────────────────────────────────────
router.put('/:id', perm('edit'), async (req, res) => {
  const errs = validate(req.body, { partial: true });
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });

  try {
    const b = setGstinState(req.body);
    const { rows } = await pool.query(
      `UPDATE sales_partners SET
         name             = COALESCE($1, name),
         association_type = COALESCE($2, association_type),
         email            = $3,
         phone            = $4,
         website          = $5,
         city             = $6,
         state            = $7,
         country          = $8,
         gstin            = $9,
         contact_name     = $10,
         region           = $11,
         commission_pct   = COALESCE($12, commission_pct),
         address          = $13,
         notes            = $14,
         status           = COALESCE($15, status),
         updated_at       = NOW()
       WHERE id = $16 AND deleted_at IS NULL
         AND ($17::int IS NULL OR company_id = $17)
       RETURNING id, ipu_number`,
      [
        nn(b.name) && String(b.name).trim(), nn(b.association_type), nn(b.email),
        nn(b.phone), nn(b.website), nn(b.city), nn(b.state), nn(b.country),
        nn(b.gstin), nn(b.contact_name), nn(b.region), nn(b.commission_pct),
        nn(b.address), nn(b.notes), nn(b.status),
        req.params.id, cid(req),
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Partner not found' });
    res.json(rows[0]);
  } catch (err) { sendWriteError(res, err); }
});

// ── convert a lead into a partner ─────────────────────────────────────────────
/**
 * POST /convert-lead — the graduation path a lead/prospect takes into a full
 * Partner record, WITHOUT re-typing what the lead already knows.
 *
 * Modelled on POST /crm/leads/:id/convert (lead -> opportunity), which is the
 * house pattern for this: one transaction, FOR UPDATE on the lead so two
 * concurrent converts cannot both win, and a duplicate guard. It differs in one
 * way on purpose — it does NOT mark the lead 'converted'. That status means
 * "became an opportunity" everywhere else in CRM, and reusing it here would make
 * a partner look like a won deal in every funnel report. The link is recorded
 * structurally instead: sales_partners.converted_from_lead_id, plus leads.partner_id
 * pointed back at the new partner so the lead immediately appears under View Leads.
 *
 * Field carry-over is limited by what a lead actually holds: company_name,
 * contact_person, email, phone and location. Leads have NO gstin/website/city/
 * state/country columns, so those stay for the drawer to fill — the body may
 * supply them and they win over the lead's values.
 */
router.post('/convert-lead', perm('add'), async (req, res) => {
  const { lead_id } = req.body;
  if (!lead_id) return res.status(400).json({ error: 'lead_id is required' });

  const errs = validate(req.body, { partial: true });
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the lead row to prevent concurrent double-conversion.
    const leadRes = await client.query(
      `SELECT * FROM leads
        WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)
        FOR UPDATE`,
      [lead_id, cid(req)]
    );
    if (leadRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Lead not found' });
    }
    const lead = leadRes.rows[0];

    const dup = await client.query(
      `SELECT id, ipu_number FROM sales_partners
        WHERE converted_from_lead_id = $1 AND deleted_at IS NULL LIMIT 1`,
      [lead_id]
    );
    if (dup.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `This lead has already been converted to partner ${dup.rows[0].ipu_number}.`,
        partner_id: dup.rows[0].id,
      });
    }

    // The body wins over the lead: the drawer is pre-filled FROM the lead, so an
    // edited value there is a deliberate correction.
    const b = setGstinState({
      ...req.body,
      name:         nn(req.body.name)         ?? lead.company_name,
      contact_name: nn(req.body.contact_name) ?? lead.contact_person,
      email:        nn(req.body.email)        ?? lead.email,
      phone:        nn(req.body.phone)        ?? lead.phone,
      city:         nn(req.body.city)         ?? lead.location,
      region:       nn(req.body.region)       ?? lead.zone,
    });
    if (!String(b.name ?? '').trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The lead has no company name — enter a partner name to convert it.' });
    }

    const ins = await client.query(
      `INSERT INTO sales_partners
         (ipu_number, name, association_type, email, phone, website, city, state,
          country, gstin, contact_name, region, commission_pct, address, notes,
          status, converted_from_lead_id, company_id, created_by)
       VALUES ('IPU-' || LPAD(nextval('seq_ipu')::text, 5, '0'),
               $1, COALESCE($2, $15), $3, $4, $5, $6, $7, COALESCE($8,'India'),
               $9, $10, $11, COALESCE($12::numeric, 0), $13, $14, 'active', $16,
               COALESCE($17, 1), $18)
       RETURNING id, ipu_number, name`,
      [
        String(b.name).trim(), nn(b.association_type), nn(b.email), nn(b.phone),
        nn(b.website), nn(b.city), nn(b.state), nn(b.country), nn(b.gstin),
        nn(b.contact_name), nn(b.region), nn(b.commission_pct), nn(b.address),
        nn(b.notes), DEFAULT_ASSOCIATION_TYPE, lead_id,
        cid(req), req.user?.userId ?? req.user?.id ?? null,
      ]
    );
    const partner = ins.rows[0];

    // Attribute the originating lead to the new partner, so it shows under
    // View Leads straight away. Only when the lead is not already attributed
    // elsewhere — a lead sourced THROUGH partner A that graduates into partner B
    // keeps its A attribution.
    await client.query(
      `UPDATE leads SET partner_id = $1, updated_at = NOW()
        WHERE id = $2 AND partner_id IS NULL`,
      [partner.id, lead_id]
    );

    await client.query('COMMIT');
    res.status(201).json(partner);
  } catch (err) {
    await client.query('ROLLBACK');
    sendWriteError(res, err);
  } finally {
    client.release();
  }
});

// ── delete ────────────────────────────────────────────────────────────────────
// Soft delete — so an IPU number is never reissued and history survives. Leads
// keep pointing at the archived partner (the FK is ON DELETE SET NULL, which only
// fires on a hard delete), so attribution is not silently rewritten.
router.delete('/:id', perm('delete'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE sales_partners SET deleted_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL
          AND ($2::int IS NULL OR company_id = $2)
        RETURNING id`,
      [req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Partner not found' });
    res.json({ message: 'Partner removed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
