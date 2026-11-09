import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { getDatabase } from '../../src/database/db.js';
import { seedDatabase } from '../../src/database/seed.js';

describe('Idempotency on Every POST Middleware Integration Tests', () => {
  let app;
  let server;
  let db;

  beforeAll(async () => {
    db = getDatabase();
    await seedDatabase(db);
    app = createApp();

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('Rejects POST request missing Idempotency-Key header with 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
    const res = await request(app)
      .post('/api/v1/destinations')
      .send({
        name: 'No Idem Header Forum',
        url: 'https://community.no-idem.example',
        platform_key: 'discourse'
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('Accepts POST with new Idempotency-Key and replays identical response with Idempotent-Replayed header on retry', async () => {
    const idemKey = `idem_test_${Date.now()}`;
    const payload = {
      name: 'Idempotent Creation Forum',
      url: `https://community.idem-${Date.now()}.example`,
      platform_key: 'discourse',
      category: 'AI Founders'
    };

    // First call: creates destination
    const res1 = await request(app)
      .post('/api/v1/destinations')
      .set('Idempotency-Key', idemKey)
      .send(payload);

    expect(res1.status).toBe(201);
    expect(res1.body.id).toBeDefined();
    expect(res1.headers['idempotent-replayed']).toBeUndefined();
    const createdId = res1.body.id;

    // Second call: exact same key and payload
    const res2 = await request(app)
      .post('/api/v1/destinations')
      .set('Idempotency-Key', idemKey)
      .send(payload);

    expect(res2.status).toBe(201);
    expect(res2.headers['idempotent-replayed']).toBe('true');
    expect(res2.body.id).toBe(createdId);
  });

  it('Returns 409 IDEMPOTENCY_CONFLICT when same key is used with different payload', async () => {
    const idemKey = `idem_conflict_${Date.now()}`;
    const payloadA = {
      name: 'Forum A',
      url: `https://community.a-${Date.now()}.example`,
      platform_key: 'discourse'
    };
    const payloadB = {
      name: 'Forum B - Changed',
      url: `https://community.b-${Date.now()}.example`,
      platform_key: 'discourse'
    };

    const res1 = await request(app)
      .post('/api/v1/destinations')
      .set('Idempotency-Key', idemKey)
      .send(payloadA);
    expect(res1.status).toBe(201);

    const res2 = await request(app)
      .post('/api/v1/destinations')
      .set('Idempotency-Key', idemKey)
      .send(payloadB);

    expect(res2.status).toBe(409);
    expect(res2.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});
