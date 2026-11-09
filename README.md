# Longtail Distribution Hub

> Runtime: Node.js 22 (ESM) | Express 5 | SQLite (`node:sqlite`) | Local Storage / S3 Client (`@aws-sdk/client-s3`) | Vitest  
> License: MIT

A high-reliability content syndication and publishing engine that distributes posts across specialized long-tail communities (Discourse, Lemmy, Dev.to, Ghost, Webhook, Assisted manual packs, Hashnode, Slack, and MRSS video feeds) with strict server-side posting rules, safe timeout retries, universal idempotency, and automated connector certification.

---

## The Problem It Solves

Publishing content across modern internet communities is notoriously fragile:
- **Niche Community Rules**: Each forum or subreddit has strict, idiosyncratic guidelines regarding self-promotion, external link limits, mandatory AI disclosures, and posting frequency. Violations lead to immediate post removals or domain bans.
- **Unreliable Networks & Duplicate Posts**: When network timeouts occur after a post is created on an upstream platform, naive retries result in duplicate posts.
- **Platform Drift**: APIs change, tokens expire, and platform schemas drift over time without notice.
- **Manual vs. Automated Distribution**: Strictly moderated platforms (e.g. Reddit) ban automated bot submissions, requiring human-in-the-loop manual publishing packs with customized framing.

**Longtail Distribution Hub** solves this by acting as an intelligent distribution firewall and syndication engine: evaluating rules before dispatching, guaranteeing idempotency across network timeouts, certifying platform connectors, and generating assisted manual packs when automation is prohibited.

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Express 5 API Gateway                             │
│      /connector/v1        /api/v1        /feeds        /health  /ready      │
└──────────────┬───────────────────────────────┬──────────────────────────────┘
               │                               │
        ┌──────▼──────┐                 ┌──────▼─────────┐
        │  Connector  │                 │   Publishing   │
        │  Registry   │                 │   Service      │
        │  (9 Connectors)               │  (Idempotency, │
        └──────┬──────┘                 │   Rules, Queue)│
               │                        └──────┬─────────┘
        ┌──────▼───────────────────────────────▼──────┐
        │       SQLite Database (node:sqlite WAL)     │
        │   destinations, publications, attempts,     │
        │   test_posts, alerts, proposed_rules        │
        └──────────────────────┬──────────────────────┘
                               │
                ┌──────────────▼──────────────┐
                │    Local Storage Service    │
                │  (Evidence, Packs, CSV, S3) │
                └─────────────────────────────┘
```

### Architectural Decisions
- **Zero-Build Native ESM (Node.js 22)**: Built purely with native ECMAScript Modules on Node.js 22. Eliminates compilation latency and source-map mismatches during runtime and CLI operations.
- **Built-in Node.js 22 SQLite (`node:sqlite`)**: Directly leverages the built-in `node:sqlite` engine (`DatabaseSync`), avoiding external binary native compilation issues common with `better-sqlite3` across different host platforms.
- **Configuration, Not Code**: Each destination is a database row. Adding a new Discourse forum, Lemmy server, or Ghost publication requires zero code changes or recompilations.
- **Universal Contract Dispatcher**: Connectors extend `BaseConnector` and declare declarative `manifest.yaml` definitions validating all 7 connector contract methods (`validate`, `publish`, `get_status`, `delete`, `fetch_metrics`, `refresh_auth`, `build_assist_pack`).

---

## 2. Key Features

- **Universal Idempotency**: Universal Express middleware mandates an `Idempotency-Key` header on all `/api/v1` POST routes, returning cached responses for identical payloads and `409 IDEMPOTENCY_CONFLICT` on mismatched payloads.
- **Safe Retries Across Timeouts (`findByMarker`)**: Injects invisible markers (e.g., `<!-- incubrix_marker:key -->`) into post payloads. If an upstream network connection drops after post creation, retries execute `findByMarker()` to recover the existing post without duplicating.
- **Server-Side Community Rules Engine**: Synchronous pre-flight checks enforce self-promotion policies, frequency caps, external link quotas, and AI-content disclosure notices.
- **10-Step Automated Connector Certification**: Proves connector health through a 10-step lifecycle (validation, publish, live read, status check, metrics probe, cleanup) with automatic demotion on breaking schema drifts.
- **150-Destination Verified Catalogue**: Seeds 150 real, verified-reachable long-tail destinations across diverse developer and creator verticals, with unknown community rules honestly preserved as `null`.
- **Culture Tailoring & Assisted Publishing**: Generates ready-to-paste Markdown and JSON packs for high-moderation communities (e.g. Reddit) that prohibit automated bot posting.
- **Reviewer Simulation Fault Injection**: Allows injecting simulated faults (`429`, `401`, `timeout_after_commit`, `rename_field`, `revoke`) via `POST /api/v1/sim/inject` to verify error recovery without external network dependencies.

---

## 3. Getting Started

### Prerequisites
- Node.js 22+ (LTS)
- Docker & Docker Compose (optional, for live local Ghost and Lemmy testing)

### Quick Start (Local Development)

```bash
# 1. Clone repository
git clone <repo-url> && cd "network4 project"

# 2. Install dependencies
npm install

# 3. Create local environment configuration
cp .env.example .env

# 4. Run database migrations
npm run migrate

# 5. Seed destination catalogue (150 verified rows)
npm run seed

# 6. Start the server
npm start
```

The service will be accessible at:
- **Web Dashboard**: `http://localhost:4000/`
- **REST API Base**: `http://localhost:4000/api/v1/`
- **Connector Contract Dispatcher**: `http://localhost:4000/connector/v1/`
- **Health Probes**: `http://localhost:4000/health` and `http://localhost:4000/ready`

