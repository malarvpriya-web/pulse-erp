import pool from '../../shared/db.js';
import { nextItemCode } from '../../../shared/docNumber.js';
import { parseAbcOverride, abcOverrideSetSql } from '../services/inventoryPlanning.service.js';
import { vocabularyValues } from '../../../shared/masterVocabulary.js';

// abc_class from Item Master is a planner's OVERRIDE, and abc_class_source
// records it (migration 20261021000009). parseAbcOverride is the one reading of
// the field: absent = leave ownership alone, blank = return to the calculated
// class, A/B/C = pin it manually, anything else = 400. It used to coerce junk
// and absence alike to NULL, so a PUT that did not mention abc_class wiped it.

/** A request field that failed validation. 422 + field errors, like validate(). */
export class ItemValidationError extends Error {
  constructor(errors) {
    super(errors.map(e => e.message).join(' '));
    this.name = 'ItemValidationError';
    this.status = 422;
    this.errors = errors;
  }
}

/**
 * The editable inventory_items fields and how a supplied value is read.
 * `blank` is what an explicit '' / null means — the defaults the full-row
 * update used to apply, kept so Item Master's blank form fields mean what they
 * always meant. Lengths are the column widths, so an over-long value is a 422
 * that names the field rather than a 500 from the database.
 */
export const ITEM_FIELDS = Object.freeze({
  item_name:           { kind: 'text', max: 255, required: true },
  item_type:           { kind: 'text', max: 50 },
  unit_of_measure:     { kind: 'text', max: 20, blank: 'pcs' },
  reorder_level:       { kind: 'number', min: 0, blank: 0 },
  safety_stock:        { kind: 'number', min: 0, blank: 0 },
  standard_cost:       { kind: 'number', min: 0, blank: 0 },
  gst_rate:            { kind: 'number', min: 0, max: 100, blank: 0 },
  lead_time_days:      { kind: 'integer', min: 0, blank: 7 },
  hsn_code:            { kind: 'text', max: 8 },
  manufacturer:        { kind: 'text', max: 200 },
  description:         { kind: 'text' },
  product_model:       { kind: 'text', max: 120 },
  is_active:           { kind: 'boolean', blank: true },
  category_id:         { kind: 'ref', table: 'item_categories', sharedAllowed: true },
  preferred_vendor_id: { kind: 'ref', table: 'vendors' },
});

/** Identity columns: may be echoed unchanged, never changed. */
const IDENTITY_FIELDS = new Set(['id', 'item_code', 'company_id']);

function coerceField(key, spec, raw) {
  const blank = raw === null || (typeof raw === 'string' && raw.trim() === '');
  if (blank) {
    if (spec.required) return { error: `${key} is required.` };
    return { value: spec.blank !== undefined ? spec.blank : null };
  }
  switch (spec.kind) {
    case 'text': {
      if (typeof raw === 'object') return { error: `${key} must be text.` };
      const s = String(raw).trim();
      if (spec.max && s.length > spec.max) return { error: `${key} must be at most ${spec.max} characters.` };
      return { value: s };
    }
    case 'number':
    case 'integer': {
      const n = typeof raw === 'boolean' ? NaN : Number(raw);
      if (!Number.isFinite(n)) return { error: `${key} must be a number.` };
      if (spec.kind === 'integer' && !Number.isInteger(n)) return { error: `${key} must be a whole number.` };
      if (spec.min !== undefined && n < spec.min) return { error: `${key} must be at least ${spec.min}.` };
      if (spec.max !== undefined && n > spec.max) return { error: `${key} must be at most ${spec.max}.` };
      return { value: n };
    }
    case 'boolean':
      if (raw === true || raw === 'true') return { value: true };
      if (raw === false || raw === 'false') return { value: false };
      return { error: `${key} must be true or false.` };
    case 'ref': {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) return { error: `${key} must be a record id.` };
      return { value: n };
    }
    default:
      return { error: `${key} cannot be set.` };
  }
}

/**
 * Freight inputs (§216) — validated TOGETHER, because a weight means nothing
 * without its basis and the unit it is per:
 *   shipping_weight_kg     kg per ONE unit of shipping_weight_uom; blank clears
 *                          the weight AND its basis/unit (never stored as 0)
 *   shipping_weight_basis  quoted | observed | estimated | assumed — required
 *                          with a weight; there is no default
 *   shipping_weight_uom    the unit the weight is per; defaults to the item's
 *                          unit_of_measure at save, and is stored explicitly
 *   freight_category       a FREIGHT_CATEGORY master value (or blank)
 * Only applied when at least one of the four is in the body.
 */
