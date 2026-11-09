import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initDatabase, setDatabase } from '../../src/database/db.js';
import { runMigrations } from '../../src/database/migrate.js';
import { CatalogueService } from '../../src/services/catalogue/catalogueService.js';
import jobQueue from '../../src/services/jobs/jobQueue.js';

describe('Safe Retries Across Timeout & Idempotent Re-queue', () => {
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
        process.env.MOCK_LEMMY_URL = `${mockBaseUrl}/lemmy`;
        process.env.MOCK_GHOST_URL = `${mockBaseUrl}/ghost`;
        process.env.MOCK_WEBHOOK_URL = `${mockBaseUrl}/webhook`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  const coreConnectors = [
    { key: 'discourse', name: 'Discourse Forum', searchPath: '/mock/discourse/search.json?q=' },
    { key: 'lemmy', name: 'Lemmy Community', searchPath: '/mock/lemmy/api/v3/search?q=' },
    { key: 'devto', name: 'Dev.to Blog', searchPath: '/mock/devto/api/articles/me/all' },
    { key: 'ghost', name: 'Ghost Publication', searchPath: '/mock/ghost/api/admin/posts/' },
    { key: 'webhook', name: 'Webhook Endpoint', searchPath: '/mock/webhook/events?marker=' }
  ];

  for (const conn of coreConnectors) {
    it(`timeout_after_commit results in exactly one post created for ${conn.key}`, async () => {
      // 1. Create certified destination pointing to mock server
      const dest = catalogue.createDestination({
        name: `Test Dest ${conn.key}`,
        url: `${mockBaseUrl}/${conn.key}`,
        platform_key: conn.key,
        connector_key: conn.key,
        status: 'certified',
        frequency_cap: '100/1d',
        self_promo_allowed: true,
        link_policy: 'allowed',
        disclosure_required: false,
        simulation_mode: true,
        is_enabled: true
      });

      // Save credentials with mockFault = timeout_after_commit
      db.run(
        `INSERT INTO auth_configs (id, destination_id, auth_type, credentials, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        `auth_${conn.key}_${Date.now()}`,
        dest.id,
        'bearer',
        JSON.stringify({
          api_key: 'test_key',
          token: 'test_token',
          mockFault: 'timeout_after_commit',
          community_id: 1,
          categoryId: 1
        }),
        new Date().toISOString()
      );

      const idemKey = `idem_${conn.key}_${Date.now()}`;
      const payload = {
        destination_id: dest.id,
        title: `Safe Retry Post for ${conn.key}`,
        body: `Testing timeout_after_commit recovery for ${conn.key}. Should not duplicate.`
      };

      // 2. Submit publication request with Idempotency-Key
      const res = await request(app)
        .post('/api/v1/publish')
        .set('Idempotency-Key', idemKey)
        .send(payload)
        .expect(202);

      expect(res.body.job_id).toBeDefined();
      const jobId = res.body.job_id;

      // 3. Wait for background job to finish processing
      let jobStatus = 'queued';
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const check = await request(app).get(`/api/v1/jobs/${jobId}`);
        jobStatus = check.body.status;
        if (jobStatus === 'succeeded' || jobStatus === 'failed') break;
      }

      expect(jobStatus).toBe('succeeded');

      // 4. Verify exactly one post exists on the mock platform
      const marker = `<!-- incubrix_marker:${idemKey} -->`;
      let postCount = 0;

      if (conn.key === 'discourse') {
        const checkRes = await request(app).get(`/mock/discourse/search.json?q=${encodeURIComponent(marker)}`);
        postCount = (checkRes.body.posts || []).filter(p => p.raw && p.raw.includes(idemKey)).length;
      } else if (conn.key === 'lemmy') {
        const checkRes = await request(app).get(`/mock/lemmy/api/v3/search?q=${encodeURIComponent(marker)}`);
        postCount = (checkRes.body.posts || []).filter(p => p.post && p.post.body && p.post.body.includes(idemKey)).length;
      } else if (conn.key === 'devto') {
        const checkRes = await request(app).get('/mock/devto/api/articles/me/all').set('api-key', 'test_key');
        postCount = (Array.isArray(checkRes.body) ? checkRes.body : []).filter(a => (a.body_markdown || '').includes(idemKey)).length;
      } else if (conn.key === 'ghost') {
        const checkRes = await request(app).get('/mock/ghost/api/admin/posts/').set('Authorization', 'Ghost test_token');
        postCount = (checkRes.body.posts || []).filter(p => (p.html || '').includes(idemKey)).length;
      } else if (conn.key === 'webhook') {
        const checkRes = await request(app).get(`/mock/webhook/events?marker=${encodeURIComponent(idemKey)}`);
        postCount = (Array.isArray(checkRes.body) ? checkRes.body : []).filter(e => e.idempotency_key === idemKey || JSON.stringify(e).includes(idemKey)).length;
      }

      expect(postCount).toBe(1);

      // Verify publish_attempts has state 'done'
      const attempt = db.get(
        'SELECT * FROM publish_attempts WHERE idempotency_key = ? AND connector_key = ?',
        idemKey, conn.key
      );
      expect(attempt).toBeDefined();
      expect(attempt.state).toBe('done');
    });
  }

  it('retrying the same Idempotency-Key with same body after a failed job re-queues the same job', async () => {
    // 1. Create destination that will fail
    const dest = catalogue.createDestination({
      name: 'Failing Destination',
      url: `${mockBaseUrl}/discourse`,
      platform_key: 'discourse_retry_test',
      connector_key: 'discourse',
      status: 'certified',
      frequency_cap: '100/1d',
      self_promo_allowed: true,
      link_policy: 'allowed',
      disclosure_required: false,
      simulation_mode: true,
      is_enabled: true
    });

    // Mock fault = auth_expired (401, non-retryable)
    db.run(
      `INSERT INTO auth_configs (id, destination_id, auth_type, credentials, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      `auth_fail_${Date.now()}`,
      dest.id,
      'bearer',
      JSON.stringify({
        api_key: 'test_key',
        mockFault: 'auth_expired'
      }),
      new Date().toISOString()
    );

    const failIdemKey = `fail_idem_${Date.now()}`;
    const payload = {
      destination_id: dest.id,
      title: 'Post Destined to Fail',
      body: 'Will fail on first attempt.'
    };

    // First request
    const firstRes = await request(app)
      .post('/api/v1/publish')
      .set('Idempotency-Key', failIdemKey)
      .send(payload)
      .expect(202);

    const firstJobId = firstRes.body.job_id;

    // Wait for failure
    let jobStatus = 'queued';
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const check = await request(app).get(`/api/v1/jobs/${firstJobId}`);
      jobStatus = check.body.status;
      if (jobStatus === 'failed') break;
    }
    expect(jobStatus).toBe('failed');

    // Fix the fault so the retry can succeed
    db.run(
      `UPDATE auth_configs SET credentials = ? WHERE destination_id = ?`,
      JSON.stringify({ api_key: 'test_key' }), // no fault
      dest.id
    );

    // Retry with SAME idempotency key and SAME body
    const retryRes = await request(app)
      .post('/api/v1/publish')
      .set('Idempotency-Key', failIdemKey)
      .send(payload)
      .expect(202);

    // Must return the SAME job_id, re-queued instead of replaying failure
    expect(retryRes.body.job_id).toBe(firstJobId);
    expect(retryRes.body.status).toBe('queued');

    // Wait for job to complete successfully now
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const check = await request(app).get(`/api/v1/jobs/${firstJobId}`);
      jobStatus = check.body.status;
      if (jobStatus === 'succeeded') break;
    }
    expect(jobStatus).toBe('succeeded');
  });
});
