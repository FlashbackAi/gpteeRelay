/**
 * SQS Service
 *
 * Event-driven task creation from S3 uploads
 * Replaces polling-based S3 scanning
 */

import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, Message } from '@aws-sdk/client-sqs';
import { AWS_CONFIG } from '../config/aws';
import logger from '../utils/logger';

export interface ImageUploadEvent {
  imageKey: string;
  bucket: string;
  uploadedAt: string;
  size: number;
}

class SQSService {
  private client: SQSClient;
  private queueUrl: string;
  private isPolling: boolean = false;
  private pollingInterval?: NodeJS.Timeout;

  constructor() {
    this.client = new SQSClient({ region: AWS_CONFIG.region });
    this.queueUrl = process.env.SQS_QUEUE_URL || '';

    if (!this.queueUrl) {
      logger.warn('[SQS] Queue URL not configured - SQS disabled');
    }
  }

  /**
   * Start polling SQS for new image upload events
   */
  async startPolling(messageHandler: (event: ImageUploadEvent) => Promise<void>): Promise<void> {
    if (!this.queueUrl) {
      logger.error('[SQS] Cannot start polling - queue URL not configured');
      return;
    }

    if (this.isPolling) {
      logger.warn('[SQS] Already polling');
      return;
    }

    this.isPolling = true;
    logger.info('[SQS] Started polling for image upload events');

    // Long-polling with 20 second wait time
    await this.poll(messageHandler);
  }

  /**
   * Stop polling
   */
  stopPolling(): void {
    this.isPolling = false;
    if (this.pollingInterval) {
      clearTimeout(this.pollingInterval);
    }
    logger.info('[SQS] Stopped polling');
  }

  /**
   * Poll for messages (long polling)
   */
  private async poll(messageHandler: (event: ImageUploadEvent) => Promise<void>): Promise<void> {
    while (this.isPolling) {
      try {
        const command = new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: 10, // Process up to 10 messages at once
          WaitTimeSeconds: 20, // Long polling (reduces empty responses)
          VisibilityTimeout: 300, // 5 minutes to process
        });

        const response = await this.client.send(command);

        if (response.Messages && response.Messages.length > 0) {
          logger.info(`[SQS] Received ${response.Messages.length} messages`);

          // Process messages concurrently
          await Promise.all(
            response.Messages.map(msg => this.processMessage(msg, messageHandler))
          );
        }
      } catch (err: any) {
        logger.error(`[SQS] Polling error: ${err.message}`);
        // Wait 5 seconds before retrying
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  /**
   * Process a single SQS message
   */
  private async processMessage(
    message: Message,
    messageHandler: (event: ImageUploadEvent) => Promise<void>
  ): Promise<void> {
    try {
      if (!message.Body) {
        logger.warn('[SQS] Message has no body');
        return;
      }

      // Parse S3 event notification
      const s3Event = JSON.parse(message.Body);

      // Handle SNS-wrapped messages (if using SNS -> SQS)
      let records = s3Event.Records;
      if (s3Event.Message) {
        const snsMessage = JSON.parse(s3Event.Message);
        records = snsMessage.Records;
      }

      if (!records || records.length === 0) {
        logger.warn('[SQS] No S3 records in message');
        await this.deleteMessage(message.ReceiptHandle!);
        return;
      }

      // Process each S3 record
      for (const record of records) {
        if (record.eventName?.startsWith('ObjectCreated:')) {
          const imageEvent: ImageUploadEvent = {
            imageKey: record.s3.object.key,
            bucket: record.s3.bucket.name,
            uploadedAt: record.eventTime,
            size: record.s3.object.size,
          };

          logger.info(`[SQS] Processing image upload: ${imageEvent.imageKey}`);

          // Call the handler
          await messageHandler(imageEvent);
        }
      }

      // Delete message after successful processing
      await this.deleteMessage(message.ReceiptHandle!);
      logger.debug(`[SQS] Deleted message: ${message.MessageId}`);

    } catch (err: any) {
      logger.error(`[SQS] Error processing message: ${err.message}`);
      // Message will become visible again after VisibilityTimeout
      // SQS will retry automatically
    }
  }

  /**
   * Delete processed message from queue
   */
  private async deleteMessage(receiptHandle: string): Promise<void> {
    try {
      const command = new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
      });

      await this.client.send(command);
    } catch (err: any) {
      logger.error(`[SQS] Error deleting message: ${err.message}`);
    }
  }

  /**
   * Health check
   */
  isConfigured(): boolean {
    return !!this.queueUrl;
  }
}

// Singleton instance
let sqsServiceInstance: SQSService | null = null;

export function getSQSService(): SQSService {
  if (!sqsServiceInstance) {
    sqsServiceInstance = new SQSService();
  }
  return sqsServiceInstance;
}

export default SQSService;
