# Longtail Distribution Hub: Test Pack Index

This index maps the core capabilities and reliability standards of the service to exact automated test suites, input fixtures, output artifacts, and evidence files.

## 1. Core Platform Capabilities

| Capability | Status | Primary Test / Code File | Generated Evidence / Output |
|-----------|--------|--------------------------|-----------------------------|
| **Core Connectors + Contract** | Yes | `tests/integration/connector_contract.test.js` | `certification-pack/{discourse,lemmy,devto,ghost}/run_record.json` |
| **Rules Engine** | Yes | `tests/unit/rules_engine.test.js` | `test-pack/outputs/result_002_case_02_self_promo_violation.json` |
| **Certification Harness** | Yes | `src/services/certification/certificationHarness.js` | `certification-pack/{discourse,lemmy,devto,ghost}/EVIDENCE.md` |
| **Assisted Publishing** | Yes | `tests/integration/publishing_lifecycle.test.js` | `test-pack/inputs/hard_cases_batch.json` |
| **Rate Limits & Circuit Breaker** | Yes | `tests/integration/simulation_injection.test.js` | `src/services/resilience/circuitBreaker.js` |
| **Safe Retries & Timeouts** | Yes | `tests/integration/timeout_retry.test.js` | `test-pack/outputs/result_007_case_07_valid_devto_canonical.json` |
| **Destination Catalogue** | Yes | `tests/unit/catalogue.test.js` | `data/catalogue_150_destinations.csv` |
| **Local Test Instances** | Yes | `docker-compose.yml`, `scripts/bootstrap_local.js` | `config/lemmy.hjson`, `.env.example` |
| **Webhook Connector** | Yes | `tests/unit/webhook_hmac.test.js` | `test-pack/outputs/result_008_case_08_valid_webhook_partner.json` |

---

## 2. Architecture & Reliability Standards

| Capability | Status | File / Test Evidence | Notes |
|------------|--------|----------------------|-------|
| **Node 22 + SQLite** | Yes | `package.json`, `src/database/db.js` | Native `node:sqlite` with WAL mode |
| **OpenAPI 3.1 Spec** | Yes | `tests/unit/openapi_valid.test.js` | Exact match with all registered Express routes |
| **Docker Compose** | Yes | `docker-compose.yml` | App, Ghost 5, Lemmy 0.19, Postgres, Pict-rs |
| **Idempotency on all POST**| Yes | `tests/unit/idempotency.test.js` | Universal middleware returning 400 on missing key |
| **Strict JSON Errors** | Yes | `tests/unit/error_handling.test.js` | 404, 405, syntax errors return `{"error": {...}}` |
| **Pino Structured Logging**| Yes | `src/utils/logger.js` | Redacted secrets, correlation IDs |
| **Decoupled Storage** | Yes | `src/services/storage/storageService.js` | Local storage with @aws-sdk/client-s3 integration |
| **Kill-Switch** | Yes | `tests/unit/rules_engine.test.js` | Immediate deactivation per connector |
| **Output Manifest** | Yes | `tests/unit/manifest.test.js` | Warnings, models, timings, license, cost |
| **Batch Runner CLI** | Yes | `tests/integration/batch_runner.test.js` | `test-pack/outputs/batch_summary.json` |

---

## 3. Advanced Features

| Feature | Status | Evidence File | Measured Result |
|---------|--------|---------------|-----------------|
| **Catalogue Import Benchmark** | Yes | `tests/unit/catalogue.test.js` | 1,000 rows imported in **1.26s** |
| **Rules Capture Adapter** | Yes | `tests/unit/rules_capture.test.js` | Mock & LLM providers with human confirm |
| **MRSS Video Feed Connector** | Yes | `tests/unit/mrss_feed.test.js` | Media RSS 2.0 XML with enclosure tags |
| **fetch_metrics (7 fields)** | Yes | `tests/unit/fetch_metrics.test.js` | Normalization across 6 connectors, L4 level |
| **Labelled Recommender Set** | Yes | `tests/integration/recommender_precision.test.js` | Evaluated across 50 curated items |
| **Recertification Scheduler** | Yes | `tests/unit/recertification_scheduler.test.js` | RECERT_BEFORE_DAYS=25 with alert webhooks |
| **Real 150 Catalogue** | Yes | `data/catalogue_150_destinations.csv` | 150 verified real public destinations, 0 synthetic |
| **Content Tailoring** | Yes | `tests/unit/tailoring.test.js` | Boundary truncation, framing, manifest warnings |
