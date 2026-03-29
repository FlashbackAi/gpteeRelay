# GpteeRelay Backend

Production-ready WebSocket relay server for the GPTee mobile application with distributed architecture, auto-scaling, and event-driven task processing.

## Quick Start

### Local Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build TypeScript
npm run build

# Run production build
npm start
```

### Deploy to AWS (CDK)

```bash
# Navigate to infrastructure
cd infrastructure

# Install CDK dependencies
npm install

# Deploy entire stack
npx cdk deploy
```

See [`infrastructure/README.md`](infrastructure/README.md) for complete deployment instructions.

---

## Features

✅ **Distributed Architecture**
- Global provider/worker visibility across all instances
- Redis-backed shared state management
- Atomic task assignment with distributed locks

✅ **Event-Driven**
- S3 upload events trigger SQS notifications
- Instant task creation (no polling delay)
- Auto-scaling based on load

✅ **Production-Ready**
- HTTPS with free SSL certificates (ACM)
- Multi-AZ deployment for high availability
- Auto-healing ECS Fargate tasks
- CloudWatch logging and monitoring

✅ **WebSocket Support**
- Sticky sessions for connection persistence
- Automatic failover on provider disconnect
- P2P inference relay

✅ **Image Analysis**
- Distributed worker coordination
- Task distribution across mobile workers
- DynamoDB result tracking

---

## Architecture

```
Internet → Route 53 → ALB (HTTPS) → ECS Fargate (2-6 instances)
                                           ↓
                          Redis + DynamoDB + S3 + SQS
```

See [`docs/WIKI.md`](docs/WIKI.md) for complete technical documentation.

---

## Documentation

| File | Purpose |
|------|---------|
| [`docs/DEPLOYMENT_WORKFLOW.md`](docs/DEPLOYMENT_WORKFLOW.md) | **Complete deployment workflow guide (START HERE)** |
| [`docs/WIKI.md`](docs/WIKI.md) | Complete technical documentation |
| [`docs/DISTRIBUTED_ARCHITECTURE.md`](docs/DISTRIBUTED_ARCHITECTURE.md) | Distributed system implementation details |
| [`infrastructure/README.md`](infrastructure/README.md) | CDK-specific deployment reference |

---

## Technology Stack

- **Runtime:** Node.js 20 + TypeScript 5.3
- **Framework:** Express 5
- **WebSocket:** ws 8.16
- **State:** Redis (ElastiCache)
- **Queue:** SQS FIFO
- **Database:** DynamoDB
- **Storage:** S3
- **Deployment:** ECS Fargate + ALB
- **IaC:** AWS CDK 2.172

---

## Project Structure

```
gpteeRelay/
├── src/                         # Application code
│   ├── server.ts                # Main WebSocket server
│   ├── services/
│   │   ├── RedisService.ts      # Distributed state management
│   │   ├── SQSService.ts        # Event queue processing
│   │   ├── SQSTaskCreator.ts    # S3 event-driven tasks
│   │   ├── DynamoDBService.ts   # Database operations
│   │   └── S3Service.ts         # Image storage
│   ├── ImageAnalysisCoordinator.ts  # Worker coordination
│   ├── config/
│   │   ├── aws.ts               # AWS configuration
│   │   └── config.ts            # Environment config
│   └── utils/
│       └── logger.ts            # CloudWatch logging
│
├── infrastructure/              # AWS CDK infrastructure
│   ├── bin/
│   │   └── app.ts               # CDK app entry
│   ├── lib/
│   │   └── gptee-relay-stack.ts # Stack definition
│   └── README.md                # Deployment guide
│
├── aws/                         # Manual deployment configs
│   ├── ecs-task-definition.json # ECS task config
│   └── iam-task-role-policy.json # IAM permissions
│
├── docs/                        # Documentation
│   ├── DEPLOYMENT_WORKFLOW.md   # Deployment guide
│   ├── WIKI.md                  # Complete technical docs
│   └── DISTRIBUTED_ARCHITECTURE.md  # System design
│
├── Dockerfile                   # Container image
├── deploy-app.bat               # Quick deployment script (Windows)
├── deploy-app.sh                # Quick deployment script (Linux/Mac)
├── package.json                 # Dependencies
└── tsconfig.json                # TypeScript config
```

---

## Environment Variables

### Required

```bash
NODE_ENV=production
PORT=9293
AWS_REGION=us-east-1
REDIS_URL=redis://gptee-redis.xxxxx.cache.amazonaws.com:6379
SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/144273780915/gptee-image-tasks.fifo
```

### Optional

```bash
ECS_TASK_ID=${ECS_TASK_ID}  # Auto-set by ECS
```

---

## API Endpoints

### Health Check
```
GET /health
Response: { status: "healthy", uptime: 12345, peers: 42 }
```

### Authentication
```
POST /api/auth/solana/challenge-node    # Get challenge
POST /api/auth/solana/verify-node       # Verify signature
POST /api/auth/solana/check-node        # Check status
POST /api/auth/solana/create-node       # Create node
```

### Node Management
```
GET  /api/node/settings          # Get settings
PUT  /api/node/settings          # Update settings
GET  /api/stats                  # Get stats
GET  /api/stats/node             # Get node stats
PUT  /api/stats/node             # Update node stats
```

### WebSocket
```
WS  /                            # WebSocket connection
```

---

## Cost

**Estimated Monthly Cost:** ~$85-110 USD

| Service | Cost |
|---------|------|
| ECS Fargate (2-6 tasks) | $30-40 |
| Application Load Balancer | $16-25 |
| ElastiCache Redis (t4g.small) | $23 |
| SQS FIFO | $2-5 |
| Route 53 | $0.50 |
| CloudWatch Logs | $5 |
| ACM (SSL) | FREE |

---

## Deployment Options

### Option 1: CDK (Recommended)

**One-command deployment:**
```bash
cd infrastructure
npm install
npx cdk deploy
```

**Deploys:**
- VPC, subnets, NAT gateway
- ElastiCache Redis
- SQS FIFO queue
- ECS cluster + service
- Application Load Balancer
- Route 53 + ACM (if domain configured)

### Option 2: Manual

Follow step-by-step guide in [`DEPLOYMENT.md`](DEPLOYMENT.md)

---

## Testing

### Local Development
```bash
npm run dev
# Server runs on http://localhost:9293
```

### Docker Build
```bash
docker build -t gptee-relay:latest .
docker run -p 9293:9293 \
  -e NODE_ENV=production \
  -e REDIS_URL=redis://localhost:6379 \
  gptee-relay:latest
