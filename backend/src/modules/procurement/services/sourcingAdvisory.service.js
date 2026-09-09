/**
 * sourcingAdvisory.service.js — put the recorded sourcing strategy in front of
 * the person actually spending the money.
 *
 * WHY
 * ---
 * The sourcing board does real work: it positions a category on spend and supply
 * risk, records the method chosen for it, freezes the facts that decision was
 * made against, and writes the approved vendor list and the preferred price.
 *
 * And nothing in the buying workflow read any of it. A buyer could raise an
 * order, or award an event, straight past a strategy recorded a week earlier,
 * and no screen, response or column would mention it. The decision and the
 * record of the decision never met — which is the difference between a strategy
 * and a document about a strategy.
 *
 * This is advisory, deliberately. It matches how the rest of the module treats
 * this class of judgement: the TCO engine reports that a cheaper total cost
 * exists and never blocks the award, and the RFx engine records
 * `followed_recommendation` rather than refusing a buyer who diverges. There
 * are good reasons to buy against a strategy and this service does not know
 * them; it only makes sure nobody can say they were unaware of it.
 *
 * ⚠ WHAT "FOLLOWED" MEANS, AND WHY IT IS NARROW
 * ----------------------------------------------
 * A strategy names a METHOD — 'function_spec', 'demand pooling', 'supplier
 * consolidation'. There is no mechanical reading of a purchase order that says
 * whether a method was applied, and inventing one would put a fabricated
 * judgement into a column that finance and audit will later read as fact.
 *
 * So `followed` answers only the question the data can answer: was this vendor
 * one the strategy's own selection approved? `approved_vendor_list` is written
 * by selectPreferredVendor as part of recording a strategy, so an AVL entry IS
 * the strategy's verdict on a supplier, in the strategy's own words.
 *
 *   true   the vendor is approved on the AVL for a line item in this category
 *   false  a strategy is on file, the vendor is not approved under it
 *   null   the question does not apply — no strategy for the category, no
 *          catalogued item to attribute one through, or no vendor yet
 *
 * `null` is never coerced to `false`. "We did not follow the strategy" and "no
 * strategy exists" are different facts, and a report that conflates them
 * accuses a buyer of something that never happened.
 */

/**
 * @param {import('pg').PoolClient|import('pg').Pool} db  a transaction client, or the pool
 * @param {{companyId: number|null, itemIds: Array<number|string>, vendorId: number|string|null}} ctx
 * @returns {Promise<{strategy: object|null, followed: boolean|null, reason: string, category_ids: number[]}>}
 */
export async function resolveSourcingAdvisory(db, { companyId, itemIds = [], vendorId = null }) {
  const items = [...new Set(itemIds.map((i) => parseInt(i, 10)).filter(Number.isFinite))];
  const none = (reason) => ({ strategy: null, followed: null, reason, category_ids: [] });
  const uncategorisedLabel = 'uncategorised';

  if (!items.length) return none('No catalogued component on this order, so no category to attribute a strategy to.');

  /**
   * The categories these lines belong to.
   *
   * ⚠ An item with NO category is not outside the scheme — it is in the
   * UNCATEGORISED bucket, which the sourcing board treats as a first-class row
   * and which a strategy can be recorded against (`category_id IS NULL`). That
   * matters more than it sounds: not one component in this database carries a
   * category_id, so every rupee of spend sits in that bucket. An earlier draft
   * of this resolver required `category_id IS NOT NULL` and would therefore
   * have returned "no strategy applies" for every order ever raised here —
   * a feature that compiles, passes a green test, and is inert against the
   * real data. The mutation tests caught it by staying green when the logic
   * was broken, which is the only reason it was noticed.
   */
  const { rows: cats } = await db.query(
    `SELECT DISTINCT category_id
       FROM inventory_items
      WHERE id = ANY($1::int[])
        AND ($2::int IS NULL OR company_id = $2)`,
    [items, companyId ?? null]
  );
  const categoryIds  = cats.map((c) => c.category_id).filter((c) => c != null);
  const uncategorised = cats.some((c) => c.category_id == null);
  if (!categoryIds.length && !uncategorised) {
    return none('These components are not in this company, so no sourcing strategy applies.');
  }

  // The strategy in force. Most recently decided wins where a category has more
  // than one; a retired strategy is not in force and is skipped. A NULL
  // category_id on the strategy IS the uncategorised bucket.
  const { rows: [strategy] } = await db.query(
    `SELECT id, category_id, quadrant_key, lever_key, method_key, method_label,
            supplier_segment, status, review_date, target_saving_pct, rationale
       FROM sourcing_category_strategies
      WHERE (category_id = ANY($1::int[]) OR ($2 AND category_id IS NULL))
        AND ($3::int IS NULL OR company_id = $3)
        AND COALESCE(status, 'active') <> 'retired'
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    [categoryIds, uncategorised, companyId ?? null]
  );
  if (!strategy) {
    return { strategy: null, followed: null, category_ids: categoryIds,
             reason: `No sourcing strategy is on file for this ${categoryIds.length ? 'category' : uncategorisedLabel + ' spend'}.` };
  }

  const vendor = parseInt(vendorId, 10);
  if (!Number.isFinite(vendor)) {
    return { strategy, followed: null, category_ids: categoryIds,
             reason: 'No supplier chosen yet, so whether the strategy was followed is undecided.' };
  }

  // The strategy's own verdict on this supplier: an approved AVL row for one of
  // the components being bought.
  const { rows: [approved] } = await db.query(
    `SELECT id, is_preferred FROM approved_vendor_list
      WHERE vendor_id = $1 AND item_id = ANY($2::int[])
        AND LOWER(COALESCE(status, '')) = 'approved'
        AND ($3::int IS NULL OR company_id = $3)
      LIMIT 1`,
    [vendor, items, companyId ?? null]
  );

  return {
    strategy,
    followed: Boolean(approved),
    category_ids: categoryIds,
    reason: approved
      ? `Supplier is approved for this category under "${strategy.method_label || strategy.method_key}".`
      : `Supplier is not on the approved vendor list for this category, whose recorded strategy is "${strategy.method_label || strategy.method_key}". This is recorded, not blocked.`,
  };
}

export default { resolveSourcingAdvisory };
