import { docClient } from './dbClient';
import { AWS_CONFIG } from '../../config/aws';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const TABLE_NAME = AWS_CONFIG.dynamodb.nodeStatisticsTable;

export interface NodeStatistics {
    node_id: string;

    // Provider Mode Stats (LLM serving)
    pro_mode_requests_served?: number;
    pro_mode_tokens_generated?: number;
    pro_mode_self_requests?: number;
    pro_mode_peak_t_s?: number;
    pro_mode_avg_t_s?: number;
    pro_mode_low_t_s?: number;
    pro_mode_response_avg_time?: number;

    // Provider Mode Uptime
    pro_mode_session_uptime?: number;        // Current session (seconds)
    pro_mode_total_uptime?: number;          // Lifetime accumulated (seconds)
    pro_mode_session_start_time?: string;    // ISO timestamp

    // Worker Mode Stats (Image analysis)
    work_mode_tasks_processed?: number;
    work_mode_tasks_failed?: number;
    work_mode_total_detections?: number;
    work_mode_avg_processing_time?: number;  // milliseconds

    // Worker Mode Uptime
    work_mode_session_uptime?: number;       // Current session (seconds)
    work_mode_total_uptime?: number;         // Lifetime accumulated (seconds)
    work_mode_session_start_time?: string;   // ISO timestamp

    // Node-Level Uptime (calculated: pro + work)
    node_total_uptime?: number;              // Total contribution (seconds)
    node_last_active_time?: string;          // ISO timestamp

    created_at: string;
    updated_at: string;
}

export type NodeStatisticsUpdate = Partial<Omit<NodeStatistics, 'node_id' | 'created_at' | 'updated_at'>>;

export class NodeStatisticsModel {

    static async getStats(node_id: string): Promise<NodeStatistics | null> {
        const res = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { node_id },
        }));
        return (res.Item as NodeStatistics) || null;
    }

    static async upsertStats(node_id: string, fields: NodeStatisticsUpdate): Promise<NodeStatistics> {
        const now = new Date().toISOString();

        const setClauses: string[] = [
            'updated_at = :updated_at',
            'created_at = if_not_exists(created_at, :created_at)',
        ];
        const exprValues: Record<string, any> = {
            ':updated_at': now,
            ':created_at': now,
        };
        const exprNames: Record<string, string> = {};

        // For each field, update the value
        Object.entries(fields).forEach(([key, value]) => {
            if (value !== undefined) {
                // Use Name mapping to avoid reserved keywords in DynamoDB
                const attrName = `#${key}`;
                const attrVal = `:${key}`;
                setClauses.push(`${attrName} = ${attrVal}`);
                exprValues[attrVal] = value;
                exprNames[attrName] = key;
            }
        });

        const res = await docClient.send(new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { node_id },
            UpdateExpression: `SET ${setClauses.join(', ')}`,
            ExpressionAttributeNames: Object.keys(exprNames).length > 0 ? exprNames : undefined,
            ExpressionAttributeValues: exprValues,
            ReturnValues: 'ALL_NEW',
        }));

        return res.Attributes as NodeStatistics;
    }
}
