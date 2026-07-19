import pool from "../config/db.js";


/* ── helpers ── */

// Look up user_id by full name:
// Strategy 1: match users.name directly
// Strategy 2: match employees by full name → get company_email → look up users.email
async function findUserIdByName(name) {
  if (!name?.trim()) return null;
  const n = name.trim();
  try {
    // Strategy 1: direct match on users.name
    const r1 = await pool.query(
      `SELECT id FROM users WHERE LOWER(TRIM(name)) = LOWER($1) LIMIT 1`,
      [n]
    );
    if (r1.rows[0]) return r1.rows[0].id;

    // Strategy 2: employee full name → company_email → users.email
    const r2 = await pool.query(
      `SELECT company_email FROM employees
       WHERE LOWER(TRIM(CONCAT(first_name, ' ', last_name))) = LOWER($1) LIMIT 1`,
      [n]
    );
    if (r2.rows[0]?.company_email) {
      const r3 = await pool.query(
        `SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
        [r2.rows[0].company_email]
      );
      if (r3.rows[0]) return r3.rows[0].id;
    }

    return null;
  } catch (err) {
    console.error('[Probation] findUserIdByName error:', err.message);
    return null;
  }
}

// Get all super_admin user IDs
async function getSuperAdminIds() {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM users WHERE role = 'super_admin' AND is_active = true`
    );
    return rows.map(r => r.id);
  } catch {
    return [];
  }
}

// Push a real notification into the notifications table
async function pushNotification({ user_id, title, message, module_name, reference_id, notification_type }) {
  if (!user_id) return;
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [user_id, title, message, module_name || 'Probation', reference_id || null, notification_type || 'probation_warning']
    );
  } catch (err) {
    console.error('[Probation] pushNotification error:', err.message);
  }
}

// Push an approval record into the approvals table
async function pushApproval({ approver_id, employee_id, title, description, requester_name }) {
  if (!approver_id) return;
  try {
    await pool.query(
      `INSERT INTO approvals
         (module_name, reference_id, reference_type, request_type, request_title, description,
          requester_name, requested_by, approver_id, status)
       VALUES ('probation', $1, 'probation_review', 'Probation', $2, $3, $4, $4, $5, 'Pending')`,
      [employee_id, title, description, requester_name || 'HR', approver_id]
    );
  } catch (err) {
    console.error('[Probation] pushApproval error:', err.message);
  }
}

/* ── service functions ── */

export const createNotification = async (data) => {
  const { employee_id, notified_to, notified_role, notification_type, module_name, remarks } = data;

  // 1. Save to probation_notifications
  const result = await pool.query(
    `INSERT INTO probation_notifications
       (employee_id, notified_to, notified_role, notification_type, module_name, remarks)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      employee_id,
      notified_to,
      notified_role || 'Manager',
      notification_type || 'approval',
      module_name || 'Probation',
      remarks || null,
    ]
  );
  const saved = result.rows[0];

  // 2. Get employee info for notification message
  let empName = 'An employee';
  let empDept  = '';
  try {
    const { rows } = await pool.query(
      `SELECT first_name, last_name, department FROM employees WHERE id = $1`,
      [employee_id]
    );
    if (rows[0]) {
      empName = `${rows[0].first_name} ${rows[0].last_name}`;
      empDept  = rows[0].department || '';
    }
  } catch { /* silent */ }

  // 3. Build notification content
  const typeLabel = {
    probation_warning : '⚠️ Probation Due Soon',
    probation_due     : '🔴 Probation End Date Reached',
    approval          : '📋 Probation Review Required',
  }[notification_type] || '📋 Probation Review Required';

  const notifTitle = typeLabel;
  const notifMessage = `${empName}${empDept ? ` (${empDept})` : ''} requires a probation review.${remarks ? ` Note: ${remarks}` : ''}`;

  // 4. Find the notified-to user and push a notification + approval to them
  const targetUserId = await findUserIdByName(notified_to);
  if (targetUserId) {
    await pushNotification({
      user_id          : targetUserId,
      title            : notifTitle,
      message          : notifMessage,
      module_name      : 'Probation',
      reference_id     : employee_id,
      notification_type: notification_type || 'probation_warning',
    });
    await pushApproval({
      approver_id    : targetUserId,
      employee_id,
      title          : `Probation Review — ${empName}`,
      description    : notifMessage,
      requester_name : 'HR / Probation System',
    });
  }

  // 5. Also notify all super_admins (if they're different from the target)
  const superAdmins = await getSuperAdminIds();
  for (const saId of superAdmins) {
    if (saId === targetUserId) continue; // already notified above
    await pushNotification({
      user_id          : saId,
      title            : notifTitle,
      message          : notifMessage,
      module_name      : 'Probation',
      reference_id     : employee_id,
      notification_type: notification_type || 'probation_warning',
    });
    await pushApproval({
      approver_id    : saId,
      employee_id,
      title          : `Probation Review — ${empName}`,
      description    : notifMessage,
      requester_name : 'HR / Probation System',
    });
  }

  return saved;
};

export const getNotifications = async () => {
  const result = await pool.query(`
    SELECT
      pn.*,
      e.first_name, e.last_name, e.office_id, e.department,
      e.designation, e.joining_date
    FROM probation_notifications pn
    JOIN employees e ON pn.employee_id = e.id
    ORDER BY pn.created_at DESC
    LIMIT 200
  `);
  return result.rows;
};

export const updateNotification = async (id, data) => {
  const { decision, performance_rating, comments } = data;
  const result = await pool.query(
    `UPDATE probation_notifications
     SET decision = $1, performance_rating = $2, comments = $3,
         status = 'completed', decided_at = CURRENT_TIMESTAMP
     WHERE id = $4
     RETURNING *`,
    [decision, performance_rating || null, comments || null, id]
  );
  return result.rows[0];
};

export const updateByEmployee = async (employee_id, data) => {
  const { decision, performance_rating, comments } = data;
  const result = await pool.query(
    `UPDATE probation_notifications
     SET decision = $1, performance_rating = $2, comments = $3,
         status = 'completed', decided_at = CURRENT_TIMESTAMP
     WHERE id = (
       SELECT id FROM probation_notifications
       WHERE employee_id = $4 AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 1
     )
     RETURNING *`,
    [decision, performance_rating || null, comments || null, employee_id]
  );
  return result.rows[0] || null;
};
