/**
 * 20260930000011 — `bgv_sensitive`: the findings behind a discrepancy.
 *
 * ── Why a second permission and not a role list ──────────────────────────────
 * `bgv:view` answers "may this person run background verification". It does not
 * answer "may this person read what the criminal-record check actually found",
 * and those are different questions with different answers: an HR executive
 * chases the agency, books the cost and files the report, and has no business
 * reading the finding that will end someone's employment.
 *
 * A role-name list inside the route would have been the quick version and the
 * wrong one — every gate in this codebase that hardcoded roles has since had to
 * be widened by hand, and a tenant that renames or adds an HR tier cannot adjust
 * it. This is a row in the same matrix `requirePermission` already reads, so it
 * is administrable from Access Control like every other grant.
 *
 * ── What it gates, and what it deliberately does not ─────────────────────────
 * GATED — the detail:
 *   · `remarks` and `followup_notes` on a check whose result is Discrepancy
 *   · the contact-history `notes` under such a check
 *   · the REPORT DOCUMENTS attached to such a check, including the bytes
 *     (GET /api/files/:name checks this too, or the folder view would hide a
 *     file that the download still served)
 *   · the Discrepancy Report export
 *
 * NOT GATED — the fact:
 *   · that the check exists, its type, its agency, its dates, its cost
 *   · its status AND its result, including the word "Discrepancy"
 *   · the case's derived status and the discrepancy COUNT
 *
 * That split is deliberate and it is the brief's: "Normal HR users can see the
 * BGV status/result at the level permitted by the existing workflow, but
 * sensitive discrepancy details must be permission-controlled." Hiding the
 * result itself would be worse than useless — an HR executive who cannot see
 * that a check came back Discrepancy will chase it as though it were still
 * pending, and the case would read as unfinished work rather than as a finding
 * awaiting a decision.
 *
 * ── Who gets it ─────────────────────────────────────────────────────────────
 * super_admin, admin, hr (roles.role_name is literally 'HR Manager') and
 * hr_manager. NOT hr_exec — that is the "HR operations" tier in this schema
 * ('employees, leaves, attendance — no payroll'), i.e. exactly the normal HR
 * user the brief distinguishes.
 *
 * Seeded for EVERY role explicitly, false included, because
 * `requirePermission` fails closed on a missing row and an absent row is
 * indistinguishable from an unseeded matrix.
 */

/** Roles that may read a discrepancy's findings and reports. */
export const BGV_SENSITIVE_ROLES = ['super_admin', 'admin', 'hr', 'hr_manager'];

export async function up(knex) {
  // ⚠ pg shim, not knex: bindings are $1/$2.
  await knex.raw(
    `INSERT INTO role_permissions (role_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
     SELECT r.id, 'bgv_sensitive',
            LOWER(r.code) = ANY($1),
            false, false, false, false,
            LOWER(r.code) = ANY($1)
       FROM roles r
      WHERE r.code IS NOT NULL
     ON CONFLICT (role_id, module) DO NOTHING`,
    [BGV_SENSITIVE_ROLES],
  );

  // can_add / can_edit / can_delete stay false for everyone: this permission
  // grants READ of sensitive detail and nothing else. Writing a check is
  // `bgv:edit` and always was. A flag nothing reads is the
  // [[project_comp_off_flag_noop_and_silent_catches]] trap.
  //
  // can_export mirrors can_view because the Discrepancy Report is the same
  // information in a file — gating the screen and leaving the export open would
  // be the [[project_pulse01_env_write_rbac_killswitch]] failure again, where a
  // gated endpoint had seven ungated aliases behind it.
}

export async function down(knex) {
  await knex.raw(`DELETE FROM role_permissions WHERE module = 'bgv_sensitive'`);
}
