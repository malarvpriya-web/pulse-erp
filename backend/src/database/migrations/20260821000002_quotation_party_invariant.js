/**
 * Enforce, in the database, the rule the CRM consolidation established for
 * opportunity → quotation:
 *
 *     A quotation raised from an opportunity carries the SAME canonical party
 *     as that opportunity's CRM account extension.
 *
 * ── What went wrong ────────────────────────────────────────────────────────
 * `POST /crm/opportunities/:id/create-quotation` resolves the party correctly
 * (opportunity → accounts.party_id → parties.id) and always stamps a matching
 * customer_name. But it is not the only writer. The 20 Aug empty-table seeding
 * sweep inserted quotation `Q-01795-SEED00795` by picking each foreign key
 * independently, producing one row that named three different customers at once:
 *
 *     opportunity_id → 5 → account 4 → party 5463f141… "NextGen Corp"
 *     customer_id    → ea94b2c7…                       "Office Supplies Co"
 *     customer_name  → free text                       "Aurora Systems"
 *
 * It also left `opportunities.quotation_id` NULL on opportunity 5 while the
 * quotation pointed back at it, which defeats the duplicate-quotation guard in
 * create-quotation (it reads opp.quotation_id) — a second quotation could have
 * been raised against the same opportunity.
 *
 * An application-layer check could not have caught this, because the writer was
 * not the application. Hence a trigger.
 *
 * ── What the trigger does ──────────────────────────────────────────────────
 * On INSERT/UPDATE of quotations:
 *   • if opportunity_id is set and that opportunity has an account with a party,
 *     customer_id must equal that party — otherwise raise (SQLSTATE 23514).
 *   • customer_name is stamped from parties.name whenever customer_id is set,
 *     so the denormalised copy cannot drift from its own foreign key. This
 *     mirrors what `accounts.account_name GENERATED ALWAYS AS (name)` did for
 *     the accounts pair; a generated column cannot be used here because the
 *     value comes from another table.
 *
 * A quotation with no opportunity_id is untouched by the first rule — direct
 * quotations to a customer remain valid.
 */

export async function up(knex) {
  // ── 1. Repair the one violating row ──────────────────────────────────────
  // The opportunity link is the trustworthy side: it resolves through the
  // canonical chain (opportunity → account → party). customer_id/customer_name
  // were independently randomised by the seeder and carry no other referent.
  const { rows: repaired } = await knex.raw(`
    UPDATE quotations q
       SET customer_id   = a.party_id,
           customer_name = p.name,
           updated_at    = NOW()
      FROM opportunities o
      JOIN accounts a ON a.id = o.account_id AND a.deleted_at IS NULL
      JOIN parties  p ON p.id = a.party_id
     WHERE q.opportunity_id = o.id
       AND q.customer_id IS DISTINCT FROM a.party_id
     RETURNING q.id, q.quotation_number
  `);
  if (repaired.length) {
    console.log(`   ↳ repaired quotation party linkage on ${repaired.length} row(s): ` +
      repaired.map(r => r.quotation_number).join(', '));
  }

  // Names that agree with the FK but were stored stale.
  await knex.raw(`
    UPDATE quotations q SET customer_name = p.name
      FROM parties p
     WHERE p.id = q.customer_id
       AND q.customer_name IS DISTINCT FROM p.name
  `);

  // ── 2. Restore missing opportunity → quotation back-references ───────────
  const { rows: relinked } = await knex.raw(`
    UPDATE opportunities o
       SET quotation_id = q.id, updated_at = NOW()
      FROM quotations q
     WHERE q.opportunity_id = o.id
       AND o.quotation_id IS NULL
       AND o.deleted_at IS NULL
     RETURNING o.id
  `);
  if (relinked.length) {
    console.log(`   ↳ restored quotation back-reference on ${relinked.length} opportunity(ies)`);
  }

  // ── 3. The guard ─────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION crm_quotation_party_guard() RETURNS trigger AS $fn$
    DECLARE
      opp_party uuid;
      opp_name  text;
    BEGIN
      IF NEW.opportunity_id IS NOT NULL THEN
        SELECT a.party_id INTO opp_party
          FROM opportunities o
          JOIN accounts a ON a.id = o.account_id AND a.deleted_at IS NULL
         WHERE o.id = NEW.opportunity_id;

        IF opp_party IS NOT NULL AND NEW.customer_id IS DISTINCT FROM opp_party THEN
          RAISE EXCEPTION
            'quotation customer (%) does not match the canonical party of opportunity % (%)',
            NEW.customer_id, NEW.opportunity_id, opp_party
            USING ERRCODE = 'check_violation';
        END IF;

        -- An opportunity with a customer must hand it down.
        IF opp_party IS NOT NULL AND NEW.customer_id IS NULL THEN
          NEW.customer_id := opp_party;
        END IF;
      END IF;

      IF NEW.customer_id IS NOT NULL THEN
        SELECT name INTO opp_name FROM parties WHERE id = NEW.customer_id;
        IF opp_name IS NOT NULL THEN NEW.customer_name := opp_name; END IF;
      END IF;

      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `);

  await knex.raw(`DROP TRIGGER IF EXISTS trg_quotation_party_guard ON quotations;`);
  await knex.raw(`
    CREATE TRIGGER trg_quotation_party_guard
      BEFORE INSERT OR UPDATE OF customer_id, customer_name, opportunity_id ON quotations
      FOR EACH ROW EXECUTE FUNCTION crm_quotation_party_guard();
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_quotation_party_guard ON quotations;`);
  await knex.raw(`DROP FUNCTION IF EXISTS crm_quotation_party_guard();`);
}
