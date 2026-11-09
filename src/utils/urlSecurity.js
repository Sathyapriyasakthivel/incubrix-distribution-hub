import http from 'node:http';
import https from 'node:https';
import { IncuBrixError } from './errors.js';

/**
 * Check whether a hostname resolves to a private, loopback, or cloud-metadata IP
 */
export function isPrivateHost(hostname) {
  if (!hostname) return true;
  const lower = hostname.toLowerCase();

  // Loopback and local names
  if (lower === 'localhost' || lower === '127.0.0.1' || lower === '::1' || lower === '0.0.0.0') {
    return true;
  }
  if (lower.endsWith('.local') || lower.endsWith('.internal') || lower.endsWith('.corp')) {
    return true;
  }

  // Cloud metadata services
  if (lower === '169.254.169.254' || lower === 'metadata.google.internal' || lower === 'instance-data') {
    return true;
  }

  // IPv4 Private Ranges
  // 10.0.0.0/8
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower)) return true;
  // 127.0.0.0/8
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower)) return true;
  // 169.254.0.0/16
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(lower)) return true;
  // 172.16.0.0/12 (172.16.0.0 – 172.31.255.255)
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(lower)) return true;
  // 192.168.0.0/16
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(lower)) return true;
  // 100.64.0.0/10 (Carrier-grade NAT)
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(lower)) return true;
  // 0.0.0.0/8
  if (/^0\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower)) return true;

  // IPv6 Private & Link-local
  if (lower.startsWith('fe80:') || lower.startsWith('fc00:') || lower.startsWith('fd')) {
    return true;
  }

  return false;
}

/**
 * Validate a target URL against SSRF and protocol rules
 */
export function validateUrl(rawUrl, options = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    throw new IncuBrixError('INVALID_URL', `Malformed URL: ${rawUrl}`, { url: rawUrl }, 400);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new IncuBrixError('INVALID_PROTOCOL', `Unsupported protocol '${parsed.protocol}'. Only http: and https: are allowed.`, { url: rawUrl }, 400);
  }

  const allowPrivate = options.allowPrivate || process.env.ALLOW_LOCAL_NETWORK === 'true';

  if (!allowPrivate && isPrivateHost(parsed.hostname)) {
    throw new IncuBrixError(
      'SSRF_BLOCKED',
      `Access to private, loopback, or metadata network addresses is prohibited (${parsed.hostname})`,
      { hostname: parsed.hostname, url: rawUrl },
      403
    );
  }

  return parsed;
}

/**
 * Safe fetch with SSRF blocking, size limit enforcement, and timeout
 */
export async function safeFetch(rawUrl, options = {}) {
  const parsed = validateUrl(rawUrl, options);
  const timeoutMs = options.timeoutMs || 5000;
  const maxBytes = options.maxBytes || 5 * 1024 * 1024; // 5MB default

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(parsed.toString(), {
      method: options.method || 'GET',
      headers: {
        'User-Agent': options.userAgent || 'IncuBrix-SecuritySafeFetch/1.0',
        ...(options.headers || {})
      },
      signal: controller.signal
    });

    if (!res.ok && !options.allowNon2xx) {
      throw new IncuBrixError('FETCH_FAILED', `Remote server returned HTTP ${res.status}`, { status: res.status, url: rawUrl }, res.status >= 500 ? 502 : 400);
    }

    // Size limit check via Content-Length header
    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      throw new IncuBrixError('PAYLOAD_TOO_LARGE', `Remote response (${contentLength} bytes) exceeds maximum size of ${maxBytes} bytes`, { maxBytes, receivedBytes: parseInt(contentLength, 10) }, 413);
    }

    // Read body safely with chunk size accumulation
    const reader = res.body?.getReader();
    if (!reader) {
      const text = await res.text();
      if (Buffer.byteLength(text) > maxBytes) {
        throw new IncuBrixError('PAYLOAD_TOO_LARGE', `Response size exceeds limit of ${maxBytes} bytes`, {}, 413);
      }
      return { status: res.status, headers: res.headers, text };
    }

    const chunks = [];
    let receivedBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.length;
      if (receivedBytes > maxBytes) {
        reader.cancel();
        throw new IncuBrixError('PAYLOAD_TOO_LARGE', `Response size exceeded maximum allowed limit of ${maxBytes} bytes`, { maxBytes, receivedBytes }, 413);
      }
      chunks.push(value);
    }

    const fullBuffer = Buffer.concat(chunks);
    const text = fullBuffer.toString('utf8');

    return {
      status: res.status,
      headers: res.headers,
      text,
      buffer: fullBuffer
    };
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new IncuBrixError('FETCH_TIMEOUT', `Request to ${parsed.hostname} timed out after ${timeoutMs}ms`, { timeoutMs }, 504);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check whether robots.txt allows crawling the given URL
 */
export async function checkRobotsTxt(targetUrl, userAgent = 'IncuBrix-RulesCapture', options = {}) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return { allowed: true };
  }

  const robotsUrl = `${parsed.protocol}//${parsed.host}/robots.txt`;

  try {
    const res = await safeFetch(robotsUrl, {
      timeoutMs: options.timeoutMs || 2000,
      maxBytes: 100 * 1024,
      allowNon2xx: true,
      allowPrivate: options.allowPrivate || false
    });

    if (res.status === 200 && res.text) {
      const isAllowed = parseRobotsTxtAllowed(res.text, parsed.pathname, userAgent);
      if (!isAllowed) {
        return {
          allowed: false,
          reason: `Path '${parsed.pathname}' is disallowed by community robots.txt at ${robotsUrl}`
        };
      }
    }
  } catch {
    // If robots.txt cannot be reached or times out, standard practice is to proceed
  }

  return { allowed: true };
}

/**
 * Basic robots.txt parser for Disallow rules
 */
export function parseRobotsTxtAllowed(robotsText, pathname, userAgent = '*') {
  const lines = robotsText.split('\n').map(l => l.trim());
  let appliesToUs = false;
  const disallows = [];
  const allows = [];

  for (const line of lines) {
    const clean = line.replace(/#.*$/, '').trim();
    if (!clean) continue;

    const [key, ...rest] = clean.split(':');
    const val = rest.join(':').trim();

    if (/^user-agent$/i.test(key)) {
      if (val === '*' || val.toLowerCase() === userAgent.toLowerCase()) {
        appliesToUs = true;
      } else {
        appliesToUs = false;
      }
    } else if (appliesToUs) {
      if (/^disallow$/i.test(key) && val) {
        disallows.push(val);
      } else if (/^allow$/i.test(key) && val) {
        allows.push(val);
      }
    }
  }

  // Sort rules by path length descending (most specific match wins per RFC 9309)
  const allRules = [
    ...allows.map(p => ({ path: p, allow: true })),
    ...disallows.map(p => ({ path: p, allow: false }))
  ].sort((a, b) => b.path.length - a.path.length);

  for (const rule of allRules) {
    if (pathname.startsWith(rule.path)) {
      return rule.allow;
    }
  }

  return true;
}
