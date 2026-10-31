import { describe, expect, it } from 'vitest';
import { matchDimension, resolveMembership, validateReferential } from '../src/index.js';
import type { Referential, ReferentialLimits } from '../src/index.js';
import { nestedReferential, specError, ueReferential } from './helpers.js';

const ue = ueReferential();
const tables = new Map<string, Referential>([['ue', ue]]);

/** The ue referential with `UE` not exhaustive. */
function ueOpen(): Referential {
  const r = ueReferential();
  const group = r.groups.UE;
  if (group) group.exhaustive = false;
  return r;
}

/** A referential that declares `codes`: FR and DE, both in the exhaustive group UE. */
function ueWithCodes(): Referential {
  return {
    format: 'run-iq.referential/1',
    id: 'ue',
    version: '1',
    dimension: 'pays',
    codes: {
      FR: [{ from: '1958-01-01', until: null }],
      DE: [{ from: '1958-01-01', until: null }],
      YU: [{ from: '1945-01-01', until: '2003-02-04' }],
    },
    groups: { UE: { exhaustive: true, members: [{ value: 'FR' }, { value: 'DE' }] } },
  };
}

/** NACE 2.1: the code 62.10 in the exhaustive section J; 62.20 used twice, with a gap. */
const nace: Referential = {
  format: 'run-iq.referential/1',
  id: 'nace',
  version: '2.1',
  dimension: 'activite',
  codeSystem: 'nace-2.1',
  codes: {
    '62.10': [{ from: '2025-01-01', until: null }],
    '62.20': [
      { from: '2008-01-01', until: '2015-01-01' },
      { from: '2025-01-01', until: null },
    ],
  },
  groups: { J: { exhaustive: true, members: [{ value: '62.10' }, { value: '62.20' }] } },
};

describe('the test referentials are valid', () => {
  it.each([
    ['ue', ue],
    ['ue open', ueOpen()],
    ['ue with codes', ueWithCodes()],
    ['nace', nace],
  ])('%s', (_name, r) => {
    expect(validateReferential(r)).toEqual([]);
  });
});