export const FREIGHT_ITEM_FIELDS = Object.freeze(['shipping_weight_kg', 'shipping_weight_basis', 'shipping_weight_uom', 'freight_category']);
const WEIGHT_BASES = ['quoted', 'observed', 'estimated', 'assumed'];

async function freightItemValues(body, row, companyId) {
  if (!FREIGHT_ITEM_FIELDS.some((k) => Object.prototype.hasOwnProperty.call(body, k))) return { values: null, errors: [] };
  const errors = [];
  const pick = (k) => (Object.prototype.hasOwnProperty.call(body, k) ? body[k] : row?.[k]);
  const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '');
  const values = {};
  const rawW = pick('shipping_weight_kg');
  if (blank(rawW)) {
    values.shipping_weight_kg = null; values.shipping_weight_basis = null; values.shipping_weight_uom = null;
  } else {
    const w = Number(rawW);
    if (!Number.isFinite(w) || w <= 0) errors.push({ field: 'shipping_weight_kg', message: 'shipping_weight_kg must be greater than 0 (leave it blank if the weight is not known).' });
    const basis = blank(pick('shipping_weight_basis')) ? null : String(pick('shipping_weight_basis')).trim().toLowerCase();
    if (!WEIGHT_BASES.includes(basis)) errors.push({ field: 'shipping_weight_basis', message: `shipping_weight_basis is required with a weight: one of ${WEIGHT_BASES.join(', ')}.` });
    const uomRaw = blank(pick('shipping_weight_uom'))
      ? (Object.prototype.hasOwnProperty.call(body, 'unit_of_measure') ? body.unit_of_measure : row?.unit_of_measure)
      : pick('shipping_weight_uom');
    const uom = blank(uomRaw) ? null : String(uomRaw).trim();
    if (!uom) errors.push({ field: 'shipping_weight_uom', message: 'State the unit the weight is per (e.g. NOS, MTR).' });
    else if (uom.length > 20) errors.push({ field: 'shipping_weight_uom', message: 'shipping_weight_uom must be at most 20 characters.' });
    values.shipping_weight_kg = w; values.shipping_weight_basis = basis; values.shipping_weight_uom = uom;
  }
  const rawC = pick('freight_category');
  if (blank(rawC)) {
    values.freight_category = null;
  } else {
    const allowed = await vocabularyValues('FREIGHT_CATEGORY', companyId, ['General', 'Fragile', 'Hazardous', 'Oversize']);
    const hit = allowed.find((v) => v.toLowerCase() === String(rawC).trim().toLowerCase());
    if (!hit) errors.push({ field: 'freight_category', message: `freight_category '${rawC}' is not in the Freight Category master.` });
    values.freight_category = hit ?? null;
  }
  return { values, errors };
}

/** The referenced row exists, is not deleted and belongs to this company. */
async function refBelongsToCompany(spec, id, companyId) {
  const shared = spec.sharedAllowed ? 'OR company_id IS NULL' : '';
  const { rows } = await pool.query(
    `SELECT 1 FROM ${spec.table}
      WHERE id = $1 AND deleted_at IS NULL
        AND ($2::int IS NULL OR company_id = $2 ${shared})`,
    [id, companyId]);
  return rows.length > 0;
}

