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
            served_requests: stats?.served_requests ?? 0,
            tokens_generated: stats?.tokens_generated ?? 0,
            self_requests: stats?.self_requests ?? 0,
            session_uptime: stats?.session_uptime ?? 0,
            peak_t_s: stats?.peak_t_s ?? 0,
            avg_t_s: stats?.avg_t_s ?? 0,
            low_t_s: stats?.low_t_s ?? 0,
            response_avg_time: stats?.response_avg_time ?? 0,
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
