-- 0006_opportunities_content: routing decisions, opportunities, recommendations,
-- content pipeline items, briefs, drafts, quality reviews, publication records.

-- Deterministic router output with explainable reason codes.
CREATE TABLE route_decisions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('site', 'page', 'page_query', 'content_signal')),
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  query TEXT,
  route TEXT NOT NULL CHECK (route IN ('INVALID_OR_INCOMPLETE_DATA', 'TECHNICAL_BLOCKER', 'EXPERIMENT_ACTIVE', 'HEALTHY', 'RANKING_OPPORTUNITY', 'CTR_OPPORTUNITY', 'CONVERSION_OPPORTUNITY', 'DECLINE', 'CONTENT_OPPORTUNITY', 'INDEXING_UNKNOWN', 'LOW_DATA', 'IRRELEVANT', 'UNSURE')),
  reason_codes_json TEXT NOT NULL CHECK (json_valid(reason_codes_json)),
  inputs_json TEXT CHECK (inputs_json IS NULL OR json_valid(inputs_json)),
  decided_by TEXT NOT NULL CHECK (decided_by IN ('rule', 'model', 'owner')),
  rules_version TEXT NOT NULL,
  period_start TEXT,
  period_end TEXT,
  decided_at TEXT NOT NULL
);
CREATE INDEX idx_route_decisions_site ON route_decisions (site_id, decided_at);

CREATE TABLE opportunities (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  route_decision_id TEXT REFERENCES route_decisions(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('page', 'page_query', 'content', 'technical', 'measurement', 'internal_link')),
  route TEXT NOT NULL,
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  query TEXT,
  is_branded INTEGER CHECK (is_branded IS NULL OR is_branded IN (0, 1)),
  score REAL,
  score_components_json TEXT CHECK (score_components_json IS NULL OR json_valid(score_components_json)),
  raw_counts_json TEXT CHECK (raw_counts_json IS NULL OR json_valid(raw_counts_json)),  -- raw counts are never hidden by smoothing
  scoring_version TEXT,
  status TEXT NOT NULL CHECK (status IN ('candidate', 'shortlisted', 'researching', 'recommended', 'deferred', 'rejected', 'archived')),
  status_reason TEXT,
  period_start TEXT,
  period_end TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_opportunities_site_status ON opportunities (site_id, status, score);

-- One primary action (or an explicit no-action decision) plus at most three
-- secondary observations per run.
CREATE TABLE recommendations (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  opportunity_id TEXT REFERENCES opportunities(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('primary', 'secondary', 'no_action', 'repair_measurement', 'collect_more_evidence')),
  action_type TEXT NOT NULL,                 -- e.g. 'rewrite_title_meta', 'add_section', 'internal_links', 'technical_fix', 'none'
  title TEXT NOT NULL,
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  query TEXT,
  diagnosis TEXT,
  proposed_change TEXT,
  hypothesis TEXT,
  success_criteria TEXT,
  risks TEXT,
  review_date TEXT,
  details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json)),   -- internal links: source, destination, passage, anchor, reason
  status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected', 'implemented', 'superseded', 'withdrawn')),
  prompt_version TEXT,
  model_id TEXT,
  scoring_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_recommendations_site ON recommendations (site_id, created_at);

-- Content farming pipeline item.
CREATE TABLE content_items (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  primary_question TEXT,
  stage TEXT NOT NULL CHECK (stage IN ('discovered', 'deduplicated', 'classified', 'clustered', 'demand_validated', 'existing_checked', 'prioritized', 'briefed', 'drafted', 'quality_checked', 'in_review', 'approved', 'exported', 'published', 'measuring', 'deferred', 'rejected')),
  decision TEXT CHECK (decision IS NULL OR decision IN ('improve_existing', 'add_section', 'create_tool', 'create_template', 'create_page', 'defer', 'reject')),
  decision_reason TEXT,
  intent TEXT,
  cluster_id TEXT REFERENCES keyword_clusters(id) ON DELETE SET NULL,
  target_page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  why_exists TEXT,
  who_benefits TEXT,
  business_relation TEXT,
  original_value TEXT,
  reader_next_step TEXT,
  demand_json TEXT CHECK (demand_json IS NULL OR json_valid(demand_json)),       -- signal origins, windows, limitations
  overlap_json TEXT CHECK (overlap_json IS NULL OR json_valid(overlap_json)),    -- existing-page overlap with uncertainty
  priority_score REAL,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_content_items_stage ON content_items (site_id, stage);

CREATE TABLE content_briefs (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  content_item_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'gate_passed', 'gate_failed', 'approved', 'superseded')),
  brief_json TEXT NOT NULL CHECK (json_valid(brief_json)),
  content_hash TEXT NOT NULL,
  gate_json TEXT CHECK (gate_json IS NULL OR json_valid(gate_json)),
  vault_path TEXT,
  prompt_version TEXT,
  model_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (content_item_id, version)
);

CREATE TABLE content_drafts (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  content_item_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  brief_id TEXT NOT NULL REFERENCES content_briefs(id) ON DELETE RESTRICT,
  brief_version INTEGER NOT NULL,
  brief_hash TEXT NOT NULL,                  -- approved brief version attached to the draft
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'needs_revision', 'needs_human_review', 'rejected', 'review_passed', 'approved', 'exported', 'published', 'superseded')),
  package_json TEXT NOT NULL CHECK (json_valid(package_json)),   -- body, titles, meta, slug, links, schema proposal, source ledger, fact-check notes
  body_hash TEXT NOT NULL,
  unresolved_facts INTEGER NOT NULL DEFAULT 0,
  revision_round INTEGER NOT NULL DEFAULT 0 CHECK (revision_round BETWEEN 0 AND 2),
  vault_path TEXT,
  prompt_version TEXT,
  model_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (content_item_id, version)
);

CREATE TABLE quality_reviews (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('brief', 'draft')),
  subject_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'needs_revision', 'needs_human_review', 'reject')),
  deterministic_json TEXT NOT NULL CHECK (json_valid(deterministic_json)),
  ai_review_json TEXT CHECK (ai_review_json IS NULL OR json_valid(ai_review_json)),
  reasons_json TEXT NOT NULL CHECK (json_valid(reasons_json)),
  revision_round INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_quality_reviews_subject ON quality_reviews (subject_type, subject_id);

-- What actually went live, when, from which revision, with rollback information.
CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('draft', 'recommendation', 'experiment')),
  subject_id TEXT NOT NULL,
  approval_id TEXT,
  url TEXT NOT NULL,
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  method TEXT NOT NULL CHECK (method IN ('manual_export', 'git_patch', 'cms_adapter')),
  export_path TEXT,
  implemented_at TEXT NOT NULL,              -- actual deployment time reported by the owner
  source_revision TEXT,
  before_snapshot_ref TEXT,
  after_snapshot_ref TEXT,
  verified_live INTEGER NOT NULL DEFAULT 0 CHECK (verified_live IN (0, 1)),
  verification_json TEXT CHECK (verification_json IS NULL OR json_valid(verification_json)),
  rollback_json TEXT CHECK (rollback_json IS NULL OR json_valid(rollback_json)),
  recorded_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_publications_site ON publications (site_id, implemented_at);
