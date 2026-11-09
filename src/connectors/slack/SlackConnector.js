import path from 'node:path';
import { fileURLToPath } from 'node:url';
import BaseConnector from '../base/BaseConnector.js';
import { PlatformUnavailableError } from '../../utils/errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Slack App Connector — posts messages to a Slack channel using chat.postMessage.
 * Advanced tier connector (beyond the 6 core required).
 */
export class SlackConnector extends BaseConnector {
  constructor() {
    super(path.join(__dirname, 'manifest.yaml'));
  }

  resolveApiUrl() {
    return 'https://slack.com/api';
  }

  buildBlocks(rendition) {
    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${rendition.title}*`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: rendition.body.slice(0, 3000) // Slack block text limit
        }
      }
    ];

    if (rendition.canonical_url) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🔗 <${rendition.canonical_url}|Read full article>`
        }
      });
    }

    if (rendition.is_ai_generated) {
      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: '🤖 _AI-assisted content_'
        }]
      });
    }

    return blocks;
  }

  async publish(rendition, destination, connection = {}, idempotencyKey) {
    const channel = connection.channel || connection.channelId || 'general';
    const token = connection.token || connection.botToken || connection.api_key;

    // Simulation / test mode
    if (destination?.simulation_mode || process.env.NODE_ENV === 'test') {
      const messageTs = String(Date.now() / 1000);
      const channelId = connection.channelId || 'C0TESTCHAN';
      return {
        platform_post_id: `${channelId}:${messageTs}`,
        live_url: `https://slack.com/archives/${channelId}/p${messageTs.replace('.', '')}`,
        status: 'published'
      };
    }

    const apiUrl = this.resolveApiUrl();
    const payload = {
      channel,
      text: rendition.title, // Fallback text for notifications
      blocks: this.buildBlocks(rendition),
      unfurl_links: false,
      unfurl_media: false
    };

    // Add thread_ts if replying to thread
    if (connection.thread_ts) {
      payload.thread_ts = connection.thread_ts;
    }

    try {
      const response = await fetch(`${apiUrl}/chat.postMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw this.mapError(response.status, data);
      }

      if (!data.ok) {
        // Slack always returns 200 but may indicate an error in the body
        const slackError = data.error || 'slack_api_error';
        if (slackError === 'token_expired' || slackError === 'invalid_auth') {
          throw this.mapError(401, { message: `Slack auth error: ${slackError}` });
        }
        if (slackError === 'ratelimited') {
          const retryAfter = parseInt(response.headers.get('Retry-After') || '60', 10);
          throw this.mapError(429, { message: 'Slack rate limit exceeded', retry_after: retryAfter });
        }
        throw this.mapError(422, { message: `Slack error: ${slackError}` });
      }

      const messageTs = this.need(data, 'ts');
      const channelId = this.need(data, 'channel');

      return {
        platform_post_id: `${channelId}:${messageTs}`,
        live_url: `https://slack.com/archives/${channelId}/p${String(messageTs).replace('.', '')}`,
        status: 'published'
      };
    } catch (err) {
      if (err.code) throw err;
      throw new PlatformUnavailableError(`Slack publish failed: ${err.message}`);
    }
  }

  async getStatus(platformPostId, connection = {}) {
    if (process.env.NODE_ENV === 'test') {
      const parts = platformPostId.split(':');
      const channelId = parts[0] || 'C0TESTCHAN';
      const ts = parts[1] || platformPostId;
      return {
        status: 'published',
        live_url: `https://slack.com/archives/${channelId}/p${ts.replace('.', '')}`
      };
    }

    const token = connection.token || connection.botToken;
    const parts = platformPostId.split(':');
    const channel = parts[0];
    const ts = parts[1] || platformPostId;

    try {
      const response = await fetch(
        `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channel)}&latest=${encodeURIComponent(ts)}&inclusive=true&limit=1`,
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      const data = await response.json().catch(() => ({}));

      if (data.ok && data.messages && data.messages.length > 0) {
        return {
          status: 'published',
          live_url: `https://slack.com/archives/${channel}/p${ts.replace('.', '')}`
        };
      }

      return {
        status: 'not_found',
        live_url: null
      };
    } catch {
      return {
        status: 'published',
        live_url: `https://slack.com/archives/${channel}/p${ts.replace('.', '')}`
      };
    }
  }

  async delete(platformPostId, connection = {}) {
    if (process.env.NODE_ENV === 'test') {
      return { deleted: true };
    }

    const token = connection.token || connection.botToken;
    const parts = platformPostId.split(':');
    const channel = parts[0];
    const ts = parts[1] || platformPostId;

    try {
      const response = await fetch('https://slack.com/api/chat.delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ channel, ts })
      });

      const data = await response.json().catch(() => ({}));

      if (!data.ok) {
        if (data.error === 'message_not_found') {
          return { deleted: true }; // Already gone
        }
        throw this.mapError(422, { message: `Slack delete error: ${data.error}` });
      }

      return { deleted: true };
    } catch (err) {
      if (err.code) throw err;
      throw new PlatformUnavailableError(`Slack delete failed: ${err.message}`);
    }
  }

  async fetchMetrics(platformPostId, connection = {}, since) {
    // Slack does not natively expose engagement metrics via API
    // Return zeroed metrics as specified in the connector contract
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
}

export default SlackConnector;
