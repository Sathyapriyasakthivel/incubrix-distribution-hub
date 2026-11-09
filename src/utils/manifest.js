import fs from 'node:fs';
import path from 'node:path';
import config from '../config/index.js';

let cachedSourcesMetadata = null;

/**
 * Extracts licensing metadata directly from SOURCES.md
 */
export function getSourcesLicensingMetadata() {
  if (cachedSourcesMetadata) return cachedSourcesMetadata;

  try {
    const sourcesPath = path.resolve(process.cwd(), 'SOURCES.md');
    if (fs.existsSync(sourcesPath)) {
      const content = fs.readFileSync(sourcesPath, 'utf8');
      const licenseMatches = [...content.matchAll(/\|\s*`?[^|]+`?\s*\|\s*`?[^|]+`?\s*\|\s*([A-Za-z0-9.-]+(?:\s*\([^)]+\))?)\s*\|/g)];
      const uniqueLicenses = [...new Set(licenseMatches.map(m => m[1].trim()).filter(l => l && l !== 'License'))];

      const hasAgpl = /AGPL/i.test(content) && !/no AGPL/i.test(content);
      const commercialPermitted = /commercially usable|Fully Permitted/i.test(content);

      cachedSourcesMetadata = {
        declared_licenses: uniqueLicenses.length > 0 ? uniqueLicenses : ['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause'],
        commercial_use_allowed: commercialPermitted,
        agpl_free: !hasAgpl,
        source_reference: 'SOURCES.md'
      };
      return cachedSourcesMetadata;
    }
  } catch {}

  cachedSourcesMetadata = {
    declared_licenses: ['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause'],
    commercial_use_allowed: true,
    agpl_free: true,
    source_reference: 'SOURCES.md'
  };
  return cachedSourcesMetadata;
}

/**
 * Builds an IncuBrix Output Manifest with warnings, timings, and metadata.
 * @param {Object} params
 * @param {string} params.connectorKey
 * @param {number} params.startTime
 * @param {number} [params.endTime]
 * @param {Array} [params.warnings]
 * @param {Object} [params.settings]
 * @param {Object} [params.aiModelInfo]
 * @param {*} [params.seed]
 * @param {boolean} [params.isAiGenerated]
 * @param {boolean} [params.aiDisclosureAdded]
 * @param {string} [params.aiDisclosureText]
 * @returns {Object} JSON manifest
 */
export function buildOutputManifest({
  connectorKey,
  startTime,
  endTime = Date.now(),
  warnings = [],
  settings = {},
  aiModelInfo = null,
  seed = null,
  isAiGenerated = false,
  aiDisclosureAdded = false,
  aiDisclosureText = null
} = {}) {
  const durationMs = Math.max(0, endTime - startTime);

  // Dynamic licensing metadata derived from SOURCES.md
  const licensingMetadata = getSourcesLicensingMetadata();

  const provider = aiModelInfo?.provider || process.env.RULES_AI_PROVIDER || config.ai.provider || 'mock';
  const model = aiModelInfo?.model || process.env.RULES_AI_MODEL || (provider === 'mock' ? 'deterministic-heuristic' : 'gpt-4o');
  const providerVersion = aiModelInfo?.version || '1.0.0';

  const providerInfo = {
    provider,
    model,
    version: providerVersion,
    is_commercial_licensed: licensingMetadata.commercial_use_allowed
  };

  // Cost estimation: per 1,000 publications
  // Heuristic / Mock cost: $0.00. Hosted LLM cost: ~$0.0002 per publication ($0.20 per 1,000)
  const estimatedCostUsd = provider === 'mock' ? 0.00 : 0.0002;

  // Content classification (marking AI-generated content explicitly)
  const isAi = Boolean(isAiGenerated);
  const contentClassification = {
    is_ai_generated: isAi,
    marked_as_ai: isAi,
    disclosure_added: Boolean(aiDisclosureAdded),
    disclosure_text: aiDisclosureText || (isAi ? '🤖 AI-assisted content' : null),
    generation_method: isAi ? 'ai_assisted' : 'human_authored'
  };

  // Seed handling: explicitly explain null when not applicable
  const seedBlock = (seed !== null && seed !== undefined)
    ? { value: seed, deterministic: true }
    : { value: null, reason: 'Deterministic heuristic execution, non-stochastic model' };

  return {
    version: '1.0.0',
    generator: 'IncuBrix Long-Tail Distribution Network Engine',
    timestamp: new Date().toISOString(),
    connector: {
      key: connectorKey,
      execution_time_ms: durationMs
    },
    models_and_providers: providerInfo,
    content_classification: contentClassification,
    seed: seedBlock,
    settings: {
      environment: config.env,
      simulation: config.simulation.defaultEnabled,
      ...settings
    },
    timings: {
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date(endTime).toISOString(),
      duration_ms: durationMs
    },
    cost_estimate: {
      unit: 'per_publication',
      cost_usd: estimatedCostUsd,
      cost_per_1000_usd: Number((estimatedCostUsd * 1000).toFixed(4)),
      currency: 'USD'
    },
    warnings: warnings || [],
    licensing: licensingMetadata
  };
}

export default buildOutputManifest;
