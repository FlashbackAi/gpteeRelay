import { Request, Response } from 'express';
import { AuthService } from '../services/auth.service';
import logger from '../../utils/logger';

const REFRESH_DAYS = 7;

export class AuthController {

    static async createSolanaChallenge(req: Request, res: Response): Promise<any> {
        try {
            const { address, platform = 'web' } = req.body || {};

            if (!address) {
                return res
                    .status(400)
                    .json({ error: 'bad_request', message: 'address required' });
            }

            const { message } = await AuthService.createSolanaChallengeForAddress(
                String(address).trim(),
                platform
            );

            logger.info(`[Auth] Solana challenge created for address: ${address} on platform: ${platform}`);
            return res.json({ message });
        } catch (err: any) {
            logger.error(`[Auth] createSolanaChallenge error: ${err.message}`, { stack: err.stack });

            if (err.code === 'ADDRESS_REQUIRED') {
                return res
                    .status(400)
                    .json({ error: 'bad_request', message: 'address required' });
            }

            return res.status(500).json({ error: 'server_error' });
        }
    }

    static async verifySolanaNode(req: Request, res: Response): Promise<any> {
        try {
            const { address, message, signature } = req.body || {};

            if (!address || !message || !signature) {
                return res.status(400).json({
                    error: 'bad_request',
                    message: 'address, message and signature are required',
                });
            }

            const result = await AuthService.verifyNodeSignatureAndLogin({
                address,
                message,
                signature,
            });
            const platform = result.platform || 'web';
            if (platform === 'web') {
                res.cookie('refreshToken', result.refreshToken, {
                    httpOnly: true,
                    secure: true,
                    sameSite: 'none',
                    maxAge: 1000 * 60 * 60 * 24 * REFRESH_DAYS,
                    path: '/',
                });

                return res.json({
                    ok: true,
                    node_id: result.node_id,
                    accessToken: result.accessToken,
                });
            }

            logger.info(`[Auth] Solana node verified: ${result.node_id} on platform: ${platform}`);
            return res.json({
                ok: true,
                node_id: result.node_id,
                accessToken: result.accessToken,
                refreshToken: result.refreshToken,
            });
        } catch (err: any) {
            logger.error(`[Auth] verifySolanaNode error: ${err.message}`, { stack: err.stack });

            switch (err.code) {
                case 'BAD_REQUEST':
                    return res
                        .status(400)
                        .json({ error: 'bad_request', message: err.message || 'bad request' });
                case 'NO_CHALLENGE':
                case 'MESSAGE_MISMATCH':
                case 'CHALLENGE_EXPIRED':
                case 'IDENTITY_NOT_FOUND':
                    return res.status(400).json({ error: err.code.toLowerCase(), message: err.message });
                case 'INVALID_ADDRESS':
                case 'INVALID_SIGNATURE_ENCODING':
                case 'INVALID_SIGNATURE':
                    return res.status(401).json({ error: err.code.toLowerCase(), message: err.message });
                default:
                    return res.status(500).json({ error: 'server_error' });
            }
        }
    }

    static async checkSolanaNode(req: Request, res: Response): Promise<any> {
        try {
            const { address } = req.body || {};

            if (!address) {
                return res.status(400).json({ error: 'bad_request', message: 'address required' });
            }

            const result = await AuthService.checkNodeIdentity({ address, provider: 'solana' });
            logger.info(`[Auth] Check Solana node: ${address} - Exists: ${result.exists}`);
            return res.json(result);

        } catch (err: any) {
            logger.error(`[Auth] checkSolanaNode error: ${err.message}`, { stack: err.stack });
            return res.status(500).json({ error: 'server_error' });
        }
    }

    static async createSolanaNode(req: Request, res: Response): Promise<any> {
        try {
            const { id, name, address, message, signature } = req.body || {};

            if (!id || !address || !message || !signature) {
                return res.status(400).json({
                    error: 'bad_request',
                    message: 'id, address, message and signature are required',
                });
            }

            const result = await AuthService.verifyAndCreateNode({
                id,
                name: name || null,
                address,
                message,
                signature,
                provider: 'solana'
            });

            const platform = result.platform || 'web';
            if (platform === 'web') {
                res.cookie('refreshToken', result.refreshToken, {
                    httpOnly: true,
                    secure: true,
                    sameSite: 'none',
                    maxAge: 1000 * 60 * 60 * 24 * REFRESH_DAYS,
                    path: '/',
                });

                logger.info(`[Auth] New Solana node created: ${result.node_id} (web)`);
                return res.json({
                    ok: true,
                    node_id: result.node_id,
                    accessToken: result.accessToken,
                });
            }

            logger.info(`[Auth] New Solana node created: ${result.node_id} (${platform})`);
            return res.json({
                ok: true,
                node_id: result.node_id,
                accessToken: result.accessToken,
                refreshToken: result.refreshToken,
            });

        } catch (err: any) {
            logger.error(`[Auth] createSolanaNode error: ${err.message}`, { stack: err.stack });

            switch (err.code) {
                case 'BAD_REQUEST':
                    return res.status(400).json({ error: 'bad_request', message: err.message || 'bad request' });
                case 'NO_CHALLENGE':
                case 'MESSAGE_MISMATCH':
                case 'CHALLENGE_EXPIRED':
                case 'IDENTITY_EXISTS':
                    return res.status(400).json({ error: err.code.toLowerCase(), message: err.message });
                case 'INVALID_ADDRESS':
                case 'INVALID_SIGNATURE_ENCODING':
                case 'INVALID_SIGNATURE':
                    return res.status(401).json({ error: err.code.toLowerCase(), message: err.message });
                default:
                    return res.status(500).json({ error: 'server_error' });
            }
        }
    }
}
