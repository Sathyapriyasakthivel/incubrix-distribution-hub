import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appJsPath = path.resolve(__dirname, '../../public/js/app.js');

describe('Dashboard Client Idempotency & POST Headers in public/js/app.js', () => {
  const appJsContent = fs.readFileSync(appJsPath, 'utf8');

  it('defines getFreshIdempotencyKey using crypto.randomUUID', () => {
    expect(appJsContent).toContain('function getFreshIdempotencyKey()');
    expect(appJsContent).toContain('crypto.randomUUID()');
  });

  it('ensures every fetch POST call includes an Idempotency-Key header', () => {
    // Regex matching fetch calls with method: 'POST'
    const fetchPostRegex = /fetch\(\s*`?\$\{?API_BASE\}?([^,`]+)`?,\s*\{[\s\S]*?method:\s*['"]POST['"][\s\S]*?\}\s*\)/g;
    let match;
    const postCalls = [];

    while ((match = fetchPostRegex.exec(appJsContent)) !== null) {
      const endpoint = match[1];
      const fetchBlock = match[0];
      postCalls.push({ endpoint, fetchBlock });
    }

    // Must find all dashboard POST endpoints
    expect(postCalls.length).toBeGreaterThanOrEqual(9);

    for (const { endpoint, fetchBlock } of postCalls) {
      expect(
        fetchBlock.includes('Idempotency-Key') || fetchBlock.includes('getFreshIdempotencyKey()'),
        `Expected POST call to ${endpoint} to include Idempotency-Key header`
      ).toBe(true);
    }
  });

  it('covers all 8 user-specified non-GET operations with Idempotency-Key', () => {
    const requiredEndpoints = [
      '/destinations',                  // create destination
      '/publish',                       // publish
      '/publish/tailor',                // tailor
      '/publish/rules/evaluate',        // rules pre-check
      '/certification/run/',            // certify
      '/publish/recommender',           // recommender
      '/assisted/generate',             // assisted generate
      '/kill-switch',                   // kill-switch
      '/destinations/import-csv'        // import
    ];

    for (const ep of requiredEndpoints) {
      expect(appJsContent, `Missing endpoint in app.js: ${ep}`).toContain(ep);
    }
  });

  it('does NOT set Content-Type manually on the multipart CSV import request', () => {
    // Extract the /destinations/import-csv fetch block
    const importRegex = /fetch\(\s*`\$\{API_BASE\}\/destinations\/import-csv`[\s\S]*?\n\s*\}\s*\)/;
    const match = appJsContent.match(importRegex);
    expect(match).not.toBeNull();

    const importBlock = match[0];
    expect(importBlock).toContain('Idempotency-Key');
    // Must NOT specify Content-Type in headers so the browser sets multipart/form-data boundary
    expect(importBlock).not.toContain("'Content-Type'");
    expect(importBlock).not.toContain('"Content-Type"');
  });

  it('updates workspace mode (LIVE vs simulation) and prompts confirmation for live destinations', () => {
    expect(appJsContent).toContain('function updateWorkspaceModeForDestination()');
    expect(appJsContent).toContain('Publish (LIVE)');
    expect(appJsContent).toContain('Publish (simulation)');
    expect(appJsContent).toContain('window.confirm(');
  });

  it('renders detailed WHY explanations in the Pre-Check rules result', () => {
    expect(appJsContent).toContain('Self-Promotion Policy (DEST_RULE_SELF_PROMO)');
    expect(appJsContent).toContain('Self-promotion is judged directly from the "Self-Promotional Material" checkbox flag');
    expect(appJsContent).toContain('self_promo_allowed');
    expect(appJsContent).toContain('disclosure_required');
    expect(appJsContent).toContain('frequency_cap');
    expect(appJsContent).toContain('link_policy');
  });
});

