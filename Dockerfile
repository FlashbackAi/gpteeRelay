# Multi-stage build for GpteeRelay Backend
# Stage 1: Build TypeScript application
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including devDependencies for TypeScript compilation)
RUN npm install

# Copy source code
COPY . .

# Build TypeScript to JavaScript
RUN npm run build

# Stage 2: Production image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm install --omit=dev

# Copy compiled JavaScript from builder stage
COPY --from=builder /app/dist ./dist

# Create logs directory
RUN mkdir -p logs

# Set NODE_ENV to production
ENV NODE_ENV=production

# Expose the application port
EXPOSE 9293

# Health check for container orchestration
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:9293/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1);})"

# Run the application
CMD ["node", "dist/server.js"]
