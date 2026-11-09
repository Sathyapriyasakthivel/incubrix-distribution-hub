import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initDatabase, setDatabase } from '../../src/database/db.js';
import { runMigrations } from '../../src/database/migrate.js';
import { CatalogueService } from '../../src/services/catalogue/catalogueService.js';
import simulationService from '../../src/services/simulation/simulationService.js';

describe('Simulation Faults Injection', () => {
  let app;
  let server;
  let db;
  let catalogue;
  let mockPort;
  let mockBaseUrl;

  beforeAll(async () => {
    db = initDatabase(':memory:');
    runMigrations(db);
    setDatabase(db);
    catalogue = new CatalogueService(db);

    app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        mockPort = server.address().port;
        mockBaseUrl = `http://127.0.0.1:${mockPort}/mock`;
        process.env.MOCK_DISCOURSE_URL = `${mockBaseUrl}/discourse`;
        process.env.MOCK_DEVTO_URL = `${mockBaseUrl}/devto`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    simulationService.resetFaults();
    delete process.env.API_ACCESS_TOKEN;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('injects all supported faults via POST /api/v1/sim/inject', async () => {
    const supportedFaults = [
      { fault: '429', reset_s: 30 },
      { fault: '401' },
      { fault: '422' },
      { fault: '500' },
      { fault: 'timeout_before_commit' },
      { fault: 'timeout_after_commit' },
      { fault: 'rename_field' },
      { fault: 'revoke' }
    ];

    for (const item of supportedFaults) {
      const res = await request(app)
        .post('/api/v1/sim/inject')
        .send({
          fault: item.fault,
          reset_s: item.reset_s,
          platform: 'discourse'
        })
        .expect(200);

      expect(res.body.status).toBe('injected');
      expect(res.body.active_fault).toBeDefined();
    }
  });

  it('injected 429 fault causes mock platform to return HTTP 429 with custom reset_s', async () => {
    // 1. Inject 429 with reset_s: 42
    await request(app)
      .post('/api/v1/sim/inject')
      .send({ fault: '429', reset_s: 42, platform: 'discourse' })
      .expect(200);

    // 2. Direct HTTP call to mock discourse
    const mockRes = await request(app)
      .post('/mock/discourse/posts.json')
      .set('Api-Key', 'test_key')
      .send({ title: 'Test', raw: 'Body' })
      .expect(429);

    expect(mockRes.headers['retry-after']).toBe('42');
    expect(mockRes.body.retry_after).toBe(42);

    // 3. Reset faults
    await request(app).post('/api/v1/sim/reset').expect(200);

    // Call should now succeed
    const passRes = await request(app)
      .post('/mock/discourse/posts.json')
      .set('Api-Key', 'test_key')
      .send({ title: 'Post After Reset', raw: 'Body' })
      .expect(200);

    expect(passRes.body.id).toBeDefined();
  });

  it('injected rename_field causes mock response to break contract', async () => {
    await request(app)
      .post('/api/v1/sim/inject')
      .send({ fault: 'rename_field', platform: 'discourse' })
      .expect(200);

    const mockRes = await request(app)
      .post('/mock/discourse/posts.json')
      .set('Api-Key', 'test_key')
      .send({ title: 'Corrupted Post', raw: 'Body' })
      .expect(200);

    expect(mockRes.body.id).toBeUndefined();
    expect(mockRes.body.unexpected_identifier_key).toBeDefined();

    await request(app).post('/api/v1/sim/reset').expect(200);
  });

  it('enforces API_ACCESS_TOKEN when configured in environment', async () => {
    process.env.API_ACCESS_TOKEN = 'secret_reviewer_demo_token_123';

    // Call without token -> 401
    const unauthRes = await request(app)
      .post('/api/v1/sim/inject')
      .send({ fault: '500' })
      .expect(401);

    expect(unauthRes.body.error.code).toBe('UNAUTHORIZED');

    // Call with correct token in header -> 200
    const authRes = await request(app)
      .post('/api/v1/sim/inject')
      .set('Authorization', 'Bearer secret_reviewer_demo_token_123')
      .send({ fault: '500' })
      .expect(200);

    expect(authRes.body.status).toBe('injected');

    // Reset with auth
    await request(app)
      .post('/api/v1/sim/reset')
      .set('Authorization', 'Bearer secret_reviewer_demo_token_123')
      .expect(200);

    delete process.env.API_ACCESS_TOKEN;
  });
});
