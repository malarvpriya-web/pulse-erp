/**
 * 20260915000007_procurement_self_approval_gate.js
 *
 * Procurement audit — segregation of duties on approval.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 * Neither `PUT /purchase-requests/:id/approve` nor
 * `PATCH /purchase-orders/:id/approve` ever compared the approver to the person
 * who raised the document. The value-band ladder in procurement.authz.js asks
 * only "does this account hold enough authority for this amount" — never "is
 * this the same person on both sides of the decision".
 *
 * So a department manager (ROLE_LEVEL 1, authority to ₹25,000) could raise a
 * ₹20,000 requisition and immediately approve it. One person, both signatures,
 * no independent review, and the audit trail records it as a properly approved
 * document because every check it ran did pass. That is the textbook
 * segregation-of-duties failure, and it is the control an external auditor
 * tests first in a purchase-to-pay cycle.
 *
 * ── WHAT THIS MIGRATION DOES ────────────────────────────────────────────────
 * Adds `procurement_settings.allow_self_approval`, default FALSE — the control
 * is ON out of the box.
 *
 * Default-on is a deliberate reversal of the pattern this codebase already got
 * caught by once, where a control shipped, sat behind a flag, and the flag was
 * never turned on, so the control existed only on paper. A segregation rule
 * that defaults to off is not a segregation rule.
 *
 * ── WHY A FLAG AT ALL, THEN ─────────────────────────────────────────────────
 * Because a genuinely small company may have exactly one person who both raises
 * and approves, and for them the block is not a control, it is a dead end. They
 * flip it in Procurement Settings, the choice is recorded per company, and the
 * fact that it was flipped is itself visible to an auditor — which is a far
 * better outcome than silently permitting self-approval everywhere.
 *
 * ── SCOPE OF THE BLOCK (enforced in procurement.authz.js) ────────────────────
 * It applies only where an approval decision carries authority. Amounts at or
 * below `auto_approve_below` already fall in the 'auto' band, which requires no
 * authority to clear, so the rule does not bite there — it engages exactly
 * where a second pair of eyes is the point.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE procurement_settings
      ADD COLUMN IF NOT EXISTS allow_self_approval BOOLEAN NOT NULL DEFAULT FALSE
  `);

  // Report which companies this newly constrains, so the change is not silent.
  // A company whose approvers are also its requesters will feel this on their
  // next approval, and whoever runs the migration should know that in advance
  // rather than hear it from them.
  const { rows } = await knex.raw(`
    SELECT pr.company_id,
           COUNT(*)::int AS self_approved_prs
      FROM purchase_requests pr
     WHERE pr.approved_by IS NOT NULL
       AND pr.requested_by_employee_id IS NOT NULL
       AND pr.approved_by = pr.requested_by_employee_id
       AND pr.deleted_at IS NULL
     GROUP BY pr.company_id
     ORDER BY self_approved_prs DESC
  `).catch(() => ({ rows: [] }));

  if (rows.length) {
    console.warn(
      `[migration 20260915000007] Self-approval is now blocked by default. ` +
      `Historical requisitions where the approver WAS the requester:`
    );
    for (const r of rows) {
      console.warn(`  company_id=${r.company_id}  self-approved PRs=${r.self_approved_prs}`);
    }
    console.warn(
      `  These rows are left exactly as they are — this migration changes no history. ` +
      `A company that must keep working this way can set allow_self_approval in Procurement Settings.`
    );
  }
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE procurement_settings DROP COLUMN IF EXISTS allow_self_approval`);
}
