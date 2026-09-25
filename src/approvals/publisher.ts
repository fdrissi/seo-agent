import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Clock } from '../core/clock.js';
import { AppError } from '../core/errors.js';
import { sha256 } from '../core/hash.js';
import { newId, slugify } from '../core/ids.js';
import { dateInZone } from '../core/time.js';
import { safeResolve } from '../security/paths.js';
import { ARTIFACT_HASH_VERSION, canonicalChange, computeArtifactHash, hashPrefix, shortRef } from './artifact.js';
import type { ContentChange } from './change.js';
import { unifiedDiff } from './diff.js';
import { comparableText } from './html.js';
import { markdownToHtml, escapeHtml } from './markdown.js';
import type { TargetRecheck } from './target-check.js';
import type { ApprovalActionType, ApprovalRecord } from './types.js';

/**
 * Publisher interface (spec section 24).
 *
 * v1 ships exactly ONE complete publisher: ManualExportPublisher. It writes a
 * reviewable export package that a human deploys; it never touches a
 * production system itself. CMS-specific draft adapters or Git-patch
 * adapters are to be implemented only after the actual platform is
 * configured; `createPublisher` throws INTEGRATION_UNAVAILABLE for them
 * instead of pretending. There are deliberately no WordPress/Webflow/generic
 * CMS adapters here.
 */

export type PublisherKind = 'manual_export' | 'git_patch' | 'cms_adapter';
export type ProposalSubjectType = 'draft' | 'recommendation' | 'experiment';

export interface CurrentState {
  /** Where the "current" values came from, e.g. `crawl_result:<id>`; null when unavailable. */
  snapshotRef: string | null;
  capturedAt: string | null;
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  robots: string | null;
  text: string | null;
  note: string | null;
}

/**
 * Drafts only: a named human's recorded acceptance of the EXACT draft body
 * (`content mark-reviewed`, stored as the draft's latest quality review).
 * Automated verdicts never count. Not part of the artifact hash: the approval
 * binds the change, this records that a human reviewed its body.
 */
export interface DraftHumanReview {
  accepted: boolean;
  reviewer: string | null;
  /** quality_reviews id of the human acceptance (null when none applies). */
  reviewId: string | null;
  reviewedAt: string | null;
  /** SHA-256 of the draft body this proposal exports (what the reviewer must have accepted). */
  bodyHash: string;
  /** Why the draft does not count as human-accepted (null when accepted). */
  reason: string | null;
}

export interface PublishProposal {
  siteId: string;
  subjectType: ProposalSubjectType;
  subjectId: string;
  actionType: ApprovalActionType;
  /** False for records that change nothing in production (e.g. a no-action recommendation). */
  productionBound: boolean;
  targetUrl: string;
  pageId: string | null;
  /** Human title of the subject (used for the package name). */
  title: string;
  summary: string;
  change: ContentChange;
  current: CurrentState;
  rollbackPlan: string;
  /** Extra reviewer context (hypothesis, evidence ids, source ledger, fact-check notes...). Not part of the artifact hash. */
  context: Record<string, unknown>;
  isSynthetic: boolean;
  warnings: string[];
  /** Drafts only: the recorded human acceptance of the exact body (see DraftHumanReview). */
  humanReview?: DraftHumanReview | null;
}

/**
 * Why a production-bound draft proposal may not be exported: human review is
 * required for publication IN ADDITION to the approval (spec sections 22 and
 * 24). Null when nothing blocks (or the proposal is not a production-bound draft).
 */
export function draftHumanReviewBlocker(p: Pick<PublishProposal, 'subjectType' | 'productionBound' | 'humanReview'>): string | null {
  if (p.subjectType !== 'draft' || !p.productionBound) return null;
  const hr = p.humanReview;
  if (!hr) return 'no human review record was resolved for this draft';
  if (!hr.accepted) return hr.reason ?? 'no named human accepted this exact draft body';
  return null;
}

/** Throws POLICY_DENIED (with the next step) when a production-bound draft lacks a recorded human acceptance. */
export function assertDraftHumanAccepted(p: Pick<PublishProposal, 'subjectType' | 'subjectId' | 'productionBound' | 'humanReview'>): void {
  const blocker = draftHumanReviewBlocker(p);
  if (!blocker) return;
  const prefix = p.humanReview?.bodyHash ? p.humanReview.bodyHash.slice(0, 12) : '<body-hash prefix>';
  throw new AppError(
    'POLICY_DENIED',
    `Export of draft ${p.subjectId} is refused: ${blocker}. A production-bound draft needs a named human's recorded acceptance of its exact body in addition to a valid approval; automated quality verdicts never count.`,
    {
      details: { reason: 'human_review_required', draftId: p.subjectId, bodyHash: p.humanReview?.bodyHash ?? null, reviewId: p.humanReview?.reviewId ?? null },
      hint: `Read the draft, then record your acceptance of this exact body: \`content mark-reviewed ${p.subjectId} --as "<your name>" --confirm ${prefix}\`. Then re-run the export (the approval stays valid: acceptance does not change the artifact).`,
    },
  );
}

