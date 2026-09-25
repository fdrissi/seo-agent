import type { AppContext } from '../app/context.js';
import type { ApprovalGate } from '../approvals/types.js';
import type { LlmClient } from '../integrations/llm/types.js';
import type { MemoryRetriever } from '../memory/types.js';
import type { VaultWriter } from '../obsidian/types.js';

/**
 * Injected dependencies for the content pipeline. The content module depends
 * only on these contracts; concrete implementations (LLM Gateway adapter,
 * hybrid memory retriever, SQLite approval service, vault writer) are wired
 * by the integration layer.
 *
 * Any dependency may be null: every stage then degrades honestly (e.g. no
 * model => deterministic classification/brief only and drafts refused; no
 * approval service => drafts refused; no vault writer => notes returned as
 * data, not written).
 */
export interface ContentDeps {
  llm: LlmClient | null;
  memory: MemoryRetriever | null;
  approvals: ApprovalGate | null;
  vault: VaultWriter | null;
  /**
   * The approvals workflow's binding for publishing a draft (its canonical
   * change hash). Optional: without it the publication gate reports the
   * binding as unavailable instead of guessing a hash.
   */
  proposals?: PublicationProposalResolver | null;
}

/** How the approvals workflow binds a publication approval for a draft. */
export interface PublicationBindingInfo {
  subjectType: string;
  actionType: 'publish_content' | 'update_page';
  /** Canonical change hash the approvals workflow binds (NOT a hash of the body alone). */
  artifactHash: string;
  targetUrl: string;
}

export interface PublicationProposalResolver {
  /** Resolve the exact proposal for a draft; throws when the approvals workflow would refuse to export it. */
  resolve(ctx: AppContext, draftId: string): PublicationBindingInfo;
}

/** Dependencies, or a provider that builds them for a given (stage) context so per-stage budgets apply. */
export type ContentDepsSource = ContentDeps | ((app: AppContext) => ContentDeps | Promise<ContentDeps>);

export async function depsFor(source: ContentDepsSource, app: AppContext): Promise<ContentDeps> {
  return typeof source === 'function' ? await source(app) : source;
}

export interface DependencyStatus {
  name: keyof ContentDeps;
  wired: boolean;
  detail: string;
}

export type ContentDepsFactory = (ctx: AppContext) => Partial<ContentDeps> | Promise<Partial<ContentDeps>>;

let registered: ContentDepsFactory | null = null;

/** Register the factory that builds concrete dependencies (integration phase, tests). */
export function registerContentDepsFactory(factory: ContentDepsFactory | null): void {
  registered = factory;
}

/**
 * Conventional wiring used when no factory is registered. Modules are loaded
 * dynamically (no compile-time dependency on other slices) and every result is
 * structurally checked; anything missing or failing is reported as "not
 * wired", never as success. Memory is created WITHOUT an LLM client so content
 * retrieval stays full-text only and never spends on embeddings implicitly.
 */
