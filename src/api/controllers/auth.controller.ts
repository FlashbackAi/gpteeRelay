import { Request, Response } from 'express';
import { AuthService } from '../services/auth.service';

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

            return res.json({ message });
        } catch (err: any) {
            console.error('[SolanaAuth] createSolanaChallenge error', err);

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

            return res.json({
                ok: true,
                node_id: result.node_id,
                accessToken: result.accessToken,
                refreshToken: result.refreshToken,
            });
        } catch (err: any) {
            console.error('[SolanaAuth] verifySolanaNode error', err);

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
            return res.json(result);

        } catch (err: any) {
            console.error('[SolanaAuth] checkSolanaNode error', err);
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

                return res.json({
                    ok: true,
                    node_id: result.node_id,
                    accessToken: result.accessToken,
                });
            }

            return res.json({
                ok: true,
                node_id: result.node_id,
                accessToken: result.accessToken,
                refreshToken: result.refreshToken,
            });

        } catch (err: any) {
            console.error('[SolanaAuth] createSolanaNode error', err);

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
