import express from 'express';
import crmRoutes from './crm.routes.js';
import emailRoutes from './email.routes.js';
import pipelineRoutes from './pipeline.routes.js';
import customer360Routes from './customer360.routes.js';
import customerDriveRoutes from './customerDrive.routes.js';
import proposalsRoutes from './proposals.routes.js';
import ceo360Routes from './ceo360.routes.js';
import customerHealthRoutes from './customerHealth.routes.js';
import pursuitsRoutes from './pursuits.routes.js';
import accountGraphRoutes from './accountGraph.routes.js';
import { adminRouter as webLeadAdminRoutes } from './webToLead.routes.js';

const router = express.Router();

router.use(crmRoutes);
router.use(pursuitsRoutes);
// Account hierarchy + account/opportunity teams (brief S2, S12) and the
// staff side of web-to-lead. The PUBLIC capture endpoint is mounted
// separately in server.js, outside verifyToken.
router.use(accountGraphRoutes);
router.use(webLeadAdminRoutes);
router.use(emailRoutes);
router.use(pipelineRoutes);
router.use(customer360Routes);
router.use(customerDriveRoutes);
router.use(proposalsRoutes);
router.use('/ceo360', ceo360Routes);
router.use('/health-engine', customerHealthRoutes);

export default router;
