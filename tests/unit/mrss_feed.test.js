import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { initDatabase, setDatabase } from '../../src/database/db.js';
import { runMigrations } from '../../src/database/migrate.js';
import { createApp } from '../../src/app.js';
import registry from '../../src/connectors/ConnectorRegistry.js';
import catalogueService from '../../src/services/catalogue/catalogueService.js';
import { CertificationHarness } from '../../src/services/certification/certificationHarness.js';

describe('MRSS Video Feed Connector & Syndication', () => {
  let db;
  let app;

  beforeEach(() => {
    db = initDatabase(':memory:');
    runMigrations(db);
    setDatabase(db);
    catalogueService.db = db;
    app = createApp();
  });

  afterEach(() => {
    if (db) db.close();
    setDatabase(null);
  });

  it('registers MRSS connector with tier feed and valid manifest', () => {
    expect(registry.hasConnector('mrss')).toBe(true);
    const connector = registry.getConnector('mrss');
    expect(connector.key).toBe('mrss');
    expect(connector.tier).toBe('feed');
    expect(connector.capabilities.has('publish')).toBe(true);
    expect(connector.capabilities.has('delete')).toBe(true);
    expect(connector.manifest.instance_param).toBe('feed_slug');
  });

  it('validates video rendition specs and rejects unsupported media types', async () => {
    const connector = registry.getConnector('mrss');
    const destination = { id: 'dest_test_mrss' };

    // Missing title
    const invalidTitle = await connector.validate({ title: '', body: 'body' }, destination, {});
    expect(invalidTitle.ok).toBe(false);
    expect(invalidTitle.violations.some(v => v.field === 'title')).toBe(true);

    // Unsupported media format (.exe)
    const invalidMedia = await connector.validate({
      title: 'Valid Video Title',
      body: 'Valid video description',
      media_urls: ['https://cdn.example.com/malicious.exe']
    }, destination, {});
    expect(invalidMedia.ok).toBe(false);
    expect(invalidMedia.violations.some(v => v.field === 'media_urls')).toBe(true);

    // Valid MP4 video
    const valid = await connector.validate({
      title: 'Showcase Demo Video',
      body: 'Demonstration of long-tail video syndication',
      media_urls: ['https://cdn.example.com/videos/demo.mp4']
    }, destination, {});
    expect(valid.ok).toBe(true);
  });

  it('publishes item to feed and generates valid Media RSS 2.0 XML with media namespace', async () => {
    const destination = catalogueService.createDestination({
      name: 'Roku Syndicated Feed',
      url: 'https://syndicate.internal/feed/roku',
      platform_key: 'mrss',
      connector_key: 'mrss'
    });

    const connector = registry.getConnector('mrss');
    const pubResult = await connector.publish(
      {
        title: 'IncuBrix Product Launch Video',
        body: 'Official launch video for long-tail distribution platform.',
        canonical_url: 'https://incubrix.internal/watch/launch',
        media_urls: [
          'https://cdn.incubrix.internal/media/launch_1080p.mp4',
          'https://cdn.incubrix.internal/thumbnails/launch.jpg'
        ]
      },
      destination,
      { base_url: 'http://127.0.0.1:3000' },
      'idem_mrss_001'
    );

    expect(pubResult.status).toBe('published');
    expect(pubResult.platform_post_id).toMatch(/^mrss_/);
    expect(pubResult.live_url).toContain(`/feeds/${destination.id}.xml`);

    // Fetch the generated XML feed via HTTP
    const res = await request(app).get(`/feeds/${destination.id}.xml`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/rss+xml');

    const xml = res.text;
    expect(xml).toContain('xmlns:media="http://search.yahoo.com/mrss/"');
    expect(xml).toContain('<title>Roku Syndicated Feed - IncuBrix MRSS Feed</title>');
    expect(xml).toContain('<title>IncuBrix Product Launch Video</title>');
    expect(xml).toContain('<media:content url="https://cdn.incubrix.internal/media/launch_1080p.mp4" medium="video"');
    expect(xml).toContain('<media:thumbnail url="https://cdn.incubrix.internal/thumbnails/launch.jpg"');
    expect(xml).toContain(pubResult.platform_post_id);
  });

  it('supports idempotent re-publishing and deletion from feed', async () => {
    const destination = { id: 'dest_idem_test' };
    const connector = registry.getConnector('mrss');

    const post1 = await connector.publish(
      { title: 'Video Episode 1', body: 'Description' },
      destination,
      {},
      'idem_unique_key_123'
    );

    // Re-publishing with same marker returns existing post
    const post2 = await connector.publish(
      { title: 'Video Episode 1', body: 'Description' },
      destination,
      {},
      'idem_unique_key_123'
    );
    expect(post2.platform_post_id).toBe(post1.platform_post_id);

    // Get status
    const statusBefore = await connector.getStatus(post1.platform_post_id, {});
    expect(statusBefore.status).toBe('published');

    // Delete post
    const deleteRes = await connector.delete(post1.platform_post_id, {});
    expect(deleteRes.deleted).toBe(true);

    // Get status after delete
    const statusAfter = await connector.getStatus(post1.platform_post_id, {});
    expect(statusAfter.status).toBe('deleted');
  });

  it('completes 10-step certification against MRSS feed, assigning Tier feed and Level L2', async () => {
    const dest = catalogueService.createDestination({
      name: 'Smart TV Video Feed',
      url: 'https://smarttv.internal/feeds/channel1',
      platform_key: 'mrss',
      connector_key: 'mrss',
      simulation_mode: 0 // real MRSS XML generator
    });

    const harness = new CertificationHarness(db);
    const result = await harness.certifyDestination(dest.id);

    expect(result.status).toBe('certified');
    expect(result.steps.length).toBe(10);
    // Tier feed must map to level L2
    expect(result.level).toBe('L2');
    expect(result.is_cleaned_up).toBe(true);

    // Verify test post was removed from the live XML feed
    const feedRes = await request(app).get(`/feeds/${dest.id}.xml`);
    expect(feedRes.status).toBe(200);
    expect(feedRes.text).not.toContain(result.test_post_id);
  });

  it('supports contract routes over POST /connector/v1/mrss/{method}', async () => {
    const dest = { id: 'dest_contract_mrss', url: 'https://tv.internal' };

    // 1. Validate
    const valRes = await request(app)
      .post('/connector/v1/mrss/validate')
      .send({ rendition: { title: 'Contract Test Video' }, destination: dest });
    expect(valRes.status).toBe(200);
    expect(valRes.body.ok).toBe(true);

    // 2. Publish
    const pubRes = await request(app)
      .post('/connector/v1/mrss/publish')
      .send({ rendition: { title: 'Contract Test Video', body: 'Test' }, destination: dest });
    expect(pubRes.status).toBe(200);
    const postId = pubRes.body.platform_post_id;
    expect(postId).toBeDefined();

    // 3. Get Status
    const statRes = await request(app)
      .post('/connector/v1/mrss/get_status')
      .send({ platform_post_id: postId });
    expect(statRes.status).toBe(200);
    expect(statRes.body.status).toBe('published');

    // 4. Delete
    const delRes = await request(app)
      .post('/connector/v1/mrss/delete')
      .send({ platform_post_id: postId });
    expect(delRes.status).toBe(200);
    expect(delRes.body.deleted).toBe(true);
  });
});
