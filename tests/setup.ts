/**
 * Global test setup: tests must never reach the real network or use real
 * credentials. Any unmocked global fetch fails loudly. Tests that exercise
 * HTTP adapters inject a fake `fetch` (see tests/helpers/fake-fetch.ts).
 */
import { afterEach, beforeEach } from 'vitest';
import { clearRegisteredSecrets } from '../src/security/redact.js';

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`Unmocked network access in tests: ${String(input)}`);
  }) as typeof fetch;
  for (const key of [
    'LLM_GATEWAY_API_KEY',
    'DATAFORSEO_LOGIN',
    'DATAFORSEO_PASSWORD',
    'APIFY_TOKEN',
    'QDRANT_API_KEY',
    'PAGESPEED_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_OAUTH_CLIENT_FILE',
    'GOOGLE_TOKEN_FILE',
    'CHEAP_MODEL',
    'REASONING_MODEL',
    'EMBEDDING_MODEL',
    'SEO_AGENT_WORKSPACE',
  ]) {
    delete process.env[key];
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearRegisteredSecrets();
});
