import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';

const router = Router();


router.post('/solana/challenge-node', AuthController.createSolanaChallenge);
router.post('/solana/verify-node', AuthController.verifySolanaNode);
router.post('/solana/check-node', AuthController.checkSolanaNode);
router.post('/solana/create-node', AuthController.createSolanaNode);

export default router;
