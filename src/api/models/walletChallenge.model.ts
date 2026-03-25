import { docClient } from './dbClient';
import { AWS_CONFIG } from '../../config/aws';
import { PutCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

const TABLE_NAME = AWS_CONFIG.dynamodb.walletChallengesTable;

export class WalletChallengesModel {
    static async saveChallenge(item: any) {
        await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item
        }));
    }

    static async getChallenge(key: { address: string, chain_type: string }) {
        const res = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: key
        }));
        return res.Item || null;
    }

    static async deleteChallenge(key: { address: string, chain_type: string }) {
        await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: key
        }));
    }
}
