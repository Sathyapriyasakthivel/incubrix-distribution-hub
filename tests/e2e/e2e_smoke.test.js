import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { getDatabase } from '../../src/database/db.js';
import { runMigrations } from '../../src/database/migrate.js';
import { seedDatabase } from '../../src/database/seed.js';

describe('End-to-End Smoke Test Suite', () => {
  let app;
  let server;
  let db;
  let createdDestId;
  let testJobId;
  const sharedIdemKey = `e2e_idem_${Date.now()}`;

  beforeAll(async () => {
    db = getDatabase();
    runMigrations(db);
    await seedDatabase(db);
    app = createApp();

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
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

  // 1. Create a destination (Configuration, not code!)
  it('Point 1: Creates a new destination through the catalogue API', async () => {
    const testUrl = `https://community.e2e-verified-${Date.now()}.example`;
    const res = await request(app)
      .post('/api/v1/destinations')
      .set('Idempotency-Key', `e2e_create_dest_${Date.now()}`)
      .send({
        name: 'E2E Verified Community Forum',
        url: testUrl,
        platform_key: 'discourse',
        connector_key: 'discourse',
        surface: 'topic',
        category: 'AI Video Founders',
        frequency_cap: '1/7d',
        self_promo_allowed: false,
        link_policy: 'allowed',
        disclosure_required: true,
        simulation_mode: true
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe('E2E Verified Community Forum');
    createdDestId = res.body.id;
  });

  // 2. Run connector certification and inspect evidence (must certify before publishing)
  it('Point 2: Runs connector certification and confirms stored evidence', async () => {
    const certRes = await request(app)
      .post(`/api/v1/certification/run/${createdDestId}`)
      .set('Idempotency-Key', `e2e_cert_run_${Date.now()}`)
      .send({});

    expect(certRes.status).toBe(200);
    expect(certRes.body.status).toBe('certified');
    expect(certRes.body.is_cleaned_up).toBe(true);
    expect(certRes.body.evidence_url).toBeDefined();
  });

  // 3. Evaluate its rules before publishing
  it('Point 3: Evaluates rules server-side before publishing attempt', async () => {
    const evalRes = await request(app)
      .post('/api/v1/publish/rules/evaluate')
      .send({
        destination_id: createdDestId,
        title: 'Compliant Discussion on Automated Video Connectors',
        body: '[AI Disclosure: Supported with AI] Detailed analysis of long-tail network distribution.',
        canonical_url: 'https://incubrix.internal/e2e',
        is_ai_generated: true,
        is_promotional: false
      });

    expect(evalRes.status).toBe(200);
    expect(evalRes.body.decision).toBe('ALLOW');
  });

  // 4. Publish successfully in simulation mode
  it('Point 4: Publishes successfully in simulation mode returning 202 Accepted', async () => {
    const pubRes = await request(app)
      .post('/api/v1/publish')
      .set('Idempotency-Key', sharedIdemKey)
      .send({
        destination_id: createdDestId,
        title: 'Compliant Discussion on Automated Video Connectors',
        body: '[AI Disclosure: Supported with AI] Detailed analysis of long-tail network distribution.',
        canonical_url: 'https://incubrix.internal/e2e',
        is_ai_generated: true,
        is_promotional: false,
        simulation: true
      });

    expect(pubRes.status).toBe(202);
    expect(pubRes.body.job_id).toBeDefined();
    testJobId = pubRes.body.job_id;
  });

  // 5. Retrieve the resulting status
  it('Point 5: Polls and retrieves resulting job status and output manifest', async () => {
    let job = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 200));
      const res = await request(app).get(`/api/v1/jobs/${testJobId}`);
      expect(res.status).toBe(200);
      job = res.body;
      if (job.status === 'succeeded') break;
    }

    expect(job.status).toBe('succeeded');
    expect(job.progress).toBe(100);
    expect(job.live_url).toBeDefined();
    expect(job.manifest).toBeDefined();
  });

  // 8. Attempt a forbidden post and confirm it is blocked
  it('Point 8: Attempts forbidden post (banned self-promo) and confirms server-side block', async () => {
    const blockRes = await request(app)
      .post('/api/v1/publish')
      .set('Idempotency-Key', `e2e_block_test_${Date.now()}`)
      .send({
        destination_id: createdDestId,
        title: 'Promotional Pitch to Non-Commercial Community',
        body: 'Check out our commercial SaaS pricing plans!',
        is_promotional: true, // Destination has self_promo_allowed = false
        simulation: true
      });

    expect(blockRes.status).toBe(422);
    expect(blockRes.body.error.code).toBe('DEST_RULE_SELF_PROMO');
    expect(blockRes.body.error.retryable).toBe(false);
  });

  // 9. Retry a request with the same idempotency key and confirm no duplicate is created
  it('Point 9: Retries request with same Idempotency-Key and confirms safe duplicate prevention', async () => {
    const retryRes = await request(app)
      .post('/api/v1/publish')
      .set('Idempotency-Key', sharedIdemKey)
      .send({
        destination_id: createdDestId,
        title: 'Compliant Discussion on Automated Video Connectors',
        body: '[AI Disclosure: Supported with AI] Detailed analysis of long-tail network distribution.',
        canonical_url: 'https://incubrix.internal/e2e',
        is_ai_generated: true,
        is_promotional: false,
        simulation: true
      });

    expect(retryRes.status).toBe(200);
    expect(retryRes.body.is_replay).toBe(true);
    expect(retryRes.body.job_id).toBe(testJobId);
  });

  // 10. Trigger a simulated connector failure and show a meaningful error
  it('Point 10: Triggers simulated platform fault and returns standardized error shape', async () => {
    const faultDest = db.get("SELECT id FROM destinations WHERE id = 'dest_9abc3454-f5f4-4870-b031-86859f0f2d02'")
      || db.get("SELECT id FROM destinations WHERE simulation_mode = 1 AND platform_key = 'ghost' LIMIT 1")
      || db.get("SELECT id FROM destinations WHERE simulation_mode = 1 LIMIT 1");

    // Force auth expiration failure during certification
    const faultRes = await request(app)
      .post(`/api/v1/certification/run/${faultDest.id}`)
      .set('Idempotency-Key', `e2e_fault_test_${Date.now()}`)
      .send({ fault_injection: 'auth_expired' });

    expect(faultRes.status).toBe(200);
    expect(faultRes.body.status).toBe('failed');
    expect(faultRes.body.error).toBeDefined();
    expect(faultRes.body.error.code).toBe('CONNECTION_AUTH_EXPIRED');
  });
});
