import { Router } from 'express';
import { StatsController } from '../controllers/stats.controller';

const router = Router();

router.get('/', StatsController.getStats);

export default router;
