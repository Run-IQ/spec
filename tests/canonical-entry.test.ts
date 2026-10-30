import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  canonicalRulePayload,
  canonicalize,
  isEffectiveAt,
  normalizeRuleDefinition,
  SpecError,
  validateRuleDefinition,
} from '../src/canonical-entry.js';
import { computeRuleChecksum } from '../src/index.js';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const rules = [
  {
    id: 'r1',
    version: 1,
    model: 'PERCENTAGE',
    params: { rate: 0.05, base: 'orderTotal' },
    priority: 1,
    effectiveFrom: '2025-01-01',
  },
  {
    id: 'irpp',
    version: 3,
    model: 'PROGRESSIVE_BRACKET',
    params: {
      base: 'income',
      brackets: [
        { from: 0, to: 900000, rate: 0 },
        { from: 900000, to: null, rate: 0.1 },
      ],
    },
    priority: 10,
    effectiveFrom: new Date('2024-01-01T00:00:00Z'),
    effectiveUntil: '2026-01-01T00:00:00+01:00',
    tags: ['tax', 'income', 'tax'],
    dimensions: { country: 'TG' },
    condition: { dsl: 'jsonlogic', value: { '>': [{ var: 'income' }, 0] } },
    jurisdiction: 'NATIONAL',
  },
  {
    id: 'flat',
    version: 1,
    model: 'FIXED_AMOUNT',
    params: { amount: 1000 },
    priority: 0,
    effectiveFrom: '2025-06-01T12:30:00Z',
    effectiveUntil: null,
    checksum: 'ignored',
  },
];

describe('@run-iq/spec/canonical', () => {
  it('canonicalRulePayload is canonicalize(normalizeRuleDefinition(x))', () => {
    for (const rule of rules) {
      expect(canonicalRulePayload(rule)).toBe(canonicalize(normalizeRuleDefinition(rule)));
    }
  });

  it('sha256 of canonicalRulePayload is the checksum', () => {
    for (const rule of rules) {
      expect(sha256(canonicalRulePayload(rule))).toBe(computeRuleChecksum(rule));
    }
  });

  it('throws SpecError on an invalid rule, like the checksum', () => {
    expect(() => canonicalRulePayload({ ...rules[0]!, effectiveFrom: 'yesterday' })).toThrow(
      SpecError,
    );
  });

  it('re-exports the validator and the validity window', () => {
    expect(validateRuleDefinition(rules[0]).valid).toBe(true);
    expect(isEffectiveAt(normalizeRuleDefinition(rules[0]!), new Date('2025-02-01'))).toBe(true);
  });

  it('imports no node: module anywhere in its module graph', () => {
    const src = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
    const seen = new Set<string>();
    const nodeImports: string[] = [];
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const code = readFileSync(file, 'utf8');
      for (const match of code.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
        const spec = match[1]!;
        if (spec.startsWith('.')) visit(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
        else nodeImports.push(`${file}: ${spec}`);
      }
    };
    visit(resolve(src, 'canonical-entry.ts'));
    expect(seen.size).toBeGreaterThan(5);
    expect(nodeImports).toEqual([]);
  });
});
