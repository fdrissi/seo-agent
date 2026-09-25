import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import type { AppContext } from '../app/context.js';
import { AppError, ValidationError, errorMessage } from '../core/errors.js';
import { hashObject, sha256 } from '../core/hash.js';
import { newId } from '../core/ids.js';
import type { TrustClass } from '../core/modes.js';
import { assertIsoDate } from '../core/time.js';
import { parseYamlSafe } from '../config/load.js';
import { siteConfigFile, siteVaultDir } from '../config/paths.js';
import { parseSiteConfig, type SiteConfig } from '../config/site-schema.js';
import { recordAudit } from '../database/audit.js';
import { ensureSite } from '../database/sites.js';
import { safeResolve } from '../security/paths.js';
import { isAllowedHost, normalizeUrl } from '../seo/url.js';
import { parseNoteStructure } from './frontmatter.js';
import { atomicWriteFile, resolveInVault } from './fs-safe.js';
import { GENERATED_END, GENERATED_START } from './types.js';

/**
 * Business-note sync: human-maintained notes in `01 Business/` are imported
 * through a validated sync with version history (`business_note_versions`).
 *
 * Trust and approval rules (enforced in code, never read from Markdown):
 * - Frontmatter such as `approved: true`, `trusted: true`, or
 *   `trust_class: owner_approved` grants nothing. Such keys are reported as
 *   ignored.
 * - Notes produced by seo-agent (generated markers, tracked in vault_notes, a
 *   generated note type, or a generated note id) are rejected: agent-generated
 *   or scraped text can never become an owner business fact by being copied
 *   into 01 Business.
 * - Recording a version never changes the site config. Only
 *   `vault apply-business --confirm <diff-hash>` does, after showing the diff;
 *   it writes the YAML config and a config version with source
 *   'business_note_sync'. The hash binds the confirmation to the exact diff and
 *   base config, so a changed note or config requires a new review.
 */

export const BUSINESS_FOLDER = '01 Business';
export const BUSINESS_NOTE_TYPES = ['business_profile', 'customer_questions', 'owner_decisions', 'business_note'] as const;
export type BusinessNoteType = (typeof BUSINESS_NOTE_TYPES)[number];

/** Note types written by seo-agent; such notes can never be imported as human business notes. */
const GENERATED_NOTE_TYPES = new Set([
  'page',
  'keyword',
  'competitor',
  'experiment',
  'decision',
  'learning',
  'source',
  'brief',
  'draft',
  'content_opportunity',
  'content_farm_index',
  'ai_search_index',
  'dashboard',
  'vault_index',
  'vault_conflict',
  'vault_backup',
  'system_log',
  'report',
]);

/** Keys that look like approval/trust claims. They are ignored and reported. */
const AUTHORITY_KEY_RE = /^(approv|trust|authori[sz]|verif|sign(ed)?[_-]?off|permission|publish|execute|allow)/i;

const text = z.string().trim().min(1).max(2_000);
const item = z.string().trim().min(1).max(500);
const factId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Fact ids use lowercase letters, digits, and hyphens, e.g. [pf-pricing-model]');

export const businessProfileSchema = z
  .object({
    offer: text.nullable().optional(),
    targetCustomer: text.nullable().optional(),
    differentiators: z.array(item).max(50).optional(),
    productFacts: z
      .array(
        z
          .object({
            id: factId,
            statement: z.string().trim().min(1).max(1_000),
            source: z.string().trim().min(1).max(500).nullable(),
            verifiedAt: z.string().nullable(),
          })
          .strict(),
      )
      .max(200)
      .optional(),
    approvedClaims: z.array(item).max(100).optional(),
    prohibitedClaims: z.array(item).max(100).optional(),
    brandVoice: text.optional(),
    editorialRequirements: z.array(item).max(50).optional(),
  })
  .strict();
export type BusinessProfileData = z.infer<typeof businessProfileSchema>;

export const customerQuestionsSchema = z.object({ questions: z.array(item).max(500) }).strict();
export const ownerDecisionsSchema = z
  .object({
    decisions: z.array(z.object({ date: z.string(), text: z.string().trim().min(1).max(1_000) }).strict()).max(500),
    authorizesProductionActions: z.literal(false),
  })
  .strict();
export const businessNoteSchema = z.object({ sections: z.array(z.object({ heading: z.string().max(200), text: z.string().max(20_000) }).strict()).max(50) }).strict();

export interface ParsedBusinessNote {
  relPath: string;
  contentHash: string;
  noteType: BusinessNoteType | null;
  noteId: string | null;
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Frontmatter keys that claimed approval/trust and were ignored. */
  ignoredAuthorityKeys: string[];
  data: Record<string, unknown> | null;
}

// ---------------------------------------------------------------- Markdown section parsing

interface Section {
  heading: string;
  key: string;
  lines: Array<{ text: string; line: number }>;
}

function stripComments(body: string): string {
  // Replace comment content with blank lines so line numbers stay meaningful.
  const blank = (m: string) => m.replace(/[^\n]/g, '');
  return body.replace(/<!--[\s\S]*?-->/g, blank).replace(/%%[\s\S]*?%%/g, blank);
}

function sectionKey(heading: string): string {
  return heading.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function parseSections(body: string, bodyStartLine: number): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  let fence: string | null = null;
  stripComments(body)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((l, i) => {
      const lineNo = bodyStartLine + i;
      const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(l);
      if (fence) {
        if (fenceMatch && fenceMatch[1]!.startsWith(fence[0]!) && fenceMatch[1]!.length >= fence.length) fence = null;
        current?.lines.push({ text: l, line: lineNo });
        return;
      }
      if (fenceMatch) fence = fenceMatch[1]!;
      const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(l);
      if (h2 && !/^###/.test(l)) {
        current = { heading: h2[1]!, key: sectionKey(h2[1]!), lines: [] };
        sections.push(current);
        return;
      }
      if (/^#\s+/.test(l)) {
        current = null;
        return;
      }
      current?.lines.push({ text: l, line: lineNo });
    });
  return sections;
}

const NONE_RE = /^\(?\s*(none|unknown|n\/a)\s*\)?$/i;

