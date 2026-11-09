import { describe, it, expect } from 'vitest';
import { buildOutputManifest, getSourcesLicensingMetadata } from '../../src/utils/manifest.js';

describe('Output Manifest Unit Tests', () => {
  it('builds a compliant output manifest with dynamic licensing, seed reason, and AI marking', () => {
    const startTime = Date.now() - 500;
    const endTime = Date.now();

    const manifest = buildOutputManifest({
      connectorKey: 'discourse',
      startTime,
      endTime,
      warnings: ['Post required word boundary truncation', 'Auto-appended AI disclosure phrase'],
      isAiGenerated: true,
      aiDisclosureAdded: true,
      aiDisclosureText: '🤖 AI-assisted content',
      settings: {
        destination_id: 'dest_test_123',
        platform_key: 'discourse'
      }
    });

    // 1. Version & Generator
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.generator).toContain('IncuBrix');
    expect(manifest.connector.key).toBe('discourse');

    // 2. Models and Providers Actually Used
    expect(manifest.models_and_providers).toBeDefined();
    expect(manifest.models_and_providers.provider).toBeDefined();
    expect(manifest.models_and_providers.version).toBeDefined();
    expect(manifest.models_and_providers.model).toBeDefined();

    // 3. Mark anything AI-generated
    expect(manifest.content_classification.is_ai_generated).toBe(true);
    expect(manifest.content_classification.disclosure_added).toBe(true);
    expect(manifest.content_classification.disclosure_text).toBe('🤖 AI-assisted content');

    // 4. Seed with explicit reason when not applicable
    expect(manifest.seed).toBeDefined();
    expect(manifest.seed.value).toBeNull();
    expect(manifest.seed.reason).toBeDefined();

    // 5. Timings & Cost estimate
    expect(manifest.timings.duration_ms).toBeGreaterThanOrEqual(500);
    expect(manifest.cost_estimate).toBeDefined();
    expect(manifest.cost_estimate.unit).toBe('per_publication');
    expect(manifest.cost_estimate.cost_usd).toBeGreaterThanOrEqual(0);
    expect(manifest.cost_estimate.cost_per_1000_usd).toBeGreaterThanOrEqual(0);

    // 6. Populated Warnings from job
    expect(manifest.warnings).toHaveLength(2);
    expect(manifest.warnings[0]).toBe('Post required word boundary truncation');

    // 7. Dynamic Licensing Block built from SOURCES.md
    expect(manifest.licensing).toBeDefined();
    expect(manifest.licensing.commercial_use_allowed).toBe(true);
    expect(manifest.licensing.agpl_free).toBe(true);
    expect(manifest.licensing.declared_licenses).toContain('MIT');
    expect(manifest.licensing.source_reference).toBe('SOURCES.md');
  });

  it('supports explicit seed when specified', () => {
    const manifest = buildOutputManifest({
      connectorKey: 'lemmy',
      startTime: Date.now(),
      seed: 42
    });

    expect(manifest.seed.value).toBe(42);
    expect(manifest.seed.deterministic).toBe(true);
  });

  it('correctly reads licensing metadata from SOURCES.md', () => {
    const meta = getSourcesLicensingMetadata();
    expect(meta.declared_licenses.length).toBeGreaterThan(0);
    expect(meta.commercial_use_allowed).toBe(true);
    expect(meta.agpl_free).toBe(true);
  });
});
