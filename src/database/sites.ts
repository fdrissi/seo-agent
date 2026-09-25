import { hashObject } from '../core/hash.js';
import { newId } from '../core/ids.js';
import type { SiteConfig } from '../config/site-schema.js';
import { recordAudit } from './audit.js';
import { parseJson, type Db } from './db.js';

export interface SiteRow {
  id: string;
  name: string;
  base_url: string;
  is_demo: number;
  active_config_version: number | null;
  created_at: string;
  updated_at: string;
}

export type ConfigSource = 'setup' | 'file' | 'business_note_sync' | 'migration' | 'demo';

/**
 * Register/refresh a site from validated configuration and record a new
 * configuration version when the (non-secret) config content changed.
 *
 * Every change of the ACTIVE version (first registration, a new version, or
 * a return to an earlier configuration hash) appends a config_activations
 * row (append-only, migration 0202); every change after the first
 * registration also writes a 'config.activated' audit event. Which
 * configuration was active when can always be reconstructed. Re-running with
 * the already active configuration writes nothing.
 */
export function ensureSite(
  db: Db,
  config: SiteConfig,
  opts: { source?: ConfigSource; now?: Date } = {},
): { site: SiteRow; configVersion: number; configChanged: boolean } {
  const now = (opts.now ?? new Date()).toISOString();
  const hash = hashObject(config);
  return db.transaction(() => {
    const existing = db.get<SiteRow>('SELECT * FROM sites WHERE id = ?', [config.site.id]);
    if (!existing) {
      db.run('INSERT INTO sites (id, name, base_url, is_demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
        config.site.id,
        config.site.businessName,
        config.site.url,
        config.profile === 'demo' ? 1 : 0,
        now,
        now,
      ]);
    } else if (existing.name !== config.site.businessName || existing.base_url !== config.site.url) {
      db.run('UPDATE sites SET name = ?, base_url = ?, updated_at = ? WHERE id = ?', [config.site.businessName, config.site.url, now, config.site.id]);
    }
    const known = db.get<{ version: number }>('SELECT version FROM config_versions WHERE site_id = ? AND config_hash = ?', [config.site.id, hash]);
    let version: number;
    let changed = false;
    if (known) version = known.version;
    else {
      const max = db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM config_versions WHERE site_id = ?', [config.site.id]);
      version = (max?.v ?? 0) + 1;
      db.run('INSERT INTO config_versions (id, site_id, version, config_hash, config_json, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        newId('cfg'),
        config.site.id,
        version,
        hash,
        JSON.stringify(config),
        opts.source ?? 'file',
        now,
      ]);
      changed = true;
    }
    // Only write when something changed: re-running with the same config leaves the row untouched.
    const previous = existing?.active_config_version ?? null;
    if (!existing || previous !== version) {
      db.run('UPDATE sites SET active_config_version = ?, updated_at = ? WHERE id = ?', [version, now, config.site.id]);
      const source = opts.source ?? 'file';
      db.run('INSERT INTO config_activations (id, site_id, version, previous_version, config_hash, source, activated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        newId('cfgact'),
        config.site.id,
        version,
        previous,
        hash,
        source,
        now,
      ]);
      // The first activation is the site registration itself; the audit event marks every later change
      // of an existing site's active configuration (a new version or a return to an earlier one).
      if (previous !== null) {
        recordAudit(db, {
          siteId: config.site.id,
          actor: 'system',
          eventType: 'config.activated',
          subjectType: 'config_version',
          subjectId: String(version),
          details: { version, previousVersion: previous, configHash: hash, newVersion: changed, returnToEarlierVersion: !changed, source },
          at: new Date(now),
        });
      }
    }
    const site = db.get<SiteRow>('SELECT * FROM sites WHERE id = ?', [config.site.id])!;
    return { site, configVersion: version, configChanged: changed };
  });
}

/**
 * Read-only: is this configuration the site's active, recorded version?
 * 'missing' = no site row; 'changed' = the row exists but this config (or its
 * name/URL) is not the active recorded version; 'current' otherwise.
 */
export function siteRegistrationStatus(db: Db, config: SiteConfig): 'current' | 'changed' | 'missing' {
  const row = db.get<SiteRow>('SELECT * FROM sites WHERE id = ?', [config.site.id]);
  if (!row) return 'missing';
  if (row.name !== config.site.businessName || row.base_url !== config.site.url) return 'changed';
  const known = db.get<{ version: number }>('SELECT version FROM config_versions WHERE site_id = ? AND config_hash = ?', [config.site.id, hashObject(config)]);
  return known && known.version === row.active_config_version ? 'current' : 'changed';
}

/** The site's active recorded configuration (parsed config_json), or null when none is recorded. */
export function activeSiteConfig(db: Db, siteId: string): Record<string, unknown> | null {
  const row = db.get<{ config_json: string }>(
    'SELECT c.config_json FROM sites s JOIN config_versions c ON c.site_id = s.id AND c.version = s.active_config_version WHERE s.id = ?',
    [siteId],
  );
  return row ? parseJson<Record<string, unknown> | null>(row.config_json, null) : null;
}

export interface ConfigActivation {
  version: number;
  previousVersion: number | null;
  configHash: string;
  source: string;
  activatedAt: string;
}

/** Activation history of a site's configuration, oldest first (append-only). */
export function configActivations(db: Db, siteId: string): ConfigActivation[] {
  return db
    .all<{ version: number; previous_version: number | null; config_hash: string; source: string; activated_at: string }>(
      'SELECT version, previous_version, config_hash, source, activated_at FROM config_activations WHERE site_id = ? ORDER BY activated_at, rowid',
      [siteId],
    )
    .map((r) => ({ version: r.version, previousVersion: r.previous_version, configHash: r.config_hash, source: r.source, activatedAt: r.activated_at }));
}

/**
 * The configuration version that was active at `atIso` (the latest activation
 * at or before it), or null when none was recorded yet. Use this, not the
 * version number order, for experiment and report config provenance.
 */
export function configVersionActiveAt(db: Db, siteId: string, atIso: string): number | null {
  return (
    db.get<{ version: number }>('SELECT version FROM config_activations WHERE site_id = ? AND activated_at <= ? ORDER BY activated_at DESC, rowid DESC LIMIT 1', [siteId, atIso])?.version ?? null
  );
}
