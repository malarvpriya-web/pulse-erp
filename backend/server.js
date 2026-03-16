import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import employeeRoutes from "./src/employees/employee.routes.js";
import authRoutes from "./src/auth/auth.routes.js";
import homeRoutes from "./src/home/home.routes.js";
import noteRoutes from "./src/notes/note.routes.js";
import announcementRoutes from "./src/announcements/announcement.routes.js";
import probationRoutes from "./src/probation/probation.routes.js";
import leaveRoutes from "./src/leaves/leave.routes.js";
import financeRoutes from "./src/modules/finance/routes/finance.routes.js";
import extendedFinanceRoutes from "./src/modules/finance/routes/extended.routes.js";
import procurementRoutes from "./src/modules/procurement/routes/procurement.routes.js";
import inventoryRoutes from "./src/modules/inventory/routes/inventory.routes.js";
import projectRoutes from "./src/modules/projects/routes/projects.routes.js";
import timesheetRoutes from "./src/modules/timesheets/routes/timesheets.routes.js";
import performanceRoutes from "./src/modules/performance/routes/performance.routes.js";
import crmRoutes from "./src/modules/crm/routes/crm.routes.js";
import salesRoutes from "./src/modules/sales/routes/sales.routes.js";
import marketingRoutes from "./src/modules/marketing/routes/marketing.routes.js";
import reportsRoutes from "./src/modules/reports/routes/reports.routes.js";
import documentsRoutes from "./src/modules/documents/routes/documents.routes.js";
import notificationsRoutes from "./src/modules/notifications/routes/notifications.routes.js";
import auditRoutes from "./src/modules/audit/routes/audit.routes.js";
import orgChartRoutes from "./src/modules/orgchart/routes/orgchart.routes.js";
import attendanceRoutes from "./src/modules/attendance/routes/attendance.routes.js";
import leavesRoutes from "./src/modules/leaves/routes/leaves.routes.js";
import recruitmentRoutes from "./src/modules/recruitment/routes/recruitment.routes.js";
import approvalsRoutes from "./src/modules/approvals/approvals.routes.js";
import financeNewRoutes from "./src/modules/finance/finance.routes.js";
import dashboardRoutes from "./src/modules/dashboard/dashboard.routes.js";
import servicedeskRoutes from "./src/modules/servicedesk/routes/servicedesk.routes.js";
import { verifyToken, allowRoles } from "./src/middlewares/auth.middleware.js";
import { runMigrations } from "./src/config/migrations.js";

dotenv.config();

const app = express();

// MIDDLEWARE
const allowedOrigins = process.env.FRONTEND_URL
  ? [process.env.FRONTEND_URL, 'http://localhost:5173', 'http://localhost:3000']
  : true; // allow all in dev

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Serve uploaded files
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ✅ Setup multer for multipart/form-data (FormData from frontend)
const storage = multer.memoryStorage(); // Store files in memory for now
const upload = multer({ 
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// ✅ Apply multer to POST /api/employees (for FormData parsing)
app.use("/api/employees", upload.any());

/* ROUTES */
app.use("/api/auth", authRoutes);
app.use("/api/home", homeRoutes);
app.use("/api/employees", employeeRoutes);
app.use("/api/notes", noteRoutes);
app.use("/api/announcements", announcementRoutes);
app.use("/api/probation", probationRoutes);
app.use("/api/leaves", leaveRoutes);
app.use("/api/finance", verifyToken, financeRoutes);
app.use("/api/finance", verifyToken, extendedFinanceRoutes);
app.use("/api/procurement", verifyToken, procurementRoutes);
app.use("/api/inventory", verifyToken, inventoryRoutes);
app.use("/api/projects", verifyToken, projectRoutes);
app.use("/api/timesheets", verifyToken, timesheetRoutes);
app.use("/api/performance", verifyToken, performanceRoutes);
app.use("/api/crm", verifyToken, crmRoutes);
app.use("/api/sales", verifyToken, salesRoutes);
app.use("/api/marketing", verifyToken, marketingRoutes);
app.use("/api/reports", verifyToken, reportsRoutes);
app.use("/api/documents", verifyToken, documentsRoutes);
app.use("/api/notifications", verifyToken, notificationsRoutes);
app.use("/api/audit", verifyToken, auditRoutes);
app.use("/api/orgchart", verifyToken, orgChartRoutes);
app.use("/api/attendance", verifyToken, attendanceRoutes);
app.use("/api/leaves-new", verifyToken, leavesRoutes);
app.use("/api/recruitment", verifyToken, recruitmentRoutes);
app.use("/api/approvals", verifyToken, approvalsRoutes);
app.use("/api/finance-new", verifyToken, financeNewRoutes);
app.use("/api/dashboard", verifyToken, dashboardRoutes);
app.use("/api/servicedesk", verifyToken, servicedeskRoutes);

/* TEST ROUTES */
app.get("/", (req, res) => {
  res.send("MIS Backend running 🚀");
});

app.get("/api/test-auth", verifyToken, (req, res) => {
  res.json({
    message: "✅ Token verified successfully",
    user: req.user,
  });
});

app.get("/api/dashboard", verifyToken, (req, res) => {
  res.json({
    message: "Welcome to MIS dashboard 🎉",
    user: req.user,
  });
});

app.get("/api/admin", verifyToken, allowRoles("admin"), (req, res) => {
  res.json({ message: "Welcome Admin 👑" });
});

/* START SERVER */
const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT} 🚀`);
  await runMigrations();
});