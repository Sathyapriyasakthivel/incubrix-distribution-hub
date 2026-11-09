import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../../src/app.js';
import { initDatabase, setDatabase } from '../../src/database/db.js';
import { runMigrations } from '../../src/database/migrate.js';
import catalogueService from '../../src/services/catalogue/catalogueService.js';
import { runBatch } from '../../scripts/batch_runner.js';

describe('Batch Runner CLI Integration', () => {
  let server;
  let port;
  let db;
  let tmpOutputDir;

  beforeAll(async () => {
    db = initDatabase(':memory:');
    runMigrations(db);
    setDatabase(db);
    catalogueService.db = db;

    const app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });

    // Seed mock destinations for discourse, devto, webhook, lemmy
    catalogueService.createDestination({
      id: 'dest_test_discourse',
      name: 'Batch Test Discourse',
      url: `http://127.0.0.1:${port}/mock/discourse`,
      platform_key: 'discourse',
      connector_key: 'discourse',
      simulation_mode: 1,
      disclosure_required: 1,
      self_promo_allowed: 0,
      frequency_cap: null,
      status: 'certified'
    });

    catalogueService.createDestination({
      id: 'dest_test_lemmy',
      name: 'Batch Test Lemmy',
      url: `http://127.0.0.1:${port}/mock/lemmy`,
      platform_key: 'lemmy',
      connector_key: 'lemmy',
      simulation_mode: 1,
      frequency_cap: null,
      status: 'certified'
    });

    catalogueService.createDestination({
      id: 'dest_test_devto',
      name: 'Batch Test Dev.to',
      url: `http://127.0.0.1:${port}/mock/devto`,
      platform_key: 'devto',
      connector_key: 'devto',
      simulation_mode: 1,
      frequency_cap: null,
      status: 'certified'
    });

    catalogueService.createDestination({
      id: 'dest_test_webhook',
      name: 'Batch Test Webhook',
      url: `http://127.0.0.1:${port}/mock/webhook`,
      platform_key: 'webhook',
      connector_key: 'webhook',
      simulation_mode: 1,
      frequency_cap: null,
      status: 'certified'
    });

    tmpOutputDir = path.resolve(process.cwd(), 'storage', 'test_batches', `batch_${Date.now()}`);
  });

  afterAll(async () => {
    if (server) await new Promise(r => server.close(r));
    if (db) db.close();
    setDatabase(null);
    if (fs.existsSync(tmpOutputDir)) {
      try {
        fs.rmSync(tmpOutputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {}
    }
  });

  it('runs batch runner over HTTP API with --api and writes results to output folder', async () => {
    const inputFixture = path.resolve(process.cwd(), 'tests', 'fixtures', 'hard_cases_batch.json');

    const summary = await runBatch({
      input: inputFixture,
      output: tmpOutputDir,
      api: `http://127.0.0.1:${port}`,
      token: 'test_token_123'
    });

    expect(summary).toBeDefined();
    expect(summary.total_items).toBe(8);
    expect(summary.output_dir).toBe(tmpOutputDir);

    // Verify summary file exists on disk
    const summaryFile = path.join(tmpOutputDir, 'batch_summary.json');
    expect(fs.existsSync(summaryFile)).toBe(true);

    const summaryJson = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
    expect(summaryJson.total_items).toBe(8);
    expect(summaryJson.expectations_matched).toBe(8);

    // Verify individual item result files exist
    const files = fs.readdirSync(tmpOutputDir);
    const resultFiles = files.filter(f => f.startsWith('result_'));
    expect(resultFiles.length).toBe(8);
  });
});
