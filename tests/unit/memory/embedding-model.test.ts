import { describe, expect, it } from 'vitest';
import { compareEmbeddingModels, sameReturnedModel } from '../../../src/memory/embeddings.js';

describe('compareEmbeddingModels (embedding-space identity)', () => {
  it('treats identical ids (ignoring case/whitespace) as the same model', () => {
    expect(compareEmbeddingModels('text-embedding-3-small', 'text-embedding-3-small')).toBe('same');
    expect(compareEmbeddingModels('Text-Embedding-3-Small ', 'text-embedding-3-small')).toBe('same');
    expect(compareEmbeddingModels('openai/text-embedding-3-small', 'OpenAI/text-embedding-3-small')).toBe('same');
  });

  it('accepts only a provider prefix added to a configured id that has none', () => {
    expect(compareEmbeddingModels('text-embedding-3-small', 'openai/text-embedding-3-small')).toBe('variant');
    expect(compareEmbeddingModels('example-embed', 'prov-a/example-embed')).toBe('variant');
  });

  it('treats a different or dropped provider as different when the configured id pins one', () => {
    expect(compareEmbeddingModels('openai/text-embedding-3-small', 'azure/text-embedding-3-small')).toBe('different');
    expect(compareEmbeddingModels('openai/text-embedding-3-small', 'text-embedding-3-small')).toBe('different');
    expect(compareEmbeddingModels('text-embedding-3-small', 'a/b/text-embedding-3-small')).toBe('different');
  });

  it('treats alias and version suffixes as different models (a moving alias can change the space)', () => {
    expect(compareEmbeddingModels('text-embedding-ada-002', 'text-embedding-ada-002-v2')).toBe('different');
    expect(compareEmbeddingModels('example-embed', 'example-embed-2026-01-15')).toBe('different');
    expect(compareEmbeddingModels('example-embed', 'example-embed@001')).toBe('different');
    expect(compareEmbeddingModels('example-embed', 'example-embed-latest')).toBe('different');
    expect(compareEmbeddingModels('example-embed', 'example-embed-preview')).toBe('different');
    expect(compareEmbeddingModels('example-embed-latest', 'example-embed-20260115')).toBe('different');
    expect(compareEmbeddingModels('example-embed', 'prov-a/example-embed-latest')).toBe('different');
  });

  it('accepts an explicitly allowlisted alias only', () => {
    expect(compareEmbeddingModels('example-embed', 'example-embed@001', ['example-embed@001'])).toBe('variant');
    expect(compareEmbeddingModels('example-embed', 'example-embed@002', ['example-embed@001'])).toBe('different');
  });

  it('flags different models, including ones with the same output size', () => {
    expect(compareEmbeddingModels('text-embedding-3-small', 'text-embedding-ada-002')).toBe('different');
    expect(compareEmbeddingModels('text-embedding-3-small', 'text-embedding-3-large')).toBe('different');
    expect(compareEmbeddingModels('example-embed', 'example-embed-multilingual')).toBe('different');
    expect(compareEmbeddingModels('gemini-embedding-001', 'gemini-embedding-2')).toBe('different');
    expect(compareEmbeddingModels('example-embed', '')).toBe('different');
  });

  it('compares returned ids exactly (case-insensitive)', () => {
    expect(sameReturnedModel('prov-a/example-embed', 'PROV-A/example-embed ')).toBe(true);
    expect(sameReturnedModel('prov-a/example-embed', 'prov-b/example-embed')).toBe(false);
  });
});
