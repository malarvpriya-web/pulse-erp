/**
 * customer-visits.routes.js — RETIRED 26 Nov 26.
 *
 * Customer Visits was a second register for the same thing as Visit Reports
 * (its own table, its own action-items table, gated on CRM permission, with no
 * edit screen and unscoped edit/delete). Owner: merge. Every visit is now a
 * visit report (/api/v1/visit-reports); Customer 360 reads visit_reports.
 * The customer_visits tables are left in place, not dropped.
 */
import express from 'express';

const router = express.Router();
const MOVED = { error: 'Customer visits are recorded as Visit Reports (Travel Desk → Visit Reports).', moved_to: '/visit-reports' };
router.use((_req, res) => res.status(410).json(MOVED));

export default router;
