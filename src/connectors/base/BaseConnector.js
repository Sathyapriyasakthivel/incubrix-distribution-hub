import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import {
  ERROR_CODES,
  IncuBrixError,
  DestinationSpecViolationError,
  AuthExpiredError,
  PlatformRateLimitError,
  PlatformContentRejectedError,
  PlatformUnavailableError
} from '../../utils/errors.js';
import logger from '../../utils/logger.js';

/**
 * Inspect a media item (URL string or object) to determine its content_type and category
 * @param {string|Object} item
 * @returns {{ url: string, contentType: string, category: string }}
 */
export function inspectMediaItem(item) {
  let url = '';
  let contentType = '';

  if (typeof item === 'string') {
    url = item.trim();
  } else if (item && typeof item === 'object') {
    url = (item.url || item.src || '').trim();
    contentType = (item.content_type || item.mime_type || item.type || '').trim().toLowerCase();
  }

  const extMap = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.tiff': 'image/tiff',
    '.avif': 'image/avif',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.m4v': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.wmv': 'video/x-ms-wmv',
    '.flv': 'video/x-flv',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.exe': 'application/x-msdownload',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  };

  // Detect MIME type from URL if not explicitly provided
  if (!contentType && url) {
    if (url.startsWith('data:')) {
      const mimeMatch = url.match(/^data:([^;,]+)/);
      if (mimeMatch) contentType = mimeMatch[1].toLowerCase();
    } else {
      try {
        const parsed = new URL(url);
        const ext = path.extname(parsed.pathname).toLowerCase();
        if (ext && extMap[ext]) {
          contentType = extMap[ext];
        }
      } catch {
        for (const [ext, mime] of Object.entries(extMap)) {
          if (url.toLowerCase().endsWith(ext)) {
            contentType = mime;
            break;
          }
        }
      }
    }
  }

  // Categorize
  let category = 'unknown';
  if (contentType.startsWith('image/')) category = 'image';
  else if (contentType.startsWith('video/')) category = 'video';
  else if (contentType.startsWith('audio/')) category = 'audio';
  else if (contentType.startsWith('application/')) category = 'application';

  // Check for video link platforms
  if (category === 'unknown' && url) {
    if (/youtube\.com\/|youtu\.be\/|vimeo\.com\/|loom\.com\/|wistia\.com\//i.test(url)) {
      category = 'video_link';
      contentType = 'video/link';
    }
  }

  return { url, contentType: contentType || 'application/octet-stream', category };
}

export class BaseConnector {
  constructor(manifestPath) {
    this.manifestPath = manifestPath;
    this.manifest = this.loadManifest(manifestPath);
    this.key = this.manifest.key;
    this.version = this.manifest.version;
    this.tier = this.manifest.tier;
    this.capabilities = new Set(this.manifest.capabilities || []);
    this.errorMap = this.manifest.error_map || {};
  }

  loadManifest(filePath) {
    try {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const manifest = yaml.parse(fileContent);
      this.validateManifest(manifest, filePath);
      return manifest;
    } catch (err) {
      throw new Error(`Failed to load manifest for connector at ${filePath}: ${err.message}`);
    }
  }

  validateManifest(manifest, filePath) {
    const required = ['key', 'version', 'tier', 'auth', 'surfaces', 'rate_limits', 'capabilities', 'error_map', 'instance_param'];
    for (const field of required) {
      if (manifest[field] === undefined || manifest[field] === null) {
        throw new Error(`Manifest validation failed for ${filePath}: missing required field '${field}'`);
      }
    }
    const requiredErrorCodes = ['429', '401', '403', '422', '4xx', '5xx'];
    for (const code of requiredErrorCodes) {
      if (!manifest.error_map[code]) {
        throw new Error(`Manifest validation failed for ${filePath}: error_map missing '${code}' mapping`);
      }
    }
  }

  /**
   * Safe nested field extractor (Integration Standard / Hard Case: Platform API field renaming)
   * Throws PLATFORM_SCHEMA_MISMATCH if path is missing or null.
   */
  need(obj, pathStr) {
    if (!obj || typeof obj !== 'object') {
      const err = new IncuBrixError(
        'PLATFORM_SCHEMA_MISMATCH',
        `Platform schema mismatch: response is not an object (expected field '${pathStr}')`,
        { path: pathStr, received: obj },
        500,
        false
      );
      throw err;
    }

    const parts = pathStr.split('.');
    let curr = obj;
    for (const part of parts) {
      if (curr === undefined || curr === null || !(part in curr) || curr[part] === undefined || curr[part] === null) {
        const err = new IncuBrixError(
          'PLATFORM_SCHEMA_MISMATCH',
          `Platform schema mismatch: response missing required field '${pathStr}'`,
          { path: pathStr, received: obj },
          500,
          false
        );
        throw err;
      }
      curr = curr[part];
    }
    return curr;
  }

