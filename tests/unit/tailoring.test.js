import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { initDatabase, setDatabase } from '../../src/database/db.js';
import { runMigrations } from '../../src/database/migrate.js';
import { createApp } from '../../src/app.js';
import catalogueService from '../../src/services/catalogue/catalogueService.js';
import tailoringRecommender, { truncateAtWordBoundary } from '../../src/services/ai/tailoringRecommender.js';

describe('Content Tailoring Engine', () => {
  let db;
  let app;
  let server;
  let port;

  beforeAll(async () => {
    const dummyApp = createApp();
    await new Promise((resolve) => {
      server = dummyApp.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
  });

  beforeEach(() => {
    db = initDatabase(':memory:');
    runMigrations(db);
    setDatabase(db);
    catalogueService.db = db;
    tailoringRecommender.db = db;
    app = createApp();
  });

  afterEach(() => {
    if (db) db.close();
    setDatabase(null);
  });

  describe('truncateAtWordBoundary', () => {
    it('truncates at space boundary without breaking words in half', () => {
      const text = 'The quick brown fox jumps over the lazy dog';
      const truncated = truncateAtWordBoundary(text, 20);
      expect(truncated).toBe('The quick brown...');
      expect(truncated.endsWith('...')).toBe(true);
      expect(truncated.length).toBeLessThanOrEqual(20);
    });

    it('returns original text if length is within limits', () => {
      const text = 'Short title';
      expect(truncateAtWordBoundary(text, 50)).toBe('Short title');
    });
  });

  describe('tailorContent rules', () => {
    it('applies discussion-first framing for Discourse forums and returns warnings', () => {
      const destination = {
        id: 'dest_disc',
        platform_key: 'discourse',
        max_title_chars: 255,
        max_body_chars: 32000
      };

      const result = tailoringRecommender.tailorContent({
        title: 'Microservice Architectures in 2026',
        body: 'Here is an overview of our backend microservices.'
      }, destination);

      expect(result.title).toBe('Discussion: Microservice Architectures in 2026');
      expect(result.body).toContain('What are your thoughts on this approach?');
      expect(result.warnings.some(w => w.includes('discussion-first'))).toBe(true);
    });

    it('appends canonical URL attribution and structure for developer article platforms (Dev.to / Hashnode)', () => {
      const destination = {
        id: 'dest_devto',
        platform_key: 'devto',
        max_title_chars: 128,
        max_body_chars: 25000
      };

      const result = tailoringRecommender.tailorContent({
        title: 'Building Safe Retries across Timeouts',
        body: 'In this tutorial we examine idempotency keys and markers.',
        canonical_url: 'https://incubrix.internal/tech/safe-retries'
      }, destination);

      expect(result.body).toContain('*Originally published at [https://incubrix.internal/tech/safe-retries](https://incubrix.internal/tech/safe-retries)*');
      expect(result.warnings.some(w => w.includes('canonical URL'))).toBe(true);
    });

    it('automatically adds disclosure notice when AI content is declared or destination requires it', () => {
      const destination = {
        id: 'dest_disclosure',
        platform_key: 'discourse',
        disclosure_required: 1,
        max_title_chars: 255,
        max_body_chars: 32000
      };

      const result = tailoringRecommender.tailorContent({
        title: 'AI Prompt Engineering Breakdown',
        body: 'Automated generated summary of top prompt models.',
        is_ai_generated: true
      }, destination);

      expect(result.body).toContain('[AI-Generated Content: Disclosed in accordance with community guidelines]');
      expect(result.warnings.some(w => w.includes('AI content disclosure'))).toBe(true);
    });

    it('formats platform-specific hashtags/mentions', () => {
      const devtoDest = { id: 'd1', platform_key: 'devto' };
      const devtoRes = tailoringRecommender.tailorContent({
        title: 'Title',
        body: 'Body',
        tags: ['NodeJS', 'AI-Tools', 'OpenSource', 'Backend', 'BonusTag']
      }, devtoDest);

      expect(devtoRes.warnings.some(w => w.includes('Dev.to platform (lowercase without #, max 4)'))).toBe(true);

      const forumDest = { id: 'd2', platform_key: 'discourse' };
      const forumRes = tailoringRecommender.tailorContent({
        title: 'Title',
        body: 'Body',
        tags: ['AI', 'Tech']
      }, forumDest);

      expect(forumRes.warnings.some(w => w.includes('hashtags for community tagging: #ai #tech'))).toBe(true);
    });

    it('applies word-boundary truncation when title or body exceeds platform limits', () => {
      const destination = {
        id: 'dest_tight',
        platform_key: 'lemmy',
        max_title_chars: 30,
        max_body_chars: 60
      };

      const longTitle = 'This is an exceptionally long title designed to trigger boundary truncation';
      const longBody = 'This is a very long body that exceeds sixty characters of length in total.';

      const result = tailoringRecommender.tailorContent({ title: longTitle, body: longBody }, destination);

      expect(result.title.length).toBeLessThanOrEqual(30);
      expect(result.title.endsWith('...')).toBe(true);
      expect(result.warnings.some(w => w.includes('Truncated title'))).toBe(true);
      expect(result.warnings.some(w => w.includes('Truncated body'))).toBe(true);
    });
  });

  describe('Publishing with tailor: true', () => {
    it('applies tailoring on publish and embeds tailoring warnings in output manifest', async () => {
      const dest = catalogueService.createDestination({
        name: 'Tailor Certified Forum',
        url: `http://127.0.0.1:${port}/mock/discourse`,
        platform_key: 'discourse',
        connector_key: 'discourse',
        simulation_mode: 1,
        disclosure_required: 1,
        status: 'certified'
      });

      const res = await request(app)
        .post('/api/v1/publish')
        .set('Idempotency-Key', 'idem_tailor_pub_001')
        .send({
          destination_id: dest.id,
          title: 'Understanding Distributed Consensus',
          body: 'Detailed technical article about Paxos and Raft protocols in distributed databases.',
          canonical_url: 'https://incubrix.internal/tech/consensus',
          tags: ['DistributedSystems', 'Database'],
          is_ai_generated: true,
          tailor: true
        });

      expect(res.status).toBe(202);
      expect(res.body.job_id).toBeDefined();

      // Wait briefly for synchronous processing of the job in test environment
      await new Promise(r => setTimeout(r, 200));

      const jobRes = await request(app).get(`/api/v1/jobs/${res.body.job_id}`);
      expect(jobRes.status).toBe(200);

      // Verify tailored title in job record
      expect(jobRes.body.title).toContain('Discussion:');

      // Verify manifest warnings contains tailoring notices
      const manifest = jobRes.body.output_manifest;
      expect(manifest).toBeDefined();
      expect(manifest.warnings).toBeInstanceOf(Array);
      expect(manifest.warnings.some(w => w.includes('discussion-first'))).toBe(true);
      expect(manifest.warnings.some(w => w.includes('AI content disclosure'))).toBe(true);
    });
  });
});
