/**
 * Task 9K5, the rule side: an unknown top-level field is refused (I13), extensions live under
 * `extensions` and enter the checksum, `null` is refused in a rule (M8), a date holds at most
 * three fractional digits (M9). The checksums of rules without extension are frozen.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  computeRuleChecksum,
  computeRuleFingerprint,
  normalizeRuleDefinition,
  RESERVED_RULE_FIELDS,
  validateRuleDefinition,
} from '../src/index.js';
import type { RuleDefinitionInput } from '../src/index.js';
import { parseRuleDate } from '../src/rule/date.js';
import { specError } from './helpers.js';

const base = {
  id: 'r1',
  version: 1,
  model: 'PERCENTAGE',
  params: { rate: 0.05, base: 'orderTotal' },
  priority: 1,
  effectiveFrom: '2025-01-01',
};

/** A rule with a field the types do not know: what a typo or a stale extension looks like. */
const withField = (field: string, ...given: [] | [unknown]): RuleDefinitionInput =>
  ({ ...base, [field]: given.length === 0 ? 'x' : given[0] }) as unknown as RuleDefinitionInput;

describe('frozen checksums: a rule with no extension and no null keeps its checksum', () => {
  const full = {
    ...base,
    id: 'full',
    effectiveUntil: '2026-01-01',
    timeZone: 'Europe/Paris',
    condition: { dsl: 'jsonlogic', value: { '>': [{ var: 'x' }, 1] } },
    ruleSet: 'vat',
    output: 'tax',
    dimensions: { country: { anyOf: ['FR', 'BE'] }, kind: 'b2b' },
    tags: ['b', 'a'],
    dominanceGroup: 'g',
    sourceRef: 'art. 1',
  };
  it.each([
    ['minimal', base, '9e0794daa99ac486a3deb903c5e21b5a6cf45303aa69f42c997b32e48bb718f3'],
    [
      'every optional field',
      full,
      '3e996bc25354826147cf9319e7789811d206442edd5f5e0663327181824d8bbc',
    ],
    [
      'instant bounds',
      {
        ...base,
        id: 'inst',
        effectiveFrom: '2025-01-01T00:00:00Z',
        effectiveUntil: '2026-01-01T00:00:00Z',
      },
      'b24b79f1c12f702065078fd44648742060a8d40b8be0fd69bc86dbd3a154979e',
    ],
  ])('%s', (_name, rule, checksum) => {
    expect(computeRuleChecksum(rule)).toBe(checksum);
  });

  it('the only null a rule accepts, effectiveUntil, gives the same checksum as its absence', () => {
    expect(computeRuleChecksum({ ...base, effectiveUntil: null })).toBe(
      '9e0794daa99ac486a3deb903c5e21b5a6cf45303aa69f42c997b32e48bb718f3',
    );
  });

  it('a normalized rule is read again as it is', () => {
    const once = normalizeRuleDefinition(full);
    expect(normalizeRuleDefinition(once as unknown as RuleDefinitionInput)).toEqual(once);
    const open = normalizeRuleDefinition(base);
    expect(open.effectiveUntil).toBeNull();
    expect(normalizeRuleDefinition(open as unknown as RuleDefinitionInput)).toEqual(open);
  });
});

