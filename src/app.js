import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import config from './config/index.js';
import correlationMiddleware from './middleware/correlation.js';
import rateLimiterMiddleware from './middleware/rateLimiter.js';
import errorHandler from './middleware/errorHandler.js';
import idempotencyMiddleware from './middleware/idempotency.js';
import { IncuBrixError, ERROR_CODES } from './utils/errors.js';

import healthRoutes from './routes/healthRoutes.js';
import connectorContractRoutes from './routes/connectorContractRoutes.js';
import destinationRoutes from './routes/destinationRoutes.js';
import publishRoutes from './routes/publishRoutes.js';
import jobRoutes from './routes/jobRoutes.js';
import certificationRoutes from './routes/certificationRoutes.js';
import connectorRoutes from './routes/connectorRoutes.js';
import assistedRoutes from './routes/assistedRoutes.js';
import storageRoutes from './routes/storageRoutes.js';
import auditRoutes from './routes/auditRoutes.js';
import simulationRoutes from './routes/simulationRoutes.js';
import feedRoutes from './routes/feedRoutes.js';
import alertRoutes from './routes/alertRoutes.js';

import createMockPlatformApp from './connectors/mocks/MockPlatformServer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../');

export function createApp() {
  const app = express();

  // Basic middleware
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(correlationMiddleware);
  app.use(rateLimiterMiddleware);

  // Serve static UI assets
  app.use(express.static(path.join(projectRoot, 'public')));

  // Mount local mock platform server for deterministic simulation mode
  const mockServer = createMockPlatformApp({ port: config.port });
  app.use('/mock', mockServer);

  // Health and readiness probes
  app.use('/', healthRoutes);

  // Connector contract endpoint
  app.use('/connector/v1', connectorContractRoutes);

  // Mount universal idempotency middleware for all /api/v1 routes
  app.use('/api/v1', idempotencyMiddleware);

  // API v1 endpoints
  app.use('/api/v1/destinations', destinationRoutes);
  app.use('/api/v1/publish', publishRoutes);
  app.use('/api/v1/jobs', jobRoutes);
  app.use('/api/v1/certification', certificationRoutes);
  app.use('/api/v1/connectors', connectorRoutes);
  app.use('/api/v1/assisted', assistedRoutes);
  app.use('/api/v1/storage', storageRoutes);
  app.use('/api/v1/audit', auditRoutes);
  app.use('/api/v1/sim', simulationRoutes);
  app.use('/api/v1/alerts', alertRoutes);

  // MRSS Video Feed endpoint
  app.use('/feeds', feedRoutes);

  // Catch-all 404 handler for unmatched routes (returns standard JSON)
  app.use((req, res, next) => {
    const err = new IncuBrixError(
      ERROR_CODES.NOT_FOUND,
      `Endpoint not found: ${req.method} ${req.originalUrl || req.url}`,
      { path: req.originalUrl || req.url, method: req.method },
      404,
      false
    );
    next(err);
  });

  // Central error handler
  app.use(errorHandler);

  return app;
}

export default createApp;
