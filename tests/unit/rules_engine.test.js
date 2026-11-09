import { describe, it, expect, beforeEach } from 'vitest';
import { PostingRulesEngine, parseFrequencyCap } from '../../src/services/rules/rulesEngine.js';
import { initDatabase } from '../../src/database/db.js';
import { runMigrations } from '../../src/database/migrate.js';
import registry from '../../src/connectors/ConnectorRegistry.js';

describe('Posting Rules Engine Unit Tests', () => {
  let db;
  let engine;

  beforeEach(() => {
    // Fresh in-memory database for isolated unit testing
    db = initDatabase(':memory:');
    runMigrations(db);
    engine = new PostingRulesEngine(db);
  });

  it('parseFrequencyCap correctly parses units and returns null for empty/invalid', () => {
    expect(parseFrequencyCap('1/7d')).toEqual({ maxPosts: 1, windowHours: 168 });
    expect(parseFrequencyCap('2/24h')).toEqual({ maxPosts: 2, windowHours: 24 });
    expect(parseFrequencyCap('3/1d')).toEqual({ maxPosts: 3, windowHours: 24 });
    expect(parseFrequencyCap(null)).toBeNull();
    expect(parseFrequencyCap('')).toBeNull();
    expect(parseFrequencyCap('   ')).toBeNull();
    expect(parseFrequencyCap('invalid')).toBeNull();
  });

  it('Null or empty frequency_cap means no cap (never crashes or blocks)', () => {
    const destination = {
      id: 'dest_no_cap',
      name: 'Uncapped Forum',
      platform_key: 'discourse',
      connector_key: 'discourse',
      status: 'certified',
      is_enabled: 1,
      frequency_cap: null,
      self_promo_allowed: 1,
      link_policy: 'allowed',
      disclosure_required: 0
    };

    const res1 = engine.evaluate({ title: 'Topic', body: 'Valid body text for post' }, destination);
    expect(res1.decision).toBe('ALLOW');

    destination.frequency_cap = '';
    const res2 = engine.evaluate({ title: 'Topic', body: 'Valid body text for post' }, destination);
    expect(res2.decision).toBe('ALLOW');
  });

  it('Allows compliant post to certified destination', () => {
    const destination = {
      id: 'dest_test_1',
      name: 'Compliant Forum',
      platform_key: 'discourse',
      connector_key: 'discourse',
      status: 'certified',
      is_enabled: 1,
      frequency_cap: '1/7d',
      self_promo_allowed: 1,
      link_policy: 'allowed',
      disclosure_required: 0,
      max_title_chars: 255,
      max_body_chars: 32000
    };

    const rendition = {
      title: 'Valid Discussion Topic',
      body: 'This is a high quality body text without any rule infringements.',
      is_promotional: false,
      is_ai_generated: false
    };

    const result = engine.evaluate(rendition, destination);
    expect(result.decision).toBe('ALLOW');
    expect(result.violations.length).toBe(0);
  });

  it('Enforces certification status: blocks non-certified with DEST_NOT_CERTIFIED and demoted with DEST_DEMOTED', () => {
    const uncertDest = {
      id: 'dest_uncert',
      name: 'Uncertified Forum',
      platform_key: 'discourse',
      connector_key: 'discourse',
      status: 'catalogued',
      is_enabled: 1
    };

    const resUncert = engine.evaluate({ title: 'Valid', body: 'Valid body content' }, uncertDest);
    expect(resUncert.decision).toBe('BLOCK');
    expect(resUncert.triggered_rules).toContain('DEST_NOT_CERTIFIED');

    const demotedDest = {
      id: 'dest_demoted',
      name: 'Demoted Forum',
      platform_key: 'discourse',
      connector_key: 'discourse',
      status: 'demoted',
      is_enabled: 1
    };

    const resDemoted = engine.evaluate({ title: 'Valid', body: 'Valid body content' }, demotedDest);
    expect(resDemoted.decision).toBe('BLOCK');
    expect(resDemoted.triggered_rules).toContain('DEST_DEMOTED');
  });

  it('Blocks post when self-promotion is banned and post is marked promotional (DEST_RULE_SELF_PROMO)', () => {
    const destination = {
      id: 'dest_test_2',
      name: 'Strict Academic Forum',
      platform_key: 'discourse',
      connector_key: 'discourse',
      status: 'certified',
      is_enabled: 1,
      frequency_cap: '1/7d',
      self_promo_allowed: 0, // strictly banned
      link_policy: 'allowed',
      disclosure_required: 0
    };

    const rendition = {
      title: 'Check out our new SaaS product launch',
      body: 'Buy our new subscription service at discounted pricing.',
      is_promotional: true,
      is_ai_generated: false
    };

    const result = engine.evaluate(rendition, destination);
    expect(result.decision).toBe('BLOCK');
    expect(result.triggered_rules).toContain('DEST_RULE_SELF_PROMO');
  });

  it('Enforces link restrictions (DEST_RULE_LINK_POLICY)', () => {
    const destinationNoLinks = {
      id: 'dest_test_3',
      name: 'No Link Community',
      platform_key: 'lemmy',
      connector_key: 'lemmy',
      status: 'certified',
      is_enabled: 1,
      link_policy: 'no_links'
    };

    const resNoLinks = engine.evaluate({
      title: 'Title',
      body: 'Here is a link https://example.com to read.',
      is_promotional: false
    }, destinationNoLinks);

    expect(resNoLinks.decision).toBe('BLOCK');
    expect(resNoLinks.triggered_rules).toContain('DEST_RULE_LINK_POLICY');

    const destinationMax1 = {
      id: 'dest_test_4',
      name: 'Max 1 Link Community',
      platform_key: 'lemmy',
      connector_key: 'lemmy',
      status: 'certified',
      is_enabled: 1,
      link_policy: 'max_1'
    };

    const resMax1 = engine.evaluate({
      title: 'Title',
      body: 'Link one: https://one.com and link two: https://two.com',
      is_promotional: false
    }, destinationMax1);

    expect(resMax1.decision).toBe('BLOCK');
    expect(resMax1.triggered_rules).toContain('DEST_RULE_LINK_POLICY');
  });

  it('Enforces AI disclosure on explicit ai_disclosure field or required phrase, auto-adds with tailor: true', () => {
    const destination = {
      id: 'dest_test_5',
      name: 'AI Transparent Forum',
      platform_key: 'ghost',
      connector_key: 'ghost',
      status: 'certified',
      is_enabled: 1,
      disclosure_required: 1,
      required_disclosure_phrase: '[AI Disclosure: Content generated with AI]'
    };

    // Missing explicit disclosure and tailor is false -> BLOCK with DEST_RULE_AI_DISCLOSURE
    const noDisclosure = engine.evaluate({
      title: 'Synthesized Blog Post',
      body: 'Generated essay without disclaimer.',
      is_ai_generated: true,
      tailor: false
    }, destination);

    expect(noDisclosure.decision).toBe('BLOCK');
    expect(noDisclosure.triggered_rules).toContain('DEST_RULE_AI_DISCLOSURE');

    // Explicit ai_disclosure field provided -> ALLOW
    const withExplicitField = engine.evaluate({
      title: 'Synthesized Blog Post',
      body: 'Full article content.',
      is_ai_generated: true,
      ai_disclosure: true
    }, destination);

    expect(withExplicitField.decision).toBe('ALLOW');

    // With tailor: true -> Auto-adds required disclosure phrase and reports warning
    const withTailor = engine.evaluate({
      title: 'Synthesized Blog Post',
      body: 'Draft content for post.',
      is_ai_generated: true,
      tailor: true
    }, destination);

    expect(withTailor.decision).toBe('ALLOW');
    expect(withTailor.warnings.length).toBeGreaterThan(0);
    expect(withTailor.warnings[0]).toContain('Auto-applied required AI disclosure');
  });

  it('Reschedules post when frequency cap is exceeded (DEST_RULE_FREQUENCY_CAP)', () => {
    const destination = {
      id: 'dest_test_freq',
      name: 'Capped Destination',
      platform_key: 'discourse',
      connector_key: 'discourse',
      status: 'certified',
      is_enabled: 1,
      frequency_cap: '1/7d' // 1 per 7 days
    };

    const now = new Date().toISOString();
    db.run(`
      INSERT INTO destinations (id, name, url, platform_key, connector_key, status, created_at, updated_at)
      VALUES ('dest_test_freq', 'Capped Destination', 'https://capped.example', 'discourse', 'discourse', 'certified', ?, ?)
    `, now, now);

    db.run(`
      INSERT INTO publications (id, destination_id, connector_key, title, body, status, created_at, updated_at)
      VALUES ('pub_1', 'dest_test_freq', 'discourse', 'Recent Post', 'Body', 'succeeded', ?, ?)
    `, now, now);

    const result = engine.evaluate({
      title: 'Second Post Too Soon',
      body: 'Trying to post inside cap window'
    }, destination);

    expect(result.decision).toBe('RESCHEDULE');
    expect(result.triggered_rules).toContain('DEST_RULE_FREQUENCY_CAP');
    expect(result.retry_at).not.toBeNull();
  });

  it('Certification test posts do NOT count toward the frequency cap', () => {
    const destination = {
      id: 'dest_test_cert_cap',
      name: 'Cert Test Destination',
      platform_key: 'discourse',
      connector_key: 'discourse',
      status: 'certified',
      is_enabled: 1,
      frequency_cap: '1/7d' // 1 per 7 days
    };

    const now = new Date().toISOString();
    db.run(`
      INSERT INTO destinations (id, name, url, platform_key, connector_key, status, created_at, updated_at)
      VALUES ('dest_test_cert_cap', 'Cert Test Destination', 'https://certcap.example', 'discourse', 'discourse', 'certified', ?, ?)
    `, now, now);

    // Insert a certification test post in publications
    db.run(`
      INSERT INTO publications (id, destination_id, connector_key, title, body, status, created_at, updated_at)
      VALUES ('pub_cert_test', 'dest_test_cert_cap', 'discourse', '[CERTIFICATION-TEST] IncuBrix Test Run 123456', 'Test Body', 'succeeded', ?, ?)
    `, now, now);

    // Now evaluate regular user post - must NOT be capped!
    const result = engine.evaluate({
      title: 'Real User Article',
      body: 'This is the first real user article after certification run'
    }, destination);

    expect(result.decision).toBe('ALLOW');
  });

  it('Enforces BLOCK over RESCHEDULE precedence when both frequency cap and content rule are violated', () => {
    const destination = {
      id: 'dest_precedence_test',
      name: 'Precedence Test Destination',
      platform_key: 'discourse',
      connector_key: 'discourse',
      status: 'certified',
      is_enabled: 1,
      frequency_cap: '1/7d',
      self_promo_allowed: 0 // strictly banned promo
    };

    const now = new Date().toISOString();
    db.run(`
      INSERT INTO destinations (id, name, url, platform_key, connector_key, status, created_at, updated_at)
      VALUES ('dest_precedence_test', 'Precedence Test Destination', 'https://prec.example', 'discourse', 'discourse', 'certified', ?, ?)
    `, now, now);

    // Insert an existing publication to trigger frequency cap
    db.run(`
      INSERT INTO publications (id, destination_id, connector_key, title, body, status, created_at, updated_at)
      VALUES ('pub_existing', 'dest_precedence_test', 'discourse', 'Existing Post', 'Body', 'succeeded', ?, ?)
    `, now, now);

    // Try posting promotional content (which should BLOCK) while also exceeding frequency cap (which would RESCHEDULE)
    const result = engine.evaluate({
      title: 'Promotional SaaS Post',
      body: 'Check out our paid SaaS discount code!',
      is_promotional: true
    }, destination);

    // Precedence rule: BLOCK MUST NEVER be overwritten by RESCHEDULE
    expect(result.decision).toBe('BLOCK');
    expect(result.triggered_rules).toContain('DEST_RULE_SELF_PROMO');
    expect(result.triggered_rules).toContain('DEST_RULE_FREQUENCY_CAP');
  });

  it('Blocks post when connector kill-switch is active', () => {
    registry.disable('ghost');

    const destination = {
      id: 'dest_test_kill',
      name: 'Ghost Blog',
      platform_key: 'ghost',
      connector_key: 'ghost',
      status: 'certified',
      is_enabled: 1
    };

    const result = engine.evaluate({ title: 'Post', body: 'Body' }, destination);
    expect(result.decision).toBe('BLOCK');
    expect(result.triggered_rules).toContain('CONNECTOR_DISABLED');

    registry.enable('ghost');
  });
});
