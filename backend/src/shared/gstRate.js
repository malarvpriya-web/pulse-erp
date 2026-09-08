/**
 * Which GST rate applies to a component.
 *
 * `inventory_items` carries two rate columns and they are not interchangeable:
 *
 *   gst_rate          DEFAULT 0    — the rate set for THIS item, when someone set one
 *   default_gst_rate  DEFAULT 18   — the fallback for an item nobody has rated
 *
 * Four call sites resolved this as `gst_rate ?? default_gst_rate`. That reads
 * correctly and is unreachable: `??` only falls through on NULL, and the column
 * DEFAULTS TO 0, so an item nobody has ever rated holds 0.00 rather than NULL
 * and the fallback never fires. Live proof: all five items in this database
 * carry `gst_rate = 0.00, default_gst_rate = 18.00`, so every one of them was
 * being costed and compared at 0% GST while the master says 18%.
 *
 * That is two of this codebase's recurring traps at once — a column default
 * quietly defining a workflow, and a zero standing in for "never set". The
 * distinction matters commercially: a genuinely nil-rated supply and an
 * unconfigured one are different facts, and only the second should inherit.
 *
 * The rule: a POSITIVE item rate wins; anything else (0, NULL, blank,
 * unparseable) falls back to the master default, then to 0.
 *
 * ⚠ This means an item that is genuinely 0%-rated cannot express that through
 * `gst_rate` alone — set `default_gst_rate` to 0 as well. Making zero mean
 * "unset" was the schema's choice, not this helper's; until the column default
 * changes, this is the only reading under which `default_gst_rate` has any
 * effect at all.
 */

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * @param {object} item  a row carrying `gst_rate` and/or `default_gst_rate`
 * @returns {number} the applicable rate as a percentage (18 means 18%)
 */
export function resolveGstRate(item) {
  if (!item) return 0;
  const own = num(item.gst_rate);
  if (own != null && own > 0) return own;
  const dflt = num(item.default_gst_rate);
  if (dflt != null && dflt > 0) return dflt;
  return 0;
}

export default resolveGstRate;
