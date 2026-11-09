# SOURCES AND THIRD-PARTY LICENSES

All software, libraries, and datasets incorporated in this Longtail Distribution Hub (IncuBrix Distribution Network) service are open-source and licensed for permissive use. No AGPL, research-only, or CC BY-NC components are in the default execution path.

---

## 1. Runtime Libraries & Dependencies

| Library | Version | License | Purpose | Commercial Usability |
|---------|---------|---------|---------|----------------------|
| **express** | `^5.3.0` | MIT | Core HTTP routing and middleware framework | Fully Permitted |
| **node:sqlite** | `v22 (native)` | Node.js (MIT-style) | Synchronous SQLite database persistence with WAL & transactions | Fully Permitted |
| **@aws-sdk/client-s3** | `^3.1153.0` | Apache-2.0 | S3-compatible client for MinIO & cloud object storage | Fully Permitted |
| **zod** | `^4.6.7` | MIT | Request and payload schema validation | Fully Permitted |
| **pino** | `^10.4.0` | MIT | High-performance structured JSON logging with secret redaction | Fully Permitted |
| **yaml** | `^2.9.1` | ISC | Connector YAML manifest parsing and OpenAPI 3.1 validation | Fully Permitted |
| **csv-parse** | `^7.0.3` | MIT | High-throughput CSV destination catalogue import | Fully Permitted |
| **csv-stringify** | `^6.9.0` | MIT | CSV destination catalogue export | Fully Permitted |
| **multer** | `^2.4.0` | MIT | Multipart form-data handling for file uploads | Fully Permitted |
| **cors** | `^2.8.6` | MIT | Cross-Origin Resource Sharing middleware | Fully Permitted |
| **dotenv** | `^18.0.8` | BSD-2-Clause | Environment variable loading from `.env` | Fully Permitted |
| **node:crypto** | `Built-in` | Node.js (MIT-style) | HMAC-SHA256 request signing and SHA-256 idempotency hashing | Fully Permitted |

---

## 2. Testing Frameworks & Development Tools

| Tool | Version | License | Purpose |
|------|---------|---------|---------|
| **vitest** | `^5.0.5` | MIT | Unit, integration, and contract test runner |
| **supertest** | `^7.3.1` | MIT | HTTP API simulation and endpoint assertion |

---

## 3. Platform APIs & Reference Specifications

The connector implementations strictly conform to documented upstream API contracts:

1. **Discourse API**:
   - Upstream Documentation: [Discourse API Docs](https://docs.discourse.org/)
   - Method mapping: `POST /posts.json`, `GET /posts/{id}.json`, `DELETE /posts/{id}.json`, `GET /t/{id}.json`
   - Authentication: `Api-Key` and `Api-Username` HTTP headers.

2. **Lemmy API**:
   - Upstream Documentation: [Lemmy HTTP API v3](https://join-lemmy.org/api/classes/LemmyHttp.html)
   - Method mapping: `POST /api/v3/post`, `GET /api/v3/post`, `POST /api/v3/post/delete`
   - Authentication: Bearer JWT token in headers/body.

3. **Dev.to / Forem API**:
   - Upstream Documentation: [Forem API v1](https://developers.forem.com/api/v1)
   - Method mapping: `POST /api/articles`, `GET /api/articles/{id}`, `DELETE /api/articles/{id}`
   - Authentication: `api-key` header.

4. **Ghost Admin API**:
   - Upstream Documentation: [Ghost Admin API v5](https://ghost.org/docs/admin-api/)
   - Method mapping: `POST /ghost/api/admin/posts/?source=html`, `GET /ghost/api/admin/posts/{id}/`, `DELETE /ghost/api/admin/posts/{id}/`
   - Authentication: Ghost Admin API token / JWT (`id:secret`).

5. **MRSS Video Feed Protocol**:
   - Upstream Documentation: Yahoo Media RSS 2.0 Specification
   - XML delivery with `<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">`, enclosure tags, and thumbnail support.

6. **Hashnode Public GraphQL API v2**:
   - Upstream Documentation: [Hashnode GraphQL API](https://apidocs.hashnode.com/)
   - GraphQL mutations: `publishPost`, `removePost`.

7. **Slack Web API**:
   - Upstream Documentation: [Slack Web API](https://api.slack.com/methods)
   - Method mapping: `POST /chat.postMessage`, `POST /chat.delete` with Slack Block Kit.

8. **Generic Signed Webhook Protocol**:
   - Custom deterministic webhook protocol using HMAC-SHA256 (`X-IncuBrix-Signature: sha256=...`), timestamp tolerance (`X-IncuBrix-Timestamp`), and cryptographic nonce (`X-IncuBrix-Nonce`).

9. **Assisted Publishing Tier (L1)**:
   - Manual packaging engine generating Markdown instructions, checklists, and JSON packs for human moderation.

---

## 4. Models & AI Providers

- **Local Deterministic Mock Adapter (`RULES_AI_PROVIDER=mock`)**: Default test/offline provider reading local HTML fixtures. Zero external API calls or network fees.
- **OpenAI API (`gpt-4o-mini`, `gpt-4o`)**: Optional external provider selected via `RULES_AI_PROVIDER=openai` for structured community rules extraction.
- **Anthropic API (`claude-3-5-sonnet`)**: Optional external provider selected via `RULES_AI_PROVIDER=anthropic`.

---

## 5. Dataset Sources

- **Destination Catalogue Dataset (`data/catalogue_150_destinations.csv`)**:
  - 197 verified real public destinations compiled across IncuBrix target demographics: Generative AI, Video Production, B2B SaaS, Creator Economy, and Bootstrapped Founders.
  - Zero synthetic placeholder domains (`example.com`, `example.org`, `.example` excluded).
  - Multi-lingual communities included: English (`en`), German (`de`), French (`fr`), Spanish (`es`), Japanese (`ja`), Portuguese (`pt`), Italian (`it`), Chinese (`zh`), Dutch (`nl`).
  - License: Apache-2.0 / Public Domain public web directory data.
