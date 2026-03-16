import express from "express";
import * as controller from "./finance.controller.js";

const router = express.Router();

router.get("/dashboard", controller.getFinanceDashboard);
router.get("/accounts", controller.getAccounts);
router.post("/accounts", controller.createAccount);
router.get("/invoices", controller.getInvoices);
router.get("/invoices/stats", controller.getInvoiceStats);
router.get("/bills", controller.getBills);
router.get("/bills/stats", controller.getBillStats);
router.get("/journal-entries", controller.getJournalEntries);
router.post("/journal-entries", controller.createJournalEntry);
router.get("/periods", controller.getPeriods);
router.post("/periods/:id/close", controller.closePeriod);
router.get("/cfo-dashboard", controller.getCFODashboard);

export default router;