/** Text section: undefined = empty (no change), null = explicitly none/unknown. */
function sectionText(s: Section): string | null | undefined {
  const t = s.lines
    .map((l) => l.text.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
    .trim();
  if (!t) return undefined;
  if (NONE_RE.test(t)) return null;
  return t;
}

/** Bullet list section: undefined = empty (no change), [] = explicit "(none)". */
function sectionList(s: Section, errors: string[]): Array<{ text: string; line: number }> | undefined {
  const items: Array<{ text: string; line: number }> = [];
  for (const { text: l, line } of s.lines) {
    if (!l.trim()) continue;
    const bullet = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(l);
    if (bullet) {
      const v = bullet[1]!.trim();
      if (v) items.push({ text: v, line });
      continue;
    }
    if (/^\s{2,}\S/.test(l) && items.length) {
      items[items.length - 1]!.text += ` ${l.trim()}`;
      continue;
    }
    errors.push(`Section "${s.heading}" (line ${line}): expected a bulleted list item ("- ..."), found plain text`);
  }
  if (!items.length) return undefined;
  if (items.length === 1 && NONE_RE.test(items[0]!.text)) return [];
  return items;
}

function parseFact(raw: string, line: number, errors: string[]): { id: string; statement: string; source: string | null; verifiedAt: string | null } | null {
  const m = /^\[([^\]]+)\]\s+(.+)$/.exec(raw);
  if (!m) {
    errors.push(`Product facts (line ${line}): each fact must start with a stable id, e.g. "- [pf-pricing-model] Statement. (source: https://..., verified: 2026-09-01)"`);
    return null;
  }
  const id = m[1]!.trim();
  let statement = m[2]!.trim();
  let source: string | null = null;
  let verifiedAt: string | null = null;
  const metaStart = statement.search(/\((?:source|verified)\s*:/i);
  if (metaStart !== -1 && statement.endsWith(')')) {
    const meta = statement.slice(metaStart + 1, -1);
    statement = statement.slice(0, metaStart).trim();
    for (const part of meta.split(/,(?=\s*(?:source|verified)\s*:)/i)) {
      const kv = /^\s*(source|verified)\s*:\s*(.*?)\s*$/i.exec(part);
      if (!kv) {
        errors.push(`Product facts (line ${line}): unrecognized metadata "${part.trim()}" (use "source:" and "verified:")`);
        continue;
      }
      if (kv[1]!.toLowerCase() === 'source') source = kv[2]! || null;
      else {
        try {
          assertIsoDate(kv[2]!);
          verifiedAt = kv[2]!;
        } catch {
          errors.push(`Product facts (line ${line}): "verified" must be a date in YYYY-MM-DD format`);
        }
      }
    }
  }
  return { id, statement, source, verifiedAt };
}

const PROFILE_SECTIONS: Record<string, keyof BusinessProfileData> = {
  offer: 'offer',
  'target customer': 'targetCustomer',
  'target customers': 'targetCustomer',
  differentiators: 'differentiators',
  'product facts': 'productFacts',
  'approved claims': 'approvedClaims',
  'prohibited claims': 'prohibitedClaims',
  'brand voice': 'brandVoice',
  'editorial requirements': 'editorialRequirements',
};

function zodErrors(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join('.') || '(note)'}: ${i.message}`);
}

function parseProfile(sections: Section[], errors: string[], warnings: string[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (const s of sections) {
    const field = PROFILE_SECTIONS[s.key];
    if (!field) {
      warnings.push(`Section "${s.heading}" is not part of the business profile and is ignored by the sync`);
      continue;
    }
    if (seen.has(field)) {
      errors.push(`Section "${s.heading}" appears more than once`);
      continue;
    }
    seen.add(field);
    if (field === 'offer' || field === 'targetCustomer') {
      const v = sectionText(s);
      if (v !== undefined) data[field] = v;
    } else if (field === 'brandVoice') {
      const v = sectionText(s);
      if (v === null) errors.push('Brand voice cannot be "(none)"; leave the section empty to keep the current configured voice');
      else if (v !== undefined) data[field] = v;
    } else if (field === 'productFacts') {
      const items = sectionList(s, errors);
      if (items !== undefined) {
        const facts = items.map((i) => parseFact(i.text, i.line, errors)).filter((f): f is NonNullable<typeof f> => f !== null);
        const ids = new Set<string>();
        for (const f of facts) {
          if (ids.has(f.id)) errors.push(`Product facts: duplicate fact id [${f.id}]`);
          ids.add(f.id);
        }
        data[field] = facts;
      }
    } else {
      const items = sectionList(s, errors);
      if (items !== undefined) data[field] = items.map((i) => i.text);
    }
  }
  const approved = new Set(((data.approvedClaims as string[] | undefined) ?? []).map((c) => c.toLowerCase()));
  for (const c of (data.prohibitedClaims as string[] | undefined) ?? []) {
    if (approved.has(c.toLowerCase())) errors.push(`Claim "${c}" is listed as both approved and prohibited`);
  }
  const parsed = businessProfileSchema.safeParse(data);
  if (!parsed.success) errors.push(...zodErrors(parsed.error));
  return data;
}

function parseQuestions(sections: Section[], errors: string[], warnings: string[]): Record<string, unknown> {
  const questions: string[] = [];
  for (const s of sections) {
    if (s.key !== 'questions') {
      warnings.push(`Section "${s.heading}" is ignored (customer_questions notes use a "## Questions" list)`);
      continue;
    }
    for (const i of sectionList(s, errors) ?? []) questions.push(i.text);
  }
  const data = { questions };
  const parsed = customerQuestionsSchema.safeParse(data);
  if (!parsed.success) errors.push(...zodErrors(parsed.error));
  return data;
}

function parseDecisions(sections: Section[], errors: string[], warnings: string[]): Record<string, unknown> {
  const decisions: Array<{ date: string; text: string }> = [];
  for (const s of sections) {
    if (s.key !== 'decisions') {
      warnings.push(`Section "${s.heading}" is ignored (owner_decisions notes use a "## Decisions" list)`);
      continue;
    }
    for (const i of sectionList(s, errors) ?? []) {
      const m = /^(\d{4}-\d{2}-\d{2})\s*[:\-–]\s*(.+)$/.exec(i.text);
      if (!m) {
        errors.push(`Decisions (line ${i.line}): use "- YYYY-MM-DD: decision"`);
        continue;
      }
      try {
        assertIsoDate(m[1]!);
      } catch {
        errors.push(`Decisions (line ${i.line}): invalid date ${m[1]}`);
        continue;
      }
      decisions.push({ date: m[1]!, text: m[2]!.trim() });
    }
  }
  const data = { decisions, authorizesProductionActions: false as const };
  const parsed = ownerDecisionsSchema.safeParse(data);
  if (!parsed.success) errors.push(...zodErrors(parsed.error));
  return data;
}

function parseFreeform(sections: Section[], errors: string[]): Record<string, unknown> {
  const data = { sections: sections.map((s) => ({ heading: s.heading, text: s.lines.map((l) => l.text).join('\n').trim() })) };
  const parsed = businessNoteSchema.safeParse(data);
  if (!parsed.success) errors.push(...zodErrors(parsed.error));
  return data;
}

export interface ParseBusinessNoteOptions {
  siteId: string;
  /** Vault paths tracked as generated notes (vault_notes). */
  trackedPaths?: ReadonlySet<string>;
  /** Note ids of generated notes (vault_notes). */
  generatedNoteIds?: ReadonlySet<string>;
}

/** Validate one human business note. Never throws for content problems: returns errors instead. */
export function parseBusinessNote(relPath: string, raw: string, opts: ParseBusinessNoteOptions): ParsedBusinessNote {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ignoredAuthorityKeys: string[] = [];
  const result = (noteType: BusinessNoteType | null, noteId: string | null, data: Record<string, unknown> | null): ParsedBusinessNote => ({
    relPath,
    contentHash: sha256(raw),
    noteType,
    noteId,
    valid: errors.length === 0,
    errors,
    warnings,
    ignoredAuthorityKeys,
    data: errors.length === 0 ? data : null,
  });

  if (raw.includes(GENERATED_START) || raw.includes(GENERATED_END)) {
    errors.push('This note contains seo-agent generated markers. Agent-generated notes cannot be imported as human business notes or grant themselves trust.');
    return result(null, null, null);
  }
  if (opts.trackedPaths?.has(relPath)) {
    errors.push('This path is tracked as a generated note; only human-written notes can be imported.');
    return result(null, null, null);
  }
  let parsed;
  try {
    parsed = parseNoteStructure(raw, relPath);
  } catch (err) {
    errors.push(errorMessage(err));
    return result(null, null, null);
  }
  const fm = parsed.frontmatter;
  for (const key of Object.keys(fm)) {
    if (AUTHORITY_KEY_RE.test(key)) {
      ignoredAuthorityKeys.push(key);
      warnings.push(`Property "${key}" is ignored: approvals and trust are granted only through the CLI workflow, never by note properties.`);
    }
  }
  const rawType = fm.type;
  if (typeof rawType === 'string' && GENERATED_NOTE_TYPES.has(rawType)) {
    errors.push(`Note type "${rawType}" is produced by seo-agent; generated notes cannot be imported as human business notes.`);
    return result(null, null, null);
  }
  if (typeof rawType !== 'string' || !(BUSINESS_NOTE_TYPES as readonly string[]).includes(rawType)) {
    errors.push(`Add a "type" property with one of: ${BUSINESS_NOTE_TYPES.join(', ')}`);
    return result(null, null, null);
  }
  const noteType = rawType as BusinessNoteType;
  const id = fm.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(id)) {
    errors.push('Add a stable "id" property (letters, digits, dot, dash, underscore, colon).');
  } else if (opts.generatedNoteIds?.has(id)) {
    errors.push(`The id "${id}" belongs to a generated note; generated notes cannot be imported as human business notes.`);
  }
  if (fm.site !== undefined && fm.site !== null) {
    if (fm.site === '{{site_id}}') errors.push('Replace the "{{site_id}}" placeholder in the "site" property with your site id.');
    else if (fm.site !== opts.siteId) errors.push(`The "site" property (${String(fm.site)}) does not match this site (${opts.siteId}).`);
  } else warnings.push('No "site" property; the note is imported for the current site.');
  if (noteType === 'business_profile' && fm.schema_version !== undefined && fm.schema_version !== 1) errors.push('Unsupported schema_version (expected 1).');

  const bodyStartLine = parsed.split.hasFrontmatter ? raw.slice(0, raw.length - parsed.body.length).split('\n').length : 1;
  const sections = parseSections(parsed.body, bodyStartLine);
  let data: Record<string, unknown>;
  switch (noteType) {
    case 'business_profile':
      data = parseProfile(sections, errors, warnings);
      break;
    case 'customer_questions':
      data = parseQuestions(sections, errors, warnings);
      break;
    case 'owner_decisions':
      data = parseDecisions(sections, errors, warnings);
      warnings.push('Owner decisions are recorded as knowledge. They never authorize production actions.');
      break;
    default:
      data = parseFreeform(sections, errors);
  }
  return result(noteType, typeof id === 'string' ? id : null, data);
}

// ---------------------------------------------------------------- scanning

export interface ScannedBusinessNote {
  relPath: string;
  raw: string | null;
  error?: string;
}

/** List Markdown notes in `01 Business/` (recursively). Symlinks are reported, never followed. */
export function scanBusinessNotes(vaultDir: string): ScannedBusinessNote[] {
  const out: ScannedBusinessNote[] = [];
  const root = path.join(vaultDir, BUSINESS_FOLDER);
  if (!existsSync(root)) return out;
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return [{ relPath: BUSINESS_FOLDER, raw: null, error: `${BUSINESS_FOLDER} is not a real folder (symlinks are never followed)` }];
  const walk = (dirAbs: string, rel: string) => {
    for (const e of readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue;
      const childRel = `${rel}/${e.name}`;
      if (e.isSymbolicLink()) {
        if (e.name.toLowerCase().endsWith('.md')) out.push({ relPath: childRel, raw: null, error: 'Symlinked note; symlinks are never followed' });
        continue;
      }
      if (e.isDirectory()) walk(path.join(dirAbs, e.name), childRel);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md') && !/\.conflict-\d{8}T\d{6}Z/.test(e.name)) {
        const abs = resolveInVault(vaultDir, childRel, { createParents: false });
        out.push({ relPath: childRel, raw: readFileSync(abs, 'utf8') });
      }
    }
  };
  walk(root, BUSINESS_FOLDER);
  return out;
}

// ---------------------------------------------------------------- config diff

export interface ConfigChange {
  path: string;
  op: 'set' | 'add' | 'remove' | 'change';
  from?: unknown;
  to?: unknown;
}

export interface ProfileDiff {
  changes: ConfigChange[];
  /** Human-readable diff lines (+ added, - removed, ~ changed). */
  lines: string[];
  nextConfig: SiteConfig;
}

type Fact = SiteConfig['business']['productFacts'][number];

function listDiff(pathName: string, from: string[], to: string[], changes: ConfigChange[]): void {
  const fromSet = new Set(from);
  const toSet = new Set(to);
  for (const x of to) if (!fromSet.has(x)) changes.push({ path: pathName, op: 'add', to: x });
  for (const x of from) if (!toSet.has(x)) changes.push({ path: pathName, op: 'remove', from: x });
  if (!changes.some((c) => c.path === pathName) && JSON.stringify(from) !== JSON.stringify(to)) changes.push({ path: pathName, op: 'change', from, to });
}

/** Compute the config changes a business profile would make (empty sections leave config unchanged). */
export function diffBusinessProfile(profile: BusinessProfileData, config: SiteConfig): ProfileDiff {
  const changes: ConfigChange[] = [];
  const next = structuredClone(config) as SiteConfig;
  const scalar = (pathName: string, from: string | null, to: string | null | undefined, apply: (v: string | null) => void) => {
    if (to === undefined || to === from) return;
    changes.push({ path: pathName, op: from === null ? 'set' : 'change', from, to });
    apply(to);
  };
  scalar('business.offer', config.business.offer, profile.offer, (v) => (next.business.offer = v));
  scalar('business.targetCustomer', config.business.targetCustomer, profile.targetCustomer, (v) => (next.business.targetCustomer = v));
  if (profile.brandVoice !== undefined && profile.brandVoice !== config.editorial.brandVoice) {
    changes.push({ path: 'editorial.brandVoice', op: 'change', from: config.editorial.brandVoice, to: profile.brandVoice });
    next.editorial.brandVoice = profile.brandVoice;
  }
  const lists: Array<[string, string[], string[] | undefined, (v: string[]) => void]> = [
    ['business.differentiators', config.business.differentiators, profile.differentiators, (v) => (next.business.differentiators = v)],
    ['business.approvedClaims', config.business.approvedClaims, profile.approvedClaims, (v) => (next.business.approvedClaims = v)],
    ['business.prohibitedClaims', config.business.prohibitedClaims, profile.prohibitedClaims, (v) => (next.business.prohibitedClaims = v)],
    ['editorial.requirements', config.editorial.requirements, profile.editorialRequirements, (v) => (next.editorial.requirements = v)],
  ];
  for (const [p, from, to, apply] of lists) {
    if (to === undefined) continue;
    const before = changes.length;
    listDiff(p, from, to, changes);
    if (changes.length !== before) apply([...to]);
  }
  if (profile.productFacts !== undefined) {
    const fromById = new Map(config.business.productFacts.map((f) => [f.id, f]));
    const toFacts: Fact[] = profile.productFacts.map((f) => ({ id: f.id, statement: f.statement, source: f.source, verifiedAt: f.verifiedAt }));
    const toById = new Map(toFacts.map((f) => [f.id, f]));
    const before = changes.length;
    for (const f of toFacts) {
      const old = fromById.get(f.id);
      if (!old) changes.push({ path: `business.productFacts[${f.id}]`, op: 'add', to: f });
      else if (old.statement !== f.statement || old.source !== f.source || old.verifiedAt !== f.verifiedAt) changes.push({ path: `business.productFacts[${f.id}]`, op: 'change', from: old, to: f });
    }
    for (const old of config.business.productFacts) if (!toById.has(old.id)) changes.push({ path: `business.productFacts[${old.id}]`, op: 'remove', from: old });
    if (changes.length === before && JSON.stringify(config.business.productFacts.map((f) => f.id)) !== JSON.stringify(toFacts.map((f) => f.id))) {
      changes.push({ path: 'business.productFacts', op: 'change', from: config.business.productFacts.map((f) => f.id), to: toFacts.map((f) => f.id) });
    }
    if (changes.length !== before) next.business.productFacts = toFacts;
  }
  const fmt = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v) : v && typeof v === 'object' && 'statement' in (v as Fact) ? `${JSON.stringify((v as Fact).statement)} (source: ${(v as Fact).source ?? 'none'}, verified: ${(v as Fact).verifiedAt ?? 'no'})` : JSON.stringify(v));
  const lines = changes.map((c) =>
    c.op === 'add' ? `+ ${c.path}: ${fmt(c.to)}` : c.op === 'remove' ? `- ${c.path}: ${fmt(c.from)}` : `~ ${c.path}: ${c.from === null || c.from === undefined ? '(unset)' : fmt(c.from)} -> ${fmt(c.to)}`,
  );
  return { changes, lines, nextConfig: next };
}

// ---------------------------------------------------------------- import (record versions)

export interface BusinessNoteImportItem extends Omit<ParsedBusinessNote, 'data'> {
  status: 'new' | 'recorded' | 'already_recorded' | 'rejected';
  recordedStatus: 'imported' | 'rejected' | 'pending_review' | null;
  versionId: string | null;
  /** Version number of this content (one per distinct content of the note). */
  version: number | null;
  /** Revision number of this recording (one per recorded change, including a return to earlier content). */
  revision: number | null;
  /** Set when the note returned to the content of an earlier version (A -> B -> A). */
  returnsToVersion: number | null;
  configChanges: string[];
  /** owner_decisions notes with --apply: entries synced into the `decisions` table. */
  ownerDecisions?: OwnerDecisionSync;
}

export interface OwnerDecisionSync {
  /** Decision rows now present for this note (one per entry and subject). */
  rows: number;
  inserted: number;
  /** Rows of entries the owner removed from the note (deleted from `decisions`). */
  withdrawn: number;
  /** Entries without a resolvable page/URL/opportunity: recorded as site-wide decisions (never exclude a specific candidate). */
  siteWide: number;
}

export interface BusinessImportResult {
  vaultDir: string;
  apply: boolean;
  dryRun: boolean;
  notes: BusinessNoteImportItem[];
  profile: { relPath: string; contentHash: string; lines: string[]; changes: ConfigChange[]; diffHash: string } | null;
  recorded: number;
  rejected: number;
  nextStep: string;
}

interface VersionRow {
  id: string;
  site_id: string;
  note_path: string;
  content_hash: string;
  parsed_json: string | null;
  status: 'imported' | 'rejected' | 'pending_review';
  validation_errors_json: string | null;
  imported_at: string;
  note_type: string | null;
  version: number | null;
  applied_config_version: number | null;
  applied_at: string | null;
  applied_by: string | null;
}

interface RevisionRow {
  id: string;
  revision: number;
  version_id: string;
  content_hash: string;
}

/**
 * The content most recently recorded for a note: the latest revision, or (for
 * history recorded before revisions existed) the highest version.
 */
function latestRecorded(ctx: AppContext, notePath: string): { contentHash: string; revision: number; revisionId: string | null } | null {
  const rev = ctx.db.get<RevisionRow>('SELECT id, revision, version_id, content_hash FROM business_note_revisions WHERE site_id = ? AND note_path = ? ORDER BY revision DESC LIMIT 1', [ctx.siteId, notePath]);
  if (rev) return { contentHash: rev.content_hash, revision: rev.revision, revisionId: rev.id };
  const v = ctx.db.get<VersionRow>('SELECT * FROM business_note_versions WHERE site_id = ? AND note_path = ? ORDER BY version DESC, imported_at DESC LIMIT 1', [ctx.siteId, notePath]);
  return v ? { contentHash: v.content_hash, revision: v.version ?? 0, revisionId: null } : null;
}

/** Next revision number for a note (continues from the version numbers of history recorded before revisions existed). */
function nextRevisionNumber(ctx: AppContext, notePath: string): number {
  const maxRev = ctx.db.get<{ v: number | null }>('SELECT MAX(revision) AS v FROM business_note_revisions WHERE site_id = ? AND note_path = ?', [ctx.siteId, notePath])?.v ?? 0;
  const maxVer = ctx.db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM business_note_versions WHERE site_id = ? AND note_path = ?', [ctx.siteId, notePath])?.v ?? 0;
  return Math.max(maxRev, maxVer) + 1;
}

function insertRevision(ctx: AppContext, notePath: string, versionId: string, contentHash: string, actor: string, at: string, revision: number = nextRevisionNumber(ctx, notePath)): { id: string; revision: number } {
  const id = newId('bnr');
  ctx.db.run(
    'INSERT INTO business_note_revisions (id, site_id, note_path, revision, version_id, content_hash, recorded_at, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, ctx.siteId, notePath, revision, versionId, contentHash, at, actor],
  );
  return { id, revision };
}

function generatedIndex(ctx: AppContext): { paths: Set<string>; ids: Set<string> } {
  const rows = ctx.db.all<{ rel_path: string; note_id: string }>('SELECT rel_path, note_id FROM vault_notes WHERE site_id = ?', [ctx.siteId]);
  return { paths: new Set(rows.map((r) => r.rel_path)), ids: new Set(rows.map((r) => r.note_id)) };
}

function currentConfig(ctx: AppContext): { config: SiteConfig; file: string; text: string } {
  const file = siteConfigFile(ctx.paths, ctx.siteId);
  if (!existsSync(file)) throw new AppError('CONFIG_MISSING', `Site config not found: ${file}`);
  const text = readFileSync(file, 'utf8');
  const config = parseSiteConfig(parseYamlSafe(text, file));
  return { config, file, text };
}

export function diffHashFor(siteId: string, relPath: string, contentHash: string, config: SiteConfig, changes: ConfigChange[]): string {
  return hashObject({ siteId, relPath, contentHash, baseConfigHash: hashObject(config), changes });
}

function parseAll(ctx: AppContext, vaultDir: string): ParsedBusinessNote[] {
  const idx = generatedIndex(ctx);
  const parsed = scanBusinessNotes(vaultDir).map((s): ParsedBusinessNote =>
    s.raw === null
      ? { relPath: s.relPath, contentHash: '', noteType: null, noteId: null, valid: false, errors: [s.error ?? 'unreadable'], warnings: [], ignoredAuthorityKeys: [], data: null }
      : parseBusinessNote(s.relPath, s.raw, { siteId: ctx.siteId, trackedPaths: idx.paths, generatedNoteIds: idx.ids }),
  );
  const profiles = parsed.filter((p) => p.valid && p.noteType === 'business_profile');
  if (profiles.length > 1) {
    for (const p of profiles) {
      p.valid = false;
      p.errors.push(`Only one business_profile note is allowed; found ${profiles.length} (${profiles.map((x) => x.relPath).join(', ')}).`);
      p.data = null;
    }
  }
  const ids = new Map<string, string[]>();
  for (const p of parsed) if (p.noteId) ids.set(p.noteId, [...(ids.get(p.noteId) ?? []), p.relPath]);
  for (const p of parsed) {
    if (p.noteId && (ids.get(p.noteId)?.length ?? 0) > 1) {
      p.valid = false;
      p.data = null;
      p.errors.push(`The id "${p.noteId}" is used by more than one business note.`);
    }
  }
  return parsed;
}

// ---------------------------------------------------------------- owner decisions -> decisions table

export interface OwnerDecisionSubject {
  subjectType: 'page' | 'url' | 'opportunity' | 'site';
  subjectId: string;
}

/** An absolute URL in decision text (trailing sentence punctuation is not part of it). */
const DECISION_URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
/** A page or opportunity id in decision text, e.g. page_01J... or opp_01J... */
const DECISION_ID_RE = /\b(page|opp)_[A-Za-z0-9]+\b/g;

/**
 * Subjects of an owner decision entry, resolved to what the recommendation
 * exclusion compares (src/seo/recommend.ts: opportunity id, page id, page URL):
 * - an absolute URL on the site -> its page id when the page is known
 *   (normalized URL, or an established alias), else the normalized URL;
 * - a page id (page_...) or opportunity id (opp_...) that exists for the site.
 * Off-site URLs are ignored. No subject -> a site-wide decision (knowledge only;
 * it never excludes a specific candidate).
 */
export function resolveDecisionSubjects(ctx: Pick<AppContext, 'db' | 'siteId' | 'config'>, text: string): OwnerDecisionSubject[] {
  const out = new Map<string, OwnerDecisionSubject>();
  const add = (s: OwnerDecisionSubject) => out.set(`${s.subjectType}:${s.subjectId}`, s);
  for (const m of text.matchAll(DECISION_URL_RE)) {
    const raw = m[0].replace(/[.,;:!?)\]}'"]+$/, '');
    const n = normalizeUrl(raw);
    if (!n || !isAllowedHost(n.url, ctx.config.site.allowedHostnames)) continue;
    const page =
      ctx.db.get<{ id: string }>('SELECT id FROM pages WHERE site_id = ? AND url = ? LIMIT 1', [ctx.siteId, n.url]) ??
      ctx.db.get<{ id: string }>(`SELECT page_id AS id FROM url_aliases WHERE site_id = ? AND alias_url = ? AND confidence = 'established' LIMIT 1`, [ctx.siteId, n.url]);
    add(page ? { subjectType: 'page', subjectId: page.id } : { subjectType: 'url', subjectId: n.url });
  }
  for (const m of text.matchAll(DECISION_ID_RE)) {
    const id = m[0];
    if (m[1] === 'page' && ctx.db.get('SELECT 1 AS x FROM pages WHERE site_id = ? AND id = ?', [ctx.siteId, id])) add({ subjectType: 'page', subjectId: id });
    if (m[1] === 'opp' && ctx.db.get('SELECT 1 AS x FROM opportunities WHERE site_id = ? AND id = ?', [ctx.siteId, id])) add({ subjectType: 'opportunity', subjectId: id });
  }
  return out.size ? [...out.values()] : [{ subjectType: 'site', subjectId: ctx.siteId }];
}

/**
 * Import the "## Decisions" entries of a validated owner_decisions note into
 * `decisions` (decided_by 'owner', vault_path = the note). Idempotent per note
 * revision: row ids are derived from (site, note, date, text, subject), so
 * re-importing the same content changes nothing; entries the owner removed
 * from the note are withdrawn (deleted) and audited. These rows are owner
 * knowledge: they can only EXCLUDE a candidate from recommendations (a
 * rejecting decision such as "- 2026-09-01: reject https://example.com/page:
 * reason"), never authorize an action.
 */
export function syncOwnerDecisions(ctx: AppContext, note: { relPath: string; contentHash: string; data: Record<string, unknown> }, opts: { actor: string; revision: number | null }): OwnerDecisionSync {
  const parsed = ownerDecisionsSchema.parse(note.data);
  const desired: Array<{ id: string; subjectType: string; subjectId: string; decision: string; date: string }> = [];
  let siteWide = 0;
  for (const d of parsed.decisions) {
    for (const s of resolveDecisionSubjects(ctx, d.text)) {
      if (s.subjectType === 'site') siteWide++;
      const id = `dec_own_${hashObject({ site: ctx.siteId, note: note.relPath, date: d.date, text: d.text, subject: s }).slice(0, 26)}`;
      if (!desired.some((x) => x.id === id)) desired.push({ id, subjectType: s.subjectType, subjectId: s.subjectId, decision: d.text, date: d.date });
    }
  }
  const now = ctx.clock.now();
  return ctx.db.transaction(() => {
    let inserted = 0;
    for (const d of desired) {
      const changes = ctx.db.run(
        `INSERT OR IGNORE INTO decisions (id, site_id, subject_type, subject_id, decision, reason, decided_by, decided_at, vault_path) VALUES (?, ?, ?, ?, ?, ?, 'owner', ?, ?)`,
        [d.id, ctx.siteId, d.subjectType, d.subjectId, d.decision, `Standing owner decision recorded in ${note.relPath}${opts.revision ? ` (revision ${opts.revision})` : ''}.`, `${d.date}T00:00:00.000Z`, note.relPath],
      ).changes;
      if (changes) {
        inserted++;
        recordAudit(ctx.db, { siteId: ctx.siteId, actor: opts.actor, eventType: 'vault.owner_decision_imported', subjectType: 'decision', subjectId: d.id, details: { notePath: note.relPath, subjectType: d.subjectType, subjectId: d.subjectId, date: d.date, revision: opts.revision }, at: now });
      }
    }
    const keep = new Set(desired.map((d) => d.id));
    const stale = ctx.db
      .all<{ id: string; subject_type: string; subject_id: string; decision: string }>(`SELECT id, subject_type, subject_id, decision FROM decisions WHERE site_id = ? AND vault_path = ? AND decided_by = 'owner'`, [ctx.siteId, note.relPath])
      .filter((r) => !keep.has(r.id));
    for (const r of stale) {
      ctx.db.run('DELETE FROM decisions WHERE site_id = ? AND id = ?', [ctx.siteId, r.id]);
      recordAudit(ctx.db, { siteId: ctx.siteId, actor: opts.actor, eventType: 'vault.owner_decision_withdrawn', subjectType: 'decision', subjectId: r.id, details: { notePath: note.relPath, subjectType: r.subject_type, subjectId: r.subject_id, decision: r.decision, revision: opts.revision }, at: now });
    }
    return { rows: desired.length, inserted, withdrawn: stale.length, siteWide };
  });
}

/**
 * Validate every note in 01 Business and show the config diff of the business
 * profile. With `apply`, record new versions in business_note_versions
 * (rejected notes are recorded with their errors). Never changes the config.
 */
export function importBusinessNotes(ctx: AppContext, opts: { vaultDir?: string; apply?: boolean; actor?: string; dryRun?: boolean } = {}): BusinessImportResult {
  const vaultDir = opts.vaultDir ?? siteVaultDir(ctx.paths, ctx.siteId);
  const apply = !!opts.apply;
  const dryRun = opts.dryRun ?? ctx.dryRun;
  const actor = opts.actor ?? 'cli';
  const now = ctx.clock.now().toISOString();
  const parsed = parseAll(ctx, vaultDir);
  const { config } = currentConfig(ctx);
  let profile: BusinessImportResult['profile'] = null;
  const items: BusinessNoteImportItem[] = [];
  let recorded = 0;
  let rejected = 0;

  for (const p of parsed) {
    let configChanges: string[] = [];
    let hasChanges = false;
    if (p.valid && p.noteType === 'business_profile' && p.data) {
      const diff = diffBusinessProfile(businessProfileSchema.parse(p.data), config);
      configChanges = diff.lines;
      hasChanges = diff.changes.length > 0;
      profile = { relPath: p.relPath, contentHash: p.contentHash, lines: diff.lines, changes: diff.changes, diffHash: diffHashFor(ctx.siteId, p.relPath, p.contentHash, config, diff.changes) };
    }
    const status: 'imported' | 'rejected' | 'pending_review' = !p.valid ? 'rejected' : hasChanges ? 'pending_review' : 'imported';
    if (!p.valid) rejected++;
    const { data, ...rest } = p;
    const existing = p.contentHash
      ? ctx.db.get<VersionRow>('SELECT * FROM business_note_versions WHERE site_id = ? AND note_path = ? AND content_hash = ?', [ctx.siteId, p.relPath, p.contentHash])
      : undefined;
    const latest = latestRecorded(ctx, p.relPath);
    // Recorded content is trusted only while it matches the site config: re-derive the profile status on every recording.
    const refreshStatus = (row: VersionRow): VersionRow['status'] => {
      if (row.status === 'rejected' || !p.valid || p.noteType !== 'business_profile' || row.status === status) return row.status;
      ctx.db.run('UPDATE business_note_versions SET status = ? WHERE site_id = ? AND id = ?', [status, ctx.siteId, row.id]);
      recordAudit(ctx.db, {
        siteId: ctx.siteId,
        actor,
        eventType: 'vault.business_note_status_changed',
        subjectType: 'business_note_version',
        subjectId: row.id,
        details: { notePath: p.relPath, version: row.version, from: row.status, to: status, reason: status === 'pending_review' ? 'the site config differs from this content' : 'the site config matches this content' },
        at: ctx.clock.now(),
      });
      return status;
    };
    // Owner decisions of a valid, recorded owner_decisions note are synced into `decisions` (idempotent).
    const syncDecisions = (revision: number | null): { ownerDecisions?: OwnerDecisionSync } =>
      apply && !dryRun && p.valid && p.noteType === 'owner_decisions' && p.data
        ? { ownerDecisions: syncOwnerDecisions(ctx, { relPath: p.relPath, contentHash: p.contentHash, data: p.data }, { actor, revision }) }
        : {};
    if (existing && latest?.contentHash === p.contentHash) {
      const recordedStatus = apply && !dryRun ? ctx.db.transaction(() => refreshStatus(existing)) : existing.status;
      items.push({ ...rest, status: 'already_recorded', recordedStatus, versionId: existing.id, version: existing.version, revision: latest.revision, returnsToVersion: null, configChanges, ...syncDecisions(latest.revision) });
      continue;
    }
    if (!apply || dryRun || !p.contentHash) {
      items.push({ ...rest, status: p.valid ? 'new' : 'rejected', recordedStatus: null, versionId: existing?.id ?? null, version: existing?.version ?? null, revision: null, returnsToVersion: existing?.version ?? null, configChanges });
      continue;
    }
    if (existing) {
      // The note returned to content recorded earlier (A -> B -> A): a new revision of the existing version.
      const { revision, recordedStatus } = ctx.db.transaction(() => {
        const rev = insertRevision(ctx, p.relPath, existing.id, p.contentHash, actor, now);
        const st = refreshStatus(existing);
        recordAudit(ctx.db, {
          siteId: ctx.siteId,
          actor,
          eventType: p.valid ? 'vault.business_note_recorded' : 'vault.business_note_rejected',
          subjectType: 'business_note_version',
          subjectId: existing.id,
          details: { notePath: p.relPath, version: existing.version, revision: rev.revision, returnsToVersion: existing.version, status: st, errors: p.errors.slice(0, 20), ignoredAuthorityKeys: p.ignoredAuthorityKeys },
          at: ctx.clock.now(),
        });
        return { revision: rev.revision, recordedStatus: st };
      });
      recorded++;
      items.push({ ...rest, status: p.valid ? 'recorded' : 'rejected', recordedStatus, versionId: existing.id, version: existing.version, revision, returnsToVersion: existing.version, configChanges, ...syncDecisions(revision) });
      continue;
    }
    const id = newId('bnv');
    const { version, revision } = ctx.db.transaction(() => {
      const max = ctx.db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM business_note_versions WHERE site_id = ? AND note_path = ?', [ctx.siteId, p.relPath]);
      const v = (max?.v ?? 0) + 1;
      const revisionNumber = nextRevisionNumber(ctx, p.relPath);
      ctx.db.run(
        `INSERT INTO business_note_versions (id, site_id, note_path, content_hash, parsed_json, status, validation_errors_json, imported_at, note_type, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          ctx.siteId,
          p.relPath,
          p.contentHash,
          p.valid ? JSON.stringify({ type: p.noteType, id: p.noteId, data, ignoredAuthorityKeys: p.ignoredAuthorityKeys, warnings: p.warnings, provenance: { folder: BUSINESS_FOLDER, generatedBySeoAgent: false } }) : null,
          status,
          p.errors.length ? JSON.stringify(p.errors) : null,
          now,
          p.noteType,
          v,
        ],
      );
      recordAudit(ctx.db, {
        siteId: ctx.siteId,
        actor,
        eventType: p.valid ? 'vault.business_note_recorded' : 'vault.business_note_rejected',
        subjectType: 'business_note_version',
        subjectId: id,
        details: { notePath: p.relPath, version: v, status, errors: p.errors.slice(0, 20), ignoredAuthorityKeys: p.ignoredAuthorityKeys },
        at: ctx.clock.now(),
      });
      const rev = insertRevision(ctx, p.relPath, id, p.contentHash, actor, now, revisionNumber);
      return { version: v, revision: rev.revision };
    });
    recorded++;
    items.push({ ...rest, status: p.valid ? 'recorded' : 'rejected', recordedStatus: status, versionId: id, version, revision, returnsToVersion: null, configChanges, ...syncDecisions(revision) });
  }

  const pendingProfile = profile && profile.changes.length > 0;
  const nextStep = !parsed.length
    ? `No notes found in ${BUSINESS_FOLDER}/. Run \`npm run cli -- vault init\` to create the templates.`
    : rejected
      ? 'Fix the listed errors in the rejected notes, then run `vault import-business` again.'
      : !apply
        ? 'Review the diff, then run `npm run cli -- vault import-business --apply` to record these versions.'
        : pendingProfile
          ? 'Run `npm run cli -- vault apply-business` to review the config diff, then confirm with `--confirm <diff-hash>`.'
          : 'Business notes are recorded. The site config already matches the business profile.';
  return { vaultDir, apply, dryRun, notes: items, profile, recorded, rejected, nextStep };
}

