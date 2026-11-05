/**
 * secureFiles.routes.js
 *
 * Replaces the public express.static("/uploads") mount.
 * Every file download requires a valid JWT and ownership check:
 *   - super_admin / admin: any file
 *   - hr_manager / hr / payroll_admin: employee documents
 *   - employee: only files linked to their own employee record
 *   - candidate résumés: any caller holding recruitment:view, same company
 *   - intern photos / documents: internships:view, same company
 *
 * Access is audit-logged on every successful download.
 */

import { Router } from 'express';
import path        from 'path';
import fs          from 'fs';
import { verifyToken, permissionFor } from '../../middlewares/auth.middleware.js';
import pool              from '../../config/db.js';
// The writer's own constant, not a second path.resolve() of our own. This file
// used to compute '../../../../uploads' from src/modules/files/, which resolves
// to Pulse/uploads — one level ABOVE the backend/uploads that StorageService
// actually writes to. That directory does not exist, so every download 404'd at
// the existence check below before any permission logic ran: no file uploaded
// through StorageService could ever be retrieved through the only route that
// serves files.
import { LOCAL_UPLOAD_DIR } from '../../services/StorageService.js';

const UPLOADS_ROOT = LOCAL_UPLOAD_DIR;


// Inline-viewable types. A deliberately SHORT allowlist: `Content-Disposition:
// inline` tells the browser to render the bytes in place, which for text/html or
// image/svg+xml means executing attacker-supplied markup and script on this
// origin. PDF and raster images render without script. Everything else keeps
// `attachment`, which is the safe default this route has always used.
//
// Extension-driven rather than sniffed, because res.sendFile() sets Content-Type
// from the extension too — deciding disposition from anything else would let the
// two disagree.
const INLINE_VIEWABLE = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp']);

// Shared by both ownership branches — every successful download is audit-logged
// before the bytes go out, and none is served any other way.
function sendFile(req, res, absPath, filename, userId) {
  // §5 of the recruitment brief: "the recruiter should NOT have to download the
  // résumé just to read it." This route hardcoded `attachment`, so an <iframe>
  // pointed at it triggered a download instead of rendering — which is why the
  // candidate profile had no résumé viewer to fix. `?disposition=inline` opts in.
  const wantsInline = String(req.query.disposition || '').toLowerCase() === 'inline';
  const ext = path.extname(filename).toLowerCase();
  const inline = wantsInline && INLINE_VIEWABLE.has(ext);

  pool.query(
    `INSERT INTO audit_logs (user_id, module_name, action_type, reference_type, new_data_json, ip_address)
     VALUES ($1, 'files', $2, 'file', $3, $4)`,
    // 'view' and 'download' are recorded as DIFFERENT actions. Reading a résumé
    // on screen and taking a copy of it are not the same act, and an audit log
    // that calls them both "download" cannot answer which one happened.
    [userId, inline ? 'view' : 'download', JSON.stringify({ filename, inline }), req.ip || null]
  ).catch(() => {});

  res.setHeader('Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(filename)}"`);
  // Belt and braces for the inline case: even on the allowlist, a stored file
  // must never be able to run script against this origin or be framed by a third
  // party site.
  if (inline) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; object-src 'self'; frame-ancestors 'self'");
  }
  return res.sendFile(absPath);
}

// Does this caller hold recruitment:view? Mirrors requirePermission's lookup but
// returns a boolean instead of terminating the response, because a "no" here
// means fall through to the next ownership branch, not 403 immediately.
async function recruitmentViewPermission(req) {
  const role = (req.user?.role || '').toLowerCase();
  if (role === 'super_admin' || role === 'admin') return true;
  try {
    const { rows } = await pool.query(
      `SELECT BOOL_OR(rp.can_view) AS can_view
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
        WHERE ur.user_id = $1 AND rp.module = 'recruitment'`,
      [req.user?.userId]
    );
    return rows[0]?.can_view === true;
  } catch { return false; }
}

const router = Router();

// All file requests require a valid token
router.use(verifyToken);

