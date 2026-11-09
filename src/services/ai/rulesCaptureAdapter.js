import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { getDatabase } from '../../database/db.js';
import logger from '../../utils/logger.js';
import { IncuBrixError } from '../../utils/errors.js';
import { safeFetch, checkRobotsTxt } from '../../utils/urlSecurity.js';

/**
 * Deterministic Mock Rules Capture Provider
 * Reads HTML/text, extracts structured posting rules with exact supporting quotes,
 * and computes dynamic confidence score based on quote completeness.
 */
export class MockRulesCaptureProvider {
  constructor() {
    this.name = 'mock';
    this.model = 'deterministic-rules-v1';
  }

  async parseContent(text) {
    // Strip HTML tags and normalize whitespace
    const cleanText = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    let frequencyCap = null;
    let selfPromoAllowed = 1;
    let linkPolicy = 'allowed';
    let disclosureRequired = 0;
    let automationAllowed = 1;

    const quotes = {};
    let matchesCount = 0;

    // 1. Frequency cap detection & quote
    const capMatch = cleanText.match(/(?:once every\s+(\d+)\s*(days|hours|d|h)|once per\s+(\d+)\s*(days|hours|d|h)|1\/(\d+)(d|h))/i);
    if (capMatch) {
      const sentence = this._extractSentence(cleanText, capMatch.index);
      quotes.frequency_cap = sentence;
      if (capMatch[1] && capMatch[2]) {
        frequencyCap = `1/${capMatch[1]}${capMatch[2].toLowerCase().startsWith('h') ? 'h' : 'd'}`;
      } else if (capMatch[3] && capMatch[4]) {
        frequencyCap = `1/${capMatch[3]}${capMatch[4].toLowerCase().startsWith('h') ? 'h' : 'd'}`;
      } else if (capMatch[5] && capMatch[6]) {
        frequencyCap = `1/${capMatch[5]}${capMatch[6].toLowerCase()}`;
      } else {
        frequencyCap = '1/7d';
      }
      matchesCount++;
    }

    // 2. Self promotion detection & quote
    if (/(?:strictly zero|no|prohibit(?:ed)?|zero)\s+(?:self-promotion|promotion|promotional)/i.test(cleanText)) {
      const idx = cleanText.search(/(?:strictly zero|no|prohibit(?:ed)?|zero)\s+(?:self-promotion|promotion|promotional)/i);
      quotes.self_promo_allowed = this._extractSentence(cleanText, idx);
      selfPromoAllowed = 0;
      matchesCount++;
    } else if (/(?:self[\s-]promotion is allowed|promotion is permitted|show & tell)/i.test(cleanText)) {
      const idx = cleanText.search(/(?:self[\s-]promotion is allowed|promotion is permitted|show & tell)/i);
      quotes.self_promo_allowed = this._extractSentence(cleanText, idx);
      selfPromoAllowed = 1;
      matchesCount++;
    }

    // 3. Link policy detection & quote
    if (/(?:external links are prohibited|no links allowed|links are not permitted)/i.test(cleanText)) {
      const idx = cleanText.search(/(?:external links are prohibited|no links allowed|links are not permitted)/i);
      quotes.link_policy = this._extractSentence(cleanText, idx);
      linkPolicy = 'no_links';
      matchesCount++;
    } else if (/(?:affiliate links are strictly forbidden|links are restricted|restricted to)/i.test(cleanText)) {
      const idx = cleanText.search(/(?:affiliate links are strictly forbidden|links are restricted|restricted to)/i);
      quotes.link_policy = this._extractSentence(cleanText, idx);
      linkPolicy = 'restricted';
      matchesCount++;
    } else if (/(?:links are allowed|permitted to include links)/i.test(cleanText)) {
      const idx = cleanText.search(/(?:links are allowed|permitted to include links)/i);
      quotes.link_policy = this._extractSentence(cleanText, idx);
      linkPolicy = 'allowed';
      matchesCount++;
    }

    // 4. AI disclosure detection & quote
    if (/(?:ai[\s-]generated.*(?:state|disclos|label)|automated.*requires.*disclosure|require_ai_disclosure)/i.test(cleanText)) {
      const idx = cleanText.search(/(?:ai[\s-]generated.*(?:state|disclos|label)|automated.*requires.*disclosure|require_ai_disclosure)/i);
      quotes.disclosure_required = this._extractSentence(cleanText, idx);
      disclosureRequired = 1;
      matchesCount++;
    } else if (/(?:no ai generated|ai generated content is prohibited)/i.test(cleanText)) {
      const idx = cleanText.search(/(?:no ai generated|ai generated content is prohibited)/i);
      quotes.disclosure_required = this._extractSentence(cleanText, idx);
      disclosureRequired = 1;
      matchesCount++;
    }

    // 5. Automation allowed detection & quote
    if (/(?:automated scripts and bots are strictly forbidden|bots are not permitted|no automated accounts)/i.test(cleanText)) {
      const idx = cleanText.search(/(?:automated scripts and bots are strictly forbidden|bots are not permitted|no automated accounts)/i);
      quotes.automation_allowed = this._extractSentence(cleanText, idx);
      automationAllowed = 0;
      matchesCount++;
    } else if (/(?:bots and automated posting are permitted|automated posting is allowed|api access is permitted)/i.test(cleanText)) {
      const idx = cleanText.search(/(?:bots and automated posting are permitted|automated posting is allowed|api access is permitted)/i);
      quotes.automation_allowed = this._extractSentence(cleanText, idx);
      automationAllowed = 1;
      matchesCount++;
    }

    // Dynamic confidence score based strictly on quotes and evidence found
    // 5 rules verified = 0.94, 4 = 0.85, 3 = 0.72, 2 = 0.55, 1 = 0.40, 0 = 0.20
    const confidenceMap = {
      5: 0.94,
      4: 0.85,
      3: 0.72,
      2: 0.55,
      1: 0.40,
      0: 0.20
    };
    const confidence = confidenceMap[matchesCount] || 0.20;

    return {
      frequency_cap: frequencyCap,
      self_promo_allowed: selfPromoAllowed,
      link_policy: linkPolicy,
      disclosure_required: disclosureRequired,
      automation_allowed: automationAllowed,
      quotes,
      confidence,
      provider: this.name,
      model: this.model,
      cost_usd: 0.0
    };
  }

