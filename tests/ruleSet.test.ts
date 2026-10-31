import { describe, expect, it } from 'vitest';
import {
  computeRuleChecksum,
  computeRuleFingerprint,
  findOverlappingVersions,
  isPackId,
  isRuleSetId,
  LOCAL_RULE_SET,
  matchesSelector,
  normalizeRuleDefinition,
  packIdProblem,
  qualifyName,
  RESERVED_RULE_FIELDS,
  validateRuleDefinition,
} from '../src/index.js';
import type { RuleDefinitionInput, RuleSelector, VersionedRuleWindow } from '../src/index.js';
import { BASE_RULE, expectRuleRefused, fixedCalendar, specError } from './helpers.js';

const RULE_SET_ID = 'ruleSet must be a rule set id matching ^[a-z0-9][a-z0-9_-]*$';

describe('rule set ids (D-4)', () => {
  it('names the rules without a rule set local', () => {
    expect(LOCAL_RULE_SET).toBe('local');
  });

  it.each(['local', 'rgpd', 'a_b-1', 'p-v2', '0x', 'tva2026', 'a'])('accepts the id %j', (id) => {
    expect(isRuleSetId(id)).toBe(true);
  });

  it.each([
    'Local',
    'a:b',
    '',
    '-a',
    '.a',
    '_a',
    'p.v2',
    'a.',
    ' a',
    'a b',
    'é',
    'a/b',
    1,
    null,
    undefined,
  ])('refuses the id %j', (id) => {
    expect(isRuleSetId(id)).toBe(false);
    expect(isPackId(id)).toBe(false);
  });

  it('refuses local as a pack id, with a named issue', () => {
    expect(isPackId('local')).toBe(false);
    expect(isPackId('rgpd')).toBe(true);
    expect(packIdProblem('rgpd')).toBeUndefined();
    expect(packIdProblem('local')).toBe(
      'pack id "local" is reserved: it names the rules without a rule set',
    );
    expect(packIdProblem('Rgpd')).toBe('pack id "Rgpd" must match ^[a-z0-9][a-z0-9_-]*$');
    expect(packIdProblem(7)).toBe('a pack id must be a string, got a value of type number');
  });
});

describe('a version is never part of a rule set id (D-4, tightened)', () => {
  const DOT = 'must not contain ".": a version is never part of a rule set id';

  it('refuses p.v2 with a named issue wherever a rule set id is written', () => {
    expect(packIdProblem('p.v2')).toBe(`pack id "p.v2" ${DOT}`);
    expectRuleRefused({ ...BASE_RULE, ruleSet: 'p.v2' }, 'ruleSet', `ruleSet ${DOT}`);
    expectRuleRefused(
      {
        ...BASE_RULE,
        exceptions: [{ kind: 'inhibit', targets: { ruleSets: ['p.v2'], tags: ['t'] } }],
      },
      'exceptions[0].targets.ruleSets[0]',
      `exceptions[0].targets.ruleSets[0] ${DOT}`,
    );
    expect(specError(() => qualifyName('p.v2', 'x'))).toMatchObject({
      code: 'INVALID_RULE',
      message: `qualifyName: "p.v2" ${DOT}`,
    });
    expect(
      specError(() =>
        findOverlappingVersions(
          [{ id: 'R1', version: 1, ruleSet: 'p.v2', effectiveFrom: '2025-01-01' }],
          'UTC',
          fixedCalendar,
        ),
      ),
    ).toMatchObject({ code: 'INVALID_RULE', message: `rule R1@1: ruleSet ${DOT}` });
  });

  it('accepts p-v2 and its qualified names', () => {
    expect(isPackId('p-v2')).toBe(true);
    expect(qualifyName('p-v2', 'x')).toBe('p-v2:x');
    const rule = { ...BASE_RULE, output: 'p-v2:x', ruleSet: 'p-v2' };
    expect(validateRuleDefinition(rule).valid).toBe(true);
    expect(normalizeRuleDefinition(rule).output).toBe('x');
    expect(validateRuleDefinition({ ...BASE_RULE, output: 'p-v2:x' }).valid).toBe(true);
  });
});