/**
 * HEAD /api/files/:filename
 *
 * "Is this file actually there?" — the same authorization as GET, no bytes and
 * no audit entry.
 *
 * View Employee lists an employee's documents from the `employees.*_file`
 * columns, which are just stored paths: a row renders whether or not anything
 * is behind it. Five of EMP003's five PDF columns point at files that are not
 * on disk, so the tab advertised "PAN Card — On file" for a document nobody
 * could open, and the only way to find out was to click View and get an error.
 * This lets the page ask first and say "Missing" instead.
 *
 * Registered BEFORE the GET handler on purpose. Express answers HEAD from a GET
 * route by running the GET handler and dropping the body — which would work,
 * but would also write a `download` row to `audit_logs` for every existence
 * probe the page makes. Reading a document and checking whether it exists are
 * not the same act, and the audit trail already draws that distinction between
 * 'view' and 'download'.
 */
router.head('/:filename', async (req, res) => {
  const { filename } = req.params;
  if (!filename || /[/\\]/.test(filename) || filename.includes('..')) return res.sendStatus(400);
  if (!fs.existsSync(path.join(UPLOADS_ROOT, filename))) return res.sendStatus(404);

  try {
    const allowed = await canReadFile(req, filename);
    return res.sendStatus(allowed ? 200 : 403);
  } catch {
    return res.sendStatus(500);
  }
});

/**
 * Does this caller hold `bgv` view permission? A boolean, not a terminating
 * middleware, because a "no" falls through to the next ownership branch.
 *
 * ⚠ Uses permissionFor(), NOT a hand-rolled `user_roles JOIN role_permissions`
 * like recruitmentViewPermission above. That query only sees roles recorded in
 * the `user_roles` table, and this codebase also carries a caller's role on
 * `users.role` / the JWT — so for an HR login whose role is not mirrored into
 * user_roles it returns false, and HR would be refused the report the BGV page
 * just let them upload. permissionFor() resolves the same user-override →
 * role-union precedence requirePermission uses, which is the whole point: the
 * file route and the module route then agree by construction.
 */
async function bgvViewPermission(req) {
  try {
    const perm = await permissionFor(req, 'bgv');
    return perm?.can_view === true;
  } catch { return false; }
}

/**
 * May this caller read the findings behind a discrepancy?
 *
 * The same grant bgv.routes.js consults (`canSeeSensitive`). Kept as its own
 * lookup rather than imported so this route has no dependency on the BGV router,
 * but it MUST stay the same module name and the same column — a second answer to
 * "who may read a discrepancy report" is how the folder view and the download
 * come to disagree.
 */
async function bgvSensitivePermission(req) {
  try {
    const perm = await permissionFor(req, 'bgv_sensitive');
    return perm?.can_view === true;
  } catch { return false; }
}

/**
 * Is this filename a background-verification report, and if so whose?
 *
 * BGV reports are written by StorageService exactly like every other upload, so
 * they land in the same directory — but they are indexed in `bgv_documents`, not
 * in any `employees.*_file` column, so the lookup above matches nothing and the
 * request falls through to the admin-only branch. Without this branch HR could
 * upload a verification report through the BGV page and then not be able to open
 * it: the module's own permission grant would be silently overridden by a role
 * list in the file route. That is the
 * [[project_pulse01_env_write_rbac_killswitch]] lesson in reverse — gating an
 * endpoint is not finished until you check what the rest of the app does with
 * the answer.
 *
 * Returns { company_id, employee_id, check_type, result } or null. `result` is
 * carried because a report on a DISCREPANCY check needs the extra
 * `bgv_sensitive` grant — hiding it in the folder view while this route still
 * served the bytes would be a gate with a hole behind it, which is the shape of
 * [[project_pulse01_env_write_rbac_killswitch]].
 */
async function bgvDocumentOwner(filename) {
  const { rows } = await pool.query(
    `SELECT e.company_id, e.id AS employee_id, ch.check_type, ch.result
       FROM bgv_documents d
       JOIN bgv_checks ch ON ch.id = d.check_id
       JOIN bgv_cases  c  ON c.id  = ch.case_id
       JOIN employees  e  ON e.id  = c.employee_id AND e.deleted_at IS NULL
      WHERE d.file_url LIKE $1
      LIMIT 1`,
    [`%${filename}`]
  );
  return rows[0] ?? null;
}