  _extractSentence(text, charIndex) {
    const start = Math.max(0, text.lastIndexOf('.', charIndex) + 1);
    let end = text.indexOf('.', charIndex);
    if (end === -1) end = text.length;
    return text.substring(start, end + 1).trim();
  }
}

/**
 * Real LLM Rules Capture Provider
 * Uses OpenAI-compatible API or configured LLM endpoint
 */
export class LlmRulesCaptureProvider {
  constructor(options = {}) {
    this.name = 'llm';
    this.provider = options.provider || process.env.RULES_AI_PROVIDER || 'openai';
    this.model = options.model || process.env.RULES_AI_MODEL || 'gpt-4o-mini';
    this.apiKey = options.apiKey || process.env.RULES_AI_API_KEY;
    this.endpoint = options.endpoint || process.env.RULES_AI_ENDPOINT || 'https://api.openai.com/v1/chat/completions';
  }

  async parseContent(text) {
    if (!this.apiKey) {
      throw new IncuBrixError('RULES_CAPTURE_AUTH_MISSING', 'RULES_AI_API_KEY is not configured for LLM rules capture', {}, 401);
    }

    const cleanText = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 8000);

    const systemPrompt = `You are an expert community guidelines analyzer. Read the provided community rules text and extract structured posting policy rules as a strict JSON object with exact supporting quotes from the text.
Return ONLY valid JSON matching this schema:
{
  "frequency_cap": "1/7d" | "1/24h" | null,
  "self_promo_allowed": 0 | 1,
  "link_policy": "allowed" | "restricted" | "no_links",
  "disclosure_required": 0 | 1,
  "automation_allowed": 0 | 1,
  "quotes": {
    "frequency_cap": "exact quoted text or null",
    "self_promo_allowed": "exact quoted text or null",
    "link_policy": "exact quoted text or null",
    "disclosure_required": "exact quoted text or null",
    "automation_allowed": "exact quoted text or null"
  },
  "confidence": 0.0 to 1.0 (float assessing how explicit the rules are)
}`;

