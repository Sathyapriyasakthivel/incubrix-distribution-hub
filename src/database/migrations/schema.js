export const schemaSql = `
-- Destinations Catalogue Table
CREATE TABLE IF NOT EXISTS destinations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  platform_key TEXT NOT NULL,
  surface TEXT DEFAULT 'default',
  category TEXT,
  audience_tags TEXT DEFAULT '[]',
  language TEXT DEFAULT 'en',
  geo TEXT DEFAULT 'global',
  est_audience INTEGER DEFAULT 0,
  rules_url TEXT,
  frequency_cap TEXT,
  self_promo_allowed INTEGER,
  link_policy TEXT,
  disclosure_required INTEGER,
  automation_allowed INTEGER,
  connector_key TEXT NOT NULL,
  relevance_score INTEGER DEFAULT 3,
  relevance_reason TEXT,
  level TEXT DEFAULT 'L0',
  last_certified_at TEXT,
  is_enabled INTEGER DEFAULT 1,
  simulation_mode INTEGER DEFAULT 1,
  status TEXT DEFAULT 'catalogued',
  secret_ref TEXT,
  rate_limited_until TEXT,
  source_url TEXT,
  researched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_destinations_platform ON destinations(platform_key);
CREATE INDEX IF NOT EXISTS idx_destinations_status ON destinations(status);
CREATE INDEX IF NOT EXISTS idx_destinations_enabled ON destinations(is_enabled);

-- Separate Auth Configs Table
CREATE TABLE IF NOT EXISTS auth_configs (
  id TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL,
  auth_type TEXT NOT NULL,
  credentials TEXT NOT NULL,
  secret_ref TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (destination_id) REFERENCES destinations(id) ON DELETE CASCADE
);

-- Destination Specific Posting Rules Overrides
CREATE TABLE IF NOT EXISTS posting_rules (
  id TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL UNIQUE,
  max_title_chars INTEGER DEFAULT 255,
  max_body_chars INTEGER DEFAULT 32000,
  allowed_content_types TEXT DEFAULT '["text","image","video_link"]',
  allowed_media_types TEXT DEFAULT '["image/jpeg","image/png","image/webp"]',
  frequency_cap_hours INTEGER DEFAULT 168,
  max_links INTEGER DEFAULT 5,
  require_ai_disclosure INTEGER DEFAULT 0,
  disallow_promotional INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (destination_id) REFERENCES destinations(id) ON DELETE CASCADE
);

-- Publications & Background Jobs Table
CREATE TABLE IF NOT EXISTS publications (
  id TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL,
  connector_key TEXT NOT NULL,
  idempotency_key TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  canonical_url TEXT,
  media_urls TEXT DEFAULT '[]',
  is_ai_generated INTEGER DEFAULT 0,
  is_promotional INTEGER DEFAULT 0,
  is_test INTEGER DEFAULT 0,
  status TEXT NOT NULL,
  progress INTEGER DEFAULT 0,
  run_at TEXT,
  platform_post_id TEXT,
  live_url TEXT,
  error_code TEXT,
  error_message TEXT,
  error_details TEXT,
  rule_decision TEXT,
  rule_violations TEXT,
  tailoring_warnings TEXT DEFAULT '[]',
  output_manifest TEXT,
  callback_url TEXT,
  simulation INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (destination_id) REFERENCES destinations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_publications_dest ON publications(destination_id);
CREATE INDEX IF NOT EXISTS idx_publications_status ON publications(status);
CREATE INDEX IF NOT EXISTS idx_publications_idempotency ON publications(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_publications_created ON publications(created_at);

-- Idempotency Records Table
CREATE TABLE IF NOT EXISTS idempotency_records (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Certification Runs Table
CREATE TABLE IF NOT EXISTS certification_runs (
  id TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL,
  connector_key TEXT NOT NULL,
  is_simulation INTEGER DEFAULT 1,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER,
  test_post_id TEXT,
  test_live_url TEXT,
  is_cleaned_up INTEGER DEFAULT 0,
  steps TEXT NOT NULL,
  evidence_file TEXT,
  error_code TEXT,
  error_message TEXT,
  FOREIGN KEY (destination_id) REFERENCES destinations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cert_dest ON certification_runs(destination_id);

-- Test Posts Table for TTL cleanup & sweeper
CREATE TABLE IF NOT EXISTS test_posts (
  id TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL,
  platform_post_id TEXT NOT NULL,
  delete_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (destination_id) REFERENCES destinations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_test_posts_delete_by ON test_posts(delete_by);

-- Publish Attempts Table for Safe Retries across timeout
CREATE TABLE IF NOT EXISTS publish_attempts (
  id TEXT PRIMARY KEY,
  connector_key TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL, -- pending | done | failed
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_publish_attempts_idem ON publish_attempts(idempotency_key);

-- Connector Rate Limits Table
CREATE TABLE IF NOT EXISTS connector_rate_limits (
  connector_key TEXT PRIMARY KEY,
  rate_limited_until TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Circuit Breakers Table
CREATE TABLE IF NOT EXISTS circuit_breakers (
  key TEXT PRIMARY KEY,
  consecutive_failures INTEGER DEFAULT 0,
  is_open INTEGER DEFAULT 0,
  opened_at TEXT,
  updated_at TEXT NOT NULL
);

-- Alerts Table for Recertification and Operational Failures (Outstanding Level)
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL, -- info | warn | error
  event_type TEXT NOT NULL,
  destination_id TEXT,
  message TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alerts_dest ON alerts(destination_id);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);

-- Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  correlation_id TEXT,
  job_id TEXT,
  payload TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

-- Post Metrics Table (Outstanding Level)
CREATE TABLE IF NOT EXISTS post_metrics (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  platform_post_id TEXT NOT NULL,
  views INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (publication_id) REFERENCES publications(id) ON DELETE CASCADE
);

-- Proposed Rules Table for Rules Capture
CREATE TABLE IF NOT EXISTS proposed_rules (
  id TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL,
  rules_url TEXT,
  status TEXT DEFAULT 'proposed',
  frequency_cap TEXT,
  self_promo_allowed INTEGER DEFAULT 1,
  link_policy TEXT DEFAULT 'allowed',
  disclosure_required INTEGER DEFAULT 0,
  automation_allowed INTEGER DEFAULT 1,
  quotes TEXT DEFAULT '{}',
  confidence REAL DEFAULT 0.0,
  provider TEXT,
  model TEXT,
  cost_usd REAL DEFAULT 0.0,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  FOREIGN KEY (destination_id) REFERENCES destinations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_proposed_rules_dest ON proposed_rules(destination_id);
CREATE INDEX IF NOT EXISTS idx_proposed_rules_status ON proposed_rules(status);

-- Feed Items Table for MRSS Video Feed Connector
CREATE TABLE IF NOT EXISTS feed_items (
  id TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  link TEXT,
  guid TEXT NOT NULL,
  media_url TEXT,
  media_type TEXT DEFAULT 'video/mp4',
  media_duration INTEGER DEFAULT 60,
  thumbnail_url TEXT,
  status TEXT DEFAULT 'published',
  idempotency_marker TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feed_items_dest ON feed_items(destination_id);
CREATE INDEX IF NOT EXISTS idx_feed_items_status ON feed_items(status);
`;


