import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import { createApp } from '../../src/app.js';
import { initDatabase, setDatabase } from '../../src/database/db.js';
import { runMigrations } from '../../src/database/migrate.js';
import { normalizeUrl } from '../../src/services/catalogue/catalogueService.js';
import { detectLanguage } from '../../src/utils/languageDetect.js';

describe('Catalogue Import & Benchmarking', () => {
  let app;
  let db;
  let mockServer;
  let mockServerUrl;

  beforeEach(async () => {
    db = initDatabase(':memory:');
    runMigrations(db);
    setDatabase(db);
    app = createApp();

    // Setup local mock HTTP server for reachability and enrichment checks
    await new Promise((resolve) => {
      mockServer = http.createServer((req, res) => {
        if (req.url === '/about.json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            about: {
              title: 'Discourse Community of AI Practitioners',
              description: 'Official developer community for generative models.',
              stats: { topic_count: 5400 }
            }
          }));
        } else if (req.url === '/api/v3/site') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            site_view: {
              site: {
                name: 'Lemmy Tech Fediverse',
                description: 'Federated discussion on open source and AI.'
              }
            }
          }));
        } else if (req.url === '/feed.csv') {
          res.writeHead(200, { 'Content-Type': 'text/csv' });
          res.end(`name,url,platform_key\nRemote Forum,${mockServerUrl}/remote,discourse\n`);
        } else if (req.url === '/unreachable') {
          res.writeHead(500);
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body>Community Page</body></html>');
        }
      });
      mockServer.listen(0, '127.0.0.1', () => {
        const port = mockServer.address().port;
        mockServerUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (mockServer) {
      await new Promise(r => mockServer.close(r));
    }
  });

  it('normalizeUrl correctly strips www, lowercases host, removes tracking parameters, and trims trailing slash', () => {
    const raw = 'HTTPS://WWW.Example.ORG:8080/Community/Forum/?utm_source=twitter&utm_medium=social&ref=newsletter&topic=ai#top';
    const norm = normalizeUrl(raw);
    expect(norm).toBe('https://example.org:8080/community/forum?topic=ai');

    const withTrailingSlash = 'http://WWW.LemmyInstance.IO/c/technology/';
    expect(normalizeUrl(withTrailingSlash)).toBe('http://lemmyinstance.io/c/technology');
  });

  it('detectLanguage identifies French, German, Spanish, and English', () => {
    expect(detectLanguage('Communauté francophone des développeurs et créateurs')).toBe('fr');
    expect(detectLanguage('Deutsche Entwickler-Community für künstliche Intelligenz')).toBe('de');
    expect(detectLanguage('Comunidad de programadores e inteligencia artificial en español')).toBe('es');
    expect(detectLanguage('Global developer community for generative AI engineers')).toBe('en');
  });

  it('Imports CSV with de-duplication on normalised URL plus platform and enriches from API', async () => {
    const csvContent = [
      'name,url,platform_key,category',
      `Discourse Test Forum,${mockServerUrl}/?utm_campaign=launch,discourse,AI`,
      `Duplicate Discourse,${mockServerUrl.replace('http://', 'http://www.')}/,discourse,AI`, // duplicate
      `Lemmy Test Instance,${mockServerUrl}/lemmy,lemmy,Tech`,
      'Bad Row Missing Name,,discourse,AI' // validation error
    ].join('\n');

    const res = await request(app)
      .post('/api/v1/destinations/import-csv')
      .set('Idempotency-Key', `import_test_${Date.now()}`)
      .attach('file', Buffer.from(csvContent), 'test_catalogue.csv');

    expect(res.status).toBe(200);
    expect(res.body.total_rows).toBe(4);
    expect(res.body.imported_count).toBe(2);
    expect(res.body.duplicate_count).toBe(1);
    expect(res.body.error_count).toBe(1);
    expect(res.body.report_json_url).toBeDefined();
    expect(res.body.report_csv_url).toBeDefined();

    // Verify enrichment was stored
    const discourseDest = db.get("SELECT * FROM destinations WHERE platform_key = 'discourse' LIMIT 1");
    expect(discourseDest).toBeDefined();
    expect(discourseDest.relevance_reason).toContain('Discourse Community of AI Practitioners');
  });

  it('Imports CSV via remote URL parameter', async () => {
    const res = await request(app)
      .post('/api/v1/destinations/import-csv')
      .set('Idempotency-Key', `import_url_${Date.now()}`)
      .send({
        url: `${mockServerUrl}/feed.csv`
      });

    expect(res.status).toBe(200);
    expect(res.body.imported_count).toBe(1);
    const remoteDest = db.get("SELECT * FROM destinations WHERE name = 'Remote Forum'");
    expect(remoteDest).toBeDefined();
  });

  it('Measures processing time for 1,000 rows (benchmark under 5 minutes)', async () => {
    // Generate 1,000 synthetic benchmark rows in memory
    const rows = ['name,url,platform_key,category,audience_tags'];
    for (let i = 0; i < 1000; i++) {
      rows.push(`Bench Destination ${i},${mockServerUrl}/bench/${i},discourse,AI,"AI;Tech"`);
    }
    const largeCsv = rows.join('\n');

    const startTime = Date.now();
    const res = await request(app)
      .post('/api/v1/destinations/import-csv')
      .set('Idempotency-Key', `import_bench_${Date.now()}`)
      .attach('file', Buffer.from(largeCsv), 'benchmark_1000.csv');

    const durationMs = Date.now() - startTime;
    console.log(`[Benchmark] Imported 1,000 catalogue rows in ${durationMs}ms (${(durationMs / 1000).toFixed(2)}s)`);

    expect(res.status).toBe(200);
    expect(res.body.total_rows).toBe(1000);
    expect(res.body.imported_count).toBe(1000);
    // Target: under 5 minutes (300,000ms)
    expect(durationMs).toBeLessThan(300000);
  });
});
