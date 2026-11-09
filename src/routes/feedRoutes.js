import express from 'express';
import { getDatabase } from '../database/db.js';

const router = express.Router();

function escapeXml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe).replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

/**
 * GET /feeds/:destination.xml
 * Returns valid Yahoo Media RSS 2.0 XML for video syndication
 */
router.get('/:destination.xml', (req, res, next) => {
  try {
    const destinationId = req.params.destination;
    const db = getDatabase();

    const dest = db.prepare('SELECT * FROM destinations WHERE id = ?').get(destinationId);
    const channelTitle = dest ? dest.name : `Channel ${destinationId}`;
    const channelLink = dest ? dest.url : `https://incubrix.internal/feeds/${destinationId}`;

    const items = db.prepare(`
      SELECT * FROM feed_items
      WHERE destination_id = ? AND status = 'published'
      ORDER BY created_at DESC
      LIMIT 100
    `).all(destinationId);

    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const feedUrl = `${appUrl.replace(/\/+$/, '')}/feeds/${destinationId}.xml`;

    const itemsXml = items.map(item => `
    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.link || item.media_url)}</link>
      <description>${escapeXml(item.description)}</description>
      <guid isPermaLink="false">${escapeXml(item.guid)}</guid>
      <pubDate>${new Date(item.created_at).toUTCString()}</pubDate>
      <media:content url="${escapeXml(item.media_url)}" medium="video" type="${escapeXml(item.media_type || 'video/mp4')}" duration="${item.media_duration || 120}" />
      ${item.thumbnail_url ? `<media:thumbnail url="${escapeXml(item.thumbnail_url)}" />` : ''}
    </item>`).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(channelTitle)} - IncuBrix MRSS Feed</title>
    <link>${escapeXml(channelLink)}</link>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />
    <description>IncuBrix Syndicated Video Feed for Long-Tail Distribution</description>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${itemsXml}
  </channel>
</rss>`;

    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.status(200).send(xml);
  } catch (err) {
    next(err);
  }
});

export default router;