describe('I13: an unknown top-level field is refused, and a typo is named', () => {
  it('a field of a reserved name in another case', () => {
    const rule = withField('dominancegroup', 'g');
    const result = validateRuleDefinition(rule);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      'unknown rule field: dominancegroup (did you mean dominanceGroup?)',
    ]);
    expect(result.issues).toEqual([
      {
        path: 'dominancegroup',
        message: 'unknown rule field: dominancegroup (did you mean dominanceGroup?)',
      },
    ]);
    const error = specError(() => normalizeRuleDefinition(rule));
    expect(error.code).toBe('INVALID_RULE');
    expect(error.message).toBe('unknown rule field: dominancegroup (did you mean dominanceGroup?)');
    expect(specError(() => computeRuleChecksum(rule)).message).toBe(error.message);
    expect(specError(() => computeRuleFingerprint(rule)).message).toBe(error.message);
  });

  it.each([
    ['effectiveUntill', 'effectiveUntil'],
    ['exception', 'exceptions'],
    ['Extensions', 'extensions'],
    ['sourceRef2', 'sourceRef'],
    ['priorty', 'priority'],
    ['ruleset', 'ruleSet'],
    ['dimension', 'dimensions'],
    ['Checksum', 'checksum'],
    ['efectiveFrom', 'effectiveFrom'],
  ])('%s: did you mean %s', (field, wanted) => {
    expect(validateRuleDefinition(withField(field)).errors).toEqual([
      `unknown rule field: ${field} (did you mean ${wanted}?)`,
    ]);
  });

  it('a transposition of two letters is named too', () => {
    expect(validateRuleDefinition(withField('modle')).errors).toEqual([
      'unknown rule field: modle (did you mean model?)',
    ]);
  });

  it('a field close to nothing is named without a suggestion', () => {
    for (const field of ['jurisdiction', 'x', 'zone']) {
      const message = `unknown rule field: ${field}`;
      expect(validateRuleDefinition(withField(field)).errors).toEqual([message]);
      expect(specError(() => normalizeRuleDefinition(withField(field))).message).toBe(message);
    }
  });

  it('an unknown field is refused whatever its value, null and undefined included', () => {
    for (const value of ['x', 1, true, [], {}, null]) {
      expect(validateRuleDefinition(withField('jurisdiction', value)).errors).toEqual([
        'unknown rule field: jurisdiction',
      ]);
    }
    expect(validateRuleDefinition(withField('jurisdiction', undefined)).errors).toEqual([
      'unknown rule field: jurisdiction',
    ]);
  });

  it('every unknown field is listed, in the order found', () => {
    const rule = { ...base, zeta: 1, dominancegroup: 'g' } as unknown as RuleDefinitionInput;
    expect(validateRuleDefinition(rule).errors).toEqual([
      'unknown rule field: zeta',
      'unknown rule field: dominancegroup (did you mean dominanceGroup?)',
    ]);
  });

  it('names the field safely when its name is hostile', () => {
    expect(validateRuleDefinition(withField('a"b\n')).errors).toEqual([
      'unknown rule field: a\\"b\\n',
    ]);
  });

  it('a field called __proto__ is refused like any other', () => {
    const rule = JSON.parse(
      '{"id":"r1","version":1,"model":"M","params":1,"priority":1,"effectiveFrom":"2025-01-01","__proto__":{"a":1}}',
    ) as RuleDefinitionInput;
    expect(validateRuleDefinition(rule).errors).toEqual(['unknown rule field: __proto__']);
  });

  it('every reserved field, extensions included, is accepted', () => {
    expect(RESERVED_RULE_FIELDS).toContain('extensions');
    expect(RESERVED_RULE_FIELDS).toHaveLength(20);
  });
});

