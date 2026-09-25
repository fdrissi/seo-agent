/**
 * Versioned structured-data feature requirements (spec §17: apply structured
 * data only when it accurately describes visible content AND meets current
 * feature requirements; do not assume FAQs qualify for a rich result).
 *
 * Each entry names the Google Search Central page it was transcribed from.
 * `verifiedAt` is the date someone actually checked that page; `null` means
 * the entry is unverified and must be re-checked before relying on it.
 * Search features change: bump STRUCTURED_DATA_REQUIREMENTS_VERSION and
 * re-verify when Google changes a feature. Nothing here promises a rich
 * result: meeting the requirements only makes markup eligible.
 */

export const STRUCTURED_DATA_REQUIREMENTS_VERSION = 'sd-requirements@2026-09-24';

export type RichResultStatus =
  /** Google documents a Search feature for this type (eligibility is never a guarantee). */
  | 'eligible'
  /** Google no longer shows this rich result: the markup creates no rich-result feature. */
  | 'deprecated'
  /** Shown only in narrow circumstances (specific site categories or combinations). */
  | 'restricted'
  /** No Google Search rich-result feature exists for this type. */
  | 'none';

export interface StructuredDataRequirement {
  type: string;
  richResult: RichResultStatus;
  /** Required properties as dot paths; "a|b|c" means at least one of them. Arrays: any element may satisfy a path. */
  required: string[];
  /** Requirements for every element of an array property (e.g. ListItem in itemListElement). */
  elements?: { path: string; required: string[]; notRequiredOnLast?: string[] };
  note: string;
  source: string;
  /** YYYY-MM-DD when the source page was checked, or null (unverified). */
  verifiedAt: string | null;
  verification: string;
}

const FETCHED = 'Checked against the live Google Search Central page on 2026-09-24 (automated fetch during development); re-verify before relying on it.';
const UNVERIFIED = 'unverified: transcribed from Google Search Central documentation without re-checking the page; verify before relying on it.';

export const STRUCTURED_DATA_REQUIREMENTS: readonly StructuredDataRequirement[] = [
  {
    type: 'Article',
    richResult: 'eligible',
    required: [],
    note: 'No required properties; headline, image, author, datePublished, and dateModified are recommended. Dates must be real publication/modification dates set by a human at publication.',
    source: 'https://developers.google.com/search/docs/appearance/structured-data/article',
    verifiedAt: '2026-09-24',
    verification: FETCHED,
  },
  {
    type: 'BlogPosting',
    richResult: 'eligible',
    required: [],
    note: 'Article subtype: same guidance as Article (no required properties).',
    source: 'https://developers.google.com/search/docs/appearance/structured-data/article',
    verifiedAt: null,
    verification: UNVERIFIED,
  },
  {
    type: 'NewsArticle',
    richResult: 'eligible',
    required: [],
    note: 'Article subtype: same guidance as Article (no required properties).',
    source: 'https://developers.google.com/search/docs/appearance/structured-data/article',
    verifiedAt: null,
    verification: UNVERIFIED,
  },
  {
    type: 'FAQPage',
    richResult: 'deprecated',
    required: [],
    note: 'Google deprecated the FAQ rich result (before that it was shown only for well-known, authoritative government and health websites); its documentation was removed. FAQ markup creates no rich result.',
    source: 'https://developers.google.com/search/updates',
    verifiedAt: '2026-09-24',
    verification: `${FETCHED} The former FAQPage documentation URL now redirects to the updates page.`,
  },
  {
    type: 'HowTo',
    richResult: 'deprecated',
    required: [],
    note: 'Google no longer shows How-to rich results on desktop or mobile; the documentation was removed. HowTo markup creates no rich result.',
    source: 'https://developers.google.com/search/docs/appearance/structured-data/how-to',
    verifiedAt: '2026-09-24',
    verification: FETCHED,
  },
  {
    type: 'Product',
    richResult: 'eligible',
    required: ['name', 'review|aggregateRating|offers'],
    note: 'Product snippets need name plus one of review, aggregateRating, or offers. Reviews/ratings are never proposed without real, visible review evidence, so a proposal needs offers built from verified owner prices.',
    source: 'https://developers.google.com/search/docs/appearance/structured-data/product-snippet',
    verifiedAt: '2026-09-24',
    verification: FETCHED,
  },
  {
    type: 'SoftwareApplication',
    richResult: 'eligible',
    required: ['name', 'offers.price', 'aggregateRating|review'],
    note: 'Software app rich results need name, offers.price, and aggregateRating or review. Without real, visible reviews the markup cannot qualify.',
    source: 'https://developers.google.com/search/docs/appearance/structured-data/software-app',
    verifiedAt: '2026-09-24',
    verification: FETCHED,
  },
  {
    type: 'LocalBusiness',
    richResult: 'eligible',
    required: ['name', 'address'],
    note: 'Local business markup needs name and a PostalAddress (from owner facts only).',
    source: 'https://developers.google.com/search/docs/appearance/structured-data/local-business',
    verifiedAt: '2026-09-24',
    verification: FETCHED,
  },
  {
    type: 'Organization',
    richResult: 'eligible',
    required: [],
    note: 'No required properties; add the properties that apply (name, url, logo, contact details from owner facts).',
    source: 'https://developers.google.com/search/docs/appearance/structured-data/organization',
    verifiedAt: '2026-09-24',
    verification: FETCHED,
  },
  {
    type: 'BreadcrumbList',
    richResult: 'eligible',
    required: ['itemListElement'],
    elements: { path: 'itemListElement', required: ['position', 'name', 'item'], notRequiredOnLast: ['item'] },
    note: 'Breadcrumbs need itemListElement; each ListItem needs position and name, and item (URL) except on the last breadcrumb.',
    source: 'https://developers.google.com/search/docs/appearance/structured-data/breadcrumb',
    verifiedAt: '2026-09-24',
    verification: FETCHED,
  },
  {
    type: 'ItemList',
    richResult: 'restricted',
    required: ['itemListElement'],
    note: 'List markup (carousel) is shown only in combination with specific supported content types (for example recipes, courses, restaurants, movies); on its own it creates no rich result.',
    source: 'https://developers.google.com/search/docs/appearance/structured-data/carousel',
    verifiedAt: null,
    verification: UNVERIFIED,
  },
  {
    type: 'WebPage',
    richResult: 'none',
    required: [],
    note: 'No Google Search rich-result feature for WebPage (absent from the Search gallery); markup only describes the page.',
    source: 'https://developers.google.com/search/docs/appearance/structured-data/search-gallery',
    verifiedAt: '2026-09-24',
    verification: `${FETCHED} WebPage is not listed in the Search gallery.`,
  },
  {
    type: 'Service',
    richResult: 'none',
    required: [],
    note: 'No Google Search rich-result feature for Service (absent from the Search gallery); markup only describes the offer.',
    source: 'https://developers.google.com/search/docs/appearance/structured-data/search-gallery',
    verifiedAt: '2026-09-24',
    verification: `${FETCHED} Service is not listed in the Search gallery.`,
  },
];

