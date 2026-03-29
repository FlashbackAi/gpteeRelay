```bash
cd E:\Data\Projects\gpteeRelay
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

Create a `.env` file in the relay server root (optional for local dev):

```env
# Local Development Configuration
PORT=9293
NODE_ENV=development

# Redis (optional - uses in-memory fallback if not configured)
# REDIS_HOST=localhost
# REDIS_PORT=6379

# Database (optional - uses mock data if not configured)
# DATABASE_URL=postgresql://user:password@localhost:5432/gptee

# AWS (optional - only needed for image worker features)
# AWS_REGION=us-east-1
# S3_BUCKET_NAME=gptee-images
# DYNAMODB_TABLE_NAME=gptee-tasks
# SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789/gptee-queue
```

### 4. Build TypeScript

```bash
npm run build
```

### 5. Start Development Server

```bash
npm run dev
```

You should see:
```
✅  GPTee Relay Server running on http/ws://0.0.0.0:9293
    Instance ID: <instance-id>
    Peers connected: 0
```

The server is now running at:
- **HTTP API**: `http://localhost:9293/api`
- **WebSocket**: `ws://localhost:9293`
- **Health Check**: `http://localhost:9293/health`

---