import { load } from 'cheerio';
import { sha256 } from '../core/hash.js';

/**
 * HTML inspection for approval target rechecks and live verification.
 * Only reads the DOM (cheerio); scripts are never executed.
 */

export interface PageFacts {
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  metaRobots: string | null;
  h1: string[];
  /** Visible text of <main> (or <body> when there is no <main>), whitespace-normalized. */
  mainText: string;
}

const BLOCK = 'p,h1,h2,h3,h4,h5,h6,li,div,section,article,header,footer,aside,nav,td,th,tr,blockquote,pre,dd,dt,figcaption,main';

export function normalizeText(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function extractPageFacts(html: string): PageFacts {
  const $ = load(html);
  $('script,style,noscript,template,svg,iframe').remove();
  $('br').replaceWith(' ');
  $(BLOCK).each((_, el) => {
    $(el).append(' ');
  });
  const attr = (sel: string, name: string): string | null => {
    const v = $(sel).first().attr(name);
    return v === undefined ? null : normalizeText(v);
  };
  const titleText = $('head title').first().text() || $('title').first().text();
  const main = $('main').first();
  const text = normalizeText((main.length ? main : $('body')).text());
  return {
    title: titleText ? normalizeText(titleText) : null,
    metaDescription: attr('meta[name="description" i]', 'content'),
    canonical: attr('link[rel="canonical" i]', 'href'),
    metaRobots: attr('meta[name="robots" i]', 'content'),
    h1: $('h1')
      .map((_, el) => normalizeText($(el).text()))
      .get()
      .filter(Boolean),
    mainText: text,
  };
}

/**
 * Fingerprint of the SEO-relevant state of a page: title, meta description,
 * canonical, robots meta, H1s, and main visible text. Used to detect that the
 * target changed between approval and execution. Dynamic page content (dates,
 * counters, rotating blocks) can change the fingerprint; the safe response is
 * to refuse and re-approve, never to proceed silently.
 */
export function pageFingerprint(html: string): string {
  const f = extractPageFacts(html);
  return sha256(JSON.stringify([f.title, f.metaDescription, f.canonical, f.metaRobots, f.h1, f.mainText]));
}

/** Normalize text for containment checks: lowercase, strip Markdown syntax and punctuation noise. */
export function comparableText(s: string): string {
  return normalizeText(
    s
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
      .replace(/[*_`>#|]/g, ' ')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .toLowerCase(),
  );
}
