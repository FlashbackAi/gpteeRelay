#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { GpteeRelayStack } from '../lib/gptee-relay-stack';

const app = new cdk.App();

// Configuration - Update these values
const config = {
  account: '144273780915',
  region: 'us-east-1',

  // Domain configuration (optional - set to empty string to skip)
  domainName: 'api.gptee.ai', // Backend API endpoint
  hostedZoneId: 'Z0893552269CFTK2NB5G1', // Route 53 hosted zone ID
  hostedZoneName: 'gptee.ai', // Your root domain

  // Existing resources (already created)
  s3BucketName: 'gptee-image-analysis',
  dynamoDBTables: {
    tasks: 'image-analysis-tasks_v1',
    results: 'image-analysis-results_v1',
    nodeIdentities: 'node_identifier_v1',
    nodes: 'nodes_v1',
    nodeSettings: 'node_settings_v1',
    nodeStatistics: 'node_statistics_v1',
    walletChallenges: 'wallet_challenges_v1',
  },

  // ECS Configuration
  ecsConfig: {
    cpu: 1024,      // 1 vCPU
    memory: 2048,  // 2 GB
    minCapacity: 2,
    maxCapacity: 6,
    targetCpuUtilization: 70,
  },

  // Redis Configuration
  redisConfig: {
    nodeType: 'cache.t4g.small', // 1.5 GB RAM, ~$23/month
    engineVersion: '7.0',
  },
};

new GpteeRelayStack(app, 'GpteeRelayStack', {
  env: {
    account: config.account,
    region: config.region,
  },
  config,
  description: 'GpteeRelay - Distributed WebSocket Relay Server',
});

app.synth();
