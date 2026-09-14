/**
 * 20260904000001_quarantine_placeholder_records.js
 *
 * Removes the placeholder records that dominate every revenue metric.
 *
 * WHY
 * ---
 * The CRM parity audit (§153) found two opportunities named `test — Opportunity`
 * and `test1`, both stage `Won`, worth **₹50,000,000 and ₹1,989,009**. Between
 * them they are 95.8% of all recorded won value in this database. Every revenue
 * figure, every win-value chart, every "top customers" list and the forecast
 * accuracy denominator were being driven by two manual smoke-test rows created
 * by the superadmin account.
 *
 * SOFT DELETE, NOT DELETE
 * -----------------------
 * `deleted_at` is set rather than the rows removed. Every read path in this
 * codebase already filters `deleted_at IS NULL`, so this takes them out of all
 * metrics immediately while leaving the rows recoverable — the `down` here is a
 * genuine restore, which a hard DELETE could not offer. Removing data outright
 * is not a migration's call to make when hiding it achieves the same thing.
 *
 * MATCHED BY PREDICATE, NOT BY ID
 * -------------------------------
 * Hardcoded ids would silently no-op on any other environment. The predicate is
 * deliberately narrow: the name must look like a placeholder AND the record must
 * have no commercial document hanging off it. An opportunity someone genuinely
 * named "Test Rig Upgrade" for a customer has a quotation or an order against it
 * and is therefore untouched.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * §153 reported "two duplicate `parties` rows named test need merging". That was
 * WRONG and is corrected here: the two rows are `SUPP-011` (party_type Supplier)
 * and `CUST-023` (party_type Customer). They share a placeholder name and nothing
 * else. Merging a supplier into a customer would have corrupted both the AP and
 * AR sides of the ledger. They are left alone; renaming them is a data-entry
 * decision for whoever owns those records.
 */

const PLACEHOLDER = `~* '^(test|demo|sample|dummy)[0-9]*( |$|—|-)'`;

export async function up(knex) {
  // -- opportunities ----------------------------------------------------------
  // Excluded if ANY commercial document references it: a real deal that happens
  // to be named "test" still produced a quote or an order, and must survive.
  const { rowCount: opps } = await knex.raw(`
    UPDATE opportunities o
       SET deleted_at = NOW(),
           notes = COALESCE(o.notes || E'\\n', '') ||
                   '[2026-09-04] Quarantined as a placeholder record — see migration 20260904000001.'
     WHERE o.deleted_at IS NULL
       AND o.opportunity_name ${PLACEHOLDER}
       AND NOT EXISTS (SELECT 1 FROM quotations  q WHERE q.opportunity_id = o.id)
       AND NOT EXISTS (SELECT 1 FROM sales_orders s WHERE s.quotation_id IN
                        (SELECT id FROM quotations WHERE opportunity_id = o.id))
  `);

  // -- projects auto-created from those opportunities -------------------------
  // The Won stage change spawns a project. A project derived from a quarantined
  // opportunity is quarantined with it, or Projects keeps reporting work that
  // has no deal behind it.
  const { rowCount: projects } = await knex.raw(`
    UPDATE projects p
       SET deleted_at = NOW()
     WHERE p.deleted_at IS NULL
       AND p.opportunity_id IN (SELECT id FROM opportunities WHERE deleted_at IS NOT NULL
                                  AND opportunity_name ${PLACEHOLDER})
  `);

  // -- leads ------------------------------------------------------------------
  // Excluded if the lead converted into an opportunity that SURVIVED the pass
  // above — that makes it a real enquiry regardless of its name.
  const { rowCount: leads } = await knex.raw(`
    UPDATE leads l
       SET deleted_at = NOW(),
           notes = COALESCE(l.notes || E'\\n', '') ||
                   '[2026-09-04] Quarantined as a placeholder record — see migration 20260904000001.'
     WHERE l.deleted_at IS NULL
       AND l.company_name ${PLACEHOLDER}
       AND NOT EXISTS (SELECT 1 FROM opportunities o
                        WHERE o.lead_id = l.id AND o.deleted_at IS NULL)
  `);

  console.log(`[quarantine_placeholder] opportunities=${opps ?? 0} projects=${projects ?? 0} leads=${leads ?? 0}`);
}

export async function down(knex) {
  // A genuine restore — only rows this migration stamped are brought back, so a
  // record soft-deleted for some other reason is not resurrected.
  await knex.raw(`
    UPDATE leads SET deleted_at = NULL,
           notes = NULLIF(regexp_replace(notes, E'\\n?\\\\[2026-09-04\\\\] Quarantined[^\\n]*', '', 'g'), '')
     WHERE notes LIKE '%migration 20260904000001%'
  `);
  await knex.raw(`
    UPDATE projects SET deleted_at = NULL
     WHERE opportunity_id IN (SELECT id FROM opportunities WHERE notes LIKE '%migration 20260904000001%')
  `);
  await knex.raw(`
    UPDATE opportunities SET deleted_at = NULL,
           notes = NULLIF(regexp_replace(notes, E'\\n?\\\\[2026-09-04\\\\] Quarantined[^\\n]*', '', 'g'), '')
     WHERE notes LIKE '%migration 20260904000001%'
  `);
}
