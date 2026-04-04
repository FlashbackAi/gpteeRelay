import { ImageAnalysisCoordinator } from '../ImageAnalysisCoordinator';
import { getS3Service } from './S3Service';
import { getDynamoDBService } from './DynamoDBService';

/**
 * Task Creator Service
 *
 * Automatically discovers images from S3 and creates analysis tasks.
 * Prevents duplicate task creation using DynamoDB state tracking.
 */
export class TaskCreatorService {
  private coordinator: ImageAnalysisCoordinator;
  private s3Service = getS3Service();
  private dynamoDBService = getDynamoDBService();

  private pollingInterval?: NodeJS.Timeout;
  private readonly POLLING_INTERVAL_MS = 120_000; // Poll every 2 minutes (120 seconds)
  private readonly BATCH_SIZE = 20; // Process 20 images per poll

  constructor(coordinator: ImageAnalysisCoordinator) {
    this.coordinator = coordinator;
    console.log('[TaskCreator] Initialized');
  }

  /**
   * Start automatic task creation from S3
   */
  async start(): Promise<void> {
    console.log('[TaskCreator] 🚀 Starting automatic task creation');

    // Initial scan
    await this.scanAndCreateTasks();

    // Start periodic polling
    this.pollingInterval = setInterval(() => {
      this.scanAndCreateTasks();
    }, this.POLLING_INTERVAL_MS);
  }

  /**
   * Stop automatic task creation
   */
  stop(): void {
    console.log('[TaskCreator] 🛑 Stopping automatic task creation');
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
    }
  }

  /**
   * Scan S3 for images and create tasks for unprocessed ones
   */
  private async scanAndCreateTasks(): Promise<void> {
    try {
      console.log('[TaskCreator] 🔍 Scanning S3 for new images...');

      // List all images in S3
      const images = await this.s3Service.listImages();

      if (images.length === 0) {
        console.log('[TaskCreator] No images found in S3');
        return;
      }

      console.log(`[TaskCreator] Found ${images.length} images in S3`);

      let newTasksCreated = 0;
      let alreadyProcessed = 0;
      let alreadyPending = 0;
      let scannedCount = 0;

      // Process images until we create BATCH_SIZE tasks or run out of images
      for (const image of images) {
        scannedCount++;
        const imageId = this.generateImageId(image.key);

        // Check if task already exists in DynamoDB
        const result = await this.dynamoDBService.createTask({
          imageId,
          imageName: image.key.split('/').pop() || image.key,
          s3Bucket: this.s3Service.getBucket(),
          s3Key: image.key,
          priority: 'normal',
        });

        if (!result.created) {
          if (result.reason === 'already_completed') {
            alreadyProcessed++;
          } else {
            alreadyPending++;
          }
          continue;
        }

        // Create task in DynamoDB (periodic assignment will pick it up)
        const taskResult = await this.dynamoDBService.createTask({
          imageId,
          imageName: image.key.split('/').pop() || image.key,
          s3Bucket: this.s3Service.getBucket(),
          s3Key: image.key,
          priority: 'normal',
        });

        if (taskResult.created) {
          console.log(`[TaskCreator] ✅ Created task for image: ${image.key} (${taskResult.reason})`);
          newTasksCreated++;
        } else {
          console.log(`[TaskCreator] ⏭️ Skipped image: ${image.key} (${taskResult.reason})`);
        }

        // Stop after creating BATCH_SIZE new tasks
        if (newTasksCreated >= this.BATCH_SIZE) {
          break;
        }
      }

      // Log summary
      if (newTasksCreated > 0 || alreadyProcessed > 0 || alreadyPending > 0) {
        console.log('[TaskCreator] 📊 Scan summary:', {
          newTasks: newTasksCreated,
          alreadyProcessed,
          alreadyPending,
          totalScanned: scannedCount,
        });
      }

    } catch (error: any) {
      console.error('[TaskCreator] ❌ Error during scan:', error.message);
    }
  }

  /**
   * Generate a unique imageId from S3 key
   * Uses the key itself as the ID (ensures uniqueness)
   */
  private generateImageId(s3Key: string): string {
    // Use the full S3 key as imageId (URL-safe)
    return s3Key.replace(/[^a-zA-Z0-9\-_.\/]/g, '_');
  }

  /**
   * Manually trigger a scan (useful for testing)
   */
  async triggerScan(): Promise<void> {
    console.log('[TaskCreator] 🔄 Manual scan triggered');
    await this.scanAndCreateTasks();
  }

  /**
   * Create task for a specific image
   */
  async createTaskForImage(s3Key: string, priority: 'low' | 'normal' | 'high' = 'normal'): Promise<string | null> {
    const imageId = this.generateImageId(s3Key);

    // Check if task already exists
    const result = await this.dynamoDBService.createTask({
      imageId,
      imageName: s3Key.split('/').pop() || s3Key,
      s3Bucket: this.s3Service.getBucket(),
      s3Key,
      priority,
    });

    if (!result.created) {
      console.log(`[TaskCreator] Task already exists for ${s3Key}: ${result.reason}`);
      return null;
    }

    // Task created in DynamoDB, periodic assignment will pick it up
    console.log(`[TaskCreator] ✅ Created task for image: ${s3Key} (${result.reason})`);
    return imageId; // Return imageId as taskId
  }
}

// Singleton instance
let taskCreatorInstance: TaskCreatorService | null = null;

export function getTaskCreatorService(coordinator: ImageAnalysisCoordinator): TaskCreatorService {
  if (!taskCreatorInstance) {
    taskCreatorInstance = new TaskCreatorService(coordinator);
  }
  return taskCreatorInstance;
}
