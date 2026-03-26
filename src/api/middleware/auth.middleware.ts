import { Request, Response, NextFunction } from 'express';

/**
 * Simple Bearer token auth middleware.
 * Reads the Authorization header, decodes the mock token to extract node_id,
 * and attaches it to req as (req as any).nodeId.
 *
 * Replace the token parsing logic with real JWT verification when ready.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): any {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
        return res.status(401).json({ error: 'unauthorized', message: 'missing bearer token' });
    }

    // --- Mock token format: "mock-access-token-<node_id>-<timestamp>" ---
    // Replace this block with real JWT.verify() when you add proper auth
    const mockMatch = token.match(/^mock-access-token-(.+)-\d+$/);
    if (!mockMatch) {
        return res.status(401).json({ error: 'unauthorized', message: 'invalid token' });
    }

    (req as any).nodeId = mockMatch[1];
    next();
}
