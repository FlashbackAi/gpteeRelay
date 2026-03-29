import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

interface GpteeRelayStackProps extends cdk.StackProps {
  config: {
    account: string;
    region: string;
    domainName?: string;
    hostedZoneId?: string;
    hostedZoneName?: string;
    s3BucketName: string;
    dynamoDBTables: {
      tasks: string;
      results: string;
      nodeIdentities: string;
      nodes: string;
      nodeSettings: string;
      nodeStatistics: string;
      walletChallenges: string;
    };
    ecsConfig: {
      cpu: number;
      memory: number;
      minCapacity: number;
      maxCapacity: number;
      targetCpuUtilization: number;
    };
    redisConfig: {
      nodeType: string;
      engineVersion: string;
    };
  };
}

export class GpteeRelayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GpteeRelayStackProps) {
    super(scope, id, props);

    const { config } = props;

    // ═══════════════════════════════════════════════════════════════════════════
    // VPC & Networking
    // ═══════════════════════════════════════════════════════════════════════════

    const vpc = new ec2.Vpc(this, 'GpteeVpc', {
      maxAzs: 2,
      natGateways: 1, // Cost optimization: 1 NAT gateway (~$32/month)
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // Security Groups
    // ═══════════════════════════════════════════════════════════════════════════

    // ALB Security Group
    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      description: 'Security group for Application Load Balancer',
      allowAllOutbound: true,
    });

    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS from internet'
    );

    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP from internet (for redirect)'
    );

    // ECS Security Group
    const ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
      vpc,
      description: 'Security group for ECS tasks',
      allowAllOutbound: true,
    });

    ecsSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(9293),
      'Allow traffic from ALB'
    );

    // Redis Security Group
    const redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSecurityGroup', {
      vpc,
      description: 'Security group for ElastiCache Redis',
      allowAllOutbound: false,
    });

    redisSecurityGroup.addIngressRule(
      ecsSecurityGroup,
      ec2.Port.tcp(6379),
      'Allow Redis access from ECS tasks'
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // ElastiCache Redis
    // ═══════════════════════════════════════════════════════════════════════════

    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Subnet group for GpteeRelay Redis',
      subnetIds: vpc.privateSubnets.map(subnet => subnet.subnetId),
      cacheSubnetGroupName: 'gptee-redis-subnet-group',
    });

    const redisCluster = new elasticache.CfnCacheCluster(this, 'RedisCluster', {
      cacheNodeType: config.redisConfig.nodeType,
      engine: 'redis',
      numCacheNodes: 1,
      engineVersion: config.redisConfig.engineVersion,
      cacheSubnetGroupName: redisSubnetGroup.ref,
      vpcSecurityGroupIds: [redisSecurityGroup.securityGroupId],
      clusterName: 'gptee-redis',
    });

    redisCluster.addDependency(redisSubnetGroup);

    // ═══════════════════════════════════════════════════════════════════════════
    // SQS FIFO Queue
    // ═══════════════════════════════════════════════════════════════════════════

    const imageTasksQueue = new sqs.Queue(this, 'ImageTasksQueue', {
      queueName: 'gptee-image-tasks',
      visibilityTimeout: cdk.Duration.seconds(300), // 5 minutes
      retentionPeriod: cdk.Duration.days(1),
      // Note: Using standard queue (not FIFO) because S3 event notifications don't support FIFO queues
      // Duplicate prevention is handled by DynamoDB's atomic createTask operation
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // S3 Event Notification
    // ═══════════════════════════════════════════════════════════════════════════

    const imageBucket = s3.Bucket.fromBucketName(
      this,
      'ImageBucket',
      config.s3BucketName
    );

    // Add S3 event notification to SQS
    imageBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(imageTasksQueue),
      { suffix: '.jpg' }
    );

    imageBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(imageTasksQueue),
      { suffix: '.png' }
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // DynamoDB Tables (Import Existing)
    // ═══════════════════════════════════════════════════════════════════════════

    const tasksTable = dynamodb.Table.fromTableName(
      this,
      'TasksTable',
      config.dynamoDBTables.tasks
    );

    const resultsTable = dynamodb.Table.fromTableName(
      this,
      'ResultsTable',
      config.dynamoDBTables.results
    );

    const nodeIdentitiesTable = dynamodb.Table.fromTableName(
      this,
      'NodeIdentitiesTable',
      config.dynamoDBTables.nodeIdentities
    );

    const nodesTable = dynamodb.Table.fromTableName(
      this,
      'NodesTable',
      config.dynamoDBTables.nodes
    );

    const nodeSettingsTable = dynamodb.Table.fromTableName(
      this,
      'NodeSettingsTable',
      config.dynamoDBTables.nodeSettings
    );

    const nodeStatisticsTable = dynamodb.Table.fromTableName(
      this,
      'NodeStatisticsTable',
      config.dynamoDBTables.nodeStatistics
    );

    const walletChallengesTable = dynamodb.Table.fromTableName(
      this,
      'WalletChallengesTable',
      config.dynamoDBTables.walletChallenges
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // ECR Repository
    // ═══════════════════════════════════════════════════════════════════════════
    
    // const ecrRepository = new ecr.Repository(this, 'GpteeRelayRepository', {
    //   repositoryName: 'gptee-relay',
    //   removalPolicy: cdk.RemovalPolicy.RETAIN,
    //   lifecycleRules: [
    //     {
    //       description: 'Keep last 10 images',
    //       maxImageCount: 10,
    //     },
    //   ],
    // });
    // Import existing ECR repository (created in previous deployment)
    const ecrRepository = ecr.Repository.fromRepositoryName(
      this,
      'GpteeRelayRepository',
      'gptee-relay'
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // IAM Roles
    // ═══════════════════════════════════════════════════════════════════════════

    // Task Execution Role (for ECS to pull images and write logs)
    const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Task Role (for application to access AWS services)
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Grant permissions to task role
    tasksTable.grantReadWriteData(taskRole);
    resultsTable.grantReadWriteData(taskRole);
    nodeIdentitiesTable.grantReadWriteData(taskRole);
    nodesTable.grantReadWriteData(taskRole);
    nodeSettingsTable.grantReadWriteData(taskRole);
    nodeStatisticsTable.grantReadWriteData(taskRole);
    walletChallengesTable.grantReadWriteData(taskRole);
    imageBucket.grantReadWrite(taskRole);
    imageTasksQueue.grantConsumeMessages(taskRole);

    // CloudWatch Logs permissions
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'logs:DescribeLogStreams',
        ],
        resources: [
          `arn:aws:logs:${config.region}:${config.account}:log-group:GpteeRelay/ApplicationLogs`,
          `arn:aws:logs:${config.region}:${config.account}:log-group:GpteeRelay/ApplicationLogs:*`,
        ],
      })
    );

    // ElastiCache describe permissions
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['elasticache:DescribeCacheClusters'],
        resources: ['*'],
      })
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // CloudWatch Log Groups
    // ═══════════════════════════════════════════════════════════════════════════

    const ecsLogGroup = new logs.LogGroup(this, 'EcsLogGroup', {
      logGroupName: '/ecs/gptee-relay',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const appLogGroup = new logs.LogGroup(this, 'AppLogGroup', {
      logGroupName: 'GpteeRelay/ApplicationLogs',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // ECS Cluster
    // ═══════════════════════════════════════════════════════════════════════════

    const cluster = new ecs.Cluster(this, 'GpteeCluster', {
      vpc,
      clusterName: 'gptee-cluster',
      containerInsights: true,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // ECS Task Definition
    // ═══════════════════════════════════════════════════════════════════════════

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      family: 'gptee-relay',
      cpu: config.ecsConfig.cpu,
      memoryLimitMiB: config.ecsConfig.memory,
      executionRole: taskExecutionRole,
      taskRole: taskRole,
    });

    // Get Redis endpoint
    const redisEndpoint = redisCluster.attrRedisEndpointAddress;
    const redisPort = redisCluster.attrRedisEndpointPort;

    const container = taskDefinition.addContainer('gptee-relay', {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepository, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'ecs',
        logGroup: ecsLogGroup,
      }),
      environment: {
        NODE_ENV: 'production',
        PORT: '9293',
        AWS_REGION: config.region,
        REDIS_URL: `redis://${redisEndpoint}:${redisPort}`,
        SQS_QUEUE_URL: imageTasksQueue.queueUrl,
      },
      healthCheck: {
        command: ['CMD-SHELL', 'node -e "require(\'http\').get(\'http://localhost:9293/health\', (r) => {process.exit(r.statusCode === 200 ? 0 : 1);})"'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    container.addPortMappings({
      containerPort: 9293,
      protocol: ecs.Protocol.TCP,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // Application Load Balancer
    // ═══════════════════════════════════════════════════════════════════════════

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      loadBalancerName: 'gptee-alb',
    });

    // Target Group with Sticky Sessions (required for WebSocket)
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc,
      port: 9293,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targetGroupName: 'gptee-tg',
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      stickinessCookieDuration: cdk.Duration.hours(24),
      stickinessCookieName: 'GPTEE_SESSION',
    });

    // Enable sticky sessions
    targetGroup.setAttribute('stickiness.enabled', 'true');
    targetGroup.setAttribute('stickiness.type', 'lb_cookie');

    // ═══════════════════════════════════════════════════════════════════════════
    // SSL Certificate & HTTPS Listener (optional)
    // ═══════════════════════════════════════════════════════════════════════════

    if (config.domainName && config.hostedZoneId && config.hostedZoneName) {
      // Import existing hosted zone
      const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: config.hostedZoneId,
        zoneName: config.hostedZoneName,
      });

      // Create SSL certificate
      const certificate = new acm.Certificate(this, 'Certificate', {
        domainName: config.domainName,
        validation: acm.CertificateValidation.fromDns(hostedZone),
      });

      // HTTPS Listener
      const httpsListener = alb.addListener('HttpsListener', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [certificate],
        defaultTargetGroups: [targetGroup],
      });

      // HTTP to HTTPS Redirect
      alb.addListener('HttpListener', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: 'HTTPS',
          port: '443',
          permanent: true,
        }),
      });

      // Route 53 A Record
      new route53.ARecord(this, 'AliasRecord', {
        zone: hostedZone,
        recordName: config.domainName,
        target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(alb)),
      });

      new cdk.CfnOutput(this, 'DomainUrl', {
        value: `https://${config.domainName}`,
        description: 'Application URL',
      });
    } else {
      // HTTP only (no domain configured)
      alb.addListener('HttpListener', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultTargetGroups: [targetGroup],
      });

      new cdk.CfnOutput(this, 'LoadBalancerUrl', {
        value: `http://${alb.loadBalancerDnsName}`,
        description: 'Load Balancer URL (HTTP only - configure domain for HTTPS)',
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ECS Fargate Service
    // ═══════════════════════════════════════════════════════════════════════════

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      serviceName: 'gptee-service',
      desiredCount: 0, // Start with 0 tasks (scale up after Docker image is pushed)
      securityGroups: [ecsSecurityGroup],
      assignPublicIp: false, // Use private subnets with NAT
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      healthCheckGracePeriod: cdk.Duration.seconds(60),
    });

    // Attach to target group
    service.attachToApplicationTargetGroup(targetGroup);

    // Auto-scaling
    const scaling = service.autoScaleTaskCount({
      minCapacity: config.ecsConfig.minCapacity,
      maxCapacity: config.ecsConfig.maxCapacity,
    });

    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: config.ecsConfig.targetCpuUtilization,
      scaleInCooldown: cdk.Duration.seconds(300),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // Outputs
    // ═══════════════════════════════════════════════════════════════════════════

    new cdk.CfnOutput(this, 'EcrRepositoryUri', {
      value: ecrRepository.repositoryUri,
      description: 'ECR Repository URI',
    });

    new cdk.CfnOutput(this, 'RedisEndpoint', {
      value: `${redisEndpoint}:${redisPort}`,
      description: 'Redis Endpoint',
    });

    new cdk.CfnOutput(this, 'SqsQueueUrl', {
      value: imageTasksQueue.queueUrl,
      description: 'SQS Queue URL',
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value: cluster.clusterName,
      description: 'ECS Cluster Name',
    });

    new cdk.CfnOutput(this, 'ServiceName', {
      value: service.serviceName,
      description: 'ECS Service Name',
    });
  }
}
