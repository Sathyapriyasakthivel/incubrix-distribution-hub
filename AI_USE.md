# AI Use and Assistance Disclosure

This document discloses all Artificial Intelligence (AI) tools, models, workflows, prompt methodologies, and division of responsibilities employed in the design, development, debugging, and verification of the **Longtail Distribution Hub** (IncuBrix Distribution Network) service.

---

## 1. Executive Summary & Integrity Statement

In accordance with rigorous engineering and portfolio integrity standards:
- **Zero Fakes Mandate**: Hardcoded fake metrics, canned AI outputs, always-passing steps, and synthetic `example.org` destinations were replaced with real test-verified implementations.
- **Test-Driven Progression**: Failing tests were authored first, implementations written, and verified green with `npm test`. All 179 automated tests across 30 test suites pass with zero API keys required.
- **AI Tool Utilization**: Google Antigravity IDE (driven by Google DeepMind Gemini models) was utilized as the primary agentic coding pair programmer.
- **Safety & Secret Isolation**: Zero production secrets, private tokens, or real user community credentials were used. Local containers (Ghost 5, Lemmy 0.19) and in-process mock platform routes handle all tests.

---

## 2. Tools & Models Employed

| Tool / Platform | Model | Primary Use Case |
|---|---|---|
| **Google Antigravity IDE** | Gemini models | End-to-end task analysis, code implementation, test authoring, database migrations, benchmarking, and documentation |
| **Node.js Test Runner (Vitest)** | Deterministic Assertion Engine | Automated execution and verification of all implementation steps (179 tests) |
| **Local Mock Platform Server** | Deterministic Express Engine | Simulating upstream platform behaviors, fault injection, and edge cases |

---

## 3. Workflows and Scope of AI Assistance

### 3.1 Honesty & Fake Removal
- Removed unverified claims and marked items accurately.
- Removed canned `captureRulesFromUrl()` output with fixed `ai_confidence_score: 0.94`.
- Removed self-scoring precision metric in `recommendDestinations()`.
- Removed always-passing steps in `certificationHarness.js`.
- Purged synthetic `... Destination #N` on `example.org` rows from the seed catalogue and isolated synthetic data strictly to test fixtures.

### 3.2 Core Reliability & Connectors
- **Local Test Containers & Bootstrap**: Configured `docker-compose.yml` with Ghost 5 (SQLite), Lemmy 0.19.8, and wrote `scripts/bootstrap_local.js`. Enforced `secret_ref` checks with `CONNECTION_SECRET_MISSING`.
- **10-Step Certification Harness**: Implemented strict 10-step certification pipeline with test post cleanup, persistent `test_posts` TTL sweeper table, local evidence storage, and non-transient failure demotion logic with `BaseConnector.need()`.
- **Certification Enforcement & Rules Precedence**: Blocked uncertified/demoted publishing with `DEST_NOT_CERTIFIED` / `DEST_DEMOTED`. Fixed rules engine precedence (BLOCK over RESCHEDULE), frequency cap handling for null values, and connector pre-flight spec validation (`DEST_SPEC_VIOLATION`).
- **Safe Retries across Timeouts**: Created `publish_attempts` table, embedded idempotency markers in posts, implemented `findByMarker()` across connectors, and built fault handling proving zero duplicate posts.
- **Header Rate Limits & Circuit Breaker**: Added `Retry-After` / `X-RateLimit-Reset` header parsing, `rate_limited_until` per destination with `run_at` re-queueing, and a 5-failure circuit breaker.
- **Universal Idempotency**: Mounted universal Express middleware across all `/api/v1` POST routes returning 400 `IDEMPOTENCY_KEY_REQUIRED`, 409 conflict on payload mismatch, and cached replays.
- **Strict JSON Errors**: Added catch-all JSON error handlers for 404, 405, and malformed JSON payloads returning the standard error envelope.
- **Decoupled Storage**: Defaulted to local filesystem storage with S3 client integration.
- **Output Manifest**: Populated dynamic warnings, models, seed information, timings, cost estimates, and license metadata.
- **Connector Contracts**: Built connector architecture with declarative manifest schema validation, verifying all contract methods.
- **Job Queue Persistence & Recovery**: Added `run_at` delayed execution, startup stuck job recovery, and manifest linkage.
- **Simulation Fault Injection**: Built `POST /api/v1/sim/inject` and `/sim/reset` supporting `429`, `401`, `422`, `500`, `timeout_before_commit`, `timeout_after_commit`, `rename_field`, and `revoke`.

### 3.3 Advanced Features & Benchmarks
- **Catalogue Import Benchmark**: Built 25-worker concurrency pool with URL normalisation, deduplication, reachability checks, and API enrichment.
- **Rules Capture Adapter**: Created `RulesCaptureAdapter` with deterministic mock fixture provider and LLM provider, quote evidence extraction, dynamic confidence scoring, and human confirmation endpoint `POST /api/v1/destinations/{id}/rules/confirm`.
- **MRSS Video Feed Connector**: Added connector serving valid Media RSS 2.0 XML with enclosure tags and full 10-step certification.
- **fetch_metrics Normalization**: Implemented 7 standardized engagement fields (`views, likes, comments, shares, saves, watch_time_s, clicks`) across connectors.
- **Recommender Precision**: Formatted ground-truth items covering diverse topics and evaluated top-10 ranking.
- **Recertification Scheduler**: Added automated interval scheduler querying destinations older than 25 days, demoting failures, recording in `alerts` table, and dispatching webhook notifications.
- **Real Catalogue - 150 Destinations**: Curated 150 verified real public destinations across verticals with working URLs, rules URLs, summarized rules, audience tags, language/geo, public audience counts, `source_url`, and `researched_at`.
- **Culture Tailoring**: Implemented discussion-first framing, canonical URL backlinks, boundary truncation, platform hashtags, and automatic AI disclosure notices.

### 3.4 Deliverables & Evidence
- **Batch Runner CLI**: Enhanced `scripts/batch_runner.js` to call public HTTP API with `--api` and `--token`, handle folders/files, validate hard case expectations, and save per-item result files.
- **OpenAPI 3.1 Spec**: Synchronized `openapi.yaml` with all registered Express routes and added an automated test asserting exact bidirectional parity.
- **Documentation**: Assembled technical evidence, updated `SOURCES.md`, `README.md`, and `docs/ENGINEERING_NOTES.md`.