/**
 * Is this filename an intern's photo or document, and if so which company's?
 *
 * Interns are not employees (see 20261013000002_internships.js), so their files
 * match nothing in the `employees.*_file` lookup and would otherwise fall through
 * to admin-only — HR could upload an intern's college letter and then not open
 * it. A removed document (deleted_at set) is not matched, so it stops being
 * served the moment it is removed.
 *
 * ⚠ No self-access branch: interns hold no login.
 */
async function internFileOwner(filename) {
  const { rows } = await pool.query(
    `SELECT company_id FROM interns
      WHERE deleted_at IS NULL AND photo_url LIKE $1
     UNION ALL
     SELECT d.company_id FROM intern_documents d
       JOIN interns i ON i.id = d.intern_id AND i.deleted_at IS NULL
      WHERE d.deleted_at IS NULL AND d.file_url LIKE $1
     LIMIT 1`,
    [`%${filename}`]
  );
  return rows[0] ?? null;
}

/** employee_documents:view — the explicit HR document grant (§202) that GET
 *  /self-service/documents lists a colleague's documents on. The file behind
 *  an entry, and the identity uploads on the employee row (PAN, Aadhaar,
 *  cancelled cheque, bank statement, résumé, offer letter), follow it. They
 *  used to open for a role list read from the primary role alone, which let
 *  payroll_admin and finance_manager open every colleague's identity
 *  documents. The owner always opens their own. */
async function hrDocumentViewPermission(req) {
  try {
    const perm = await permissionFor(req, 'employee_documents');
    return perm?.can_view === true;
  } catch { return false; }
}

/** internships:view, through the same resolver requirePermission uses. */
async function internViewPermission(req) {
  try {
    const perm = await permissionFor(req, 'internships');
    return perm?.can_view === true;
  } catch { return false; }
}

/**
 * Does this caller hold the file? The ownership half of the GET handler,
 * extracted so HEAD asks exactly the same question — a probe that used a looser
 * rule than the download would leak the existence of another tenant's files.
 */
/*
 * SELF-ACCESS is decided by `users.employee_id = employees.id`.
 *
 * ⚠ Both ownership queries used to join `users.email = employees.company_email`
 * (exact case, no company predicate). Company email is editable on Edit
 * Employee and is not the login: an employee who signs in with a different
 * address (user 880 / employee 1 on 2026-10-12) could never open their own
 * documents, an edit of the company email cut the employee off, and setting it
 * to ANOTHER account's login email handed that account this employee's PAN,
 * Aadhaar and bank documents — across tenants, since users.email is global.
 */
/**
 * Self-service / HR personnel documents (`employee_documents.file_url`,
 * uploaded through POST /self-service/documents). They match no
 * `employees.*_file` column, so they fell through to admin-only: the employee
 * who uploaded a document, and the HR team who must verify it, could not open
 * it. Readable by the document's own employee (users.employee_id link) and by
 * admin / HR of the same company — nobody else. PAYROLL_DATA_FLOW_AUDIT.md Part 12.
 */
async function employeeDocumentOwner(filename) {
  const { rows } = await pool.query(
    `SELECT d.employee_id, e.company_id
       FROM employee_documents d JOIN employees e ON e.id = d.employee_id
      WHERE d.file_url LIKE $1
      LIMIT 1`, [`%/${filename}`]);
  return rows[0] || null;
}
async function ownsEmployeeDocument(userId, employeeId) {
  const { rows } = await pool.query('SELECT 1 FROM users WHERE id = $1 AND employee_id = $2', [userId, employeeId]);
  return rows.length > 0;
}

