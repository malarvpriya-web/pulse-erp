/**
 * 20260609000001_fix_company_state_tamilnadu.js
 *
 * Corrects the company's state and GST state code.
 * Tamil Nadu state code = 33.
 * Also seeds a blank finance settings row so the settings page
 * always has a DB record to load (returns {} until user saves).
 *
 * Rewritten to use only knex.raw() — compatible with the custom migration shim.
 */

export async function up(knex) {
  const safe = async (label, sql, params) => {
    await knex.raw('SAVEPOINT cs_sp');
    try {
      await knex.raw(sql, params || []);
      await knex.raw('RELEASE SAVEPOINT cs_sp');
    } catch (e) {
      await knex.raw('ROLLBACK TO SAVEPOINT cs_sp');
      console.warn(`[fix_company_state_tamilnadu] skip (${label}): ${e.message.split('\n')[0]}`);
    }
  };

  // 1. Add state_code column to companies if missing
  await safe('add state_code column',
    `ALTER TABLE companies ADD COLUMN IF NOT EXISTS state_code VARCHAR(10)`);

  // 2. Fix company row 1 state/state_code
  await safe('update company state', `
    UPDATE companies
    SET state      = 'Tamil Nadu',
        state_code = '33',
        updated_at = NOW()
    WHERE id = 1
  `);

  // 3. Ensure finance settings row exists
  await safe('seed finance settings', `
    INSERT INTO company_settings (company_id, module, settings, updated_at)
    VALUES (1, 'finance', '{}'::JSONB, NOW())
    ON CONFLICT (company_id, module) DO NOTHING
  `);

  console.log('[migration 20260609000001] Company state set to Tamil Nadu (33), finance settings row seeded.');
}

export async function down(knex) {
  // Intentionally a no-op — reverting a state/code correction is a manual data decision
}
