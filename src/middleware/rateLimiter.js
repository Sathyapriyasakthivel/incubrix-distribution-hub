import config from '../config/index.js';
import { PlatformRateLimitError } from '../utils/errors.js';

const requestStore = new Map();

// Periodic cleanup every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of requestStore.entries()) {
    if (now - record.windowStart > config.limits.rateLimitWindowMs) {
      requestStore.delete(key);
    }
  }
}, 300000).unref();

export function rateLimiterMiddleware(req, res, next) {
  // Exclude static assets and mock platform routes from strict rate limiting
  if (req.path.startsWith('/mock') || req.path.startsWith('/css') || req.path.startsWith('/js') || req.path.startsWith('/assets')) {
    return next();
  }

  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = config.limits.rateLimitWindowMs || 60000;
  const maxRequests = config.limits.rateLimitMaxRequests || 120;

  let record = requestStore.get(clientIp);
  if (!record || now - record.windowStart > windowMs) {
    record = { windowStart: now, count: 0 };
    requestStore.set(clientIp, record);
  }

  record.count++;

  res.setHeader('X-RateLimit-Limit', maxRequests);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - record.count));

  if (record.count > maxRequests) {
    const retryAfter = Math.ceil((record.windowStart + windowMs - now) / 1000);
    res.setHeader('Retry-After', retryAfter);
    return next(new PlatformRateLimitError(`API rate limit exceeded. Please wait ${retryAfter} seconds.`, {
      retryAfter
    }));
  }

  next();
}

export default rateLimiterMiddleware;
