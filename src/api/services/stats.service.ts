import { getDynamoDBService } from '../../services/DynamoDBService';
import { NodeStatisticsModel, NodeStatisticsUpdate } from '../models/nodeStatistics.model';
import { NodesModel } from '../models/node.model';

export class StatsService {
    static async getOverallStats() {
        try {
            const dynamoService = getDynamoDBService();
            const stats = await dynamoService.getStatistics();
            return stats;
        } catch (error) {
            console.error('Failed to get stats', error);
            throw error;
        }
    }

    static async getNodeStats(node_id: string) {
        // Ensure node exists
        const node = await NodesModel.getNode(node_id);
        if (!node) {
            const err: any = new Error('node_not_found');
            err.code = 'NODE_NOT_FOUND';
            throw err;
        }

        const stats = await NodeStatisticsModel.getStats(node_id);

        return {
            node_id,
            // Provider mode stats
            pro_mode_requests_served: stats?.pro_mode_requests_served ?? 0,
            pro_mode_tokens_generated: stats?.pro_mode_tokens_generated ?? 0,
            pro_mode_self_requests: stats?.pro_mode_self_requests ?? 0,
            pro_mode_peak_t_s: stats?.pro_mode_peak_t_s ?? 0,
            pro_mode_avg_t_s: stats?.pro_mode_avg_t_s ?? 0,
            pro_mode_low_t_s: stats?.pro_mode_low_t_s ?? 0,
            pro_mode_response_avg_time: stats?.pro_mode_response_avg_time ?? 0,
            pro_mode_session_uptime: stats?.pro_mode_session_uptime ?? 0,
            pro_mode_total_uptime: stats?.pro_mode_total_uptime ?? 0,
            pro_mode_session_start_time: stats?.pro_mode_session_start_time ?? null,
            // Worker mode stats
            work_mode_tasks_processed: stats?.work_mode_tasks_processed ?? 0,
            work_mode_tasks_failed: stats?.work_mode_tasks_failed ?? 0,
            work_mode_total_detections: stats?.work_mode_total_detections ?? 0,
            work_mode_avg_processing_time: stats?.work_mode_avg_processing_time ?? 0,
            work_mode_session_uptime: stats?.work_mode_session_uptime ?? 0,
            work_mode_total_uptime: stats?.work_mode_total_uptime ?? 0,
            work_mode_session_start_time: stats?.work_mode_session_start_time ?? null,
            // Node-level stats
            node_total_uptime: stats?.node_total_uptime ?? 0,
            node_last_active_time: stats?.node_last_active_time ?? null,
            created_at: stats?.created_at ?? null,
            updated_at: stats?.updated_at ?? null,
        };
    }

    static async updateNodeStats(node_id: string, fields: NodeStatisticsUpdate) {
        // Ensure node exists
        const node = await NodesModel.getNode(node_id);
        if (!node) {
            const err: any = new Error('node_not_found');
            err.code = 'NODE_NOT_FOUND';
            throw err;
        }

        return await NodeStatisticsModel.upsertStats(node_id, fields);
    }
}
