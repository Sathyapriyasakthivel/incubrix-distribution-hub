import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, setDatabase } from '../../src/database/db.js';
import { runMigrations } from '../../src/database/migrate.js';
import catalogueService from '../../src/services/catalogue/catalogueService.js';
import { CertificationHarness } from '../../src/services/certification/certificationHarness.js';
import AssistedConnector from '../../src/connectors/assisted/AssistedConnector.js';

describe('Assisted Connector Certification & Pack Validation (P1-A)', () => {
  let db;
  let certHarness;

  beforeEach(() => {
    db = initDatabase(':memory:');
    runMigrations(db);
    setDatabase(db);
    catalogueService.db = db;
    certHarness = new CertificationHarness(db);
  });

  afterEach(() => {
    if (db) db.close();
    setDatabase(null);
  });

  it('buildAssistPack contains title, body, tags, destination rules, instructions, deep link, and disclosure text', async () => {
    const connector = new AssistedConnector();
    const destination = {
      id: 'dest_assisted_forum',
      name: 'Designer News Community',
      url: 'https://news.layervault.com',
      platform_key: 'assisted',
      rules_url: 'https://news.layervault.com/guidelines',
      frequency_cap: '1/3d',
      self_promo_allowed: 0,
      link_policy: 'max_1',
      disclosure_required: 1,
      automation_allowed: 0
    };

    const rendition = {
      title: 'Automating Design Handoffs in 2026',
      body: 'Comprehensive guide to bridging design tokens with continuous integration.',
      tags: ['Design', 'Automation', 'Frontend'],
      canonical_url: 'https://incubrix.internal/design/handoff-automation',
      is_ai_generated: true,
      is_promotional: false
    };

    const pack = await connector.buildAssistPack(rendition, destination, 'test_idem_pack_01');

    // Verify all required fields from prompt
    expect(pack).toHaveProperty('title', rendition.title);
    expect(pack.body).toContain(rendition.body);
    expect(pack.tags).toEqual(['Design', 'Automation', 'Frontend']);
    expect(pack.destination_rules).toMatchObject({
      rules_url: 'https://news.layervault.com/guidelines',
      frequency_cap: '1/3d',
      self_promo_allowed: 0,
      link_policy: 'max_1',
      disclosure_required: true,
      automation_allowed: 0
    });
    expect(pack.posting_instructions).toBeInstanceOf(Array);
    expect(pack.posting_instructions.length).toBeGreaterThan(0);
    expect(pack.deep_link).toBe('https://news.layervault.com');
    expect(pack.disclosure_text).toContain('AI Disclosure:');
    expect(pack.body).toContain('AI Disclosure:');
    expect(pack.files).toHaveLength(2);

    // Verify idempotent regeneration produces exact same pack_id and contents
    const regenPack = await connector.buildAssistPack(rendition, destination, 'test_idem_pack_01');
    expect(regenPack.pack_id).toBe(pack.pack_id);
    expect(regenPack.body).toBe(pack.body);
    expect(regenPack.files[0].download_url).toBe(pack.files[0].download_url);
  });

  it('Full 10-step certification passes for assisted connector and awards level L1', async () => {
    const dest = catalogueService.createDestination({
      id: 'dest_test_assisted_cert',
      name: 'Assisted Publishing Destination',
      url: 'https://community.openai.com',
      platform_key: 'assisted',
      connector_key: 'assisted',
      simulation_mode: 1,
      disclosure_required: 1,
      self_promo_allowed: 0,
      status: 'catalogued'
    });

    const result = await certHarness.certifyDestination(dest.id, { strictDeleteVerify: true });

    expect(result.status).toBe('certified');
    expect(result.level).toBe('L1');
    expect(result.steps).toHaveLength(10);

    const step5 = result.steps.find(s => s.step === 5);
    expect(step5.status).toBe('passed');
    expect(step5.details.idempotent_regeneration_verified).toBe(true);

    const step6 = result.steps.find(s => s.step === 6);
    expect(step6.status).toBe('passed');
    expect(step6.details.retrieved_status).toBe('assisted_pack_ready');

    const step8 = result.steps.find(s => s.step === 8);
    expect(step8.status).toBe('passed');
  });
});
