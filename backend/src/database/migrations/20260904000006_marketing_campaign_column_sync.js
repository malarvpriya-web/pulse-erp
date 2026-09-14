/**
 * 20260904000006_marketing_campaign_column_sync.js
 *
 * Stops `marketing_campaigns` carrying two column families that can disagree.
 *
 * WHY
 * ---
 * The table has BOTH `name`/`type` and `campaign_name`/`campaign_type`. The
 * application writes only the first pair; the seeder wrote both. So every
 * campaign created through the API has `campaign_name = NULL`, and the create
 * endpoint's `RETURNING *` hands that NULL straight back to the caller — a
 * response that appears to say the campaign has no name.
 *
 * Nothing currently reads the physical `campaign_name`: every reference in the
 * codebase is the alias `mc.name AS campaign_name`. That makes this latent
 * rather than active, which is exactly the state in which it is cheapest to fix
 * and most likely to bite later — the next person to write
 * `SELECT campaign_name FROM marketing_campaigns` gets NULL for every real
 * campaign and no error.
 *
 * WHY A TRIGGER AND NOT A DROP
 * ----------------------------
 * Dropping the columns is tempting: no index, constraint or reader depends on
 * them (verified before writing this). But a DROP is irreversible in practice —
 * the data goes with it — and this tree currently has more than one session
 * working in it, so a column that vanishes underneath an in-flight change is a
 * bad trade for a latent problem. Keeping them SYNCHRONISED removes the failure
 * mode completely while leaving every possible reader correct.
 *
 * A generated column would be the tidiest expression of this, but Postgres
 * cannot convert an existing column to GENERATED — it would mean dropping and
 * re-adding, which is the destructive path again.
 */

export async function up(knex) {
  // Backfill both directions: the app-written rows have name and a NULL mirror;
  // any legacy row with only the mirror keeps its value.
  const { rowCount: filledMirror } = await knex.raw(`
    UPDATE marketing_campaigns
       SET campaign_name = COALESCE(campaign_name, name),
           campaign_type = COALESCE(campaign_type, type)
     WHERE campaign_name IS DISTINCT FROM COALESCE(campaign_name, name)
        OR campaign_type IS DISTINCT FROM COALESCE(campaign_type, type)
  `);

  const { rowCount: filledPrimary } = await knex.raw(`
    UPDATE marketing_campaigns
       SET name = COALESCE(name, campaign_name),
           type = COALESCE(type, campaign_type)
     WHERE name IS NULL OR type IS NULL
  `);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION marketing_campaigns_sync_names()
    RETURNS trigger AS $fn$
    BEGIN
      -- Whichever side the writer used wins; the other mirrors it. COALESCE
      -- order matters: on an UPDATE that changes name, NEW.campaign_name
      -- still holds the OLD value, so the primary column must be preferred.
      -- (No backticks in this comment: it lives inside a JS template
      --  literal and one would end the string.)
      NEW.campaign_name := COALESCE(NEW.name, NEW.campaign_name);
      NEW.campaign_type := COALESCE(NEW.type, NEW.campaign_type);
      NEW.name          := COALESCE(NEW.name, NEW.campaign_name);
      NEW.type          := COALESCE(NEW.type, NEW.campaign_type);
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql
  `);

  await knex.raw(`DROP TRIGGER IF EXISTS trg_marketing_campaigns_sync_names ON marketing_campaigns`);
  await knex.raw(`
    CREATE TRIGGER trg_marketing_campaigns_sync_names
      BEFORE INSERT OR UPDATE ON marketing_campaigns
      FOR EACH ROW EXECUTE FUNCTION marketing_campaigns_sync_names()
  `);

  console.log(`[marketing_campaign_column_sync] backfilled mirror=${filledMirror ?? 0} primary=${filledPrimary ?? 0}; trigger installed`);
}

export async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_marketing_campaigns_sync_names ON marketing_campaigns`);
  await knex.raw(`DROP FUNCTION IF EXISTS marketing_campaigns_sync_names()`);
  // The backfilled values are left in place: they are correct, and reverting
  // them would restore NULLs that never carried information.
}
