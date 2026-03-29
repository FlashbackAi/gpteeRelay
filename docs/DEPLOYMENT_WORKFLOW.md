# GpteeRelay Deployment Workflow

Complete guide for deploying infrastructure and application updates.

---

## Table of Contents

1. [Initial Deployment (First Time)](#initial-deployment-first-time)
2. [Code Changes Only](#code-changes-only)
3. [Infrastructure Changes](#infrastructure-changes)
4. [Adding New Services](#adding-new-services)
5. [Post-Deployment: Adding SSL/Domain](#post-deployment-adding-ssldomain)

---

## Initial Deployment (First Time)

### Prerequisites

- AWS CLI configured with credentials
- Node.js 18+ installed
- Docker installed and running
- AWS Account: 144273780915
- Region: us-east-1

### Step 1: Bootstrap CDK (One-Time Only)

```bash
cd E:\Data\Projects\gpteeRelay\infrastructure
npx cdk bootstrap aws://144273780915/us-east-1
```

### Step 2: Deploy Infrastructure

```bash
# From infrastructure directory
npx cdk deploy
```

**Expected Duration:** 10-15 minutes

**What Gets Created:**
- VPC with public/private subnets
- ElastiCache Redis (cache.t4g.small)
- SQS Standard Queue
- ECS Cluster (with 0 running tasks initially)
- Application Load Balancer
- Security Groups & IAM Roles
- CloudWatch Log Groups

**Important Outputs to Save:**
```
EcrRepositoryUri: 144273780915.dkr.ecr.us-east-1.amazonaws.com/gptee-relay
RedisEndpoint: gptee-redis.XXXXXX.ng.0001.use1.cache.amazonaws.com:6379
SqsQueueUrl: https://sqs.us-east-1.amazonaws.com/144273780915/gptee-image-tasks
LoadBalancerUrl: GpteeRelayStack-Alb-XXXXXXXXXX.us-east-1.elb.amazonaws.com
```

### Step 3: Build and Push Docker Image

```bash
# Navigate to project root
cd E:\Data\Projects\gpteeRelay

# Install dependencies
npm install

# Build TypeScript
npm run build

# Login to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 144273780915.dkr.ecr.us-east-1.amazonaws.com

# Build Docker image
docker build -t gptee-relay:latest .

# Tag for ECR
docker tag gptee-relay:latest 144273780915.dkr.ecr.us-east-1.amazonaws.com/gptee-relay:latest

# Push to ECR
docker push 144273780915.dkr.ecr.us-east-1.amazonaws.com/gptee-relay:latest
```

**Expected Duration:** 5-10 minutes (depending on internet speed)

### Step 4: Scale Up ECS Service

```bash
# Start 2 tasks (minimum capacity)
aws ecs update-service \
  --cluster gptee-cluster \
  --service gptee-service \
  --desired-count 2
```

**Expected Duration:** 2-3 minutes for tasks to become healthy

### Step 5: Verify Deployment

```bash
# Check service status
aws ecs describe-services \
  --cluster gptee-cluster \
  --services gptee-service \
  --query 'services[0].{runningCount:runningCount,desiredCount:desiredCount,status:status}'

# Check task health
aws ecs list-tasks \
  --cluster gptee-cluster \
  --service-name gptee-service

# Test health endpoint
ALB_URL=$(aws cloudformation describe-stacks \
  --stack-name GpteeRelayStack \
  --query 'Stacks[0].Outputs[?OutputKey==`LoadBalancerUrl`].OutputValue' \
  --output text)

curl http://${ALB_URL}/health
```

**Expected Response:**
```json
{
  "status": "healthy",
  "uptime": 12345,
  "peers": 0
}
```

### Step 6: Monitor Logs

```bash
# Tail ECS logs
aws logs tail /ecs/gptee-relay --follow

# Tail application logs
aws logs tail GpteeRelay/ApplicationLogs --follow
```

---

## Code Changes Only

When you modify application code (TypeScript files in `src/`):

### Quick Workflow

```bash
# 1. Navigate to project root
cd E:\Data\Projects\gpteeRelay

# 2. Build TypeScript
npm run build

# 3. Build Docker image
docker build -t gptee-relay:latest .

# 4. Login to ECR (if session expired)
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 144273780915.dkr.ecr.us-east-1.amazonaws.com

# 5. Tag and push
docker tag gptee-relay:latest 144273780915.dkr.ecr.us-east-1.amazonaws.com/gptee-relay:latest
docker push 144273780915.dkr.ecr.us-east-1.amazonaws.com/gptee-relay:latest

# 6. Force ECS to deploy new image (zero-downtime rolling update)
aws ecs update-service \
  --cluster gptee-cluster \
  --service gptee-service \
  --force-new-deployment

# 7. Monitor deployment
aws ecs describe-services \
  --cluster gptee-cluster \
  --services gptee-service \
  --query 'services[0].deployments'
```

**Expected Duration:** 5-10 minutes total
- Build & push: 3-5 minutes
- ECS rolling update: 2-5 minutes

### Automated Script (Optional)

Create `deploy-app.sh`:

```bash
#!/bin/bash
set -e

echo "Building TypeScript..."
npm run build

echo "Building Docker image..."
docker build -t gptee-relay:latest .

echo "Logging into ECR..."
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 144273780915.dkr.ecr.us-east-1.amazonaws.com

echo "Pushing to ECR..."
docker tag gptee-relay:latest 144273780915.dkr.ecr.us-east-1.amazonaws.com/gptee-relay:latest
docker push 144273780915.dkr.ecr.us-east-1.amazonaws.com/gptee-relay:latest

echo "Deploying to ECS..."
aws ecs update-service \
  --cluster gptee-cluster \
  --service gptee-service \
  --force-new-deployment

echo "✅ Deployment initiated. Check status:"
echo "aws ecs describe-services --cluster gptee-cluster --services gptee-service"
```

**Usage:**
```bash
chmod +x deploy-app.sh
./deploy-app.sh
```

---

## Infrastructure Changes

When you modify infrastructure code (`infrastructure/lib/gptee-relay-stack.ts`):

### Examples of Infrastructure Changes:
- Changing ECS CPU/memory
- Adding new security groups
- Modifying Redis configuration
- Adding new environment variables
- Changing auto-scaling settings

### Workflow

```bash
# 1. Navigate to infrastructure directory
cd E:\Data\Projects\gpteeRelay\infrastructure

# 2. Preview changes (IMPORTANT!)
npx cdk diff

# Review the output carefully:
# - [+] means resource will be created
# - [-] means resource will be deleted
# - [~] means resource will be modified

# 3. Deploy infrastructure changes
npx cdk deploy

# 4. If ECS task definition changed, force redeploy
aws ecs update-service \
  --cluster gptee-cluster \
  --service gptee-service \
  --force-new-deployment
```

**Expected Duration:** 5-30 minutes (depending on changes)

### Safe vs Risky Changes

**Safe Changes (No Downtime):**
- Adding new environment variables
- Scaling limits (minCapacity, maxCapacity)
- Auto-scaling thresholds
- Log retention settings
- Adding new IAM permissions

**Risky Changes (Potential Downtime/Replacement):**
- VPC/subnet modifications
- Security group changes (test carefully)
- Redis instance type (causes replacement)
- Load balancer changes

**Always run `npx cdk diff` first!**

---

## Adding New Services

When adding new AWS services (e.g., DynamoDB table, Lambda function, SNS topic):

### Step 1: Update CDK Stack

Edit `infrastructure/lib/gptee-relay-stack.ts`:

```typescript
// Example: Adding a new DynamoDB table
const newTable = new dynamodb.Table(this, 'NewTable', {
  tableName: 'new-table-name',
  partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  removalPolicy: cdk.RemovalPolicy.RETAIN,
});
```

### Step 2: Add IAM Permissions

```typescript
// In TaskRole permissions section
taskRole.addToPolicy(new iam.PolicyStatement({
  actions: [
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:Query',
  ],
  resources: [newTable.tableArn],
}));
```

### Step 3: Add Environment Variables (if needed)

```typescript
// In task definition environment section
environment: {
  NEW_TABLE_NAME: newTable.tableName,
},
```

### Step 4: Update Application Code

Create service file in `src/services/`:

```typescript
// src/services/NewService.ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { awsConfig } from '../config/aws';

export class NewService {
  private client: DynamoDBClient;

  constructor() {
    this.client = new DynamoDBClient({ region: awsConfig.region });
  }

  // Your methods here
}
```

### Step 5: Deploy Infrastructure First

```bash
cd E:\Data\Projects\gpteeRelay\infrastructure
npx cdk diff  # Review changes
npx cdk deploy
```

### Step 6: Deploy Application Code

```bash
cd E:\Data\Projects\gpteeRelay
npm run build
docker build -t gptee-relay:latest .
docker tag gptee-relay:latest 144273780915.dkr.ecr.us-east-1.amazonaws.com/gptee-relay:latest
docker push 144273780915.dkr.ecr.us-east-1.amazonaws.com/gptee-relay:latest
aws ecs update-service --cluster gptee-cluster --service gptee-service --force-new-deployment
```

---

## Post-Deployment: Adding SSL/Domain

After initial deployment, add custom domain and HTTPS.

### Step 1: Create Route 53 Hosted Zone

```bash
# Create hosted zone
aws route53 create-hosted-zone \
  --name gptee.ai \
  --caller-reference $(date +%s)

# Note the Hosted Zone ID and Nameservers from output
```

**Example Output:**
```json
{
  "HostedZone": {
    "Id": "/hostedzone/Z1234567890ABC",
    "Name": "gptee.ai"
  },
  "DelegationSet": {
    "NameServers": [
      "ns-123.awsdns-12.com",
      "ns-456.awsdns-34.net",
      "ns-789.awsdns-56.org",
      "ns-012.awsdns-78.co.uk"
    ]
  }
}
```

### Step 2: Update GoDaddy Nameservers

1. Login to GoDaddy
2. Go to your domain `gptee.ai` settings
3. Click "Manage DNS"
4. Scroll to "Nameservers" section
5. Click "Change"
6. Select "Custom Nameservers"
7. Enter all 4 nameservers from Route 53 output above
8. Save changes

**Note:** DNS propagation can take 24-48 hours, but usually completes in 1-2 hours.

### Step 3: Update CDK Configuration

Edit `infrastructure/bin/app.ts`:

```typescript
const config = {
  account: '144273780915',
  region: 'us-east-1',

  // Add these values:
  domainName: 'api.gptee.ai',
  hostedZoneId: 'Z1234567890ABC', // From Step 1
  hostedZoneName: 'gptee.ai',

  // ... rest of config
};
```

### Step 4: Redeploy Infrastructure

```bash
cd E:\Data\Projects\gpteeRelay\infrastructure
npx cdk diff  # Review changes
npx cdk deploy
```

**What Gets Created:**
- ACM SSL Certificate (free)
- DNS validation records (automatic)
- HTTPS listener on ALB (port 443)
- Route 53 A record pointing to ALB

**Expected Duration:**
- Deployment: 5-10 minutes
- Certificate validation: 5-30 minutes (automatic)

### Step 5: Verify SSL Certificate

```bash
# Check certificate status
aws acm list-certificates --region us-east-1

# Once validated, test HTTPS endpoint
curl https://api.gptee.ai/health
```

### Step 6: Update Mobile App

Update your mobile app configuration to use:
- **WebSocket:** `wss://api.gptee.ai` (instead of `ws://`)
- **HTTP API:** `https://api.gptee.ai` (instead of `http://`)

---

## Troubleshooting

### Issue: Docker build fails

```bash
# Clear Docker cache
docker system prune -a
docker build --no-cache -t gptee-relay:latest .
```

### Issue: ECR login fails

```bash
# Re-authenticate
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 144273780915.dkr.ecr.us-east-1.amazonaws.com
```

### Issue: ECS tasks fail health checks

```bash
# Check logs
aws logs tail /ecs/gptee-relay --follow

# Common causes:
# 1. Redis connection failed - check security groups
# 2. Environment variables missing - check task definition
# 3. Application crash on startup - check application logs
```

### Issue: CDK deployment stuck

```bash
# Cancel deployment
Ctrl+C

# Destroy partial stack
npx cdk destroy

# Retry deployment
npx cdk deploy
```

### Issue: Certificate validation stuck

```bash
# Check DNS records exist
aws route53 list-resource-record-sets \
  --hosted-zone-id Z1234567890ABC \
  | grep CNAME

# Check certificate status
aws acm describe-certificate \
  --certificate-arn <ARN from cdk output>
```

---

## Cost Monitoring

```bash
# Check current month's estimated costs
aws ce get-cost-and-usage \
  --time-period Start=$(date -d '1 month ago' +%Y-%m-01),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics BlendedCost

# Set up billing alerts (recommended)
# Go to AWS Console → Billing → Billing Preferences → Enable "Receive Billing Alerts"
```

**Expected Monthly Cost:** ~$110-135 USD

---

## Quick Reference Commands

### Check Service Status
```bash
aws ecs describe-services --cluster gptee-cluster --services gptee-service
```

### View Logs
```bash
aws logs tail /ecs/gptee-relay --follow
```

### Scale Service
```bash
aws ecs update-service --cluster gptee-cluster --service gptee-service --desired-count 4
```

### Rollback to Previous Image
```bash
# List images
aws ecr describe-images --repository-name gptee-relay --query 'sort_by(imageDetails,& imagePushedAt)[-5:]'

# Update task definition to use specific tag, then force deployment
```

### Delete Everything
```bash
cd E:\Data\Projects\gpteeRelay\infrastructure
npx cdk destroy
# Note: S3, DynamoDB, and ECR (with RETAIN policy) must be deleted manually
```

---

## Version History

- **v1.0.0** (2026-03-29): Initial deployment guide
- **Infrastructure:** AWS CDK 2.172
- **Runtime:** Node.js 20, TypeScript 5.3
- **AWS Account:** 144273780915
- **Region:** us-east-1

---

**For detailed technical documentation, see:** [`WIKI.md`](WIKI.md)
**For CDK-specific details, see:** [`infrastructure/README.md`](infrastructure/README.md)
