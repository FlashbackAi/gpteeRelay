import { docClient } from './dbClient';
import { AWS_CONFIG } from '../../config/aws';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const TABLE_NAME = AWS_CONFIG.dynamodb.nodeStatisticsTable;

export interface NodeStatistics {
    node_id: string;
    served_requests?: number;
    tokens_generated?: number;
    self_requests?: number;
    session_uptime?: number;
    peak_t_s?: number;
    avg_t_s?: number;
    low_t_s?: number;
    response_avg_time?: number;
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