  /**
   * Validate rendition against destination surface spec
   * @param {Object} rendition - { title, body, canonical_url, media_urls, is_ai_generated, is_promotional }
   * @param {Object} destination - destination record
   * @param {Object} connection - auth credentials
   * @returns {Promise<{ ok: boolean, violations: Array<{ field: string, rule: string, message: string }> }>}
   */
  async validate(rendition, destination, connection) {
    const violations = [];
    const surface = this.manifest.surfaces?.[0] || { spec: { title_max_chars: 255, body_max_chars: 32000, links_allowed: true } };
    const spec = surface.spec || {};

    // Validate title length
    if (spec.title_max_chars && rendition.title && rendition.title.length > spec.title_max_chars) {
      violations.push({
        field: 'title',
        rule: 'max_length',
        message: `Title exceeds maximum allowed length of ${spec.title_max_chars} chars (got ${rendition.title.length})`
      });
    }

    // Validate body length
    if (spec.body_max_chars && rendition.body && rendition.body.length > spec.body_max_chars) {
      violations.push({
        field: 'body',
        rule: 'max_length',
        message: `Body exceeds maximum allowed length of ${spec.body_max_chars} chars (got ${rendition.body.length})`
      });
    }

    // Validate link policy
    if (spec.links_allowed === false && rendition.body && /https?:\/\//i.test(rendition.body)) {
      violations.push({
        field: 'body',
        rule: 'no_links',
        message: 'Destination surface strictly prohibits links in the body'
      });
    }

    // Validate media content types and MIME-based compatibility
    const mediaItems = [];
    if (Array.isArray(rendition.media_urls)) {
      mediaItems.push(...rendition.media_urls);
    } else if (rendition.media_urls) {
      mediaItems.push(rendition.media_urls);
    }
    if (Array.isArray(rendition.media)) {
      mediaItems.push(...rendition.media);
    }

    if (mediaItems.length > 0) {
      const allowedContentTypes = (surface.content_types || ['text']).map(t => t.toLowerCase());
      const allowsImages = allowedContentTypes.includes('image');
      const allowsVideos = allowedContentTypes.includes('video');
      const allowsVideoLinks = allowedContentTypes.includes('video_link');

      for (let i = 0; i < mediaItems.length; i++) {
        const item = mediaItems[i];
        const { url, contentType, category } = inspectMediaItem(item);

        let accepted = false;
        if (category === 'image' && allowsImages) {
          accepted = true;
        } else if (category === 'video' && allowsVideos) {
          accepted = true;
        } else if (category === 'video_link' && (allowsVideoLinks || allowsVideos)) {
          accepted = true;
        }

        if (!accepted) {
          violations.push({
            field: 'media_urls',
            rule: 'DEST_SPEC_VIOLATION',
            message: `Media item '${url || `item[${i}]`}' with content_type '${contentType}' is not accepted by destination surface (allowed: ${allowedContentTypes.join(', ')})`
          });
        }
      }
    }

    // De-duplicate violation messages in validate responses
    const uniqueViolations = [];
    const seen = new Set();
    for (const v of violations) {
      const dedupeKey = `${v.field}:${v.rule}:${v.message}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        uniqueViolations.push(v);
      }
    }

    return {
      ok: uniqueViolations.length === 0,
      violations: uniqueViolations
    };
  }

  /**
   * Publish rendition to destination
   * @param {Object} rendition
   * @param {Object} destination
   * @param {Object} connection
   * @param {string} idempotencyKey
   * @returns {Promise<{ platform_post_id: string, live_url: string, status: string }>}
   */
  async publish(rendition, destination, connection, idempotencyKey) {
    throw new Error('publish() must be implemented by subclass');
  }

  /**
   * Get post status
   * @param {string} platformPostId
   * @param {Object} connection
   * @returns {Promise<{ status: string, live_url: string }>}
   */
  async getStatus(platformPostId, connection) {
    throw new Error('getStatus() must be implemented by subclass');
  }

  /**
   * Delete test post
   * @param {string} platformPostId
   * @param {Object} connection
   * @returns {Promise<{ deleted: boolean }>}
   */
  async delete(platformPostId, connection) {
    throw new Error('delete() must be implemented by subclass');
  }

  /**
   * Fetch metrics (optional)
   * @param {string} platformPostId
   * @param {Object} connection
   * @param {string} since
   * @returns {Promise<{ views: number, likes: number, comments: number, shares: number, saves: number, watch_time_s: number, clicks: number }>}
   */
  async fetchMetrics(platformPostId, connection, since) {
    return {
      views: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      saves: 0,
      watch_time_s: 0,
      clicks: 0
    };
  }

  /**
   * Refresh auth token (optional)
   */
  async refreshAuth(connection) {
    return { expires_at: null };
  }

  /**
   * Build assisted publication pack (assisted tier only)
   */
  async buildAssistPack(rendition, destination) {
    throw new Error('buildAssistPack() only supported on assisted connectors');
  }

  /**
   * Map HTTP or API status code to standard IncuBrix error
   */
  mapError(statusCode, responseBody = {}, headers = null) {
    const codeStr = String(statusCode);

    // Partner revoked permission (HTTP 401/403/410) maps to CONNECTION_AUTH_EXPIRED
    if (statusCode === 401 || statusCode === 403 || statusCode === 410) {
      return new AuthExpiredError(responseBody.message || 'Platform partner authentication expired or permission revoked', {
        code: ERROR_CODES.CONNECTION_AUTH_EXPIRED,
        statusCode,
        retryable: false
      });
    }

    // Check for daily quota exhaustion (PLATFORM_QUOTA_EXHAUSTED)
    const isQuotaExhausted = responseBody.code === 'QUOTA_EXHAUSTED' ||
      responseBody.error === 'quota_exceeded' ||
      (typeof responseBody.message === 'string' && /quota/i.test(responseBody.message));

    if (isQuotaExhausted) {
      const tomorrowMidnight = new Date();
      tomorrowMidnight.setUTCHours(24, 0, 0, 0);
      return new IncuBrixError(
        'PLATFORM_QUOTA_EXHAUSTED',
        responseBody.message || 'Platform daily quota exhausted, rescheduled to next quota window',
        {
          code: 'PLATFORM_QUOTA_EXHAUSTED',
          statusCode,
          retryable: true,
          retry_at: tomorrowMidnight.toISOString(),
          retryAfter: Math.floor((tomorrowMidnight.getTime() - Date.now()) / 1000)
        },
        429,
        true
      );
    }

    const mappedCode = this.errorMap[codeStr] || ERROR_CODES.PLATFORM_UNAVAILABLE;

    if (mappedCode === ERROR_CODES.PLATFORM_RATE_LIMIT || statusCode === 429) {
      // Header-based reset time parsing (Retry-After / X-RateLimit-Reset)
      let seconds = 60;

      const retryAfterHeader = headers?.get
        ? (headers.get('retry-after') || headers.get('Retry-After'))
        : (headers?.['retry-after'] || headers?.['Retry-After']);

      const rateLimitResetHeader = headers?.get
        ? (headers.get('x-ratelimit-reset') || headers.get('X-RateLimit-Reset'))
        : (headers?.['x-ratelimit-reset'] || headers?.['X-RateLimit-Reset']);

      if (retryAfterHeader) {
        const parsed = parseInt(retryAfterHeader, 10);
        if (!isNaN(parsed)) {
          seconds = parsed;
        } else {
          const dateMs = new Date(retryAfterHeader).getTime();
          if (!isNaN(dateMs)) {
            seconds = Math.max(1, Math.ceil((dateMs - Date.now()) / 1000));
          }
        }
      } else if (rateLimitResetHeader) {
        const resetVal = parseInt(rateLimitResetHeader, 10);
        if (!isNaN(resetVal)) {
          if (resetVal > 1000000000) {
            seconds = Math.max(1, resetVal - Math.floor(Date.now() / 1000));
          } else {
            seconds = resetVal;
          }
        }
      } else if (responseBody.retry_after) {
        seconds = parseInt(responseBody.retry_after, 10) || 60;
      }

      const retryAtIso = new Date(Date.now() + seconds * 1000).toISOString();

      return new PlatformRateLimitError(responseBody.message || 'Platform rate limit encountered', {
        statusCode: 429,
        retryAfter: seconds,
        retry_at: retryAtIso
      });
    }

    if (mappedCode === ERROR_CODES.CONNECTION_AUTH_EXPIRED) {
      return new AuthExpiredError(responseBody.message || 'Platform authentication expired or invalid', {
        statusCode,
        code: ERROR_CODES.CONNECTION_AUTH_EXPIRED,
        retryable: false
      });
    }

    if (mappedCode === ERROR_CODES.PLATFORM_CONTENT_REJECTED) {
      return new PlatformContentRejectedError(responseBody.message || 'Platform refused content', {
        statusCode,
        code: ERROR_CODES.PLATFORM_CONTENT_REJECTED,
        details: responseBody
      });
    }

    return new PlatformUnavailableError(responseBody.message || `Platform error (${statusCode})`, {
      statusCode,
      code: ERROR_CODES.PLATFORM_UNAVAILABLE,
      details: responseBody
    });
  }

  /**
   * Find post by idempotency marker (Safe retry across timeout)
   * @param {string} marker
   * @param {Object} destination
   * @param {Object} connection
   * @returns {Promise<{ platform_post_id: string, live_url: string, status: string }|null>}
   */
  async findByMarker(marker, destination = {}, connection = {}) {
    return null;
  }
}

export default BaseConnector;
