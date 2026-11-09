import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initDatabase, setDatabase } from '../../src/database/db.js';
import { runMigrations } from '../../src/database/migrate.js';
import { CatalogueService } from '../../src/services/catalogue/catalogueService.js';

describe('Publishing Lifecycle Integration Tests', () => {
  let app;
  let server;
  let db;
  let testDestId;
  let strictDestId;

  beforeAll(async () => {
    // Use isolated in-memory database to avoid shared state / frequency cap pollution
    db = initDatabase(':memory:');
    runMigrations(db);
    setDatabase(db);

    // Seed a clean discourse destination that allows posting
    const catalogue = new CatalogueService(db);
    const dest = catalogue.createDestination({
      name: 'Integration Test Discourse Forum',
      url: 'https://integration-test-discourse.example',
      platform_key: 'discourse',
      connector_key: 'discourse',
      status: 'certified',
      frequency_cap: '100/1d', // high cap so tests won't hit it
      self_promo_allowed: true,
      link_policy: 'allowed',
      disclosure_required: false,
      simulation_mode: true,
      is_enabled: true
    });
    testDestId = dest.id;

    // Seed a strict destination that bans self-promotion
    const strictDest = catalogue.createDestination({
      name: 'Strict No Promo Forum',
      url: 'https://strict-no-promo.example',
      platform_key: 'discourse',
      connector_key: 'discourse',
      status: 'certified',
      frequency_cap: '100/1d',
      self_promo_allowed: false,
      link_policy: 'allowed',
      disclosure_required: false,
      simulation_mode: true,
      is_enabled: true
    });
    strictDestId = strictDest.id;

    // Seed an uncertified destination and a demoted destination
    const uncertDest = catalogue.createDestination({
      name: 'Uncertified Integration Forum',
      url: 'https://uncert-forum.example',
      platform_key: 'discourse',
      connector_key: 'discourse',
      status: 'catalogued',
      is_enabled: true
    });

    const demotedDest = catalogue.createDestination({
      name: 'Demoted Integration Forum',
      url: 'https://demoted-forum.example',
      platform_key: 'discourse',
      connector_key: 'discourse',
      status: 'demoted',
      is_enabled: true
    });

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

  it('POST /api/v1/publish returns 202 Accepted with job_id and poll succeeds', async () => {
    const idemKey = `test_idem_${Date.now()}`;
    const res = await request(app)
      .post('/api/v1/publish')
      .set('Idempotency-Key', idemKey)
      .send({
        destination_id: testDestId,
        title: 'Integration Test Publication Topic',
        body: 'This is an integration test publication body that exceeds twenty characters easily.',
        canonical_url: 'https://incubrix.internal/test',
        simulation: true
      });

    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty('job_id');
    expect(res.body.status).toBe('queued');

    const jobId = res.body.job_id;

    // Wait for background job execution to finish
    let job = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 200));
      const pollRes = await request(app).get(`/api/v1/jobs/${jobId}`);
      expect(pollRes.status).toBe(200);
      job = pollRes.body;
      if (job.status === 'succeeded' || job.status === 'failed') break;
    }

    expect(job.status).toBe('succeeded');
    expect(job.progress).toBe(100);
    expect(job.live_url).toBeDefined();
    expect(job.manifest).toHaveProperty('generator');
    expect(job.manifest.licensing.commercial_use_allowed).toBe(true);

    // Hard Case 1 & Integration Standard 4: Retry with same Idempotency-Key
    const retryRes = await request(app)
      .post('/api/v1/publish')
      .set('Idempotency-Key', idemKey)
      .send({
        destination_id: testDestId,
        title: 'Integration Test Publication Topic',
        body: 'This is an integration test publication body that exceeds twenty characters easily.',
        canonical_url: 'https://incubrix.internal/test',
        simulation: true
      });

    expect(retryRes.status).toBe(200);
    expect(retryRes.body.is_replay).toBe(true);
    expect(retryRes.body.job_id).toBe(jobId);
    expect(retryRes.body.live_url).toBe(job.live_url);
  });

  it('Blocks post when self-promotion is banned on destination (DEST_RULE_SELF_PROMO)', async () => {
    const res = await request(app)
      .post('/api/v1/publish')
      .set('Idempotency-Key', `idem_strict_${Date.now()}`)
      .send({
        destination_id: strictDestId,
        title: 'Promotional Product Pitch',
        body: 'Sign up for our discounted tier today at our website.',
        is_promotional: true,
        simulation: true
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('DEST_RULE_SELF_PROMO');
    expect(res.body.error.retryable).toBe(false);
  });

  it('Blocks publishing to uncertified destination with DEST_NOT_CERTIFIED', async () => {
    const uncert = db.get("SELECT id FROM destinations WHERE name = 'Uncertified Integration Forum'");
    const res = await request(app)
      .post('/api/v1/publish')
      .set('Idempotency-Key', `idem_uncert_${Date.now()}`)
      .send({
        destination_id: uncert.id,
        title: 'Valid Discussion Topic',
        body: 'Valid post body text exceeding twenty characters.',
        simulation: true
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('DEST_NOT_CERTIFIED');
  });

  it('Blocks publishing to demoted destination with DEST_DEMOTED', async () => {
    const demoted = db.get("SELECT id FROM destinations WHERE name = 'Demoted Integration Forum'");
    const res = await request(app)
      .post('/api/v1/publish')
      .set('Idempotency-Key', `idem_demoted_${Date.now()}`)
      .send({
        destination_id: demoted.id,
        title: 'Valid Discussion Topic',
        body: 'Valid post body text exceeding twenty characters.',
        simulation: true
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('DEST_DEMOTED');
  });

  it('Recommender ranks certified destinations above uncertified and excludes demoted', async () => {
    const res = await request(app)
      .post('/api/v1/publish/recommender')
      .set('Idempotency-Key', `idem_rec_${Date.now()}`)
      .send({
        title: 'AI Engineering and SaaS Architecture',
        body: 'Deep dive into LLMs, AI agents, and cloud architectures.',
        tags: ['ai', 'saas']
      });

    expect(res.status).toBe(200);
    expect(res.body.top_recommendations.length).toBeGreaterThan(0);

    // Demoted destinations must never appear
    for (const rec of res.body.top_recommendations) {
      expect(rec.status).not.toBe('demoted');
    }

    // Certified destinations rank above uncertified destinations
    let seenUncertified = false;
    for (const rec of res.body.top_recommendations) {
      if (rec.status !== 'certified') {
        seenUncertified = true;
      } else if (seenUncertified) {
        expect(rec.status).not.toBe('certified');
      }
    }
  });
});
