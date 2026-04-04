import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { AWS_CONFIG } from '../config/aws';

/**
 * DynamoDB Service for Image Analysis System
 *
 * Tables:
 * 1. image-analysis-tasks - Track task state and prevent duplicates
 * 2. image-analysis-results - Store completed analysis results
 */
export class DynamoDBService {
  private client: DynamoDBDocumentClient;
  private readonly TASKS_TABLE = AWS_CONFIG.dynamodb.tasksTable;
  private readonly RESULTS_TABLE = AWS_CONFIG.dynamodb.resultsTable;

  constructor() {
    // Initialize DynamoDB client
    const dynamoClient = new DynamoDBClient({
      region: AWS_CONFIG.region,
    });

    this.client = DynamoDBDocumentClient.from(dynamoClient, {
      marshallOptions: {
        removeUndefinedValues: true,
      },
    });
  }

  /**
   * Create a new task entry
   * Returns false if task already exists (duplicate prevention)
   */
  async createTask(params: {
    imageId: string;
    imageName: string;
    s3Bucket: string;
    s3Key: string;
    priority: 'low' | 'normal' | 'high';
  }): Promise<{ created: boolean; reason?: string }> {
    const { imageId, imageName, s3Bucket, s3Key, priority } = params;

    // Check if task already exists
    const existing = await this.getTask(imageId);
    if (existing) {
      // If already completed successfully, don't recreate
      if (existing.status === 'completed') {
        return { created: false, reason: 'already_completed' };
      }
      // If failed, allow retry by updating status to pending
      if (existing.status === 'failed') {
        await this.updateTaskStatus(imageId, 'pending');
        return { created: true, reason: 'retry_after_failure' };
      }
      // If pending/assigned/processing, don't recreate
      return { created: false, reason: `already_${existing.status}` };
    }

    // Create new task
    const now = new Date().toISOString();
    await this.client.send(
      new PutCommand({
        TableName: this.TASKS_TABLE,
        Item: {
          image_id: imageId, // DynamoDB table uses snake_case for partition key
          imageName,
          s3Bucket,
          s3Key,
          status: 'pending',
          priority,
          attemptCount: 0,
          createdAt: now,
          updatedAt: now,
        },
      })
    );

    return { created: true };
  }

  /**
   * Get task by imageId
   */
  async getTask(imageId: string): Promise<any | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.TASKS_TABLE,
        Key: { image_id: imageId }, // DynamoDB table uses snake_case for partition key
      })
    );
    return result.Item || null;
  }

  /**
   * Update task status
   */
  async updateTaskStatus(
    imageId: string,
    status: 'pending' | 'assigned' | 'processing' | 'completed' | 'failed',
    additionalFields?: {
      assignedWorkerId?: string;
      assignedAt?: string;
      completedAt?: string;
      attemptCount?: number;
    }
  ): Promise<void> {
    const updateExpression: string[] = ['#status = :status', '#updatedAt = :updatedAt'];
    const expressionAttributeNames: Record<string, string> = {
      '#status': 'status',
      '#updatedAt': 'updatedAt',
    };
    const expressionAttributeValues: Record<string, any> = {
      ':status': status,
      ':updatedAt': new Date().toISOString(),
    };

    if (additionalFields) {
      if (additionalFields.assignedWorkerId) {
        updateExpression.push('#assignedWorkerId = :assignedWorkerId');
        expressionAttributeNames['#assignedWorkerId'] = 'assignedWorkerId';
        expressionAttributeValues[':assignedWorkerId'] = additionalFields.assignedWorkerId;
      }
      if (additionalFields.assignedAt) {
        updateExpression.push('#assignedAt = :assignedAt');
        expressionAttributeNames['#assignedAt'] = 'assignedAt';
        expressionAttributeValues[':assignedAt'] = additionalFields.assignedAt;
      }
      if (additionalFields.completedAt) {
        updateExpression.push('#completedAt = :completedAt');
        expressionAttributeNames['#completedAt'] = 'completedAt';
        expressionAttributeValues[':completedAt'] = additionalFields.completedAt;
      }
      if (additionalFields.attemptCount !== undefined) {
        updateExpression.push('#attemptCount = :attemptCount');
        expressionAttributeNames['#attemptCount'] = 'attemptCount';
        expressionAttributeValues[':attemptCount'] = additionalFields.attemptCount;
        updateExpression.push('#lastAttemptAt = :lastAttemptAt');
        expressionAttributeNames['#lastAttemptAt'] = 'lastAttemptAt';
        expressionAttributeValues[':lastAttemptAt'] = new Date().toISOString();
      }
    }

    await this.client.send(
      new UpdateCommand({
        TableName: this.TASKS_TABLE,
        Key: { image_id: imageId }, // DynamoDB table uses snake_case for partition key
        UpdateExpression: `SET ${updateExpression.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
      })
    );
  }

  /**
   * Get pending tasks (for bulk submission or monitoring)
   */
  async getPendingTasks(limit: number = 100): Promise<any[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.TASKS_TABLE,
        IndexName: 'status-priority-index',
        KeyConditionExpression: '#status = :status',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':status': 'pending',
        },
        Limit: limit,
        ScanIndexForward: false, // Sort by priority descending
      })
    );
    return result.Items || [];
  }

  /**
   * Store task result
   */
  async storeTaskResult(result: {
    taskId: string;
    imageId: string;
    imageName: string;
    analysisType: string;
    status: 'completed' | 'failed';
    detections?: Array<{
      detectionId: string;
      bbox: number[];
      confidence: number;
      attributes?: {
        age?: number;
        gender?: string;
        gender_confidence?: number;
      };
    }>;
    detectionsFound?: number;
    workerId: string;
    workerDisplayName: string;
    processingTimeMs: number;
    thermalStatus: string;
    errorMessage?: string;
    errorCode?: string;
  }): Promise<void> {
    const now = new Date().toISOString();

    // Store result
    await this.client.send(
      new PutCommand({
        TableName: this.RESULTS_TABLE,
        Item: {
          ...result,
          completedAt: now,
          createdAt: now,
        },
      })
    );

    // Update task status
    await this.updateTaskStatus(result.imageId, result.status, {
      completedAt: now,
    });

    console.log(`[DynamoDB] Stored ${result.status} result for task ${result.taskId}`);
  }

  /**
   * Get results for an image
   */
  async getImageResults(imageId: string): Promise<any[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.RESULTS_TABLE,
        KeyConditionExpression: '#imageId = :imageId',
        ExpressionAttributeNames: {
          '#imageId': 'imageId',
        },
        ExpressionAttributeValues: {
          ':imageId': imageId,
        },
      })
    );
    return result.Items || [];
  }

  /**
   * Get statistics
   */
  async getStatistics(): Promise<{
    totalTasks: number;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  }> {
    // Note: For production, you'd want to maintain counters in a separate table
    // This is a simple scan-based approach (expensive for large datasets)

    // For now, return placeholder
    // TODO: Implement proper statistics tracking
    return {
      totalTasks: 0,
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    };
  }
}

// Singleton instance
let dynamoDBServiceInstance: DynamoDBService | null = null;

export function getDynamoDBService(): DynamoDBService {
  if (!dynamoDBServiceInstance) {
    dynamoDBServiceInstance = new DynamoDBService();
  }
  return dynamoDBServiceInstance;
}
