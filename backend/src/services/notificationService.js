export function createNotification(db, userId, module, recordId, message) {
    return db.query(
        "INSERT INTO notifications (user_id, module, record_id, message) VALUES ($1, $2, $3, $4)",
        [userId, module, recordId, message]
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
