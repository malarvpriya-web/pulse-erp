import pool from "../config/db.js";

// ── schema self-heal ──────────────────────────────────────────────────────────
pool.query(`
  ALTER TABLE announcements ADD COLUMN IF NOT EXISTS priority  VARCHAR(10)  DEFAULT 'medium';
  ALTER TABLE announcements ADD COLUMN IF NOT EXISTS category  VARCHAR(50)  DEFAULT 'General';
  ALTER TABLE announcements ADD COLUMN IF NOT EXISTS created_by INTEGER;
  ALTER TABLE announcements ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
`).catch(e => console.error('[announcements] schema bootstrap failed:', e.message));

// ── helpers ───────────────────────────────────────────────────────────────────
const READ_COUNT_SQL = `
  COALESCE((
    SELECT COUNT(*) FROM announcement_reads
    WHERE announcement_id = a.id
  ), 0)::int AS read_count,
  CASE
    WHEN a.target_type = 'department'
      THEN (SELECT COUNT(*) FROM employees
             WHERE LOWER(department) = LOWER(a.target_value)
               AND LOWER(COALESCE(status,'')) NOT IN ('resigned','terminated'))
    WHEN a.target_type = 'employee' THEN 1
    ELSE (SELECT COUNT(*) FROM employees
           WHERE LOWER(COALESCE(status,'')) NOT IN ('resigned','terminated'))
  END::int AS total_audience
`;

const AUTHOR_SQL = `
  TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS created_by_name
`;

// ── exports ───────────────────────────────────────────────────────────────────
export const addAnnouncement = async (
  companyId,
  title, message, fromDate, toDate,
  targetType, targetValue, isActive, isPinned, publishAt,
  priority, category, createdBy
) => {
  const result = await pool.query(
    `INSERT INTO announcements
       (company_id, title, message, from_date, to_date, target_type, target_value,
        is_active, is_pinned, publish_at, priority, category, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [companyId ?? null, title, message, fromDate, toDate, targetType, targetValue,
     isActive, isPinned ?? false, publishAt || null,
     priority || 'medium', category || 'General', createdBy || null]
  );
  return result.rows[0];
};

export const getAnnouncements = async (companyId) => {
  const cid = companyId ?? null;
  // Auto-deactivate past-end-date announcements for this company
  await pool.query(
    `UPDATE announcements SET is_active = false
      WHERE is_active = true
        AND to_date::date < CURRENT_DATE
        AND ($1::int IS NULL OR company_id = $1)`,
    [cid]
  );
  const result = await pool.query(`
    SELECT a.*,
           ${READ_COUNT_SQL},
           ${AUTHOR_SQL}
      FROM announcements a
      LEFT JOIN employees e ON e.id = a.created_by
     WHERE ($1::int IS NULL OR a.company_id = $1)
     ORDER BY a.is_pinned DESC, a.created_at DESC
  `, [cid]);
  return result.rows;
};

export const getActiveAnnouncements = async (companyId) => {
  const cid = companyId ?? null;
  const result = await pool.query(`
    SELECT a.*,
           ${READ_COUNT_SQL},
           ${AUTHOR_SQL}
      FROM announcements a
      LEFT JOIN employees e ON e.id = a.created_by
     WHERE a.is_active = true
       AND a.from_date::date <= CURRENT_DATE
       AND a.to_date::date   >= CURRENT_DATE
       AND (a.publish_at IS NULL OR a.publish_at <= NOW())
       AND ($1::int IS NULL OR a.company_id = $1)
     ORDER BY a.is_pinned DESC, a.created_at DESC
  `, [cid]);
  return result.rows;
};

export const updateAnnouncement = async (
  id, companyId,
  title, message, fromDate, toDate,
  targetType, targetValue, isActive, isPinned, publishAt,
  priority, category
) => {
  const cid = companyId ?? null;
  const result = await pool.query(
    `UPDATE announcements
        SET title=$1, message=$2, from_date=$3, to_date=$4,
            target_type=$5, target_value=$6, is_active=$7,
            is_pinned=$8, publish_at=$9,
            priority=$10, category=$11,
            updated_at=NOW()
      WHERE id=$12
        AND ($13::int IS NULL OR company_id = $13)
      RETURNING *`,
    [title, message, fromDate, toDate, targetType, targetValue,
     isActive, isPinned ?? false, publishAt || null,
     priority || 'medium', category || 'General',
     id, cid]
  );
  return result.rows[0];
};

export const toggleAnnouncementStatus = async (id, isActive, companyId) => {
  const cid = companyId ?? null;
  const result = await pool.query(
    `UPDATE announcements SET is_active = $1, updated_at = NOW()
      WHERE id = $2
        AND ($3::int IS NULL OR company_id = $3)
        AND NOT ($1 = true AND to_date::date < CURRENT_DATE)
      RETURNING *`,
    [isActive, id, cid]
  );
  if (!result.rows[0])
    throw new Error("Cannot activate an expired announcement. Update the end date first.");
  return result.rows[0];
};

export const togglePinned = async (id, isPinned, companyId) => {
  const cid = companyId ?? null;
  const result = await pool.query(
    `UPDATE announcements SET is_pinned=$1, updated_at=NOW()
      WHERE id=$2
        AND ($3::int IS NULL OR company_id = $3)
      RETURNING *`,
    [isPinned, id, cid]
  );
  if (!result.rows[0]) throw new Error("Announcement not found");
  return result.rows[0];
};

export const markAnnouncementRead = async (announcementId, userId) => {
  await pool.query(
    `INSERT INTO announcement_reads (announcement_id, user_id)
     VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [announcementId, userId]
  );
};

export const deleteAnnouncement = async (id, companyId) => {
  const cid = companyId ?? null;
  await pool.query(
    `DELETE FROM announcements
      WHERE id=$1
        AND ($2::int IS NULL OR company_id = $2)`,
    [id, cid]
  );
};

export const deleteExpiredAnnouncements = async (companyId) => {
  const cid = companyId ?? null;
  await pool.query(
    `DELETE FROM announcements
      WHERE to_date::date < CURRENT_DATE
        AND ($1::int IS NULL OR company_id = $1)`,
    [cid]
  );
};