describe('resolveMembership', () => {
  it('FR is in UE in 2026, directly', () => {
    expect(resolveMembership(ue, 'UE', 'FR', '2026-01-01')).toEqual({ result: true, via: ['UE'] });
  });

  it('GB is in UE until 2020-02-01, excluded', () => {
    expect(resolveMembership(ue, 'UE', 'GB', '2019-06-01')).toEqual({ result: true, via: ['UE'] });
    expect(resolveMembership(ue, 'UE', 'GB', '2020-01-31')).toEqual({ result: true, via: ['UE'] });
    expect(resolveMembership(ue, 'UE', 'GB', '2020-02-01')).toEqual({ result: false });
    expect(resolveMembership(ue, 'UE', 'GB', '1972-12-31')).toEqual({ result: false });
  });

  it('HR is in UE from 2013-07-01, included', () => {
    expect(resolveMembership(ue, 'UE', 'HR', '2013-06-30')).toEqual({ result: false });
    expect(resolveMembership(ue, 'UE', 'HR', '2013-07-01')).toEqual({ result: true, via: ['UE'] });
  });

  it('FR is in EEE through UE', () => {
    expect(resolveMembership(ue, 'EEE', 'FR', '2026-01-01')).toEqual({
      result: true,
      via: ['EEE', 'UE'],
    });
    expect(resolveMembership(ue, 'EEE', 'NO', '2026-01-01')).toEqual({
      result: true,
      via: ['EEE'],
    });
    expect(resolveMembership(ue, 'MONDE', 'FR', '2026-01-01')).toEqual({
      result: true,
      via: ['MONDE', 'EEE', 'UE'],
    });
  });

  it('refuses a group as the value: an input names an entity, not a group (M8)', () => {
    for (const [group, value] of [
      ['EEE', 'UE'],
      ['UE', 'UE'],
      ['UE', 'EEE'],
    ] as const) {
      const error = specError(() => resolveMembership(ue, group, value, '2026-01-01'));
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.message).toBe(`input value ${value} is a group of ue`);
    }
  });

  it('XX is unknown in a group that is not exhaustive', () => {
    expect(resolveMembership(ue, 'MONDE', 'XX', '2026-01-01')).toEqual({
      result: 'unknown',
      why: 'XX in MONDE is unknown: MONDE is not exhaustive',
    });
  });

  it('XX is outside EEE: EEE is exhaustive and UE answers no', () => {
    expect(resolveMembership(ue, 'EEE', 'XX', '2026-01-01')).toEqual({ result: false });
  });

  it('exhaustiveness is per group: with UE open, XX in EEE is unknown', () => {
    expect(resolveMembership(ueOpen(), 'EEE', 'XX', '2026-01-01')).toEqual({
      result: 'unknown',
      why: 'XX in UE is unknown: UE is not exhaustive',
    });
    expect(resolveMembership(ueOpen(), 'EEE', 'FR', '2026-01-01')).toEqual({
      result: true,
      via: ['EEE', 'UE'],
    });
  });

  it('a code not valid at the date is unknown; valid, it is judged', () => {
    const r = ueWithCodes();
    expect(resolveMembership(r, 'UE', 'YU', '2026-01-01')).toEqual({
      result: 'unknown',
      why: 'code YU not valid at 2026-01-01',
    });
    expect(resolveMembership(r, 'UE', 'YU', '2000-01-01')).toEqual({ result: false });
  });

  it('a code reused after a gap is unknown in the gap', () => {
    expect(resolveMembership(nace, 'J', '62.20', '2010-01-01')).toEqual({
      result: true,
      via: ['J'],
    });
    expect(resolveMembership(nace, 'J', '62.20', '2020-01-01')).toEqual({
      result: 'unknown',
      why: 'code 62.20 not valid at 2020-01-01',
    });
    expect(resolveMembership(nace, 'J', '62.20', '2025-01-01')).toEqual({
      result: true,
      via: ['J'],
    });
  });

  it('reads a qualified value in the code system of the referential only', () => {
    expect(resolveMembership(nace, 'J', 'nace-2.1:62.10', '2026-01-01')).toEqual({
      result: true,
      via: ['J'],
    });
    expect(resolveMembership(nace, 'J', '62.10', '2026-01-01')).toEqual({
      result: true,
      via: ['J'],
    });
    expect(resolveMembership(nace, 'J', 'nace-2:62.10', '2026-01-01')).toEqual({
      result: 'unknown',
      why: 'code system nace-2 is not nace-2.1',
    });
    expect(resolveMembership(ue, 'UE', 'iso:FR', '2026-01-01')).toEqual({
      result: 'unknown',
      why: 'code system iso is not declared by referential ue',
    });
  });

  it('with codes, a value absent from codes is unknown (I24); without codes, it is outside', () => {
    expect(resolveMembership(ueWithCodes(), 'UE', 'ZZ', '2026-01-01')).toEqual({
      result: 'unknown',
      why: 'code ZZ not in referential ue',
    });
    expect(resolveMembership(ue, 'UE', 'ZZ', '2026-01-01')).toEqual({ result: false });
  });

  it('a group name is never read as a missing code: it is refused as a value', () => {
    const error = specError(() => resolveMembership(ueWithCodes(), 'UE', 'UE', '2026-01-01'));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('input value UE is a group of ue');
  });

  it('honours maxDepth, up to 1 024, and walks without recursion (I2)', () => {
    const deep = nestedReferential(100);
    const error = specError(() => resolveMembership(deep, 'G1', 'x', '2026-01-01'));
    expect(error.code).toBe('INVALID_REFERENTIAL');
    expect(error.message).toBe('group nesting deeper than 64');
    expect(resolveMembership(deep, 'G1', 'x', '2026-01-01', { maxDepth: 100 })).toEqual({
      result: true,
      via: Array.from({ length: 100 }, (_, i) => `G${i + 1}`),
    });
    expect(
      specError(() => resolveMembership(deep, 'G1', 'x', '2026-01-01', { maxDepth: 99 })).message,
    ).toBe('group nesting deeper than 99');
    const deepest = nestedReferential(1024);
    expect(resolveMembership(deepest, 'G1', 'x', '2026-01-01', { maxDepth: 1024 }).result).toBe(
      true,
    );
    const ceiling = specError(() =>
      resolveMembership(deepest, 'G1', 'x', '2026-01-01', { maxDepth: 1025 }),
    );
    expect(ceiling.code).toBe('INVALID_REFERENTIAL');
    expect(ceiling.message).toBe('maxDepth must be at most 1024');
  });

  it('stops on a cycle of an unvalidated referential with a SpecError', () => {
    const r: Referential = {
      ...ueReferential(),
      groups: {
        A: { exhaustive: true, members: [{ value: 'B' }] },
        B: { exhaustive: true, members: [{ value: 'A' }] },
      },
    };
    const error = specError(() => resolveMembership(r, 'A', 'x', '2026-01-01'));
    expect(error.code).toBe('INVALID_REFERENTIAL');
    expect(error.message).toBe('group nesting deeper than 64');
  });

  it('refuses invalid options with a SpecError (M3)', () => {
    const throwing = {
      get maxDepth(): number {
        throw new Error('opt');
      },
    };
    const cases: [unknown, string][] = [
      [null, 'options must be an object'],
      [throwing, 'options could not be read: opt'],
      [{ maxDepth: 0 }, 'maxDepth must be a positive integer'],
    ];
    for (const [options, message] of cases) {
      // The types refuse these options; a caller without types can still pass them.
      const limits = options as ReferentialLimits;
      const error = specError(() => resolveMembership(ue, 'UE', 'FR', '2026-01-01', limits));
      expect(error.code).toBe('INVALID_REFERENTIAL');
      expect(error.message).toBe(message);
    }
  });

  it('resolves 64 nested groups without overflowing the stack', () => {
    const deep = nestedReferential(64);
    const result = resolveMembership(deep, 'G1', 'x', '2026-01-01');
    expect(result).toEqual({
      result: true,
      via: Array.from({ length: 64 }, (_, i) => `G${i + 1}`),
    });
    expect(resolveMembership(deep, 'G1', 'y', '2026-01-01')).toEqual({ result: false });
  });

  it('picks the same via whatever the order of members', () => {
    const r: Referential = {
      format: 'run-iq.referential/1',
      id: 'r',
      version: '1',
      dimension: 'd',
      groups: {
        TOP: { exhaustive: true, members: [{ value: 'B' }, { value: 'A' }] },
        A: { exhaustive: true, members: [{ value: 'x' }] },
        B: { exhaustive: true, members: [{ value: 'x' }] },
      },
    };
    expect(resolveMembership(r, 'TOP', 'x', '2026-01-01')).toEqual({
      result: true,
      via: ['TOP', 'A'],
    });
  });

  it('a direct member wins over a nested path, and true wins over unknown', () => {
    const r: Referential = {
      format: 'run-iq.referential/1',
      id: 'r',
      version: '1',
      dimension: 'd',
      groups: {
        TOP: { exhaustive: true, members: [{ value: 'A' }, { value: 'x' }] },
        A: { exhaustive: false, members: [] },
      },
    };
    expect(resolveMembership(r, 'TOP', 'x', '2026-01-01')).toEqual({
      result: true,
      via: ['TOP'],
    });
  });

  it('refuses an unknown group and an invalid date with a SpecError', () => {
    const unknown = specError(() => resolveMembership(ue, 'ASEAN', 'FR', '2026-01-01'));
    expect(unknown.code).toBe('INVALID_REFERENTIAL');
    expect(unknown.message).toBe('group ASEAN not in referential ue');
    expect(specError(() => resolveMembership(ue, 'UE', 'FR', '2026-02-30')).code).toBe(
      'INVALID_DATE',
    );
  });

  it('turns a hostile referential into a SpecError, never a raw error', () => {
    const { proxy, revoke } = Proxy.revocable(ueReferential(), {});
    revoke();
    const error = specError(() => resolveMembership(proxy, 'UE', 'FR', '2026-01-01'));
    expect(error.code).toBe('INVALID_REFERENTIAL');
    expect(error.message).toMatch(/^referential could not be read: /);
  });

  it('resolves each group once: 25 layers of diamonds (2^25 paths) answer at once', () => {
    const groups: Referential['groups'] = {};
    const layers = 25;
    for (let layer = 0; layer < layers; layer++) {
      for (const side of ['a', 'b']) {
        const members =
          layer === layers - 1
            ? [{ value: 'y' }]
            : [{ value: `L${layer + 1}a` }, { value: `L${layer + 1}b` }];
        groups[`L${layer}${side}`] = { exhaustive: true, members };
      }
    }
    expect(validateReferential({ ...ueReferential(), groups })).toEqual([]);
    // Count every read of a group: each of the 50 groups is read once, never once per path.
    let reads = 0;
    const counted = new Proxy(groups, {
      get(target, key, receiver): unknown {
        if (typeof key === 'string') reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const r: Referential = { ...ueReferential(), groups: counted };
    expect(resolveMembership(r, 'L0a', 'x', '2026-01-01')).toEqual({ result: false });
    expect(reads).toBeLessThanOrEqual(2 * layers);
  });
});

describe('matchDimension', () => {
  it('compares a value without ref by equality', () => {
    expect(matchDimension('FR', 'FR', '2026-01-01', new Map())).toEqual({
      result: true,
      values: ['FR'],
      via: [],
    });
    expect(matchDimension('FR', 'DE', '2026-01-01', new Map())).toEqual({
      result: false,
      why: 'no input value matches',
    });
    expect(matchDimension({ anyOf: ['DE', 'FR'] }, 'FR', '2026-01-01', new Map())).toEqual({
      result: true,
      values: ['FR'],
      via: [],
    });
  });

  it('never reads a group by equality: UE does not match FR without ref', () => {
    expect(matchDimension('UE', 'FR', '2026-01-01', tables)).toEqual({
      result: false,
      why: 'no input value matches',
    });
  });

  it('applies anyOf and except through the referential', () => {
    const spec = { ref: 'ue', anyOf: ['UE'], except: ['DK'] };
    expect(matchDimension(spec, 'DK', '2026-01-01', tables)).toEqual({
      result: false,
      why: 'no input value matches',
    });
    expect(matchDimension(spec, 'FR', '2026-01-01', tables)).toEqual({
      result: true,
      values: ['FR'],
      via: ['UE'],
    });
  });

  it('an unknown membership in except makes the match unknown', () => {
    const r = ueReferential();
    r.groups.ZONE = { exhaustive: false, members: [{ value: 'DK' }] };
    const spec = { ref: 'ue', anyOf: ['UE'], except: ['ZONE'] };
    expect(matchDimension(spec, 'FR', '2026-01-01', new Map([['ue', r]]))).toEqual({
      result: 'unknown',
      why: 'FR in ZONE is unknown: ZONE is not exhaustive',
    });
    expect(matchDimension(spec, 'DK', '2026-01-01', new Map([['ue', r]]))).toEqual({
      result: false,
      why: 'no input value matches',
    });
  });

  it('judges except at the same date as anyOf', () => {
    const spec = { ref: 'ue', anyOf: ['DK', 'NO'], except: ['UE'] };
    // Before 1973 DK is not in UE: except does not apply.
    expect(matchDimension(spec, 'DK', '1972-06-01', tables)).toEqual({
      result: true,
      values: ['DK'],
      via: [],
    });
    expect(matchDimension(spec, 'DK', '2026-01-01', tables)).toEqual({
      result: false,
      why: 'no input value matches',
    });
  });

  it('an unknown membership in anyOf makes the match unknown', () => {
    expect(matchDimension({ ref: 'ue', anyOf: ['MONDE'] }, 'XX', '2026-01-01', tables)).toEqual({
      result: 'unknown',
      why: 'XX in MONDE is unknown: MONDE is not exhaustive',
    });
  });

  it("match 'any' over several input values (M-11)", () => {
    expect(matchDimension({ anyOf: ['DE', 'FR'] }, ['US', 'FR'], '2026-01-01', tables)).toEqual({
      result: true,
      values: ['FR'],
      via: [],
    });
    expect(
      matchDimension({ ref: 'ue', anyOf: ['UE'] }, ['US', 'FR'], '2026-01-01', tables),
    ).toEqual({ result: true, values: ['FR'], via: ['UE'] });
  });

  it("match 'all' over several input values (M-11)", () => {
    const all = { anyOf: ['DE', 'FR'], match: 'all' as const };
    expect(matchDimension(all, ['DE', 'FR'], '2026-01-01', tables)).toEqual({
      result: true,
      values: ['DE', 'FR'],
      via: [],
    });
    expect(matchDimension(all, ['US', 'FR'], '2026-01-01', tables)).toEqual({
      result: false,
      why: 'input value US does not match',
    });
  });

  it("match 'all': false wins over unknown, unknown over true", () => {
    const all = { ref: 'ue', anyOf: ['MONDE'], match: 'all' as const };
    expect(matchDimension(all, ['FR', 'XX'], '2026-01-01', tables)).toEqual({
      result: 'unknown',
      why: 'XX in MONDE is unknown: MONDE is not exhaustive',
    });
    const eee = { ref: 'ue', anyOf: ['EEE', 'MONDE'], except: ['NO'], match: 'all' as const };
    expect(matchDimension(eee, ['NO', 'XX'], '2026-01-01', tables)).toEqual({
      result: false,
      why: 'input value NO does not match',
    });
  });

  it("match 'any': true wins over unknown; unknown over false", () => {
    const spec = { ref: 'ue', anyOf: ['MONDE'] };
    expect(matchDimension(spec, ['XX', 'FR'], '2026-01-01', tables)).toEqual({
      result: true,
      values: ['FR'],
      via: ['MONDE', 'EEE', 'UE'],
    });
    const eee = { ref: 'ue', anyOf: ['EEE', 'MONDE'], except: ['NO'] };
    expect(matchDimension(eee, ['NO', 'XX'], '2026-01-01', tables)).toEqual({
      result: 'unknown',
      why: 'XX in MONDE is unknown: MONDE is not exhaustive',
    });
  });

  it('lists the matched values sorted, and the groups crossed once', () => {
    const spec = { ref: 'ue', anyOf: ['EEE'] };
    expect(matchDimension(spec, ['NO', 'FR', 'DK'], '2026-01-01', tables)).toEqual({
      result: true,
      values: ['DK', 'FR', 'NO'],
      via: ['EEE', 'UE'],
    });
  });

  it('matches a code of anyOf by equality, through its validity', () => {
    const tablesWithCodes = new Map([['ue', ueWithCodes()]]);
    expect(
      matchDimension({ ref: 'ue', anyOf: ['YU'] }, 'YU', '2000-01-01', tablesWithCodes),
    ).toEqual({ result: true, values: ['YU'], via: [] });
    expect(
      matchDimension({ ref: 'ue', anyOf: ['YU'] }, 'YU', '2026-01-01', tablesWithCodes),
    ).toEqual({ result: 'unknown', why: 'code YU not valid at 2026-01-01' });
    expect(
      matchDimension(
        { ref: 'nace', anyOf: ['62.10'] },
        'nace-2.1:62.10',
        '2026-01-01',
        new Map([['nace', nace]]),
      ),
    ).toEqual({ result: true, values: ['nace-2.1:62.10'], via: [] });
  });

  it('refuses a ref absent from the table', () => {
    const error = specError(() =>
      matchDimension({ ref: 'ue', anyOf: ['UE'] }, 'FR', '2026-01-01', new Map()),
    );
    expect(error.code).toBe('INVALID_REFERENTIAL');
    expect(error.message).toBe('unknown referential ue');
  });

  it('refuses a group or code the referential does not know, when it declares codes', () => {
    const error = specError(() =>
      matchDimension(
        { ref: 'ue', anyOf: ['UEE'] },
        'FR',
        '2026-01-01',
        new Map([['ue', ueWithCodes()]]),
      ),
    );
    expect(error.code).toBe('INVALID_REFERENTIAL');
    expect(error.message).toBe('UEE is neither a group nor a code of referential ue');
  });

  it('refuses a qualified rule value with ref: the referential fixes the code system (M2)', () => {
    const error = specError(() =>
      matchDimension(
        { ref: 'nace', anyOf: ['nace-2:62.10'] },
        '62.10',
        '2026-01-01',
        new Map([['nace', nace]]),
      ),
    );
    expect(error.code).toBe('INVALID_RULE');
    expect(error.message).toBe(
      'dimension.anyOf[0] must not be qualified: the referential fixes the code system',
    );
  });

  it('refuses a group as an input value (M8)', () => {
    for (const spec of [
      { ref: 'ue', anyOf: ['MONDE'], except: ['FR'] },
      { ref: 'ue', anyOf: ['FR'] },
    ]) {
      const error = specError(() => matchDimension(spec, ['DK', 'UE'], '2026-01-01', tables));
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.message).toBe('input value UE is a group of ue');
    }
  });

  it('names an unreadable input as INVALID_INPUT (M5)', () => {
    const input = new Proxy(['FR'], {
      get(target, key, receiver): unknown {
        if (key === 'length') throw new Error('in');
        return Reflect.get(target, key, receiver);
      },
    });
    const error = specError(() => matchDimension('FR', input, '2026-01-01', tables));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('input could not be read: in');
    // The types refuse a number; a caller without types can still pass one.
    const number = 1 as unknown as string;
    const shape = specError(() => matchDimension('FR', number, '2026-01-01', tables));
    expect(shape.code).toBe('INVALID_INPUT');
    expect(shape.message).toBe('input must be a value or an array of values');
  });

  it('takes the limits of validateReferential (I2)', () => {
    const deep = new Map([['deep', nestedReferential(100)]]);
    const spec = { ref: 'deep', anyOf: ['G1'] };
    expect(specError(() => matchDimension(spec, 'x', '2026-01-01', deep)).message).toBe(
      'group nesting deeper than 64',
    );
    expect(matchDimension(spec, 'x', '2026-01-01', deep, { maxDepth: 100 }).result).toBe(true);
    // The types refuse null options; a caller without types can still pass them.
    const nullLimits = null as unknown as ReferentialLimits;
    expect(specError(() => matchDimension(spec, 'x', '2026-01-01', deep, nullLimits)).code).toBe(
      'INVALID_REFERENTIAL',
    );
  });

  it('refuses an invalid spec, input or date with a SpecError', () => {
    expect(specError(() => matchDimension({ anyOf: [] }, 'FR', '2026-01-01', tables)).code).toBe(
      'INVALID_RULE',
    );
    const empty = specError(() => matchDimension('FR', [], '2026-01-01', tables));
    expect(empty.code).toBe('INVALID_INPUT');
    expect(empty.message).toBe('a dimension input must hold at least one value');
    const bad = specError(() => matchDimension('FR', ['FR', ':x'], '2026-01-01', tables));
    expect(bad.code).toBe('INVALID_INPUT');
    expect(bad.message).toBe('input[1] has an empty code system before ":"');
    expect(specError(() => matchDimension('FR', 'FR', '2026-13-01', tables)).code).toBe(
      'INVALID_DATE',
    );
  });
});
