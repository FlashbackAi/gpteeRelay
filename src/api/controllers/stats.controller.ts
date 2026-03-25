import { Request, Response } from 'express';
import { StatsService } from '../services/stats.service';

export class StatsController {
    static async getStats(req: Request, res: Response) {
        try {
            const stats = await StatsService.getOverallStats();
            res.json({ success: true, data: stats });
        } catch (error: any) {
            res.status(500).json({ success: false, error: error.message });
        }
    }
}