```

### Health Check
```bash
curl http://localhost:9293/health
# Should return: {"status":"healthy",...}
```

---

## Monitoring

### CloudWatch Logs
```bash
# Container logs
aws logs tail /ecs/gptee-relay --follow

# Application logs
aws logs tail GpteeRelay/ApplicationLogs --follow
```

### Metrics
```bash
# ECS metrics
aws cloudwatch get-metric-statistics \
  --namespace AWS/ECS \
  --metric-name CPUUtilization

# ALB metrics
aws cloudwatch get-metric-statistics \
  --namespace AWS/ApplicationELB \
  --metric-name TargetResponseTime
```

---

## Troubleshooting

### Issue: Container fails to start
```bash
# Check logs
aws logs tail /ecs/gptee-relay --follow

# Common causes:
# 1. Redis connection timeout → Check security groups
# 2. Missing environment variables → Check task definition
# 3. Image pull failed → Check ECR permissions
```

### Issue: High latency
```bash
# Check Redis latency
aws cloudwatch get-metric-statistics \
  --namespace AWS/ElastiCache \
  --metric-name NetworkBytesIn

# Check ALB metrics
aws cloudwatch get-metric-statistics \
  --namespace AWS/ApplicationELB \
  --metric-name TargetResponseTime
```

See [`WIKI.md#troubleshooting`](WIKI.md#troubleshooting) for comprehensive troubleshooting guide.

---

## Security

✅ **Network:** Private subnets, security groups, VPC isolation
✅ **Authentication:** Solana wallet signatures
✅ **Encryption:** TLS 1.3 in transit, DynamoDB at rest
✅ **IAM:** Least-privilege roles, no hardcoded credentials
✅ **Monitoring:** CloudWatch logs, audit trails

---

## Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

---

## License

Proprietary - All rights reserved

---

## Support

- **Deployment Guide:** See [`docs/DEPLOYMENT_WORKFLOW.md`](docs/DEPLOYMENT_WORKFLOW.md)
- **Technical Documentation:** See [`docs/WIKI.md`](docs/WIKI.md)
- **Architecture Details:** See [`docs/DISTRIBUTED_ARCHITECTURE.md`](docs/DISTRIBUTED_ARCHITECTURE.md)
- **CDK Reference:** See [`infrastructure/README.md`](infrastructure/README.md)
- **Issues:** Check CloudWatch logs first

---

## Version

**Current Version:** 1.0.0
**Last Updated:** 2026-03-29
**AWS Account:** 144273780915
**Region:** us-east-1

---

**Built with ❤️ using TypeScript, AWS CDK, and Redis**