describe('qualifyName', () => {
  it('keeps a local name bare and qualifies any other', () => {
    expect(qualifyName('local', 'x')).toBe('x');
    expect(qualifyName('rgpd', 'profilage')).toBe('rgpd:profilage');
    expect(qualifyName(LOCAL_RULE_SET, 'R1')).toBe('R1');
  });

  it.each([
    ['Local', 'x', 'qualifyName: "Local" is not a rule set id (^[a-z0-9][a-z0-9_-]*$)'],
    ['rgpd', 'a:b', 'qualifyName: "a:b" is not a bare name: it is empty or holds ":"'],
    ['rgpd', '', 'qualifyName: "" is not a bare name: it is empty or holds ":"'],
    [1, 'x', 'qualifyName: a rule set id must be a string, got a value of type number'],
    ['rgpd', null, 'qualifyName: a name must be a string, got a value of type null'],
  ])('refuses qualifyName(%j, %j)', (ruleSet, name, message) => {
    // Hostile input on purpose: the signature takes strings, a JavaScript caller may not.
    const call = (): unknown => qualifyName(ruleSet as string, name as string);
    expect(specError(call)).toMatchObject({ code: 'INVALID_RULE', message });
  });
});

describe('the ruleSet field', () => {
  it('keeps a pack id', () => {
    expect(normalizeRuleDefinition({ ...BASE_RULE, ruleSet: 'rgpd' }).ruleSet).toBe('rgpd');
  });

  it("drops 'local' and null, as absent: one rule, one checksum", () => {
    for (const ruleSet of ['local', null, undefined]) {
      const value = { ...BASE_RULE, ruleSet };
      expect(normalizeRuleDefinition(value)).not.toHaveProperty('ruleSet');
      expect(computeRuleChecksum(value)).toBe(computeRuleChecksum(BASE_RULE));
    }
  });

  it.each([['Local'], ['a:b'], [''], [' rgpd'], [3], [{ id: 'rgpd' }]])(
    'refuses ruleSet %j',
    (ruleSet) => {
      expectRuleRefused({ ...BASE_RULE, ruleSet }, 'ruleSet', RULE_SET_ID);
    },
  );

  it('is a reserved field that enters the checksum and the fingerprint', () => {
    expect(RESERVED_RULE_FIELDS).toEqual(expect.arrayContaining(['ruleSet', 'forEach']));
    expect(RESERVED_RULE_FIELDS).toEqual(expect.arrayContaining(['timeZone', 'effectiveOn']));
    const packed = { ...BASE_RULE, ruleSet: 'rgpd' };
    expect(computeRuleChecksum(packed)).not.toBe(computeRuleChecksum(BASE_RULE));
    expect(computeRuleFingerprint(packed)).not.toBe(computeRuleFingerprint(BASE_RULE));
  });
});

describe('the default output (review M6)', () => {
  it("drops output 'value', the default: absent and 'value' are one rule", () => {
    const explicit = { ...BASE_RULE, output: 'value' };
    expect(normalizeRuleDefinition(explicit)).not.toHaveProperty('output');
    expect(computeRuleChecksum(explicit)).toBe(computeRuleChecksum(BASE_RULE));
  });

  it('drops the default output of a pack, written qualified by the pack', () => {
    const packed = { ...BASE_RULE, ruleSet: 'rgpd' };
    const qualified = { ...packed, output: 'rgpd:value' };
    expect(normalizeRuleDefinition(qualified)).not.toHaveProperty('output');
    expect(computeRuleChecksum(qualified)).toBe(computeRuleChecksum(packed));
  });

  it("keeps another rule set's value, which is not the default", () => {
    const local = { ...BASE_RULE, output: 'rgpd:value' };
    expect(normalizeRuleDefinition(local).output).toBe('rgpd:value');
  });
});

