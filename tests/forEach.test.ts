import { describe, expect, it } from 'vitest';
import {
  computeRuleChecksum,
  computeRuleFingerprint,
  normalizeRuleDefinition,
  RESERVED_RULE_FIELDS,
  validateRuleDefinition,
} from '../src/index.js';
import type { ForEach, OrderKey, RuleDefinitionInput } from '../src/index.js';
import { ACCEPTED_FOR_EACH, REFUSED_FOR_EACH, VALIDATOR_ONLY_FOR_EACH } from './forEach-cases.js';
import { BASE_RULE, expectRuleRefused, specError } from './helpers.js';

const rule = (forEach: unknown): RuleDefinitionInput => ({ ...BASE_RULE, forEach });

type Collection = Exclude<ForEach, { segments: unknown }>;
type Segmented = Extract<ForEach, { segments: unknown }>;

/** The normalized `forEach` of `value`, which must be a collection. */
function collectionOf(value: RuleDefinitionInput): Collection {
  const forEach = normalizeRuleDefinition(value).forEach;
  if (forEach === undefined || 'segments' in forEach) throw new Error('expected a collection');
  return forEach;
}

/** The normalized `forEach` of `value`, which must be segments. */
function segmentsOf(value: RuleDefinitionInput): Segmented {
  const forEach = normalizeRuleDefinition(value).forEach;
  if (forEach === undefined || !('segments' in forEach)) throw new Error('expected segments');
  return forEach;
}

describe('forEach: accepted forms', () => {
  it.each(ACCEPTED_FOR_EACH)('accepts %s', (_label, forEach, normal) => {
    expect(normalizeRuleDefinition(rule(forEach)).forEach).toEqual(normal);
    expect(validateRuleDefinition(rule(forEach))).toEqual({ valid: true, errors: [], issues: [] });
  });

  it('types the two forms', () => {
    const order: OrderKey = { path: '/naissance', type: 'date', dir: 'asc' };
    const collection: ForEach = { path: '/enfants', key: 'id', orderBy: [order] };
    const segments: ForEach = { segments: { from: '/$dates/a', until: '/$dates/b', facts: [] } };
    expect(normalizeRuleDefinition(rule(collection)).forEach).toEqual(collection);
    expect(normalizeRuleDefinition(rule(segments)).forEach).toEqual(segments);
  });
});

describe('forEach: refused forms', () => {
  it.each([...REFUSED_FOR_EACH, ...VALIDATOR_ONLY_FOR_EACH])(
    'refuses %s',
    (_label, forEach, path, message) => {
      expectRuleRefused(rule(forEach), path, message);
    },
  );

  it('reports every problem of a forEach at once, each with its path', () => {
    const forEach = {
      path: '/foyers/*',
      key: 1,
      orderBy: [{ path: '/a', type: 'x', dir: 'up' }],
      recurse: '/r',
      groupBy: '/g',
      extra: true,
    };
    expect(validateRuleDefinition(rule(forEach)).issues.map((i) => i.path)).toEqual([
      'forEach.extra',
      'forEach.path',
      'forEach.key',
      'forEach.orderBy[0].type',
      'forEach.orderBy[0].dir',
      'forEach.groupBy',
      'forEach.orderBy',
    ]);
  });

  it('reports every problem of segments, facts included (review M3)', () => {
    const forEach = { segments: { from: '/$dates/a', until: '/$dates/a', facts: [3, '/$x'] } };
    expect(validateRuleDefinition(rule(forEach)).issues).toEqual([
      {
        path: 'forEach.segments.until',
        message:
          'forEach.segments.until must differ from forEach.segments.from: ' +
          'the period would be empty',
      },
      {
        path: 'forEach.segments.facts[0]',
        message: 'forEach.segments.facts[0] must be a JSON pointer: got a value of type number',
      },
      {
        path: 'forEach.segments.facts[1]',
        message:
          'forEach.segments.facts[1] must point into the input data: "$x" is an engine variable',
      },
    ]);
  });

  it('refuses a lone surrogate inside forEach as NON_SERIALIZABLE, with its path', () => {
    const value = rule({ path: '/enfants', key: 'i\uD800d' });
    expect(specError(() => normalizeRuleDefinition(value))).toMatchObject({
      code: 'NON_SERIALIZABLE',
      path: 'forEach.key',
    });
    expect(validateRuleDefinition(value).issues.map((i) => i.path)).toEqual(['forEach.key']);
  });

  it('turns a throwing getter into an issue, never a raw error', () => {
    const forEach = {
      path: '/enfants',
      get key(): string {
        throw new Error('boom');
      },
    };
    const message = 'forEach could not be read: boom';
    expectRuleRefused(rule(forEach), 'forEach', message);
  });

  it('is a reserved field: never an extension', () => {
    expect(RESERVED_RULE_FIELDS).toContain('forEach');
    expectRuleRefused(
      rule(42),
      'forEach',
      'forEach must be an object { path, key, orderBy?, dimensions?, recurse?, groupBy? } ' +
        'or { segments }',
    );
  });
});

