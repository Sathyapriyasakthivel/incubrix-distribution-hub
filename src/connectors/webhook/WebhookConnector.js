import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import BaseConnector from '../base/BaseConnector.js';
import config from '../../config/index.js';
import { PlatformUnavailableError, AuthExpiredError } from '../../utils/errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class WebhookConnector extends BaseConnector {
  constructor() {
    super(path.join(__dirname, 'manifest.yaml'));
  }

  resolveUrl(destination = {}, connection = {}) {
    const rawUrl = connection.base_url || connection.baseUrl || destination.url || '';
    const isRealInstance = connection.simulation_mode === 0 || connection.simulation_mode === false || destination.simulation_mode === 0 || destination.simulation_mode === false;
    const isLocal = rawUrl && (rawUrl.includes('localhost') || rawUrl.includes('127.0.0.1') || rawUrl.includes('mock'));
    if (isRealInstance || isLocal) {
      return rawUrl.replace(/\/+$/, '');
    }
    return (process.env.MOCK_WEBHOOK_RECEIVER_URL || 'http://127.0.0.1:4000/mock/webhook').replace(/\/+$/, '');
  }

  signPayload(payloadString, secret) {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(payloadString).digest('hex');
  }

  async publish(rendition, destination, connection = {}, idempotencyKey) {
    const baseUrl = this.resolveUrl(destination, connection);
    const postUrl = `${baseUrl}/receiver`;

    const secret = connection.secret || config.security.webhookSharedSecret;
    if (!secret && !destination?.simulation_mode && process.env.NODE_ENV !== 'test') {
      const { ConnectionSecretMissingError } = await import('../../utils/errors.js');
      throw new ConnectionSecretMissingError('Webhook HMAC secret missing from connection/secret_ref');
    }

    const timestamp = new Date().toISOString();
    const nonce = crypto.randomUUID();

    const payload = {
      event: 'publish',
      idempotency_key: idempotencyKey,
      destination_id: destination.id,
      timestamp,
      nonce,
      rendition: {
        title: rendition.title,
        body: rendition.body,
        canonical_url: rendition.canonical_url,
        media_urls: rendition.media_urls || [],
        is_ai_generated: Boolean(rendition.is_ai_generated),
        is_promotional: Boolean(rendition.is_promotional)
      }
    };

    const payloadString = JSON.stringify(payload);
    const signature = this.signPayload(payloadString, secret || 'test_secret');

    try {
      const response = await fetch(postUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-IncuBrix-Signature': signature,
          'X-IncuBrix-Timestamp': timestamp,
          'X-IncuBrix-Nonce': nonce,
          ...(connection.mockFault ? { 'X-Mock-Fault': connection.mockFault } : {})
        },
        body: payloadString
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) {
          throw new AuthExpiredError(`Webhook HMAC signature rejected by receiver: ${body.message || 'Unauthorized'}`);
        }
        throw this.mapError(response.status, body, response.headers);
      }

      // Hard Case: Validate expected schema via need()
      const eventId = body.event_id !== undefined ? this.need(body, 'event_id') : this.need(body, 'id');
      const liveUrl = (body.live_url && body.live_url.startsWith('http')) ? body.live_url : `${baseUrl}/events/${eventId}`;

      return {
        platform_post_id: String(eventId),
        live_url: liveUrl,
        status: 'published'
      };
    } catch (err) {
      if (err.name === 'IncuBrixError' || err.code) throw err;
      throw new PlatformUnavailableError(`Webhook dispatch failed: ${err.message}`);
    }
  }

  async findByMarker(marker, destination = {}, connection = {}) {
    if (!marker) return null;
    const baseUrl = this.resolveUrl(destination, connection);
    const searchUrl = `${baseUrl}/events?marker=${encodeURIComponent(marker)}`;

    try {
      const response = await fetch(searchUrl);
      if (!response.ok) return null;
      const events = await response.json().catch(() => []);
      if (Array.isArray(events)) {
        const matched = events.find(e => e.idempotency_key === marker || JSON.stringify(e).includes(marker));
        if (matched) {
          const id = matched.event_id || matched.id;
          return {
            platform_post_id: String(id),
            live_url: matched.live_url || `${baseUrl}/events/${id}`,
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
      : (process.env.MOCK_WEBHOOK_RECEIVER_URL || 'http://127.0.0.1:4000/mock/webhook')).replace(/\/+$/, '');
    const postUrl = `${baseUrl}/events/${platformPostId}`;

    try {
      const response = await fetch(postUrl);
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw this.mapError(response.status, body, response.headers);
      }

      return {
        status: 'published',
        platform_post_id: platformPostId,
        live_url: (body.url && body.url.startsWith('http')) ? body.url : `${baseUrl}/events/${platformPostId}`
      };
    } catch (err) {
      if (err.name === 'IncuBrixError') throw err;
      throw new PlatformUnavailableError(`Webhook getStatus failed: ${err.message}`);
    }
  }

  async delete(platformPostId, connection = {}) {
    const rawUrl = connection.base_url || connection.baseUrl || '';
    const isRealInstance = connection.simulation_mode === 0 || connection.simulation_mode === false;
    const isLocal = rawUrl && (rawUrl.includes('localhost') || rawUrl.includes('127.0.0.1') || rawUrl.includes('mock'));
    const baseUrl = (isRealInstance || isLocal
      ? rawUrl
      : (process.env.MOCK_WEBHOOK_RECEIVER_URL || 'http://127.0.0.1:4000/mock/webhook')).replace(/\/+$/, '');
    const deleteUrl = `${baseUrl}/events/${platformPostId}`;

    try {
      const response = await fetch(deleteUrl, { method: 'DELETE' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw this.mapError(response.status, body, response.headers);
      }

      return { deleted: true };
    } catch (err) {
      if (err.name === 'IncuBrixError') throw err;
      throw new PlatformUnavailableError(`Webhook delete failed: ${err.message}`);
    }
  }
}

export default WebhookConnector;
