import { Request, Response } from 'express';
import { StatsService } from '../services/stats.service';
import { NodeStatisticsUpdate } from '../models/nodeStatistics.model';
import logger from '../../utils/logger';

export class StatsController {
    static async getStats(req: Request, res: Response) {
        try {
            const stats = await StatsService.getOverallStats();
            res.json({ success: true, data: stats });
        } catch (error: any) {
            res.status(500).json({ success: false, error: error.message });
        }
    }

    static async getNodeStats(req: Request, res: Response): Promise<any> {
        try {
            const node_id = req.query.node_id as string;
            if (!node_id) {
                return res.status(400).json({ error: 'bad_request', message: 'node_id is required' });
            }
            const stats = await StatsService.getNodeStats(node_id);
            logger.info(`[Stats] Statistics retrieved for node: ${node_id}`);
            return res.json(stats);
        } catch (err: any) {
            logger.error(`[Stats] getNodeStats error: ${err.message}`, { stack: err.stack });
            if (err.code === 'NODE_NOT_FOUND') {
                return res.status(404).json({ error: 'not_found', message: 'node not found' });
            }
            return res.status(500).json({ error: 'server_error' });
        }
    }

    static async updateNodeStats(req: Request, res: Response): Promise<any> {
        try {
            const {
                node_id,
                served_requests,
                tokens_generated,
                self_requests,
                session_uptime,
                peak_t_s,
                avg_t_s,
                low_t_s,
                response_avg_time,
            } = req.body || {};

            if (!node_id) {
                return res.status(400).json({ error: 'bad_request', message: 'node_id is required' });
            }

            const fields: NodeStatisticsUpdate = {};

            // Helper to add field if provided
            const addField = (name: string, value: any) => {
                if (value !== undefined) {
                    (fields as any)[name] = value;
                }
            };

            addField('served_requests', served_requests);
            addField('tokens_generated', tokens_generated);
            addField('self_requests', self_requests);
            addField('session_uptime', session_uptime);
            addField('peak_t_s', peak_t_s);
            addField('avg_t_s', avg_t_s);
            addField('low_t_s', low_t_s);
            addField('response_avg_time', response_avg_time);

            if (Object.keys(fields).length === 0) {
                return res.status(400).json({
                    error: 'bad_request',
                    message: 'at least one statistic field required',
                });
            }

            const updated = await StatsService.updateNodeStats(node_id, fields);
            logger.info(`[Stats] Statistics updated for node: ${node_id}`, { fields: Object.keys(fields) });
            return res.json(updated);
        } catch (err: any) {
            logger.error(`[Stats] updateNodeStats error: ${err.message}`, { stack: err.stack });
            if (err.code === 'NODE_NOT_FOUND') {
                return res.status(404).json({ error: 'not_found', message: 'node not found' });
            }
            return res.status(500).json({ error: 'server_error' });
        }
    }
}
