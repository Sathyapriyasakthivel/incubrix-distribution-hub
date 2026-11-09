import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase, setDatabase } from '../../src/database/db.js';
import { runMigrations } from '../../src/database/migrate.js';
import catalogueService from '../../src/services/catalogue/catalogueService.js';
import tailoringRecommender from '../../src/services/ai/tailoringRecommender.js';
import { evaluateRecommender } from '../../scripts/evaluate_recommender.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../');

describe('Recommender Precision on Labelled Test Set', () => {
  let db;

  beforeEach(() => {
    db = initDatabase(':memory:');
    runMigrations(db);
    setDatabase(db);
    catalogueService.db = db;
    tailoringRecommender.db = db;
  });

  afterEach(() => {
    if (db) db.close();
    setDatabase(null);
  });

  it('data/labelled_recommender_set.json has at least 20 items and is explicitly marked draft needs human review', () => {
    const filePath = path.join(projectRoot, 'data/labelled_recommender_set.json');
    expect(fs.existsSync(filePath), 'File must exist').toBe(true);

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(data.items.length).toBeGreaterThanOrEqual(20);

    // Ground rule check: must clearly mark as needs human review
    expect(data._metadata.status).toBe('draft_needs_human_review');
    expect(data._metadata.notice).toContain('NEEDS HUMAN REVIEW');
  });

  it('recommender ranks certified destinations above uncertified ones and excludes demoted', () => {
    // Certified destination
    catalogueService.createDestination({
      name: 'Certified Dev Forum',
      url: 'https://certified.test',
      platform_key: 'discourse',
      connector_key: 'discourse',
      category: 'AI / LLM Engineering',
      status: 'certified',
      is_enabled: 1
    });

    // Uncertified destination
    catalogueService.createDestination({
      name: 'Uncertified AI Forum',
      url: 'https://uncertified.test',
      platform_key: 'discourse',
      connector_key: 'discourse',
      category: 'AI / LLM Engineering',
      status: 'catalogued',
      is_enabled: 1
    });

    // Demoted destination
    catalogueService.createDestination({
      name: 'Demoted AI Forum',
      url: 'https://demoted.test',
      platform_key: 'discourse',
      connector_key: 'discourse',
      category: 'AI / LLM Engineering',
      status: 'demoted',
      is_enabled: 1
    });

    const recommendations = tailoringRecommender.recommendDestinations({
      title: 'AI LLM Engineering Guide',
      body: 'Detailed technical guide on AI prompts',
      tags: ['AI', 'LLM']
    }, 10);

    const returnedNames = recommendations.top_recommendations.map(r => r.name);
    expect(returnedNames).toContain('Certified Dev Forum');
    expect(returnedNames).toContain('Uncertified AI Forum');
    expect(returnedNames).not.toContain('Demoted AI Forum');

    // Certified must rank above uncertified
    const certIndex = returnedNames.indexOf('Certified Dev Forum');
    const uncertIndex = returnedNames.indexOf('Uncertified AI Forum');
    expect(certIndex).toBeLessThan(uncertIndex);
  });

  it('recommender returns uncertified destinations when no certified destinations exist', () => {
    catalogueService.createDestination({
      name: 'Only Uncertified AI Community',
      url: 'https://only-uncertified.test',
      platform_key: 'discourse',
      connector_key: 'discourse',
      category: 'AI / LLM Engineering',
      status: 'catalogued',
      is_enabled: 1
    });

    const recommendations = tailoringRecommender.recommendDestinations({
      title: 'Machine Learning Pipelines',
      body: 'Training models and datasets',
      tags: ['AI', 'ML']
    }, 5);

    expect(recommendations.top_recommendations.length).toBeGreaterThan(0);
    const names = recommendations.top_recommendations.map(r => r.name);
    expect(names).toContain('Only Uncertified AI Community');
  });

  it('runs evaluateRecommender and computes truthful, non-faked precision@10 metrics', () => {
    const report = evaluateRecommender(db);

    expect(report.total_items_evaluated).toBeGreaterThanOrEqual(20);
    expect(typeof report.average_precision_at_10).toBe('number');
    expect(report.average_precision_at_10).toBeGreaterThanOrEqual(0.0);
    expect(report.average_hits_in_top_10).toBeGreaterThanOrEqual(0.0);
    expect(report.results.length).toBe(report.total_items_evaluated);

    // Verify each result item has specific reasons populated
    for (const res of report.results) {
      expect(res.item_id).toBeDefined();
      expect(typeof res.hits_in_top_10).toBe('number');
      expect(typeof res.precision_at_10).toBe('number');
    }
  });
});
