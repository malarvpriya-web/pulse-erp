/**
 * projectTypes.js — the single source of truth for Manifest's project-type list.
 *
 * Lifted out of projects/routes/deliveryTracker.routes.js (which still re-exports
 * it, so its existing import surface is unchanged) because the servicedesk module
 * needs the same list for IPS `service_type`: importing it from a routes file
 * would execute that module's router construction and table init as a side effect.
 *
 * This list is deliberately NOT a DB CHECK constraint — it has already widened
 * once (7 -> 10 entries), and a CHECK would make every future addition a
 * migration. Validate against it in the route layer instead.
 */

export const PROJECT_TYPES = [
  'EPC', 'HVDC', 'STATCOM', 'SST', 'AMC',
  'Installation', 'Commissioning', 'O&M', 'Supply', 'Turnkey',
];

/** Electrical voltage classification — the rollup product_lines.voltage_class uses. */
export const VOLTAGE_CLASSES = ['LV', 'MV', 'HV'];
