import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initDatabase, setDatabase } from '../../src/database/db.js';
import { runMigrations } from '../../src/database/migrate.js';
import { CatalogueService } from '../../src/services/catalogue/catalogueService.js';
import resilienceService from '../../src/services/resilience/resilienceService.js';

describe('Header-Based Rate Limits & Circuit Breaker', () => {
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
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('reads reset time from Retry-After header, stores rate_limited_until, and reschedules jobs', async () => {
    // 1. Create a certified destination pointing to mock discourse
    const dest = catalogue.createDestination({
      name: 'Rate Limited Forum',
      url: `${mockBaseUrl}/discourse-rl`,
      platform_key: 'discourse_rl',
      connector_key: 'discourse',
      status: 'certified',
      frequency_cap: '100/1d',
      self_promo_allowed: true,
      link_policy: 'allowed',
      disclosure_required: false,
      simulation_mode: true,
      is_enabled: true
    });

    // Mock fault = rate_limit (returns HTTP 429 with Retry-After: 15)
    db.run(
      `INSERT INTO auth_configs (id, destination_id, auth_type, credentials, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      `auth_rl_${Date.now()}`,
      dest.id,
      'bearer',
      JSON.stringify({
        api_key: 'test_key',
        mockFault: 'rate_limit'
      }),
      new Date().toISOString()
    );

    const idemKey = `idem_rl_${Date.now()}`;
    const payload = {
      destination_id: dest.id,
      title: 'Rate Limit Test Post',
      body: 'Will hit 429 with Retry-After header.'
    };

    // First request: hits 429, job gets rescheduled to retry_at
    const res = await request(app)
      .post('/api/v1/publish')
      .set('Idempotency-Key', idemKey)
      .send(payload)
      .expect(202);

    const jobId = res.body.job_id;

    // Wait for job to process and encounter the rate limit
    let jobStatus = 'queued';
    let jobRecord = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const check = await request(app).get(`/api/v1/jobs/${jobId}`);
      jobStatus = check.body.status;
      jobRecord = check.body;
      if (jobRecord?.run_at && new Date(jobRecord.run_at) > new Date()) break;
    }

    expect(jobStatus).toBe('queued');
    expect(jobRecord.run_at).toBeDefined();

    // Verify rate_limited_until is stored in destinations table
    const storedDest = db.get('SELECT rate_limited_until FROM destinations WHERE id = ?', dest.id);
    expect(storedDest.rate_limited_until).toBeDefined();
    expect(new Date(storedDest.rate_limited_until).getTime()).toBeGreaterThan(Date.now());

    // Subsequent request to same destination inside rate limit window:
    // MUST NOT call the platform and must return status: queued with retry_at
    const subIdemKey = `idem_rl_sub_${Date.now()}`;
    const subRes = await request(app)
      .post('/api/v1/publish')
      .set('Idempotency-Key', subIdemKey)
      .send({
        destination_id: dest.id,
        title: 'Second Post Inside Window',
        body: 'Should be immediately queued to retry_at without calling platform.'
      });

    expect([200, 202]).toContain(subRes.status);
    expect(subRes.body.status).toBe('queued');
    expect(subRes.body.retry_at).toBe(storedDest.rate_limited_until);

    // Clear rate limits for clean subsequent tests
    resilienceService.clearRateLimits();
  });

  it('trips circuit breaker after 5 consecutive failures and blocks further calls with circuit_open: true', async () => {
    // 1. Create destination pointing to failing server
    const dest = catalogue.createDestination({
      name: 'Unstable Destination',
      url: `${mockBaseUrl}/discourse-unstable`,
      platform_key: 'discourse_unstable',
      connector_key: 'discourse',
      status: 'certified',
      frequency_cap: '100/1d',
      self_promo_allowed: true,
      link_policy: 'allowed',
      disclosure_required: false,
      simulation_mode: true,
      is_enabled: true
    });

    // Record 4 consecutive failures manually or through service
    for (let i = 0; i < 4; i++) {
      resilienceService.recordFailure(`dest:${dest.id}`);
    }
    expect(resilienceService.isCircuitOpen(dest.id, dest.connector_key)).toBe(false);

    // 5th failure trips the breaker
    const result5 = resilienceService.recordFailure(`dest:${dest.id}`);
    expect(result5.isOpen).toBe(true);
    expect(resilienceService.isCircuitOpen(dest.id, dest.connector_key)).toBe(true);

    // Any new publish request to this destination must immediately fail with 503 CIRCUIT_BREAKER_OPEN
    const res = await request(app)
      .post('/api/v1/publish')
      .set('Idempotency-Key', `cb_idem_${Date.now()}`)
      .send({
        destination_id: dest.id,
        title: 'Post to Tripped Destination',
        body: 'Should be rejected immediately by circuit breaker.'
      })
      .expect(503);

    expect(res.body.error.code).toBe('PLATFORM_CIRCUIT_OPEN');
    expect(res.body.error.details.circuit_open).toBe(true);

    // Reset circuit breaker
    resilienceService.resetCircuit(`dest:${dest.id}`);
    expect(resilienceService.isCircuitOpen(dest.id, dest.connector_key)).toBe(false);
  });

  it('maps HTTP 401, 403, and 410 to CONNECTION_AUTH_EXPIRED', async () => {
    const { DiscourseConnector } = await import('../../src/connectors/discourse/DiscourseConnector.js');
    const base = new DiscourseConnector();

    const err401 = base.mapError(401, { message: 'Token expired' });
    expect(err401.code).toBe('CONNECTION_AUTH_EXPIRED');
    expect(err401.retryable).toBe(false);

    const err403 = base.mapError(403, { message: 'Forbidden / revoked' });
    expect(err403.code).toBe('CONNECTION_AUTH_EXPIRED');
    expect(err403.retryable).toBe(false);

    const err410 = base.mapError(410, { message: 'Gone / app uninstalled' });
    expect(err410.code).toBe('CONNECTION_AUTH_EXPIRED');
    expect(err410.retryable).toBe(false);
  });
});
