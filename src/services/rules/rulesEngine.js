import crypto from 'node:crypto';
import { getDatabase } from '../../database/db.js';
import registry from '../../connectors/ConnectorRegistry.js';
import logger from '../../utils/logger.js';

/**
 * Concurrency-safe Posting-Rules Engine
 * Evaluates:
 * 0. Destination Certification Status (must be 'certified', not 'demoted' or 'catalogued'/'uncertified')
 * 1. Destination Enabled & Operational status
 * 2. Connector Readiness & Kill-Switch
 * 3. Concurrency-safe Frequency Caps (null or empty cap means no cap; test posts excluded)
 * 4. Self-Promotion Policy (DEST_RULE_SELF_PROMO)
 * 5. Link Restrictions (DEST_RULE_LINK_POLICY)
 * 6. AI-Generated Content Disclosure (DEST_RULE_AI_DISCLOSURE)
 * 7. Title & Body Length / Content Specs (DEST_SPEC_VIOLATION)
 * 8. Media Restrictions (DEST_SPEC_VIOLATION)
 *
 * Precedence: BLOCK over RESCHEDULE is strictly enforced.
 */

export function parseFrequencyCap(capString) {
  if (!capString || typeof capString !== 'string' || !capString.trim()) {
    return null; // Null or empty means no frequency cap
  }
  // Format: count/interval, e.g. "1/7d", "2/24h", "1/1d"
  const match = capString.trim().match(/^(\d+)\/(\d+)([dh])$/i);
  if (!match) {
    return null; // Unrecognized format means no cap
  }
  const count = parseInt(match[1], 10);
  const duration = parseInt(match[2], 10);
  const unit = match[3].toLowerCase();
  const windowHours = unit === 'd' ? duration * 24 : duration;
  return { maxPosts: count, windowHours };
}

export class PostingRulesEngine {
  constructor(db = null) {
    this._db = db;
  }

  get db() {
    return this._db || getDatabase();
  }

  set db(val) {
    this._db = val;
  }

