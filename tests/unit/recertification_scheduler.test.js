import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase } from '../../src/database/db.js';
import { runMigrations } from '../../src/database/migrate.js';
import { CatalogueService } from '../../src/services/catalogue/catalogueService.js';
import { CertificationHarness } from '../../src/services/certification/certificationHarness.js';
import { RecertificationScheduler } from '../../src/services/certification/recertificationScheduler.js';

describe('Recertification Scheduler Unit Tests (Outstanding Level)', () => {
  let db;
  let catalogue;
  let harness;
  let scheduler;

  beforeEach(() => {
    db = initDatabase(':memory:');
    runMigrations(db);
    catalogue = new CatalogueService(db);
    harness = new CertificationHarness(db);
    scheduler = new RecertificationScheduler(db, harness);
  });

  it('Identifies destinations due for recertification based on age', () => {
    // 1. Create destination certified 35 days ago
    const oldDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
    const dest1 = catalogue.createDestination({
      name: 'Old Certified Forum',
      url: 'https://old-forum.example',
      platform_key: 'discourse',
      connector_key: 'discourse',
      simulation_mode: true
    });
    db.run('UPDATE destinations SET status = ?, last_certified_at = ? WHERE id = ?', 'certified', oldDate, dest1.id);

    // 2. Create destination certified 5 days ago (fresh)
    const freshDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const dest2 = catalogue.createDestination({
      name: 'Fresh Certified Forum',
      url: 'https://fresh-forum.example',
      platform_key: 'discourse',
      connector_key: 'discourse',
      simulation_mode: true
    });
    db.run('UPDATE destinations SET status = ?, last_certified_at = ? WHERE id = ?', 'certified', freshDate, dest2.id);

    // 3. Create destination never certified (null)
    const dest3 = catalogue.createDestination({
      name: 'Uncertified Forum',
      url: 'https://uncertified-forum.example',
      platform_key: 'discourse',
      connector_key: 'discourse',
      simulation_mode: true
    });

    const dueList = scheduler.getDueDestinations(30);
    const dueIds = dueList.map(d => d.id);

    expect(dueIds).toContain(dest1.id); // > 30 days
    expect(dueIds).toContain(dest3.id); // never certified (null)
    expect(dueIds).not.toContain(dest2.id); // 5 days old (not due)
  });

  it('Executes recertification cycle and updates passing destination status', async () => {
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const dest = catalogue.createDestination({
      name: 'Valid Recert Forum',
      url: 'https://valid-recert.example',
      platform_key: 'discourse',
      connector_key: 'discourse',
      simulation_mode: true
    });
    db.run('UPDATE destinations SET status = ?, last_certified_at = ? WHERE id = ?', 'certified', oldDate, dest.id);

    const passingHarness = {
      certifyDestination: async (destId) => {
        db.run("UPDATE destinations SET status = 'certified', last_certified_at = ? WHERE id = ?", new Date().toISOString(), destId);
        return {
          status: 'certified',
          run_id: 'cert_mock_pass_123',
          duration_ms: 32
        };
      }
    };
    const passingScheduler = new RecertificationScheduler(db, passingHarness);
    const report = await passingScheduler.runCycle({ maxAgeDays: 30, limit: 10 });

    expect(report.passed).toBeGreaterThanOrEqual(1);
    expect(report.failed).toBe(0);

    const updated = catalogue.getDestination(dest.id);
    expect(updated.status).toBe('certified');
    expect(new Date(updated.last_certified_at).getTime()).toBeGreaterThan(Date.now() - 5000);

    // Check audit log
    const audit = db.get("SELECT * FROM audit_logs WHERE event_type = 'RECERTIFICATION_SUCCESS'");
    expect(audit).not.toBeNull();
  });

  it('Demotes destination and creates alert when recertification fails', async () => {
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const dest = catalogue.createDestination({
      name: 'Failing Destination',
      url: 'https://failing-recert.example',
      platform_key: 'devto',
      connector_key: 'devto',
      simulation_mode: true
    });
    db.run('UPDATE destinations SET status = ?, last_certified_at = ? WHERE id = ?', 'certified', oldDate, dest.id);

    // Mock harness failure
    const mockHarness = {
      certifyDestination: async () => {
        // Demote destination as harness does
        db.run("UPDATE destinations SET status = 'uncertified' WHERE id = ?", dest.id);
        return {
          status: 'failed',
          run_id: 'cert_mock_fail',
          error_message: 'Upstream API contract failure'
        };
      }
    };

    const failingScheduler = new RecertificationScheduler(db, mockHarness);
    const report = await failingScheduler.runCycle({ maxAgeDays: 30 });

    expect(report.failed).toBe(1);
    expect(report.demoted.length).toBe(1);
    expect(report.demoted[0].destination_id).toBe(dest.id);

    const updated = catalogue.getDestination(dest.id);
    expect(updated.status).toBe('uncertified');

    // Verify alert was logged in audit_logs
    const alert = db.get("SELECT * FROM audit_logs WHERE event_type = 'RECERTIFICATION_FAILURE_ALERT'");
    expect(alert).not.toBeNull();
    const payload = JSON.parse(alert.payload);
    expect(payload.alert_level).toBe('HIGH');
    expect(payload.action_taken).toBe('DEMOTED_TO_UNCERTIFIED');
  });

  it('Scheduler start and stop manages interval timer cleanly', () => {
    expect(scheduler.timer).toBeNull();
    scheduler.start(60000);
    expect(scheduler.timer).not.toBeNull();
    scheduler.stop();
    expect(scheduler.timer).toBeNull();
  });

  it('Records failure in alerts table and dispatches webhook when ALERT_WEBHOOK_URL is set', async () => {
    const originalFetch = global.fetch;
    let webhookCalled = false;
    let webhookPayload = null;

    global.fetch = async (url, opts) => {
      if (url === 'https://hooks.internal/alerts') {
        webhookCalled = true;
        webhookPayload = JSON.parse(opts.body);
        return { ok: true, status: 200 };
      }
      return { ok: true, status: 200 };
    };

    process.env.ALERT_WEBHOOK_URL = 'https://hooks.internal/alerts';

    try {
      const dest = catalogue.createDestination({
        name: 'Webhook Alert Dest',
        url: 'https://webhook-alert.example',
        platform_key: 'discourse',
        connector_key: 'discourse'
      });

      const mockHarness = {
        certifyDestination: async () => ({
          status: 'failed',
          run_id: 'cert_fail_alert',
          error_message: 'Auth token revoked by platform admin'
        })
      };

      const sched = new RecertificationScheduler(db, mockHarness);
      await sched.runCycle({ maxAgeDays: 0 });

      // 1. Verify alert inserted into alerts table
      const alertRow = db.get("SELECT * FROM alerts WHERE destination_id = ?", dest.id);
      expect(alertRow).not.toBeNull();
      expect(alertRow.level).toBe('error');
      expect(alertRow.event_type).toBe('RECERTIFICATION_FAILURE');
      expect(alertRow.message).toContain('Auth token revoked');

      // 2. Verify webhook dispatched
      expect(webhookCalled).toBe(true);
      expect(webhookPayload.destination_id).toBe(dest.id);
      expect(webhookPayload.level).toBe('error');
    } finally {
      global.fetch = originalFetch;
      delete process.env.ALERT_WEBHOOK_URL;
    }
  });

  it('Exposes recorded alerts via GET /api/v1/alerts', async () => {
    const { createApp } = await import('../../src/app.js');
    const { setDatabase } = await import('../../src/database/db.js');
    const request = (await import('supertest')).default;

    setDatabase(db);
    const app = createApp();

    // Insert alert directly
    db.prepare(`
      INSERT INTO alerts (id, level, event_type, destination_id, message, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('alert_test_001', 'error', 'RECERTIFICATION_FAILURE', 'dest_123', 'Sample certification failure', '{"reason":"401"}', new Date().toISOString());

    const res = await request(app).get('/api/v1/alerts');
    expect(res.status).toBe(200);
    expect(res.body.alerts).toBeInstanceOf(Array);
    expect(res.body.alerts.length).toBeGreaterThanOrEqual(1);
    expect(res.body.alerts[0].id).toBe('alert_test_001');
    expect(res.body.alerts[0].message).toBe('Sample certification failure');
  });
});