class InventoryItemRepository {
  async create(data) {
    const {
      item_code, item_name, item_type, unit_of_measure,
      reorder_level, safety_stock, standard_cost,
      inventory_account_id, expense_account_id,
      hsn_code, gst_rate, manufacturer, lead_time_days,
      description, company_id,
      category_id, abc_class, product_model,
    } = data;
    // Creating needs a name — the database refuses a NULL one, and that used to
    // surface as a 500 rather than as the missing field it is.
    const errors = [];
    if (item_name == null || String(item_name).trim() === '') {
      errors.push({ field: 'item_name', message: 'item_name is required.' });
    }
    // A class given at creation is a manual one; none leaves it to the engine.
    let abc = { mode: 'keep', value: null };
    try { abc = parseAbcOverride(abc_class); }
    catch (e) { errors.push({ field: 'abc_class', message: e.message }); }
    const freight = await freightItemValues(data, { unit_of_measure: unit_of_measure ?? 'pcs' }, company_id ?? null);
    errors.push(...freight.errors);
    if (errors.length) throw new ItemValidationError(errors);
    const abcValue = abc.mode === 'set' ? abc.value : null;
    const fv = freight.values || {};

    const result = await pool.query(
      `INSERT INTO inventory_items
         (item_code, item_name, item_type, unit_of_measure,
          reorder_level, safety_stock, standard_cost,
          inventory_account_id, expense_account_id,
          hsn_code, gst_rate, manufacturer, lead_time_days,
          description, company_id, category_id, abc_class, product_model, abc_class_source,
          shipping_weight_kg, shipping_weight_basis, shipping_weight_uom, freight_category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::text,$18,
               CASE WHEN $17::text IS NULL THEN 'calculated' ELSE 'manual' END,
               $19,$20,$21,$22)
       RETURNING *`,
      [
        item_code, item_name, item_type ?? null, unit_of_measure ?? 'pcs',
        reorder_level ?? 0, safety_stock ?? 0, standard_cost ?? 0,
        inventory_account_id ?? null, expense_account_id ?? null,
        hsn_code ?? null, gst_rate ?? 0, manufacturer ?? null, lead_time_days ?? 7,
        description ?? null, company_id ?? null,
        category_id || null, abcValue, product_model || null,
        fv.shipping_weight_kg ?? null, fv.shipping_weight_basis ?? null,
        fv.shipping_weight_uom ?? null, fv.freight_category ?? null,
      ]
    );
    return result.rows[0];
  }

  async findAll(filters = {}) {
    const params = [];

    // Per-store balance when warehouse_id is supplied, global on-hand otherwise.
    // Correlated subquery + COALESCE keeps zero-balance items in the catalog
    // (global-catalog + per-store-balance model — see project_itemmaster_audit_gaps).
    let stockWhCond = '';
    if (filters.warehouse_id != null && filters.warehouse_id !== '') {
      params.push(filters.warehouse_id);
      stockWhCond = ` AND sl.warehouse_id = $${params.length}`;
    }

    let query = `
      SELECT ii.*,
             c.name          AS category_name,
             c.category_code AS category_code,
             COALESCE((
               SELECT SUM(sl.quantity_in - sl.quantity_out)
                 FROM stock_ledger sl
                WHERE sl.item_id = ii.id${stockWhCond}
             ), 0) AS current_stock,
             (SELECT COUNT(*)::int FROM item_vendor_prices ivp
               WHERE ivp.item_id = ii.id AND ivp.deleted_at IS NULL) AS vendor_price_count
        FROM inventory_items ii
        LEFT JOIN item_categories c ON c.id = ii.category_id AND c.deleted_at IS NULL
       WHERE ii.deleted_at IS NULL`;

    if (filters.company_id != null) {
      params.push(filters.company_id);
      query += ` AND ii.company_id = $${params.length}`;
    }

    if (filters.item_type) {
      params.push(filters.item_type);
      query += ` AND ii.item_type = $${params.length}`;
    }

    if (filters.category_id) {
      params.push(filters.category_id);
      query += ` AND ii.category_id = $${params.length}`;
    }

    if (filters.abc_class) {
      params.push(String(filters.abc_class).toUpperCase());
      query += ` AND ii.abc_class = $${params.length}`;
    }

    if (filters.search) {
      params.push(`%${filters.search}%`);
      const p = params.length;
      query += ` AND (ii.item_name ILIKE $${p} OR ii.item_code ILIKE $${p})`;
    }

    if (filters.is_active !== undefined) {
      params.push(filters.is_active);
      query += ` AND ii.is_active = $${params.length}`;
    }

    query += ' ORDER BY ii.item_code';
    const result = await pool.query(query, params);
    return result.rows;
  }

  async findById(id, company_id = null) {
    const params = [id];
    let query = `
      SELECT ii.*,
             c.name          AS category_name,
             c.category_code AS category_code
        FROM inventory_items ii
        LEFT JOIN item_categories c ON c.id = ii.category_id AND c.deleted_at IS NULL
       WHERE ii.id = $1 AND ii.deleted_at IS NULL`;
    if (company_id != null) {
      params.push(company_id);
      query += ` AND ii.company_id = $${params.length}`;
    }
    const result = await pool.query(query, params);
    return result.rows[0];
  }

