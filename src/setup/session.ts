import type { Clock } from '../core/clock.js';
import { AppError } from '../core/errors.js';
import type { WorkspacePaths } from '../config/paths.js';
import type { SecretStore } from '../config/secrets.js';
import { safeParseSiteConfig, type SiteConfig } from '../config/site-schema.js';
import { saveDraft, type SetupDraft } from './draft.js';
import type { Parser } from './parse.js';
import type { PromptIO } from './prompt-io.js';
import { mergeValues, setAt, type Values } from './values.js';

/**
 * Wizard session: the draft being filled in, plus the prompt helpers.
 *
 * Every validated answer is stored in `draft.partial[stepId][key]` and the
 * draft is saved immediately, so an interrupted wizard resumes exactly where
 * it stopped: on resume, `ask` replays stored answers without prompting.
 * When a step finishes, its values move to `draft.values`, the step is marked
 * answered, and its partial answers are dropped.
 */

export interface GscPropertyChoice {
  siteUrl: string;
  permissionLevel: string;
  canReadData: boolean;
}

export type GscDiscoveryResult = { ok: true; properties: GscPropertyChoice[] } | { ok: false; reason: string; nextStep?: string };

export interface ModelChoice {
  id: string;
  kind: 'chat' | 'embedding';
  /** True when the catalog has a verified price for the model. */
  priced: boolean;
}

export type ModelListResult = { ok: true; models: ModelChoice[]; retrievedAt: string; authenticated: boolean } | { ok: false; reason: string; nextStep?: string };

/** Optional network-backed helpers. Each is a free, read-only request and is only used after the owner agrees. */
export interface SetupServices {
  /** Whether Google credentials look usable (files present); no network. */
  googleCredentialsPresent?: () => { present: boolean; detail: string };
  /** Accessible Search Console properties for the configured Google identity (sites.list). */
  discoverGscProperties?: (config: SiteConfig) => Promise<GscDiscoveryResult>;
  /** LLM Gateway model catalog (GET /v1/models). */
  listModels?: (config: SiteConfig) => Promise<ModelListResult>;
}

export interface AskOptions<T> {
  question: string;
  parse: Parser<T>;
  /** Printed before the first prompt of this key. */
  help?: string;
  /** Substituted for a blank answer before parsing (shown as [default]). */
  default?: string;
}

const MAX_ATTEMPTS = 20;

export interface SessionInit {
  io: PromptIO;
  paths: WorkspacePaths;
  secrets: SecretStore;
  clock: Clock;
  services: SetupServices;
  offline: boolean;
  draft: SetupDraft;
  /** Existing configuration (update mode) or {} (create mode). */
  base: Values;
  /** Workspace kind from the manifest. */
  workspaceKind: 'live' | 'demo';
  /** Steps to (re-)ask even if already answered; null = normal "only missing" behaviour. */
  only: ReadonlySet<string> | null;
}

export class WizardSession {
  readonly io: PromptIO;
  readonly paths: WorkspacePaths;
  readonly secrets: SecretStore;
  readonly clock: Clock;
  readonly services: SetupServices;
  readonly offline: boolean;
  readonly draft: SetupDraft;
  readonly base: Values;
  readonly workspaceKind: 'live' | 'demo';
  readonly only: ReadonlySet<string> | null;
  /** Secret keys the owner chose to inject through the environment or to skip in this run. */
  readonly deferredSecrets = new Map<string, 'env' | 'skipped'>();
  /** Secret keys stored in this run (names only). */
  readonly storedSecrets: string[] = [];

  constructor(init: SessionInit) {
    this.io = init.io;
    this.paths = init.paths;
    this.secrets = init.secrets;
    this.clock = init.clock;
    this.services = init.services;
    this.offline = init.offline;
    this.draft = init.draft;
    this.base = init.base;
    this.workspaceKind = init.workspaceKind;
    this.only = init.only;
  }

  get siteId(): string {
    return this.draft.siteId;
  }

  /** Base config merged with the answers so far. */
  values(): Values {
    return mergeValues(this.base, this.draft.values);
  }

  /** The merged values parsed as a full config (defaults applied), or null while incomplete/invalid. */
  candidateConfig(): SiteConfig | null {
    const r = safeParseSiteConfig(this.values());
    return r.ok ? r.config : null;
  }

  set(path: string, value: unknown): void {
    setAt(this.draft.values, path, value);
  }

  save(): void {
    saveDraft(this.paths, this.draft, this.clock.now(), this.secrets);
  }

  print(text: string): void {
    this.io.print(text);
  }

  private partialOf(stepId: string): Record<string, unknown> {
    const p = this.draft.partial[stepId];
    if (p) return p;
    const created: Record<string, unknown> = {};
    this.draft.partial[stepId] = created;
    return created;
  }

  /** True when an answer for `key` is already stored for this step (resume). */
  hasAnswer(stepId: string, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.draft.partial[stepId] ?? {}, key);
  }

  /** Drop a stored answer (used when an answer must not be replayed). */
  forget(stepId: string, key: string): void {
    const p = this.draft.partial[stepId];
    if (p) delete p[key];
  }

  /**
   * Ask one question (or replay the stored answer). Invalid input is
   * re-prompted with the parser's error. The validated value is saved to the
   * draft before this returns.
   */
  async ask<T>(stepId: string, key: string, opts: AskOptions<T>): Promise<T> {
    const partial = this.partialOf(stepId);
    if (Object.prototype.hasOwnProperty.call(partial, key)) return partial[key] as T;
    if (opts.help) this.io.print(opts.help);
    const question = opts.default !== undefined && opts.default !== '' ? `${opts.question.replace(/:\s*$/, '')} [${opts.default}]: ` : opts.question;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const raw = await this.io.ask(question, { key });
      const input = raw.trim() === '' && opts.default !== undefined ? opts.default : raw;
      const r = opts.parse(input);
      if (r.ok) {
        partial[key] = r.value === undefined ? null : r.value;
        this.save();
        return r.value;
      }
      this.io.print(`  Invalid: ${r.error}`);
    }
    throw new AppError('VALIDATION_FAILED', `Too many invalid answers for ${key}; progress so far is saved.`, { hint: 'Run `npm run cli -- setup` again to resume.' });
  }

  /** Hidden input for a secret. Never stored in the draft or printed. */
  async askSecret(key: string, question: string): Promise<string> {
    return (await this.io.askSecret(question, { key })).trim();
  }

  /** Mark a step complete: its values stay in draft.values, its partial answers are dropped. */
  finishStep(stepId: string): void {
    if (!this.draft.answered.includes(stepId)) this.draft.answered.push(stepId);
    delete this.draft.partial[stepId];
    this.save();
  }

  /** Re-open a step (e.g. after final validation found a problem in its values). */
  reopenStep(stepId: string): void {
    this.draft.answered = this.draft.answered.filter((s) => s !== stepId);
    delete this.draft.partial[stepId];
  }
}
