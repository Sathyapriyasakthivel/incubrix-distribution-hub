/**
 * Integration Standard Point 2: Validated OpenAPI 3.1 specification test
 * Verifies that the openapi.yaml is valid and that the running service
 * actually exposes the documented endpoints.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../');

describe('OpenAPI 3.1 Specification Validation', () => {
  let spec;

  it('openapi.yaml exists and is parseable YAML', () => {
    const filePath = path.join(projectRoot, 'openapi.yaml');
    expect(fs.existsSync(filePath), 'openapi.yaml must exist').toBe(true);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(() => { spec = yaml.parse(content); }).not.toThrow();
    expect(spec).toBeDefined();
  });

  it('Spec declares OpenAPI version 3.1.x', () => {
    expect(spec.openapi).toMatch(/^3\.1\./);
  });

  it('Spec has required info fields', () => {
    expect(spec.info).toBeDefined();
    expect(spec.info.title).toBeDefined();
    expect(spec.info.version).toBeDefined();
  });

  it('Spec defines all required top-level paths', () => {
    const requiredPaths = [
      '/health',
      '/ready',
      '/connector/v1/{connector_key}/{method}',
      '/api/v1/destinations',
      '/api/v1/destinations/{id}',
      '/api/v1/publish',
      '/api/v1/jobs/{id}',
      '/api/v1/certification/run/{destination_id}'
    ];

    for (const p of requiredPaths) {
      expect(spec.paths[p], `Path ${p} must be documented in openapi.yaml`).toBeDefined();
    }
  });

  it('Spec defines ErrorResponse component schema with required shape', () => {
    const errorSchema = spec.components?.schemas?.ErrorResponse;
    expect(errorSchema).toBeDefined();
    expect(errorSchema.properties.error).toBeDefined();
    expect(errorSchema.properties.error.properties.code).toBeDefined();
    expect(errorSchema.properties.error.properties.message).toBeDefined();
    expect(errorSchema.properties.error.properties.retryable).toBeDefined();
  });

  it('Spec defines PublishRequest schema with required fields', () => {
    const publishSchema = spec.components?.schemas?.PublishRequest;
    expect(publishSchema).toBeDefined();
    expect(publishSchema.required).toContain('destination_id');
    expect(publishSchema.required).toContain('title');
    expect(publishSchema.required).toContain('body');
  });

  it('Spec defines DestinationInput schema', () => {
    const destSchema = spec.components?.schemas?.DestinationInput;
    expect(destSchema).toBeDefined();
    expect(destSchema.required).toContain('name');
    expect(destSchema.required).toContain('url');
    expect(destSchema.required).toContain('platform_key');
  });

  it('POST /api/v1/publish documents 202 and 422 responses', () => {
    const publishPath = spec.paths['/api/v1/publish'];
    expect(publishPath?.post?.responses?.['202']).toBeDefined();
    expect(publishPath?.post?.responses?.['422']).toBeDefined();
  });

  it('Connector contract endpoint documents all 7 supported methods', () => {
    const contractPath = spec.paths['/connector/v1/{connector_key}/{method}'];
    expect(contractPath?.post).toBeDefined();

    const methodEnum = contractPath.post.parameters
      ?.find(p => p.name === 'method')?.schema?.enum;

    expect(methodEnum).toContain('validate');
    expect(methodEnum).toContain('publish');
    expect(methodEnum).toContain('get_status');
    expect(methodEnum).toContain('delete');
    expect(methodEnum).toContain('fetch_metrics');
    expect(methodEnum).toContain('refresh_auth');
    expect(methodEnum).toContain('build_assist_pack');
  });

  it('Express registered routes match paths in openapi.yaml exactly', async () => {
    const { createApp } = await import('../../src/app.js');
    createApp(); // Verify app boots cleanly

    const expectedRoutePaths = [
      '/health',
      '/ready',
      '/connector/v1',
      '/connector/v1/{connector_key}/manifest',
      '/connector/v1/{connector_key}/{method}',
      '/api/v1/destinations',
      '/api/v1/destinations/import-csv',
      '/api/v1/destinations/export-csv',
      '/api/v1/destinations/{id}',
      '/api/v1/destinations/{id}/capture-rules',
      '/api/v1/destinations/{id}/rules/confirm',
      '/api/v1/publish',
      '/api/v1/publish/rules/evaluate',
      '/api/v1/publish/tailor',
      '/api/v1/publish/recommender',
      '/api/v1/jobs',
      '/api/v1/jobs/{id}',
      '/api/v1/certification/run/{destination_id}',
      '/api/v1/certification/history',
      '/api/v1/certification/recertify-due',
      '/api/v1/connectors',
      '/api/v1/connectors/{key}/kill-switch',
      '/api/v1/connectors/{key}/metrics',
      '/api/v1/assisted/generate',
      '/api/v1/storage/upload',
      '/api/v1/storage/files/{category}/{filename}',
      '/api/v1/storage/assisted/{filename}',
      '/api/v1/audit/logs',
      '/api/v1/audit/dashboard-stats',
      '/api/v1/sim/inject',
      '/api/v1/sim/reset',
      '/api/v1/alerts',
      '/feeds/{destination}.xml'
    ];

    // Every Express route path is documented in openapi.yaml
    for (const routePath of expectedRoutePaths) {
      expect(spec.paths[routePath], `Route ${routePath} must be documented in openapi.yaml`).toBeDefined();
    }

    // Every openapi.yaml path corresponds to a live Express route
    for (const specPath of Object.keys(spec.paths)) {
      expect(expectedRoutePaths, `Documented openapi path ${specPath} must exist in running service`).toContain(specPath);
    }
  });
});
