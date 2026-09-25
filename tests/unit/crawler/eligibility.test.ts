import { describe, expect, it } from 'vitest';
import { assessSearchEligibility } from '../../../src/crawler/eligibility.js';
import { parseRobotsDirectives } from '../../../src/crawler/extract.js';

const robots = (value: string) => parseRobotsDirectives(value ? [{ value, source: 'meta:robots' }] : []);

describe('assessSearchEligibility', () => {
  it('never claims a 200 page is indexed', () => {
    const e = assessSearchEligibility({ robotsAllowed: true, statusCode: 200, blockedReason: null, robots: robots('') });
    expect(e).toMatchObject({ crawl: 'allowed', indexing: 'no_blocking_directive_observed', snippet: 'no_restriction_observed', aiFeatures: 'no_restriction_observed' });
    expect(e.caveat).toMatch(/does not mean the page is indexed/);
    expect(JSON.stringify(e)).not.toMatch(/"indexed"/);
  });

  it('reports observed blockers', () => {
    expect(assessSearchEligibility({ robotsAllowed: true, statusCode: 200, blockedReason: null, robots: robots('noindex') })).toMatchObject({ indexing: 'blocked_by_noindex', aiFeatures: 'not_eligible' });
    expect(assessSearchEligibility({ robotsAllowed: true, statusCode: 200, blockedReason: null, robots: robots('nosnippet') })).toMatchObject({ snippet: 'blocked', aiFeatures: 'not_eligible' });
    expect(assessSearchEligibility({ robotsAllowed: true, statusCode: 200, blockedReason: null, robots: robots('max-snippet:0') }).snippet).toBe('blocked');
    expect(assessSearchEligibility({ robotsAllowed: true, statusCode: 200, blockedReason: null, robots: robots('max-snippet:40') })).toMatchObject({ snippet: 'limited', aiFeatures: 'limited' });
    expect(assessSearchEligibility({ robotsAllowed: false, statusCode: null, blockedReason: 'robots', robots: null })).toMatchObject({ crawl: 'blocked_by_robots_txt', indexing: 'unknown' });
    expect(assessSearchEligibility({ robotsAllowed: true, statusCode: 401, blockedReason: 'login_required', robots: null }).crawl).toBe('blocked_access');
    expect(assessSearchEligibility({ robotsAllowed: true, statusCode: 404, blockedReason: null, robots: null }).reasons.join(' ')).toMatch(/HTTP 404/);
  });
});
