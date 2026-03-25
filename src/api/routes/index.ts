import { Router } from 'express';
import authRoutes from './auth.routes';
import statsRoutes from './stats.routes';

const apiRouter = Router();

apiRouter.use('/auth', authRoutes);
apiRouter.use('/stats', statsRoutes);

export default apiRouter;
