/**
 * salesPartners.js — the single source of truth for the Partner (IPU) taxonomies.
 *
 * Lives in shared/ next to projectTypes.js and engineeringDevelopment.js so the
 * route layer and any future consumer import one list rather than each keeping a
 * copy that drifts. Deliberately NOT DB CHECK constraints — see the header of
 * migration 20260717000004.
 *
 * This file settles a three-way disagreement that existed before it:
 *   - SalesPartners.jsx offered reseller / referral / distributor / technology
 *   - database/crm-sales-advanced-schema.sql (dead) commented "Reseller,
 *     Distributor, Referral, SI"
 *   - accounts.account_type carries its own Capitalized 'Partner'
 * None was authoritative. Confirmed with the business 2026-07-17.
 */

/**
 * How a partner is associated with Manifest. Stored Capitalized and displayed
 * verbatim — matching the accounts.account_type convention rather than the
 * lowercase-slug convention used by engineering statuses, because these are
 * proper nouns the business uses in writing.
 */
export const ASSOCIATION_TYPES = ['System Integrator', 'Partner'];

/** Default for a new partner and for any row with an unrecognised value. */
export const DEFAULT_ASSOCIATION_TYPE = 'Partner';

/** Lifecycle. `active` is the pre-existing default and is kept. */
export const PARTNER_STATUSES = ['active', 'inactive', 'suspended'];
