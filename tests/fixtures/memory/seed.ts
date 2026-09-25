/**
 * SYNTHETIC records across the authoritative tables used by memory collectors
 * (clearly fake data; example.test domains).
 */
import type { AppContext } from '../../../src/app/context.js';

const T = '2026-09-20T10:00:00.000Z';

export function seedRecords(c: Pick<AppContext, 'db' | 'siteId'>): void {
  const s = c.siteId;
  c.db.run(`INSERT INTO sources (id, site_id, source_type, trust_class, url, title, retrieved_at, raw_ref) VALUES ('src1', ?, 'competitor_page', 'scraped_untrusted', 'https://competitor.example.test/pricing', 'Competitor pricing (synthetic)', ?, 'raw/abc.json')`, [s, T]);
  c.db.run(`INSERT INTO sources (id, site_id, source_type, trust_class, url, title, retrieved_at) VALUES ('src2', ?, 'gsc', 'first_party_measurement', NULL, 'GSC', ?)`, [s, T]);
  c.db.run(`INSERT INTO evidence (id, site_id, source_id, kind, summary, excerpt, collected_at) VALUES ('ev1', ?, 'src1', 'excerpt', 'Competitor lists organizer at 59 EUR', 'Our organizer costs 59 EUR with free shipping.', ?)`, [s, T]);
  c.db.run(`INSERT INTO evidence (id, site_id, source_id, kind, summary, excerpt, collected_at) VALUES ('ev2', ?, 'src2', 'excerpt', 'metric', 'clicks 10', ?)`, [s, T]);
  c.db.run(`INSERT INTO competitors (id, site_id, domain, name, origin, first_seen_at) VALUES ('cmp1', ?, 'competitor.example.test', 'Competitor (synthetic)', 'configured', ?)`, [s, T]);
  c.db.run(`INSERT INTO competitor_pages (id, site_id, competitor_id, url, first_seen_at) VALUES ('cp1', ?, 'cmp1', 'https://competitor.example.test/pricing', ?)`, [s, T]);
  c.db.run(`INSERT INTO competitor_changes (id, site_id, competitor_page_id, change_type, summary, detected_at) VALUES ('cc1', ?, 'cp1', 'content_changed', 'Competitor added a bundle discount section.', ?)`, [s, T]);
  c.db.run(`INSERT INTO content_items (id, site_id, title, stage, is_synthetic, created_at, updated_at) VALUES ('ci1', ?, 'Desk storage guide', 'briefed', 1, ?, ?)`, [s, T, T]);
  c.db.run(`INSERT INTO content_briefs (id, site_id, content_item_id, version, status, brief_json, content_hash, created_at) VALUES ('b1', ?, 'ci1', 1, 'superseded', '{"angle":"old angle"}', 'h1', ?)`, [s, T]);
  c.db.run(`INSERT INTO content_briefs (id, site_id, content_item_id, version, status, brief_json, content_hash, created_at) VALUES ('b2', ?, 'ci1', 2, 'approved', '{"angle":"compact storage for kitchen-table offices","sections":["why","how"]}', 'h2', ?)`, [s, T]);
  c.db.run(`INSERT INTO content_items (id, site_id, title, stage, decision_reason, is_synthetic, created_at, updated_at) VALUES ('ci2', ?, 'Celebrity desk tours', 'rejected', 'No business relation', 1, ?, ?)`, [s, T, T]);
  c.db.run(
    `INSERT INTO recommendations (id, site_id, kind, action_type, title, diagnosis, proposed_change, status, created_at, updated_at)
     VALUES ('rec1', ?, 'primary', 'rewrite_title_meta', 'Rewrite pricing title to mention cheap organizers', 'CTR below peers', 'Use the word cheap in the title', 'rejected', ?, ?)`,
    [s, T, T],
  );
  c.db.run(`INSERT INTO decisions (id, site_id, subject_type, subject_id, decision, reason, decided_by, decided_at) VALUES ('dec1', ?, 'recommendation', 'rec1', 'rejected', 'Brand does not compete on being cheap', 'owner:alex', ?)`, [s, T]);
  c.db.run(
    `INSERT INTO experiments (id, site_id, type, hypothesis, evidence_json, proposed_change, change_hash, primary_metric, outcome_kind, guardrail_metrics_json, min_observation_days, sample_requirements_json, risks, rollback_plan, status, outcome_json, created_at, updated_at)
     VALUES ('exp1', ?, 'title_meta', 'Adding price to the title raises CTR', '[]', 'Add price to title', 'ch', 'ctr', 'seo_visibility', '[]', 28, '{}', 'low', 'revert title', 'negative', '{"ctr_change_pct": -4.1, "confidence": "low"}', ?, ?)`,
    [s, T, T],
  );
  c.db.run(`INSERT INTO learnings (id, site_id, statement, scope, evidence_json, experiment_id, status, approved_by, approved_at, created_at, updated_at) VALUES ('l1', ?, 'Price in titles did not help CTR for organizer pages', 'organizer pages', '[]', 'exp1', 'approved', 'owner:alex', ?, ?, ?)`, [s, T, T, T]);
  c.db.run(`INSERT INTO learnings (id, site_id, statement, scope, evidence_json, status, created_at, updated_at) VALUES ('l2', ?, 'Proposed learning not yet approved', 'x', '[]', 'proposed', ?, ?)`, [s, T, T]);
}