const BY_TYPE = new Map(STRUCTURED_DATA_REQUIREMENTS.map((r) => [r.type, r]));

export function structuredDataRequirement(type: string): StructuredDataRequirement | null {
  return BY_TYPE.get(type) ?? null;
}

/** Types the draft may propose at all (the allowlist). */
export const SUPPORTED_SCHEMA_TYPES: ReadonlySet<string> = new Set(STRUCTURED_DATA_REQUIREMENTS.map((r) => r.type));

function present(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.some(present);
  return true;
}

/** Whether a dot path has a value (arrays: any element may carry it). */
export function hasPath(node: unknown, path: string): boolean {
  const [head, ...rest] = path.split('.');
  if (Array.isArray(node)) return node.some((n) => hasPath(n, path));
  if (!node || typeof node !== 'object' || !head) return false;
  const v = (node as Record<string, unknown>)[head];
  if (!rest.length) return present(v);
  return hasPath(v, rest.join('.'));
}

/** Missing required properties of one JSON-LD node for its requirement entry. */
export function missingRequiredProperties(node: Record<string, unknown>, req: StructuredDataRequirement): string[] {
  const missing: string[] = [];
  for (const r of req.required) if (!r.split('|').some((alt) => hasPath(node, alt))) missing.push(r.includes('|') ? `one of ${r.split('|').join(', ')}` : r);
  if (req.elements) {
    const list = node[req.elements.path];
    const items = Array.isArray(list) ? list : list ? [list] : [];
    items.forEach((el, i) => {
      const last = i === items.length - 1;
      for (const p of req.elements!.required) {
        if (last && req.elements!.notRequiredOnLast?.includes(p)) continue;
        if (!hasPath(el, p)) missing.push(`${req.elements!.path}[${i}].${p}`);
      }
    });
  }
  return missing;
}

/** JSON-LD nodes with a @type (top-level object or @graph members). */
export function typedNodes(jsonLd: Record<string, unknown>, fallbackType: string): Array<{ type: string; node: Record<string, unknown> }> {
  const graph = jsonLd['@graph'];
  const nodes = Array.isArray(graph) ? graph.filter((n): n is Record<string, unknown> => !!n && typeof n === 'object') : [jsonLd];
  const out: Array<{ type: string; node: Record<string, unknown> }> = [];
  for (const n of nodes) {
    const t = n['@type'] ?? (nodes.length === 1 ? fallbackType : undefined);
    for (const type of ([] as unknown[]).concat(t ?? []).map(String)) out.push({ type, node: n });
  }
  return out;
}

/** Plain-language rules for the draft prompt, generated from the table (so the prompt never drifts from the gate). */
export function structuredDataPromptRules(): string {
  const lines = [`Structured-data requirements (${STRUCTURED_DATA_REQUIREMENTS_VERSION}):`];
  for (const r of STRUCTURED_DATA_REQUIREMENTS) {
    const req = r.required.length ? `required: ${r.required.map((x) => x.replace(/\|/g, ' or ')).join(', ')}` : 'no required properties';
    const status =
      r.richResult === 'deprecated'
        ? 'DEPRECATED rich result: do not propose it for a rich result'
        : r.richResult === 'restricted'
          ? 'restricted rich result'
          : r.richResult === 'none'
            ? 'no rich result'
            : 'eligible (never guaranteed)';
    lines.push(`- ${r.type}: ${status}; ${req}.`);
  }
  lines.push('- Never include datePublished or dateModified in a proposal for new content; a human sets real dates at publication.');
  lines.push('- Never include review or aggregateRating; prices only from product facts.');
  return lines.join('\n');
}