export interface PreparedFile {
  path: string;
  content: string;
}

export interface PreparedArtifact {
  kind: PublisherKind;
  proposal: PublishProposal;
  artifactHash: string;
  files: PreparedFile[];
}

export interface ApprovedPublication {
  artifact: PreparedArtifact;
  /** Null only for non-production exports. */
  approval: ApprovalRecord | null;
  recheck: TargetRecheck | null;
  allowUnverifiedTarget: boolean;
  actor: string;
}

export interface PublishResult {
  kind: PublisherKind;
  status: 'exported';
  /** Manual export never changes production; a human deploys the package. */
  liveChange: false;
  exportDir: string;
  files: string[];
  artifactHash: string;
  approvalId: string | null;
  warnings: string[];
}

export interface Publisher {
  readonly kind: PublisherKind;
  /** Build the exact artifact (and its hash) for review and approval. Pure: no writes. */
  prepare(proposal: PublishProposal): PreparedArtifact;
  /** Execute an approved artifact. */
  publish(approved: ApprovedPublication): Promise<PublishResult>;
}

/** Artifact hash of a proposal: exactly what would go live at the target. */
export function proposalArtifactHash(p: Pick<PublishProposal, 'actionType' | 'targetUrl' | 'change'>): string {
  return computeArtifactHash({ actionType: p.actionType, target: p.targetUrl, change: canonicalChange(p.change as Record<string, unknown>) });
}

