import express from 'express';
import pool from '../shared/db.js';
import { allowRoles } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';

const router = express.Router();

/**
 * Travel Audit — reconciles travel spend against the Finance module rather
 * than reporting the travel module's own numbers back to itself.
 *
 * Three ledgers should agree and frequently don't:
 *   expense_claims          — the claim as approved and paid (shared with Finance)
 *   journal_entries         — the accounting posting (via expense_claims.journal_entry_id)
 *   travel_cost_transactions— the travel module's own cost ledger, written on pay
 *
 * Every exception below is a disagreement between two of those three, or an
 * advance that was disbursed and never squared off. Each query is isolated:
 * one failing table degrades that section to empty rather than 500-ing the page.
 */

const AUDIT_ROLES = ['admin', 'super_admin', 'finance', 'manager'];

const safeRows = async (label, sql, params = []) => {
  try { const r = await pool.query(sql, params); return r.rows; }
  catch (e) { console.warn(`[travel-audit] ${label}: ${e.message.split('\n')[0]}`); return []; }
};
const num = (v) => Number(v ?? 0);

router.get('/', allowRoles(...AUDIT_ROLES), async (req, res) => {
  const { year } = req.query;
  const companyId = companyOf(req);

  // Scoping mirrors the rest of Travel: filter when the user is company-scoped,
  // otherwise show everything. NULL company_id rows stay invisible to scoped
  // users — consistent with the module, and worth knowing when numbers look low.
  const ecScope = companyId != null ? `AND ec.company_id = ${parseInt(companyId, 10)}` : '';
  const taScope = companyId != null ? `AND ta.company_id = ${parseInt(companyId, 10)}` : '';
  const yr = year && year !== 'All' ? parseInt(year, 10) : null;
  const ecYear = yr ? `AND EXTRACT(YEAR FROM COALESCE(ec.expense_date, ec.claim_date, ec.created_at::date)) = ${yr}` : '';
  const taYear = yr ? `AND EXTRACT(YEAR FROM COALESCE(ta.required_by, ta.created_at::date)) = ${yr}` : '';

  const [
    totals, unposted, gstUnverified, unsettledAdvances, unlinkedClaims, missingCostLedger,
  ] = await Promise.all([
    safeRows('totals', `
      SELECT COALESCE(SUM(ec.total_amount), 0) AS total_spend,
             COALESCE(SUM(ec.gst_amount), 0)   AS total_gst,
             COALESCE(SUM(ec.gst_amount) FILTER (WHERE ec.gst_verified), 0) AS gst_recoverable,
             COUNT(*)                          AS claim_count,
             COUNT(ec.journal_entry_id)        AS posted_count
        FROM expense_claims ec
       WHERE ec.deleted_at IS NULL ${ecScope} ${ecYear}`),

    // Paid to the employee but never posted to the books.
    safeRows('unposted', `
      SELECT ec.id, ec.claim_number, ec.employee_name, ec.total_amount,
             ec.payment_date, ec.payment_ref, ec.status
        FROM expense_claims ec
       WHERE ec.deleted_at IS NULL
         AND ec.journal_entry_id IS NULL
         AND (LOWER(ec.status) = 'paid' OR ec.paid_at IS NOT NULL)
         ${ecScope} ${ecYear}
       ORDER BY ec.payment_date DESC NULLS LAST
       LIMIT 200`),

    // GST claimed but never verified — not recoverable until someone checks it.
    safeRows('gst_unverified', `
      SELECT ec.id, ec.claim_number, ec.employee_name, ec.bill_number,
             ec.vendor_name, ec.gst_amount, ec.total_amount, ec.status
        FROM expense_claims ec
       WHERE ec.deleted_at IS NULL
         AND COALESCE(ec.gst_amount, 0) > 0
         AND COALESCE(ec.gst_verified, false) = false
         ${ecScope} ${ecYear}
       ORDER BY ec.gst_amount DESC
       LIMIT 200`),

    // Money out the door with nothing squared against it.
    safeRows('unsettled_advances', `
      SELECT ta.id, ta.amount, ta.settled_amount,
             (COALESCE(ta.amount,0) - COALESCE(ta.settled_amount,0)) AS outstanding,
             ta.status, ta.payment_ref, ta.payment_date, ta.purpose,
             COALESCE(
               NULLIF(TRIM(CONCAT(eu.first_name,' ',eu.last_name)), ''),
               u.name,
               NULLIF(TRIM(CONCAT(ed.first_name,' ',ed.last_name)), '')
             ) AS employee_name,
             COALESCE(tr.request_number, CASE WHEN tr.id IS NOT NULL THEN 'TR-' || LPAD(tr.id::text,3,'0') END) AS request_number
        FROM travel_advances ta
        LEFT JOIN users u      ON u.id  = ta.employee_id
        LEFT JOIN employees eu ON eu.id = u.employee_id
        LEFT JOIN employees ed ON ed.id = ta.employee_id
        LEFT JOIN travel_requests tr ON tr.id = ta.travel_request_id
       WHERE ta.status IN ('Disbursed','Partially Settled')
         AND (COALESCE(ta.amount,0) - COALESCE(ta.settled_amount,0)) > 0
         ${taScope} ${taYear}
       ORDER BY outstanding DESC
       LIMIT 200`),

    // Travel-category spend that no travel request accounts for.
    safeRows('unlinked_claims', `
      SELECT ec.id, ec.claim_number, ec.employee_name, ec.total_amount,
             ec.expense_date, ec.category, ec.expense_type, ec.status
        FROM expense_claims ec
       WHERE ec.deleted_at IS NULL
         AND ec.travel_request_id IS NULL
         ${ecScope} ${ecYear}
       ORDER BY ec.total_amount DESC NULLS LAST
       LIMIT 200`),

    // Paid claims the travel cost ledger never recorded.
    safeRows('missing_cost_ledger', `
      SELECT ec.id, ec.claim_number, ec.employee_name, ec.total_amount,
             ec.payment_date, ec.cost_type
        FROM expense_claims ec
       WHERE ec.deleted_at IS NULL
         AND (LOWER(ec.status) = 'paid' OR ec.paid_at IS NOT NULL)
         AND NOT EXISTS (
           SELECT 1 FROM travel_cost_transactions tct
            WHERE tct.source_type = 'expense_claim' AND tct.source_id = ec.id
         )
         ${ecScope} ${ecYear}
       ORDER BY ec.payment_date DESC NULLS LAST
       LIMIT 200`),
  ]);

  const t = totals[0] || {};
  const sum = (rows, key) => rows.reduce((s, r) => s + num(r[key]), 0);

  res.json({
    summary: {
      total_spend:       num(t.total_spend),
      total_gst:         num(t.total_gst),
      gst_recoverable:   num(t.gst_recoverable),
      gst_at_risk:       sum(gstUnverified, 'gst_amount'),
      claim_count:       Number(t.claim_count || 0),
      posted_count:      Number(t.posted_count || 0),
      unposted_amount:   sum(unposted, 'total_amount'),
      unsettled_amount:  sum(unsettledAdvances, 'outstanding'),
      unlinked_amount:   sum(unlinkedClaims, 'total_amount'),
    },
    exceptions: {
      unposted:            unposted,
      gst_unverified:      gstUnverified,
      unsettled_advances:  unsettledAdvances,
      unlinked_claims:     unlinkedClaims,
      missing_cost_ledger: missingCostLedger,
    },
  });
});

// Years with travel activity, for the audit's year filter.
router.get('/years', allowRoles(...AUDIT_ROLES), async (req, res) => {
  const companyId = companyOf(req);
  const scope = companyId != null ? `AND company_id = ${parseInt(companyId, 10)}` : '';
  const rows = await safeRows('years', `
    SELECT DISTINCT year FROM (
      SELECT EXTRACT(YEAR FROM COALESCE(expense_date, claim_date, created_at::date))::int AS year
        FROM expense_claims WHERE deleted_at IS NULL ${scope}
      UNION
      SELECT EXTRACT(YEAR FROM COALESCE(required_by, created_at::date))::int
        FROM travel_advances WHERE 1=1 ${scope}
    ) y WHERE year IS NOT NULL ORDER BY year DESC`);
  res.json(rows.map(r => r.year));
});

export default router;
