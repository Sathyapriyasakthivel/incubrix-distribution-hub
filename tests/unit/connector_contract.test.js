import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import registry from '../../src/connectors/ConnectorRegistry.js';
import connectorContractRoutes from '../../src/routes/connectorContractRoutes.js';
import createMockPlatformApp from '../../src/connectors/mocks/MockPlatformServer.js';

describe('IncuBrix Connector Contract Tests', () => {
  let server;
  let mockApp;
  let testApp;
  let port;

  beforeAll(async () => {
    mockApp = createMockPlatformApp();
    testApp = express();
    testApp.use(express.json());
    testApp.use('/mock', mockApp);
    testApp.use('/connector/v1', connectorContractRoutes);

    await new Promise((resolve) => {
      server = testApp.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        process.env.MOCK_DISCOURSE_URL = `http://127.0.0.1:${port}/mock/discourse`;
        process.env.MOCK_DEVTO_URL = `http://127.0.0.1:${port}/mock/devto`;
        process.env.MOCK_LEMMY_URL = `http://127.0.0.1:${port}/mock/lemmy`;
        process.env.MOCK_GHOST_URL = `http://127.0.0.1:${port}/mock/ghost`;
        process.env.MOCK_WEBHOOK_RECEIVER_URL = `http://127.0.0.1:${port}/mock/webhook`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('Must register all six core connectors plus advanced connectors', () => {
    const connectors = registry.listConnectors();
    const keys = connectors.map(c => c.key);
    expect(keys).toContain('discourse');
    expect(keys).toContain('lemmy');
    expect(keys).toContain('devto');
    expect(keys).toContain('ghost');
    expect(keys).toContain('webhook');
    expect(keys).toContain('assisted');
  });

  it('Manifests conform to connector contract format', () => {
    const discourse = registry.getConnector('discourse');
    expect(discourse.manifest.key).toBe('discourse');
    expect(discourse.manifest.tier).toBe('native');
    expect(discourse.manifest.auth).toBe('api_key');
    expect(discourse.manifest.surfaces).toBeInstanceOf(Array);
    expect(discourse.manifest.error_map['429']).toBe('PLATFORM_RATE_LIMIT');
  });

  it('Discourse validate() detects short titles and bodies', async () => {
    const res = await request(testApp)
      .post('/connector/v1/discourse/validate')
      .send({
        rendition: { title: 'short', body: 'tiny' },
        destination: { simulation_mode: true },
        connection: {}
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.violations.length).toBeGreaterThanOrEqual(2);
  });

  it('Discourse publish() succeeds against mock', async () => {
    const res = await request(testApp)
      .post('/connector/v1/discourse/publish')
      .send({
        rendition: {
          title: 'Valid Long Title For Discourse Community',
          body: 'This is a sufficiently long body meeting the twenty character minimum length requirement.'
        },
        destination: { simulation_mode: true },
        connection: { apiKey: 'test_key', apiUsername: 'admin' }
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('platform_post_id');
    expect(res.body).toHaveProperty('live_url');
    expect(res.body.status).toBe('published');
  });

  it('Dev.to publish() and delete() work against mock', async () => {
    const publishRes = await request(testApp)
      .post('/connector/v1/devto/publish')
      .send({
        rendition: {
          title: 'A Great Developer Article',
          body: 'This is the complete article markdown body with more than 30 characters of rich tutorial content.'
        },
        destination: { simulation_mode: true },
        connection: { apiKey: 'devto_test_key' }
      });

    expect(publishRes.status).toBe(200);
    const postId = publishRes.body.platform_post_id;

    // Delete post
    const deleteRes = await request(testApp)
      .post('/connector/v1/devto/delete')
      .send({ platform_post_id: postId, connection: { apiKey: 'devto_test_key' } });

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.deleted).toBe(true);
  });

  it('Generic Webhook signs with HMAC-SHA256 and verifies successfully', async () => {
    const res = await request(testApp)
      .post('/connector/v1/webhook/publish')
      .send({
        rendition: {
          title: 'Webhook Event Title',
          body: 'Deterministic event payload to partner receiver'
        },
        destination: { id: 'dest_test_wh', simulation_mode: true },
        connection: { secret: 'incubrix_webhook_dev_secret_xyz123' }
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('published');
    expect(res.body).toHaveProperty('platform_post_id');
  });

  it('Assisted connector generates ready-to-post pack with files and checklist', async () => {
    const res = await request(testApp)
      .post('/connector/v1/assisted/build_assist_pack')
      .send({
        rendition: {
          title: 'Assisted Community Post',
          body: 'Content destined for human moderation'
        },
        destination: {
          id: 'dest_manual_1',
          name: 'Private Founder Circle',
          url: 'https://community.founders.example',
          self_promo_allowed: 0,
          disclosure_required: 1
        }
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('pack_id');
    expect(res.body).toHaveProperty('checklist');
    expect(res.body.checklist.length).toBeGreaterThan(0);
    expect(res.body.files.length).toBe(2);
  });

  it('Enforces kill switch and returns CONNECTOR_DISABLED error', async () => {
    registry.disable('lemmy');

    const res = await request(testApp)
      .post('/connector/v1/lemmy/publish')
      .send({
        rendition: { title: 'Test Lemmy', body: 'Some body text' },
        destination: {},
        connection: {}
      });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CONNECTOR_DISABLED');
    expect(res.body.error.retryable).toBe(false);

    // Re-enable
    registry.enable('lemmy');
  });

  it('Lemmy publish(), get_status(), delete(), and fetch_metrics() work via contract endpoint', async () => {
    // 1. Publish
    const pubRes = await request(testApp)
      .post('/connector/v1/lemmy/publish')
      .send({
        rendition: { title: 'Lemmy Contract Post', body: 'This is a valid body for a Lemmy community post.' },
        destination: { simulation_mode: true },
        connection: { token: 'lemmy_jwt_token' }
      });

    expect(pubRes.status).toBe(200);
    expect(pubRes.body).toHaveProperty('platform_post_id');
    const postId = pubRes.body.platform_post_id;

    // 2. get_status
    const statusRes = await request(testApp)
      .post('/connector/v1/lemmy/get_status')
      .send({ platform_post_id: postId, connection: { token: 'lemmy_jwt_token' } });

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe('published');

    // 3. fetch_metrics
    const metricsRes = await request(testApp)
      .post('/connector/v1/lemmy/fetch_metrics')
      .send({ platform_post_id: postId, connection: { token: 'lemmy_jwt_token' } });

    expect(metricsRes.status).toBe(200);
    expect(metricsRes.body).toHaveProperty('views');
    expect(metricsRes.body).toHaveProperty('likes');

    // 4. delete
    const delRes = await request(testApp)
      .post('/connector/v1/lemmy/delete')
      .send({ platform_post_id: postId, connection: { token: 'lemmy_jwt_token' } });

    expect(delRes.status).toBe(200);
    expect(delRes.body.deleted).toBe(true);
  });

  it('Ghost publish(), get_status(), delete(), and fetch_metrics() work via contract endpoint', async () => {
    // 1. Publish
    const pubRes = await request(testApp)
      .post('/connector/v1/ghost/publish')
      .send({
        rendition: { title: 'Ghost Publication Title', body: 'Valid content body for Ghost blog publication.' },
        destination: { simulation_mode: true },
        connection: { token: 'ghost_token' }
      });

    expect(pubRes.status).toBe(200);
    expect(pubRes.body).toHaveProperty('platform_post_id');
    const postId = pubRes.body.platform_post_id;

    // 2. get_status
    const statusRes = await request(testApp)
      .post('/connector/v1/ghost/get_status')
      .send({ platform_post_id: postId, connection: { token: 'ghost_token' } });

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe('published');

    // 3. fetch_metrics
    const metricsRes = await request(testApp)
      .post('/connector/v1/ghost/fetch_metrics')
      .send({ platform_post_id: postId, connection: { token: 'ghost_token' } });

    expect(metricsRes.status).toBe(200);
    expect(metricsRes.body).toHaveProperty('views');

    // 4. delete
    const delRes = await request(testApp)
      .post('/connector/v1/ghost/delete')
      .send({ platform_post_id: postId, connection: { token: 'ghost_token' } });

    expect(delRes.status).toBe(200);
    expect(delRes.body.deleted).toBe(true);
  });

  it('Webhook get_status and delete work via contract endpoint', async () => {
    // 1. Publish
    const pubRes = await request(testApp)
      .post('/connector/v1/webhook/publish')
      .send({
        rendition: { title: 'WH Event', body: 'Payload' },
        destination: { id: 'dest_wh_1', simulation_mode: true },
        connection: { secret: 'incubrix_webhook_dev_secret_xyz123' }
      });

    expect(pubRes.status).toBe(200);
    const eventId = pubRes.body.platform_post_id;

    // 2. get_status
    const statusRes = await request(testApp)
      .post('/connector/v1/webhook/get_status')
      .send({ platform_post_id: eventId });

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe('published');

    // 3. delete
    const delRes = await request(testApp)
      .post('/connector/v1/webhook/delete')
      .send({ platform_post_id: eventId });

    expect(delRes.status).toBe(200);
    expect(delRes.body.deleted).toBe(true);
  });

  it('refresh_auth contract endpoint returns expires_at structure', async () => {
    const res = await request(testApp)
      .post('/connector/v1/discourse/refresh_auth')
      .send({ connection: { apiKey: 'key' } });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('expires_at');
  });

  it('Field rename fault triggers PLATFORM_SCHEMA_MISMATCH across connectors', async () => {
    // 1. Discourse with renamed field fault
    const discRes = await request(testApp)
      .post('/connector/v1/discourse/publish')
      .send({
        rendition: { title: 'Discourse Valid Title Longer Than 15', body: 'Sufficently long body for Discourse minimum' },
        destination: { simulation_mode: true },
        connection: { apiKey: 'test_key', mockFault: 'field_rename' }
      });
    expect(discRes.status).toBe(500);
    expect(discRes.body.error.code).toBe('PLATFORM_SCHEMA_MISMATCH');

    // 2. Dev.to with renamed field fault
    const devtoRes = await request(testApp)
      .post('/connector/v1/devto/publish')
      .send({
        rendition: { title: 'Dev.to Title', body: 'Dev.to article body content over 30 chars' },
        destination: { simulation_mode: true },
        connection: { apiKey: 'key', mockFault: 'field_rename' }
      });
    expect(devtoRes.status).toBe(500);
    expect(devtoRes.body.error.code).toBe('PLATFORM_SCHEMA_MISMATCH');

    // 3. Lemmy with renamed field fault
    const lemmyRes = await request(testApp)
      .post('/connector/v1/lemmy/publish')
      .send({
        rendition: { title: 'Lemmy Title', body: 'Lemmy body text' },
        destination: { simulation_mode: true },
        connection: { token: 'token', mockFault: 'field_rename' }
      });
    expect(lemmyRes.status).toBe(500);
    expect(lemmyRes.body.error.code).toBe('PLATFORM_SCHEMA_MISMATCH');

    // 4. Ghost with renamed field fault
    const ghostRes = await request(testApp)
      .post('/connector/v1/ghost/publish')
      .send({
        rendition: { title: 'Ghost Title', body: 'Ghost post body' },
        destination: { simulation_mode: true },
        connection: { token: 'token', mockFault: 'field_rename' }
      });
    expect(ghostRes.status).toBe(500);
    expect(ghostRes.body.error.code).toBe('PLATFORM_SCHEMA_MISMATCH');
  });

  it('Manifest validation throws when required fields or error maps are missing', () => {
    const discourse = registry.getConnector('discourse');
    expect(() => discourse.validateManifest({}, 'dummy.yaml')).toThrow(/missing required field/);
    expect(() => discourse.validateManifest({
      key: 'test', version: '1.0.0', tier: 'native', auth: 'api_key',
      surfaces: [], rate_limits: {}, capabilities: [], instance_param: 'url',
      error_map: { '429': 'PLATFORM_RATE_LIMIT' } // missing 401, 403, 422, 4xx, 5xx
    }, 'dummy.yaml')).toThrow(/error_map missing/);
  });

  it('GhostConnector and LemmyConnector resolveUrl consistently translate localhost to container URLs', () => {
    const ghost = registry.getConnector('ghost');
    const lemmy = registry.getConnector('lemmy');

    const origGhostEnv = process.env.GHOST_LOCAL_URL;
    const origLemmyEnv = process.env.LEMMY_LOCAL_URL;
    try {
      process.env.GHOST_LOCAL_URL = 'http://ghost:2368';
      process.env.LEMMY_LOCAL_URL = 'http://lemmy:8536';

      // Ghost resolves localhost:2368 and container hostnames
      expect(ghost.resolveUrl({ url: 'http://localhost:2368' }, {})).toBe('http://ghost:2368');
      expect(ghost.resolveUrl({}, { base_url: 'http://localhost:2368' })).toBe('http://ghost:2368');
      expect(ghost.resolveUrl({}, { base_url: 'http://127.0.0.1:2368' })).toBe('http://ghost:2368');
      expect(ghost.resolveUrl({ url: 'http://ghost:2368' }, {})).toBe('http://ghost:2368');

      // Lemmy resolves localhost:8536 and container hostnames
      expect(lemmy.resolveUrl({ url: 'http://localhost:8536' }, {})).toBe('http://lemmy:8536');
      expect(lemmy.resolveUrl({}, { base_url: 'http://localhost:8536' })).toBe('http://lemmy:8536');
      expect(lemmy.resolveUrl({}, { base_url: 'http://127.0.0.1:8536' })).toBe('http://lemmy:8536');
      expect(lemmy.resolveUrl({ url: 'http://lemmy:8536' }, {})).toBe('http://lemmy:8536');
    } finally {
      if (origGhostEnv) process.env.GHOST_LOCAL_URL = origGhostEnv; else delete process.env.GHOST_LOCAL_URL;
      if (origLemmyEnv) process.env.LEMMY_LOCAL_URL = origLemmyEnv; else delete process.env.LEMMY_LOCAL_URL;
    }
  });
});
