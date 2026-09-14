/**
 * heroTones — canonical module → PageHero gradient family.
 *
 * ★ APP-WIDE DECISION (2026-08-20): every module uses `violet`. ★
 *
 * Per-module colour families were built and piloted on Quality, then reverted
 * on the product owner's instruction — one brand gradient across all pages.
 * Do NOT reintroduce a per-module tone without an explicit instruction.
 *
 * `PageHero` already defaults to `violet`, so pages pass no `tone` at all.
 * That is the intended usage: a page carrying an inline `tone=` is how a
 * design system drifts. This map exists as the single lever if the app ever
 * does go back to per-module colour — flip the values here, nothing else.
 *
 * The other gradients (`teal`, `emerald`, `rose`, …) still ship in
 * pulse-hero.css. They are dormant, not dead: they cost nothing, and keeping
 * them means restoring per-module colour is a one-file change.
 */

/** The one brand gradient. `.plh-hero--violet` in pulse-hero.css. */
export const APP_TONE = 'violet';

/**
 * MODULE_TONE — every module, mapped to the single app tone.
 *
 * Kept as an explicit map rather than collapsing to a bare constant so the
 * module list stays visible at the call site and a future per-module scheme
 * has somewhere to land.
 */
export const MODULE_TONE = {
  // people
  hr:            APP_TONE,
  employees:     APP_TONE,
  attendance:    APP_TONE,
  leaves:        APP_TONE,
  recruitment:   APP_TONE,
  performance:   APP_TONE,
  timesheets:    APP_TONE,

  // money
  finance:       APP_TONE,
  travel:        APP_TONE,

  // demand
  crm:           APP_TONE,
  sales:         APP_TONE,
  marketing:     APP_TONE,
  tenders:       APP_TONE,

  // supply
  inventory:     APP_TONE,
  procurement:   APP_TONE,
  assets:        APP_TONE,

  // make
  production:    APP_TONE,
  engineering:   APP_TONE,
  rd:            APP_TONE,

  // conformance
  quality:       APP_TONE,
  compliance:    APP_TONE,
  complaints:    APP_TONE,
  servicedesk:   APP_TONE,

  // deliver
  projects:      APP_TONE,
  operations:    APP_TONE,

  // system
  admin:         APP_TONE,
  settings:      APP_TONE,
  audit:         APP_TONE,
  approvals:     APP_TONE,
  documents:     APP_TONE,
  reports:       APP_TONE,
  analytics:     APP_TONE,
  ai:            APP_TONE,
  iot:           APP_TONE,
  orgchart:      APP_TONE,
  notifications: APP_TONE,
};

/**
 * toneFor — tone for a module key. Every module resolves to the app tone
 * today, including modules not listed above.
 * @param {string} moduleKey e.g. 'quality' (the features/<module>/ folder name)
 * @returns {string}
 */
export const toneFor = (moduleKey) => MODULE_TONE[moduleKey] || APP_TONE;