  /**
   * PARTIAL update: only the fields the caller supplies are written; anything
   * omitted keeps its stored value.
   *
   * This used to be a full-row rewrite — every column was set from the body,
   * with `?? 0` / `?? null` filling whatever was missing. A caller that sent
   * three fields therefore asked the database to set item_name to NULL (a 500
   * on the NOT NULL constraint — Inventory Intelligence's "Save Rule" never
   * once worked) and, had it got past that, would have zeroed the item's cost,
   * stock levels and GST and blanked its description. Item Master happens to
   * send its whole form, so it was the only caller that worked.
   *
   * Contract:
   *   - Fields are validated by ITEM_FIELDS. A supplied blank keeps its old
   *     meaning (numeric blank = 0 / lead time 7, unit blank = 'pcs', text
   *     blank = NULL); item_name may never be blank.
   *   - item_code / id / company_id are identity, not editable: echoing the
   *     current value (Item Master sends item_code) is accepted and ignored,
   *     a different value is refused.
   *   - Any other unknown field is refused, not ignored — silently dropping a
   *     field the caller thinks it saved is how "Save Rule" would have lost the
   *     preferred vendor the old update never wrote.
   *   - category_id / preferred_vendor_id must belong to the caller's company
   *     (a category may also be a shared one with no company). The foreign keys
   *     alone accept another tenant's id.
   *   - abc_class goes through parseAbcOverride (absent = keep ownership).
   * Throws ItemValidationError (status 422, field-level `errors`) and writes
   * nothing when any field is invalid. Returns null when the item is not
   * visible to `company_id`.
   */
  async update(id, data, company_id = null, current = null) {
    const row = current ?? await this.findById(id, company_id);
    if (!row) return null;
    const body = data && typeof data === 'object' ? data : {};
    const errors = [];
    const sets = [];
    const params = [];
    const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    for (const [key, raw] of Object.entries(body)) {
      if (key === 'abc_class' || FREIGHT_ITEM_FIELDS.includes(key)) continue;
      if (IDENTITY_FIELDS.has(key)) {
        if (raw !== undefined && String(raw) !== String(row[key] ?? '')) {
          errors.push({ field: key, message: `${key} cannot be changed.` });
        }
        continue;
      }
      const spec = ITEM_FIELDS[key];
      if (!spec) { errors.push({ field: key, message: `${key} is not an editable item field.` }); continue; }
      if (raw === undefined) continue;
      const { value, error } = coerceField(key, spec, raw);
      if (error) { errors.push({ field: key, message: error }); continue; }
      if (spec.kind === 'ref' && value != null && !(await refBelongsToCompany(spec, value, row.company_id))) {
        errors.push({ field: key, message: `${key} ${value} does not exist in this company.` });
        continue;
      }
      push(key, value);
    }

    let abc = { mode: 'keep', value: null };
    try { abc = parseAbcOverride(body.abc_class); }
    catch (e) { errors.push({ field: 'abc_class', message: e.message }); }
    const freight = await freightItemValues(body, row, row.company_id);
    errors.push(...freight.errors);
    if (errors.length) throw new ItemValidationError(errors);
    if (freight.values) for (const [k, v] of Object.entries(freight.values)) push(k, v);

    if (abc.mode !== 'keep') {
      params.push(abc.mode, abc.value);
      sets.push(abcOverrideSetSql(`$${params.length - 1}::text`, `$${params.length}::text`));
    }
    if (!sets.length) return row;                         // nothing to change: a no-op, not an error

    params.push(id);
    let whereClause = `WHERE id = $${params.length} AND deleted_at IS NULL`;
    if (company_id != null) {
      params.push(company_id);
      whereClause += ` AND company_id = $${params.length}`;
    }
    const result = await pool.query(
      `UPDATE inventory_items SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
       ${whereClause}
       RETURNING *`,
      params
    );
    return result.rows[0] || null;
  }

  async softDelete(id, company_id = null) {
    const params = [id];
    let whereClause = 'WHERE id = $1 AND deleted_at IS NULL';
    if (company_id != null) {
      params.push(company_id);
      whereClause += ` AND company_id = $${params.length}`;
    }
    const result = await pool.query(
      `UPDATE inventory_items SET deleted_at = NOW() ${whereClause} RETURNING id`,
      params
    );
    return result.rows[0] || null;
  }

  async getNextCode(client) {
    return nextItemCode(client);
  }
}

export default new InventoryItemRepository();
