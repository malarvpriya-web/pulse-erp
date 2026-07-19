/**
 * 20260621000002_logistics_quality_company_scope.js
 *
 * Add company_id scoping to logistics tables so shipments and e-way bills
 * are isolated per tenant. Uses SAVEPOINT pattern to be idempotent.
 */

export async function up(knex) {
  const safe = async (label, fn) => {
    const sp = `sp_lq_${label.replace(/\W/g, '_').slice(0, 40)}`;
    await knex.raw(`SAVEPOINT ${sp}`);
    try { await fn(); }
    catch (e) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${sp}`);
      console.warn(`[logistics_quality_scope] skipped (${label}): ${e.message}`);
    } finally {
      await knex.raw(`RELEASE SAVEPOINT ${sp}`);
    }
  };

  // ── shipments ──────────────────────────────────────────────────────────────
  await safe('shipments_company_id', () =>
    knex.raw(`ALTER TABLE shipments ADD COLUMN company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL`)
  );
  await safe('shipments_direction', () =>
    knex.raw(`ALTER TABLE shipments ADD COLUMN direction VARCHAR(10) DEFAULT 'outbound'`)
  );
  await safe('idx_shipments_company', () =>
    knex.raw(`CREATE INDEX IF NOT EXISTS idx_shipments_company ON shipments(company_id)`)
  );
  await safe('idx_shipments_status', () =>
    knex.raw(`CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status)`)
  );

  // ── eway_bills ─────────────────────────────────────────────────────────────
  await safe('eway_bills_company_id', () =>
    knex.raw(`ALTER TABLE eway_bills ADD COLUMN company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL`)
  );
  await safe('idx_eway_bills_company', () =>
    knex.raw(`CREATE INDEX IF NOT EXISTS idx_eway_bills_company ON eway_bills(company_id)`)
  );

  console.log('[logistics_quality_scope] migration complete');
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE shipments DROP COLUMN IF EXISTS company_id`);
  await knex.raw(`ALTER TABLE shipments DROP COLUMN IF EXISTS direction`);
  await knex.raw(`ALTER TABLE eway_bills DROP COLUMN IF EXISTS company_id`);
}
