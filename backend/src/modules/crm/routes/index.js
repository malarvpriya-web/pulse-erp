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

const router = express.Router();

router.use(crmRoutes);
router.use(pursuitsRoutes);
router.use(emailRoutes);
router.use(pipelineRoutes);
router.use(customer360Routes);
router.use(customerDriveRoutes);
router.use(proposalsRoutes);
router.use('/ceo360', ceo360Routes);
router.use('/health-engine', customerHealthRoutes);

export default router;