/** Specific credential shapes (API keys, tokens, private keys, credentials in URLs). Content is flagged, never altered. */
const CREDENTIAL_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bya29\.[A-Za-z0-9._-]{10,}/,
  /\bGOCSPX-[A-Za-z0-9_-]{10,}/,
  /\bapify_api_[A-Za-z0-9]{20,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/,
  /[?&](api_key|apikey|access_token|refresh_token|client_secret|password)=[^&\s"']{6,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
];

export function looksLikeCredential(text: string): boolean {
  return CREDENTIAL_SHAPES.some((re) => re.test(text));
}

function sentences(text: string): string {
  const t = text.replace(/\r\n?/g, '\n');
  if (t.includes('\n')) return t;
  return t.split(/(?<=[.!?])\s+/).join('\n');
}

function mdCell(v: string | null | undefined): string {
  return v === null || v === undefined || v === '' ? '_(none)_' : v.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export interface ManualExportOptions {
  exportsDir: string;
  siteId: string;
  timeZone: string;
  clock: Clock;
  /** Command prefix shown in the checklist. */
  cliPrefix?: string;
}

export class ManualExportPublisher implements Publisher {
  readonly kind = 'manual_export' as const;

  constructor(private readonly opts: ManualExportOptions) {}

  prepare(p: PublishProposal): PreparedArtifact {
    if (p.siteId !== this.opts.siteId) throw new AppError('VALIDATION_FAILED', `Proposal belongs to site ${p.siteId}, publisher to ${this.opts.siteId}.`);
    const artifactHash = proposalArtifactHash(p);
    const c = p.change;
    const files: PreparedFile[] = [];
    const warnings = [...p.warnings];
    const credentialLike = [c.bodyMarkdown, c.title, c.metaDescription, c.instructions].some((v) => typeof v === 'string' && looksLikeCredential(v));
    if (credentialLike) warnings.push('Content contains a credential-like pattern (e.g. an API key or token shape). Review before publishing; it was not altered.');

    // content.md / content.html
    if (c.bodyMarkdown) {
      files.push({ path: 'content.md', content: `${c.bodyMarkdown.trim()}\n` });
      files.push({
        path: 'content.html',
        content: `<!-- HTML-ready conversion of content.md (headings, paragraphs, lists, links, emphasis, code). Review before pasting into your CMS. -->\n${markdownToHtml(c.bodyMarkdown)}\n`,
      });
    } else {
      files.push({
        path: 'content.md',
        content: [`# Change for ${p.targetUrl}`, '', c.instructions ? `## Exact change\n\n${c.instructions}\n` : '', '(This change has no body content; see metadata.json and diff.md.)', ''].join('\n'),
      });
    }
    const head: string[] = [];
    if (c.title) head.push(`<title>${escapeHtml(c.title)}</title>`);
    if (c.metaDescription) head.push(`<meta name="description" content="${escapeHtml(c.metaDescription)}">`);
    if (c.canonical) head.push(`<link rel="canonical" href="${escapeHtml(c.canonical)}">`);
    if (c.robots) head.push(`<meta name="robots" content="${escapeHtml(c.robots)}">`);
    if (c.structuredData !== undefined) head.push(`<script type="application/ld+json">\n${JSON.stringify(c.structuredData, null, 2).replace(/</g, '\\u003c')}\n</script>`);
    if (head.length) files.push({ path: 'head-snippet.html', content: `<!-- Proposed <head> elements for ${escapeHtml(p.targetUrl)} -->\n${head.join('\n')}\n` });

    // metadata.json
    files.push({
      path: 'metadata.json',
      content: `${JSON.stringify(
        {
          generator: 'seo-agent manual export',
          isSynthetic: p.isSynthetic,
          siteId: p.siteId,
          subject: { type: p.subjectType, id: p.subjectId, title: p.title },
          actionType: p.actionType,
          productionBound: p.productionBound,
          targetUrl: p.targetUrl,
          pageId: p.pageId,
          change: canonicalChange(c as Record<string, unknown>),
          artifactHash,
          artifactHashVersion: ARTIFACT_HASH_VERSION,
          context: p.context,
          ...(p.humanReview ? { humanReview: p.humanReview } : {}),
          warnings,
        },
        null,
        2,
      )}\n`,
    });

    // diff.md
    const cur = p.current;
    const fieldRows: Array<[string, string | null, string | undefined]> = [
      ['title', cur.title, c.title],
      ['meta description', cur.metaDescription, c.metaDescription],
      ['canonical', cur.canonical, c.canonical],
      ['robots', cur.robots, c.robots],
      ['redirect to', null, c.redirectTo],
    ];
    const diffLines = [
      `# Diff vs current: ${p.targetUrl}`,
      '',
      cur.snapshotRef ? `Current state from ${cur.snapshotRef} captured ${cur.capturedAt ?? 'at an unknown time'}.` : `Current state UNAVAILABLE${cur.note ? `: ${cur.note}` : ''}. Capture the live page before implementing so the change can be rolled back.`,
      '',
      '| field | current | proposed |',
      '| --- | --- | --- |',
      ...fieldRows.filter(([, a, b]) => a !== null || b !== undefined).map(([f, a, b]) => `| ${f} | ${mdCell(a)} | ${b === undefined ? '_(unchanged)_' : mdCell(b)} |`),
      '',
    ];
    if (c.bodyMarkdown) {
      if (cur.text) {
        const d = unifiedDiff(sentences(cur.text), sentences(comparableText(c.bodyMarkdown)), { fromLabel: 'current visible text', toLabel: 'proposed text' });
        diffLines.push('## Text diff (sentence level; visible page text vs proposed Markdown text, formatting ignored)', '', '```diff', d.unified.trimEnd(), '```', '');
      } else diffLines.push('## Text diff', '', 'No current page text is available (new page or no crawl snapshot); the full proposed content is new.', '');
    }
    if (c.instructions) diffLines.push('## Exact change (as approved)', '', c.instructions, '');
    files.push({ path: 'diff.md', content: `${diffLines.join('\n')}\n` });

    // rollback
    const rollback = {
      targetUrl: p.targetUrl,
      actionType: p.actionType,
      plan: p.rollbackPlan,
      previous: { snapshotRef: cur.snapshotRef, capturedAt: cur.capturedAt, title: cur.title, metaDescription: cur.metaDescription, canonical: cur.canonical, robots: cur.robots },
      previousAvailable: !!cur.snapshotRef,
      note: cur.snapshotRef ? 'Restore the previous values above (and the page text from the snapshot) to roll back.' : 'No before-snapshot exists. Save a copy of the live page before implementing; rollback depends on it.',
    };
    files.push({ path: 'rollback.json', content: `${JSON.stringify(rollback, null, 2)}\n` });
    files.push({
      path: 'rollback.md',
      content: [
        `# Rollback: ${p.targetUrl}`,
        '',
        `Plan: ${p.rollbackPlan}`,
        '',
        '| field | value before the change |',
        '| --- | --- |',
        `| title | ${mdCell(cur.title)} |`,
        `| meta description | ${mdCell(cur.metaDescription)} |`,
        `| canonical | ${mdCell(cur.canonical)} |`,
        `| robots | ${mdCell(cur.robots)} |`,
        `| snapshot | ${mdCell(cur.snapshotRef)} |`,
        '',
        rollback.note,
        '',
        'A rollback of a production page is itself a production change: record it with `experiments annotate` so measurements are flagged.',
        '',
      ].join('\n'),
    });

    // checklist
    const cli = this.opts.cliPrefix ?? 'npm run cli --';
    files.push({
      path: 'checklist.md',
      content: [
        `# Implementation checklist: ${p.title}`,
        '',
        `- [ ] Review content.md${c.bodyMarkdown ? ' / content.html' : ''}${head.length ? ' / head-snippet.html' : ''} and diff.md against the live page ${p.targetUrl}`,
        ...warnings.map((w) => `- [ ] Resolve warning: ${w}`),
        cur.snapshotRef ? '- [ ] Keep rollback.md at hand' : '- [ ] Save a copy of the current live page first (no before-snapshot was available)',
        `- [ ] Implement exactly this change (artifact ${hashPrefix(artifactHash)}...). Any edit means the approval no longer applies: request a new one.`,
        '- [ ] Note the deployment revision/commit and the actual time the change went live (with time zone)',
        `- [ ] Record it: \`${cli} experiments mark-implemented ${p.subjectId} --subject-type ${p.subjectType} --at <ISO time it went live> --revision <revision> --url ${p.targetUrl} --as <your name>\``,
        '- [ ] Do not make other changes to this page during the observation window; record unavoidable critical fixes with `experiments annotate --kind critical_fix`',
        '',
      ].join('\n'),
    });
    return { kind: this.kind, proposal: { ...p, warnings }, artifactHash, files };
  }

  /** Directory the package would be written to (not created). */
  plannedDir(artifact: PreparedArtifact): string {
    const base = safeResolve(this.opts.exportsDir, this.opts.siteId);
    const date = dateInZone(this.opts.clock.now(), this.opts.timeZone);
    const name = `${date}-${slugify(`${artifact.proposal.subjectType}-${artifact.proposal.title}`, 60)}`;
    let candidate = safeResolve(base, name);
    for (let i = 2; existsSync(candidate); i++) candidate = safeResolve(base, `${name}-${i}`);
    return candidate;
  }

  /**
   * Synchronous write so callers can consume the approval and write the
   * package in ONE database transaction: if writing fails, the approval stays
   * unexecuted. Writes into a temporary directory and renames atomically.
   */
  publishSync(approved: ApprovedPublication, targetDir?: string): PublishResult {
    const a = approved.artifact;
    if (a.kind !== this.kind) throw new AppError('VALIDATION_FAILED', `Artifact kind ${a.kind} cannot be published by ${this.kind}.`);
    const p = a.proposal;
    if (p.siteId !== this.opts.siteId) throw new AppError('VALIDATION_FAILED', 'Artifact belongs to another site.');
    if (proposalArtifactHash(p) !== a.artifactHash) throw new AppError('APPROVAL_INVALID', 'Artifact content does not match its hash.');
    if (p.productionBound) {
      const ap = approved.approval;
      if (!ap) throw new AppError('APPROVAL_REQUIRED', `A production-bound export needs an approval for artifact ${shortRef(a.artifactHash)}....`);
      if (ap.siteId !== p.siteId || ap.artifactHash !== a.artifactHash || ap.subjectType !== p.subjectType || ap.subjectId !== p.subjectId || ap.actionType !== p.actionType) {
        throw new AppError('APPROVAL_INVALID', `Approval ${ap.id} is not bound to this exact artifact.`);
      }
      if (ap.status !== 'approved' && ap.status !== 'executed') throw new AppError('APPROVAL_INVALID', `Approval ${ap.id} is ${ap.status}.`);
      // Drafts: the recorded human acceptance of the exact body is required as well (defense in depth; exportSubject checks first).
      assertDraftHumanAccepted(p);
    }
    const finalDir = targetDir ?? this.plannedDir(a);
    const base = safeResolve(this.opts.exportsDir, this.opts.siteId);
    if (path.dirname(finalDir) !== base) throw new AppError('UNSAFE_PATH', 'Export directory must be directly inside the site export folder.');
    if (existsSync(finalDir)) throw new AppError('CONFLICT', `Export directory already exists: ${finalDir}`);
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const tmp = safeResolve(base, `.tmp-${newId('exp')}`);
    mkdirSync(tmp, { mode: 0o700 });
    try {
      const readme = this.readme(approved, path.basename(finalDir));
      const all: PreparedFile[] = [{ path: 'README.md', content: readme }, ...a.files];
      for (const f of all) writeFileSync(safeResolve(tmp, f.path), f.content, { mode: 0o600 });
      const manifest = {
        generator: 'seo-agent manual export',
        generatedAt: this.opts.clock.now().toISOString(),
        siteId: p.siteId,
        subject: { type: p.subjectType, id: p.subjectId },
        actionType: p.actionType,
        targetUrl: p.targetUrl,
        artifactHash: a.artifactHash,
        approvalId: approved.approval?.id ?? null,
        approver: approved.approval?.approver ?? null,
        sourceRevisionAtApproval: approved.approval?.sourceRevision ?? null,
        targetRecheck: approved.recheck,
        allowUnverifiedTarget: approved.allowUnverifiedTarget,
        isSynthetic: p.isSynthetic,
        files: all.map((f) => ({ path: f.path, sha256: sha256(f.content), bytes: Buffer.byteLength(f.content) })),
      };
      writeFileSync(safeResolve(tmp, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, finalDir);
      return {
        kind: this.kind,
        status: 'exported',
        liveChange: false,
        exportDir: finalDir,
        files: [...all.map((f) => f.path), 'manifest.json'],
        artifactHash: a.artifactHash,
        approvalId: approved.approval?.id ?? null,
        warnings: p.warnings,
      };
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
  }

  async publish(approved: ApprovedPublication): Promise<PublishResult> {
    return this.publishSync(approved);
  }

  private readme(approved: ApprovedPublication, dirName: string): string {
    const a = approved.artifact;
    const p = a.proposal;
    const ap = approved.approval;
    const lines: Array<string | null> = [
      `# ${p.isSynthetic ? '[SYNTHETIC DEMO DATA] ' : ''}Export package: ${p.title}`,
      '',
      `Package: ${dirName}`,
      '',
      'This package was NOT published anywhere. A human deploys it and then records the real deployment with `experiments mark-implemented`.',
      '',
      `- Site: ${p.siteId}`,
      `- Subject: ${p.subjectType} ${p.subjectId}`,
      `- Action: ${p.actionType}${p.productionBound ? ' (production change)' : ' (no production change)'}`,
      `- Target: ${p.targetUrl}`,
      `- Artifact hash: ${a.artifactHash}`,
      ap ? `- Approval: ${ap.id}, approved by ${ap.approver ?? '?'} at ${ap.decidedAt ?? '?'}, expires ${ap.expiresAt}` : '- Approval: not required (no production change)',
      ap?.sourceRevision ? `- Source revision at approval: ${ap.sourceRevision}` : null,
      approved.recheck ? `- Target recheck before export: ${approved.recheck.status} (${approved.recheck.detail})` : null,
      approved.allowUnverifiedTarget && approved.recheck?.status !== 'unchanged' ? '- The target could NOT be rechecked; export proceeded because --allow-unverified-target was given (recorded).' : null,
      '',
      '## Summary',
      '',
      p.summary,
      '',
      ...(p.warnings.length ? ['## Warnings', '', ...p.warnings.map((w) => `- ${w}`), ''] : []),
      '## Files',
      '',
      '- content.md / content.html: the proposed content',
      '- head-snippet.html: proposed <head> elements (when applicable)',
      '- metadata.json: exact change, hashes, context',
      '- diff.md: current vs proposed',
      '- rollback.md / rollback.json: how to undo the change',
      '- checklist.md: implementation and recording steps',
      '- manifest.json: file hashes',
      '',
    ];
    return lines.filter((l): l is string => l !== null).join('\n');
  }
}

/**
 * Publisher factory. Only `manual_export` exists in v1. Every other kind is a
 * documented placeholder that throws INTEGRATION_UNAVAILABLE: a CMS draft or
 * Git patch adapter is built only after the owner's actual platform is
 * configured and its API verified (docs/modules/experiments-approvals.md).
 */
export function createPublisher(kind: string, opts: ManualExportOptions): Publisher {
  if (kind === 'manual_export') return new ManualExportPublisher(opts);
  throw new AppError('INTEGRATION_UNAVAILABLE', `No "${kind}" publisher is configured. Version 1 supports only the manual export workflow.`, {
    details: { kind, available: ['manual_export'] },
    hint: 'Use `export <subject-type> <id>` and deploy the package yourself, then run `experiments mark-implemented`. A CMS or Git adapter is implemented only once your actual platform is configured.',
  });
}
