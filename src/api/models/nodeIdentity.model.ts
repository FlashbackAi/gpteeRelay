import { docClient } from './dbClient';
import { AWS_CONFIG } from '../../config/aws';
import { PutCommand, GetCommand, UpdateCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

const TABLE_NAME = AWS_CONFIG.dynamodb.nodeIdentitiesTable;

export class NodeIdentitiesModel {
    static async getIdentity(identifier: string, provider: string) {
        const res = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { identifier, provider }
        }));
        return res.Item || null;
    }

    static async createIdentity(params: { identifier: string, provider: string, node_id: string, username?: string | null, verified?: boolean, password_hash?: string }) {
        const now = new Date().toISOString();
        const item: any = {
            identifier: params.identifier,
            provider: params.provider,
            node_id: params.node_id,
            username: params.username || null,
            verified: !!params.verified,
            created_at: now,
            last_seen_at: now,
        };
        if (params.password_hash) item.password_hash = params.password_hash;

        await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item,
            ConditionExpression: 'attribute_not_exists(identifier) AND attribute_not_exists(provider)'
        }));
        return item;
    }

    static async touchIdentity(identifier: string, provider: string) {
        try {
            await docClient.send(new UpdateCommand({
                TableName: TABLE_NAME,
                Key: { identifier, provider },
                UpdateExpression: 'SET last_seen_at = :ts',
                ExpressionAttributeValues: { ':ts': new Date().toISOString() },
                ConditionExpression: 'attribute_exists(identifier) AND attribute_exists(provider)'
            }));
        } catch (_) { }
    }

    static async deleteIdentity(identifier: string, provider: string) {
        await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { identifier, provider }
        }));
    }
}
