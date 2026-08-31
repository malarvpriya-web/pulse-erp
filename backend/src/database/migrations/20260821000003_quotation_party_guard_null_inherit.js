/**
 * Fix the ordering bug in crm_quotation_party_guard (20260821000002).
 *
 * The function compared first and inherited second:
 *
 *     IF opp_party IS NOT NULL AND NEW.customer_id IS DISTINCT FROM opp_party
 *       THEN RAISE ...
 *     IF opp_party IS NOT NULL AND NEW.customer_id IS NULL
 *       THEN NEW.customer_id := opp_party;
 *
 * `NULL IS DISTINCT FROM <uuid>` is TRUE, so the RAISE fired before the inherit
 * branch could ever run. An INSERT that supplied an opportunity but no explicit
 * customer — the intended "let the opportunity hand its customer down" path —
 * was rejected with "quotation customer (<NULL>) does not match ...".
 *
 * Caught by integration.crmCustomerIntegrity's "inherits the opportunity's party
 * when customer_id is omitted" case. Inherit first, then compare.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION crm_quotation_party_guard() RETURNS trigger AS $fn$
    DECLARE
      opp_party  uuid;
      party_name text;
    BEGIN
      IF NEW.opportunity_id IS NOT NULL THEN
        SELECT a.party_id INTO opp_party
          FROM opportunities o
          JOIN accounts a ON a.id = o.account_id AND a.deleted_at IS NULL
         WHERE o.id = NEW.opportunity_id;

        -- Inherit BEFORE comparing: an omitted customer is the opportunity
        -- handing its own down, not a disagreement with it.
        IF opp_party IS NOT NULL AND NEW.customer_id IS NULL THEN
          NEW.customer_id := opp_party;
        END IF;

        IF opp_party IS NOT NULL AND NEW.customer_id <> opp_party THEN
          RAISE EXCEPTION
            'quotation customer (%) does not match the canonical party of opportunity % (%)',
            NEW.customer_id, NEW.opportunity_id, opp_party
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;

      IF NEW.customer_id IS NOT NULL THEN
        SELECT name INTO party_name FROM parties WHERE id = NEW.customer_id;
        IF party_name IS NOT NULL THEN NEW.customer_name := party_name; END IF;
      END IF;

      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `);
}

export async function down(knex) {
  // Restores the 20260821000002 body, ordering bug and all, so the pair is a
  // clean round trip.
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
}
