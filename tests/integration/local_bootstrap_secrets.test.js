import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initDatabase, setDatabase } from '../../src/database/db.js';
import { runMigrations } from '../../src/database/migrate.js';
import GhostConnector from '../../src/connectors/ghost/GhostConnector.js';
import LemmyConnector from '../../src/connectors/lemmy/LemmyConnector.js';
import DiscourseConnector from '../../src/connectors/discourse/DiscourseConnector.js';
import DevtoConnector from '../../src/connectors/devto/DevtoConnector.js';
import { createGhostToken } from '../../src/utils/ghostAuth.js';
import { ConnectionSecretMissingError } from '../../src/utils/errors.js';

describe('Local Test Instances & Secret Enforcement', () => {
  let db;
  let app;

  beforeEach(() => {
    db = initDatabase(':memory:');
    runMigrations(db);
    setDatabase(db);
    app = createApp();
  });

  afterEach(() => {
    delete process.env.TEST_GHOST_SECRET;
    delete process.env.TEST_LEMMY_SECRET;
    delete process.env.TEST_DISCOURSE_SECRET;
    delete process.env.GHOST_ADMIN_KEY;
    delete process.env.LEMMY_JWT_TOKEN;
  });

  it('Ghost Admin API JWT generator produces valid JWT from id:secret', () => {
    const adminKey = '64f1a2b3c4d5e6f7a8b9c0d1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const jwt = createGhostToken(adminKey);

    expect(jwt).toBeDefined();
    const parts = jwt.split('.');
    expect(parts.length).toBe(3);

    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    expect(header.alg).toBe('HS256');
    expect(header.typ).toBe('JWT');
    expect(header.kid).toBe('64f1a2b3c4d5e6f7a8b9c0d1');

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    expect(payload.aud).toBe('/admin/');
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it('Destination with simulation_mode = 0 and missing secret throws CONNECTION_SECRET_MISSING for Ghost', async () => {
    const connector = new GhostConnector();
    const destination = {
      id: 'local-ghost-test',
      name: 'Local Ghost',
      url: 'http://localhost:2368',
      simulation_mode: 0,
      secret_ref: 'TEST_GHOST_SECRET'
    };
    const connection = {}; // TEST_GHOST_SECRET is not set in env

    const rendition = {
      title: 'Real Ghost Article',
      body: 'This post is targeted at real local Ghost instance.'
    };

    await expect(
      connector.publish(rendition, destination, connection, 'idem_ghost_sec_01')
    ).rejects.toThrow(ConnectionSecretMissingError);

    try {
      await connector.publish(rendition, destination, connection, 'idem_ghost_sec_01');
    } catch (err) {
      expect(err.code).toBe('CONNECTION_SECRET_MISSING');
      expect(err.statusCode).toBe(401);
    }
  });

  it('Destination with simulation_mode = 0 and missing secret throws CONNECTION_SECRET_MISSING for Lemmy', async () => {
    const connector = new LemmyConnector();
    const destination = {
      id: 'local-lemmy-test',
      name: 'Local Lemmy',
      url: 'http://localhost:8536',
      simulation_mode: 0,
      secret_ref: 'TEST_LEMMY_SECRET'
    };
    const connection = {};

    const rendition = {
      title: 'Real Lemmy Topic',
      body: 'Testing live Lemmy secret enforcement without fallback.'
    };

    await expect(
      connector.publish(rendition, destination, connection, 'idem_lemmy_sec_01')
    ).rejects.toThrow(ConnectionSecretMissingError);

    try {
      await connector.publish(rendition, destination, connection, 'idem_lemmy_sec_01');
    } catch (err) {
      expect(err.code).toBe('CONNECTION_SECRET_MISSING');
      expect(err.statusCode).toBe(401);
    }
  });

  it('Destination with simulation_mode = 0 and missing secret throws CONNECTION_SECRET_MISSING for Discourse', async () => {
    const connector = new DiscourseConnector();
    const destination = {
      id: 'local-discourse-test',
      name: 'Local Discourse',
      url: 'http://localhost:4200',
      simulation_mode: 0,
      secret_ref: 'TEST_DISCOURSE_SECRET'
    };
    const connection = {};

    const rendition = {
      title: 'Real Discourse Topic',
      body: 'Testing live Discourse secret enforcement.'
    };

    await expect(
      connector.publish(rendition, destination, connection, 'idem_disc_sec_01')
    ).rejects.toThrow(ConnectionSecretMissingError);

    try {
      await connector.publish(rendition, destination, connection, 'idem_disc_sec_01');
    } catch (err) {
      expect(err.code).toBe('CONNECTION_SECRET_MISSING');
      expect(err.statusCode).toBe(401);
    }
  });

  it('Publish API blocks request when destination simulation_mode = 0 and secret_ref is missing', async () => {
    const destId = `dest_real_http_ghost_${Date.now()}`;
    const now = new Date().toISOString();
    db.run(`
      INSERT INTO destinations (
        id, name, url, platform_key, surface, category, audience_tags,
        language, geo, est_audience, rules_url, frequency_cap,
        self_promo_allowed, link_policy, disclosure_required, automation_allowed,
        connector_key, relevance_score, relevance_reason, level,
        is_enabled, simulation_mode, status, secret_ref, created_at, updated_at
      ) VALUES (
        ?, 'Real Ghost Instance', 'http://localhost:2368', 'ghost', 'article',
        'Publishing', '["CMS"]', 'en', 'global', 1000, 'http://localhost:2368/rules',
        '10/24h', 1, 'allowed', 0, 1, 'ghost', 5, 'Real Ghost node', 'L0',
        1, 0, 'certified', 'MISSING_ENV_SECRET_KEY', ?, ?
      )
    `, destId, now, now);

    const res = await request(app)
      .post('/api/v1/publish')
      .set('Idempotency-Key', `idem_real_pub_${Date.now()}`)
      .send({
        destination_id: destId,
        title: 'Publish to Real Ghost without Secret',
        body: 'This publication should fail because secret_ref is not present in process.env',
        is_promotional: false
      });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('CONNECTION_SECRET_MISSING');
  });

  it('Lemmy connector enforces 200 char max title length limit', async () => {
    const connector = new LemmyConnector();
    const destination = { id: 'dest_lemmy_limits', simulation_mode: 1 };
    const longTitle = 'A'.repeat(201);

    const validation = await connector.validate({
      title: longTitle,
      body: 'Valid post body with enough text to pass validation.'
    }, destination, {});

    expect(validation.ok).toBe(false);
    const titleViolation = validation.violations.find(v => v.field === 'title' && v.rule === 'max_length');
    expect(titleViolation).toBeDefined();
    expect(titleViolation.message).toMatch(/200/);
  });

  it('scripts/bootstrap_local.js seeds local-ghost and local-lemmy with simulation_mode = 0 and secret_ref', async () => {
    const { seedLocalDestinations } = await import('../../scripts/bootstrap_local.js');
    seedLocalDestinations(db, {
      ghostUrl: 'http://localhost:2368',
      ghostAdminKey: 'test_ghost_admin_key_123',
      lemmyUrl: 'http://localhost:8536',
      lemmyJwt: 'test_lemmy_jwt_456',
      lemmyCommunityId: 2
    });

    const ghostDest = db.get('SELECT * FROM destinations WHERE id = ?', 'local-ghost');
    expect(ghostDest).toBeDefined();
    expect(ghostDest.platform_key).toBe('ghost');
    expect(ghostDest.connector_key).toBe('ghost');
    expect(ghostDest.simulation_mode).toBe(0);
    expect(ghostDest.secret_ref).toBe('GHOST_ADMIN_KEY');

    const lemmyDest = db.get('SELECT * FROM destinations WHERE id = ?', 'local-lemmy');
    expect(lemmyDest).toBeDefined();
    expect(lemmyDest.platform_key).toBe('lemmy');
    expect(lemmyDest.connector_key).toBe('lemmy');
    expect(lemmyDest.simulation_mode).toBe(0);
    expect(lemmyDest.secret_ref).toBe('LEMMY_JWT_TOKEN');

    const ghostAuth = db.get('SELECT * FROM auth_configs WHERE destination_id = ?', 'local-ghost');
    expect(ghostAuth).toBeDefined();
    expect(ghostAuth.secret_ref).toBe('GHOST_ADMIN_KEY');

    const lemmyAuth = db.get('SELECT * FROM auth_configs WHERE destination_id = ?', 'local-lemmy');
    expect(lemmyAuth).toBeDefined();
    expect(lemmyAuth.secret_ref).toBe('LEMMY_JWT_TOKEN');
  });
});
