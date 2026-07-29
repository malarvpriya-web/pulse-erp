// Was inserting into columns that don't exist (`module`, `record_id` — the
// real table has `module_name`, `reference_id`) and never provided `title`,
// which is NOT NULL. Every call has always thrown; every call site wraps it
// in .catch(() => {}), so this has silently done nothing since it was
// written. Confirmed the only importer is recruitment.routes.js (7 call
// sites — new candidate, interview scheduled, offer sent, etc.), all of
// which have silently never notified anyone. Keeping the same signature so
// none of those 7 call sites need to change.
export function createNotification(db, userId, module, recordId, message) {
    return db.query(
        "INSERT INTO notifications (user_id, title, message, module_name, reference_id) VALUES ($1, $2, $3, $4, $5)",
        [userId, (message || 'Notification').slice(0, 100), message, module, recordId]
    );
}

export function getUserNotifications(db, userId) {
    return db.query(
        "SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC",
        [userId]
    );
}

export function markAsRead(db, notificationId) {
    return db.query(
        "UPDATE notifications SET is_read = true WHERE id = $1",
        [notificationId]
    );
}

export default {
    createNotification,
    getUserNotifications,
    markAsRead
};