type Mod = Record<string, unknown>;
const CONVENTIONAL: Array<{ name: keyof ContentDeps; modules: string[]; label: string; build: (m: Mod, ctx: AppContext) => unknown; valid: (v: unknown) => boolean }> = [
  {
    name: 'llm',
    modules: ['../integrations/llm/index.js'],
    label: 'createLlmClient(ctx)',
    build: (m, ctx) => (typeof m.createLlmClient === 'function' ? (m.createLlmClient as (c: AppContext) => unknown)(ctx) : null),
    valid: (v) => hasMethods(v, ['structured', 'embed', 'isConfigured']),
  },
  {
    name: 'memory',
    modules: ['../memory/service.js'],
    label: 'createMemoryService(ctx) (full-text only)',
    build: (m, ctx) => (typeof m.createMemoryService === 'function' ? (m.createMemoryService as (c: AppContext, d: object) => unknown)(ctx, {}) : null),
    valid: (v) => hasMethods(v, ['search']),
  },
  {
    name: 'approvals',
    modules: ['../approvals/service.js'],
    label: 'new ApprovalService(db)',
    build: (m, ctx) => (typeof m.ApprovalService === 'function' ? new (m.ApprovalService as new (db: unknown, o: object) => unknown)(ctx.db, { clock: ctx.clock }) : null),
    valid: (v) => hasMethods(v, ['request', 'check', 'consume']),
  },
  {
    name: 'vault',
    modules: ['../obsidian/writer.js'],
    label: 'createVaultWriter(ctx)',
    build: (m, ctx) => (typeof m.createVaultWriter === 'function' ? (m.createVaultWriter as (c: AppContext) => unknown)(ctx) : null),
    valid: (v) => hasMethods(v, ['writeGenerated']),
  },
  {
    name: 'proposals',
    modules: ['../approvals/subjects.js'],
    label: 'resolveProposal + proposalArtifactHash (approvals workflow)',
    build: async (m) => {
      const pub = await importModule('../approvals/publisher.js');
      const resolve = m.resolveProposal as ((c: AppContext, t: string, id: string) => { subjectType: string; actionType: string; targetUrl: string }) | undefined;
      const hash = pub?.proposalArtifactHash as ((p: unknown) => string) | undefined;
      if (typeof resolve !== 'function' || typeof hash !== 'function') return null;
      const resolver: PublicationProposalResolver = {
        resolve(c, draftId) {
          const p = resolve(c, 'draft', draftId);
          return { subjectType: p.subjectType, actionType: p.actionType === 'update_page' ? 'update_page' : 'publish_content', artifactHash: hash(p), targetUrl: p.targetUrl };
        },
      };
      return resolver;
    },
    valid: (v) => hasMethods(v, ['resolve']),
  },
];

/** Import a module relative to this file (supports running from sources where files end in .ts). */
async function importModule(spec: string): Promise<Mod | null> {
  const url = new URL(spec, import.meta.url);
  for (const href of [url.href, url.href.replace(/\.js$/, '.ts')]) {
    try {
      return (await import(href)) as Mod;
    } catch {
      continue;
    }
  }
  return null;
}

function hasMethods(v: unknown, names: string[]): boolean {
  return !!v && typeof v === 'object' && names.every((n) => typeof (v as Record<string, unknown>)[n] === 'function');
}

export async function resolveContentDeps(ctx: AppContext, overrides: Partial<ContentDeps> = {}): Promise<{ deps: ContentDeps; status: DependencyStatus[] }> {
  const deps: ContentDeps = { llm: null, memory: null, approvals: null, vault: null, proposals: null };
  const status: DependencyStatus[] = [];
  let fromFactory: Partial<ContentDeps> = {};
  if (registered) fromFactory = await registered(ctx);
  for (const c of CONVENTIONAL) {
    const set = (v: unknown) => ((deps as unknown as Record<string, unknown>)[c.name] = v ?? null);
    if (c.name in overrides) {
      set(overrides[c.name]);
      status.push({ name: c.name, wired: !!overrides[c.name], detail: overrides[c.name] ? 'provided by caller' : 'explicitly disabled by caller' });
      continue;
    }
    if (c.name in fromFactory) {
      const v = fromFactory[c.name] ?? null;
      set(v);
      status.push({ name: c.name, wired: !!v, detail: v ? 'provided by registered factory' : 'explicitly disabled by registered factory' });
      continue;
    }
    const found = await tryConventional(c, ctx);
    set(found.value);
    status.push({ name: c.name, wired: !!found.value, detail: found.detail });
  }
  return { deps, status };
}

async function tryConventional(c: (typeof CONVENTIONAL)[number], ctx: AppContext): Promise<{ value: unknown; detail: string }> {
  for (const spec of c.modules) {
    const mod = await importModule(spec);
    if (!mod) continue;
    try {
      const v = await c.build(mod, ctx);
      if (c.valid(v)) return { value: v, detail: `wired via ${c.label}` };
      return { value: null, detail: `${c.label} not available in ${spec.replace('../', 'src/')}` };
    } catch (err) {
      return { value: null, detail: `${c.label} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { value: null, detail: `not wired in this build (${c.label} not found)` };
}
