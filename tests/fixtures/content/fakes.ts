/**
 * SYNTHETIC test doubles for the content slice: a programmable fixture
 * LlmClient, an in-memory MemoryRetriever, and an in-memory ApprovalGate
 * with the documented binding semantics (site, action, subject, artifact
 * hash, expiry, one-time execution). No network, no real credentials.
 */
import type { ApprovalActionType, ApprovalCheck, ApprovalGate, ApprovalRecord, ApprovalRequestInput } from '../../../src/approvals/types.js';
import type { EmbedRequest, EmbedResult, LlmClient, ModelTier, StructuredRequest, StructuredResult, TextRequest, TextResult } from '../../../src/integrations/llm/types.js';
import type { MemoryRetriever, RetrievalQuery, RetrievalResult, RetrievedChunk } from '../../../src/memory/types.js';
import type { GeneratedNote, ParsedNote, VaultWriter, WriteOutcome } from '../../../src/obsidian/types.js';

export type Handler = (req: StructuredRequest<unknown>, callIndex: number) => unknown | { __fail: string };

export class FakeLlm implements LlmClient {
  /** Fixture outputs are synthetic by default; a test may flip this to exercise non-demo paths. */
  synthetic = true;
  readonly calls: Array<StructuredRequest<unknown>> = [];
  readonly embedCalls: EmbedRequest[] = [];
  constructor(
    private readonly handlers: Record<string, Handler>,
    private readonly configured: Partial<Record<ModelTier | 'embedding', boolean>> = { cheap: true, reasoning: true, embedding: false },
    private readonly embedder?: (texts: string[]) => Float32Array[],
  ) {}

  isConfigured(tier: ModelTier | 'embedding'): boolean {
    return !!this.configured[tier];
  }

  callsFor(promptId: string): Array<StructuredRequest<unknown>> {
    return this.calls.filter((c) => c.promptId === promptId);
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls.push(req as StructuredRequest<unknown>);
    const h = this.handlers[req.promptId];
    if (!h) return { ok: false, status: 'unsupported', reason: `no fixture handler for ${req.promptId}` };
    const raw = h(req as StructuredRequest<unknown>, this.callsFor(req.promptId).length - 1);
    if (raw && typeof raw === 'object' && '__fail' in (raw as Record<string, unknown>)) return { ok: false, status: 'provider_error', reason: String((raw as { __fail: string }).__fail) };
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) return { ok: false, status: 'needs_review', reason: `fixture output failed schema: ${parsed.error.issues[0]?.message ?? ''}`, lastRawOutput: JSON.stringify(raw) };
    return {
      ok: true,
      value: parsed.data,
      callId: `call_${this.calls.length}`,
      model: 'fixture-model',
      promptVersion: `${req.promptId}@1+fixture`,
      usage: { inputTokens: null, outputTokens: null, reasoningTokens: null },
      costMicros: null,
      repairAttempts: 0,
      truncation: [],
    };
  }

  async text(_req: TextRequest): Promise<TextResult> {
    return { ok: false, status: 'unsupported', reason: 'text() not used by the content slice' };
  }

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    this.embedCalls.push(req);
    if (!this.embedder) return { ok: false, status: 'not_configured', reason: 'no embedder' };
    const vectors = this.embedder(req.texts);
    return { ok: true, vectors, model: 'fixture-embed', dimensions: vectors[0]?.length ?? 0, usage: { inputTokens: null, outputTokens: null, reasoningTokens: null }, costMicros: null };
  }
}

export class FakeMemory implements MemoryRetriever {
  readonly queries: RetrievalQuery[] = [];
  constructor(private readonly chunks: Array<Partial<RetrievedChunk> & { siteId: string; text: string }>) {}
  async search(q: RetrievalQuery): Promise<RetrievalResult> {
    this.queries.push(q);
    const out: RetrievedChunk[] = this.chunks
      .filter((c) => c.siteId === q.siteId)
      .filter((c) => !q.trustClasses || q.trustClasses.includes(c.trustClass ?? 'owner_approved'))
      .map((c, i) => ({
        chunkId: c.chunkId ?? `chunk_${i}`,
        documentId: c.documentId ?? `doc_${i}`,
        text: c.text,
        headingPath: c.headingPath ?? '',
        title: c.title ?? 'Synthetic business note',
        sourceType: c.sourceType ?? 'business_note',
        sourceRef: c.sourceRef ?? `01 Business/Note ${i}.md`,
        sourceUrl: c.sourceUrl ?? null,
        trustClass: c.trustClass ?? 'owner_approved',
        documentStatus: c.documentStatus ?? 'active',
        recordStatus: c.recordStatus ?? null,
        sourceDate: c.sourceDate ?? '2026-09-01',
        language: c.language ?? 'en',
        scores: { fused: 1 },
        explanation: ['fixture'],
      }));
    return { chunks: out.slice(0, q.limit ?? 10), method: 'fts_only', degraded: true, degradedReason: 'fixture', usedTokens: 0, budgetTokens: q.contextBudgetTokens ?? 1000, truncated: false };
  }
}

