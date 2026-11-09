import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import express from 'express';
import request from 'supertest';
import { StorageService } from '../../src/services/storage/storageService.js';
import { LlmRulesCaptureProvider } from '../../src/services/ai/rulesCaptureAdapter.js';
import connectorContractRoutes from '../../src/routes/connectorContractRoutes.js';
import createMockPlatformApp from '../../src/connectors/mocks/MockPlatformServer.js';

describe('P2 Standard Conformance: Storage S3 Backend, LLM Recorded Fixture & fetch_metrics', () => {
  let mockServer;
  let mockServerPort;
  let mockServerUrl;
  let contractApp;

  beforeAll(async () => {
    // Setup mock server for LLM fixture and platform mocks
    const mockPlatformApp = createMockPlatformApp();
    contractApp = express();
    contractApp.use(express.json());
    contractApp.use('/mock', mockPlatformApp);
    contractApp.use('/connector/v1', connectorContractRoutes);

    await new Promise((resolve) => {
      mockServer = http.createServer((req, res) => {
        // Recorded LLM fixture for gpt-4o-mini
        if (req.url === '/v1/chat/completions') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          const recordedFixture = {
            id: 'chatcmpl-record-incubrix-rules-01',
            object: 'chat.completion',
            created: 1729000000,
            model: 'gpt-4o-mini',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    frequency_cap: '1/7d',
                    self_promo_allowed: 0,
                    link_policy: 'restricted',
                    disclosure_required: 1,
                    automation_allowed: 1,
                    quotes: {
                      frequency_cap: 'Members may submit no more than 1 post per 7 days.',
                      self_promo_allowed: 'Strictly zero self-promotion is permitted.',
                      link_policy: 'Affiliate links are strictly forbidden.',
                      disclosure_required: 'All AI-generated content must explicitly disclose its automated nature.',
                      automation_allowed: 'API access and automated posting are permitted under developer token.'
                    },
                    confidence: 0.94
                  })
                },
                finish_reason: 'stop'
              }
            ],
            usage: {
              prompt_tokens: 420,
              completion_tokens: 110,
              total_tokens: 530
            }
          };
          res.end(JSON.stringify(recordedFixture));
        } else {
          mockPlatformApp(req, res);
        }
      });

      mockServer.listen(0, '127.0.0.1', () => {
        mockServerPort = mockServer.address().port;
        mockServerUrl = `http://127.0.0.1:${mockServerPort}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (mockServer) {
      await new Promise(r => mockServer.close(r));
    }
  });

  describe('StorageService Backend', () => {
    it('Saves and reads files through storage service with local mirror fallback', async () => {
      const storage = new StorageService();
      const testContent = JSON.stringify({ test: 'storage_content', timestamp: Date.now() });
      const filename = `test_file_${Date.now()}.json`;

      const savedPath = await storage.saveFile('reports', filename, testContent, 'application/json');
      expect(savedPath).toBeDefined();

      const exists = storage.hasFile('reports', filename);
      expect(exists).toBe(true);

      const retrieved = await storage.getFile('reports', filename);
      expect(retrieved.toString('utf8')).toBe(testContent);
    });

    it('Tests S3/MinIO backend when available, or marks Not verified if MinIO is unavailable', async () => {
      const minioUrl = process.env.S3_ENDPOINT_URL || 'http://localhost:9000';
      let isMinioLive = false;
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 1000);
        const resp = await fetch(`${minioUrl}/minio/health/live`, { signal: controller.signal });
        clearTimeout(t);
        isMinioLive = resp.ok;
      } catch {
        isMinioLive = false;
      }

      const storage = new StorageService();

      if (!isMinioLive) {
        console.log(`[Honesty Declaration] MinIO S3 backend at ${minioUrl} is unavailable: Not verified`);
        expect(storage).toBeDefined();
        expect(storage.backend).toBeDefined();
        return;
      }

      // MinIO is running live: test real S3 upload and read
      storage.backend = 's3';
      const testContent = Buffer.from(`MinIO verified content ${Date.now()}`);
      const filename = `s3_test_${Date.now()}.bin`;
      const saved = await storage.saveFile('certification', filename, testContent);

      expect(saved.s3Key).toBe(`certification/${filename}`);
      expect(storage.hasFile('certification', filename)).toBe(true);
    });
  });

  describe('LLM Rules Capture Provider with Recorded Fixture', () => {
    it('Extracts structured community guidelines rules using recorded LLM fixture', async () => {
      const provider = new LlmRulesCaptureProvider({
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: 'sk-mock-recorded-test-key-incubrix',
        endpoint: `${mockServerUrl}/v1/chat/completions`
      });

      const sampleGuidelines = `
Community Posting Rules:
1. Members may submit no more than 1 post per 7 days.
2. Strictly zero self-promotion is permitted.
3. Affiliate links are strictly forbidden.
4. All AI-generated content must explicitly disclose its automated nature.
5. API access and automated posting are permitted under developer token.
`;

      const result = await provider.parseContent(sampleGuidelines);

      expect(result).toBeDefined();
      expect(result.frequency_cap).toBe('1/7d');
      expect(result.self_promo_allowed).toBe(0);
      expect(result.link_policy).toBe('restricted');
      expect(result.disclosure_required).toBe(1);
      expect(result.automation_allowed).toBe(1);
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
      expect(result.quotes.frequency_cap).toContain('1 post per 7 days');
      expect(result.cost_usd).toBeGreaterThan(0);
      expect(result.provider).toBe('openai');
      expect(result.model).toBe('gpt-4o-mini');
    });
  });

  describe('fetch_metrics Contract Endpoint Reachability', () => {
    it('Reaches fetch_metrics through POST /connector/v1/{key}/fetch_metrics for core connectors', async () => {
      // 1. Discourse fetch_metrics
      const discourseRes = await request(contractApp)
        .post('/connector/v1/discourse/fetch_metrics')
        .send({
          platform_post_id: 'post_12345',
          destination: { simulation_mode: true },
          connection: { apiKey: 'test_key' }
        });

      expect(discourseRes.status).toBe(200);
      expect(discourseRes.body).toHaveProperty('views');
      expect(discourseRes.body).toHaveProperty('likes');
      expect(discourseRes.body).toHaveProperty('comments');
      expect(discourseRes.body).toHaveProperty('shares');
      expect(discourseRes.body).toHaveProperty('saves');
      expect(discourseRes.body).toHaveProperty('watch_time_s');
      expect(discourseRes.body).toHaveProperty('clicks');

      // 2. Lemmy fetch_metrics
      const lemmyRes = await request(contractApp)
        .post('/connector/v1/lemmy/fetch_metrics')
        .send({
          platform_post_id: 'post_5555',
          destination: { simulation_mode: true },
          connection: { jwt: 'test_jwt' }
        });

      expect(lemmyRes.status).toBe(200);
      expect(lemmyRes.body).toHaveProperty('views');
      expect(lemmyRes.body).toHaveProperty('likes');
      expect(lemmyRes.body).toHaveProperty('comments');

      // 3. Dev.to fetch_metrics
      const devtoRes = await request(contractApp)
        .post('/connector/v1/devto/fetch_metrics')
        .send({
          platform_post_id: 'article_9988',
          destination: { simulation_mode: true },
          connection: { apiKey: 'test_key' }
        });

      expect(devtoRes.status).toBe(200);
      expect(devtoRes.body).toHaveProperty('views');
      expect(devtoRes.body).toHaveProperty('likes');

      // 4. Ghost fetch_metrics
      const ghostRes = await request(contractApp)
        .post('/connector/v1/ghost/fetch_metrics')
        .send({
          platform_post_id: 'ghost_post_777',
          destination: { simulation_mode: true },
          connection: { token: 'test_token' }
        });

      expect(ghostRes.status).toBe(200);
      expect(ghostRes.body).toHaveProperty('views');
    });

    it('Rejects fetch_metrics with 400 when platform_post_id is missing', async () => {
      const res = await request(contractApp)
        .post('/connector/v1/discourse/fetch_metrics')
        .send({
          destination: { simulation_mode: true }
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('Returns 404 when connector key is unknown', async () => {
      const res = await request(contractApp)
        .post('/connector/v1/non_existent_platform/fetch_metrics')
        .send({
          platform_post_id: 'id_123'
        });

      expect(res.status).toBe(404);
    });
  });
});
