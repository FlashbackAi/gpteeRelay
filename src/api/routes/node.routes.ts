import { Router } from 'express';
import { NodeController } from '../controllers/node.controller';

const router = Router();

router.get('/settings', NodeController.getSettings);
router.put('/settings', NodeController.updateSettings);

export default router;

