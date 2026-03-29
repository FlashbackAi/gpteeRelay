/**
 * SQS Task Creator Service
 *
 * Event-driven task creation from S3 uploads via SQS
 * Replaces polling-based S3 scanning
 */

import { getSQSService, ImageUploadEvent } from './SQSService';
import { getDynamoDBService } from './DynamoDBService';
import { ImageAnalysisCoordinator } from '../ImageAnalysisCoordinator';
import logger from '../utils/logger';

export class SQSTaskCreator {
  private sqsService = getSQSService();
  private dynamoDBService = getDynamoDBService();
  private coordinator: ImageAnalysisCoordinator;

  constructor(coordinator: ImageAnalysisCoordinator) {
    this.coordinator = coordinator;
  }

  /**
   * Start processing SQS events
   */
  async start(): Promise<void> {
    if (!this.sqsService.isConfigured()) {
      logger.warn('[SQSTaskCreator] SQS not configured - task creation disabled');
      logger.warn('[SQSTaskCreator] Set SQS_QUEUE_URL environment variable to enable');
      return;
    }

    logger.info('[SQSTaskCreator] 🚀 Starting SQS-based task creation');

    // Start polling SQS
    await this.sqsService.startPolling(async (event: ImageUploadEvent) => {
      await this.handleImageUpload(event);
    });
  }

  /**
   * Stop processing
   */
  stop(): void {
    this.sqsService.stopPolling();
    logger.info('[SQSTaskCreator] Stopped');
  }

  /**
   * Handle S3 image upload event from SQS
   */
  private async handleImageUpload(event: ImageUploadEvent): Promise<void> {
    try {
      const imageId = this.generateImageId(event.imageKey);

      logger.info(`[SQSTaskCreator] Processing image: ${event.imageKey} (${event.size} bytes)`);

      // Try to create task in DynamoDB (atomic - prevents duplicates across instances)
      const result = await this.dynamoDBService.createTask({
        imageId,
        imageName: event.imageKey.split('/').pop() || event.imageKey,
        s3Bucket: event.bucket,
        s3Key: event.imageKey,
        priority: 'normal',
      });

      if (result.created) {
        logger.info(`[SQSTaskCreator] ✅ Created task for image: ${event.imageKey}`);
      } else {
        logger.debug(`[SQSTaskCreator] Task already exists: ${imageId} (${result.reason})`);
      }
    } catch (err: any) {
      logger.error(`[SQSTaskCreator] Error handling image upload: ${err.message}`);
      throw err; // SQS will retry on error
    }
  }

  /**
   * Generate consistent image ID from S3 key
   */
  private generateImageId(s3Key: string): string {
    return s3Key.replace(/[^a-zA-Z0-9]/g, '_');
  }
}

// Singleton instance
let sqsTaskCreatorInstance: SQSTaskCreator | null = null;

export function getSQSTaskCreator(coordinator: ImageAnalysisCoordinator): SQSTaskCreator {
  if (!sqsTaskCreatorInstance) {
    sqsTaskCreatorInstance = new SQSTaskCreator(coordinator);
  }
  return sqsTaskCreatorInstance;
}

export default SQSTaskCreator;
