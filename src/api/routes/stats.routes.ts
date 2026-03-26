import { Router } from 'express';
import { StatsController } from '../controllers/stats.controller';

const router = Router();

// Overall stats
router.get('/', StatsController.getStats);

// Node-specific stats
router.get('/node', StatsController.getNodeStats);
router.put('/node', StatsController.updateNodeStats);

export default router;
