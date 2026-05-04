import { describe, expect, it } from 'vitest';
import { extractJsonObject, extractJsonObjectResult, extractStringArray } from '../src/activities/_internal/json-extract';

describe('extractJsonObject', () => {
  it('parses whole-object JSON', () => {
    expect(extractJsonObject('{"verdict":"retry","rationale":"transient"}')).toEqual({
      verdict: 'retry',
      rationale: 'transient',
    });
  });

  it('parses fenced JSON', () => {
    expect(extractJsonObject('```json\n{"theme":"cleanup","steps":[]}\n```')).toEqual({
      theme: 'cleanup',
      steps: [],
    });
  });

  it('parses embedded JSON', () => {
    expect(extractJsonObject('preamble {"overview":"repo","conventions":[]} trailing prose')).toEqual({
      overview: 'repo',
      conventions: [],
    });
  });

  it('returns undefined for malformed non-JSON inputs', () => {
    expect(extractJsonObject('not json at all')).toBeUndefined();
    expect(extractJsonObject('```json\n{"theme":\n```')).toBeUndefined();
  });

  it('reports absent JSON separately from malformed structured JSON', () => {
    expect(extractJsonObjectResult('not json at all')).toEqual({
      ok: false,
      kind: 'no-json-object',
      message: 'structured output did not contain a JSON object',
    });

    expect(extractJsonObjectResult('```json\n{"theme":\n```')).toEqual(
      expect.objectContaining({
        ok: false,
        kind: 'malformed-json',
        message: expect.stringContaining('structured output contained malformed JSON'),
      }),
    );
  });

  it('does not skip a malformed first object to parse later prose', () => {
    expect(extractJsonObjectResult('first {"theme":} then {"theme":"valid"}')).toEqual(
      expect.objectContaining({
        ok: false,
        kind: 'malformed-json',
      }),
    );
  });

  it('parses embedded JSON with braces inside strings', () => {
    expect(extractJsonObject('preamble {"overview":"uses {braces} in strings","conventions":[]} trailing')).toEqual({
      overview: 'uses {braces} in strings',
      conventions: [],
    });
  });
});

describe('extractStringArray', () => {
  it('returns all string elements from a homogeneous string array', () => {
    expect(extractStringArray(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('drops non-string elements from a mixed array', () => {
    expect(extractStringArray(['a', 1, null, 'b', true, undefined, {}])).toEqual(['a', 'b']);
  });

  it('returns empty array for an empty array input', () => {
    expect(extractStringArray([])).toEqual([]);
  });

  it('returns empty array for non-array inputs', () => {
    expect(extractStringArray(null)).toEqual([]);
    expect(extractStringArray(undefined)).toEqual([]);
    expect(extractStringArray('string')).toEqual([]);
    expect(extractStringArray(42)).toEqual([]);
    expect(extractStringArray({ key: 'value' })).toEqual([]);
  });
});
