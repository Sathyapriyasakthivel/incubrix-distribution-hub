import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { WebhookConnector } from '../../src/connectors/webhook/WebhookConnector.js';
import createMockPlatformApp from '../../src/connectors/mocks/MockPlatformServer.js';
import { AuthExpiredError } from '../../src/utils/errors.js';

describe('Hard Case 10: Webhook HMAC Signature & Rejection Tests', () => {
  let server;
  let mockUrl;
  let connector;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/mock', createMockPlatformApp({ port: 0 }));

    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        mockUrl = `http://127.0.0.1:${port}/mock/webhook`;
        resolve();
      });
    });

    connector = new WebhookConnector();
  });

  afterAll(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('HC10 (Success): Dispatches payload with valid HMAC-SHA256 signature', async () => {
    const destination = {
      id: 'dest_webhook_01',
      url: mockUrl,
      simulation_mode: false
    };
    const connection = {}; // Uses default system webhook shared secret
    const rendition = {
      title: 'Signed Webhook Event',
      body: 'This payload has a valid HMAC-SHA256 signature header.',
      canonical_url: 'https://incubrix.internal/test',
      is_ai_generated: false,
      is_promotional: false
    };

    const result = await connector.publish(rendition, destination, connection, 'idem_wh_001');

    expect(result).toBeDefined();
    expect(result.status).toBe('published');
    expect(result.platform_post_id).toMatch(/^wh_/);
    expect(result.live_url).toContain('/webhook/events/');
  });

  it('HC10 (Failure): Receiver rejects HMAC mismatch with 401 mapped to non-retryable AuthExpiredError', async () => {
    // Intentionally sign with a wrong secret so signature does not match receiver secret
    const wrongSecret = 'wrong_secret_tampered_key_999';
    const destination = {
      id: 'dest_webhook_02',
      url: mockUrl,
      simulation_mode: false
    };
    const connection = { secret: wrongSecret };
    const rendition = {
      title: 'Tampered Signature Webhook',
      body: 'Receiver should reject this with HTTP 401 InvalidSignature.',
      canonical_url: null,
      is_ai_generated: false,
      is_promotional: false
    };

    await expect(
      connector.publish(rendition, destination, connection, 'idem_wh_002')
    ).rejects.toThrow(AuthExpiredError);

    try {
      await connector.publish(rendition, destination, connection, 'idem_wh_002');
    } catch (err) {
      expect(err.code).toBe('CONNECTION_AUTH_EXPIRED');
      expect(err.retryable).toBe(false);
      expect(err.statusCode).toBe(401);
      expect(err.message).toContain('Webhook HMAC signature rejected by receiver');
    }
  });

  it('HC10: Querying status of published webhook event succeeds', async () => {
    const destination = { id: 'dest_webhook_03', url: mockUrl };
    const result = await connector.publish(
      { title: 'Status Check Event', body: 'Payload body' },
      destination,
      {},
      'idem_wh_003'
    );

    const statusResult = await connector.getStatus(result.platform_post_id, { baseUrl: mockUrl });
    expect(statusResult.status).toBe('published');
    expect(statusResult.platform_post_id).toBe(result.platform_post_id);
  });
});
