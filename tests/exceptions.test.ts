import { describe, expect, it } from 'vitest';
import * as canonicalEntry from '../src/canonical-entry.js';
import {
  computeRuleChecksum,
  computeRuleFingerprint,
  EXCEPTION_MODEL,
  matchesSelector,
  normalizeRuleDefinition,
  SpecError,
  validateRuleDefinition,
  verifyRuleChecksum,
} from '../src/index.js';
import type { RuleDefinitionInput, RuleException, RuleSelector } from '../src/index.js';
import { REFUSED_EXCEPTIONS } from './exception-cases.js';

const base = {
  id: 'r1',
  version: 1,
  model: 'PERCENTAGE',
  params: { rate: 0.05, base: 'orderTotal' },
  priority: 1,
  effectiveFrom: '2025-01-01',
};

/** A rule of the reserved model, which only carries exceptions. */
const carrier = {
  ...base,
  id: 'exempt-exports',
  model: EXCEPTION_MODEL,
  params: {},
  exceptions: [{ kind: 'inhibit', targets: { tags: ['vat'] } }],
};

function issuesOf(value: unknown): { path: string; message: string }[] {
  return validateRuleDefinition(value).issues;
}

/** The `SpecError` normalize throws for `value`; fails the test when it does not throw. */
function normalizeError(value: unknown): SpecError {
  try {
    normalizeRuleDefinition(value as RuleDefinitionInput);
  } catch (error) {
    if (error instanceof SpecError) return error;
    throw error;
  }
  throw new Error('normalizeRuleDefinition accepted the value');
}

describe('EXCEPTION_MODEL', () => {
  it('is the reserved model name, exported by both entries', () => {
    expect(EXCEPTION_MODEL).toBe('@run-iq/exception');
    expect(canonicalEntry.EXCEPTION_MODEL).toBe(EXCEPTION_MODEL);
    expect(canonicalEntry.matchesSelector).toBe(matchesSelector);
  });

  it('accepts a rule that only carries exceptions', () => {
    expect(validateRuleDefinition(carrier)).toEqual({ valid: true, errors: [], issues: [] });
    expect(normalizeRuleDefinition(carrier).exceptions).toEqual(carrier.exceptions);
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['an empty list', []],
  ])('requires exceptions: refuses them %s', (_label, exceptions) => {
    const value = { ...carrier, exceptions };
    const message =
      'exceptions must list at least one exception: ' +
      'a rule of model "@run-iq/exception" only carries exceptions';
    expect(issuesOf(value)).toEqual([{ path: 'exceptions', message }]);
    expect(normalizeError(value)).toMatchObject({ code: 'INVALID_RULE', message });
  });

  it('refuses an output', () => {
    const value = { ...carrier, output: 'tax' };
    const message = 'output must be absent: a rule of model "@run-iq/exception" produces no output';
    expect(issuesOf(value)).toEqual([{ path: 'output', message }]);
    expect(normalizeError(value)).toMatchObject({ code: 'INVALID_RULE', message });
  });

  it.each([
    ['value', undefined],
    ['value', 'rgpd'],
    ['rgpd:value', 'rgpd'],
  ])('accepts output %s in rule set %s, the default output, as absent', (output, ruleSet) => {
    const absent = { ...carrier, ruleSet };
    const value = { ...absent, output };
    expect(validateRuleDefinition(value)).toEqual({ valid: true, errors: [], issues: [] });
    expect(normalizeRuleDefinition(value)).not.toHaveProperty('output');
    expect(computeRuleChecksum(value)).toBe(computeRuleChecksum(absent));
  });

  it.each([
    ['rgpd:x', 'rgpd'],
    ['rgpd:value', undefined],
    ['rgpd:value', 'interne'],
  ])('refuses output %s in rule set %s, which is not the default', (output, ruleSet) => {
    const value = { ...carrier, ruleSet, output };
    const message = 'output must be absent: a rule of model "@run-iq/exception" produces no output';
    expect(issuesOf(value)).toEqual([{ path: 'output', message }]);
    expect(normalizeError(value)).toMatchObject({ code: 'INVALID_RULE', message });
  });

  it('accepts a null output, which means absent', () => {
    expect(validateRuleDefinition({ ...carrier, output: null }).valid).toBe(true);
    expect(computeRuleChecksum({ ...carrier, output: null })).toBe(computeRuleChecksum(carrier));
  });

  it('reports both problems at once', () => {
    expect(issuesOf({ ...carrier, output: 'tax', exceptions: [] }).map((i) => i.path)).toEqual([
      'output',
      'exceptions',
    ]);
  });

  it('makes the checksum functions throw too', () => {
    const value = { ...carrier, exceptions: [] };
    expect(() => computeRuleChecksum(value)).toThrow(SpecError);
    expect(() => verifyRuleChecksum({ ...value, checksum: 'x' })).toThrow(
      expect.objectContaining({ code: 'INVALID_RULE' }),
    );
  });

  it('does not constrain other models', () => {
    expect(validateRuleDefinition({ ...base, output: 'tax' }).valid).toBe(true);
    expect(validateRuleDefinition({ ...base, exceptions: carrier.exceptions }).valid).toBe(true);
  });
});

