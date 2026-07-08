import { describe, it, expect } from 'vitest';
import { parseClassificationResults, parseExtractionResult } from '../src/lib/anthropic';

const validClassification = {
  results: [
    { is_decision_bearing: true, is_trivial: false, entity_mentions: [{ kind: 'technology', name: 'Redis' }] },
    { is_decision_bearing: false, is_trivial: true, entity_mentions: [] },
  ],
};

describe('parseClassificationResults', () => {
  it('accepts a valid payload and returns results in order', () => {
    const out = parseClassificationResults(validClassification, 2);
    expect(out).toHaveLength(2);
    expect(out[0].is_decision_bearing).toBe(true);
    expect(out[1].is_trivial).toBe(true);
  });
  it('rejects a count mismatch', () => {
    expect(() => parseClassificationResults(validClassification, 3)).toThrow(/expected 3/i);
  });
  it('rejects an invalid entity kind', () => {
    const bad = { results: [{ is_decision_bearing: false, is_trivial: false, entity_mentions: [{ kind: 'planet', name: 'Mars' }] }] };
    expect(() => parseClassificationResults(bad, 1)).toThrow(/kind/i);
  });
});

const validExtraction = {
  title: 'Use Redis for session cache',
  decision: 'Adopt Redis as the session cache backend.',
  reasoning: 'In-process cache did not survive restarts.',
  alternatives: [{ option: 'Memcached', why_rejected: 'No persistence.' }],
  confidence: 0.9,
  entities: [{ kind: 'technology', name: 'Redis', description: 'In-memory data store' }],
  relationships: [
    { source: { kind: 'component', name: 'session service' }, target: { kind: 'technology', name: 'Redis' }, relation: 'uses' },
  ],
};

describe('parseExtractionResult', () => {
  it('accepts a valid payload', () => {
    const out = parseExtractionResult(validExtraction);
    expect(out.title).toBe('Use Redis for session cache');
    expect(out.relationships[0].relation).toBe('uses');
  });
  it('rejects an invalid relation', () => {
    const bad = { ...validExtraction, relationships: [{ ...validExtraction.relationships[0], relation: 'loves' }] };
    expect(() => parseExtractionResult(bad)).toThrow(/relation/i);
  });
  it('clamps confidence into 0..1', () => {
    const out = parseExtractionResult({ ...validExtraction, confidence: 1.7 });
    expect(out.confidence).toBe(1);
  });
});
