import { Router } from 'express';
import authRoutes from './auth.routes';
import statsRoutes from './stats.routes';
import nodeRoutes from './node.routes';

const apiRouter = Router();

apiRouter.use('/auth', authRoutes);
apiRouter.use('/stats', statsRoutes);
apiRouter.use('/node', nodeRoutes);

export default apiRouter;