describe('exceptions: accepted forms', () => {
  const all: RuleException[] = [
    { kind: 'inhibit', targets: { ids: ['vat-standard'] } },
    {
      kind: 'substitute',
      targets: { dimensions: { country: 'TG' }, outputs: ['vat'] },
      params: { rate: 0.1, meta: { note: null } },
    },
    { kind: 'shortCircuit', output: 'eligible', value: false, reason: 'already exempted' },
    { kind: 'shortCircuit', output: 'note', value: null },
  ];

  it('keeps each kind, with null as data inside', () => {
    expect(validateRuleDefinition({ ...base, exceptions: all }).valid).toBe(true);
    expect(normalizeRuleDefinition({ ...base, exceptions: all }).exceptions).toEqual(all);
  });

  it('accepts a selector with every field', () => {
    const targets: RuleSelector = {
      ids: ['a'],
      tags: ['vat'],
      dimensions: { country: 'TG', regime: { ref: 'regimes', anyOf: ['normal'] } },
      outputs: ['value'],
      models: ['PERCENTAGE'],
    };
    const value = { ...base, exceptions: [{ kind: 'inhibit', targets }] };
    expect(validateRuleDefinition(value).valid).toBe(true);
  });

  it('accepts an empty field next to a non-empty one, and drops it', () => {
    const value = {
      ...base,
      exceptions: [{ kind: 'inhibit', targets: { ids: [], tags: ['vat'] } }],
    };
    expect(validateRuleDefinition(value).valid).toBe(true);
    expect(normalizeRuleDefinition(value).exceptions).toEqual([
      { kind: 'inhibit', targets: { tags: ['vat'] } },
    ]);
  });

  it('turns a Date value into its ISO string and drops undefined properties', () => {
    const value = {
      ...base,
      exceptions: [
        {
          kind: 'shortCircuit',
          output: 'since',
          value: new Date('2025-01-01T00:00:00Z'),
          reason: undefined,
        },
      ],
    };
    expect(normalizeRuleDefinition(value).exceptions).toEqual([
      { kind: 'shortCircuit', output: 'since', value: '2025-01-01T00:00:00.000Z' },
    ]);
  });
});

describe('exceptions: refused forms', () => {
  it.each(REFUSED_EXCEPTIONS)('refuses %s', (_label, exceptions, path, message) => {
    const value = { ...base, exceptions };
    expect(issuesOf(value)[0]).toEqual({ path, message });
    expect(normalizeError(value)).toMatchObject({ code: 'INVALID_RULE', message });
  });

  it('reports every problem of every item', () => {
    const value = {
      ...base,
      exceptions: [
        { kind: 'inhibit', targets: { ids: [''], tags: [1] } },
        { kind: 'substitute', targets: {}, params: 1 },
      ],
    };
    expect(issuesOf(value).map((i) => i.path)).toEqual([
      'exceptions[0].targets.ids[0]',
      'exceptions[0].targets.tags[0]',
      'exceptions[1].targets',
      'exceptions[1].params',
    ]);
  });

  it('refuses a non-JSON value inside an exception with its path, as NON_SERIALIZABLE', () => {
    const value = {
      ...base,
      exceptions: [{ kind: 'shortCircuit', output: 'vat', value: Number.NaN }],
    };
    expect(issuesOf(value)).toEqual([
      { path: 'exceptions[0].value', message: expect.stringContaining('exceptions[0].value') },
    ]);
    expect(normalizeError(value)).toMatchObject({
      code: 'NON_SERIALIZABLE',
      path: 'exceptions[0].value',
    });
  });
});

