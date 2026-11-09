# Multi-stage production-ready Dockerfile for IncuBrix Distribution Network
FROM node:22-alpine AS base

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application source
COPY . .

# Ensure storage and data directories exist with write permissions
RUN mkdir -p data storage/uploads storage/certification storage/batches storage/assisted

EXPOSE 4000

ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0

# Run database migrations and start server
CMD ["node", "src/server.js"]