describe('forEach: normalization', () => {
  it('writes a one-level key list as its one name', () => {
    const one = normalizeRuleDefinition(rule({ path: '/enfants', key: ['id'] }));
    expect(one.forEach).toEqual({ path: '/enfants', key: 'id' });
    expect(computeRuleChecksum(rule({ path: '/enfants', key: ['id'] }))).toBe(
      computeRuleChecksum(rule({ path: '/enfants', key: 'id' })),
    );
  });

  it('writes the same name at every level as that name', () => {
    const forEach = { path: '/foyers/*/personnes', key: ['id', 'id'] };
    expect(normalizeRuleDefinition(rule(forEach)).forEach).toEqual({
      path: '/foyers/*/personnes',
      key: 'id',
    });
  });

  it('keeps the order of orderBy, which has a meaning', () => {
    const first = { path: '/b', type: 'string', dir: 'asc' };
    const second = { path: '/a', type: 'number', dir: 'desc' };
    const out = normalizeRuleDefinition(rule({ path: '/x', key: 'id', orderBy: [first, second] }));
    expect(out.forEach).toEqual({ path: '/x', key: 'id', orderBy: [first, second] });
    expect(computeRuleChecksum(rule({ path: '/x', key: 'id', orderBy: [first, second] }))).not.toBe(
      computeRuleChecksum(rule({ path: '/x', key: 'id', orderBy: [second, first] })),
    );
  });

  it('drops an empty orderBy and empty dimensions, as absent', () => {
    const empty = { path: '/x', key: 'id', orderBy: [], dimensions: {} };
    expect(normalizeRuleDefinition(rule(empty)).forEach).toEqual({ path: '/x', key: 'id' });
    expect(computeRuleChecksum(rule(empty))).toBe(
      computeRuleChecksum(rule({ path: '/x', key: 'id' })),
    );
  });

  it('sorts and deduplicates the facts of segments, by pointer', () => {
    const facts = ['/salaire/b', '/prime', '/salaire', '/prime'];
    const segments = { from: '/$dates/a', until: '/$dates/b', facts };
    expect(normalizeRuleDefinition(rule({ segments })).forEach).toEqual({
      segments: {
        from: '/$dates/a',
        until: '/$dates/b',
        facts: ['/prime', '/salaire', '/salaire/b'],
      },
    });
  });

  it('treats an undefined forEach as absent', () => {
    expect(normalizeRuleDefinition(rule(undefined))).not.toHaveProperty('forEach');
    expect(computeRuleChecksum(rule(undefined))).toBe(computeRuleChecksum(BASE_RULE));
  });

  it('refuses a null forEach: the field must be omitted', () => {
    expect(validateRuleDefinition(rule(null)).errors).toEqual([
      'forEach is null: omit the field instead',
    ]);
  });

  it('never mutates the input and shares no reference with it', () => {
    const forEach = {
      path: '/x',
      key: ['id'],
      orderBy: [{ path: '/a', type: 'date', dir: 'asc' }],
    };
    const copy = structuredClone(forEach);
    const kept = collectionOf(rule(forEach));
    expect(forEach).toEqual(copy);
    expect(kept.orderBy?.[0]).toEqual(forEach.orderBy[0]);
    expect(kept.orderBy?.[0]).not.toBe(forEach.orderBy[0]);
  });

  it('is idempotent', () => {
    for (const [, forEach] of ACCEPTED_FOR_EACH) {
      const once = normalizeRuleDefinition(rule(forEach));
      expect(normalizeRuleDefinition(once)).toEqual(once);
    }
  });

  it('enters the checksum and the fingerprint', () => {
    const plain = rule({ path: '/enfants', key: 'id' });
    expect(computeRuleChecksum(plain)).not.toBe(computeRuleChecksum(BASE_RULE));
    expect(computeRuleFingerprint(plain)).not.toBe(computeRuleFingerprint(BASE_RULE));
    expect(computeRuleChecksum(plain)).not.toBe(
      computeRuleChecksum(rule({ path: '/enfants', key: 'id', groupBy: '/c' })),
    );
  });

  it('reads a long path and many facts in one pass', () => {
    const path = `/a${'/*/b'.repeat(50_000)}`;
    const out = normalizeRuleDefinition(rule({ path, key: 'id' }));
    expect(out.forEach).toEqual({ path, key: 'id' });
    const facts = Array.from({ length: 50_000 }, (_, i) => `/f${49_999 - i}`);
    const segments = { from: '/$dates/a', until: '/$dates/b', facts };
    const kept = segmentsOf(rule({ segments }));
    expect(kept.segments.facts).toHaveLength(50_000);
    expect(kept.segments.facts[0]).toBe('/f0');
  }, 60_000);
});

describe('forEach and effectiveOn', () => {
  it('reads $item only from a collection that gives one item', () => {
    const segments = { from: '/$dates/a', until: '/$dates/b', facts: [] };
    expectRuleRefused(
      { ...rule({ segments }), effectiveOn: '/$item/x' },
      'effectiveOn',
      'effectiveOn reads $item without forEach.path: a segment has no item',
    );
    expectRuleRefused(
      { ...rule({ path: '/ops', key: 'id', groupBy: '/client' }), effectiveOn: '/$item/x' },
      'effectiveOn',
      'effectiveOn reads $item with forEach.groupBy: a group has no single item',
    );
  });

  it('accepts $item with a recursion and $segment with segments', () => {
    const recurse = { ...rule({ path: '/c', key: 'id', recurse: '/c' }), effectiveOn: '/$item/d' };
    expect(validateRuleDefinition(recurse).valid).toBe(true);
    const segments = { from: '/$dates/a', until: '/$dates/b', facts: [] };
    const segmented = { ...rule({ segments }), effectiveOn: '/$segment/from' };
    expect(normalizeRuleDefinition(segmented).effectiveOn).toBe('/$segment/from');
  });

  it('reports only the forEach problem when forEach is invalid', () => {
    const value = { ...rule({ path: '/x' }), effectiveOn: '/$item/d' };
    expect(validateRuleDefinition(value).issues).toEqual([
      {
        path: 'forEach.key',
        message: 'forEach.key is required: the member that identifies each element',
      },
    ]);
  });
});
