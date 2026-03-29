# GpteeRelay CDK Infrastructure

AWS CDK infrastructure-as-code for deploying GpteeRelay backend to production.

## What This Deploys

- ✅ **VPC** with public/private subnets across 2 AZs
- ✅ **ElastiCache Redis** (cache.t4g.small) for distributed state
- ✅ **SQS FIFO Queue** for event-driven task creation
- ✅ **Application Load Balancer** with sticky sessions
- ✅ **ECS Fargate** cluster with auto-scaling (2-6 tasks)
- ✅ **ECR Repository** for Docker images
- ✅ **IAM Roles** with least-privilege permissions
- ✅ **CloudWatch Log Groups** for monitoring
- ✅ **Route 53 + ACM** (optional) for custom domain + SSL
- ✅ **S3 Event Notifications** to SQS

## Prerequisites

1. **AWS CLI** configured with credentials
   ```bash
   aws configure
   ```

2. **Node.js 18+** installed
   ```bash
   node --version  # Should be 18 or higher
   ```

3. **Docker** installed and running
   ```bash
   docker --version
   ```

4. **Existing AWS Resources** (already created):
   - S3 bucket: `gptee-image-analysis`
   - DynamoDB tables (7 tables)

## Quick Start

### Step 1: Install Dependencies

```bash
cd infrastructure
npm install
```

### Step 2: Configure Settings

Edit `bin/app.ts` and update the configuration:

```typescript
const config = {
  account: '144273780915',      // Your AWS account ID
  region: 'us-east-1',           // Your AWS region

  // Optional: Domain configuration (leave empty for HTTP-only deployment)
  domainName: '',                // e.g., 'api.yourdomain.com'
  hostedZoneId: '',              // e.g., 'Z1234567890ABC'
  hostedZoneName: '',            // e.g., 'yourdomain.com'

  // ... rest of config
};
```

**Note:** If you don't have a domain yet, leave `domainName`, `hostedZoneId`, and `hostedZoneName` empty. You can add it later.

### Step 3: Bootstrap CDK (First Time Only)

```bash
npx cdk bootstrap aws://144273780915/us-east-1
```

This creates the necessary S3 bucket and IAM roles for CDK deployments.

### Step 4: Preview Changes

```bash
npx cdk diff
```

This shows what resources will be created **before** deploying.

### Step 5: Deploy Infrastructure

```bash
npx cdk deploy
```

This will:
1. Show you a summary of changes
2. Ask for confirmation
3. Create all resources (~10-15 minutes)
4. Output important values (Redis endpoint, SQS URL, etc.)

**Save the outputs!** You'll need them for the next step.

---

## Step 6: Build & Push Docker Image

After infrastructure is deployed:

```bash
# Navigate to main project
cd ..

# Install dependencies
npm install

# Build TypeScript
npm run build

# Get ECR repository URI from CDK outputs
ECR_URI=$(aws cloudformation describe-stacks \
  --stack-name GpteeRelayStack \
  --query 'Stacks[0].Outputs[?OutputKey==`EcrRepositoryUri`].OutputValue' \
  --output text)

echo $ECR_URI

# Login to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin $ECR_URI

# Build Docker image
docker build -t gptee-relay:latest .

# Tag image
docker tag gptee-relay:latest ${ECR_URI}:latest

# Push to ECR
docker push ${ECR_URI}:latest
```

---

## Step 7: Deploy ECS Service

The ECS service will automatically pull the image and start tasks:

```bash
# Force new deployment to pick up the image
aws ecs update-service \
  --cluster gptee-cluster \
  --service gptee-service \
  --force-new-deployment
```

---

## Step 8: Verify Deployment

```bash
# Check ECS service status
aws ecs describe-services \
  --cluster gptee-cluster \
  --services gptee-service

# Check task status
aws ecs list-tasks \
  --cluster gptee-cluster \
  --service-name gptee-service

# Check logs
aws logs tail /ecs/gptee-relay --follow

# Test health endpoint
ALB_URL=$(aws cloudformation describe-stacks \
  --stack-name GpteeRelayStack \
  --query 'Stacks[0].Outputs[?OutputKey==`LoadBalancerUrl`].OutputValue' \
  --output text)

curl ${ALB_URL}/health
```

---

## Adding Custom Domain (Optional)

If you skipped domain configuration initially, you can add it later:

### Step 1: Create Route 53 Hosted Zone

```bash
aws route53 create-hosted-zone \
  --name yourdomain.com \
  --caller-reference $(date +%s)
```

**Note the Hosted Zone ID and Nameservers**

### Step 2: Update GoDaddy Nameservers

1. Login to GoDaddy
2. Go to your domain settings
3. Change nameservers to Route 53 nameservers (from Step 1)

### Step 3: Update CDK Configuration

Edit `bin/app.ts`:

```typescript
domainName: 'api.yourdomain.com',
hostedZoneId: 'Z1234567890ABC',      // From Step 1
hostedZoneName: 'yourdomain.com',
```

### Step 4: Redeploy

```bash
npx cdk deploy
```

CDK will:
- Request SSL certificate from ACM
- Add DNS validation records
- Create HTTPS listener on ALB
- Create Route 53 A record

