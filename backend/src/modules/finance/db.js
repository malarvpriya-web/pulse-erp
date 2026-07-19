// Canonical pool is owned by src/config/db.js — one Pool instance for the whole app.
// All modules that previously created their own pool now share the same connection.
export { default } from '../../config/db.js';
