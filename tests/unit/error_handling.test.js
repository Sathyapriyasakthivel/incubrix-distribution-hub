import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('JSON Error Handling Everywhere', () => {
  const app = createApp();

  it('Unknown route returns standard 404 JSON error instead of HTML', async () => {
    const res = await request(app).get('/api/v1/unknown-endpoint-xyz');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toEqual({
      code: 'NOT_FOUND',
      message: expect.stringContaining('/api/v1/unknown-endpoint-xyz'),
      retryable: false,
      details: expect.any(Object)
    });
  });

  it('Malformed JSON payload returns standard 400 MALFORMED_JSON error', async () => {
    const res = await request(app)
      .post('/api/v1/destinations')
      .set('Idempotency-Key', 'err_test_malformed_json')
      .set('Content-Type', 'application/json')
      .send('{ "name": "Broken JSON", invalid ');

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error.code).toBe('MALFORMED_JSON');
    expect(res.body.error.retryable).toBe(false);
  });
});
