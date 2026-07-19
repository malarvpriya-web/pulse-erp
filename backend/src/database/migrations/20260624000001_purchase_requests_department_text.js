export async function up(pool) {
  const safe = async (label, sql) => {
    try { await pool.query(sql); }
    catch (e) { console.warn(`[pr_dept_text] skip (${label}): ${e.message.split('\n')[0]}`); }
  };

  await safe('pr add department text',
    `ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS department VARCHAR(100)`);
}

export async function down(pool) {
  try { await pool.query(`ALTER TABLE purchase_requests DROP COLUMN IF EXISTS department`); }
  catch (_) {}
}
