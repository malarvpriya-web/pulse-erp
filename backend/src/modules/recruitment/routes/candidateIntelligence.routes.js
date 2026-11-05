/**
 * candidateIntelligence.routes.js
 *
 * The HTTP surface for the Recruitment redesign: notes, the activity timeline,
 * Stage-1 screening, role suitability, Future Opportunity recontacts, the Talent
 * Bank, similar candidates, bulk actions, the recruiter work queue and the
 * quick-view projection.
 *
 * Mounted on the SAME /recruitment prefix as recruitment.routes.js and BEFORE it
 * (server.js), for the reason the careers router is mounted the same way: a
 * literal path registered after a /:param route on the same prefix is
 * unreachable. Nothing here shadows an existing route — every path is either a
 * new literal or a new suffix under /candidates/:id — and mounting first means a
 * future /:id route added to the main file cannot swallow these.
 *
 * ── PERMISSIONS ─────────────────────────────────────────────────────────────
 * §30 lists Recruitment.View/Create/Edit/Screen/Interview/StatusChange/Notes/
 * TalentBank/Export/Admin. `role_permissions` has a FIXED verb set — can_view,
 * can_add, can_edit, can_delete, can_approve, can_export — so those ten cannot
 * become columns without a platform-wide RBAC change, which this work is
 * explicitly not allowed to make. They are mapped onto the verbs that already
 * exist, and the mapping is recorded here so the next reader knows it was a
 * decision and not an omission:
 *
 *   Recruitment.View          → recruitment:view
 *   Recruitment.Create        → recruitment:add
 *   Recruitment.Notes         → recruitment:add     (writing a note is creating a record)
 *   Recruitment.TalentBank    → recruitment:add     (banking a candidate creates membership)
 *   Recruitment.Edit          → recruitment:edit
 *   Recruitment.Screen        → recruitment:edit    (screening edits a candidate's assessment)
 *   Recruitment.Interview     → recruitment:edit
 *   Recruitment.StatusChange  → recruitment:edit
 *   Recruitment.Export        → recruitment:export  (already enforced, see /candidates/export)
 *   Recruitment.Admin         → recruitment:delete
 *
 * Every route below is gated. There is no unauthenticated path in this file and
 * no route that relies on the frontend having hidden a button.
 */

import express from 'express';
import pool from '../../shared/db.js';
import ci from '../repositories/candidateIntelligence.repository.js';
import { companyOf } from '../../../shared/scope.js';
// One shared resolver, so the timeline's actor_name is produced the same way here
// and in recruitment.routes.js rather than by two caches that can disagree.
import { actorNameOf } from '../actorName.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { respondError } from '../../../shared/pgErrors.js';
import { validateBody, validateObject } from '../../../shared/requestSchema.js';
import { logAudit } from '../../../services/AuditService.js';
import notificationsRepository from '../../notifications/repositories/notifications.repository.js';
import {
  noteSchema, screeningSaveSchema, screeningDecisionSchema, suitabilitySchema,
  suitabilityEntrySchema, recontactSchema, recontactCompleteSchema, talentBankSchema,
  bulkSchema, BULK_VALUE_RULES, candidateProfileSchema, VOCABULARIES,
} from './candidateIntelligence.schemas.js';

const router = express.Router();

const view   = requirePermission('recruitment', 'view');
const add    = requirePermission('recruitment', 'add');
const edit   = requirePermission('recruitment', 'edit');
const admin  = requirePermission('recruitment', 'delete');

const cid = (req) => companyOf(req);
const uid = (req) => req.user?.userId ?? req.user?.id ?? null;

/** The mutation context every repository write takes. */
async function ctxOf(req) {
  return {
    company_id: cid(req),
    actor_user_id: uid(req),
    actor_name: await actorNameOf(req),
  };
}

// module_name + reference_id are what the notification bell routes on, so a
// recruitment notification carrying the candidate id is click-through-able. No
// `link` is passed: notificationsRepository.create() does not read one (it
// inserts six columns and `link` is not among them), and passing a field the
// writer ignores is how a feature comes to look implemented when it is not.
const notify = (userId, candidateId, message) => {
  if (!userId) return;
  notificationsRepository.create({
    user_id: userId,
    title: (message || 'Recruitment').slice(0, 100),
    message,
    module_name: 'recruitment',
    reference_id: candidateId,
    notification_type: 'info',
  }).catch(() => {});
};

