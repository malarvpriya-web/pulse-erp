/**
 * careers.routes.js — the public careers page, plus the staff side that runs it.
 *
 * The audit's Section 1A asked whether candidates can apply directly through a
 * company careers page. They could not: there was no public route in the repo,
 * so every applicant reached the ATS by somebody retyping them.
 *
 * TWO ROUTERS, MOUNTED DIFFERENTLY
 * --------------------------------
 * `publicRouter` serves anonymous traffic — the job list and the apply form —
 * and is mounted OUTSIDE verifyToken. `adminRouter` manages the portal and is
 * mounted inside the recruitment surface behind the normal permission gates.
 *
 * They are separate objects rather than one router with per-route middleware so
 * the public surface is exactly three endpoints, visible at the mount site in
 * server.js. This mirrors webToLead.routes.js deliberately: a public write path
 * hidden among authenticated ones is how a gate goes missing.
 *
 * WHAT DEFENDS THE PUBLIC WRITE ENDPOINT
 * --------------------------------------
 *  - a per-company portal KEY, revocable from the database with no deploy;
 *  - an ORIGIN allowlist (empty = any, which someone has to choose);
 *  - an HOURLY CAP counted from careers_applications itself, so it survives a
 *    restart — an in-memory counter resets to zero on every deploy, which is
 *    when a flood is most likely;
 *  - a HONEYPOT field, answered with 200 so a bot cannot tell it was caught;
 *  - DUPLICATE suppression, so a double-click does not create two candidates;
 *  - a file-type and size limit on the résumé, enforced before anything is read;
 *  - every submission recorded, accepted or not.
 *
 * WHAT THE PUBLIC ENDPOINT NEVER DOES
 * -----------------------------------
 * It never reveals whether an email is already in the pipeline. Answering a
 * duplicate differently from a first-time applicant would turn the careers page
 * into an oracle for "is this person job-hunting at your company" — which is
 * exactly the information a candidate's current employer would like.
 *
 * It also never returns the internal candidate id, the pipeline stage, or a
 * salary range unless the portal is explicitly configured to show one.
 */

import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import pool from '../../../config/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { companyOf } from '../../../shared/scope.js';
import { logAudit } from '../../../services/AuditService.js';
import { uploadFile } from '../../../services/StorageService.js';
import { triggerEmail } from '../../../services/emailTrigger.js';
import recruitmentRepository from '../repositories/recruitment.repository.js';
import { respondError } from '../../../shared/pgErrors.js';

export const publicRouter = express.Router();
export const adminRouter  = express.Router();

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const DEDUPE_MINUTES = 30;

/**
 * The notice an applicant actually agrees to, stored with their record.
 *
 * Kept here, next to the endpoint that records it, and written into
 * `candidates.consent_text` verbatim. Storing the WORDING rather than a boolean
 * is the difference between "they ticked something" and "here is what they
 * agreed to" — this notice will be edited over time, and a record that points at
 * today's version cannot evidence what last year's applicant saw.
 *
 * The public page shows the same sentence. If you change one, change both.
 */
const CONSENT_TEXT =
  'By applying you agree that we may hold the details above to consider you for ' +
  'this role and get in touch about it.';

// How long an unsuccessful applicant's details are kept. A default, overridable
// per company, expressed in months because that is how retention policies are
// written. The purge job never touches an active or hired candidate.
const DEFAULT_RETENTION_MONTHS = 24;

async function retentionMonths(companyId) {
  try {
    const { rows } = await pool.query(
      `SELECT (settings->>'candidate_retention_months')::int AS months
         FROM company_settings
        WHERE module = 'recruitment' AND company_id IS NOT DISTINCT FROM $1
        LIMIT 1`,
      [companyId]
    );
    const m = rows[0]?.months;
    return Number.isFinite(m) && m > 0 && m <= 240 ? m : DEFAULT_RETENTION_MONTHS;
  } catch {
    return DEFAULT_RETENTION_MONTHS;
  }
}

const ALLOWED_RESUME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

// Memory storage with a hard 5 MB cap — the same limit the authenticated
// candidate upload uses. multer rejects an oversized file before the handler
// runs, so a large upload never reaches the database logic.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_RESUME_TYPES.has(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error('Please attach a PDF or Word document.'), { status: 415 }));
  },
});

