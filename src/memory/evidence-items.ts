import type { EvidenceItem } from '../integrations/llm/types.js';
import type { RetrievalResult } from './types.js';

/**
 * Convert retrieved memory chunks into LLM evidence items. Every item keeps
 * its trust class (the LLM client wraps it as untrusted data), and rejected
 * proposals / negative experiments carry their status in the label so they
 * are never presented as recommendations.
 */
export function toEvidenceItems(result: RetrievalResult): EvidenceItem[] {
  return result.chunks.map((c) => {
    const status: string[] = [];
    if (c.documentStatus !== 'active') status.push(c.documentStatus.toUpperCase());
    if (c.recordStatus && c.recordStatus !== c.documentStatus) status.push(`record status: ${c.recordStatus}`);
    const label = `memory:${c.sourceType} "${c.title}"${c.headingPath ? ` > ${c.headingPath}` : ''}${status.length ? ` [${status.join('; ')}]` : ''}`;
    const item: EvidenceItem = { id: `memory:${c.chunkId}`, label, text: c.text, trustClass: c.trustClass, sourceId: c.sourceRef };
    if (c.sourceUrl) item.url = c.sourceUrl;
    if (c.sourceDate) item.retrievedAt = c.sourceDate;
    return item;
  });
}