describe('rule ids (D-4)', () => {
  it('refuses ":" in an id', () => {
    expectRuleRefused({ ...BASE_RULE, id: 'rgpd:R1' }, 'id', 'id must not contain ":"');
  });

  it('accepts any other id', () => {
    expect(validateRuleDefinition({ ...BASE_RULE, id: 'R1.a/b-$' }).valid).toBe(true);
  });
});

describe('output names (D-4, pre-flight M-14)', () => {
  it.each(['x', 'pack:x', 'a-b', 'a_b:c d', 'p-v2:x'])('accepts the output %j', (output) => {
    expect(validateRuleDefinition({ ...BASE_RULE, output }).valid).toBe(true);
    expect(normalizeRuleDefinition({ ...BASE_RULE, output }).output).toBe(output);
  });

  it.each([
    ['a:b:c', 'output name must hold at most one ":": <rule set>:<name>'],
    [
      'pack:$x',
      'output name must not start with "$" after ":": output names starting with "$" are reserved',
    ],
    ['a.b', 'output name must not contain "."'],
    ['pack:a.b', 'output name must not contain "."'],
    ['p.v2:x', 'output name must not contain "."'],
    ['local:x', 'output name must not be qualified by "local": a local name is written bare'],
    ['Pack:x', 'output name must start with a rule set id before ":": ^[a-z0-9][a-z0-9_-]*$'],
    [':x', 'output name must start with a rule set id before ":": ^[a-z0-9][a-z0-9_-]*$'],
    ['pack:', 'output name must name an output after ":"'],
  ])('refuses the output %j', (output, message) => {
    expectRuleRefused({ ...BASE_RULE, output }, 'output', message);
  });

  it('writes a name qualified by its own rule set bare: one meaning, one checksum', () => {
    const qualified = { ...BASE_RULE, ruleSet: 'rgpd', output: 'rgpd:profilage' };
    const bare = { ...BASE_RULE, ruleSet: 'rgpd', output: 'profilage' };
    expect(normalizeRuleDefinition(qualified).output).toBe('profilage');
    expect(computeRuleChecksum(qualified)).toBe(computeRuleChecksum(bare));
    const other = { ...BASE_RULE, ruleSet: 'rgpd', output: 'aiact:risque' };
    expect(normalizeRuleDefinition(other).output).toBe('aiact:risque');
  });

  it('refuses the same names in a shortCircuit and in selector outputs', () => {
    expectRuleRefused(
      { ...BASE_RULE, exceptions: [{ kind: 'shortCircuit', output: 'a.b', value: 1 }] },
      'exceptions[0].output',
      'exceptions[0].output name must not contain "."',
    );
    expectRuleRefused(
      { ...BASE_RULE, exceptions: [{ kind: 'inhibit', targets: { outputs: ['x', 'a:b:c'] } }] },
      'exceptions[0].targets.outputs[1]',
      'exceptions[0].targets.outputs[1] name must hold at most one ":": <rule set>:<name>',
    );
  });
});