export class FakeApprovalGate implements ApprovalGate {
  readonly records: ApprovalRecord[] = [];
  private seq = 0;
  constructor(private readonly now: () => Date = () => new Date('2026-09-24T09:00:00.000Z')) {}

  request(input: ApprovalRequestInput): ApprovalRecord {
    const live = this.records.find((r) => r.siteId === input.siteId && r.actionType === input.actionType && r.subjectType === input.subjectType && r.subjectId === input.subjectId && r.artifactHash === input.artifactHash && (r.status === 'pending' || r.status === 'approved'));
    if (live) return live;
    const rec: ApprovalRecord = {
      id: `apr_${++this.seq}`,
      siteId: input.siteId,
      actionType: input.actionType,
      target: input.target,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      artifactHash: input.artifactHash,
      sourceRevision: input.sourceRevision ?? null,
      summary: input.summary,
      status: 'pending',
      requestedBy: input.requestedBy,
      requestedAt: this.now().toISOString(),
      approver: null,
      decidedAt: null,
      expiresAt: new Date(this.now().getTime() + (input.ttlHours ?? 72) * 3_600_000).toISOString(),
      executedAt: null,
    };
    this.records.push(rec);
    return rec;
  }

  /** Test helper: a human approves (normally `approvals approve <id>`). */
  approve(id: string, approver = 'owner:test'): ApprovalRecord {
    const r = this.records.find((x) => x.id === id);
    if (!r) throw new Error(`no approval ${id}`);
    r.status = 'approved';
    r.approver = approver;
    r.decidedAt = this.now().toISOString();
    return r;
  }

  /** Test helper: request + approve in one step for an exact proposal. */
  grant(input: Omit<ApprovalRequestInput, 'summary' | 'requestedBy' | 'target'> & { target?: string }): ApprovalRecord {
    const r = this.request({ ...input, target: input.target ?? input.subjectId, summary: 'test grant', requestedBy: 'test' });
    return this.approve(r.id);
  }

  check(input: { siteId: string; actionType: ApprovalActionType; subjectType: string; subjectId: string; artifactHash: string; sourceRevision?: string | null }): ApprovalCheck {
    const same = this.records.filter((r) => r.siteId === input.siteId && r.actionType === input.actionType && r.subjectType === input.subjectType && r.subjectId === input.subjectId);
    if (!same.length) return { ok: false, reason: 'none' };
    const exact = same.filter((r) => r.artifactHash === input.artifactHash);
    if (!exact.length) return { ok: false, reason: 'hash_mismatch', approval: same[same.length - 1]! };
    const approved = exact.find((r) => r.status === 'approved');
    if (approved) {
      if (new Date(approved.expiresAt).getTime() < this.now().getTime()) return { ok: false, reason: 'expired', approval: approved };
      return { ok: true, approval: approved };
    }
    const latest = exact[exact.length - 1]!;
    const reason = latest.status === 'executed' ? 'already_executed' : latest.status === 'pending' ? 'pending' : latest.status === 'rejected' ? 'rejected' : latest.status === 'expired' ? 'expired' : 'invalidated';
    return { ok: false, reason, approval: latest };
  }

  consume(approvalId: string, _execution: Record<string, unknown>): ApprovalRecord {
    const r = this.records.find((x) => x.id === approvalId);
    if (!r || r.status !== 'approved') throw new Error(`approval ${approvalId} is not approved`);
    r.status = 'executed';
    r.executedAt = this.now().toISOString();
    return r;
  }
}

export class FakeVault implements VaultWriter {
  readonly siteId: string;
  readonly vaultDir = '/fake-vault';
  readonly written: GeneratedNote[] = [];
  constructor(siteId: string) {
    this.siteId = siteId;
  }
  writeGenerated(note: GeneratedNote): WriteOutcome {
    this.written.push(note);
    return { status: 'created', relPath: note.relPath };
  }
  readNote(_relPath: string): ParsedNote | null {
    return null;
  }
  link(toRelPath: string, alias?: string): string {
    return alias ? `[[${toRelPath.replace(/\.md$/, '')}|${alias}]]` : `[[${toRelPath.replace(/\.md$/, '')}]]`;
  }
  appendSystemLog(): void {}
}
