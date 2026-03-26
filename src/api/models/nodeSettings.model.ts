import { docClient } from './dbClient';
import { AWS_CONFIG } from '../../config/aws';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const TABLE_NAME = AWS_CONFIG.dynamodb.nodeSettingsTable;

export interface NodeSettings {
    node_id: string;
    worker_mode_enabled?: boolean;
    worker_mode_updated_at?: string;
    provider_mode_enabled?: boolean;
    provider_mode_updated_at?: string;
    battery_threshold?: number;
    created_at: string;
    updated_at: string;
}

export interface NodeSettingsUpdate {
    worker_mode_enabled?: boolean;
    provider_mode_enabled?: boolean;
    battery_threshold?: number;
}

export class NodeSettingsModel {

    static async getSettings(node_id: string): Promise<NodeSettings | null> {
        const res = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { node_id },
        }));
        return (res.Item as NodeSettings) || null;
    }

    static async upsertSettings(node_id: string, fields: NodeSettingsUpdate): Promise<NodeSettings> {
        const now = new Date().toISOString();

        const setClauses: string[] = [
            'updated_at = :updated_at',
            'created_at = if_not_exists(created_at, :created_at)',
        ];
        const exprValues: Record<string, any> = {
            ':updated_at': now,
            ':created_at': now,
        };

        if (fields.worker_mode_enabled !== undefined) {
            setClauses.push('worker_mode_enabled = :wme');
            exprValues[':wme'] = fields.worker_mode_enabled;
            setClauses.push('worker_mode_updated_at = :wme_at');
            exprValues[':wme_at'] = now;
        }

        if (fields.provider_mode_enabled !== undefined) {
            setClauses.push('provider_mode_enabled = :pme');
            exprValues[':pme'] = fields.provider_mode_enabled;
            setClauses.push('provider_mode_updated_at = :pme_at');
            exprValues[':pme_at'] = now;
        }

        if (fields.battery_threshold !== undefined) {
            setClauses.push('battery_threshold = :bt');
            exprValues[':bt'] = fields.battery_threshold;
        }

        const res = await docClient.send(new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { node_id },
            UpdateExpression: `SET ${setClauses.join(', ')}`,
            ExpressionAttributeValues: exprValues,
            ReturnValues: 'ALL_NEW',
        }));

        return res.Attributes as NodeSettings;
    }
}
