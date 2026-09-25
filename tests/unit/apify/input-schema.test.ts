import { describe, expect, it } from 'vitest';
import { detectSchemaDocument, diffInputSchemas, inputSchemaHash, parseInputSchema, validateInputAgainstSchema } from '../../../src/integrations/apify/input-schema.js';
import { fixtureSchema, loadJson } from '../../fixtures/apify/fake-apify.js';

describe('apify input schema', () => {
  it('parses a schema given as a JSON string (build.inputSchema) or an object', () => {
    const raw = fixtureSchema();
    const a = parseInputSchema(JSON.stringify(raw));
    const b = parseInputSchema(raw);
    expect(Object.keys(a.properties)).toHaveLength(43);
    expect(inputSchemaHash(a)).toBe(inputSchemaHash(b));
  });

  it('hash is independent of key order but changes when a property changes', () => {
    const raw = fixtureSchema();
    const reordered = { properties: raw.properties, type: raw.type, title: raw.title, schemaVersion: raw.schemaVersion, _synthetic: raw._synthetic, _note: raw._note };
    expect(inputSchemaHash(parseInputSchema(reordered))).toBe(inputSchemaHash(parseInputSchema(raw)));
    const changed = structuredClone(raw);
    changed.properties.maxPostsCount.maximum = 100;
    expect(inputSchemaHash(parseInputSchema(changed))).not.toBe(inputSchemaHash(parseInputSchema(raw)));
  });

  it('rejects non-schemas', () => {
    expect(() => parseInputSchema('{not json')).toThrow(/not valid JSON/);
    expect(() => parseInputSchema({ type: 'object', properties: {} })).toThrow(/no properties/);
    expect(() => parseInputSchema({ searchTerms: ['x'] })).toThrow(/not an Apify input schema/);
  });

  it('diffs schemas (added, removed, changed, meta)', () => {
    const a = parseInputSchema(fixtureSchema());
    const raw = fixtureSchema();
    delete raw.properties.onlyWithFlair;
    raw.properties.webhookUrl = { title: 'Webhook URL', type: 'string', default: '' };
    raw.properties.maxPostsCount.default = 10;
    raw.required = ['searchTerms'];
    const d = diffInputSchemas(a, parseInputSchema(raw));
    expect(d.added).toEqual(['webhookUrl']);
    expect(d.removed).toEqual(['onlyWithFlair']);
    expect(d.changed).toEqual(['maxPostsCount']);
    expect(d.changedMeta).toEqual(['required']);
  });

  describe('validateInputAgainstSchema', () => {
    const schema = parseInputSchema(fixtureSchema());
    it('accepts a valid input', () => {
      expect(validateInputAgainstSchema({ searchTerms: ['a'], maxPostsCount: 5, searchTime: 'month', aiAnalysis: false, customLabels: {} }, schema)).toEqual([]);
    });
    it('rejects unknown fields (fields outside the schema are never sent)', () => {
      const errs = validateInputAgainstSchema({ searchTerms: ['a'], proxyConfiguration: { useApifyProxy: true } }, schema);
      expect(errs).toEqual(['"proxyConfiguration" is not a field of the verified input schema']);
    });
    it('checks types, enums, ranges, list item types, and secret fields', () => {
      const errs = validateInputAgainstSchema(
        { searchTerms: ['ok', 3], maxPostsCount: 50001, searchTime: 'decade', includeNSFW: 'no', mcpServerToken: 'x', maxCommentsCount: 1.5 },
        schema,
      );
      expect(errs).toEqual(
        expect.arrayContaining([
          '"searchTerms" items must be of type string',
          '"maxPostsCount" must be <= 50000',
          expect.stringContaining('"searchTime" must be one of'),
          '"includeNSFW" must be of type boolean',
          '"mcpServerToken" is a secret field and must never be set by this application',
          '"maxCommentsCount" must be of type integer',
        ]),
      );
    });
    it('enforces required fields when the schema declares them', () => {
      const raw = fixtureSchema();
      raw.required = ['startUrls'];
      expect(validateInputAgainstSchema({ searchTerms: ['a'] }, parseInputSchema(raw))).toEqual(['required field "startUrls" is missing']);
    });
  });

  describe('detectSchemaDocument', () => {
    it('detects a raw schema, a build envelope, and an OpenAPI document', () => {
      const raw = fixtureSchema();
      expect(detectSchemaDocument(raw).kind).toBe('input_schema');
      const build = detectSchemaDocument({ data: { id: 'SYNBUILD1', actId: '9sHOY9RzPYGjmTHo8', buildNumber: '0.0.513', inputSchema: JSON.stringify(raw) } });
      expect(build).toMatchObject({ kind: 'build', buildNumber: '0.0.513', buildId: 'SYNBUILD1', actorId: '9sHOY9RzPYGjmTHo8' });
      const openapi = detectSchemaDocument({ openapi: '3.0.1', components: { schemas: { inputSchema: raw } } });
      expect(openapi.kind).toBe('openapi');
    });
    it('never treats an example input as the schema', () => {
      expect(() => detectSchemaDocument(loadJson('example-input.json'))).toThrow(/example input/);
    });
    it('reports a build whose inputSchema is null as unavailable', () => {
      expect(() => detectSchemaDocument({ data: { id: 'b', buildNumber: '0.0.1', inputSchema: null } })).toThrow(/unavailable/);
    });
  });
});