describe('exceptions: normalization', () => {
  it('an empty list is the same as absent', () => {
    const withEmpty = { ...base, exceptions: [] };
    expect(normalizeRuleDefinition(withEmpty)).not.toHaveProperty('exceptions');
    expect(computeRuleChecksum(withEmpty)).toBe(computeRuleChecksum(base));
    expect(computeRuleFingerprint(withEmpty)).toBe(computeRuleFingerprint(base));
  });

  it('sorts and deduplicates ids, tags, outputs and models', () => {
    const value = {
      ...base,
      exceptions: [
        {
          kind: 'inhibit',
          targets: {
            ids: ['c', 'a', 'c', 'b'],
            tags: ['vat', 'export', 'vat'],
            outputs: ['vat', 'value'],
            models: ['PERCENTAGE', 'FLAT', 'FLAT'],
            dimensions: { regime: 'normal', country: 'TG' },
          },
        },
      ],
    };
    expect(normalizeRuleDefinition(value).exceptions).toEqual([
      {
        kind: 'inhibit',
        targets: {
          ids: ['a', 'b', 'c'],
          tags: ['export', 'vat'],
          outputs: ['value', 'vat'],
          models: ['FLAT', 'PERCENTAGE'],
          dimensions: { country: 'TG', regime: 'normal' },
        },
      },
    ]);
  });

  it('writes selector dimension specs in their normal form', () => {
    const value = {
      ...base,
      exceptions: [
        {
          kind: 'inhibit',
          targets: {
            dimensions: {
              pays: { ref: 'ue', anyOf: ['UE', 'NO', 'UE'], except: [], match: 'any' },
              regime: { anyOf: ['normal'] },
            },
          },
        },
      ],
    };
    expect(normalizeRuleDefinition(value).exceptions).toEqual([
      {
        kind: 'inhibit',
        targets: { dimensions: { pays: { ref: 'ue', anyOf: ['NO', 'UE'] }, regime: 'normal' } },
      },
    ]);
  });

  it('the checksum does not depend on the order of ids in a selector', () => {
    const ab = { ...base, exceptions: [{ kind: 'inhibit', targets: { ids: ['a', 'b'] } }] };
    const ba = { ...base, exceptions: [{ kind: 'inhibit', targets: { ids: ['b', 'a', 'b'] } }] };
    expect(computeRuleChecksum(ba)).toBe(computeRuleChecksum(ab));
  });

  it('keeps the order of the exception list, which has a meaning', () => {
    const first = { kind: 'inhibit', targets: { ids: ['a'] } };
    const second = { kind: 'shortCircuit', output: 'vat', value: 0 };
    const forward = { ...base, exceptions: [first, second] };
    const backward = { ...base, exceptions: [second, first] };
    expect(normalizeRuleDefinition(backward).exceptions).toEqual([second, first]);
    expect(computeRuleChecksum(backward)).not.toBe(computeRuleChecksum(forward));
  });

  it('does not touch the order inside substitute params', () => {
    const value = {
      ...base,
      exceptions: [
        { kind: 'substitute', targets: { ids: ['a'] }, params: { brackets: [3, 1, 2] } },
      ],
    };
    expect(normalizeRuleDefinition(value).exceptions).toEqual(value.exceptions);
  });

  it('never mutates the input', () => {
    const ids = ['b', 'a'];
    const value = { ...base, exceptions: [{ kind: 'inhibit', targets: { ids } }] };
    normalizeRuleDefinition(value);
    expect(ids).toEqual(['b', 'a']);
  });

  it('keeps a __proto__ dimension key as data', () => {
    const dimensions = JSON.parse('{"__proto__":"x"}') as Record<string, string>;
    const value = { ...base, exceptions: [{ kind: 'inhibit', targets: { dimensions } }] };
    const [exception] = normalizeRuleDefinition(value).exceptions ?? [];
    expect(
      exception?.kind === 'inhibit' && Object.keys(exception.targets.dimensions ?? {}),
    ).toEqual(['__proto__']);
  });
});

