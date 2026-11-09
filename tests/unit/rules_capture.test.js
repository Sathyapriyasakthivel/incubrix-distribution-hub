import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import request from 'supertest';
import { initDatabase, setDatabase } from '../../src/database/db.js';
import { runMigrations } from '../../src/database/migrate.js';
import { createApp } from '../../src/app.js';
import {
  MockRulesCaptureProvider,
  LlmRulesCaptureProvider,
  RulesCaptureAdapter
} from '../../src/services/ai/rulesCaptureAdapter.js';
import catalogueService from '../../src/services/catalogue/catalogueService.js';

describe('Rules Capture Adapter', () => {
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

  describe('MockRulesCaptureProvider', () => {
    it('accurately parses TechForum fixture rules and computes dynamic confidence with quotes', async () => {
      const provider = new MockRulesCaptureProvider();
      const adapter = new RulesCaptureAdapter({ provider: 'mock' });
      const rawHtml = await adapter.fetchRulesContent('tests/fixtures/rules/tech_forum_rules.html');

      const result = await provider.parseContent(rawHtml);

      expect(result.frequency_cap).toBe('1/7d');
      expect(result.self_promo_allowed).toBe(1);
      expect(result.link_policy).toBe('restricted');
      expect(result.disclosure_required).toBe(1);
      expect(result.automation_allowed).toBe(1);

      // Verifies exact quotes are populated
      expect(result.quotes.frequency_cap).toContain('1/7d');
      expect(result.quotes.self_promo_allowed).toContain('Self promotion is allowed');
      expect(result.quotes.link_policy).toMatch(/strictly forbidden|restricted to/);
      expect(result.quotes.disclosure_required).toContain('AI-generated');
      expect(result.quotes.automation_allowed).toContain('Bots and automated posting are permitted');

      // Confidence is dynamically computed from evidence (all 5 matched -> 0.94)
      expect(result.confidence).toBe(0.94);
      expect(result.cost_usd).toBe(0.0);
      expect(result.provider).toBe('mock');
    });

    it('accurately parses StrictDev fixture rules with strict prohibitions', async () => {
      const provider = new MockRulesCaptureProvider();
      const adapter = new RulesCaptureAdapter({ provider: 'mock' });
      const rawHtml = await adapter.fetchRulesContent('tests/fixtures/rules/strict_community_rules.html');

      const result = await provider.parseContent(rawHtml);

      expect(result.frequency_cap).toBe('1/24h');
      expect(result.self_promo_allowed).toBe(0);
      expect(result.link_policy).toBe('no_links');
      expect(result.disclosure_required).toBe(1);
      expect(result.automation_allowed).toBe(0);

      expect(result.quotes.self_promo_allowed).toContain('Strictly zero self-promotion');
      expect(result.quotes.link_policy).toContain('External links are prohibited');
      expect(result.quotes.automation_allowed).toContain('Automated scripts and bots are strictly forbidden');
      expect(result.confidence).toBe(0.94);
    });

    it('computes lower confidence when fewer rule patterns match', async () => {
      const provider = new MockRulesCaptureProvider();
      const vagueText = '<p>Welcome to our forum. Be nice to everyone.</p>';

      const result = await provider.parseContent(vagueText);

      expect(result.confidence).toBe(0.20);
      expect(Object.keys(result.quotes).length).toBe(0);
    });
  });

  describe('LlmRulesCaptureProvider', () => {
    it('parses LLM structured JSON response and computes real token cost', async () => {
      const originalFetch = global.fetch;
      const fakeLlmResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                frequency_cap: '1/3d',
                self_promo_allowed: 1,
                link_policy: 'restricted',
                disclosure_required: 1,
                automation_allowed: 1,
                quotes: {
                  frequency_cap: 'Post once every 3 days',
                  self_promo_allowed: 'Promo permitted in Friday thread',
                  link_policy: 'Links to open source projects only',
                  disclosure_required: 'Tag AI posts with #ai',
                  automation_allowed: 'API bots allowed with key'
                },
                confidence: 0.88
              })
            }
          }
        ],
        usage: {
          prompt_tokens: 350,
          completion_tokens: 120,
          total_tokens: 470
        }
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => fakeLlmResponse
      });

      try {
        const llmProvider = new LlmRulesCaptureProvider({
          provider: 'openai',
          apiKey: 'test-api-key',
          model: 'gpt-4o-mini'
        });

        const result = await llmProvider.parseContent('Rules text sample...');

        expect(result.frequency_cap).toBe('1/3d');
        expect(result.self_promo_allowed).toBe(1);
        expect(result.confidence).toBe(0.88);
        expect(result.quotes.frequency_cap).toBe('Post once every 3 days');
        expect(result.provider).toBe('openai');
        expect(result.model).toBe('gpt-4o-mini');
        // Real cost calculation: 350 * 0.15e-6 + 120 * 0.60e-6 = 0.0000525 + 0.000072 = 0.000125
        expect(result.cost_usd).toBeGreaterThan(0);
        expect(result.cost_usd).toBeCloseTo(0.000125, 5);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('throws RULES_CAPTURE_AUTH_MISSING if API key is not configured', async () => {
      const llmProvider = new LlmRulesCaptureProvider({ provider: 'openai', apiKey: '' });
      await expect(llmProvider.parseContent('Some rules')).rejects.toThrow('RULES_AI_API_KEY is not configured');
    });
  });

  describe('Rules Proposal and Human Confirmation Lifecycle', () => {
    it('stores captured rules as proposed and only applies them after human confirmation', async () => {
      // 1. Seed a destination with default rules
      const dest = catalogueService.createDestination({
        name: 'Tech Discourse Forum',
        url: 'https://forum.tech.internal',
        platform_key: 'discourse',
        connector_key: 'discourse',
        rules_url: 'tests/fixtures/rules/tech_forum_rules.html',
        frequency_cap: '1/7d',
        self_promo_allowed: 1,
        link_policy: 'allowed',
        disclosure_required: 0,
        automation_allowed: 1
      });

      const adapter = new RulesCaptureAdapter({ db, provider: 'mock' });

      // 2. Capture rules from strict fixture
      const captured = await adapter.captureRules('tests/fixtures/rules/strict_community_rules.html');
      expect(captured.self_promo_allowed).toBe(0);
      expect(captured.link_policy).toBe('no_links');

      // 3. Save proposal
      const proposal = adapter.saveProposal(dest.id, 'tests/fixtures/rules/strict_community_rules.html', captured);
      expect(proposal.status).toBe('proposed');

      // Destination in DB must NOT be updated yet (ground rule: human must confirm)
      const untouchedDest = catalogueService.getDestination(dest.id);
      expect(untouchedDest.self_promo_allowed).toBe(true);
      expect(untouchedDest.link_policy).toBe('allowed');

      // 4. Human confirms proposal
      const confirmation = adapter.confirmProposal(dest.id);
      expect(confirmation.status).toBe('confirmed');
      expect(confirmation.applied_rules.self_promo_allowed).toBe(false);
      expect(confirmation.applied_rules.link_policy).toBe('no_links');

      // 5. Verify DB now reflects confirmed rules
      const updatedDest = catalogueService.getDestination(dest.id);
      expect(updatedDest.self_promo_allowed).toBe(false);
      expect(updatedDest.link_policy).toBe('no_links');
    });

    it('executes full capture-rules and confirm-rules flow over Express HTTP API', async () => {
      const dest = catalogueService.createDestination({
        name: 'API Forum',
        url: 'https://api-forum.test',
        platform_key: 'discourse',
        connector_key: 'discourse',
        rules_url: 'tests/fixtures/rules/tech_forum_rules.html',
        frequency_cap: '1/7d',
        self_promo_allowed: 1,
        disclosure_required: 0
      });

      // POST /capture-rules with destination_id saves proposal
      const captureRes = await request(app)
        .post(`/api/v1/destinations/${dest.id}/capture-rules`)
        .set('Idempotency-Key', 'idem_capture_001')
        .send({ rules_url: 'tests/fixtures/rules/tech_forum_rules.html' });

      expect(captureRes.status).toBe(200);
      expect(captureRes.body.status).toBe('proposed');
      expect(captureRes.body.quotes.disclosure_required).toBeDefined();

      // Confirm rules via POST /:id/rules/confirm
      const confirmRes = await request(app)
        .post(`/api/v1/destinations/${dest.id}/rules/confirm`)
        .set('Idempotency-Key', 'idem_confirm_001')
        .send();

      expect(confirmRes.status).toBe(200);
      expect(confirmRes.body.status).toBe('confirmed');
      expect(confirmRes.body.applied_rules.disclosure_required).toBe(true);

      const finalDest = catalogueService.getDestination(dest.id);
      expect(finalDest.disclosure_required).toBe(true);
    });
  });

  describe('Rules Capture Security and Resource Limits', () => {
    let limitServer;
    let limitServerUrl;

    beforeAll(async () => {
      limitServer = http.createServer((req, res) => {
        if (req.url === '/robots.txt') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('User-agent: *\nDisallow: /disallowed-rules\nAllow: /\n');
        } else if (req.url === '/disallowed-rules') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body>Disallowed rules content</body></html>');
        } else if (req.url === '/oversized-rules') {
          res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': '5000' });
          res.end('A'.repeat(5000));
        } else if (req.url === '/slow-rules') {
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body>Slow rules content</body></html>');
          }, 300);
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise(resolve => limitServer.listen(0, '127.0.0.1', resolve));
      const port = limitServer.address().port;
      limitServerUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      if (limitServer) {
        await new Promise(r => limitServer.close(r));
      }
    });

    it('enforces robots.txt and throws ROBOTS_TXT_DISALLOWED (HTTP 403)', async () => {
      const adapter = new RulesCaptureAdapter({ provider: 'mock' });
      await expect(
        adapter.fetchRulesContent(`${limitServerUrl}/disallowed-rules`, { allowPrivate: true })
      ).rejects.toMatchObject({
        code: 'ROBOTS_TXT_DISALLOWED',
        statusCode: 403
      });
    });

    it('enforces response payload size limit and throws PAYLOAD_TOO_LARGE (HTTP 413)', async () => {
      const adapter = new RulesCaptureAdapter({ provider: 'mock' });
      await expect(
        adapter.fetchRulesContent(`${limitServerUrl}/oversized-rules`, {
          allowPrivate: true,
          skipRobots: true,
          maxBytes: 1000 // 1000 bytes max, response is 5000 bytes
        })
      ).rejects.toMatchObject({
        code: 'PAYLOAD_TOO_LARGE',
        statusCode: 413
      });
    });

    it('enforces request timeout limit and throws FETCH_TIMEOUT (HTTP 504)', async () => {
      const adapter = new RulesCaptureAdapter({ provider: 'mock' });
      await expect(
        adapter.fetchRulesContent(`${limitServerUrl}/slow-rules`, {
          allowPrivate: true,
          skipRobots: true,
          timeoutMs: 50 // 50ms timeout, server takes 300ms
        })
      ).rejects.toMatchObject({
        code: 'FETCH_TIMEOUT',
        statusCode: 504
      });
    });

    it('returns 413 over Express API when payload exceeds maxBytes limit', async () => {
      const res = await request(app)
        .post('/api/v1/destinations/capture-rules')
        .set('Idempotency-Key', 'idem_oversized_01')
        .send({
          rules_url: `${limitServerUrl}/oversized-rules`,
          allowPrivate: true,
          skipRobots: true,
          maxBytes: 1000
        });

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('returns 403 over Express API when robots.txt disallows the URL', async () => {
      const res = await request(app)
        .post('/api/v1/destinations/capture-rules')
        .set('Idempotency-Key', 'idem_robots_01')
        .send({
          rules_url: `${limitServerUrl}/disallowed-rules`,
          allowPrivate: true
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ROBOTS_TXT_DISALLOWED');
    });
  });
});

