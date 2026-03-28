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
                // Provider mode stats
                pro_mode_requests_served,
                pro_mode_tokens_generated,
                pro_mode_self_requests,
                pro_mode_peak_t_s,
                pro_mode_avg_t_s,
                pro_mode_low_t_s,
                pro_mode_response_avg_time,
                pro_mode_session_uptime,
                pro_mode_total_uptime,
                pro_mode_session_start_time,
                // Worker mode stats
                work_mode_tasks_processed,
                work_mode_tasks_failed,
                work_mode_total_detections,
                work_mode_avg_processing_time,
                work_mode_session_uptime,
                work_mode_total_uptime,
                work_mode_session_start_time,
                // Node-level stats
                node_total_uptime,
                node_last_active_time,
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

            // Provider mode stats
            addField('pro_mode_requests_served', pro_mode_requests_served);
            addField('pro_mode_tokens_generated', pro_mode_tokens_generated);
            addField('pro_mode_self_requests', pro_mode_self_requests);
            addField('pro_mode_peak_t_s', pro_mode_peak_t_s);
            addField('pro_mode_avg_t_s', pro_mode_avg_t_s);
            addField('pro_mode_low_t_s', pro_mode_low_t_s);
            addField('pro_mode_response_avg_time', pro_mode_response_avg_time);
            addField('pro_mode_session_uptime', pro_mode_session_uptime);
            addField('pro_mode_total_uptime', pro_mode_total_uptime);
            addField('pro_mode_session_start_time', pro_mode_session_start_time);
            // Worker mode stats
            addField('work_mode_tasks_processed', work_mode_tasks_processed);
            addField('work_mode_tasks_failed', work_mode_tasks_failed);
            addField('work_mode_total_detections', work_mode_total_detections);
            addField('work_mode_avg_processing_time', work_mode_avg_processing_time);
            addField('work_mode_session_uptime', work_mode_session_uptime);
            addField('work_mode_total_uptime', work_mode_total_uptime);
            addField('work_mode_session_start_time', work_mode_session_start_time);
            // Node-level stats
            addField('node_total_uptime', node_total_uptime);
            addField('node_last_active_time', node_last_active_time);

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
