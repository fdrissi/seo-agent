import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../app/context.js';
import { errorMessage } from '../core/errors.js';
import type { IntegrationStatus, StatusCheckOptions } from '../integrations/types.js';

/**
 * Integration statuses for the vault dashboard.
 *
 * `vault render` never makes network requests. It always reports the vault's
 * own status (local, no network), and it includes the other integrations only
 * when the integration layer registers a provider (for example the doctor's
 * offline checks). The provider is always called with `{ network: false }`.
 * Without a provider, the dashboard says plainly that the other integrations
 * were not checked, rather than guessing from configuration.
 */

export type IntegrationStatusProvider = (ctx: AppContext, opts: StatusCheckOptions) => IntegrationStatus[] | Promise<IntegrationStatus[]>;

let registered: IntegrationStatusProvider | null = null;

/** Register (or clear with null) the provider of offline integration statuses used by `vault render`. */
export function registerIntegrationStatusProvider(provider: IntegrationStatusProvider | null): void {
  registered = provider;
}

/** Status of the vault itself: a local folder of Markdown files; nothing is sent anywhere. */
export function vaultIntegrationStatus(ctx: AppContext, vaultDir: string): IntegrationStatus {
  const base = { id: 'obsidian' as const, sendsExternally: [], checkedAt: ctx.clock.now().toISOString(), networkChecked: false, chargeable: false };
  if (!ctx.settings.features.obsidian) {
    return { ...base, state: 'disabled', detail: 'Vault output is disabled (features.obsidian = false).', nextStep: 'Enable features.obsidian in the site config to render notes.' };
  }
  let initialized = false;
  try {
    const st = existsSync(vaultDir) ? lstatSync(vaultDir) : null;
    initialized = !!st && st.isDirectory() && !st.isSymbolicLink() && existsSync(path.join(vaultDir, '01 Business'));
  } catch {
    initialized = false;
  }
  return initialized
    ? { ...base, state: 'ready', detail: 'Local Markdown vault (plain files; Obsidian optional). No network access.' }
    : { ...base, state: 'degraded', detail: 'Generated notes are written, but the vault was not initialized from the template (the 01 Business notes are missing).', nextStep: 'Run "npm run cli -- vault init" (never overwrites).' };
}

export interface DashboardStatuses {
  statuses: IntegrationStatus[];
  /** Shown under the table when the list is incomplete. */
  note: string | null;
}

/** Statuses for the dashboard of this render (offline only). */
export async function collectDashboardStatuses(ctx: AppContext, vaultDir: string, provider: IntegrationStatusProvider | null = registered): Promise<DashboardStatuses> {
  const own = vaultIntegrationStatus(ctx, vaultDir);
  if (!provider) {
    return {
      statuses: [own],
      note: 'Other integrations were not checked during this render (no status provider is wired into `vault render`). Run `npm run cli -- doctor` for their status.',
    };
  }
  try {
    const others = (await provider(ctx, { network: false })).filter((s) => s.id !== 'obsidian');
    return { statuses: [own, ...others], note: others.some((s) => s.networkChecked) ? null : 'Offline checks only: configuration and stored credentials, not connectivity. Run `npm run cli -- doctor` for a live check.' };
  } catch (err) {
    return { statuses: [own], note: `Other integrations could not be checked during this render (${errorMessage(err)}). Run \`npm run cli -- doctor\`.` };
  }
}
