import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { parseArgs, executeHold, certifyLive } from '../../scripts/certify_live.js';
import { CertificationHarness } from '../../src/services/certification/certificationHarness.js';
import createMockPlatformApp from '../../src/connectors/mocks/MockPlatformServer.js';
import { initDatabase, setDatabase } from '../../src/database/db.js';
import { runMigrations } from '../../src/database/migrate.js';
import catalogueService from '../../src/services/catalogue/catalogueService.js';

describe('certify_live --hold flag & countdown execution', () => {
  describe('parseArgs CLI flag parsing', () => {
    it('defaults to hold = 0 when no flags are passed', () => {
      expect(parseArgs([])).toEqual({ hold: 0 });
    });

    it('parses --hold <seconds> correctly', () => {
      expect(parseArgs(['--hold', '10'])).toEqual({ hold: 10 });
      expect(parseArgs(['--hold', '45'])).toEqual({ hold: 45 });
    });

    it('parses --hold=<seconds> format correctly', () => {
      expect(parseArgs(['--hold=20'])).toEqual({ hold: 20 });
      expect(parseArgs(['--hold=100'])).toEqual({ hold: 100 });
    });

    it('handles --hold with missing or invalid value safely (defaults to 0)', () => {
      expect(parseArgs(['--hold'])).toEqual({ hold: 0 });
      expect(parseArgs(['--hold', 'not-a-number'])).toEqual({ hold: 0 });
      expect(parseArgs(['--hold=-15'])).toEqual({ hold: 0 });
      expect(parseArgs(['--hold', '-5'])).toEqual({ hold: 0 });
    });

    it('parses --hold correctly when mixed with other arguments', () => {
      expect(parseArgs(['--verbose', '--hold', '7', '--dry-run'])).toEqual({ hold: 7 });
      expect(parseArgs(['--env=production', '--hold=12'])).toEqual({ hold: 12 });
    });
  });

  describe('executeHold helper execution', () => {
    it('prints post URLs, counts down every second, and calls sleepFn', async () => {
      const logs = [];
      const mockLogger = (msg) => logs.push(msg);
      const sleepCalls = [];
      const mockSleep = async (ms) => {
        sleepCalls.push(ms);
      };

      await executeHold(3, {
        destination: { id: 'local-ghost', platform_key: 'ghost', url: 'http://localhost:2368' },
        testPostId: 'ghost_post_12345',
        testLiveUrl: 'http://localhost:2368/p/ghost_post_12345',
        connectorKey: 'ghost'
      }, {
        logger: mockLogger,
        sleepFn: mockSleep
      });

      // Assert sleep was called 3 times with 1000ms each
      expect(sleepCalls).toEqual([1000, 1000, 1000]);

      const logText = logs.join('\n');
      // Assert post URLs are printed for Ghost
      expect(logText).toContain('Live Post URL: http://localhost:2368/p/ghost_post_12345');
      expect(logText).toContain('Ghost Admin Editor: http://localhost:2368/ghost/#/editor/post/ghost_post_12345');
      expect(logText).toContain('Ghost Admin Posts: http://localhost:2368/ghost/#/posts');

      // Assert countdown was printed
      expect(logText).toContain('Deleting in 3s...');
      expect(logText).toContain('Deleting in 2s...');
      expect(logText).toContain('Deleting in 1s...');
      expect(logText).toContain('Hold complete (3s)');
    });

    it('prints Lemmy API and web URLs for Lemmy destinations', async () => {
      const logs = [];
      const mockLogger = (msg) => logs.push(msg);
      const mockSleep = vi.fn().mockResolvedValue(undefined);

      await executeHold(2, {
        destination: { id: 'local-lemmy', platform_key: 'lemmy', url: 'http://localhost:8536' },
        testPostId: '42',
        testLiveUrl: 'http://localhost:8536/post/42',
        connectorKey: 'lemmy'
      }, {
        logger: mockLogger,
        sleepFn: mockSleep
      });

      expect(mockSleep).toHaveBeenCalledTimes(2);

      const logText = logs.join('\n');
      expect(logText).toContain('Live Post URL: http://localhost:8536/post/42');
      expect(logText).toContain('Lemmy API: http://localhost:8536/api/v3/post?id=42');
      expect(logText).toContain('Lemmy Post: http://localhost:8536/post/42');
    });
  });

  describe('CertificationHarness integration with hold option', () => {
    let server;
    let mockApp;
    let testApp;
    let port;
    let db;

    beforeAll(async () => {
      mockApp = createMockPlatformApp();
      testApp = express();
      testApp.use(express.json());
      testApp.use('/mock', mockApp);

      await new Promise((resolve) => {
        server = testApp.listen(0, '127.0.0.1', () => {
          port = server.address().port;
          process.env.MOCK_GHOST_URL = `http://127.0.0.1:${port}/mock/ghost`;
          resolve();
        });
      });
    });

    afterAll(async () => {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    beforeEach(() => {
      db = initDatabase(':memory:');
      runMigrations(db);
      setDatabase(db);
      catalogueService.db = db;
    });

    afterEach(() => {
      if (db) db.close();
      setDatabase(null);
    });

    it('default hold=0 does not pause or invoke sleepFn', async () => {
      const dest = catalogueService.createDestination({
        name: 'Ghost Simulation Test Default',
        url: process.env.MOCK_GHOST_URL,
        platform_key: 'ghost',
        connector_key: 'ghost',
        simulation_mode: 1
      });

      const mockSleep = vi.fn();
      const harness = new CertificationHarness(db);

      const result = await harness.certifyDestination(dest.id, {
        sleepFn: mockSleep
      });

      expect(result.status).toBe('certified');
      expect(mockSleep).not.toHaveBeenCalled();
      expect(result.is_cleaned_up).toBe(true);
    });

    it('executes hold countdown before delete step when hold > 0 is provided', async () => {
      const dest = catalogueService.createDestination({
        name: 'Ghost Simulation Test With Hold',
        url: process.env.MOCK_GHOST_URL,
        platform_key: 'ghost',
        connector_key: 'ghost',
        simulation_mode: 1
      });

      const logs = [];
      const mockLogger = (msg) => logs.push(msg);
      const sleepCalls = [];
      const mockSleep = async (ms) => {
        sleepCalls.push(ms);
      };

      const harness = new CertificationHarness(db);

      const result = await harness.certifyDestination(dest.id, {
        hold: 2,
        sleepFn: mockSleep,
        logger: mockLogger
      });

      expect(result.status).toBe('certified');
      expect(sleepCalls).toEqual([1000, 1000]);
      expect(result.is_cleaned_up).toBe(true);

      const logText = logs.join('\n');
      expect(logText).toContain('[HOLD]');
      expect(logText).toContain('Deleting in 2s...');
      expect(logText).toContain('Deleting in 1s...');
      expect(logText).toContain('Ghost Admin');
    });
  });
});

