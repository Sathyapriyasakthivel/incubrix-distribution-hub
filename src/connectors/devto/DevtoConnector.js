import path from 'node:path';
import { fileURLToPath } from 'node:url';
import BaseConnector from '../base/BaseConnector.js';
import { PlatformUnavailableError } from '../../utils/errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class DevtoConnector extends BaseConnector {
  constructor() {
    super(path.join(__dirname, 'manifest.yaml'));
  }

  async validate(rendition, destination, connection) {
    const baseValidation = await super.validate(rendition, destination, connection);
    const violations = [...baseValidation.violations];

    if (!rendition.title || rendition.title.trim().length < 5) {
      violations.push({
        field: 'title',
        rule: 'min_length',
        message: 'Dev.to article title must be at least 5 characters'
      });
    }

    if (rendition.title && rendition.title.length > 128) {
      violations.push({
        field: 'title',
        rule: 'max_length',
        message: `Dev.to article title exceeds 128 characters (got ${rendition.title.length})`
      });
    }

    if (!rendition.body || rendition.body.trim().length < 30) {
      violations.push({
        field: 'body',
        rule: 'min_length',
        message: 'Dev.to article body markdown must be at least 30 characters'
      });
    }

    return {
      ok: violations.length === 0,
      violations
    };
  }

  resolveUrl(destination = {}, connection = {}) {
    const rawUrl = connection.base_url || connection.baseUrl || destination.url || '';
    const isRealInstance = connection.simulation_mode === 0 || connection.simulation_mode === false || destination.simulation_mode === 0 || destination.simulation_mode === false;
    const isLocal = rawUrl && (rawUrl.includes('localhost') || rawUrl.includes('127.0.0.1') || rawUrl.includes('mock'));
    if (isRealInstance || isLocal) {
      return rawUrl.replace(/\/+$/, '');
    }
    return (process.env.MOCK_DEVTO_URL || 'http://127.0.0.1:4000/mock/devto').replace(/\/+$/, '');
  }

  async publish(rendition, destination, connection = {}, idempotencyKey) {
    const baseUrl = this.resolveUrl(destination, connection);
    const postUrl = `${baseUrl}/api/articles`;

    const apiKey = connection.apiKey || connection.api_key;
    if (!apiKey && !destination?.simulation_mode && process.env.NODE_ENV !== 'test') {
      const { ConnectionSecretMissingError } = await import('../../utils/errors.js');
      throw new ConnectionSecretMissingError('Dev.to API key missing from connection/secret_ref');
    }
    const resolvedApiKey = apiKey || 'devto_mock_api_key';

    const tags = Array.isArray(rendition.tags) ? rendition.tags.slice(0, 4) : ['technology', 'discuss'];
    const marker = idempotencyKey ? `<!-- incubrix_marker:${idempotencyKey} -->` : '';
    const bodyMarkdown = marker ? `${rendition.body}\n\n${marker}` : rendition.body;

    const payload = {
      article: {
        title: rendition.title,
        body_markdown: bodyMarkdown,
        published: true,
        canonical_url: rendition.canonical_url || undefined,
        tags
      }
    };

    try {
      const response = await fetch(postUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': resolvedApiKey,
          ...(connection.mockFault ? { 'X-Mock-Fault': connection.mockFault } : {})
        },
        body: JSON.stringify(payload)
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw this.mapError(response.status, body, response.headers);
      }

      // Hard Case: Validate expected schema via need()
      const postId = this.need(body, 'id');
      const liveUrl = (body.url && body.url.startsWith('http')) ? body.url : `${baseUrl}/articles/${postId}`;

      return {
        platform_post_id: String(postId),
        live_url: liveUrl,
        status: 'published'
      };
    } catch (err) {
      if (err.name === 'IncuBrixError' || err.code) throw err;
      throw new PlatformUnavailableError(`Dev.to publish failed: ${err.message}`);
    }
  }

  async findByMarker(marker, destination = {}, connection = {}) {
    if (!marker) return null;
    const baseUrl = this.resolveUrl(destination, connection);
    const searchUrl = `${baseUrl}/api/articles/me/all?per_page=50`;
    const apiKey = connection.apiKey || connection.api_key || 'devto_mock_api_key';

    try {
      const response = await fetch(searchUrl, {
        headers: { 'api-key': apiKey }
      });
      if (!response.ok) return null;
      const articles = await response.json().catch(() => []);
      if (Array.isArray(articles)) {
        const matched = articles.find(a => (a.body_markdown && a.body_markdown.includes(marker)) || (a.body && a.body.includes(marker)));
        if (matched) {
          return {
            platform_post_id: String(matched.id),
            live_url: (matched.url && matched.url.startsWith('http')) ? matched.url : `${baseUrl}/articles/${matched.id}`,
            status: 'published'
          };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  async getStatus(platformPostId, connection = {}) {
    const rawUrl = connection.base_url || connection.baseUrl || '';
    const isRealInstance = connection.simulation_mode === 0 || connection.simulation_mode === false;
    const isLocal = rawUrl && (rawUrl.includes('localhost') || rawUrl.includes('127.0.0.1') || rawUrl.includes('mock'));
    const baseUrl = (isRealInstance || isLocal
      ? rawUrl
      : (process.env.MOCK_DEVTO_URL || 'http://127.0.0.1:4000/mock/devto')).replace(/\/+$/, '');
    const postUrl = `${baseUrl}/api/articles/${platformPostId}`;
    const apiKey = connection.apiKey || connection.api_key || 'devto_mock_api_key';

    try {
      const response = await fetch(postUrl, {
        headers: { 'api-key': apiKey }
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw this.mapError(response.status, body, response.headers);
      }

      return {
        status: 'published',
        live_url: (body.url && body.url.startsWith('http')) ? body.url : `${baseUrl}/articles/${platformPostId}`
      };
    } catch (err) {
      if (err.name === 'IncuBrixError') throw err;
      throw new PlatformUnavailableError(`Dev.to getStatus failed: ${err.message}`);
    }
  }

  async delete(platformPostId, connection = {}) {
    const rawUrl = connection.base_url || connection.baseUrl || '';
    const isRealInstance = connection.simulation_mode === 0 || connection.simulation_mode === false;
    const isLocal = rawUrl && (rawUrl.includes('localhost') || rawUrl.includes('127.0.0.1') || rawUrl.includes('mock'));
    const baseUrl = (isRealInstance || isLocal
      ? rawUrl
      : (process.env.MOCK_DEVTO_URL || 'http://127.0.0.1:4000/mock/devto')).replace(/\/+$/, '');
    const deleteUrl = `${baseUrl}/api/articles/${platformPostId}`;
    const apiKey = connection.apiKey || connection.api_key || 'devto_mock_api_key';

    try {
      const response = await fetch(deleteUrl, {
        method: 'DELETE',
        headers: { 'api-key': apiKey }
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw this.mapError(response.status, body, response.headers);
      }

      return { deleted: true };
    } catch (err) {
      if (err.name === 'IncuBrixError') throw err;
      throw new PlatformUnavailableError(`Dev.to delete failed: ${err.message}`);
    }
  }

  async fetchMetrics(platformPostId, connection = {}, since) {
    const rawUrl = connection.base_url || connection.baseUrl || '';
    const isRealInstance = connection.simulation_mode === 0 || connection.simulation_mode === false;
    const isLocal = rawUrl && (rawUrl.includes('localhost') || rawUrl.includes('127.0.0.1') || rawUrl.includes('mock'));
    const baseUrl = (isRealInstance || isLocal
      ? rawUrl
      : (process.env.MOCK_DEVTO_URL || 'http://127.0.0.1:4000/mock/devto')).replace(/\/+$/, '');
    const postUrl = `${baseUrl}/api/articles/${platformPostId}`;

    try {
      const response = await fetch(postUrl, {
        headers: { 'api-key': connection.apiKey || connection.api_key || 'devto_mock_api_key' }
      });

      if (!response.ok) return super.fetchMetrics(platformPostId, connection, since);

      const body = await response.json().catch(() => ({}));
      return {
        views: body.page_views_count || 0,
        likes: body.positive_reactions_count || 0,
        comments: body.comments_count || 0,
        shares: 0,
        saves: 0,
        watch_time_s: 0,
        clicks: 0
      };
    } catch {
      return super.fetchMetrics(platformPostId, connection, since);
    }
  }
}

export default DevtoConnector;
