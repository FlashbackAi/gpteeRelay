/**
 * AWS Configuration
 *
 * Centralized AWS settings for all services
 */

export const AWS_CONFIG = {
  /**
   * AWS Region
   */
  region: process.env.AWS_REGION || 'ap-south-1',

  /**
   * S3 Bucket for image storage
   */
  s3: {
    bucket: 'gpteeimageanalysis',
  },

  /**
   * DynamoDB Tables
   */
  dynamodb: {
    tasksTable: 'image-analysis-tasks',
    resultsTable: 'image-analysis-results',
  },
};
