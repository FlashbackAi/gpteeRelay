import crypto from 'crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { PublicKey } from '@solana/web3.js';
import { v4 as uuidv4 } from 'uuid';
import { NodesModel } from '../models/node.model';
import { NodeIdentitiesModel } from '../models/nodeIdentity.model';
import { WalletChallengesModel } from '../models/walletChallenge.model';

const SOLANA_CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const APP_DOMAIN = 'gpteerelay.local';
const SOLANA_PROVIDER = 'solana';

export class AuthService {

    static buildSolanaLoginMessage({ address, nonce, issuedAt }: { address: string, nonce: string, issuedAt: string }) {
        return [
            `${APP_DOMAIN} wants you to sign in with your Solana wallet:`,
            `${address}`,
            '',
            `URI: https://${APP_DOMAIN}`,
            `Version: 1`,
            `Chain: solana`,
            `Nonce: ${nonce}`,
            `Issued At: ${issuedAt}`,
            '',
            'By signing this message, you prove wallet ownership to log in to Flashback. No funds will be moved.',
        ].join('\n');
    }

    static async createSolanaChallengeForAddress(address: string, platform: string) {
        if (!address) {
            const err: any = new Error('address_required');
            err.code = 'ADDRESS_REQUIRED';
            throw err;
        }

        const nonce = crypto.randomBytes(16).toString('hex');
        const issuedAt = new Date().toISOString();
        const message = this.buildSolanaLoginMessage({ address, nonce, issuedAt });
        const expiresAt = new Date(Date.now() + SOLANA_CHALLENGE_TTL_MS).toISOString();

        await WalletChallengesModel.saveChallenge({
            address,
            chain_type: 'solana',
            nonce,
            message,
            issued_at: issuedAt,
            expires_at: expiresAt,
            platform
        });

        return {
            message,
            nonce,
            issued_at: issuedAt,
            expires_at: expiresAt,
        };
    }

    static async checkNodeIdentity({ address, provider }: { address: string, provider: string }) {
        const identifier = String(address || '').trim();
        if (!identifier) {
            const err: any = new Error('address_required');
            err.code = 'ADDRESS_REQUIRED';
            throw err;
        }

        const existing = await NodeIdentitiesModel.getIdentity(identifier, provider);
        if (existing) {
            await NodeIdentitiesModel.touchIdentity(identifier, provider);
            return { exists: true, node_id: existing.node_id };
        }
        return {
            exists: false
        };
    }

    static async verifyNodeSignatureAndLogin({ address, message, signature }: { address: string, message: string, signature: string }) {
        const addr = String(address || '').trim();
        const msg = String(message || '');
        const sig = String(signature || '');

        if (!addr || !msg || !sig) {
            const err: any = new Error('address, message and signature are required');
            err.code = 'BAD_REQUEST';
            throw err;
        }

        // 1) Load challenge
        const challenge = await WalletChallengesModel.getChallenge({
            address: addr,
            chain_type: 'solana',
        });

        if (!challenge) {
            const err: any = new Error('no challenge found');
            err.code = 'NO_CHALLENGE';
            throw err;
        }

        const platform = challenge.platform || 'web';

        // 2) Validate message and expiry
        if (String(challenge.message) !== msg) {
            const err: any = new Error('message mismatch');
            err.code = 'MESSAGE_MISMATCH';
            throw err;
        }

        if (challenge.expires_at && new Date(challenge.expires_at).getTime() < Date.now()) {
            const err: any = new Error('challenge expired');
            err.code = 'CHALLENGE_EXPIRED';
            throw err;
        }

        // 3) Verify Ed25519 signature
        let pubKey;
        try {
            pubKey = new PublicKey(addr);
        } catch (e) {
            const err: any = new Error('invalid_solana_address');
            err.code = 'INVALID_ADDRESS';
            throw err;
        }

        const msgBytes = Buffer.from(msg, 'utf8');
        let sigBytes;
        try {
            sigBytes = bs58.decode(sig);
        } catch (e) {
            const err: any = new Error('invalid_signature_encoding');
            err.code = 'INVALID_SIGNATURE_ENCODING';
            throw err;
        }

        const ok = nacl.sign.detached.verify(
            msgBytes,
            sigBytes,
            pubKey.toBytes(),
        );

        if (!ok) {
            const err: any = new Error('invalid_signature');
            err.code = 'INVALID_SIGNATURE';
            throw err;
        }

        // 4) Ensure we have the identity
        const existingIdentity = await NodeIdentitiesModel.getIdentity(addr, SOLANA_PROVIDER);
        if (!existingIdentity) {
            const err: any = new Error('identity_not_found');
            err.code = 'IDENTITY_NOT_FOUND';
            throw err;
        }

        const node_id = existingIdentity.node_id;
        await NodeIdentitiesModel.touchIdentity(addr, SOLANA_PROVIDER);

        // 5) Fetch node details to get the name
        const node = await NodesModel.getNode(node_id);
        const nodeName = node?.name || null;

        // 6) Single-use: delete challenge
        await WalletChallengesModel.deleteChallenge({
            address: addr,
            chain_type: 'solana',
        });

        // 7) Issue tokens
        const accessToken = `mock-access-token-${node_id}-${Date.now()}`;
        const refreshToken = `mock-refresh-token-${node_id}-${Date.now()}`;

        return {
            node_id,
            name: nodeName, // Include the node name
            accessToken,
            refreshToken,
            platform
        };
    }