**Wait 5-30 minutes for certificate validation.**

---

## Useful Commands

### CDK Commands

```bash
npx cdk diff            # Preview changes
npx cdk deploy          # Deploy stack
npx cdk destroy         # Delete all resources
npx cdk synth           # Generate CloudFormation template
npx cdk ls              # List stacks
```

### ECS Commands

```bash
# View service events
aws ecs describe-services --cluster gptee-cluster --services gptee-service

# Scale service
aws ecs update-service \
  --cluster gptee-cluster \
  --service gptee-service \
  --desired-count 4

# Force new deployment
aws ecs update-service \
  --cluster gptee-cluster \
  --service gptee-service \
  --force-new-deployment

# View running tasks
aws ecs list-tasks --cluster gptee-cluster --service-name gptee-service
```

### Logs Commands

```bash
# Tail ECS logs
aws logs tail /ecs/gptee-relay --follow

# Tail application logs
aws logs tail GpteeRelay/ApplicationLogs --follow

# Filter logs
aws logs filter-pattern "ERROR" --log-group-name /ecs/gptee-relay
```

### Redis Commands

```bash
# Get Redis endpoint
aws cloudformation describe-stacks \
  --stack-name GpteeRelayStack \
  --query 'Stacks[0].Outputs[?OutputKey==`RedisEndpoint`].OutputValue' \
  --output text

# Connect to Redis (from bastion host or ECS task)
redis-cli -h gptee-redis.XXXXXX.ng.0001.use1.cache.amazonaws.com
```

### SQS Commands

```bash
# Check queue depth
aws sqs get-queue-attributes \
  --queue-url $(aws cloudformation describe-stacks \
    --stack-name GpteeRelayStack \
    --query 'Stacks[0].Outputs[?OutputKey==`SqsQueueUrl`].OutputValue' \
    --output text) \
  --attribute-names ApproximateNumberOfMessages
```

---

## Cost Breakdown

| Resource | Configuration | Monthly Cost |
|----------|--------------|--------------|
| **ECS Fargate** | 2-6 tasks × 0.5 vCPU × 1 GB | $30-40 |
| **ALB** | Internet-facing | $16-25 |
| **NAT Gateway** | 1 gateway | $32 |
| **ElastiCache** | cache.t4g.small | $23 |
| **SQS** | FIFO, ~1M requests | $2-5 |
| **Route 53** | 1 hosted zone | $0.50 |
| **ACM** | SSL certificate | FREE |
| **CloudWatch** | Logs (10 GB) | $5 |
| **TOTAL** | | **~$110-135/month** |

**Note:** DynamoDB and S3 costs are variable based on usage.

---

## Troubleshooting

### Issue: CDK deploy fails with "No VPC found"

**Solution:** Ensure your AWS account has default VPC or create one:
```bash
aws ec2 create-default-vpc
```

### Issue: ECS tasks fail health checks

**Solution:** Check logs:
```bash
aws logs tail /ecs/gptee-relay --follow
```

Common causes:
- Redis not accessible (check security groups)
- Environment variables incorrect
- Application not binding to 0.0.0.0:9293

### Issue: "Unable to pull image"

**Solution:** Ensure image is pushed to ECR:
```bash
aws ecr describe-images --repository-name gptee-relay
```

### Issue: Certificate validation stuck

**Solution:** Check Route 53 nameservers match GoDaddy:
```bash
aws route53 get-hosted-zone --id Z1234567890ABC
```

Verify CNAME records exist:
```bash
aws route53 list-resource-record-sets --hosted-zone-id Z1234567890ABC
```

---

## Cleanup

To delete all resources:

```bash
npx cdk destroy
```

**Warning:** This will delete:
- VPC and all networking
- ElastiCache Redis (data loss!)
- SQS queue (messages lost!)
- ECS cluster and tasks
- ALB and target groups
- CloudWatch log groups (logs lost!)

**NOT deleted** (must delete manually if needed):
- S3 buckets
- DynamoDB tables
- ECR repository (has RETAIN policy)

---

## Security Best Practices

✅ **Implemented:**
- ECS tasks in private subnets
- Security groups with least privilege
- IAM roles (no hardcoded credentials)
- VPC endpoints for AWS services (optional)
- SSL/TLS encryption in transit

❌ **TODO (Production Hardening):**
- Enable VPC Flow Logs
- Add AWS WAF to ALB
- Enable ECS Exec auditing
- Implement secrets management (AWS Secrets Manager)
- Add CloudWatch alarms

---

## Next Steps

1. ✅ Deploy infrastructure: `npx cdk deploy`
2. ✅ Build and push Docker image
3. ✅ Verify deployment
4. 🔲 Configure custom domain (optional)
5. 🔲 Set up CloudWatch alarms
6. 🔲 Configure auto-scaling policies
7. 🔲 Update mobile app with new endpoint
8. 🔲 Load test and tune performance

---

## Support

For issues or questions:
1. Check CloudWatch logs first
2. Review `DEPLOYMENT.md` in parent directory
3. Check AWS CloudFormation events
4. Verify security group rules

**CDK Documentation:** https://docs.aws.amazon.com/cdk/