describe('selectors with ruleSets', () => {
  const inhibit = (targets: unknown, ruleSet?: string): RuleDefinitionInput => ({
    ...BASE_RULE,
    ...(ruleSet === undefined ? {} : { ruleSet }),
    exceptions: [{ kind: 'inhibit', targets }],
  });
  const targetsOf = (value: RuleDefinitionInput): unknown => {
    const [exception] = normalizeRuleDefinition(value).exceptions ?? [];
    return exception?.kind === 'inhibit' ? exception.targets : undefined;
  };

  it('targets a rule of rgpd that feeds profilage', () => {
    const rgpd = { id: 'R1', ruleSet: 'rgpd', tags: [], dimensions: {}, model: 'M' };
    const selector = { ruleSets: ['rgpd'], outputs: ['rgpd:profilage'] };
    expect(matchesSelector({ ...rgpd, output: 'profilage' }, selector)).toBe(true);
    expect(matchesSelector({ ...rgpd, output: 'autre' }, selector)).toBe(false);
    expect(matchesSelector({ ...rgpd, ruleSet: 'aiact', output: 'profilage' }, selector)).toBe(
      false,
    );
    expect(matchesSelector({ ...rgpd, ruleSet: undefined, output: 'profilage' }, selector)).toBe(
      false,
    );
  });

  it("ruleSets: ['local'] targets a rule without a rule set", () => {
    const local = { id: 'R1', tags: ['t'], dimensions: {}, model: 'M' };
    const selector = { ruleSets: ['local'], tags: ['t'] };
    expect(matchesSelector(local, selector, 'rgpd')).toBe(true);
    expect(matchesSelector({ ...local, ruleSet: 'rgpd' }, selector, 'rgpd')).toBe(false);
  });

  it("without ruleSets, a selector targets only its carrier's rule set (D-37)", () => {
    const rgpd = { id: 'R1', ruleSet: 'rgpd', tags: [], dimensions: {}, model: 'M' };
    const local = { id: 'R1', tags: [], dimensions: {}, model: 'M' };
    expect(matchesSelector(rgpd, { ids: ['R1'] }, 'rgpd')).toBe(true);
    expect(matchesSelector(local, { ids: ['R1'] }, 'rgpd')).toBe(false);
    expect(matchesSelector(local, { ids: ['R1'] })).toBe(true);
    expect(matchesSelector(rgpd, { ids: ['R1'] })).toBe(false);
  });

  it('resolves bare names in the carrier and qualified names as written (D-37)', () => {
    const interne = {
      id: 'R1',
      ruleSet: 'interne',
      tags: [],
      dimensions: {},
      model: 'M',
      output: 'taux',
    };
    const targets = { ruleSets: ['interne'], ids: ['interne:R1'] };
    expect(matchesSelector(interne, targets, 'convention')).toBe(true);
    expect(matchesSelector(interne, { ruleSets: ['interne'], ids: ['R1'] }, 'convention')).toBe(
      false,
    );
    expect(matchesSelector(interne, { ruleSets: ['interne'], outputs: ['taux'] }, 'interne')).toBe(
      true,
    );
    const feeding = { ...interne, ruleSet: 'convention', output: 'interne:taux' };
    expect(matchesSelector(feeding, { outputs: ['interne:taux'] }, 'convention')).toBe(true);
    const packDefault = { ...interne, output: undefined };
    expect(matchesSelector(packDefault, { outputs: ['value'] }, 'interne')).toBe(true);
    expect(matchesSelector(packDefault, { outputs: ['interne:value'] }, 'local')).toBe(false);
    const both = { ruleSets: ['interne', 'local'], outputs: ['interne:value'] };
    expect(matchesSelector(packDefault, both)).toBe(true);
  });

  it.each([
    [{ ids: 'R1' }, 'selector.ids must be an array of strings'],
    [{ outputs: 'x' }, 'selector.outputs must be an array of strings'],
    [{ tags: ['t'], ruleSets: 'local' }, 'selector.ruleSets must be an array of strings'],
    [{ tags: [1] }, 'selector.tags must be an array of strings'],
    [{ models: null }, 'selector.models must be an array of strings'],
    [{ dimensions: ['FR'] }, 'selector.dimensions must be an object of dimension specs'],
  ])(
    'refuses the malformed selector %j with a typed SpecError (review M2)',
    (s: unknown, message) => {
      const local = { id: 'R1', tags: ['t'], dimensions: {}, model: 'M' };
      // Hostile input on purpose: a JavaScript caller can pass any shape.
      const selector = s as RuleSelector;
      expect(specError(() => matchesSelector(local, selector))).toMatchObject({
        code: 'INVALID_RULE',
        message,
      });
    },
  );

  it.each([
    [{ id: 1 }, 'rule.id must be a non-empty string'],
    [{ tags: 't' }, 'rule.tags must be an array of strings'],
    [{ model: null }, 'rule.model must be a non-empty string'],
    [{ output: 3 }, 'rule.output must be a string when present'],
    [{ dimensions: null }, 'rule.dimensions must be an object of dimension specs'],
    [{ id: 'a:b' }, 'qualifyName: "a:b" is not a bare name: it is empty or holds ":"'],
  ])('refuses the malformed rule %j with a typed SpecError (review M2)', (patch, message) => {
    // Hostile input on purpose: a JavaScript caller can pass any shape.
    const rule = { id: 'R1', tags: ['t'], dimensions: {}, model: 'M', ...patch } as Parameters<
      typeof matchesSelector
    >[0];
    expect(specError(() => matchesSelector(rule, { ids: ['R1'] }))).toMatchObject({
      code: 'INVALID_RULE',
      message,
    });
  });

  it('refuses a rule that is not a plain object (review round 4)', () => {
    // Hostile input on purpose: a JavaScript caller can pass any shape.
    for (const rule of [null, 'R1', [], new Map()]) {
      const hostile = rule as unknown as Parameters<typeof matchesSelector>[0];
      expect(specError(() => matchesSelector(hostile, { ids: ['R1'] }))).toMatchObject({
        code: 'INVALID_RULE',
        message: 'rule must be a plain object',
      });
    }
  });

  it('turns a throwing getter, a throwing proxy or a revoked proxy into a SpecError', () => {
    const local = { id: 'R1', tags: ['t'], dimensions: {}, model: 'M' };
    const boom = (): never => {
      throw new Error('boom');
    };
    const getter = Object.defineProperty({ ...local }, 'tags', { get: boom, enumerable: true });
    const trap = new Proxy(local, { get: boom });
    const revocable = Proxy.revocable(local, {});
    revocable.revoke();
    const throwingSelector = Object.defineProperty({}, 'ids', { get: boom, enumerable: true });
    const deepSelector = { dimensions: new Proxy({}, { ownKeys: boom }) };
    const cases: [unknown, unknown, string][] = [
      [getter, { ids: ['R1'] }, 'rule could not be read: boom'],
      [trap, { ids: ['R1'] }, 'rule could not be read: boom'],
      [local, throwingSelector, 'selector could not be read: boom'],
      [local, deepSelector, 'selector could not be read: boom'],
      [
        local,
        new Proxy({ ids: ['R1'] }, { getPrototypeOf: boom }),
        'selector could not be read: boom',
      ],
    ];
    for (const [rule, selector, message] of cases) {
      const call = (): boolean =>
        // Hostile input on purpose: a JavaScript caller can pass any shape.
        matchesSelector(rule as typeof local, selector as RuleSelector);
      expect(specError(call)).toMatchObject({ code: 'INVALID_RULE', message });
    }
    const revoked = specError(() => matchesSelector(revocable.proxy, { ids: ['R1'] }));
    expect(revoked.code).toBe('INVALID_RULE');
    expect(revoked.message.startsWith('rule could not be read: ')).toBe(true);
  });

  it('refuses an invalid rule set with a SpecError', () => {
    const rule = { id: 'R1', ruleSet: 'Bad', tags: [], dimensions: {}, model: 'M' };
    expect(specError(() => matchesSelector(rule, { ids: ['R1'] }))).toMatchObject({
      code: 'INVALID_RULE',
      message: 'rule ruleSet "Bad" is not a rule set id (^[a-z0-9][a-z0-9_-]*$)',
    });
    const local = { ...rule, ruleSet: undefined };
    expect(specError(() => matchesSelector(local, { ids: ['R1'] }, 'A'))).toMatchObject({
      code: 'INVALID_RULE',
      message: 'carrier ruleSet "A" is not a rule set id (^[a-z0-9][a-z0-9_-]*$)',
    });
  });

  it.each([
    [3, 'number'],
    [null, 'null'],
    [['rgpd'], 'array'],
  ])('refuses the non-string carrier %j by its type', (carrier: unknown, type) => {
    const local = { id: 'R1', tags: ['t'], dimensions: {}, model: 'M' };
    // Hostile input on purpose: a JavaScript caller can pass any carrier.
    const call = (): boolean => matchesSelector(local, { ids: ['R1'] }, carrier as string);
    expect(specError(call)).toMatchObject({
      code: 'INVALID_RULE',
      message: `carrier ruleSet must be a string, got ${type}`,
    });
  });

  it('sorts and deduplicates ruleSets, and drops the carrier set alone', () => {
    expect(targetsOf(inhibit({ ruleSets: ['rgpd', 'local', 'rgpd'], tags: ['t'] }))).toEqual({
      ruleSets: ['local', 'rgpd'],
      tags: ['t'],
    });
    expect(targetsOf(inhibit({ ruleSets: ['local'], tags: ['t'] }))).toEqual({ tags: ['t'] });
    expect(targetsOf(inhibit({ ruleSets: ['rgpd'], tags: ['t'] }, 'rgpd'))).toEqual({
      tags: ['t'],
    });
    expect(computeRuleChecksum(inhibit({ ruleSets: [], tags: ['t'] }))).toBe(
      computeRuleChecksum(inhibit({ tags: ['t'] })),
    );
  });

  it("writes names qualified by the carrier's own rule set bare", () => {
    const written = { ruleSets: ['rgpd', 'aiact'], ids: ['rgpd:R1', 'aiact:R2'], tags: ['t'] };
    expect(targetsOf(inhibit({ ...written, outputs: ['rgpd:x', 'x', 'aiact:y'] }, 'rgpd'))).toEqual(
      {
        ruleSets: ['aiact', 'rgpd'],
        ids: ['R1', 'aiact:R2'],
        tags: ['t'],
        outputs: ['aiact:y', 'x'],
      },
    );
  });

  it('does not count ruleSets as a constraint: it alone would target a whole rule set', () => {
    expectRuleRefused(
      inhibit({ ruleSets: ['rgpd'] }),
      'exceptions[0].targets',
      'exceptions[0].targets must constrain at least one of ids, tags, dimensions, outputs, ' +
        'models: an empty selector would target every rule',
    );
  });

  it.each([
    [
      { ruleSets: ['Rgpd'], tags: ['t'] },
      'exceptions[0].targets.ruleSets[0]',
      'exceptions[0].targets.ruleSets[0] must be a rule set id matching ^[a-z0-9][a-z0-9_-]*$',
    ],
    [
      { ruleSets: 'rgpd', tags: ['t'] },
      'exceptions[0].targets.ruleSets',
      'exceptions[0].targets.ruleSets must be an array of non-empty strings',
    ],
    [
      { ids: ['a:b:c'] },
      'exceptions[0].targets.ids[0]',
      'exceptions[0].targets.ids[0] name must hold at most one ":": <rule set>:<name>',
    ],
    [
      { ids: ['local:R1'] },
      'exceptions[0].targets.ids[0]',
      'exceptions[0].targets.ids[0] name must not be qualified by "local": ' +
        'a local name is written bare',
    ],
    [
      { ids: ['rgpd:R1'] },
      'exceptions[0].targets.ids[0]',
      'exceptions[0].targets.ids[0] names a rule of "rgpd", a rule set the selector ' +
        'does not target',
    ],
    [
      { ruleSets: ['rgpd'], ids: ['R1'] },
      'exceptions[0].targets.ids[0]',
      'exceptions[0].targets.ids[0] names a rule of "local", a rule set the selector ' +
        'does not target',
    ],
  ])('refuses the selector %j', (targets, path, message) => {
    expectRuleRefused(inhibit(targets), path, message);
  });

  it.each([
    [{ outputs: ['interne:taux'] }, undefined, 'interne'],
    [{ ruleSets: ['local'], outputs: ['interne:taux'] }, 'rgpd', 'interne'],
    [{ ruleSets: ['local'], outputs: ['rgpd:x'] }, 'rgpd', 'rgpd'],
    [{ ruleSets: ['local'], outputs: ['y'] }, 'rgpd', 'rgpd'],
    [{ ruleSets: ['rgpd'], outputs: ['t'] }, undefined, 'local'],
    [{ ruleSets: ['local'], outputs: ['autre:z'] }, undefined, 'autre'],
  ])('refuses a selector output that can never match: %j in %s (review M1)', (t, set, named) => {
    const at = 'exceptions[0].targets.outputs[0]';
    const why =
      named === 'local'
        ? 'only local rules feed it (a pack never imports local), and the selector does not ' +
          'target local'
        : `only rules of ${named} or of a pack that imports it feed it, and the selector ` +
          `targets neither ${named} nor any pack`;
    expectRuleRefused(inhibit(t, set), at, `${at} names an output of "${named}": ${why}`);
  });

  it.each([
    [{ ruleSets: ['interne'], outputs: ['interne:taux'] }, undefined],
    [{ ruleSets: ['rgpd'], outputs: ['interne:t'] }, undefined],
    [{ outputs: ['y', 'interne:z'] }, 'rgpd'],
    [{ ruleSets: ['rgpd', 'local'], outputs: ['autre:z', 't'] }, undefined],
    [{ ruleSets: ['local', 'rgpd'], outputs: ['y'] }, 'rgpd'],
  ])(
    'accepts a reachable selector output: %j in %s (D-23: a pack may import any set but local)',
    (t, set) => {
      expect(validateRuleDefinition(inhibit(t, set))).toEqual({
        valid: true,
        errors: [],
        issues: [],
      });
    },
  );

  it('accepts ids of every targeted rule set', () => {
    const targets = { ruleSets: ['rgpd', 'local'], ids: ['R1', 'rgpd:R2'] };
    expect(validateRuleDefinition(inhibit(targets)).valid).toBe(true);
    expect(validateRuleDefinition(inhibit({ ids: ['R1'] }, 'rgpd')).valid).toBe(true);
    expect(validateRuleDefinition(inhibit({ ids: ['rgpd:R1'] }, 'rgpd')).valid).toBe(true);
  });

  it('checks the targeted rule sets only once the rule set is known', () => {
    const value = inhibit({ ids: ['rgpd:R1'] }, 'Bad');
    expect(validateRuleDefinition(value).issues).toEqual([
      { path: 'ruleSet', message: RULE_SET_ID },
    ]);
  });
});

