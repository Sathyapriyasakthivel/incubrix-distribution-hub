import { describe, it, expect, beforeAll } from 'vitest';
import registry from '../../src/connectors/ConnectorRegistry.js';
import { inspectMediaItem } from '../../src/connectors/base/BaseConnector.js';

describe('P1-D: Media Validation & Deduplication Across Connectors', () => {
  it('inspectMediaItem correctly determines MIME types and categories', () => {
    expect(inspectMediaItem('https://example.com/photo.PNG').category).toBe('image');
    expect(inspectMediaItem('https://example.com/clip.mp4').category).toBe('video');
    expect(inspectMediaItem('https://example.com/audio.mp3').category).toBe('audio');
    expect(inspectMediaItem('https://example.com/document.pdf').category).toBe('application');
    expect(inspectMediaItem('https://www.youtube.com/watch?v=dQw4w9WgXcQ').category).toBe('video_link');
    expect(inspectMediaItem({ url: 'https://cdn.example/file', content_type: 'video/mp4' }).category).toBe('video');
  });

  it('Dev.to connector enforces [text, image] and rejects video with DEST_SPEC_VIOLATION', async () => {
    const devto = registry.getConnector('devto');
    
    // Valid image attachment
    const validRes = await devto.validate({
      title: 'Valid Devto Article Title Over 10 Chars',
      body: 'This is a sufficiently long body for Devto article requirements.',
      media_urls: ['https://example.com/screenshot.png']
    }, { simulation_mode: true }, {});
    expect(validRes.ok).toBe(true);
    expect(validRes.violations.length).toBe(0);

    // Unaccepted video attachment
    const invalidVideoRes = await devto.validate({
      title: 'Valid Devto Article Title Over 10 Chars',
      body: 'This is a sufficiently long body for Devto article requirements.',
      media_urls: ['https://example.com/demo-video.mp4']
    }, { simulation_mode: true }, {});
    expect(invalidVideoRes.ok).toBe(false);
    expect(invalidVideoRes.violations.length).toBeGreaterThan(0);
    const mediaViolation = invalidVideoRes.violations.find(v => v.field === 'media_urls');
    expect(mediaViolation).toBeDefined();
    expect(mediaViolation.rule).toBe('DEST_SPEC_VIOLATION');
    expect(mediaViolation.message).toContain('video/mp4');

    // Unaccepted audio attachment
    const invalidAudioRes = await devto.validate({
      title: 'Valid Devto Article Title Over 10 Chars',
      body: 'This is a sufficiently long body for Devto article requirements.',
      media_urls: ['https://example.com/podcast.mp3']
    }, { simulation_mode: true }, {});
    expect(invalidAudioRes.ok).toBe(false);
    expect(invalidAudioRes.violations.some(v => v.field === 'media_urls' && v.rule === 'DEST_SPEC_VIOLATION')).toBe(true);
  });

  it('Hashnode connector rejects video and non-image media with DEST_SPEC_VIOLATION', async () => {
    const hashnode = registry.getConnector('hashnode');
    const res = await hashnode.validate({
      title: 'Hashnode Article Title Over 10 Chars',
      body: 'Body text for hashnode post publication test.',
      media_urls: ['https://example.com/unsupported.mp4']
    }, { simulation_mode: true }, {});

    expect(res.ok).toBe(false);
    const violation = res.violations.find(v => v.field === 'media_urls');
    expect(violation).toBeDefined();
    expect(violation.rule).toBe('DEST_SPEC_VIOLATION');
  });

  it('Ghost connector accepts images and video links but rejects audio/application attachments', async () => {
    const ghost = registry.getConnector('ghost');

    // Accepts image and video link
    const validRes = await ghost.validate({
      title: 'Ghost Editorial Publication Article',
      body: 'Article text content for ghost publication test.',
      media_urls: ['https://example.com/hero.jpg', 'https://www.youtube.com/watch?v=12345']
    }, { simulation_mode: true }, {});
    expect(validRes.ok).toBe(true);

    // Rejects audio
    const invalidRes = await ghost.validate({
      title: 'Ghost Editorial Publication Article',
      body: 'Article text content for ghost publication test.',
      media_urls: ['https://example.com/recording.wav']
    }, { simulation_mode: true }, {});
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.violations.some(v => v.field === 'media_urls' && v.rule === 'DEST_SPEC_VIOLATION')).toBe(true);
  });

  it('Discourse connector accepts images and video links but rejects non-media attachments', async () => {
    const discourse = registry.getConnector('discourse');
    const invalidRes = await discourse.validate({
      title: 'Discussion: Architectural Patterns in Distributed Systems?',
      body: 'Sufficently long body for Discourse community guideline limits.',
      media_urls: ['https://example.com/installer.exe']
    }, { simulation_mode: true }, {});

    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.violations.some(v => v.field === 'media_urls' && v.rule === 'DEST_SPEC_VIOLATION')).toBe(true);
  });

  it('Lemmy connector accepts images and video links but rejects unaccepted documents', async () => {
    const lemmy = registry.getConnector('lemmy');
    const invalidRes = await lemmy.validate({
      title: 'Lemmy Fediverse Post Topic Title',
      body: 'Fediverse post body text with sufficient length.',
      media_urls: ['https://example.com/archive.zip']
    }, { simulation_mode: true }, {});

    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.violations.some(v => v.field === 'media_urls' && v.rule === 'DEST_SPEC_VIOLATION')).toBe(true);
  });

  it('MRSS connector accepts video and image but rejects unsupported media', async () => {
    const mrss = registry.getConnector('mrss');
    const invalidRes = await mrss.validate({
      title: 'MRSS Video Item Title',
      body: 'MRSS item description',
      media_urls: ['https://example.com/audio.mp3']
    }, { simulation_mode: true }, {});

    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.violations.some(v => v.field === 'media_urls')).toBe(true);
  });

  it('Validate response deduplicates identical violation messages', async () => {
    const devto = registry.getConnector('devto');
    const res = await devto.validate({
      title: 'Valid Devto Article Title Over 10 Chars',
      body: 'Sufficently long body for Devto article requirements.',
      media_urls: ['https://example.com/video1.mp4', 'https://example.com/video1.mp4']
    }, { simulation_mode: true }, {});

    expect(res.ok).toBe(false);
    // Deduplication should ensure no duplicate identical message
    const msgs = res.violations.map(v => v.message);
    const uniqueMsgs = new Set(msgs);
    expect(msgs.length).toBe(uniqueMsgs.size);
  });
});
