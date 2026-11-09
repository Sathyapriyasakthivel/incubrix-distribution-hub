import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { getDatabase } from '../../src/database/db.js';
import catalogueService from '../../src/services/catalogue/catalogueService.js';

describe('Certification Lifecycle & Fault Injection Integration Tests', () => {
  let app;
  let server;
  let db;

  const simDiscourseId = 'dest_sim_discourse_lifecycle';
  const simDevtoId = 'dest_sim_devto_lifecycle';
  const simGhostId = 'dest_sim_ghost_lifecycle';

  beforeAll(async () => {
    db = getDatabase();
    app = createApp();

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        process.env.MOCK_DISCOURSE_URL = `http://127.0.0.1:${port}/mock/discourse`;
        process.env.MOCK_DEVTO_URL = `http://127.0.0.1:${port}/mock/devto`;
        process.env.MOCK_LEMMY_URL = `http://127.0.0.1:${port}/mock/lemmy`;
        process.env.MOCK_GHOST_URL = `http://127.0.0.1:${port}/mock/ghost`;
        process.env.MOCK_WEBHOOK_RECEIVER_URL = `http://127.0.0.1:${port}/mock/webhook`;

        // Seed simulation destinations needed for this test explicitly by ID
        catalogueService.createDestination({
          id: simDiscourseId,
          name: 'Simulated Discourse Lifecycle Forum',
          url: `http://127.0.0.1:${port}/mock/discourse`,
          platform_key: 'discourse',
          connector_key: 'discourse',
          simulation_mode: 1,
          status: 'uncertified',
          disclosure_required: 0,
          self_promo_allowed: 1,
          is_enabled: 1
        });

        catalogueService.createDestination({
          id: simDevtoId,
          name: 'Simulated Devto Lifecycle Blog',
          url: `http://127.0.0.1:${port}/mock/devto`,
          platform_key: 'devto',
          connector_key: 'devto',
          simulation_mode: 1,
          status: 'certified',
          is_enabled: 1
        });

        catalogueService.createDestination({
          id: simGhostId,
          name: 'Simulated Ghost Lifecycle Publication',
          url: `http://127.0.0.1:${port}/mock/ghost`,
          platform_key: 'ghost',
          connector_key: 'ghost',
          simulation_mode: 1,
          status: 'certified',
          is_enabled: 1
        });

        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('Runs clean 10-step certification, cleans up, and generates evidence', async () => {
    const dest = db.get('SELECT id, name FROM destinations WHERE id = ?', simDiscourseId);
    expect(dest).toBeDefined();

    const res = await request(app)
      .post(`/api/v1/certification/run/${dest.id}`)
      .set('Idempotency-Key', `cert_lifecycle_${Date.now()}_clean`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('certified');
    expect(res.body.steps.length).toBeGreaterThanOrEqual(8);
    expect(res.body.is_cleaned_up).toBe(true);
    expect(res.body.evidence_url).toBeDefined();

    // Verify destination marked certified in DB
    const updated = db.get('SELECT status, last_certified_at FROM destinations WHERE id = ?', dest.id);
    expect(updated.status).toBe('certified');
    expect(updated.last_certified_at).not.toBeNull();
  });

  it('Hard Case 7: API field rename fault injection causes certification failure and demotes destination', async () => {
    const dest = db.get('SELECT id FROM destinations WHERE id = ?', simDevtoId);
    expect(dest).toBeDefined();

    const res = await request(app)
      .post(`/api/v1/certification/run/${dest.id}`)
      .set('Idempotency-Key', `cert_lifecycle_${Date.now()}_fault`)
      .send({ fault_injection: 'field_rename' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.error).toBeDefined();

    // Assert destination is demoted
    const demoted = db.get('SELECT status FROM destinations WHERE id = ?', dest.id);
    expect(demoted.status).toBe('demoted');
  });

  it('Transient 429 rate limit makes certification run inconclusive and does NOT demote', async () => {
    const dest = db.get('SELECT id FROM destinations WHERE id = ?', simGhostId);
    expect(dest).toBeDefined();

    // Ensure destination starts certified
    db.run("UPDATE destinations SET status = 'certified' WHERE id = ?", dest.id);

    const res = await request(app)
      .post(`/api/v1/certification/run/${dest.id}`)
      .set('Idempotency-Key', `cert_lifecycle_${Date.now()}_transient`)
      .send({ fault_injection: 'rate_limit' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('inconclusive');

    // Confirm destination was NOT demoted
    const unchanged = db.get('SELECT status FROM destinations WHERE id = ?', dest.id);
    expect(unchanged.status).toBe('certified');
  });

  it('Test post sweeper cleans up expired test posts', async () => {
    const { testPostSweeper } = await import('../../src/services/certification/testPostSweeper.js');
    // Record an expired test post
    testPostSweeper.recordTestPost(simDiscourseId, 'post_expired_dummy', -10);

    const checkBefore = db.get("SELECT * FROM test_posts WHERE platform_post_id = 'post_expired_dummy'");
    expect(checkBefore).toBeDefined();

    const { swept } = await testPostSweeper.sweepExpiredPosts();
    expect(swept).toBeGreaterThanOrEqual(1);

    const checkAfter = db.get("SELECT * FROM test_posts WHERE platform_post_id = 'post_expired_dummy'");
    expect(checkAfter).toBeNull();
  });
});
