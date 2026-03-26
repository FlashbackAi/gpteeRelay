import { Request, Response } from 'express';
import { NodeService } from '../services/node.service';
import { NodeSettingsUpdate } from '../models/nodeSettings.model';

export class NodeController {

    static async getSettings(req: Request, res: Response): Promise<any> {
        try {
            const node_id = req.query.node_id as string;
            if (!node_id) {
                return res.status(400).json({ error: 'bad_request', message: 'node_id is required' });
            }
            const settings = await NodeService.getNodeSettings(node_id);
            return res.json(settings);
        } catch (err: any) {
            console.error('[NodeController] getSettings error', err);
            if (err.code === 'NODE_NOT_FOUND') {
                return res.status(404).json({ error: 'not_found', message: 'node not found' });
            }
            return res.status(500).json({ error: 'server_error' });
        }
    }

    static async updateSettings(req: Request, res: Response): Promise<any> {
        try {
            const { node_id, worker_mode_enabled, provider_mode_enabled, battery_threshold } = req.body || {};

            if (!node_id) {
                return res.status(400).json({ error: 'bad_request', message: 'node_id is required' });
            }

            const fields: NodeSettingsUpdate = {};

            if (worker_mode_enabled !== undefined) {
                if (typeof worker_mode_enabled !== 'boolean') {
                    return res.status(400).json({ error: 'bad_request', message: 'worker_mode_enabled must be a boolean' });
                }
                fields.worker_mode_enabled = worker_mode_enabled;
            }

            if (provider_mode_enabled !== undefined) {
                if (typeof provider_mode_enabled !== 'boolean') {
                    return res.status(400).json({ error: 'bad_request', message: 'provider_mode_enabled must be a boolean' });
                }
                fields.provider_mode_enabled = provider_mode_enabled;
            }

            if (battery_threshold !== undefined) {
                if (typeof battery_threshold !== 'number' || battery_threshold < 0 || battery_threshold > 100) {
                    return res.status(400).json({ error: 'bad_request', message: 'battery_threshold must be a number between 0 and 100' });
                }
                fields.battery_threshold = battery_threshold;
            }

            if (Object.keys(fields).length === 0) {
                return res.status(400).json({
                    error: 'bad_request',
                    message: 'at least one field required: worker_mode_enabled, provider_mode_enabled, battery_threshold',
                });
            }

            const updated = await NodeService.updateNodeSettings(node_id, fields);
            return res.json(updated);
        } catch (err: any) {
            console.error('[NodeController] updateSettings error', err);
            if (err.code === 'NODE_NOT_FOUND') {
                return res.status(404).json({ error: 'not_found', message: 'node not found' });
            }
            return res.status(500).json({ error: 'server_error' });
        }
    }
}
