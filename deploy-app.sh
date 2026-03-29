#!/bin/bash
# GpteeRelay Application Deployment Script
# Use this for deploying code changes (not infrastructure changes)

set -e

ECR_URI="144273780915.dkr.ecr.us-east-1.amazonaws.com/gptee-relay"
CLUSTER="gptee-cluster"
SERVICE="gptee-service"
REGION="us-east-1"

echo "=========================================="
echo "GpteeRelay Application Deployment"
echo "=========================================="
echo ""

# Step 1: Build TypeScript
echo "📦 Building TypeScript..."
npm run build
echo "✅ Build complete"
echo ""

# Step 2: Build Docker image
echo "🐳 Building Docker image..."
docker build -t gptee-relay:latest .
echo "✅ Docker image built"
echo ""

# Step 3: Login to ECR
echo "🔐 Logging into ECR..."
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ECR_URI
echo "✅ ECR login successful"
echo ""

# Step 4: Tag and push
echo "📤 Pushing to ECR..."
docker tag gptee-relay:latest ${ECR_URI}:latest
docker push ${ECR_URI}:latest
echo "✅ Image pushed to ECR"
echo ""

# Step 5: Deploy to ECS
echo "🚀 Deploying to ECS..."
aws ecs update-service \
  --cluster $CLUSTER \
  --service $SERVICE \
  --force-new-deployment \
  --region $REGION > /dev/null
echo "✅ Deployment initiated"
echo ""

echo "=========================================="
echo "Deployment Summary"
echo "=========================================="
echo "Image: ${ECR_URI}:latest"
echo "Cluster: $CLUSTER"
echo "Service: $SERVICE"
echo ""
echo "Monitor deployment:"
echo "  aws ecs describe-services --cluster $CLUSTER --services $SERVICE --region $REGION"
echo ""
echo "View logs:"
echo "  aws logs tail /ecs/gptee-relay --follow --region $REGION"
echo ""