describe('findOverlappingVersions never mixes local rules with a pack', () => {
  const version = (n: number, ruleSet?: string): VersionedRuleWindow => ({
    id: 'R1',
    version: n,
    effectiveFrom: '2025-01-01',
    effectiveUntil: null,
    ...(ruleSet === undefined ? {} : { ruleSet }),
  });

  it('keeps the same id of a pack and of local rules apart', () => {
    const rules = [version(1), version(1, 'rgpd'), version(2, 'rgpd')];
    expect(findOverlappingVersions(rules, 'UTC', fixedCalendar)).toEqual([
      { ruleSet: 'rgpd', id: 'R1', versions: [1, 2], kind: 'overlap' },
    ]);
  });

  it("groups an explicit 'local' with the rules without a rule set", () => {
    const rules = [version(1), version(2, 'local')];
    expect(findOverlappingVersions(rules, 'UTC', fixedCalendar)).toEqual([
      { ruleSet: 'local', id: 'R1', versions: [1, 2], kind: 'overlap' },
    ]);
    expect(
      specError(() =>
        findOverlappingVersions([version(1), version(1, 'local')], 'UTC', fixedCalendar),
      ),
    ).toMatchObject({ code: 'INVALID_RULE', message: 'duplicate rule R1@1' });
  });

  it('refuses a rule set that is not a rule set id', () => {
    expect(
      specError(() => findOverlappingVersions([version(1, 'Rgpd')], 'UTC', fixedCalendar)),
    ).toMatchObject({ code: 'INVALID_RULE', message: `rule R1@1: ${RULE_SET_ID}` });
  });
});