/**
 * Confirm a candidate exists in the caller's company before doing anything with
 * them.
 *
 * Used by every /candidates/:id/* route below. Without it each handler would
 * scope its own writes and a single forgotten predicate would be a cross-tenant
 * write — which is exactly the defect class this module was audited for. One
 * lookup, one place to get it right.
 */
async function candidateInScope(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'That is not a valid candidate id.' });
    return null;
  }
  const { rows } = await pool.query(
    `SELECT id, full_name, candidate_code, company_id, recruiter_id, applied_job_id,
            current_stage, disposition, anonymised_at
       FROM candidates
      WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
    [id, cid(req)]
  );
  if (!rows.length) {
    res.status(404).json({ error: 'Candidate not found' });
    return null;
  }
  return rows[0];
}

/**
 * Which application is a screening about?
 *
 * Explicit if the caller said; otherwise the candidate's PRIMARY application; only
 * null when they genuinely have none (a speculative résumé-database profile).
 *
 * Defaulting here rather than leaving it null matters more than it looks. A
 * screening row is unique per application, with a second partial unique index for
 * the one speculative screening a candidate may have — so a request that omitted
 * the id created a SEPARATE speculative screening alongside the real
 * application-scoped one. The candidate then had two screenings with different
 * scores, the page showed whichever it asked for, and a recruiter's ratings went
 * into a row nobody would look at again.
 *
 * @returns {Promise<number|null>}
 */
async function resolveApplicationId(req, candidateId, explicit) {
  const given = explicit == null || explicit === '' ? null : parseInt(explicit, 10);
  if (Number.isInteger(given)) return given;

  const { rows } = await pool.query(
    `SELECT id FROM candidate_applications
      WHERE candidate_id = $1 AND ($2::int IS NULL OR company_id = $2)
      ORDER BY is_primary DESC, applied_at ASC
      LIMIT 1`,
    [candidateId, cid(req)]
  );
  return rows[0]?.id ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
// VOCABULARIES — one request, every dropdown
// ═══════════════════════════════════════════════════════════════════════════
// Declared first so no /:param route can capture it. The frontend has its own
// canonical constants file; this endpoint exists for the vocabularies that are
// DATA rather than code (the company's departments, its recruiters, its talent
// pools) and returns the enum sets alongside them so a screen needs one call to
// draw every picker.
router.get('/meta/candidate-workbench', view, async (req, res) => {
  try {
    const companyId = cid(req);
    const [departments, recruiters, pools, questions] = await Promise.all([
      ci.listDepartments(companyId),
      pool.query(
        `SELECT u.id, COALESCE(e.name, u.email) AS name, u.email
           FROM users u
           LEFT JOIN employees e ON e.id = u.employee_id
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN role_permissions rp ON rp.role_id = ur.role_id
          WHERE rp.module = 'recruitment' AND rp.can_edit = TRUE
            AND u.is_active = TRUE
            AND ($1::int IS NULL OR u.company_id = $1)
          GROUP BY u.id, e.name, u.email
          ORDER BY 2`,
        [companyId]
      ).then(r => r.rows).catch(() => []),
      pool.query(
        `SELECT id, pool_name, category, department, is_seeded,
                (SELECT COUNT(*)::int FROM talent_pool_members m WHERE m.pool_id = talent_pools.id) AS member_count
           FROM talent_pools
          WHERE is_active IS NOT FALSE AND ($1::int IS NULL OR company_id = $1)
          ORDER BY category NULLS LAST, pool_name`,
        [companyId]
      ).then(r => r.rows),
      ci.listScreeningQuestions(companyId),
    ]);

    res.json({ departments, recruiters, pools, screening_questions: questions, vocabularies: VOCABULARIES });
  } catch (error) {
    respondError(res, error);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// WORK QUEUE (§23)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/work-queue', view, async (req, res) => {
  try {
    const counts = await ci.getWorkQueue(cid(req), uid(req));
    // The recontacts themselves come with the counts: §23 wants the number
    // clickable, and a recruiter who clicks "12 due for recontact" wants the
    // twelve, not a second request.
    const due = await ci.listRecontacts({
      company_id: cid(req), due_only: true, status: 'pending', limit: 25,
    });
    res.json({ counts, recontacts_due: due, as_of: new Date().toISOString() });
  } catch (error) {
    respondError(res, error);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TALENT BANK (§17, §19)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/talent-bank', view, async (req, res) => {
  try {
    const companyId = cid(req);
    // Guarantees §17's categories exist for THIS company, including one onboarded
    // after the seed migration ran. Idempotent and a no-op once they are there.
    await ci.ensureStandardTalentPools(companyId).catch(() => {});

    const result = await ci.searchTalentBank({ ...req.query, company_id: companyId });
    res.set('X-Total-Count', String(result.total));
    res.json(result);
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/talent-bank/pools', view, async (req, res) => {
  try {
    const companyId = cid(req);
    await ci.ensureStandardTalentPools(companyId).catch(() => {});
    const { rows } = await pool.query(
      `SELECT tp.id, tp.pool_name, tp.category, tp.department, tp.description, tp.is_seeded,
              COUNT(m.candidate_id)::int AS member_count
         FROM talent_pools tp
         LEFT JOIN talent_pool_members m ON m.pool_id = tp.id
        WHERE tp.is_active IS NOT FALSE AND ($1::int IS NULL OR tp.company_id = $1)
        GROUP BY tp.id
        ORDER BY tp.category NULLS LAST, tp.pool_name`,
      [companyId]
    );
    res.json(rows);
  } catch (error) {
    respondError(res, error);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// RECONTACT / FUTURE OPPORTUNITY (§18)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/recontacts', view, async (req, res) => {
  try {
    res.json(await ci.listRecontacts({ ...req.query, company_id: cid(req) }));
  } catch (error) {
    respondError(res, error);
  }
});

router.post('/recontacts/:id/complete', edit, validateBody(recontactCompleteSchema), async (req, res) => {
  try {
    const ctx = await ctxOf(req);
    const rc = await ci.completeRecontact(req.params.id, req.body, ctx);
    if (!rc) return res.status(404).json({ error: 'That reminder no longer exists, or it has already been closed.' });
    logAudit({
      userId: ctx.actor_user_id, module: 'Recruitment', recordId: rc.candidate_id,
      recordType: 'candidate_recontact', action: 'complete',
      newData: { recontact_id: rc.id, status: rc.status, reengage: Boolean(req.body.reengage) }, req,
    });
    res.json(rc);
  } catch (error) {
    respondError(res, error);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SCREENING QUESTIONS (§13)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/screening-questions', view, async (req, res) => {
  try {
    res.json(await ci.listScreeningQuestions(cid(req)));
  } catch (error) {
    respondError(res, error);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// BULK ACTIONS (§22)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/candidates/bulk-action', edit, validateBody(bulkSchema), async (req, res) => {
  try {
    const { action, value } = req.body;

    // `value` means something different for every action, so it is validated here
    // rather than in the schema — this is the only point where the action and the
    // value are both known.
    const rule = BULK_VALUE_RULES[action];
    if (rule) {
      const isNullish = value === undefined || value === null || value === '';
      if (!(rule.nullable && isNullish)) {
        const errors = validateObject({ value }, { value: { ...rule, required: true, label: 'Value' } });
        if (Object.keys(errors).length) {
          return res.status(400).json({ error: Object.values(errors)[0], errors });
        }
      }
    }

    // §22: "Bulk actions must require confirmation for destructive operations."
    // Confirmation is a UI affordance and a UI affordance is not a control, so the
    // destructive ones additionally require an explicit acknowledgement in the
    // body. A mis-wired button cannot reject forty candidates by accident.
    const DESTRUCTIVE = new Set(['rejected', 'rejected_from_manifest', 'blacklisted', 'inactive']);
    const destructive = (action === 'stage' || action === 'disposition') && DESTRUCTIVE.has(String(value));
    if (destructive && req.body.confirm !== true && req.body.confirm !== 'true') {
      return res.status(400).json({
        error: `Setting ${String(value).replace(/_/g, ' ')} for several candidates at once needs confirmation.`,
        requires_confirmation: true,
      });
    }

    const ctx = await ctxOf(req);
    const result = await ci.bulkUpdate(req.body, ctx);

    logAudit({
      userId: ctx.actor_user_id, module: 'Recruitment', recordId: null,
      recordType: 'candidate_bulk', action: 'bulk_update',
      newData: { action, value, count: result.updated, skipped: result.skipped }, req,
    });

    res.json({
      ...result,
      // The skipped count is reported, not hidden. A selection that silently
      // applied to 38 of 40 candidates is a bug the recruiter has no way to see.
      message: result.skipped
        ? `Updated ${result.updated} candidate${result.updated === 1 ? '' : 's'}. ${result.skipped} could not be found in this company and were left unchanged.`
        : `Updated ${result.updated} candidate${result.updated === 1 ? '' : 's'}.`,
    });
  } catch (error) {
    respondError(res, error);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PER-CANDIDATE
// ═══════════════════════════════════════════════════════════════════════════

// ── Quick view (§8) ────────────────────────────────────────────────────────
router.get('/candidates/:id/quick-view', view, async (req, res) => {
  try {
    const cand = await candidateInScope(req, res);
    if (!cand) return;
    const data = await ci.getQuickView(cand.id, cid(req), { viewer_user_id: uid(req) });
    res.json(data);
  } catch (error) {
    respondError(res, error);
  }
});

// ── Activity timeline (§21) ────────────────────────────────────────────────
router.get('/candidates/:id/activity', view, async (req, res) => {
  try {
    const cand = await candidateInScope(req, res);
    if (!cand) return;
    res.json(await ci.listActivity(cand.id, cid(req), { limit: req.query.limit }));
  } catch (error) {
    respondError(res, error);
  }
});

// ── Notes (§9) ─────────────────────────────────────────────────────────────
router.get('/candidates/:id/notes', view, async (req, res) => {
  try {
    const cand = await candidateInScope(req, res);
    if (!cand) return;
    res.json(await ci.listNotes(cand.id, cid(req), { viewer_user_id: uid(req) }));
  } catch (error) {
    respondError(res, error);
  }
});

router.post('/candidates/:id/notes', add, validateBody(noteSchema), async (req, res) => {
  try {
    const cand = await candidateInScope(req, res);
    if (!cand) return;

    const ctx = await ctxOf(req);
    const note = await ci.createNote({ ...req.body, candidate_id: cand.id }, ctx);

    logAudit({
      userId: ctx.actor_user_id, module: 'Recruitment', recordId: cand.id,
      recordType: 'candidate_note', action: 'create',
      newData: { note_id: note.id, note_type: note.note_type, visibility: note.visibility }, req,
    });

    // The candidate's recruiter is told when somebody else comments on their
    // candidate — but not when they comment themselves, which would be noise.
    if (cand.recruiter_id && cand.recruiter_id !== ctx.actor_user_id && note.visibility !== 'private') {
      notify(cand.recruiter_id, cand.id,
        `${ctx.actor_name || 'A colleague'} added a ${note.note_type} note on ${cand.full_name}`);
    }

    res.status(201).json(note);
  } catch (error) {
    respondError(res, error);
  }
});

router.put('/candidates/:id/notes/:noteId', edit, async (req, res) => {
  try {
    const cand = await candidateInScope(req, res);
    if (!cand) return;

    // A partial update: pinning sends only is_pinned, so `required: true` on body
    // must not apply. validateObject with partial, not validateBody.
    const errors = validateObject(req.body, noteSchema, { partial: true });
    if (Object.keys(errors).length) {
      return res.status(400).json({ error: Object.values(errors)[0], errors });
    }

    const ctx = await ctxOf(req);
    const note = await ci.updateNote(req.params.noteId, req.body, ctx);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    res.json(note);
  } catch (error) {
    respondError(res, error);
  }
});

router.delete('/candidates/:id/notes/:noteId', edit, async (req, res) => {
  try {
    const cand = await candidateInScope(req, res);
    if (!cand) return;
    const ctx = await ctxOf(req);
    const note = await ci.deleteNote(req.params.noteId, ctx);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    res.json({ message: 'Note removed', id: note.id });
  } catch (error) {
    respondError(res, error);
  }
});

// ── Screening (§10–§15) ────────────────────────────────────────────────────
router.get('/candidates/:id/screening', view, async (req, res) => {
  try {
    const cand = await candidateInScope(req, res);
    if (!cand) return;

    const applicationId = await resolveApplicationId(req, cand.id, req.query.application_id);
    const screening = await ci.getScreening({
      candidate_id: cand.id,
      application_id: applicationId,
      company_id: cid(req),
    });
    const questions = await ci.listScreeningQuestions(cid(req));

    // The questions come back whether or not a screening exists, so the workspace
    // can be drawn before the first save. A null screening is a valid, empty
    // one — not a 404, because "this candidate has not been screened" is the
    // normal state and the answer to the request.
    res.json({ screening, questions });
  } catch (error) {
    respondError(res, error);
  }
});

router.post('/candidates/:id/screening', edit, validateBody(screeningSaveSchema), async (req, res) => {
  try {
    const cand = await candidateInScope(req, res);
    if (!cand) return;

    const applicationId = await resolveApplicationId(req, cand.id, req.body.application_id);
    if (applicationId) {
      // An application id from the body is checked against BOTH the candidate and
      // the company. Checking only the company would let a screening be attached
      // to a different candidate's application.
      const { rows } = await pool.query(
        `SELECT id FROM candidate_applications
          WHERE id = $1 AND candidate_id = $2 AND ($3::int IS NULL OR company_id = $3)`,
        [applicationId, cand.id, cid(req)]
      );
      if (!rows.length) {
        return res.status(400).json({ error: 'That application does not belong to this candidate.' });
      }
    }

    const ctx = await ctxOf(req);
    const saved = await ci.upsertScreening(
      { ...req.body, candidate_id: cand.id, application_id: applicationId }, ctx
    );
    res.json(saved);
  } catch (error) {
    respondError(res, error);
  }
});

router.post('/screenings/:screeningId/complete', edit, validateBody(screeningDecisionSchema), async (req, res) => {
  try {
    const { decision } = req.body;

    // §15: "If 'Reject from Manifest' is selected, require a reason."
    if (decision === 'reject_from_manifest' && !String(req.body.reject_reason || '').trim()) {
      return res.status(400).json({
        error: 'Rejecting a candidate from Manifest needs a reason. This stays on their record.',
        errors: { reject_reason: 'A reason is required to reject a candidate from Manifest.' },
      });
    }
    // §16 is the whole point of this decision — choosing it without naming a
    // department records nothing, so it is refused rather than silently doing
    // nothing.
    if (decision === 'consider_other_roles'
        && !(Array.isArray(req.body.suitable_departments) && req.body.suitable_departments.length)) {
      return res.status(400).json({
        error: 'Choose at least one other department to consider this candidate for.',
        errors: { suitable_departments: 'Select at least one department.' },
      });
    }
    // §18's reminder is the feature; a Future Opportunity with no date is a label.
    if (decision === 'future_opportunity' && !req.body.recontact_on) {
      return res.status(400).json({
        error: 'A future opportunity needs a date to come back to the candidate on.',
        errors: { recontact_on: 'Pick a recontact date.' },
      });
    }

    const ctx = await ctxOf(req);

    // The override reason is required when the human disagrees with the
    // scorecard. §14 permits the override and asks for the reason; refusing it
    // without one is what makes the stored `overridden` flag meaningful.
    const { rows: pre } = await pool.query(
      `SELECT s.id, s.recommendation, s.candidate_id, c.full_name, c.recruiter_id
         FROM candidate_screenings s JOIN candidates c ON c.id = s.candidate_id
        WHERE s.id = $1 AND ($2::int IS NULL OR s.company_id = $2)`,
      [req.params.screeningId, ctx.company_id]
    );
    if (!pre.length) return res.status(404).json({ error: 'Screening not found' });

    if (pre[0].recommendation && pre[0].recommendation !== decision
        && !String(req.body.override_reason || '').trim()) {
      return res.status(400).json({
        error: `The scorecard suggests "${pre[0].recommendation.replace(/_/g, ' ')}". Choosing something else is fine — please say why.`,
        errors: { override_reason: 'A short reason is required when overriding the recommendation.' },
        recommendation: pre[0].recommendation,
      });
    }

    const result = await ci.completeScreening(req.params.screeningId, req.body, ctx);
    if (!result) return res.status(404).json({ error: 'Screening not found' });

    logAudit({
      userId: ctx.actor_user_id, module: 'Recruitment', recordId: pre[0].candidate_id,
      recordType: 'candidate_screening', action: 'complete',
      newData: {
        screening_id: result.id, decision,
        recommendation: pre[0].recommendation,
        overridden: Boolean(pre[0].recommendation && pre[0].recommendation !== decision),
        override_reason: req.body.override_reason || null,
        reject_reason: req.body.reject_reason || null,
      },
      req,
    });

    if (pre[0].recruiter_id && pre[0].recruiter_id !== ctx.actor_user_id) {
      notify(pre[0].recruiter_id, pre[0].candidate_id,
        `${pre[0].full_name}: Stage 1 screening completed — ${decision.replace(/_/g, ' ')}`);
    }

    res.json(result);
  } catch (error) {
    respondError(res, error);
  }
});

// ── Role suitability (§16, §27) ────────────────────────────────────────────
router.get('/candidates/:id/suitability', view, async (req, res) => {
  try {
    const cand = await candidateInScope(req, res);
    if (!cand) return;
    res.json(await ci.listSuitability(cand.id, cid(req)));
  } catch (error) {
    respondError(res, error);
  }
});

router.post('/candidates/:id/suitability', add, validateBody(suitabilitySchema), async (req, res) => {
  try {
    const cand = await candidateInScope(req, res);
    if (!cand) return;

    const raw = Array.isArray(req.body.departments) ? req.body.departments : [];
    // Accepts either ["Testing","Service"] or the richer
    // [{department, role_title, suitability, reason}] form, because the checkbox
    // list sends the former and the per-row editor the latter.
    const entries = [];
    for (const item of raw) {
      const entry = typeof item === 'string' ? { department: item } : (item || {});
      const errors = validateObject(entry, suitabilityEntrySchema);
      if (Object.keys(errors).length) {
        return res.status(400).json({ error: Object.values(errors)[0], errors });
      }
      entries.push(entry);
    }
    if (!entries.length) {
      return res.status(400).json({ error: 'Select at least one department.' });
    }

    const ctx = await ctxOf(req);
    const saved = await ci.saveSuitability(cand.id, entries, {
      ...ctx,
      reason: req.body.reason || null,
      // Defaults to the opening they were actually assessed for, which is the
      // context that makes the judgement legible later.
      identified_from_job_id: req.body.identified_from_job_id || cand.applied_job_id || null,
    });

    logAudit({
      userId: ctx.actor_user_id, module: 'Recruitment', recordId: cand.id,
      recordType: 'candidate_suitability', action: 'create',
      newData: { departments: saved.map(s => s.department) }, req,
    });

    res.status(201).json({
      saved,
      message: `${cand.full_name} recorded as suitable for ${saved.map(s => s.department).join(', ')}.`,
    });
  } catch (error) {
    respondError(res, error);
  }
});

router.post('/suitability/:suitabilityId/convert', add, async (req, res) => {
  try {
    const jobId = parseInt(req.body.job_opening_id, 10);
    if (!Number.isInteger(jobId)) {
      return res.status(400).json({ error: 'Pick the opening to put this candidate forward for.' });
    }
    const ctx = await ctxOf(req);
    const result = await ci.convertSuitability(req.params.suitabilityId, jobId, ctx);
    if (!result) return res.status(404).json({ error: 'That suitability record no longer exists.' });

    logAudit({
      userId: ctx.actor_user_id, module: 'Recruitment',
      recordId: result.application?.candidate_id ?? null,
      recordType: 'candidate_application', action: 'create',
      newData: { from_suitability: req.params.suitabilityId, job_opening_id: jobId }, req,
    });

    res.status(result.created ? 201 : 200).json({
      ...result,
      message: result.created
        ? `Put forward for ${result.job_title}.`
        : `Already under consideration for ${result.job_title} — nothing to add.`,
    });
  } catch (error) {
    respondError(res, error);
  }
});

// ── Talent Bank membership (§17) ───────────────────────────────────────────
router.post('/candidates/:id/talent-bank', add, validateBody(talentBankSchema), async (req, res) => {
  try {
    const cand = await candidateInScope(req, res);
    if (!cand) return;
    const ctx = await ctxOf(req);
    const result = await ci.addToTalentBank(cand.id, req.body, ctx);
    if (!result) return res.status(404).json({ error: 'Candidate not found' });

    logAudit({
      userId: ctx.actor_user_id, module: 'Recruitment', recordId: cand.id,
      recordType: 'candidate_talent_pool', action: 'create',
      newData: { pools: result.pools.map(p => p.pool_name), tags: req.body.tags || [] }, req,
    });

    res.status(201).json({
      ...result,
      message: result.pools.length
        ? `${cand.full_name} kept in the Talent Bank under ${result.pools.map(p => p.pool_name).join(', ')}.`
        : `${cand.full_name} kept in the Talent Bank.`,
    });
  } catch (error) {
    respondError(res, error);
  }
});

// ── Future Opportunity (§18) ───────────────────────────────────────────────
router.post('/candidates/:id/recontact', add, validateBody(recontactSchema), async (req, res) => {
  try {
    const cand = await candidateInScope(req, res);
    if (!cand) return;

    // A recontact date in the past is a reminder that fires immediately and reads
    // as a bug. Compared as date strings, deliberately: `new Date('2026-09-27')`
    // is UTC midnight, so a same-day date in IST parses as yesterday and a guard
    // written that way fails open. This codebase has already shipped that bug once
    // in the GRN future-date check.
    const today = new Date().toISOString().slice(0, 10);
    if (String(req.body.recontact_on).slice(0, 10) < today) {
      return res.status(400).json({
        error: 'Pick a recontact date in the future.',
        errors: { recontact_on: 'The date has already passed.' },
      });
    }

    const ctx = await ctxOf(req);
    const rc = await ci.createRecontact(cand.id, req.body, ctx);
    if (!rc) return res.status(404).json({ error: 'Candidate not found' });

    logAudit({
      userId: ctx.actor_user_id, module: 'Recruitment', recordId: cand.id,
      recordType: 'candidate_recontact', action: 'create',
      newData: { recontact_on: rc.recontact_on, potential_role: rc.potential_role }, req,
    });

    res.status(201).json({
      ...rc,
      message: `${cand.full_name} saved as a future opportunity. You will be reminded on ${String(rc.recontact_on).slice(0, 10)}.`,
    });
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/candidates/:id/recontact', view, async (req, res) => {
  try {
    const cand = await candidateInScope(req, res);
    if (!cand) return;
    res.json(await ci.listRecontacts({
      company_id: cid(req), candidate_id: cand.id, status: req.query.status || 'pending',
    }));
  } catch (error) {
    respondError(res, error);
  }
});

// ── Similar candidates (§20) ───────────────────────────────────────────────
router.get('/candidates/:id/similar', view, async (req, res) => {
  try {
    const cand = await candidateInScope(req, res);
    if (!cand) return;
    const rows = await ci.findSimilar(cand.id, cid(req), { limit: req.query.limit });
    res.json(rows || []);
  } catch (error) {
    respondError(res, error);
  }
});

// ── Profile fields the redesign added (§4, §26) ────────────────────────────
// A narrow PATCH rather than widening the existing PUT /candidates/:id, whose
// schema and behaviour six screens depend on. The allowlist is the schema: a
// field not in candidateProfileSchema cannot be written here at all.
router.patch('/candidates/:id/profile', edit, async (req, res) => {
  try {
    const cand = await candidateInScope(req, res);
    if (!cand) return;

    const errors = validateObject(req.body, candidateProfileSchema, { partial: true });
    if (Object.keys(errors).length) {
      return res.status(400).json({ error: Object.values(errors)[0], errors });
    }

    const FIELDS = Object.keys(candidateProfileSchema);
    const sets = [];
    const params = [cand.id];
    let n = 2;
    for (const f of FIELDS) {
      if (req.body[f] === undefined) continue;
      if (f === 'preferred_locations') {
        const list = Array.isArray(req.body[f]) ? req.body[f] : JSON.parse(req.body[f] || '[]');
        sets.push(`preferred_locations = $${n++}::jsonb`);
        params.push(JSON.stringify(list));
      } else {
        // An empty string means "cleared", not "set to the empty string" — every
        // form in this module posts its whole state, so untouched inputs arrive
        // as ''. Writing '' into an enum column would violate its CHECK.
        sets.push(`${f} = $${n++}`);
        params.push(req.body[f] === '' ? null : req.body[f]);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

    const { rows } = await pool.query(
      `UPDATE candidates SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      params
    );

    const ctx = await ctxOf(req);
    // The two changes a recruiter needs to see on the timeline. Editing a
    // relocation note is an ordinary field edit and the audit log has it; putting
    // every field edit on the timeline would bury the events that matter.
    if (req.body.disposition && req.body.disposition !== cand.disposition) {
      await ci.recordActivity({
        company_id: ctx.company_id, candidate_id: cand.id,
        event_type: 'disposition_change',
        summary: `Candidate status: ${String(cand.disposition || 'new').replace(/_/g, ' ')} → ${String(req.body.disposition).replace(/_/g, ' ')}`,
        detail: { from: cand.disposition, to: req.body.disposition },
        actor_user_id: ctx.actor_user_id, actor_name: ctx.actor_name,
      });
    }
    if (req.body.recruiter_id !== undefined && req.body.recruiter_id !== cand.recruiter_id) {
      await ci.recordActivity({
        company_id: ctx.company_id, candidate_id: cand.id,
        event_type: 'recruiter_assigned',
        summary: 'Recruiter assigned',
        detail: { from: cand.recruiter_id, to: req.body.recruiter_id || null },
        actor_user_id: ctx.actor_user_id, actor_name: ctx.actor_name,
      });
      if (req.body.recruiter_id && req.body.recruiter_id !== ctx.actor_user_id) {
        notify(req.body.recruiter_id, cand.id, `${cand.full_name} has been assigned to you`);
      }
    }

    logAudit({
      userId: ctx.actor_user_id, module: 'Recruitment', recordId: cand.id,
      recordType: 'candidate', action: 'update',
      newData: Object.fromEntries(FIELDS.filter(f => req.body[f] !== undefined).map(f => [f, req.body[f]])),
      req,
    });

    res.json(rows[0]);
  } catch (error) {
    respondError(res, error);
  }
});

// ── Admin: correct or withdraw a timeline entry ────────────────────────────
// There is deliberately NO route here to edit or delete candidate_activity.
// §34 requires the audit history to be immutable to normal users, and the
// cheapest way to guarantee that is for the capability not to exist: no handler,
// no permission to misconfigure, no future caller to forget. A wrong event is
// corrected by appending a correcting one.
router.post('/candidates/:id/activity/correction', admin, async (req, res) => {
  try {
    const cand = await candidateInScope(req, res);
    if (!cand) return;
    const body = String(req.body.summary || '').trim();
    if (!body) return res.status(400).json({ error: 'Say what the correction is.' });

    const ctx = await ctxOf(req);
    const row = await ci.recordActivity({
      company_id: ctx.company_id, candidate_id: cand.id,
      event_type: 'correction',
      summary: body.slice(0, 500),
      detail: { corrects: req.body.corrects_activity_id || null },
      actor_user_id: ctx.actor_user_id, actor_name: ctx.actor_name,
    });
    res.status(201).json(row);
  } catch (error) {
    respondError(res, error);
  }
});

export default router;