// ---------------------------------------------------------------- apply to config

export interface ApplyBusinessResult {
  status: 'no_changes' | 'confirmation_required' | 'would_apply' | 'applied';
  relPath: string;
  versionId: string;
  version: number | null;
  diffHash: string;
  lines: string[];
  changes: ConfigChange[];
  configVersion?: number;
  configChanged?: boolean;
  backupFile?: string;
  nextStep: string;
}

/** Set a nested key in a YAML document, creating intermediate maps. Comments elsewhere are preserved. */
function setYaml(doc: ReturnType<typeof parseDocument>, keys: string[], value: unknown): void {
  doc.setIn(keys, doc.createNode(value));
}

/**
 * Apply the current, recorded business profile to the site config. Without
 * `confirmHash` it only returns the diff and its hash. With a matching hash it
 * writes the YAML config atomically (backup first) and records a config
 * version with source 'business_note_sync'. Frontmatter can never trigger this.
 */
export function applyBusinessProfile(ctx: AppContext, opts: { vaultDir?: string; confirmHash?: string; actor?: string; dryRun?: boolean; log?: (line: string) => void } = {}): ApplyBusinessResult {
  const vaultDir = opts.vaultDir ?? siteVaultDir(ctx.paths, ctx.siteId);
  const dryRun = opts.dryRun ?? ctx.dryRun;
  const actor = opts.actor ?? 'cli';
  const parsed = parseAll(ctx, vaultDir).filter((p) => p.noteType === 'business_profile' || p.relPath.endsWith('Business Profile.md'));
  const invalid = parsed.filter((p) => !p.valid);
  const valid = parsed.filter((p) => p.valid && p.noteType === 'business_profile');
  if (!valid.length) {
    if (invalid.length) throw new ValidationError('The business profile note is invalid; nothing can be applied.', { errors: invalid.flatMap((p) => p.errors.map((e) => `${p.relPath}: ${e}`)) });
    throw new AppError('NOT_FOUND', `No business_profile note found in ${BUSINESS_FOLDER}/.`, { hint: 'Run `npm run cli -- vault init` to create "01 Business/Business Profile.md".' });
  }
  const note = valid[0]!;
  const row = ctx.db.get<VersionRow>('SELECT * FROM business_note_versions WHERE site_id = ? AND note_path = ? AND content_hash = ?', [ctx.siteId, note.relPath, note.contentHash]);
  if (!row) {
    throw new AppError('VALIDATION_FAILED', `The current content of ${note.relPath} has not been recorded yet.`, { hint: 'Run `npm run cli -- vault import-business --apply` first, then review the diff here.' });
  }
  const latest = latestRecorded(ctx, note.relPath);
  if (!latest || latest.contentHash !== note.contentHash) {
    throw new AppError('VALIDATION_FAILED', `${note.relPath} returned to the content of version ${row.version ?? '?'}, but that change has not been recorded yet.`, {
      hint: 'Run `npm run cli -- vault import-business --apply` first, then review the diff here.',
    });
  }
  if (row.status === 'rejected') throw new ValidationError(`Version ${row.version ?? '?'} of ${note.relPath} was rejected during import.`, { errors: JSON.parse(row.validation_errors_json ?? '[]') as string[] });
  const { config, file, text } = currentConfig(ctx);
  const diff = diffBusinessProfile(businessProfileSchema.parse(note.data), config);
  const diffHash = diffHashFor(ctx.siteId, note.relPath, note.contentHash, config, diff.changes);
  const base = { relPath: note.relPath, versionId: row.id, version: row.version, diffHash, lines: diff.lines, changes: diff.changes };
  if (!diff.changes.length) {
    if (row.status === 'pending_review' && !dryRun) ctx.db.run("UPDATE business_note_versions SET status = 'imported' WHERE site_id = ? AND id = ?", [ctx.siteId, row.id]);
    return { ...base, status: 'no_changes', nextStep: 'The site config already matches the business profile.' };
  }
  if (!opts.confirmHash) {
    return { ...base, status: 'confirmation_required', nextStep: `Review the diff. To write it to the site config, run: npm run cli -- vault apply-business --confirm ${diffHash}` };
  }
  if (opts.confirmHash !== diffHash) {
    throw new AppError('APPROVAL_INVALID', 'The confirmation hash does not match the current diff (the note or the config changed since it was reviewed).', {
      hint: 'Run `npm run cli -- vault apply-business` again, review the new diff, and confirm its hash.',
    });
  }
  if (dryRun) return { ...base, status: 'would_apply', nextStep: 'Dry run: nothing was written.' };

  // Build the new YAML text: edit only the affected keys so comments elsewhere survive.
  const doc = parseDocument(text, { schema: 'core', uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length) throw new AppError('CONFIG_INVALID', `Cannot edit ${file}: ${doc.errors[0]!.message}`);
  const next = diff.nextConfig;
  const touched = new Set(diff.changes.map((c) => c.path.replace(/\[.*$/, '')));
  if (touched.has('business.offer')) setYaml(doc, ['business', 'offer'], next.business.offer);
  if (touched.has('business.targetCustomer')) setYaml(doc, ['business', 'targetCustomer'], next.business.targetCustomer);
  if (touched.has('business.differentiators')) setYaml(doc, ['business', 'differentiators'], next.business.differentiators);
  if (touched.has('business.approvedClaims')) setYaml(doc, ['business', 'approvedClaims'], next.business.approvedClaims);
  if (touched.has('business.prohibitedClaims')) setYaml(doc, ['business', 'prohibitedClaims'], next.business.prohibitedClaims);
  if (touched.has('business.productFacts')) setYaml(doc, ['business', 'productFacts'], next.business.productFacts);
  if (touched.has('editorial.brandVoice')) setYaml(doc, ['editorial', 'brandVoice'], next.editorial.brandVoice);
  if (touched.has('editorial.requirements')) setYaml(doc, ['editorial', 'requirements'], next.editorial.requirements);
  const newText = doc.toString();
  const reparsed = parseSiteConfig(parseYamlSafe(newText, file));
  const expected = parseSiteConfig(next);
  if (hashObject(reparsed) !== hashObject(expected)) {
    throw new AppError('INTERNAL', 'The edited config does not round-trip to the reviewed values; nothing was written.');
  }

  const stamp = ctx.clock.now().toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
  mkdirSync(path.join(ctx.paths.backupsDir, 'config'), { recursive: true, mode: 0o700 });
  const backupDir = path.join(ctx.paths.backupsDir, 'config');
  let backupFile = safeResolve(backupDir, `${ctx.siteId}.${stamp}.yaml`);
  for (let n = 2; existsSync(backupFile); n++) backupFile = safeResolve(backupDir, `${ctx.siteId}.${stamp}-${n}.yaml`);
  atomicWriteFile(backupFile, text, { noOverwrite: true, mode: 0o600 });
  atomicWriteFile(file, newText, { expectedCurrent: text, mode: 0o600 });
  const site = ensureSite(ctx.db, reparsed, { source: 'business_note_sync', now: ctx.clock.now() });
  const at = ctx.clock.now().toISOString();
  ctx.db.transaction(() => {
    // Every application is kept (append-only); the version row holds the latest one.
    ctx.db.run(
      `INSERT INTO business_profile_applications (id, site_id, version_id, revision_id, note_path, content_hash, diff_hash, config_version, config_changed, changes_json, applied_at, applied_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId('bpa'), ctx.siteId, row.id, latest.revisionId, note.relPath, note.contentHash, diffHash, site.configVersion, site.configChanged ? 1 : 0, JSON.stringify(diff.lines.slice(0, 200)), at, actor],
    );
    ctx.db.run("UPDATE business_note_versions SET status = 'imported', applied_config_version = ?, applied_at = ?, applied_by = ? WHERE site_id = ? AND id = ?", [site.configVersion, at, actor, ctx.siteId, row.id]);
  });
  recordAudit(ctx.db, {
    siteId: ctx.siteId,
    actor,
    eventType: 'config.business_note_sync',
    subjectType: 'business_note_version',
    subjectId: row.id,
    details: { notePath: note.relPath, version: row.version, diffHash, configVersion: site.configVersion, changes: diff.lines.slice(0, 50), backupFile },
    at: ctx.clock.now(),
  });
  opts.log?.(`Business profile ${note.relPath} v${row.version ?? '?'} applied to the site config (config version ${site.configVersion}, diff ${diffHash.slice(0, 12)}).`);
  return {
    ...base,
    status: 'applied',
    configVersion: site.configVersion,
    configChanged: site.configChanged,
    backupFile,
    nextStep: `Site config updated (config version ${site.configVersion}${site.configChanged ? '' : ', identical to an earlier recorded config version, which is active again'}). Previous config saved to ${backupFile}.`,
  };
}

// ---------------------------------------------------------------- history and trust

export interface BusinessNoteVersionView {
  id: string;
  notePath: string;
  noteType: string | null;
  version: number | null;
  status: string;
  contentHash: string;
  importedAt: string;
  /** Latest application to the site config (see `applications` for all of them). */
  appliedConfigVersion: number | null;
  appliedAt: string | null;
  appliedBy: string | null;
  errors: string[];
  trustClass: TrustClass | null;
  /** Revisions (recordings) at which the note had this content, oldest first. */
  revisions: number[];
  /** True when this is the content most recently recorded for the note. */
  current: boolean;
  /** Every confirmed application of this version, oldest first. */
  applications: Array<{ configVersion: number; configChanged: boolean; appliedAt: string; appliedBy: string; diffHash: string }>;
}

/**
 * Trust derives from code-checked provenance (human folder, not generated,
 * explicit CLI import, and for the profile an explicit apply), never from
 * note properties.
 */
export function businessNoteTrustClass(row: { status: string; note_type: string | null }): TrustClass | null {
  if (row.status === 'rejected') return null;
  if (row.status === 'pending_review') return 'user_reported';
  return 'owner_approved';
}

export function listBusinessNoteVersions(ctx: AppContext, notePath?: string): BusinessNoteVersionView[] {
  const rows = notePath
    ? ctx.db.all<VersionRow>('SELECT * FROM business_note_versions WHERE site_id = ? AND note_path = ? ORDER BY note_path, version, imported_at', [ctx.siteId, notePath])
    : ctx.db.all<VersionRow>('SELECT * FROM business_note_versions WHERE site_id = ? ORDER BY note_path, version, imported_at', [ctx.siteId]);
  const latestByPath = new Map<string, string | null>();
  return rows.map((r) => {
    if (!latestByPath.has(r.note_path)) latestByPath.set(r.note_path, latestRecorded(ctx, r.note_path)?.contentHash ?? null);
    const revisions = ctx.db.all<{ revision: number }>('SELECT revision FROM business_note_revisions WHERE site_id = ? AND version_id = ? ORDER BY revision', [ctx.siteId, r.id]).map((x) => x.revision);
    const applications = ctx.db
      .all<{ config_version: number; config_changed: number; applied_at: string; applied_by: string; diff_hash: string }>(
        'SELECT config_version, config_changed, applied_at, applied_by, diff_hash FROM business_profile_applications WHERE site_id = ? AND version_id = ? ORDER BY applied_at, rowid',
        [ctx.siteId, r.id],
      )
      .map((a) => ({ configVersion: a.config_version, configChanged: a.config_changed === 1, appliedAt: a.applied_at, appliedBy: a.applied_by, diffHash: a.diff_hash }));
    return {
      id: r.id,
      notePath: r.note_path,
      noteType: r.note_type,
      version: r.version,
      status: r.status,
      contentHash: r.content_hash,
      importedAt: r.imported_at,
      appliedConfigVersion: r.applied_config_version,
      appliedAt: r.applied_at,
      appliedBy: r.applied_by,
      errors: r.validation_errors_json ? (JSON.parse(r.validation_errors_json) as string[]) : [],
      trustClass: businessNoteTrustClass(r),
      revisions,
      current: latestByPath.get(r.note_path) === r.content_hash,
      applications,
    };
  });
}
