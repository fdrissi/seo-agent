import { describe, expect, it } from 'vitest';
import { ENDPOINTS, buildPath, requireEndpoint } from '../../../src/integrations/dataforseo/endpoints.js';
import { PROFILE_DEFAULTS } from '../../../src/config/profiles.js';
import { AppError } from '../../../src/core/errors.js';

const full = { ...PROFILE_DEFAULTS.full };

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as AppError).code;
  }
  return undefined;
}

describe('DataForSEO endpoint allowlist', () => {
  it('allows the verified SERP, keyword-volume, lookup, and account endpoints', () => {
    for (const key of [
      'serp/google/organic/task_post',
      'serp/google/organic/tasks_ready',
      'serp/google/organic/task_get/advanced/{id}',
      'serp/google/organic/live/advanced',
      'serp/google/locations',
      'serp/google/languages',
      'keywords_data/google_ads/search_volume/task_post',
      'keywords_data/google_ads/search_volume/live',
      'keywords_data/google_ads/locations',
      'appendix/user_data',
    ]) {
      expect(requireEndpoint(key, full).key).toBe(key);
    }
  });

  it('marks only task creation / live calls as paid; retrieval and lookups are free', () => {
    expect(ENDPOINTS.get('serp/google/organic/task_post')!.paid).toBe(true);
    expect(ENDPOINTS.get('serp/google/organic/task_get/advanced/{id}')!.paid).toBe(false);
    expect(ENDPOINTS.get('serp/google/organic/tasks_ready')!.paid).toBe(false);
    expect(ENDPOINTS.get('appendix/user_data')!.paid).toBe(false);
    expect(ENDPOINTS.get('serp/google/organic/live/advanced')!.maxTasksPerPost).toBe(1);
    expect(ENDPOINTS.get('serp/google/organic/task_post')!.maxTasksPerPost).toBe(100);
  });

  it('refuses unknown endpoints', () => {
    expect(codeOf(() => requireEndpoint('on_page/task_post', full))).toBe('POLICY_DENIED');
    expect(codeOf(() => requireEndpoint('serp/bing/organic/task_post', full))).toBe('POLICY_DENIED');
  });

  it('refuses backlinks, Labs, AI-optimization, and AI SERP families while their flags are off (default in every profile)', () => {
    for (const key of [
      'backlinks/summary/live',
      'backlinks/backlinks/live',
      'dataforseo_labs/google/ranked_keywords/live',
      'dataforseo_labs/google/keyword_ideas/live',
      'ai_optimization/llm_mentions/search_mentions/live',
      'ai_optimization/chat_gpt/llm_responses/live',
      'serp/google/ai_mode/task_post',
      'serp/ai_summary',
    ]) {
      expect(codeOf(() => requireEndpoint(key, full)), key).toBe('INTEGRATION_DISABLED');
    }
    for (const profile of ['demo', 'core', 'full'] as const) {
      expect(PROFILE_DEFAULTS[profile].dataforseoBacklinks).toBe(false);
      expect(PROFILE_DEFAULTS[profile].dataforseoLabsExports).toBe(false);
      expect(PROFILE_DEFAULTS[profile].dataforseoAiVisibility).toBe(false);
    }
  });

  it('with a flag on, only the selected gated endpoints resolve; other paths in the family stay refused', () => {
    const flags = { ...full, dataforseoBacklinks: true };
    expect(requireEndpoint('backlinks/summary/live', flags).gate).toBe('dataforseoBacklinks');
    expect(codeOf(() => requireEndpoint('backlinks/backlinks/live', flags))).toBe('POLICY_DENIED');
  });

  it('validates path parameters so they cannot alter the path', () => {
    const spec = requireEndpoint('serp/google/organic/task_get/advanced/{id}', full);
    expect(buildPath(spec, { id: '09241257-1535-0066-0000-2b4d4d7d8f38' })).toBe('serp/google/organic/task_get/advanced/09241257-1535-0066-0000-2b4d4d7d8f38');
    expect(codeOf(() => buildPath(spec, { id: '../../backlinks/summary' }))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => buildPath(spec, {}))).toBe('VALIDATION_FAILED');
    const loc = requireEndpoint('serp/google/locations/{country}', full);
    expect(buildPath(loc, { country: 'ee' })).toBe('serp/google/locations/ee');
    expect(codeOf(() => buildPath(loc, { country: 'EE/../x' }))).toBe('VALIDATION_FAILED');
  });
});