  /**
   * Evaluate posting rules for a submission
   * @param {Object} rendition - { title, body, canonical_url, media_urls, is_ai_generated, is_promotional, ai_disclosure, tailor }
   * @param {Object} destination - destination catalogue row
   * @param {Object} options - { correlationId, jobId, tailor }
   * @returns {Object} - { decision: 'ALLOW'|'BLOCK'|'RESCHEDULE', reason: string, reasons: string[], violations: object[], triggered_rules: string[], retry_at: string|null, warnings: string[] }
   */
  evaluate(rendition, destination, options = {}) {
    const violations = [];
    const triggeredRules = [];
    const warnings = [];
    let isBlocked = false;
    let isRescheduled = false;
    let rescheduleAfter = null;

    // Rule 0: Destination Certification Status Check
    if (destination.status === 'demoted') {
      isBlocked = true;
      triggeredRules.push('DEST_DEMOTED');
      violations.push({
        rule: 'DEST_DEMOTED',
        field: 'status',
        message: `Destination '${destination.name || destination.id}' has been demoted due to a certification failure and cannot accept publications.`
      });
    } else if (destination.status && destination.status !== 'certified') {
      isBlocked = true;
      triggeredRules.push('DEST_NOT_CERTIFIED');
      violations.push({
        rule: 'DEST_NOT_CERTIFIED',
        field: 'status',
        message: `Destination '${destination.name || destination.id}' is not certified (current status: '${destination.status}'). Publishing requires certified status.`
      });
    }

    // Rule 1: Destination Enabled Check
    if (destination.is_enabled === 0 || destination.is_enabled === false) {
      isBlocked = true;
      triggeredRules.push('DESTINATION_DISABLED');
      violations.push({
        rule: 'DESTINATION_DISABLED',
        field: 'is_enabled',
        message: `Destination '${destination.name || destination.id}' is currently disabled.`
      });
    }

    // Rule 2: Connector Readiness & Kill-Switch
    if (destination.connector_key && registry.isKillSwitchActive(destination.connector_key)) {
      isBlocked = true;
      triggeredRules.push('CONNECTOR_DISABLED');
      violations.push({
        rule: 'CONNECTOR_DISABLED',
        field: 'connector_key',
        message: `Connector '${destination.connector_key}' is disabled by kill-switch.`
      });
    }

    // Rule 3: Frequency Cap Check (Concurrency-safe SQLite query)
    // Null or empty frequency_cap means no cap
    const cap = parseFrequencyCap(destination.frequency_cap);
    if (cap) {
      const { maxPosts, windowHours } = cap;
      const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

      // Exclude certification test posts from counting towards user publication frequency caps
      const recentPostRow = this.db.get(`
        SELECT COUNT(*) as count, MIN(created_at) as oldest_post
        FROM publications
        WHERE destination_id = ?
          AND status IN ('succeeded', 'published', 'running', 'queued')
          AND created_at >= ?
          AND (is_test = 0 OR is_test IS NULL)
          AND title NOT LIKE '[CERTIFICATION-TEST]%'
      `, destination.id, windowStart);

      const recentPostCount = recentPostRow?.count || 0;
      if (recentPostCount >= maxPosts) {
        isRescheduled = true;
        triggeredRules.push('DEST_RULE_FREQUENCY_CAP');

        // Calculate when the cap window clears
        const oldestDate = recentPostRow?.oldest_post ? new Date(recentPostRow.oldest_post) : new Date();
        const clearTime = new Date(oldestDate.getTime() + windowHours * 60 * 60 * 1000);
        rescheduleAfter = clearTime.toISOString();

        violations.push({
          rule: 'DEST_RULE_FREQUENCY_CAP',
          field: 'frequency_cap',
          retry_at: rescheduleAfter,
          message: `Frequency cap exceeded: Destination allows at most ${maxPosts} post(s) per ${windowHours} hours. Currently ${recentPostCount} recent post(s). Window resets at ${rescheduleAfter}.`
        });
      }
    }

    // Rule 4: Self-Promotion Policy
    const bansPromo = destination.self_promo_allowed === 0 || destination.self_promo_allowed === false || destination.disallow_promotional === 1;
    if (bansPromo && rendition.is_promotional) {
      isBlocked = true;
      triggeredRules.push('DEST_RULE_SELF_PROMO', 'NO_SELF_PROMOTION');
      violations.push({
        rule: 'DEST_RULE_SELF_PROMO',
        field: 'is_promotional',
        message: `Destination '${destination.name || destination.id}' strictly prohibits self-promotional content.`
      });
    }

    // Rule 5: Link Policy
    const bodyLinks = (rendition.body || '').match(/https?:\/\/[^\s]+/gi) || [];
    const totalLinks = bodyLinks.length + (rendition.canonical_url ? 1 : 0);

    if (destination.link_policy === 'no_links' && totalLinks > 0) {
      isBlocked = true;
      triggeredRules.push('DEST_RULE_LINK_POLICY', 'LINK_POLICY_NO_LINKS');
      violations.push({
        rule: 'DEST_RULE_LINK_POLICY',
        field: 'body',
        message: `Destination '${destination.name || destination.id}' does not allow external links.`
      });
    } else if (destination.link_policy === 'max_1' && totalLinks > 1) {
      isBlocked = true;
      triggeredRules.push('DEST_RULE_LINK_POLICY', 'LINK_POLICY_MAX_1');
      violations.push({
        rule: 'DEST_RULE_LINK_POLICY',
        field: 'body',
        message: `Destination '${destination.name || destination.id}' allows at most 1 link (found ${totalLinks}).`
      });
    }

    // Rule 6: AI-Disclosure Requirement
    // Tests explicit ai_disclosure field or destination's required phrase, not a loose body regex
    const requiresAiDisclosure = destination.disclosure_required === 1 || destination.disclosure_required === true || destination.require_ai_disclosure === 1;
    if (requiresAiDisclosure && rendition.is_ai_generated) {
      const requiredPhrase = destination.disclosure_phrase || destination.required_disclosure_phrase;
      const hasExplicitField = Boolean(rendition.ai_disclosure);
      const hasRequiredPhrase = requiredPhrase
        ? (rendition.body && rendition.body.includes(requiredPhrase))
        : (rendition.body && rendition.body.includes('[AI Disclosure'));

      if (!hasExplicitField && !hasRequiredPhrase) {
        if (rendition.tailor === true || options.tailor === true) {
          // Automatic tailoring adds the disclosure and reports in warnings
          const phraseToApply = requiredPhrase || '[AI Disclosure: Content generated with AI assistance]';
          rendition.ai_disclosure = phraseToApply;
          rendition.body = `${phraseToApply}\n\n${rendition.body || ''}`.trim();
          warnings.push(`Auto-applied required AI disclosure statement: "${phraseToApply}"`);
        } else {
          isBlocked = true;
          triggeredRules.push('DEST_RULE_AI_DISCLOSURE', 'AI_DISCLOSURE_REQUIRED');
          violations.push({
            rule: 'DEST_RULE_AI_DISCLOSURE',
            field: 'ai_disclosure',
            message: `Destination '${destination.name || destination.id}' requires explicit AI disclosure for AI-generated content.`
          });
        }
      }
    }

    // Rule 7: Title & Body Specification Limits
    if (rendition.title && destination.max_title_chars && rendition.title.length > destination.max_title_chars) {
      isBlocked = true;
      triggeredRules.push('DEST_SPEC_VIOLATION');
      violations.push({
        rule: 'DEST_SPEC_VIOLATION',
        field: 'title',
        message: `Title length (${rendition.title.length}) exceeds destination limit of ${destination.max_title_chars} characters.`
      });
    }

    if (rendition.body && destination.max_body_chars && rendition.body.length > destination.max_body_chars) {
      isBlocked = true;
      triggeredRules.push('DEST_SPEC_VIOLATION');
      violations.push({
        rule: 'DEST_SPEC_VIOLATION',
        field: 'body',
        message: `Body length (${rendition.body.length}) exceeds destination limit of ${destination.max_body_chars} characters.`
      });
    }

    // Rule 8: Media Type Restrictions
    if (rendition.media_urls && rendition.media_urls.length > 0 && destination.allowed_media_types) {
      try {
        const allowedMedia = typeof destination.allowed_media_types === 'string'
          ? JSON.parse(destination.allowed_media_types)
          : destination.allowed_media_types;
        if (Array.isArray(allowedMedia) && allowedMedia.length === 0) {
          isBlocked = true;
          triggeredRules.push('DEST_SPEC_VIOLATION', 'MEDIA_NOT_ALLOWED');
          violations.push({
            rule: 'DEST_SPEC_VIOLATION',
            field: 'media_urls',
            message: `Destination '${destination.name || destination.id}' does not permit media uploads.`
          });
        }
      } catch {
        // Fallback
      }
    }

    // Enforce Precedence: BLOCK over RESCHEDULE
    let decision = 'ALLOW';
    if (isBlocked) {
      decision = 'BLOCK';
    } else if (isRescheduled) {
      decision = 'RESCHEDULE';
    }

    const humanReason = violations.map(v => v.message).join('; ') || 'Compliant with all destination posting rules';

    // Record decision in audit log
    const auditRecord = {
      id: 'audit_' + crypto.randomUUID(),
      event_type: 'RULE_EVALUATION',
      entity_type: 'destination',
      entity_id: destination.id,
      correlation_id: options.correlationId || null,
      job_id: options.jobId || null,
      payload: JSON.stringify({
        decision,
        reason: humanReason,
        triggered_rules: triggeredRules,
        violations,
        destination_name: destination.name,
        reschedule_after: isBlocked ? null : rescheduleAfter,
        warnings
      }),
      created_at: new Date().toISOString()
    };

    try {
      this.db.run(`
        INSERT INTO audit_logs (id, event_type, entity_type, entity_id, correlation_id, job_id, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, auditRecord.id, auditRecord.event_type, auditRecord.entity_type, auditRecord.entity_id, auditRecord.correlation_id, auditRecord.job_id, auditRecord.payload, auditRecord.created_at);
    } catch (err) {
      logger.warn('Failed to persist rule audit log', { error: err.message });
    }

    return {
      decision,
      reason: humanReason,
      reasons: violations.map(v => v.message),
      violations,
      triggered_rules: triggeredRules,
      retry_at: isBlocked ? null : rescheduleAfter,
      reschedule_after: isBlocked ? null : rescheduleAfter,
      warnings
    };
  }
}

export const rulesEngine = new PostingRulesEngine();
export default rulesEngine;
