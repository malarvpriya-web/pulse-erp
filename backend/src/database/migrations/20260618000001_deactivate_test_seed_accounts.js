/**
 * Deactivate test/seed super_admin accounts that should not exist in production.
 * Targets users with common seed/demo email patterns only — real admin accounts
 * from the company domain are left untouched.
 *
 * Safe to re-run: the WHERE clause is idempotent.
 */
export async function up(knex) {
  const TEST_EMAIL_PATTERNS = [
    '%@example.com',
    '%@example.org',
    '%@test.com',
    '%@test.org',
    '%@localhost',
    '%@demo.com',
    '%@dummy.com',
    'admin@admin.com',
    'admin@admin',
    'test@test',
    'seed@seed',
    'superadmin@superadmin',
  ];

  const conditions = TEST_EMAIL_PATTERNS
    .map((_, i) => `LOWER(email) LIKE $${i + 1}`)
    .join(' OR ');

  const result = await knex.raw(`
    UPDATE users
    SET    is_active  = false,
           updated_at = NOW()
    WHERE  (${conditions})
    RETURNING id, email, role
  `, TEST_EMAIL_PATTERNS);

  const deactivated = result.rows ?? [];
  if (deactivated.length > 0) {
    console.log(`[Migration] Deactivated ${deactivated.length} test/seed account(s):`);
    for (const u of deactivated) {
      console.log(`  - ${u.email} (${u.role}) id=${u.id}`);
    }
  } else {
    console.log('[Migration] No test/seed accounts found to deactivate.');
  }
}

export async function down(knex) {
  // Re-activation must be done manually; we cannot reliably know which accounts
  // were active before this migration ran.
  console.log('[Migration] down: no-op — re-activate accounts manually if needed');
}
