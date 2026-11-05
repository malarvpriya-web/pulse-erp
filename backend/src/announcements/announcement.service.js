import pool from "../config/db.js";
import { countsSql } from "./announcement.visibility.js";

// ── schema self-heal ──────────────────────────────────────────────────────────
pool.query(`
  ALTER TABLE announcements ADD COLUMN IF NOT EXISTS priority  VARCHAR(10)  DEFAULT 'medium';
  ALTER TABLE announcements ADD COLUMN IF NOT EXISTS category  VARCHAR(50)  DEFAULT 'General';
  ALTER TABLE announcements ADD COLUMN IF NOT EXISTS created_by INTEGER;
  ALTER TABLE announcements ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
`).catch(e => console.error('[announcements] schema bootstrap failed:', e.message));

// Every function here takes a concrete companyId. The old `($1::int IS NULL OR
// company_id = $1)` predicate meant a request with no company — including the
// unauthenticated /active route — read, and deleted, every tenant's rows. The
// controller refuses a company-less caller before reaching this file.
//
// Nothing here deletes. DELETE /announcements/:id archives (deleted_at), and
// expiry is computed from to_date — the GET list used to flip is_active and the
// public /active route used to DELETE every expired row in every company.

// created_by / updated_by / deleted_by are users.id (what the controller has
// always written). The author name joins through the login to its employee; it
// used to join employees.id = created_by, which named the wrong person.
const AUTHOR_SQL = `
  NULLIF(TRIM(COALESCE(ce.first_name,'') || ' ' || COALESCE(ce.last_name,'')), '') AS created_by_name
`;

// Scheduled = not started yet (From date ahead) or a Scheduled Publish time ahead.
const LIFECYCLE_SQL = `
  CASE
    WHEN a.deleted_at IS NOT NULL                                   THEN 'archived'
    WHEN a.to_date::date < CURRENT_DATE                              THEN 'expired'
    WHEN a.is_active IS DISTINCT FROM true                           THEN 'inactive'
    WHEN a.from_date::date > CURRENT_DATE
      OR (a.publish_at IS NOT NULL AND a.publish_at > NOW())         THEN 'scheduled'
    ELSE 'active'
  END AS lifecycle_status
`;

/** The management list (HR page). Archived rows are excluded. `createdBy` narrows to one author. */
export const listForManagement = async (companyId, { createdBy = null } = {}) => {
  const { rows } = await pool.query(`
    SELECT a.*,
           ${countsSql('a')},
           ${LIFECYCLE_SQL},
           ${AUTHOR_SQL}
      FROM announcements a
      LEFT JOIN users cu     ON cu.id = a.created_by
      LEFT JOIN employees ce ON ce.id = cu.employee_id
     WHERE a.company_id = $1::int
       AND a.deleted_at IS NULL
       AND ($2::int IS NULL OR a.created_by = $2::int)
     ORDER BY a.is_pinned DESC, a.created_at DESC, a.id DESC
  `, [companyId, createdBy]);
  return rows;
};

/** One non-archived row in the company, or undefined. Used as the audit before-image. */
export const findInCompany = async (id, companyId, db = pool) => {
  if (!/^\d+$/.test(String(id))) return undefined;
  const { rows } = await db.query(
    `SELECT * FROM announcements WHERE id = $1 AND company_id = $2::int AND deleted_at IS NULL`,
    [Number(id), companyId]);
  return rows[0];
};

export const addAnnouncement = async (companyId, f, createdBy) => {
  const { rows } = await pool.query(
    `INSERT INTO announcements
       (company_id, title, message, from_date, to_date, target_type, target_value,
        is_active, is_pinned, publish_at, priority, category, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING *`,
    [companyId, f.title, f.message, f.from_date, f.to_date, f.target_type, f.target_value,
     f.is_active, f.is_pinned, f.publish_at, f.priority, f.category, createdBy]);
  return rows[0];
};

export const updateAnnouncement = async (id, companyId, f, updatedBy) => {
  const { rows } = await pool.query(
    `UPDATE announcements
        SET title=$1, message=$2, from_date=$3, to_date=$4,
            target_type=$5, target_value=$6, is_active=$7,
            is_pinned=$8, publish_at=$9,
            priority=$10, category=$11,
            updated_by=$12, updated_at=NOW()
      WHERE id=$13 AND company_id=$14::int AND deleted_at IS NULL
      RETURNING *`,
    [f.title, f.message, f.from_date, f.to_date, f.target_type, f.target_value,
     f.is_active, f.is_pinned, f.publish_at, f.priority, f.category,
     updatedBy, Number(id), companyId]);
  return rows[0];
};

export class AnnouncementStateError extends Error {}

export const toggleAnnouncementStatus = async (id, isActive, companyId, updatedBy) => {
  const { rows } = await pool.query(
    `UPDATE announcements SET is_active = $1, updated_by = $4, updated_at = NOW()
      WHERE id = $2 AND company_id = $3::int AND deleted_at IS NULL
        AND NOT ($1 = true AND to_date::date < CURRENT_DATE)
      RETURNING *`,
    [isActive, Number(id), companyId, updatedBy]);
  if (!rows[0]) throw new AnnouncementStateError("Cannot activate an expired announcement. Update the end date first.");
  return rows[0];
};

export const togglePinned = async (id, isPinned, companyId, updatedBy) => {
  const { rows } = await pool.query(
    `UPDATE announcements SET is_pinned = $1, updated_by = $4, updated_at = NOW()
      WHERE id = $2 AND company_id = $3::int AND deleted_at IS NULL
      RETURNING *`,
    [isPinned, Number(id), companyId, updatedBy]);
  return rows[0];
};

/** Archive (soft delete). The row and its read receipts are kept. */
export const archiveAnnouncement = async (id, companyId, deletedBy) => {
  const { rows } = await pool.query(
    `UPDATE announcements
        SET deleted_at = NOW(), deleted_by = $3, is_pinned = false, updated_at = NOW()
      WHERE id = $1 AND company_id = $2::int AND deleted_at IS NULL
      RETURNING *`,
    [Number(id), companyId, deletedBy]);
  return rows[0];
};

/** Record that `userId` read the announcement. The caller has already checked visibility. */
export const markAnnouncementRead = async (announcementId, userId) => {
  await pool.query(
    `INSERT INTO announcement_reads (announcement_id, user_id)
     VALUES ($1, $2) ON CONFLICT (announcement_id, user_id) DO NOTHING`,
    [Number(announcementId), userId]);
  const { rows } = await pool.query(
    `SELECT read_at FROM announcement_reads WHERE announcement_id = $1 AND user_id = $2`,
    [Number(announcementId), userId]);
  return rows[0]?.read_at ?? null;
};