    const promptTokens = Math.ceil((systemPrompt.length + cleanText.length) / 4);

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: cleanText }
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' }
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new IncuBrixError('PLATFORM_API_ERROR', `LLM provider returned HTTP ${res.status}: ${errBody}`, {}, res.status);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    const parsed = JSON.parse(content);

    const completionTokens = data.usage?.completion_tokens || Math.ceil((content?.length || 0) / 4);
    const totalPromptTokens = data.usage?.prompt_tokens || promptTokens;

    // Real cost calculation: gpt-4o-mini: $0.15 / 1M prompt, $0.60 / 1M completion
    const costUsd = Number(((totalPromptTokens * 0.00000015) + (completionTokens * 0.00000060)).toFixed(6));

    return {
      frequency_cap: parsed.frequency_cap || null,
      self_promo_allowed: parsed.self_promo_allowed === 0 ? 0 : 1,
      link_policy: parsed.link_policy || 'allowed',
      disclosure_required: parsed.disclosure_required ? 1 : 0,
      automation_allowed: parsed.automation_allowed === 0 ? 0 : 1,
      quotes: parsed.quotes || {},
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.85,
      provider: this.provider,
      model: this.model,
      cost_usd: costUsd
    };
  }
}

/**
 * Rules Capture Adapter
 * Manages provider selection, fetching rules content, proposal persistence, and human confirmation.
 */
export class RulesCaptureAdapter {
  constructor(options = {}) {
    this._db = options.db || null;
    const providerType = options.provider || process.env.RULES_AI_PROVIDER || 'mock';

    if (providerType === 'llm' || providerType === 'openai') {
      this.provider = new LlmRulesCaptureProvider(options);
    } else {
      this.provider = new MockRulesCaptureProvider();
    }
  }

  get db() {
    return this._db || getDatabase();
  }

  set db(val) {
    this._db = val;
  }

