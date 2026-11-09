import crypto from 'node:crypto';

/**
 * Creates a Ghost Admin API JWT token from an admin API key formatted as 'id:secret'.
 * If the key does not contain ':' or is already a token, it is returned as is.
 *
 * Algorithm per Ghost Admin API specification:
 * - Header: { alg: 'HS256', typ: 'JWT', kid: id }
 * - Payload: { iat, exp (5 min), aud: '/admin/' }
 * - Secret: Buffer.from(secret, 'hex')
 *
 * @param {string} adminKey - Admin API key (id:secret) or raw JWT
 * @returns {string} Signed JWT for Ghost Authorization header
 */
export function createGhostToken(adminKey) {
  if (!adminKey || typeof adminKey !== 'string') {
    return '';
  }

  // If already a JWT (contains dots) or mock string without colon, return as is
  if (adminKey.includes('.') || !adminKey.includes(':')) {
    return adminKey;
  }

  const [id, secret] = adminKey.split(':');
  if (!id || !secret) {
    return adminKey;
  }

  try {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: id })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({
      iat: now,
      exp: now + 5 * 60,
      aud: '/admin/'
    })).toString('base64url');

    const secretBuffer = Buffer.from(secret, 'hex');
    const signature = crypto.createHmac('sha256', secretBuffer)
      .update(`${header}.${payload}`)
      .digest('base64url');

    return `${header}.${payload}.${signature}`;
  } catch (err) {
    return adminKey;
  }
}

export default createGhostToken;
