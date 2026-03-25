import { getDynamoDBService } from '../../services/DynamoDBService';

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
}