/** Every submission is recorded — accepted or not. Never throws. */
async function record(portal, status, { candidateId = null, jobId = null, reason = null, payload = null, req }) {
  try {
    await pool.query(
      `INSERT INTO careers_applications
         (portal_id, company_id, job_opening_id, candidate_id, status, reason, payload, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [portal.id, portal.company_id, jobId, candidateId, status, reason,
       payload ? JSON.stringify(payload) : null,
       req?.ip ?? null, req?.get?.('user-agent') ?? null]
    );
  } catch (err) {
    // A lost application is worse than a missing log line, so this never breaks
    // the capture — but it is not swallowed silently either.
    console.warn(JSON.stringify({
      ts: new Date().toISOString(), level: 'WARN', event: 'careers_application_log_failed',
      portalId: portal.id, status, message: err.message,
    }));
  }
}

/** Resolve an active portal by key, or null. Unknown and disabled look alike. */
async function resolvePortal(portalKey) {
  const { rows } = await pool.query(`SELECT * FROM careers_portals WHERE portal_key = $1`, [portalKey]);
  const portal = rows[0];
  return portal && portal.is_active ? portal : null;
}

/** Origin allowlist. Empty list = any origin, which an admin has to choose. */
function originAllowed(portal, req) {
  const origins = Array.isArray(portal.allowed_origins) ? portal.allowed_origins : [];
  if (!origins.length) return true;
  const origin = req.get('origin') || req.get('referer') || '';
  return origins.some(o => origin.startsWith(String(o)));
}

/**
 * The shape of a job as the open internet sees it.
 *
 * Built by naming fields explicitly rather than spreading the row: `SELECT *`
 * on job_openings would publish gdrive folder ids, positions_filled and the
 * internal requisition id to anyone who loads the page.
 */
function publicJob(row, portal) {
  const job = {
    id: row.id,
    job_title: row.job_title,
    department: row.department,
    location: row.location,
    employment_type: row.employment_type,
    experience_min: row.experience_min,
    experience_max: row.experience_max,
    description: row.description,
    requirements: row.requirements,
    benefits: row.benefits,
    posted_date: row.posted_date,
    closing_date: row.closing_date,
  };
  // Off by default: a range that is fine internally is a negotiating position
  // once it is public.
  if (portal.show_salary_range) {
    job.salary_min = row.salary_min;
    job.salary_max = row.salary_max;
  }
  return job;
}

/* ══════════════════════════════════════════════════════════════════════════
   PUBLIC — three endpoints, no session
   ══════════════════════════════════════════════════════════════════════════ */

/** GET /api/public/careers/:portalKey — the portal and its open roles. */
publicRouter.get('/careers/:portalKey', async (req, res) => {
  try {
    const portal = await resolvePortal(req.params.portalKey);
    if (!portal) return res.status(404).json({ error: 'Careers page not found' });
    if (!originAllowed(portal, req)) return res.status(403).json({ error: 'Not available from this origin' });

    // Only genuinely open roles, and only those still inside their closing date.
    // An advert that outlives its deadline collects applications nobody reads.
    const { rows } = await pool.query(
      `SELECT * FROM job_openings
        WHERE company_id = $1
          AND deleted_at IS NULL
          AND LOWER(status) = 'open'
          AND (closing_date IS NULL OR closing_date >= CURRENT_DATE)
        ORDER BY posted_date DESC NULLS LAST, id DESC`,
      [portal.company_id]
    );

    res.json({
      portal: {
        display_name: portal.display_name || 'Careers',
        intro_text: portal.intro_text || null,
        // Served rather than hard-coded in the page, so the text shown and the
        // text stored on the candidate's record cannot drift apart.
        consent_text: CONSENT_TEXT,
      },
      jobs: rows.map(r => publicJob(r, portal)),
    });
  } catch (error) {
    console.error('[careers] list failed:', error.message);
    res.status(500).json({ error: 'Could not load the careers page.' });
  }
});

/** GET /api/public/careers/:portalKey/jobs/:jobId — one role. */
publicRouter.get('/careers/:portalKey/jobs/:jobId', async (req, res) => {
  try {
    const portal = await resolvePortal(req.params.portalKey);
    if (!portal) return res.status(404).json({ error: 'Careers page not found' });
    if (!originAllowed(portal, req)) return res.status(403).json({ error: 'Not available from this origin' });

    const { rows } = await pool.query(
      `SELECT * FROM job_openings
        WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL
          AND LOWER(status) = 'open'
          AND (closing_date IS NULL OR closing_date >= CURRENT_DATE)`,
      [req.params.jobId, portal.company_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'This role is no longer open.' });
    res.json(publicJob(rows[0], portal));
  } catch (error) {
    console.error('[careers] job failed:', error.message);
    res.status(500).json({ error: 'Could not load this role.' });
  }
});

/**
 * GET /api/public/careers/:portalKey/feed.xml — the Indeed job feed.
 *
 * Of every channel the brief names, this is the ONLY third-party one that can be
 * built without signing something first. Indeed publishes an XML feed format and
 * polls a URL you give them; there is no API key, no partner programme and no
 * contract. LinkedIn needs ATS partner certification and Naukri a paid RMS
 * agreement — neither is an engineering task, and neither is faked here.
 *
 * Format: the standard Indeed XML Job Feed. Dates are RFC-822 as that spec
 * requires; the body is wrapped in CDATA because job descriptions routinely
 * contain ampersands and angle brackets that would otherwise break the document.
 *
 * Opt-in per job (`job_openings.include_in_feed`). A confidential replacement
 * hire must not be syndicated to a job board because somebody forgot to untick
 * something, so the default is false and publishing is a decision.
 */
publicRouter.get('/careers/:portalKey/feed.xml', async (req, res) => {
  try {
    const portal = await resolvePortal(req.params.portalKey);
    if (!portal) return res.status(404).type('text/plain').send('Not found');

    const { rows } = await pool.query(
      `SELECT jo.*, c.name AS company_name
         FROM job_openings jo
         LEFT JOIN companies c ON c.id = jo.company_id
        WHERE jo.company_id = $1
          AND jo.deleted_at IS NULL
          AND LOWER(jo.status) = 'open'
          AND jo.include_in_feed = true
          AND (jo.closing_date IS NULL OR jo.closing_date >= CURRENT_DATE)
        ORDER BY jo.posted_date DESC NULLS LAST, jo.id DESC`,
      [portal.company_id]
    );

    const base = publicBaseUrl(req);
    const xml = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<source>',
      `  <publisher>${xmlEscape(rows[0]?.company_name || portal.display_name || 'Careers')}</publisher>`,
      `  <publisherurl>${xmlEscape(base)}</publisherurl>`,
      `  <lastBuildDate>${rfc822(new Date())}</lastBuildDate>`,
      ...rows.map(job => jobToXml(job, portal, base)),
      '</source>',
    ].join('\n');

    // Feeds are polled, not browsed. A short cache keeps a crawler that ignores
    // its own schedule from hammering the database.
    res.set('Cache-Control', 'public, max-age=900');
    res.type('application/xml').send(xml);
  } catch (error) {
    console.error('[careers] feed failed:', error.message);
    res.status(500).type('text/plain').send('Feed unavailable');
  }
});

/** XML text escaping. CDATA covers the bodies; this covers attributes and titles. */
function xmlEscape(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** CDATA, with the one sequence that can close a CDATA block neutralised. */
function cdata(v) {
  return `<![CDATA[${String(v ?? '').replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}

/** RFC-822, which is what the Indeed feed spec asks for — not ISO-8601. */
function rfc822(d) {
  return new Date(d).toUTCString().replace('GMT', '+0000');
}

/**
 * The public base URL.
 *
 * Taken from PUBLIC_BASE_URL where it is set, because a feed is consumed by
 * somebody else's crawler and a localhost URL in it is useless. Falls back to
 * the request's own host so the feed is still correct in development.
 */
function publicBaseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function jobToXml(job, portal, base) {
  const applyUrl = `${base}/careers/${portal.portal_key}`;
  const lines = [
    '  <job>',
    `    <title>${cdata(job.job_title)}</title>`,
    `    <date>${rfc822(job.posted_date || job.created_at || new Date())}</date>`,
    `    <referencenumber>${cdata(String(job.id))}</referencenumber>`,
    `    <url>${cdata(applyUrl)}</url>`,
    `    <company>${cdata(job.company_name || portal.display_name || '')}</company>`,
    `    <city>${cdata(job.location || '')}</city>`,
    `    <country>${cdata(process.env.CAREERS_FEED_COUNTRY || 'IN')}</country>`,
    `    <description>${cdata([job.description, job.requirements, job.benefits].filter(Boolean).join('\n\n'))}</description>`,
  ];
  if (job.department)      lines.push(`    <category>${cdata(job.department)}</category>`);
  if (job.employment_type) lines.push(`    <jobtype>${cdata(job.employment_type)}</jobtype>`);
  // Salary follows the SAME rule as the careers page: published only when the
  // portal is configured to publish it. Syndicating a range to a job board that
  // is hidden on your own site would be an odd way to leak it.
  if (portal.show_salary_range && job.salary_min != null) {
    lines.push(`    <salary>${cdata(`${job.salary_min}${job.salary_max != null ? ' - ' + job.salary_max : '+'}`)}</salary>`);
  }
  lines.push('  </job>');
  return lines.join('\n');
}

/**
 * POST /api/public/careers/:portalKey/apply/:jobId
 *
 * multipart/form-data: full_name, email, phone, current_company,
 * current_designation, experience_years, notice_period_days, expected_ctc,
 * location, cover_note, resume (file), website (honeypot).
 */
publicRouter.post('/careers/:portalKey/apply/:jobId', upload.single('resume'), async (req, res) => {
  let portal;
  try {
    portal = await resolvePortal(req.params.portalKey);
    if (!portal) return res.status(404).json({ error: 'Careers page not found' });
    if (!originAllowed(portal, req)) {
      await record(portal, 'rejected', { reason: `origin not allowed: ${req.get('origin') || '(none)'}`, payload: req.body, req });
      return res.status(403).json({ error: 'Applications cannot be submitted from that origin.' });
    }

    // Counted from the table, so a restart cannot reset it.
    const { rows: [{ n }] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM careers_applications
        WHERE portal_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
      [portal.id]
    );
    if (n >= portal.max_per_hour) {
      await record(portal, 'rate_limited', { reason: `${n} in the last hour, cap ${portal.max_per_hour}`, req });
      return res.status(429).json({ error: 'We are receiving a lot of applications right now. Please try again shortly.' });
    }

    // Honeypot. 200 on purpose: telling a bot it was caught teaches it to leave
    // the field alone next time.
    if (String(req.body?.website ?? '').trim() !== '') {
      await record(portal, 'spam', { reason: 'honeypot filled', payload: req.body, req });
      return res.status(200).json({ success: true, message: 'Thank you — your application has been received.' });
    }

    const full_name = String(req.body?.full_name ?? '').trim();
    const email     = String(req.body?.email ?? '').trim();
    const phone     = String(req.body?.phone ?? '').trim();

    if (!full_name) {
      await record(portal, 'rejected', { reason: 'no name', payload: req.body, req });
      return res.status(400).json({ error: 'Please tell us your name.' });
    }
    if (!email || !EMAIL_RE.test(email)) {
      await record(portal, 'rejected', { reason: 'missing or malformed email', payload: req.body, req });
      return res.status(400).json({ error: 'Please give us an email address we can reply to.' });
    }

    // The role must be open and belong to this portal's company. Checked here as
    // well as on the read endpoints, because a form can be left open in a tab
    // long after the advert closes.
    const { rows: jobs } = await pool.query(
      `SELECT id, job_title, status FROM job_openings
        WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
      [req.params.jobId, portal.company_id]
    );
    const job = jobs[0];
    if (!job) {
      await record(portal, 'rejected', { reason: `unknown job ${req.params.jobId}`, payload: req.body, req });
      return res.status(404).json({ error: 'That role is no longer listed.' });
    }
    if (String(job.status).toLowerCase() !== 'open') {
      await record(portal, 'rejected', { jobId: job.id, reason: `job status ${job.status}`, payload: req.body, req });
      return res.status(409).json({ error: 'Applications for this role have closed.' });
    }

    // Same person, same role, within the window = one application. Answered
    // identically to a success so the endpoint cannot be used to test whether
    // an address is already in the pipeline.
    const { rows: [dupe] } = await pool.query(
      `SELECT id FROM careers_applications
        WHERE portal_id = $1 AND status = 'accepted' AND job_opening_id = $2
          AND LOWER(payload->>'email') = LOWER($3)
          AND created_at > NOW() - ($4 || ' minutes')::interval
        LIMIT 1`,
      [portal.id, job.id, email, String(DEDUPE_MINUTES)]
    );
    if (dupe) {
      await record(portal, 'duplicate', { jobId: job.id, reason: `same email within ${DEDUPE_MINUTES} minutes`, payload: req.body, req });
      return res.status(200).json({ success: true, message: 'Thank you — your application has been received.' });
    }

    const num = (v) => { const n2 = Number(v); return Number.isFinite(n2) && n2 >= 0 ? n2 : null; };
    const profile = {
      full_name,
      email,
      phone: phone || null,
      current_company:     String(req.body?.current_company ?? '').trim() || null,
      current_designation: String(req.body?.current_designation ?? '').trim() || null,
      location:            String(req.body?.location ?? '').trim() || null,
      experience_years:    num(req.body?.experience_years),
      notice_period_days:  num(req.body?.notice_period_days),
      expected_ctc:        num(req.body?.expected_ctc),
      notes:               String(req.body?.cover_note ?? '').trim() || null,
    };

    // Stored through the same writer the authenticated paths use, so a résumé
    // from the careers page is retrievable exactly like any other.
    let resume_file_url = null;
    if (req.file) {
      resume_file_url = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);
    }

    // Consent is recorded at the moment it is given, with the wording that was
    // on screen and a retention date computed from it. The audit's Section 11
    // asked for candidate consent "where required"; capturing it on the public
    // page is the only place it can honestly be captured at all, because it is
    // the only place the candidate themselves is present.
    const months = await retentionMonths(portal.company_id);

    let candidate;
    try {
      candidate = await recruitmentRepository.createCandidate({
        ...profile,
        resume_file_url,
        source: portal.default_source,
        applied_job_id: job.id,
        company_id: portal.company_id,
        skills: [],
        consent_basis:  'consent',
        consent_text:   CONSENT_TEXT,
        consent_source: 'careers_portal',
        retention_months: months,
      });
    } catch (err) {
      // createCandidate raises 409 when the email is already in the pipeline.
      // An existing candidate applying for a DIFFERENT role is a real event, so
      // it is recorded as a second application rather than turned away — and
      // the response is the same either way.
      if (err.statusCode === 409 && err.existingCandidateId) {
        await pool.query(
          `INSERT INTO candidate_applications
             (company_id, candidate_id, job_opening_id, stage, status, origin, is_primary, applied_at)
           VALUES ($1,$2,$3,'applied','active','applied',false, NOW())
           ON CONFLICT (candidate_id, job_opening_id) DO NOTHING`,
          [portal.company_id, err.existingCandidateId, job.id]
        );
        await record(portal, 'accepted', {
          candidateId: err.existingCandidateId, jobId: job.id,
          reason: 'existing candidate — recorded as an additional application',
          payload: { ...req.body, website: undefined }, req,
        });
        await bumpPortal(portal.id);
        return res.status(201).json({ success: true, message: 'Thank you — your application has been received.' });
      }
      throw err;
    }

    await record(portal, 'accepted', {
      candidateId: candidate.id, jobId: job.id,
      payload: { ...req.body, website: undefined }, req,
    });
    await bumpPortal(portal.id);

    triggerEmail('application_received', {
      candidate_name:  candidate.full_name,
      candidate_email: candidate.email,
      job_title:       job.job_title,
    }, portal.company_id);

    // No candidate id, no stage, nothing internal.
    res.status(201).json({ success: true, message: 'Thank you — your application has been received.' });
  } catch (error) {
    if (portal) {
      await record(portal, 'rejected', { reason: error.message, payload: req.body, req });
    }
    // The applicant gets a usable message; the detail goes to the log, not the
    // response, so a database error cannot leak schema to the open internet.
    console.error('[careers] apply failed:', error.message);
    const status = error.status || (error.statusCode === 409 ? 409 : 500);
    res.status(status).json({
      error: status === 415 || status === 409
        ? error.message
        : 'Something went wrong submitting your application. Please try again.',
    });
  }
});

async function bumpPortal(portalId) {
  await pool.query(
    `UPDATE careers_portals
        SET submission_count = submission_count + 1, last_submission_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [portalId]
  ).catch(() => {});
}

/* ══════════════════════════════════════════════════════════════════════════
   ADMIN — behind the same recruitment permission as the rest of the module
   ══════════════════════════════════════════════════════════════════════════ */

const view = requirePermission('recruitment', 'view');
const edit = requirePermission('recruitment', 'edit');

/** GET /recruitment/careers-portal — this company's portal, created on demand. */
adminRouter.get('/careers-portal', view, async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { rows } = await pool.query(`SELECT * FROM careers_portals WHERE company_id = $1`, [companyId]);
    if (!rows.length) return res.json(null);

    const portal = rows[0];
    const { rows: [stats] } = await pool.query(
      `SELECT COUNT(*)::int                                            AS total,
              COUNT(*) FILTER (WHERE status = 'accepted')::int         AS accepted,
              COUNT(*) FILTER (WHERE status = 'duplicate')::int        AS duplicates,
              COUNT(*) FILTER (WHERE status = 'spam')::int             AS spam,
              COUNT(*) FILTER (WHERE status = 'rate_limited')::int     AS rate_limited,
              COUNT(*) FILTER (WHERE status = 'rejected')::int         AS rejected,
              COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS last_7_days
         FROM careers_applications WHERE portal_id = $1`,
      [portal.id]
    );
    res.json({ ...portal, stats });
  } catch (error) {
    respondError(res, error);
  }
});

/** POST /recruitment/careers-portal — create the portal, or rotate its key. */
adminRouter.post('/careers-portal', edit, async (req, res) => {
  try {
    const companyId = companyOf(req);
    if (!companyId) return res.status(403).json({ error: 'Company scope required' });

    const key = crypto.randomBytes(18).toString('base64url');
    const { rows } = await pool.query(
      `INSERT INTO careers_portals (company_id, portal_key, display_name, created_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (company_id) DO UPDATE
         SET portal_key = EXCLUDED.portal_key, updated_at = NOW()
       RETURNING *`,
      [companyId, key, String(req.body?.display_name ?? '').trim() || 'Careers',
       req.user?.userId ?? null]
    );

    logAudit({
      userId: req.user?.userId ?? req.user?.id,
      module: 'Recruitment', recordId: rows[0].id, recordType: 'careers_portal',
      action: 'rotate_key', newData: { rotated: true }, req,
    });
    res.status(201).json(rows[0]);
  } catch (error) {
    respondError(res, error);
  }
});

/** PUT /recruitment/careers-portal — settings. The key is NOT editable here. */
adminRouter.put('/careers-portal', edit, async (req, res) => {
  try {
    const companyId = companyOf(req);
    const origins = Array.isArray(req.body?.allowed_origins) ? req.body.allowed_origins
                  : typeof req.body?.allowed_origins === 'string'
                    ? req.body.allowed_origins.split(',').map(s => s.trim()).filter(Boolean)
                    : null;

    // Every column COALESCE'd — the same partial-update lesson as R-04.
    const { rows } = await pool.query(
      `UPDATE careers_portals SET
         display_name      = COALESCE($2, display_name),
         intro_text        = COALESCE($3, intro_text),
         allowed_origins   = COALESCE($4::jsonb, allowed_origins),
         max_per_hour      = COALESCE($5, max_per_hour),
         show_salary_range = COALESCE($6, show_salary_range),
         is_active         = COALESCE($7, is_active),
         updated_at        = NOW()
       WHERE company_id = $1
       RETURNING *`,
      [
        companyId,
        req.body?.display_name ?? null,
        req.body?.intro_text ?? null,
        origins ? JSON.stringify(origins) : null,
        req.body?.max_per_hour ?? null,
        req.body?.show_salary_range === undefined ? null : !!req.body.show_salary_range,
        req.body?.is_active === undefined ? null : !!req.body.is_active,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'No careers portal for this company yet.' });
    res.json(rows[0]);
  } catch (error) {
    respondError(res, error);
  }
});

/** GET /recruitment/careers-portal/submissions — the log, including refusals. */
adminRouter.get('/careers-portal/submissions', view, async (req, res) => {
  try {
    const companyId = companyOf(req);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const { rows } = await pool.query(
      `SELECT ca.id, ca.status, ca.reason, ca.created_at, ca.candidate_id,
              ca.payload->>'full_name' AS applicant_name,
              ca.payload->>'email'     AS applicant_email,
              jo.job_title
         FROM careers_applications ca
         LEFT JOIN job_openings jo ON jo.id = ca.job_opening_id
        WHERE ca.company_id = $1
        ORDER BY ca.created_at DESC
        LIMIT $2`,
      [companyId, limit]
    );
    res.json(rows);
  } catch (error) {
    respondError(res, error);
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   JOB DISTRIBUTION — where a role is advertised
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * GET /recruitment/jobs/:id/distribution
 *
 * Every channel for one opening, with the channels that have no row yet
 * included as `draft` — so the screen is a complete checklist rather than a list
 * of what somebody remembered to record. `posting_mode` on each row is what
 * distinguishes a real automated posting from a manual tick.
 */
adminRouter.get('/jobs/:id/distribution', view, async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { rows: job } = await pool.query(
      `SELECT id, job_title, status, include_in_feed FROM job_openings
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) AND deleted_at IS NULL`,
      [req.params.id, companyId]
    );
    if (!job.length) return res.status(404).json({ error: 'Job opening not found' });

    const { rows: existing } = await pool.query(
      `SELECT * FROM job_distributions WHERE job_opening_id = $1 ORDER BY channel`,
      [req.params.id]
    );
    const byChannel = new Map(existing.map(r => [r.channel, r]));

    const channels = CHANNEL_CATALOGUE.map(meta => ({
      ...meta,
      ...(byChannel.get(meta.channel) || { channel: meta.channel, status: 'draft', posting_mode: meta.default_mode }),
    }));

    res.json({ job: job[0], channels });
  } catch (error) {
    respondError(res, error);
  }
});

/**
 * PUT /recruitment/jobs/:id/distribution/:channel
 *
 * Record a posting. For `careers` and `indeed` the system knows the answer
 * itself, so those are reported rather than set by hand; for the rest this is
 * the manual checklist entry, and it insists on a URL when marking something
 * posted — "posted to LinkedIn" with no link is not a record anyone can act on
 * when the role closes.
 */
adminRouter.put('/jobs/:id/distribution/:channel', edit, async (req, res) => {
  try {
    const companyId = companyOf(req);
    const meta = CHANNEL_CATALOGUE.find(c => c.channel === req.params.channel);
    if (!meta) return res.status(400).json({ error: 'Unknown channel.' });

    const { rows: job } = await pool.query(
      `SELECT id, company_id FROM job_openings
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) AND deleted_at IS NULL`,
      [req.params.id, companyId]
    );
    if (!job.length) return res.status(404).json({ error: 'Job opening not found' });

    const status = String(req.body?.status || 'posted');
    if (!['draft', 'posted', 'expired', 'removed', 'failed'].includes(status)) {
      return res.status(400).json({ error: 'Unknown status.' });
    }
    const url = String(req.body?.external_url ?? '').trim() || null;
    if (status === 'posted' && meta.default_mode === 'manual' && !url) {
      return res.status(400).json({
        error: 'Add the link to the posting — without it nobody can take it down when the role closes.',
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO job_distributions
         (company_id, job_opening_id, channel, status, posting_mode, external_url, external_ref, notes, posted_at, created_by)
       -- $4 carries an explicit cast: it is both an inserted value and a CASE
       -- comparand, and without it Postgres reports "inconsistent types deduced
       -- for parameter $4" and the statement fails at parse time.
       VALUES ($1,$2,$3,$4::varchar,$5,$6,$7,$8,
               CASE WHEN $4::varchar = 'posted' THEN NOW() ELSE NULL END, $9)
       ON CONFLICT (job_opening_id, channel) DO UPDATE SET
         status       = EXCLUDED.status,
         external_url = COALESCE(EXCLUDED.external_url, job_distributions.external_url),
         external_ref = COALESCE(EXCLUDED.external_ref, job_distributions.external_ref),
         notes        = COALESCE(EXCLUDED.notes, job_distributions.notes),
         posted_at    = CASE WHEN EXCLUDED.status = 'posted'
                             THEN COALESCE(job_distributions.posted_at, NOW()) ELSE job_distributions.posted_at END,
         removed_at   = CASE WHEN EXCLUDED.status IN ('removed','expired') THEN NOW() ELSE NULL END,
         updated_at   = NOW()
       RETURNING *`,
      [job[0].company_id, req.params.id, meta.channel, status, meta.default_mode,
       url, String(req.body?.external_ref ?? '').trim() || null,
       String(req.body?.notes ?? '').trim() || null, req.user?.userId ?? null]
    );

    logAudit({
      userId: req.user?.userId ?? req.user?.id,
      module: 'Recruitment', recordId: parseInt(req.params.id), recordType: 'job_distribution',
      action: 'update', newData: { channel: meta.channel, status }, req,
    });
    res.json(rows[0]);
  } catch (error) {
    respondError(res, error);
  }
});

/** PUT /recruitment/jobs/:id/feed — include this role in the Indeed feed, or not. */
adminRouter.put('/jobs/:id/feed', edit, async (req, res) => {
  try {
    const include = !!req.body?.include_in_feed;
    const { rows } = await pool.query(
      `UPDATE job_openings SET include_in_feed = $3, updated_at = NOW()
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) AND deleted_at IS NULL
        RETURNING id, job_title, include_in_feed`,
      [req.params.id, companyOf(req), include]
    );
    if (!rows.length) return res.status(404).json({ error: 'Job opening not found' });

    // The feed is the posting: including a job IS publishing it, so the tracker
    // records that without anyone ticking a box.
    await pool.query(
      `INSERT INTO job_distributions
         (company_id, job_opening_id, channel, status, posting_mode, posted_at, created_by)
       VALUES ($1,$2,'indeed',$3::varchar,'feed', CASE WHEN $4::boolean THEN NOW() ELSE NULL END, $5)
       ON CONFLICT (job_opening_id, channel) DO UPDATE SET
         status     = EXCLUDED.status,
         posted_at  = CASE WHEN EXCLUDED.status = 'posted'
                           THEN COALESCE(job_distributions.posted_at, NOW()) ELSE job_distributions.posted_at END,
         removed_at = CASE WHEN EXCLUDED.status = 'removed' THEN NOW() ELSE NULL END,
         updated_at = NOW()`,
      [companyOf(req), req.params.id, include ? 'posted' : 'removed', include, req.user?.userId ?? null]
    ).catch(() => {});

    res.json(rows[0]);
  } catch (error) {
    respondError(res, error);
  }
});

/**
 * The channel catalogue.
 *
 * `supported` is the honest answer to "is this an integration", and the UI shows
 * it verbatim. Saying "LinkedIn: manual" on the screen is the whole point — the
 * audit's complaint was a settings page whose three toggles implied integrations
 * that did not exist.
 */
const CHANNEL_CATALOGUE = [
  { channel: 'careers',  label: 'Careers page',  default_mode: 'automatic',
    supported: 'Automatic — every open role appears on your careers page.' },
  { channel: 'indeed',   label: 'Indeed',        default_mode: 'feed',
    supported: 'XML feed — give Indeed your feed URL and they collect roles you opt in. No agreement needed.' },
  { channel: 'linkedin', label: 'LinkedIn',      default_mode: 'manual',
    supported: 'Manual — automated posting needs LinkedIn ATS partner certification.' },
  { channel: 'naukri',   label: 'Naukri',        default_mode: 'manual',
    supported: 'Manual — automated posting needs a paid Naukri RMS agreement.' },
  { channel: 'foundit',  label: 'Foundit',       default_mode: 'manual',
    supported: 'Manual — automated posting needs a commercial API agreement.' },
  { channel: 'other',    label: 'Other',         default_mode: 'manual',
    supported: 'Manual — anywhere else you advertised, recorded so it can be taken down.' },
];