    static async verifyAndCreateNode({ id, name, address, message, signature, provider }: {
        id: string, name: string, address: string, message: string, signature: string, provider: string
    }) {
        const addr = String(address || '').trim();
        const msg = String(message || '');
        const sig = String(signature || '');

        if (!addr || !msg || !sig || !id || !provider) {
            const err: any = new Error('Missing required fields string');
            err.code = 'BAD_REQUEST';
            throw err;
        }

        // 1) Verify payload and challenge
        const challenge = await WalletChallengesModel.getChallenge({
            address: addr,
            chain_type: 'solana',
        });

        if (!challenge) {
            const err: any = new Error('no challenge found');
            err.code = 'NO_CHALLENGE';
            throw err;
        }

        const platform = challenge.platform || 'web';

        if (String(challenge.message) !== msg) {
            const err: any = new Error('message mismatch');
            err.code = 'MESSAGE_MISMATCH';
            throw err;
        }

        if (challenge.expires_at && new Date(challenge.expires_at).getTime() < Date.now()) {
            const err: any = new Error('challenge expired');
            err.code = 'CHALLENGE_EXPIRED';
            throw err;
        }

        // 2) Verify Ed25519 signature
        let pubKey;
        try {
            pubKey = new PublicKey(addr);
        } catch (e) {
            const err: any = new Error('invalid_solana_address');
            err.code = 'INVALID_ADDRESS';
            throw err;
        }

        const msgBytes = Buffer.from(msg, 'utf8');
        let sigBytes;
        try {
            sigBytes = bs58.decode(sig);
        } catch (e) {
            const err: any = new Error('invalid_signature_encoding');
            err.code = 'INVALID_SIGNATURE_ENCODING';
            throw err;
        }

        const ok = nacl.sign.detached.verify(
            msgBytes,
            sigBytes,
            pubKey.toBytes(),
        );

        if (!ok) {
            const err: any = new Error('invalid_signature');
            err.code = 'INVALID_SIGNATURE';
            throw err;
        }

        // 3) Check if identity already exists
        const existingIdentity = await NodeIdentitiesModel.getIdentity(addr, provider);
        if (existingIdentity) {
            const err: any = new Error('identity_exists');
            err.code = 'IDENTITY_EXISTS';
            throw err;
        }

        // 4) Create user and identity
        try {
            await NodesModel.createNode({
                node_id: id,
                name,
            });

            await NodeIdentitiesModel.createIdentity({
                identifier: addr,
                provider,
                node_id: id,
                verified: true,
            });
        } catch (err: any) {
            throw err;
        }

        // 5) Cleanup challenge
        await WalletChallengesModel.deleteChallenge({
            address: addr,
            chain_type: 'solana',
        });

        // 6) Issue tokens
        const accessToken = `mock-access-token-${id}-${Date.now()}`;
        const refreshToken = `mock-refresh-token-${id}-${Date.now()}`;

        return {
            node_id: id,
            accessToken,
            refreshToken,
            platform
        };
    }
}