describe('matchesSelector', () => {
  const rule = {
    id: 'vat-standard',
    tags: ['fiscal', 'vat'],
    dimensions: { country: 'TG', regime: 'normal' },
    output: 'vat',
    model: 'PERCENTAGE',
  };

  it('matches on each field alone', () => {
    expect(matchesSelector(rule, { ids: ['vat-standard'] })).toBe(true);
    expect(matchesSelector(rule, { tags: ['vat'] })).toBe(true);
    expect(matchesSelector(rule, { dimensions: { country: 'TG' } })).toBe(true);
    expect(matchesSelector(rule, { outputs: ['vat'] })).toBe(true);
    expect(matchesSelector(rule, { models: ['PERCENTAGE'] })).toBe(true);
  });

  it('OR inside a field', () => {
    expect(matchesSelector(rule, { ids: ['other', 'vat-standard'] })).toBe(true);
    expect(matchesSelector(rule, { tags: ['income', 'vat'] })).toBe(true);
    expect(matchesSelector(rule, { ids: ['other', 'another'] })).toBe(false);
    expect(matchesSelector(rule, { models: ['FLAT'] })).toBe(false);
  });

  it('AND between fields', () => {
    expect(matchesSelector(rule, { tags: ['vat'], models: ['PERCENTAGE'] })).toBe(true);
    expect(matchesSelector(rule, { tags: ['vat'], models: ['FLAT'] })).toBe(false);
    expect(matchesSelector(rule, { ids: ['vat-standard'], outputs: ['value'] })).toBe(false);
  });

  it('dimensions require every key to be equal', () => {
    expect(matchesSelector(rule, { dimensions: { country: 'TG', regime: 'normal' } })).toBe(true);
    expect(matchesSelector(rule, { dimensions: { country: 'TG', regime: 'simplified' } })).toBe(
      false,
    );
    expect(matchesSelector(rule, { dimensions: { country: 'TG', sector: 'mining' } })).toBe(false);
  });

  it('compares the written dimension, never the membership (X-10)', () => {
    const fr = { ...rule, dimensions: { pays: 'FR' } };
    expect(matchesSelector(fr, { dimensions: { pays: 'UE' } })).toBe(false);
    expect(matchesSelector(fr, { dimensions: { pays: { ref: 'ue', anyOf: ['UE'] } } })).toBe(false);
    expect(matchesSelector(fr, { dimensions: { pays: 'FR' } })).toBe(true);
  });

  it('compares structured dimensions in their normal form (X-10)', () => {
    const written = { ...rule, dimensions: { pays: { ref: 'ue', anyOf: ['NO', 'UE'] } } };
    const selector = { dimensions: { pays: { ref: 'ue', anyOf: ['UE', 'NO'] } } };
    expect(matchesSelector(written, selector)).toBe(true);
    expect(matchesSelector(written, { dimensions: { pays: { ref: 'ue', anyOf: ['UE'] } } })).toBe(
      false,
    );
    expect(
      matchesSelector(written, { dimensions: { pays: { ref: 'eu', anyOf: ['NO', 'UE'] } } }),
    ).toBe(false);
    expect(
      matchesSelector(written, {
        dimensions: { pays: { ref: 'ue', anyOf: ['NO', 'UE'], match: 'all' } },
      }),
    ).toBe(false);
    expect(
      matchesSelector(written, {
        dimensions: { pays: { ref: 'ue', anyOf: ['NO', 'UE'], except: ['DK'] } },
      }),
    ).toBe(false);
  });

  it('a lone anyOf value is the value itself, on either side', () => {
    const fr = { ...rule, dimensions: { pays: { anyOf: ['FR'] } } };
    expect(matchesSelector(fr, { dimensions: { pays: 'FR' } })).toBe(true);
    expect(
      matchesSelector(
        { ...rule, dimensions: { pays: 'FR' } },
        {
          dimensions: { pays: { anyOf: ['FR'] } },
        },
      ),
    ).toBe(true);
  });

  it('refuses an invalid dimension spec with a SpecError', () => {
    expect(() => matchesSelector(rule, { dimensions: { country: { anyOf: [] } } })).toThrow(
      expect.objectContaining({ code: 'INVALID_RULE' }),
    );
  });

  it('a dimension key the rule only inherits does not match', () => {
    expect(matchesSelector(rule, { dimensions: { toString: 'x' } })).toBe(false);
    expect(matchesSelector(rule, { dimensions: { constructor: 'Object' } })).toBe(false);
  });

  it('outputs compare the default output when the rule has none', () => {
    const noOutput = {
      id: rule.id,
      tags: rule.tags,
      dimensions: rule.dimensions,
      model: rule.model,
    };
    expect(matchesSelector(noOutput, { outputs: ['value'] })).toBe(true);
    expect(matchesSelector(noOutput, { outputs: ['vat'] })).toBe(false);
    expect(matchesSelector(rule, { outputs: ['value'] })).toBe(false);
  });

  it('an empty field puts no constraint, like an absent one', () => {
    expect(matchesSelector(rule, { ids: [], tags: ['vat'] })).toBe(true);
    expect(matchesSelector(rule, { dimensions: {}, models: ['PERCENTAGE'] })).toBe(true);
  });

  it('a selector that constrains nothing matches nothing', () => {
    expect(matchesSelector(rule, {})).toBe(false);
    expect(matchesSelector(rule, { ids: [], dimensions: {} })).toBe(false);
  });
});