  /**
   * Fetch rules HTML from URL, local file, or direct content
   */
  async fetchRulesContent(rulesUrl, options = {}) {
    if (!rulesUrl) {
      throw new IncuBrixError('VALIDATION_ERROR', 'rulesUrl is required', {}, 400);
    }

    if (rulesUrl.startsWith('file://') || rulesUrl.startsWith('/') || rulesUrl.includes('\\') || rulesUrl.startsWith('./') || rulesUrl.startsWith('tests/')) {
      const filePath = rulesUrl.replace(/^file:\/\//, '');
      return await fs.readFile(filePath, 'utf-8');
    }

    if (rulesUrl.startsWith('http://') || rulesUrl.startsWith('https://')) {
      const allowPrivate = Boolean(options.allowPrivate || process.env.ALLOW_LOCAL_NETWORK === 'true');

      // Check community robots.txt if not opted out
      if (!options.skipRobots) {
        const robotsCheck = await checkRobotsTxt(rulesUrl, 'IncuBrix-RulesCapture', { allowPrivate });
        if (!robotsCheck.allowed) {
          throw new IncuBrixError('ROBOTS_TXT_DISALLOWED', robotsCheck.reason || 'Blocked by community robots.txt', { rulesUrl }, 403);
        }
      }

      // Fetch with size cap (2MB default) and timeout (5000ms default)
      const res = await safeFetch(rulesUrl, {
        maxBytes: options.maxBytes !== undefined ? options.maxBytes : 2 * 1024 * 1024,
        timeoutMs: options.timeoutMs || 5000,
        userAgent: 'IncuBrix-RulesCapture/1.0',
        allowPrivate
      });

      return res.text;
    }

    // Direct content
    return rulesUrl;
  }

  /**
   * Run rules capture and extract structured rules
   */
  async captureRules(rulesUrl, options = {}) {
    const rawContent = await this.fetchRulesContent(rulesUrl, options);
    return await this.provider.parseContent(rawContent);
  }

  /**
   * Save a proposed rule set to the database with status = 'proposed'
   */
  saveProposal(destinationId, rulesUrl, capturedRules) {
    const id = `prop_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO proposed_rules (
        id, destination_id, rules_url, status,
        frequency_cap, self_promo_allowed, link_policy,
        disclosure_required, automation_allowed, quotes,
        confidence, provider, model, cost_usd, created_at
      ) VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      destinationId,
      rulesUrl,
      capturedRules.frequency_cap || null,
      capturedRules.self_promo_allowed !== undefined ? capturedRules.self_promo_allowed : 1,
      capturedRules.link_policy || 'allowed',
      capturedRules.disclosure_required ? 1 : 0,
      capturedRules.automation_allowed !== undefined ? capturedRules.automation_allowed : 1,
      JSON.stringify(capturedRules.quotes || {}),
      capturedRules.confidence || 0.0,
      capturedRules.provider || this.provider.name,
      capturedRules.model || this.provider.model,
      capturedRules.cost_usd || 0.0,
      now
    );

    return {
      proposal_id: id,
      destination_id: destinationId,
      rules_url: rulesUrl,
      status: 'proposed',
      ...capturedRules,
      created_at: now
    };
  }

  /**
   * Confirm proposed rules by a person and apply them to the destination
   */
  confirmProposal(destinationId, overrides = {}) {
    const proposal = this.db.prepare(`
      SELECT * FROM proposed_rules
      WHERE destination_id = ? AND status = 'proposed'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(destinationId);

    if (!proposal && Object.keys(overrides).length === 0) {
      throw new IncuBrixError('PROPOSAL_NOT_FOUND', `No proposed rules found for destination ${destinationId}`, {}, 404);
    }

    const frequencyCap = overrides.frequency_cap !== undefined ? overrides.frequency_cap : (proposal ? proposal.frequency_cap : '1/7d');
    const selfPromoAllowed = overrides.self_promo_allowed !== undefined ? (overrides.self_promo_allowed ? 1 : 0) : (proposal ? proposal.self_promo_allowed : 1);
    const linkPolicy = overrides.link_policy !== undefined ? overrides.link_policy : (proposal ? proposal.link_policy : 'allowed');
    const disclosureRequired = overrides.disclosure_required !== undefined ? (overrides.disclosure_required ? 1 : 0) : (proposal ? proposal.disclosure_required : 0);
    const automationAllowed = overrides.automation_allowed !== undefined ? (overrides.automation_allowed ? 1 : 0) : (proposal ? proposal.automation_allowed : 1);

    const now = new Date().toISOString();

    // Apply rules to destinations catalogue table
    this.db.prepare(`
      UPDATE destinations
      SET frequency_cap = ?,
          self_promo_allowed = ?,
          link_policy = ?,
          disclosure_required = ?,
          automation_allowed = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      frequencyCap,
      selfPromoAllowed,
      linkPolicy,
      disclosureRequired,
      automationAllowed,
      now,
      destinationId
    );

    if (proposal) {
      this.db.prepare(`
        UPDATE proposed_rules
        SET status = 'confirmed', confirmed_at = ?
        WHERE id = ?
      `).run(now, proposal.id);
    }

    logger.info(`Posting rules confirmed for destination ${destinationId}`, {
      destination_id: destinationId,
      frequency_cap: frequencyCap,
      self_promo_allowed: selfPromoAllowed,
      link_policy: linkPolicy,
      disclosure_required: disclosureRequired,
      automation_allowed: automationAllowed
    });

    return {
      destination_id: destinationId,
      status: 'confirmed',
      applied_rules: {
        frequency_cap: frequencyCap,
        self_promo_allowed: Boolean(selfPromoAllowed),
        link_policy: linkPolicy,
        disclosure_required: Boolean(disclosureRequired),
        automation_allowed: Boolean(automationAllowed)
      },
      confirmed_at: now
    };
  }
}

export const rulesCaptureAdapter = new RulesCaptureAdapter();
export default rulesCaptureAdapter;
