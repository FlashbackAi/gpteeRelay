import { docClient } from './dbClient';
import { AWS_CONFIG } from '../../config/aws';
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const TABLE_NAME = AWS_CONFIG.dynamodb.nodesTable;

function compact(obj: any) {
    return Object.fromEntries(
        Object.entries(obj).filter(([_, v]) => v !== null && v !== undefined)
    );
}

export class NodesModel {
    static async createNode(node: any) {
        const now = new Date().toISOString();
        const raw = {
            node_id: node.node_id,
            created_at: now,
            updated_at: now,
            email: node.email || null,
            email_verified: node.email_verified,
            name: node.name || null,
        };
        const item = compact(raw);
        await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item,
            ConditionExpression: 'attribute_not_exists(node_id)',
        }));
        return item;
    }

    static async getNode(node_id: string) {
        const res = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { node_id }
        }));
        return res.Item || null;
    }

}