async function canReadFile(req, filename) {
  const { userId, role } = req.user;
  const companyId = req.scope?.company_id ?? null;
  const isAdmin   = ['super_admin', 'admin'].includes((role || '').toLowerCase());
  const isHR      = ['hr_manager', 'hr_exec', 'hr', 'payroll_admin', 'finance_manager'].includes((role || '').toLowerCase());

  const { rows } = await pool.query(
    `SELECT e.id AS employee_id, e.company_id, u.id AS user_id, (e.photo_url LIKE $1) AS is_photo
       FROM employees e
       LEFT JOIN users u ON u.employee_id = e.id  -- the login link, NOT company_email (see canReadFile)
      WHERE e.deleted_at IS NULL
        AND (
          e.photo_url             LIKE $1 OR
          e.pan_file               LIKE $1 OR
          e.aadhaar_file           LIKE $1 OR
          e.cancelled_cheque_file  LIKE $1 OR
          e.bank_statement_file    LIKE $1 OR
          e.resume_file            LIKE $1 OR
          e.offer_letter_file      LIKE $1
        )
      LIMIT 1`,
    [`%${filename}`]
  );

  if (rows.length === 0) {
    // ── Background-verification reports ─────────────────────────────────────
    // Checked BEFORE candidate résumés and before the admin-only fallback.
    //
    // ⚠ There is deliberately NO self-ownership branch here, unlike employee
    // documents above. A criminal-record check, a reference response or an
    // employment-verification report is precisely the document its own subject
    // must not be able to pull, so an employee reading their own BGV report is
    // not a special case to allow — it is the case to refuse. Access is
    // company-scoped plus the `bgv` view grant, and nothing else.
    const bgv = await bgvDocumentOwner(filename);
    if (bgv) {
      if (companyId != null && bgv.company_id !== companyId) return false;
      if (!(await bgvViewPermission(req))) return false;
      // A report on a check that came back Discrepancy needs the extra grant.
      if (bgv.result === 'Discrepancy') return await bgvSensitivePermission(req);
      return true;
    }

    const intern = await internFileOwner(filename);
    if (intern) {
      if (companyId != null && intern.company_id !== companyId) return false;
      return await internViewPermission(req);
    }

    const doc = await employeeDocumentOwner(filename);
    if (doc) {
      if (companyId != null && doc.company_id !== companyId) return false;
      if (await ownsEmployeeDocument(userId, doc.employee_id)) return true;
      return await hrDocumentViewPermission(req);
    }

    const { rows: cand } = await pool.query(
      `SELECT id, company_id FROM candidates
        WHERE deleted_at IS NULL AND (resume_file_url LIKE $1 OR resume_url LIKE $1)
        LIMIT 1`,
      [`%${filename}`]
    );
    if (cand.length > 0) {
      if (companyId != null && cand[0].company_id !== companyId) return false;
      return await recruitmentViewPermission(req);
    }
    // Not linked to any record — admin only, same as the GET handler.
    return isAdmin;
  }

  const rec = rows[0];
  if (companyId != null && rec.company_id !== companyId) return false;
  if (String(rec.user_id) === String(userId)) return true;
  // The profile photo is not an identity document — its rule is unchanged.
  if (rec.is_photo) return isAdmin || isHR;
  return await hrDocumentViewPermission(req);
}

/**
 * GET /api/files/:filename
 *
 * Security checks (in order):
 * 1. Path traversal prevention — filename must not contain .. or /
 * 2. File must exist on disk
 * 3. Ownership check — the file must be linked to an employee record
 *    that belongs to the requester's company_id.
 *    For non-admin roles: file must belong to the requesting user's employee.
 * 4. Audit log on success.
 */
