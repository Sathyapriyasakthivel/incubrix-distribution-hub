import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../');

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),
  host: process.env.HOST || '0.0.0.0',
  appUrl: process.env.APP_URL || `http://localhost:${process.env.PORT || '4000'}`,
  logLevel: process.env.LOG_LEVEL || 'info',

  get dbPath() {
    return process.env.DB_PATH || path.join(projectRoot, 'data', 'incubrix.db');
  },
  get storageDir() {
    return process.env.STORAGE_DIR || path.join(projectRoot, 'storage');
  },

  security: {
    webhookSharedSecret: process.env.WEBHOOK_SHARED_SECRET || 'incubrix_webhook_dev_secret_xyz123',
    callbackSigningSecret: process.env.CALLBACK_SIGNING_SECRET || 'incubrix_callback_secret_abc789',
    adminApiKey: process.env.ADMIN_API_KEY || 'incubrix_admin_dev_token_2026'
  },

  limits: {
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '120', 10),
    defaultTimeoutMs: parseInt(process.env.DEFAULT_TIMEOUT_MS || '5000', 10),
    maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10)
  },

  simulation: {
    defaultEnabled: process.env.SIMULATION_DEFAULT !== 'false',
    mockUrls: {
      discourse: process.env.MOCK_DISCOURSE_URL || 'http://localhost:4200',
      lemmy: process.env.MOCK_LEMMY_URL || 'http://localhost:8536',
      devto: process.env.MOCK_DEVTO_URL || 'http://localhost:3001',
      ghost: process.env.MOCK_GHOST_URL || 'http://localhost:2368',
      webhook: process.env.MOCK_WEBHOOK_RECEIVER_URL || 'http://localhost:9001'
    }
  },

  ai: {
    provider: process.env.AI_ADAPTER_PROVIDER || 'mock',
    apiKey: process.env.AI_ADAPTER_API_KEY || ''
  },

  s3: {
    backend: process.env.STORAGE_BACKEND || 'local',
    endpointUrl: process.env.S3_ENDPOINT_URL || 'http://localhost:9000',
    accessKey: process.env.S3_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.S3_SECRET_KEY || 'minioadmin',
    bucket: process.env.S3_BUCKET || 'incubrix',
    publicBaseUrl: process.env.S3_PUBLIC_BASE_URL || null,
    region: process.env.S3_REGION || 'us-east-1'
  },

  get paths() {
    const storage = this.storageDir;
    return {
      root: projectRoot,
      data: process.env.DATA_DIR || path.join(projectRoot, 'data'),
      storage,
      uploads: path.join(storage, 'uploads'),
      certification: path.join(storage, 'certification'),
      batches: path.join(storage, 'batches')
    };
  }
};

export default config;