---

## 4. Running with Docker Compose (Local Live Instances)

To run the full stack including local Ghost 5 Alpine and Lemmy 0.19.8 instances:

```bash
# 1. Start containers in the background
docker compose up -d

# 2. Verify containers are healthy
docker compose ps

# 3. Bootstrap local Ghost and Lemmy test credentials
node scripts/bootstrap_local.js

# 4. Run live certification against real running containers
node scripts/certify_live.js
```

### Docker Networking Details
- In Docker Compose, the application container uses `extra_hosts: ["host.docker.internal:host-gateway"]` to reach host-bound services.
- Connectors (`GhostConnector` and `LemmyConnector`) automatically translate `http://localhost:2368` and `http://localhost:8536` to internal container service hostnames (`http://ghost:2368` and `http://lemmy:8536`) when running containerized.
- The Ghost Admin API (`/ghost/api/admin/...`) accepts requests from both internal DNS and host gateway addresses without host redirection.

---

## 5. Automated Tests

All 179 automated unit, integration, contract, and E2E tests run completely offline with zero external API keys or cloud dependencies using the embedded mock platform server:

```bash
# Run all tests (179 passing across 30 test suites)
npm test

# Run specific test suites
npm run test:unit           # Unit tests (rules, catalogue, HMAC, manifests, etc.)
npm run test:integration    # Integration tests (lifecycle, retries, contracts, rate limits)
npm run test:e2e            # End-to-end smoke tests
```

---

## 6. Web Dashboard UI

Open `http://localhost:4000/` in your browser to interact with the dashboard:

1. **Overview**: Displays health probes, active connectors, certified destination counts, and quick simulation toggles.
2. **Destinations Catalogue**: Browse the 150 verified destinations, filter by platform or category, search by tag, view rule values, or import destinations via CSV.
3. **Publishing Workspace**:
   - Select a destination; the interface dynamically displays **`Publish (LIVE)`** or **`Publish (simulation)`** depending on destination mode.
   - Run **Pre-Check Rules** to see an itemized explanation of why a decision was made (self-promo policy, AI disclosure, link policy, frequency cap).
   - If publishing to a live destination, an explicit confirmation dialog prompts for verification before dispatching live posts.
4. **Connectors & Certification**: View registered connectors and trigger 10-step certification runs with instant audit evidence.
5. **Recommender & Rules Capture**: Test multi-attribute destination recommendations and preview AI rules capture.
6. **Assisted Publishing**: Inspect generated manual submission packs with customized discussion framing and copyable payloads.

---

## 7. API Overview

All `/api/v1` POST routes require an `Idempotency-Key` header.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Liveness health check |
| `GET` | `/ready` | Readiness check with connector count |
| `GET` | `/api/v1/destinations` | List destinations (supports filtering & pagination) |
| `POST`| `/api/v1/destinations` | Create a new destination |
| `POST`| `/api/v1/destinations/import-csv` | Import destinations from CSV with SSRF protection |
| `POST`| `/api/v1/publish` | Submit publication job (returns 202 with `job_id`) |
| `POST`| `/api/v1/publish/rules/evaluate` | Pre-flight rules check with itemized reasons |
| `POST`| `/api/v1/publish/tailor` | Tailor title and body for destination platform culture |
| `POST`| `/api/v1/publish/recommender` | Recommend matching destinations for content |
| `POST`| `/api/v1/certification/run/:id` | Execute 10-step certification harness |
| `POST`| `/api/v1/sim/inject` | Inject simulated platform fault (429, timeout, revoke, etc.) |
| `POST`| `/api/v1/sim/reset` | Clear active simulation faults |
| `POST`| `/connector/v1/:key/:method` | Connector contract dispatcher (`validate`, `publish`, etc.) |

### Standard Error Response Shape
All errors return a consistent JSON envelope with `UPPER_SNAKE_CASE` error codes:
```json
{
  "error": {
    "code": "DEST_RULE_SELF_PROMO",
    "message": "Self-promotional content is prohibited by this destination's rules",
    "retryable": false,
    "details": {
      "rule": "self_promo_allowed",
      "destination_id": "dest_123"
    }
  }
}
```

---

## 8. Honest Limitations & Verification Scope

- **Live Local Containers**: Real publishing, reading, and deletion have been verified live against local Ghost 5 Alpine (`http://localhost:2368`) and Lemmy 0.19.8 (`http://localhost:8536`) Docker containers.
- **Simulated Connectors**: Discourse, Dev.to, Hashnode, Slack, Webhook, and MRSS connectors are tested and certified against the embedded high-fidelity HTTP simulation platform server.
- **S3 / MinIO Storage**: The application defaults to local filesystem storage (`STORAGE_BACKEND=local`). MinIO was removed from Docker Compose because the MinIO container image can no longer be pulled from Docker Hub or Quay without authentication; S3 storage stays "Not verified".
- **Rules Extraction**: Real community guidelines were fetched for 14 destinations. Because public guidelines pages do not publish strict numeric frequency caps or binary flags, those rule fields are honestly left `null` rather than fabricated.

---

## 9. AI Assistance

AI coding tools (including Google Antigravity powered by Google DeepMind Gemini models) were utilized during development for code generation, test fixture creation, refactoring, and test authoring. All generated code and architecture decisions were strictly audited and validated by deterministic test suites and live container verification.

---

## 10. License

This project is licensed under the [MIT License](LICENSE).