router.get('/:filename', async (req, res) => {
  const { filename } = req.params;

  // 1. Path traversal guard
  if (!filename || /[/\\]/.test(filename) || filename.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const absPath = path.join(UPLOADS_ROOT, filename);

  // 2. File must exist
  if (!fs.existsSync(absPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const { userId, role } = req.user;
  const companyId = req.scope?.company_id ?? null;
  const isAdmin   = ['super_admin', 'admin'].includes((role || '').toLowerCase());
  const isHR      = ['hr_manager', 'hr_exec', 'hr', 'payroll_admin', 'finance_manager'].includes((role || '').toLowerCase());

  try {
    // 3. Ownership check via DB
    // Employee documents store file paths in employees table columns:
    // photo_url, pan_url, aadhaar_url, cancelled_cheque_url, bank_statement_url,
    // resume_url, offer_letter_url
    // We look for a row where any of these columns contains this filename.
    const { rows } = await pool.query(
      `SELECT e.id AS employee_id, e.company_id, u.id AS user_id, (e.photo_url LIKE $1) AS is_photo
         FROM employees e
         LEFT JOIN users u ON u.employee_id = e.id  -- the login link, NOT company_email (see canReadFile)
        WHERE e.deleted_at IS NULL
          AND (
            e.photo_url             LIKE $1 OR
            e.pan_file               LIKE $1 OR
            e.aadhaar_file           LIKE $1 OR
            e.cancelled_cheque_file  LIKE $1 OR
            e.bank_statement_file    LIKE $1 OR
            e.resume_file            LIKE $1 OR
            e.offer_letter_file      LIKE $1
          )
        LIMIT 1`,
      [`%${filename}`]
    );

    // Candidate résumés live on `candidates`, not `employees`, so they matched
    // nothing above and fell through to the admin-only branch — locking out the
    // HR and recruiter roles who are the whole point of the Resume Database.
    // Checked as a second lookup rather than a UNION so the employee-document
    // path above keeps its exact behaviour.
    if (rows.length === 0) {
      // Background-verification reports — see bgvDocumentOwner() and the note
      // in canReadFile(). HEAD and GET must ask the same question or the
      // existence probe leaks what the download refuses.
      const bgv = await bgvDocumentOwner(filename);
      if (bgv) {
        if (companyId != null && bgv.company_id !== companyId) {
          return res.status(403).json({ error: 'Forbidden' });
        }
        if (!(await bgvViewPermission(req))) {
          return res.status(403).json({ error: 'Forbidden' });
        }
        if (bgv.result === 'Discrepancy' && !(await bgvSensitivePermission(req))) {
          return res.status(403).json({
            error: 'Forbidden',
            code: 'BGV_SENSITIVE_REQUIRED',
            message: 'This verification report is restricted to HR Manager / Admin roles.',
          });
        }
        return sendFile(req, res, absPath, filename, userId);
      }

      // Intern photos and documents — see internFileOwner(). Same question as
      // canReadFile() asks for HEAD.
      const intern = await internFileOwner(filename);
      if (intern) {
        if (companyId != null && intern.company_id !== companyId) {
          return res.status(403).json({ error: 'Forbidden' });
        }
        if (!(await internViewPermission(req))) return res.status(403).json({ error: 'Forbidden' });
        return sendFile(req, res, absPath, filename, userId);
      }

      // Self-service / HR personnel documents — see employeeDocumentOwner().
      const doc = await employeeDocumentOwner(filename);
      if (doc) {
        if (companyId != null && doc.company_id !== companyId) return res.status(403).json({ error: 'Forbidden' });
        // Owner, or hr:view — the same question canReadFile() asks for HEAD.
        if (!(await ownsEmployeeDocument(userId, doc.employee_id)) && !(await hrDocumentViewPermission(req))) {
          return res.status(403).json({ error: 'Forbidden' });
        }
        return sendFile(req, res, absPath, filename, userId);
      }

      const { rows: cand } = await pool.query(
        `SELECT id, company_id
           FROM candidates
          WHERE deleted_at IS NULL
            AND (resume_file_url LIKE $1 OR resume_url LIKE $1)
          LIMIT 1`,
        [`%${filename}`]
      );
      if (cand.length > 0) {
        // Company isolation applies to candidate files exactly as it does to
        // employee files — no cross-tenant read, admin included.
        if (companyId != null && cand[0].company_id !== companyId) {
          return res.status(403).json({ error: 'Forbidden' });
        }
        // Candidate PII is recruitment data: gate it on the same permission the
        // rest of the module uses rather than on a role name list, so a revoked
        // recruitment grant revokes résumé access too.
        const perm = await recruitmentViewPermission(req);
        if (!perm) return res.status(403).json({ error: 'Forbidden' });
        return sendFile(req, res, absPath, filename, userId);
      }
    }

    if (rows.length > 0) {
      const rec = rows[0];

      // Company isolation — even admins cannot cross company boundaries
      if (companyId != null && rec.company_id !== companyId) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      // The owner; else the photo by the old role rule, and an identity
      // document only with employee_documents:view — what canReadFile() asks
      // for HEAD.
      if (String(rec.user_id) !== String(userId)) {
        const allowed = rec.is_photo ? (isAdmin || isHR) : await hrDocumentViewPermission(req);
        if (!allowed) return res.status(403).json({ error: 'Forbidden' });
      }
    } else {
      // File not linked to any employee record — admin-only access
      if (!isAdmin) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    // 4. Audit log + stream
    return sendFile(req, res, absPath, filename, userId);

  } catch (err) {
    console.error('[secureFiles]', err.message);
    res.status(500).json({ error: 'File access failed' });
  }
});

export default router;
