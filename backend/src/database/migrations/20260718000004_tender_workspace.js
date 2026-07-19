/**
 * 20260718000004_tender_workspace.js
 *
 * Government Tender workspace (Manifest OS gap). Tenders are NOT a new entity —
 * `opportunities` already carries the tender fields (tender_number, tender_source,
 * submission_deadline, bid_type, emd_amount, emd_status, loa_received/date/amount,
 * product_category). The gap was a dedicated workspace + the EMD lifecycle and a
 * document checklist. This migration adds only those missing bits:
 *
 *   opportunities.emd_mode / emd_expiry_date / emd_refund_date  — EMD lifecycle
 *     (a bid's earnest-money deposit is blocked until refunded; track how it was
 *      furnished, when it expires, and when it came back).
 *   tender_documents — the per-tender document checklist (NIT, technical bid,
 *     commercial bid, EMD proof, …) with submission status + due dates.
 *
 * Additive + nullable only; no existing opportunity data is touched.
 */

export async function up(knex) {
  const safe = async (label, sql) => {
    const sp = `sp_tnd_${label.replace(/\W/g, '_').slice(0, 40)}`;
    await knex.raw(`SAVEPOINT ${sp}`);
    try { await knex.raw(sql); await knex.raw(`RELEASE SAVEPOINT ${sp}`); }
    catch (e) { await knex.raw(`ROLLBACK TO SAVEPOINT ${sp}`); console.warn(`[tender_workspace] skipped (${label}): ${e.message.split('\n')[0]}`); }
  };

  await safe('emd_cols', `
    ALTER TABLE opportunities
      ADD COLUMN IF NOT EXISTS emd_mode        VARCHAR(20),   -- DD | BG | online | exempt
      ADD COLUMN IF NOT EXISTS emd_expiry_date DATE,
      ADD COLUMN IF NOT EXISTS emd_refund_date DATE`);

  await safe('tender_documents', `
    CREATE TABLE IF NOT EXISTS tender_documents (
      id             SERIAL PRIMARY KEY,
      company_id     INTEGER NOT NULL DEFAULT 1,
      opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
      doc_name       VARCHAR(200) NOT NULL,
      doc_type       VARCHAR(50),                       -- nit | technical | commercial | emd_proof | corrigendum | other
      status         VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | submitted | na
      due_date       DATE,
      file_url       TEXT,
      notes          TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safe('idx_tdoc', `CREATE INDEX IF NOT EXISTS idx_tender_documents_opp ON tender_documents(opportunity_id)`);
  await safe('idx_opp_tender', `CREATE INDEX IF NOT EXISTS idx_opportunities_tender ON opportunities(submission_deadline) WHERE tender_number IS NOT NULL`);

  console.log('[migration 20260718000004] tender_workspace applied.');
}

export async function down(knex) {
  const safe = async (sql) => { try { await knex.raw(sql); } catch { /* ignore */ } };
  await safe(`DROP TABLE IF EXISTS tender_documents CASCADE`);
  await safe(`ALTER TABLE opportunities DROP COLUMN IF EXISTS emd_mode, DROP COLUMN IF EXISTS emd_expiry_date, DROP COLUMN IF EXISTS emd_refund_date`);
}
