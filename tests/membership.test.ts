import { describe, expect, it } from 'vitest';
import { matchDimension, resolveMembership, validateReferential } from '../src/index.js';
import type { Referential } from '../src/index.js';
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

  it('a group is in the groups that hold it, and is itself', () => {
    expect(resolveMembership(ue, 'EEE', 'UE', '2026-01-01')).toEqual({
      result: true,
      via: ['EEE'],
    });
    expect(resolveMembership(ue, 'UE', 'UE', '2026-01-01')).toEqual({ result: true, via: [] });
    expect(resolveMembership(ue, 'UE', 'EEE', '2026-01-01')).toEqual({ result: false });
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

  it('a group name is never read as a missing code', () => {
    expect(resolveMembership(ueWithCodes(), 'UE', 'UE', '2026-01-01')).toEqual({
      result: true,
      via: [],
    });
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
    const r: Referential = { ...ueReferential(), groups };
    expect(validateReferential(r)).toEqual([]);
    const start = performance.now();
    expect(resolveMembership(r, 'L0a', 'x', '2026-01-01')).toEqual({ result: false });
    expect(performance.now() - start).toBeLessThan(500);
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
        { ref: 'nace', anyOf: ['nace-2.1:62.10'] },
        '62.10',
        '2026-01-01',
        new Map([['nace', nace]]),
      ),
    ).toEqual({ result: true, values: ['62.10'], via: [] });
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

  it('refuses a rule value of another code system', () => {
    const error = specError(() =>
      matchDimension(
        { ref: 'nace', anyOf: ['nace-2:62.10'] },
        '62.10',
        '2026-01-01',
        new Map([['nace', nace]]),
      ),
    );
    expect(error.code).toBe('INVALID_REFERENTIAL');
    expect(error.message).toBe('nace-2:62.10 is not of code system nace-2.1 of referential nace');
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
