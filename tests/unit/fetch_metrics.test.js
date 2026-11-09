import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import registry from '../../src/connectors/ConnectorRegistry.js';
import createMockPlatformApp from '../../src/connectors/mocks/MockPlatformServer.js';
import { initDatabase, setDatabase } from '../../src/database/db.js';
import { runMigrations } from '../../src/database/migrate.js';
import catalogueService from '../../src/services/catalogue/catalogueService.js';
import { CertificationHarness } from '../../src/services/certification/certificationHarness.js';

describe('fetch_metrics Normalization and Level L4 Assignment', () => {
  let server;
  let mockApp;
  let testApp;
  let port;
  let db;

  const EXPECTED_METRIC_KEYS = [
    'views',
    'likes',
    'comments',
    'shares',
    'saves',
    'watch_time_s',
    'clicks'
  ];

  beforeAll(async () => {
    mockApp = createMockPlatformApp();
    testApp = express();
    testApp.use(express.json());
    testApp.use('/mock', mockApp);

    await new Promise((resolve) => {
      server = testApp.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        process.env.MOCK_DISCOURSE_URL = `http://127.0.0.1:${port}/mock/discourse`;
        process.env.MOCK_DEVTO_URL = `http://127.0.0.1:${port}/mock/devto`;
        process.env.MOCK_LEMMY_URL = `http://127.0.0.1:${port}/mock/lemmy`;
        process.env.MOCK_GHOST_URL = `http://127.0.0.1:${port}/mock/ghost`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  beforeEach(() => {
    db = initDatabase(':memory:');
    runMigrations(db);
    setDatabase(db);
    catalogueService.db = db;
  });

  afterEach(() => {
    if (db) db.close();
    setDatabase(null);
  });

  function assertMetricsShape(metrics) {
    expect(metrics).toBeDefined();
    for (const key of EXPECTED_METRIC_KEYS) {
      expect(typeof metrics[key], `Metric ${key} must be a number`).toBe('number');
    }
    expect(Object.keys(metrics).sort()).toEqual(EXPECTED_METRIC_KEYS.sort());
  }

  it('Discourse fetchMetrics returns normalized metrics with realistic engagement values', async () => {
    const connector = registry.getConnector('discourse');
    const pub = await connector.publish(
      { title: 'Metrics Test Topic for Discourse', body: 'Body with sufficient content for Discourse.' },
      { simulation_mode: true },
      { apiKey: 'test_key', apiUsername: 'admin' },
      'idem_disc_metrics'
    );

    const metrics = await connector.fetchMetrics(pub.platform_post_id, {
      base_url: process.env.MOCK_DISCOURSE_URL,
      apiKey: 'test_key',
      username: 'admin'
    });

    assertMetricsShape(metrics);
    expect(metrics.views).toBeGreaterThan(0);
    expect(metrics.likes).toBeGreaterThan(0);
  });

  it('Lemmy fetchMetrics returns normalized metrics from post counts', async () => {
    const connector = registry.getConnector('lemmy');
    const pub = await connector.publish(
      { title: 'Lemmy Metrics Test', body: 'Body meeting minimum chars' },
      { simulation_mode: true },
      { token: 'lemmy_token' },
      'idem_lemmy_metrics'
    );

    const metrics = await connector.fetchMetrics(pub.platform_post_id, {
      base_url: process.env.MOCK_LEMMY_URL,
      token: 'lemmy_token'
    });

    assertMetricsShape(metrics);
    expect(metrics.likes).toBeGreaterThan(0);
    expect(metrics.comments).toBeGreaterThan(0);
  });

  it('Dev.to fetchMetrics returns normalized views, reactions, and comments', async () => {
    const connector = registry.getConnector('devto');
    const pub = await connector.publish(
      { title: 'Dev.to Metrics Test Article', body: 'Article body markdown with at least 30 characters.' },
      { simulation_mode: true },
      { apiKey: 'test_key' },
      'idem_devto_metrics'
    );

    const metrics = await connector.fetchMetrics(pub.platform_post_id, {
      base_url: process.env.MOCK_DEVTO_URL,
      apiKey: 'test_key'
    });

    assertMetricsShape(metrics);
    expect(metrics.views).toBeGreaterThan(0);
    expect(metrics.likes).toBeGreaterThan(0);
    expect(metrics.comments).toBeGreaterThan(0);
  });

  it('Ghost fetchMetrics returns normalized audience counts', async () => {
    const connector = registry.getConnector('ghost');
    const pub = await connector.publish(
      { title: 'Ghost Editorial Publication', body: 'Ghost publication body content for metrics check.' },
      { simulation_mode: true },
      { admin_key: '60c72b2f9b1d8b001c8a1234:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
      'idem_ghost_metrics'
    );

    const metrics = await connector.fetchMetrics(pub.platform_post_id, {
      base_url: process.env.MOCK_GHOST_URL,
      admin_key: '60c72b2f9b1d8b001c8a1234:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    });

    assertMetricsShape(metrics);
    expect(metrics.views).toBeGreaterThan(0);
    expect(metrics.clicks).toBeGreaterThan(0);
  });

  it('Slack fetchMetrics returns normalized zero metrics as Slack does not track engagement', async () => {
    const connector = registry.getConnector('slack');
    const metrics = await connector.fetchMetrics('slack_msg_123', {});
    assertMetricsShape(metrics);
    expect(metrics.views).toBe(0);
    expect(metrics.likes).toBe(0);
    expect(metrics.comments).toBe(0);
  });

  it('Hashnode fetchMetrics returns normalized metrics', async () => {
    const connector = registry.getConnector('hashnode');
    const metrics = await connector.fetchMetrics('post_hashnode_123', {});
    assertMetricsShape(metrics);
    expect(metrics.views).toBeGreaterThan(0);
    expect(metrics.likes).toBeGreaterThan(0);
  });

  it('Destinations supporting metrics achieve Level L4 upon certification', async () => {
    const dest = catalogueService.createDestination({
      name: 'L4 Discourse Community',
      url: process.env.MOCK_DISCOURSE_URL,
      platform_key: 'discourse',
      connector_key: 'discourse',
      simulation_mode: 1
    });

    const harness = new CertificationHarness(db);
    const result = await harness.certifyDestination(dest.id);

    expect(result.status).toBe('certified');
    // Passing metrics must elevate native destination to level L4
    expect(result.level).toBe('L4');
    expect(result.is_cleaned_up).toBe(true);

    const destAfter = catalogueService.getDestination(dest.id);
    expect(destAfter.level).toBe('L4');
  });
});