describe('I13: extensions go under `extensions`, covered by the checksum', () => {
  const ext = (extensions: unknown): RuleDefinitionInput =>
    ({ ...base, extensions }) as unknown as RuleDefinitionInput;

  it('are kept, and enter the checksum and the fingerprint', () => {
    const rule = ext({ jurisdiction: 'NATIONAL', zone: { a: [1, 2] } });
    expect(validateRuleDefinition(rule)).toEqual({ valid: true, errors: [], issues: [] });
    expect(normalizeRuleDefinition(rule).extensions).toEqual({
      jurisdiction: 'NATIONAL',
      zone: { a: [1, 2] },
    });
    expect(computeRuleChecksum(ext({ jurisdiction: 'NATIONAL' }))).not.toBe(
      computeRuleChecksum(ext({ jurisdiction: 'REGIONAL' })),
    );
    expect(computeRuleChecksum(ext({ jurisdiction: 'NATIONAL' }))).not.toBe(
      computeRuleChecksum(base),
    );
    expect(computeRuleFingerprint(ext({ jurisdiction: 'NATIONAL' }))).not.toBe(
      computeRuleFingerprint(ext({ jurisdiction: 'REGIONAL' })),
    );
  });

  it('the checksum of a rule with extensions is frozen', () => {
    expect(
      computeRuleChecksum({
        ...base,
        id: 'ext',
        extensions: { jurisdiction: 'NATIONAL' },
      } as RuleDefinitionInput),
    ).toBe('6b3f458bac56902f7a08c6afdcd476fad988f1e3d7e11080ee27a55efc8f9c35');
  });

  it('the checksum is the sha256 of the canonical definition, extensions under their name', () => {
    const canonical =
      '{"dimensions":{},"effectiveFrom":"2025-01-01","effectiveUntil":null,' +
      '"extensions":{"jurisdiction":"NATIONAL"},"id":"ext","model":"PERCENTAGE",' +
      '"params":{"base":"orderTotal","rate":0.05},"priority":1,"tags":[],"version":1}';
    const rule = { ...base, id: 'ext', extensions: { jurisdiction: 'NATIONAL' } };
    expect(computeRuleChecksum(rule)).toBe(createHash('sha256').update(canonical).digest('hex'));
  });

  it('the checksum is the sha256 of the canonical definition, extensions under their name', () => {
    const canonical =
      '{"dimensions":{},"effectiveFrom":"2025-01-01","effectiveUntil":null,' +
      '"extensions":{"jurisdiction":"NATIONAL"},"id":"ext","model":"PERCENTAGE",' +
      '"params":{"base":"orderTotal","rate":0.05},"priority":1,"tags":[],"version":1}';
    const rule = { ...base, id: 'ext', extensions: { jurisdiction: 'NATIONAL' } };
    expect(computeRuleChecksum(rule)).toBe(createHash('sha256').update(canonical).digest('hex'));
  });

  it('the order of the keys does not matter', () => {
    expect(computeRuleChecksum(ext({ a: 1, b: 2 }))).toBe(computeRuleChecksum(ext({ b: 2, a: 1 })));
  });

  it('an empty `extensions` is absent: same checksum as no field', () => {
    expect(computeRuleChecksum(ext({}))).toBe(computeRuleChecksum(base));
    expect('extensions' in normalizeRuleDefinition(ext({}))).toBe(false);
  });

  it('a name that is a reserved field is fine under `extensions`', () => {
    const rule = ext({ id: 'other', dominanceGroup: 'g' });
    expect(validateRuleDefinition(rule).valid).toBe(true);
    expect(normalizeRuleDefinition(rule).id).toBe('r1');
    expect(normalizeRuleDefinition(rule).extensions).toEqual({ id: 'other', dominanceGroup: 'g' });
  });

  it('null inside `extensions` is data, kept', () => {
    expect(normalizeRuleDefinition(ext({ a: null })).extensions).toEqual({ a: null });
    expect(computeRuleChecksum(ext({ a: null }))).not.toBe(computeRuleChecksum(ext({})));
  });

  it.each([
    ['a string', 'x'],
    ['a number', 1],
    ['a list', [1]],
  ])('`extensions` as %s is refused', (_name, value) => {
    const message = 'extensions must be an object';
    expect(validateRuleDefinition(ext(value)).errors).toEqual([message]);
    expect(specError(() => normalizeRuleDefinition(ext(value))).message).toBe(message);
  });

  it('`extensions: null` is refused like any null', () => {
    expect(validateRuleDefinition(ext(null)).errors).toEqual([
      'extensions is null: omit the field instead',
    ]);
  });

  it('a value that is not JSON is refused under its path', () => {
    expect(validateRuleDefinition(ext({ a: undefined })).errors).toEqual([
      'extensions.a is not JSON: undefined',
    ]);
    expect(validateRuleDefinition(ext({ a: Number.NaN })).errors).toHaveLength(1);
    expect(specError(() => normalizeRuleDefinition(ext({ f: () => 1 }))).code).toBe(
      'NON_SERIALIZABLE',
    );
  });

  it('a key with a lone surrogate is refused', () => {
    expect(validateRuleDefinition(ext({ '\ud800': 1 })).valid).toBe(false);
    expect(specError(() => normalizeRuleDefinition(ext({ '\ud800': 1 }))).code).toBe(
      'NON_SERIALIZABLE',
    );
  });
});

