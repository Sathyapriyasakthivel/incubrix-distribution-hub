import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initDatabase, setDatabase } from '../../src/database/db.js';
import { runMigrations } from '../../src/database/migrate.js';
import { isPrivateHost, validateUrl, safeFetch, parseRobotsTxtAllowed } from '../../src/utils/urlSecurity.js';
import { RulesCaptureAdapter } from '../../src/services/ai/rulesCaptureAdapter.js';

describe('P2 Security: SSRF Protection, Size Cap, Timeout & Robots.txt', () => {
  let app;
  let db;
  let testServer;
  let testServerPort;
  let testServerUrl;

  beforeAll(async () => {
    db = initDatabase(':memory:');
    runMigrations(db);
    setDatabase(db);
    app = createApp();

    await new Promise((resolve) => {
      testServer = http.createServer((req, res) => {
        if (req.url === '/robots.txt') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(`User-agent: *\nDisallow: /forbidden-rules\nDisallow: /private/\nAllow: /public\n`);
        } else if (req.url === '/forbidden-rules') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body>Community rules that should not be scraped</body></html>');
        } else if (req.url === '/oversized.csv') {
          res.writeHead(200, { 'Content-Type': 'text/csv' });
          // Send 12MB of data (over 10MB limit)
          const bigChunk = 'name,url,platform_key\n' + 'A'.repeat(1024 * 1024 * 11);
          res.end(bigChunk);
        } else if (req.url === '/valid.csv') {
          res.writeHead(200, { 'Content-Type': 'text/csv' });
          res.end('name,url,platform_key\nTest Community,https://example.com/forum,discourse\n');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body>Standard page</body></html>');
        }
      });

      testServer.listen(0, '127.0.0.1', () => {
        testServerPort = testServer.address().port;
        testServerUrl = `http://127.0.0.1:${testServerPort}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (testServer) {
      await new Promise(r => testServer.close(r));
    }
  });

  it('isPrivateHost correctly classifies private, loopback, and cloud metadata targets', () => {
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('0.0.0.0')).toBe(true);
    expect(isPrivateHost('169.254.169.254')).toBe(true);
    expect(isPrivateHost('metadata.google.internal')).toBe(true);
    expect(isPrivateHost('10.0.5.21')).toBe(true);
    expect(isPrivateHost('192.168.1.100')).toBe(true);
    expect(isPrivateHost('172.20.0.5')).toBe(true);
    expect(isPrivateHost('100.64.0.1')).toBe(true);

    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('community.openai.com')).toBe(false);
    expect(isPrivateHost('posthog.com')).toBe(false);
  });

  it('validateUrl blocks disallowed protocols and private IP ranges by default', () => {
    expect(() => validateUrl('file:///etc/passwd')).toThrow(/Unsupported protocol/);
    expect(() => validateUrl('ftp://example.com/feed.csv')).toThrow(/Unsupported protocol/);
    expect(() => validateUrl('gopher://example.com/')).toThrow(/Unsupported protocol/);

    expect(() => validateUrl('http://169.254.169.254/latest/meta-data')).toThrow(/prohibited/);
    expect(() => validateUrl('http://127.0.0.1:8080/admin')).toThrow(/prohibited/);
    expect(() => validateUrl('http://10.0.0.1/internal.csv')).toThrow(/prohibited/);

    // Permitted when allowPrivate is explicitly true
    expect(() => validateUrl('http://127.0.0.1:8080/test', { allowPrivate: true })).not.toThrow();
  });

  it('POST /api/v1/destinations/import-csv blocks SSRF attempts to private networks', async () => {
    const res = await request(app)
      .post('/api/v1/destinations/import-csv')
      .set('Idempotency-Key', `idem_ssrf_${Date.now()}`)
      .send({ url: 'http://169.254.169.254/latest/meta-data/credentials' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SSRF_BLOCKED');
  });

  it('POST /api/v1/destinations/import-csv allows remote CSV fetch with allowPrivate option in test', async () => {
    const res = await request(app)
      .post('/api/v1/destinations/import-csv')
      .set('Idempotency-Key', `idem_ssrf_allow_${Date.now()}`)
      .send({
        url: `${testServerUrl}/valid.csv`,
        allow_private: true
      });

    expect(res.status).toBe(200);
    expect(res.body.imported_count).toBe(1);
  });

  it('safeFetch rejects responses exceeding maximum size cap', async () => {
    let thrown = null;
    try {
      await safeFetch(`${testServerUrl}/oversized.csv`, {
        allowPrivate: true,
        maxBytes: 1024 * 1024 // 1MB cap
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('parseRobotsTxtAllowed checks Disallow rules correctly', () => {
    const robotsContent = `
User-agent: *
Disallow: /admin/
Disallow: /secret-rules
Allow: /admin/public
`;
    expect(parseRobotsTxtAllowed(robotsContent, '/secret-rules', 'IncuBrix-RulesCapture')).toBe(false);
    expect(parseRobotsTxtAllowed(robotsContent, '/admin/users', 'IncuBrix-RulesCapture')).toBe(false);
    expect(parseRobotsTxtAllowed(robotsContent, '/admin/public', 'IncuBrix-RulesCapture')).toBe(true);
    expect(parseRobotsTxtAllowed(robotsContent, '/guidelines', 'IncuBrix-RulesCapture')).toBe(true);
  });

  it('RulesCaptureAdapter respects community robots.txt and rejects crawling forbidden paths', async () => {
    const adapter = new RulesCaptureAdapter();
    let thrown = null;
    try {
      await adapter.fetchRulesContent(`${testServerUrl}/forbidden-rules`, {
        allowPrivate: true
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('ROBOTS_TXT_DISALLOWED');
  });
});
