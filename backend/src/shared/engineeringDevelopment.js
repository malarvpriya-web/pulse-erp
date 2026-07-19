/**
 * engineeringDevelopment.js — the single source of truth for the Engineering
 * Development (IPD) taxonomies.
 *
 * Lives in shared/ (next to projectTypes.js) so the route layer and any future
 * consumer import the lists from one place rather than each hand-rolling a copy
 * that drifts. Deliberately NOT DB CHECK constraints — see the header of
 * migration 20260717000001 for the reasoning.
 *
 * Category is NOT part of this file: it is the electrical voltage class, and
 * VOLTAGE_CLASSES in projectTypes.js already owns that list (LV/MV/HV).
 */

/**
 * Development lifecycle. Engineering-specific by decision: the production list
 * (PRODUCTION_STAGES) carries handover/dispatched, which are meaningless for a
 * development record, and the R&D list (RDProjects.jsx) has no procurement step.
 * This list keeps `procurement` and `assembly` — the two stages the module
 * actually needed — without importing production's shipping vocabulary.
 */
export const DEV_STATUSES = [
  'design',
  'procurement',
  'assembly',
  'testing',
  'validation',
  'closed',
  'cancelled',
];

/** Statuses that mean the record is finished — used to default actual_close_date. */
export const DEV_TERMINAL_STATUSES = ['closed', 'cancelled'];

/** What kind of development effort this is. */
export const DEV_TYPES = [
  'New Product',
  'Improvement',
  'Cost Reduction',
  'Customization',
  'Obsolescence',
];

/** Where the developed item sits in the assembly hierarchy. */
export const ASSEMBLY_TYPES = ['Main Part', 'Sub Part'];

export const DEV_PRIORITIES = ['low', 'medium', 'high', 'critical'];