describe('M8: null is refused in a rule, the field to omit is named', () => {
  it.each([
    'condition',
    'timeZone',
    'effectiveOn',
    'forEach',
    'ruleSet',
    'output',
    'dimensions',
    'tags',
    'dominanceGroup',
    'exceptions',
    'sourceRef',
    'extensions',
  ])('%s: null', (field) => {
    const rule = withField(field, null);
    const message = `${field} is null: omit the field instead`;
    expect(validateRuleDefinition(rule).errors).toEqual([message]);
    expect(validateRuleDefinition(rule).issues).toEqual([{ path: field, message }]);
    const error = specError(() => normalizeRuleDefinition(rule));
    expect(error.code).toBe('INVALID_RULE');
    expect(error.message).toBe(message);
  });

  it('a required field that is null keeps its own message', () => {
    expect(validateRuleDefinition(withField('model', null)).errors).toEqual([
      'model must be a non-empty string',
    ]);
    expect(validateRuleDefinition(withField('priority', null)).errors).toEqual([
      'priority must be a finite number',
    ]);
  });

  it('`params: null` is data', () => {
    expect(validateRuleDefinition(withField('params', null)).valid).toBe(true);
  });

  it('`effectiveFrom: null` is refused as a date', () => {
    expect(validateRuleDefinition(withField('effectiveFrom', null)).valid).toBe(false);
  });

  it('`effectiveUntil: null` is the canonical "no end" and stays accepted', () => {
    expect(validateRuleDefinition(withField('effectiveUntil', null)).valid).toBe(true);
  });

  it('a null in `dimensions` is refused, its dimension named', () => {
    const rule = withField('dimensions', { country: null, kind: 'b2b' });
    const message = 'dimensions.country is null: omit the field instead';
    expect(validateRuleDefinition(rule).errors).toEqual([message]);
    expect(validateRuleDefinition(rule).issues).toEqual([{ path: 'dimensions.country', message }]);
    expect(specError(() => normalizeRuleDefinition(rule)).message).toBe(message);
  });

  it('every null of `dimensions` is listed', () => {
    const rule = withField('dimensions', { a: null, b: null });
    expect(validateRuleDefinition(rule).errors).toEqual([
      'dimensions.a is null: omit the field instead',
      'dimensions.b is null: omit the field instead',
    ]);
  });

  it('a null inside a dimension spec keeps its own message', () => {
    expect(validateRuleDefinition(withField('dimensions', { a: { anyOf: [null] } })).valid).toBe(
      false,
    );
  });

  it('the ignored `checksum` may still be null', () => {
    expect(validateRuleDefinition(withField('checksum', null)).valid).toBe(true);
    expect(computeRuleChecksum(withField('checksum', null))).toBe(computeRuleChecksum(base));
  });

  it('absence and undefined are still absence', () => {
    expect(computeRuleChecksum(withField('dominanceGroup', undefined))).toBe(
      computeRuleChecksum(base),
    );
    expect(computeRuleChecksum(withField('dimensions', { a: undefined }))).toBe(
      computeRuleChecksum(base),
    );
  });
});

describe('M9: a date holds at most three fractional digits', () => {
  it.each(['00.1234Z', '00.123456Z', '00.123456789Z', '00.1000Z', '00.0000Z'])(
    '%s is refused, not truncated',
    (tail) => {
      const error = specError(() => parseRuleDate(`2026-01-01T00:00:${tail}`, 'evaluatedAt'));
      expect(error.code).toBe('INVALID_DATE');
      expect(error.message).toBe(
        `evaluatedAt must be a Date, YYYY-MM-DD, or an ISO date-time with Z or an offset; got "2026-01-01T00:00:${tail}" (at most 3 fractional digits)`,
      );
    },
  );

  it.each([
    ['00.1Z', 100],
    ['00.12Z', 120],
    ['00.123Z', 123],
    ['00.123+01:00', 123],
    ['00Z', 0],
  ])('%s is read', (tail, ms) => {
    const date = parseRuleDate(`2026-01-01T00:00:${tail}`, 'evaluatedAt');
    expect(date.getUTCMilliseconds()).toBe(ms);
  });
});

describe('the schema and the validator agree on the new rules', () => {
  it('the schema refuses an unknown field and holds `extensions`', () => {
    const schema = JSON.parse(readFileSync('schema/rule-definition.schema.json', 'utf8')) as {
      additionalProperties: unknown;
      properties: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toContain('extensions');
    expect(Object.keys(schema.properties).sort()).toEqual([...RESERVED_RULE_FIELDS].sort());
  });
});
