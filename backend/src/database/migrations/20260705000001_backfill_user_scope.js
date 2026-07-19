/**
 * 20260705000001_backfill_user_scope.js
 *
 * Assigns a primary company scope to every user that has none.
 *
 * Single-company deployments were left with an empty user_scope table. That made
 * verifyToken resolve req.scope = null for every non-super-admin user, so every
 * scope-guarded endpoint returned 403 "Company scope required" — surfacing in the
 * UI as generic "Failed to load / Failed to save" errors (e.g. Shop Floor).
 *
 * Backfill is gap-filling only: users who already have a scope row are left
 * untouched. Scopes point at the first (lowest-id) company. If no company exists
 * yet, users are skipped and can be scoped once a company is created.
 */
export async function up(knex) {
  await knex.raw(`
    INSERT INTO user_scope (user_id, company_id, branch_id, is_primary)
    SELECT u.id, c.id, NULL, true
    FROM users u
    CROSS JOIN LATERAL (SELECT id FROM companies ORDER BY id LIMIT 1) c
    WHERE NOT EXISTS (SELECT 1 FROM user_scope s WHERE s.user_id = u.id)
  `);
}

export async function down(knex) {
  // No-op: we cannot know which scope rows pre-existed, so we don't remove any.
}
