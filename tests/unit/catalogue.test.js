import { describe, it, expect, beforeEach } from 'vitest';
import { CatalogueService, normalizeUrl } from '../../src/services/catalogue/catalogueService.js';
import { initDatabase } from '../../src/database/db.js';
import { runMigrations } from '../../src/database/migrate.js';
import { IncuBrixError } from '../../src/utils/errors.js';

describe('Destination Catalogue Unit Tests', () => {
  let db;
  let service;

  beforeEach(() => {
    db = initDatabase(':memory:');
    runMigrations(db);
    service = new CatalogueService(db);
  });

  it('normalizeUrl cleans and normalizes domains and paths', () => {
    expect(normalizeUrl('https://Community.OpenAI.com/')).toBe('https://community.openai.com');
    expect(normalizeUrl('HTTP://dev.to/articles///')).toBe('http://dev.to/articles');
  });

  it('Creates and retrieves a destination configuration', () => {
    const dest = service.createDestination({
      name: 'Test Discourse Forum',
      url: 'https://forum.example.com',
      platform_key: 'discourse',
      category: 'AI',
      relevance_score: 4
    });

    expect(dest.id).toBeDefined();
    expect(dest.name).toBe('Test Discourse Forum');
    expect(dest.status).toBe('uncertified');

    const fetched = service.getDestination(dest.id);
    expect(fetched.name).toBe('Test Discourse Forum');
    expect(fetched.relevance_score).toBe(4);
  });

  it('Rejects duplicate destination with same platform and normalized URL', () => {
    service.createDestination({
      name: 'First Instance',
      url: 'https://community.example.com',
      platform_key: 'discourse'
    });

    expect(() => {
      service.createDestination({
        name: 'Duplicate Instance',
        url: 'https://community.example.com/',
        platform_key: 'discourse'
      });
    }).toThrow(IncuBrixError);
  });

  it('Imports CSV with row-by-row validation and reports bad rows', async () => {
    const csvContent = `name,url,platform_key,category
Valid Community,https://valid.example.com,discourse,AI
,https://missing-name.com,lemmy,Tech
Valid Lemmy,https://lemmy.example.org,lemmy,Fediverse`;

    const result = await service.importCsv(csvContent);
    expect(result.total_rows).toBe(3);
    expect(result.imported_count).toBe(2);
    expect(result.error_count).toBe(1);
    expect(result.errors[0].row).toBe(3); // row 3 has missing name
  });

  describe('Real Catalogue Verification', () => {
    it('seeds exactly 150 real, verified-reachable destinations with zero synthetic examples', async () => {
      const { generateFullDestinationCatalogue } = await import('../../src/database/seeds/destinationsData.js');
      const catalogue = generateFullDestinationCatalogue();

      // Exactly 150 verified-reachable rows in catalogue
      expect(catalogue.length).toBe(150);

      // Verify no synthetic example.org or example.com domains
      const synthetic = catalogue.filter(d =>
        d.url.includes('example.org') ||
        d.url.includes('example.com') ||
        d.url.includes('.example') ||
        d.name.includes('Destination #')
      );
      expect(synthetic).toHaveLength(0);

      // Verify every row has L0 status until certified
      for (const dest of catalogue) {
        expect(dest.level).toBe('L0');
        expect(dest.url).toMatch(/^https?:\/\//);
        if (dest.rules_url) {
          expect(dest.rules_url).toMatch(/^https?:\/\//);
        }
        expect(dest.source_url).toMatch(/^https?:\/\//);
        expect(dest.researched_at).toBeDefined();
        expect(dest.relevance_score).toBeGreaterThanOrEqual(1);
        expect(dest.relevance_score).toBeLessThanOrEqual(5);
        expect(dest.relevance_reason).toBeTruthy();
      }

      // Verify exactly the 14 destinations with accessible rules pages have rules_url populated
      const researched = catalogue.filter(d => d.rules_url);
      expect(researched.length).toBe(14);
      for (const dest of researched) {
        expect(dest.rules_url).toMatch(/^https?:\/\//);
        expect(dest.source_url).toMatch(/^https?:\/\//);
        expect(dest.researched_at).toBeDefined();
        // Honest pass: rules pages fetched do not prescribe frequency caps or binary flags; left null
        expect(dest.frequency_cap).toBeNull();
        expect(dest.self_promo_allowed).toBeNull();
        expect(dest.link_policy).toBeNull();
        expect(dest.disclosure_required).toBeNull();
      }

      // Verify unresearched rows have empty rule fields
      const unresearched = catalogue.filter(d => !d.rules_url);
      expect(unresearched.length).toBe(136);
      for (const dest of unresearched) {
        expect(dest.frequency_cap).toBeNull();
        expect(dest.self_promo_allowed).toBeNull();
        expect(dest.link_policy).toBeNull();
        expect(dest.disclosure_required).toBeNull();
      }

      // Verify inclusion of non-English communities
      const nonEnglish = catalogue.filter(d => d.language && d.language !== 'en');
      expect(nonEnglish.length).toBeGreaterThanOrEqual(10);
      const languages = new Set(nonEnglish.map(d => d.language));
      expect(languages.has('de')).toBe(true);
      expect(languages.has('fr')).toBe(true);
      expect(languages.has('ja')).toBe(true);
      expect(languages.has('es')).toBe(true);
      expect(languages.has('pt')).toBe(true);
    });

    it('ensureCatalogue150Loaded idempotently imports 150 destinations with status catalogued and null rule fields', () => {
      // Seed pre-existing local destinations first
      const now = new Date().toISOString();
      db.run("INSERT INTO destinations (id, name, url, platform_key, connector_key, simulation_mode, status, created_at, updated_at) VALUES ('local-ghost', 'Local Ghost', 'http://localhost:2368', 'ghost', 'ghost', 0, 'catalogued', ?, ?)", now, now);
      db.run("INSERT INTO destinations (id, name, url, platform_key, connector_key, simulation_mode, status, created_at, updated_at) VALUES ('local-lemmy', 'Local Lemmy', 'http://localhost:8536', 'lemmy', 'lemmy', 0, 'catalogued', ?, ?)", now, now);

      const initialCount = db.get('SELECT COUNT(*) as count FROM destinations').count;
      expect(initialCount).toBe(2);

      // First run loads from CSV
      const firstRun = service.ensureCatalogue150Loaded();
      expect(firstRun.loaded).toBe(150);
      expect(firstRun.skipped).toBe(0);

      // Verify status is 'catalogued'
      const rows = db.query("SELECT * FROM destinations WHERE id NOT IN ('local-ghost', 'local-lemmy')");
      expect(rows.length).toBe(150);
      for (const r of rows) {
        expect(r.status).toBe('catalogued');
        // Unknown rule fields are left blank / null
        expect(r.frequency_cap).toBeNull();
        expect(r.self_promo_allowed).toBeNull();
        expect(r.link_policy).toBeNull();
        expect(r.disclosure_required).toBeNull();
        expect(r.automation_allowed).toBeNull();
      }

      // Pre-existing local destinations remain intact
      const ghost = db.get("SELECT * FROM destinations WHERE id = 'local-ghost'");
      expect(ghost).toBeDefined();
      expect(ghost.simulation_mode).toBe(0);

      // Second run is idempotent (0 loaded, 150 skipped)
      const secondRun = service.ensureCatalogue150Loaded();
      expect(secondRun.loaded).toBe(0);
      expect(secondRun.skipped).toBe(150);

      const totalCount = db.get('SELECT COUNT(*) as count FROM destinations').count;
      expect(totalCount).toBe(152);
    });
  });
});
