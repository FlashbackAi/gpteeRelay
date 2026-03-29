/**
 * AWS Configuration
 *
 * Centralized AWS settings for all services
 */

export const AWS_CONFIG = {
  /**
   * AWS Region
   */
  region: process.env.AWS_REGION || 'us-east-1',

  /**
   * S3 Bucket for image storage
   */
  s3: {
    bucket: 'gptee-image-analysis',
  },

  /**
   * SQS Queue for image upload events
   */
  sqs: {
    queueUrl: process.env.SQS_QUEUE_URL || '',
  },

  /**
   * Redis (ElastiCache) for distributed state
   */
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  /**
   * DynamoDB Tables
   */
  dynamodb: {
    tasksTable: 'image-analysis-tasks_v1',
    resultsTable: 'image-analysis-results_v1',
    nodeIdentitiesTable: 'node_identifier_v1',
    nodesTable: 'nodes_v1',
    nodeSettingsTable: 'node_settings_v1',
    nodeStatisticsTable: 'node_statistics_v1',
    walletChallengesTable: 'wallet_challenges_v1',
  },
};
