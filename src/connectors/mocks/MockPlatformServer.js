import express from 'express';
import crypto from 'node:crypto';
import logger from '../../utils/logger.js';
import simulationService from '../../services/simulation/simulationService.js';

/**
 * Deterministic Mock Platform Server for IncuBrix Connectors
 * Supports Discourse, Lemmy, Dev.to, Ghost, Webhook receiver, and Slack/Hashnode
 * Supports fault injection via headers:
 * - X-Mock-Fault: 'rate_limit' | 'auth_expired' | 'content_rejected' | 'timeout' | 'server_error' | 'field_rename'
 */
export function createMockPlatformApp(options = {}) {
  const app = express();
  app.use(express.json());

  // In-memory mock storage for published posts
  const posts = new Map();
  const deletedPosts = new Set();
  const webhookLogs = [];

  // Fault injection middleware (supports X-Mock-Fault headers and Reviewer Sim Injection)
  app.use((req, res, next) => {
    const pathParts = req.path.split('/').filter(Boolean);
    const platform = pathParts[0] || 'all';

    const headerFault = req.headers['x-mock-fault'];
    const injected = simulationService.getInjectedFault(platform);

    const fault = headerFault || injected?.fault;
    const resetS = req.headers['x-mock-reset-s'] || injected?.reset_s || 15;

    if (fault) {
      if (fault === 'rate_limit' || fault === '429') {
        res.setHeader('Retry-After', String(resetS));
        return res.status(429).json({
          error: 'Rate limit exceeded',
          retry_after: Number(resetS),
          message: `Too many requests. Please wait ${resetS} seconds.`
        });
      }
      if (fault === 'auth_expired' || fault === '401') {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Token has expired or was revoked'
        });
      }
      if (fault === 'content_rejected' || fault === '422') {
        return res.status(422).json({
          error: 'Unprocessable Entity',
          message: 'Platform moderation policy rejected content: forbidden keywords detected'
        });
      }
      if (fault === 'server_error' || fault === '500') {
        return res.status(500).json({
          error: 'Internal Server Error',
          message: 'Platform database connection failed'
        });
      }
      if (fault === 'timeout_before_commit') {
        req.socket.destroy();
        return;
      }
      if (fault === 'revoke') {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Partner integration revoked by community admin'
        });
      }
      if (fault === 'timeout') {
        // Delay response to simulate timeout or abort
        setTimeout(() => {
          if (!res.headersSent) {
            res.status(504).json({ error: 'Gateway Timeout', message: 'Platform upstream timed out' });
          }
        }, 3000);
        return;
      }
      if (fault === 'field_rename' || fault === 'rename_field') {
        // Returns a response where the standard id field is renamed, breaking contract
        return res.status(200).json({
          unexpected_identifier_key: 'post_' + crypto.randomUUID().slice(0, 8),
          malformed: true
        });
      }
    }
    next();
  });

  // --- DISCOURSE MOCK API ---
  app.post('/discourse/posts.json', (req, res) => {
    const apiKey = req.headers['api-key'];
    const apiUsername = req.headers['api-username'];
    if (!apiKey || apiKey === 'invalid_key') {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    const { title, raw, category } = req.body;
    const postId = 'disc_' + Math.floor(10000 + Math.random() * 90000);
    const postData = {
      id: postId,
      title: title || 'Discourse Topic',
      raw,
      category,
      created_at: new Date().toISOString(),
      views: 12,
      like_count: 3,
      posts_count: 1
    };
    posts.set(postId, postData);

    const fault = req.headers['x-mock-fault'] || simulationService.getInjectedFault('discourse')?.fault;
    if (fault === 'timeout_after_commit') {
      req.socket.destroy();
      return;
    }

    const protocol = req.protocol || 'http';
    const host = req.get('host') || `127.0.0.1:${options.port || 4000}`;
    const baseUrl = req.get('host')
      ? `${protocol}://${host}${req.baseUrl || '/mock'}`
      : (process.env.APP_URL ? `${process.env.APP_URL.replace(/\/+$/, '')}${req.baseUrl || '/mock'}` : `${protocol}://${host}${req.baseUrl || '/mock'}`);

    return res.status(200).json({
      id: postId,
      post_number: 1,
      topic_id: postId,
      topic_slug: 'test-topic',
      url: `${baseUrl}/discourse/t/test-topic/${postId}`,
      ...postData
    });
  });

  app.get('/discourse/search.json', (req, res) => {
    const q = (req.query.q || '').trim();
    const matching = [];
    for (const [id, post] of posts.entries()) {
      if (deletedPosts.has(id)) continue;
      if (!q || (post.raw && post.raw.includes(q)) || (post.title && post.title.includes(q))) {
        matching.push({
          id: post.id,
          post_number: 1,
          topic_id: post.id,
          topic_slug: post.topic_slug || 'test-topic',
          title: post.title,
          blurb: post.raw,
          raw: post.raw
        });
      }
    }
    return res.status(200).json({ posts: matching });
  });

  app.get('/discourse/posts/:id.json', (req, res) => {
    const post = posts.get(req.params.id);
    if (!post || deletedPosts.has(req.params.id)) {
      return res.status(404).json({ error: 'Post not found' });
    }
    return res.status(200).json(post);
  });

  app.delete('/discourse/posts/:id.json', (req, res) => {
    const id = req.params.id;
    if (!posts.has(id) || deletedPosts.has(id)) {
      return res.status(404).json({ error: 'Post not found' });
    }
    deletedPosts.add(id);
    return res.status(200).json({ success: 'OK' });
  });

  app.get('/discourse/topics/:id.json', (req, res) => {
    const post = posts.get(req.params.id);
    if (!post || deletedPosts.has(req.params.id)) {
      return res.status(404).json({ error: 'Topic not found' });
    }
    return res.status(200).json({
      id: post.id,
      views: post.views,
      like_count: post.like_count,
      posts_count: post.posts_count
    });
  });

  // Discourse public live URL web page
  app.get(['/discourse/t/:slug/:id', '/discourse/t/:id'], (req, res) => {
    const id = req.params.id;
    const post = posts.get(id);
    if (!post || deletedPosts.has(id)) {
      return res.status(404).send('<html><body>Not Found</body></html>');
    }
    return res.status(200).send(`<html><head><title>${post.title}</title></head><body><h1>${post.title}</h1><div>${post.raw}</div></body></html>`);
  });

  // Discourse cheap authenticated endpoint
  app.get(['/discourse/site/basic-info.json', '/discourse/about.json'], (req, res) => {
    const apiKey = req.headers['api-key'];
    if (!apiKey || apiKey === 'invalid_key') {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    return res.status(200).json({ title: 'Mock Discourse Community', description: 'Test Forum' });
  });

  // --- LEMMY MOCK API ---
  app.post('/lemmy/api/v3/post', (req, res) => {
    const auth = req.body.auth || req.headers.authorization;
    if (!auth || auth.includes('invalid')) {
      return res.status(401).json({ error: 'not_logged_in' });
    }

    const { name, body, community_id } = req.body;
    const postId = 'lemmy_' + Math.floor(10000 + Math.random() * 90000);
    const host = req.get('host') || `127.0.0.1:${options.port || 4000}`;
    const protocol = req.protocol || 'http';
    const baseUrl = req.get('host')
      ? `${protocol}://${host}${req.baseUrl || '/mock'}`
      : (process.env.APP_URL ? `${process.env.APP_URL.replace(/\/+$/, '')}${req.baseUrl || '/mock'}` : `${protocol}://${host}${req.baseUrl || '/mock'}`);
    const apId = `${baseUrl}/lemmy/post/${postId}`;

    const postData = {
      id: postId,
      name,
      body,
      community_id,
      ap_id: apId,
      deleted: false,
      counts: {
        score: 5,
        upvotes: 6,
        downvotes: 1,
        comments: 2
      }
    };
    posts.set(postId, postData);

    const fault = req.headers['x-mock-fault'] || simulationService.getInjectedFault('lemmy')?.fault;
    if (fault === 'timeout_after_commit') {
      req.socket.destroy();
      return;
    }

    return res.status(200).json({
      post_view: {
        post: postData,
        counts: postData.counts
      }
    });
  });

  app.get('/lemmy/api/v3/search', (req, res) => {
    const q = (req.query.q || '').trim();
    const matching = [];
    for (const [id, post] of posts.entries()) {
      if (deletedPosts.has(id)) continue;
      if (!q || (post.body && post.body.includes(q)) || (post.name && post.name.includes(q))) {
        matching.push({
          post: {
            id: post.id,
            name: post.name,
            body: post.body,
            ap_id: post.ap_id,
            deleted: false
          }
        });
      }
    }
    return res.status(200).json({ posts: matching });
  });

  app.get('/lemmy/api/v3/post', (req, res) => {
    const id = req.query.id;
    const postData = posts.get(id);
    if (!postData || deletedPosts.has(id)) {
      return res.status(404).json({ error: 'couldnt_find_post' });
    }
    return res.status(200).json({
      post_view: {
        post: postData,
        counts: postData.counts
      }
    });
  });

  app.post('/lemmy/api/v3/post/delete', (req, res) => {
    const auth = req.headers.authorization || req.body.auth;
    const { post_id } = req.body;
    if (!auth || auth.includes('invalid')) {
      return res.status(401).json({ error: 'not_logged_in' });
    }
    if (!posts.has(post_id) || deletedPosts.has(post_id)) {
      return res.status(404).json({ error: 'couldnt_find_post' });
    }
    deletedPosts.add(post_id);
    return res.status(200).json({
      post_view: {
        post: { id: post_id, deleted: true }
      }
    });
  });

  // Lemmy public live URL web page
  app.get('/lemmy/post/:id', (req, res) => {
    const post = posts.get(req.params.id);
    if (!post || deletedPosts.has(req.params.id)) {
      return res.status(404).send('<html><body>Post Not Found</body></html>');
    }
    return res.status(200).send(`<html><head><title>${post.name}</title></head><body><h1>${post.name}</h1><div>${post.body}</div></body></html>`);
  });

  // Lemmy cheap authenticated endpoint
  app.get('/lemmy/api/v3/site', (req, res) => {
    const auth = req.query.auth || req.headers.authorization;
    if (auth && auth.includes('invalid')) {
      return res.status(401).json({ error: 'not_logged_in' });
    }
    return res.status(200).json({ site_view: { site: { name: 'Mock Lemmy Community' } } });
  });

  // --- DEV.TO MOCK API ---
  app.post('/devto/api/articles', (req, res) => {
    const apiKey = req.headers['api-key'];
    if (!apiKey || apiKey === 'invalid_key') {
      return res.status(401).json({ error: 'Unauthorized: api-key invalid' });
    }

    const article = req.body.article || {};
    const articleId = 'devto_' + Math.floor(10000 + Math.random() * 90000);
    const host = req.get('host') || `127.0.0.1:${options.port || 4000}`;
    const protocol = req.protocol || 'http';
    const baseUrl = req.get('host')
      ? `${protocol}://${host}${req.baseUrl || '/mock'}`
      : (process.env.APP_URL ? `${process.env.APP_URL.replace(/\/+$/, '')}${req.baseUrl || '/mock'}` : `${protocol}://${host}${req.baseUrl || '/mock'}`);
    const articleUrl = `${baseUrl}/devto/articles/${articleId}`;

    const data = {
      id: articleId,
      title: article.title,
      body_markdown: article.body_markdown,
      url: articleUrl,
      page_views_count: 45,
      positive_reactions_count: 8,
      comments_count: 3
    };
    posts.set(articleId, data);

    const fault = req.headers['x-mock-fault'] || simulationService.getInjectedFault('devto')?.fault;
    if (fault === 'timeout_after_commit') {
      req.socket.destroy();
      return;
    }

    return res.status(201).json(data);
  });

  app.get('/devto/api/articles/:id', (req, res) => {
    const article = posts.get(req.params.id);
    if (!article || deletedPosts.has(req.params.id)) {
      return res.status(404).json({ error: 'Article not found' });
    }
    return res.status(200).json(article);
  });

  // Dev.to public live URL web page
  app.get('/devto/articles/:id', (req, res) => {
    const article = posts.get(req.params.id);
    if (!article || deletedPosts.has(req.params.id)) {
      return res.status(404).send('<html><body>Not Found</body></html>');
    }
    return res.status(200).send(`<html><head><title>${article.title}</title></head><body><h1>${article.title}</h1><div>${article.body_markdown}</div></body></html>`);
  });

  // Dev.to authenticated listing / search endpoint
  app.get('/devto/api/articles/me/all', (req, res) => {
    const apiKey = req.headers['api-key'];
    if (!apiKey || apiKey === 'invalid_key') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const articles = [];
    for (const [id, post] of posts.entries()) {
      if (deletedPosts.has(id)) continue;
      if (id.startsWith('devto_')) {
        articles.push(post);
      }
    }
    if (articles.length === 0) {
      articles.push({ id: 1, title: 'My Article', body_markdown: 'Sample body' });
    }
    return res.status(200).json(articles);
  });

  app.delete('/devto/api/articles/:id', (req, res) => {
    const id = req.params.id;
    if (!posts.has(id) || deletedPosts.has(id)) {
      return res.status(404).json({ error: 'Article not found' });
    }
    deletedPosts.add(id);
    return res.status(200).json({ message: 'Article deleted successfully' });
  });

  // --- GHOST MOCK API ---
  app.post('/ghost/api/admin/posts', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || auth.includes('invalid')) {
      return res.status(401).json({
        errors: [{ message: 'Ghost Admin token expired or invalid', errorType: 'UnauthorizedError' }]
      });
    }

    const postInput = req.body.posts?.[0] || {};
    const postId = 'ghost_' + Math.floor(10000 + Math.random() * 90000);
    const host = req.get('host') || `127.0.0.1:${options.port || 4000}`;
    const protocol = req.protocol || 'http';
    const baseUrl = req.get('host')
      ? `${protocol}://${host}${req.baseUrl || '/mock'}`
      : (process.env.APP_URL ? `${process.env.APP_URL.replace(/\/+$/, '')}${req.baseUrl || '/mock'}` : `${protocol}://${host}${req.baseUrl || '/mock'}`);
    const postUrl = `${baseUrl}/ghost/post/${postId}`;

    const postData = {
      id: postId,
      title: postInput.title,
      html: postInput.html,
      status: postInput.status || 'published',
      url: postUrl,
      count: {
        clicks: 14,
        positive_feedback: 4
      }
    };
    posts.set(postId, postData);

    const fault = req.headers['x-mock-fault'] || simulationService.getInjectedFault('ghost')?.fault;
    if (fault === 'timeout_after_commit') {
      req.socket.destroy();
      return;
    }

    return res.status(201).json({
      posts: [postData]
    });
  });

  app.get(['/ghost/api/admin/posts', '/ghost/api/admin/posts/'], (req, res) => {
    const matching = [];
    for (const [id, post] of posts.entries()) {
      if (deletedPosts.has(id)) continue;
      if (id.startsWith('ghost_')) {
        matching.push(post);
      }
    }
    return res.status(200).json({ posts: matching });
  });

  app.get('/ghost/api/admin/posts/:id', (req, res) => {
    const post = posts.get(req.params.id);
    if (!post || deletedPosts.has(req.params.id)) {
      return res.status(404).json({ errors: [{ message: 'Post not found', errorType: 'NotFoundError' }] });
    }
    return res.status(200).json({ posts: [post] });
  });

  app.delete('/ghost/api/admin/posts/:id', (req, res) => {
    const id = req.params.id;
    if (!posts.has(id) || deletedPosts.has(id)) {
      return res.status(404).json({ errors: [{ message: 'Post not found', errorType: 'NotFoundError' }] });
    }
    deletedPosts.add(id);
    return res.status(204).end();
  });

  // Ghost public live URL web page
  app.get('/ghost/post/:id', (req, res) => {
    const post = posts.get(req.params.id);
    if (!post || deletedPosts.has(req.params.id)) {
      return res.status(404).send('<html><body>Post Not Found</body></html>');
    }
    return res.status(200).send(`<html><head><title>${post.title}</title></head><body><h1>${post.title}</h1><div>${post.html}</div></body></html>`);
  });

  // Ghost cheap authenticated endpoint
  app.get('/ghost/api/admin/site', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || auth.includes('invalid')) {
      return res.status(401).json({ errors: [{ message: 'Unauthorized' }] });
    }
    return res.status(200).json({ site: { title: 'Mock Ghost Blog' } });
  });

  // --- GENERIC SIGNED WEBHOOK RECEIVER MOCK ---
  app.post('/webhook/receiver', (req, res) => {
    const signatureHeader = req.headers['x-incubrix-signature'];
    const timestampHeader = req.headers['x-incubrix-timestamp'];
    const secret = req.headers['x-webhook-secret'] || process.env.WEBHOOK_SHARED_SECRET || 'incubrix_webhook_dev_secret_xyz123';

    if (!signatureHeader) {
      return res.status(401).json({
        error: 'MissingSignature',
        message: 'X-IncuBrix-Signature header is missing'
      });
    }

    // Verify HMAC-SHA256 signature against raw payload
    const bodyString = JSON.stringify(req.body);
    const computedSignature = 'sha256=' + crypto.createHmac('sha256', secret).update(bodyString).digest('hex');

    if (signatureHeader !== computedSignature && signatureHeader !== 'mock_bypass_signature') {
      return res.status(401).json({
        error: 'InvalidSignature',
        message: 'HMAC signature verification failed. Shared secret mismatch or tampered body.'
      });
    }

    const event = req.body.event || 'publish';
    const webhookPostId = 'wh_' + Math.floor(10000 + Math.random() * 90000);
    const baseUrl = req.baseUrl || `http://localhost:${options.port || 4000}/mock`;

    const record = {
      id: webhookPostId,
      event,
      payload: req.body,
      idempotency_key: req.body.idempotency_key,
      received_at: new Date().toISOString(),
      url: `${baseUrl}/webhook/events/${webhookPostId}`
    };

    posts.set(webhookPostId, record);
    webhookLogs.push(record);

    const fault = req.headers['x-mock-fault'] || simulationService.getInjectedFault('webhook')?.fault;
    if (fault === 'timeout_after_commit') {
      req.socket.destroy();
      return;
    }

    return res.status(200).json({
      status: 'acknowledged',
      event_id: webhookPostId,
      live_url: record.url,
      timestamp: new Date().toISOString()
    });
  });

  app.get('/webhook/events', (req, res) => {
    const marker = (req.query.marker || req.query.q || '').trim();
    const matching = [];
    for (const [id, post] of posts.entries()) {
      if (deletedPosts.has(id)) continue;
      if (id.startsWith('wh_')) {
        if (!marker || JSON.stringify(post).includes(marker) || post.idempotency_key === marker) {
          matching.push({
            id: post.id,
            event_id: post.id,
            live_url: post.url,
            ...post
          });
        }
      }
    }
    return res.status(200).json(matching);
  });

  app.get('/webhook/events/:id', (req, res) => {
    const item = posts.get(req.params.id);
    if (!item || deletedPosts.has(req.params.id)) {
      return res.status(404).json({ error: 'Webhook event not found' });
    }
    return res.status(200).json(item);
  });

  app.delete('/webhook/events/:id', (req, res) => {
    const id = req.params.id;
    if (!posts.has(id) || deletedPosts.has(id)) {
      return res.status(404).json({ error: 'Webhook event not found' });
    }
    deletedPosts.add(id);
    return res.status(200).json({ deleted: true });
  });

  // Mock status endpoint
  app.get('/status', (req, res) => {
    res.json({
      status: 'healthy',
      active_posts: posts.size - deletedPosts.size,
      total_created: posts.size,
      total_deleted: deletedPosts.size
    });
  });

  return app;
}

export default createMockPlatformApp;
