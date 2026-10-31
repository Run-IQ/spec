import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  computeReferentialDigest,
  normalizeReferential,
  sha256Hex,
  validateReferential,
} from '../src/index.js';
import type { Referential, ReferentialLimits, ReferentialMember } from '../src/index.js';
import { referentialCheckSteps } from '../src/referential/validate.js';
import { nestedReferential, specError, ueReferential } from './helpers.js';

/**
 * The most cycle and depth sweep steps allowed per node in the work-bound tests. Measured:
 * 2.8 (layered), 3.0 (fan-in), 5.5 (33 000 one-day periods), 4.75 (chains); a quadratic sweep
 * takes thousands per node on these shapes.
 */
const STEPS_PER_NODE = 10;

/** 10 000 groups on 4 levels (10, 100, 1 000, 8 890), each a member twice, on adjacent periods. */
function layeredReferential(): Referential {
  const groups: Record<string, ReferentialMember[]> = {};
  const twice = (value: string): ReferentialMember[] => [
    { value, from: '2000-01-01', until: '2010-01-01' },
    { value, from: '2010-01-01' },
  ];
  let previous: string[] = [];
  [10, 100, 1000, 8890].forEach((size, level) => {
    const names = Array.from({ length: size }, (_, i) => `L${level}-${i}`);
    for (const name of names) groups[name] = [];
    names.forEach((name, i) => {
      const parent = previous[i % Math.max(previous.length, 1)];
      if (parent !== undefined) groups[parent]?.push(...twice(name));
    });
    previous = names;
  });
  for (const leaf of previous) groups[leaf]?.push(...twice(`code-${leaf}`));
  return withGroups(groups);
}

/** `HUB` holding `leaves` groups, itself held by `parents` groups; every group exhaustive. */
function fanIn(leaves: number, parents: number): Referential {
  const groups: Record<string, ReferentialMember[]> = {};
  groups.HUB = Array.from({ length: leaves }, (_, i) => ({ value: `L${i}` }));
  for (let i = 0; i < leaves; i++) groups[`L${i}`] = [{ value: `x${i}` }];
  for (let i = 0; i < parents; i++) groups[`R${i}`] = [{ value: 'HUB' }];
  return withGroups(groups);
}

/** `HUB` holding `leaves` empty groups, held by `ROOT` on `days` separate one-day periods. */
function dailyHub(leaves: number, days: number): Referential {
  const groups: Record<string, ReferentialMember[]> = {};
  groups.HUB = Array.from({ length: leaves }, (_, i) => ({ value: `L${i}` }));
  for (let i = 0; i < leaves; i++) groups[`L${i}`] = [];
  const day = (i: number): string =>
    new Date(Date.UTC(2000, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
  groups.ROOT = Array.from({ length: days }, (_, i) => ({
    value: 'HUB',
    from: day(2 * i),
    until: day(2 * i + 1),
  }));
  return withGroups(groups);
}

/**
 * `HUB` holding `leaves` empty groups and, on `days` one-day periods, the group `Y`; `ROOT`
 * holds `HUB` on the same periods.
 */
function toggledHub(leaves: number, days: number): Referential {
  const r = dailyHub(leaves, days);
  const daily = r.groups.ROOT?.members ?? [];
  r.groups.Y = { exhaustive: true, members: [] };
  r.groups.HUB?.members.push(...daily.map((m) => ({ ...m, value: 'Y' })));
  return r;
}

/** A referential with only the given groups, every group exhaustive. */
function withGroups(groups: Record<string, ReferentialMember[]>): Referential {
  const out: Referential['groups'] = {};
  for (const [name, members] of Object.entries(groups)) {
    out[name] = { exhaustive: true, members };
  }
  return { format: 'run-iq.referential/1', id: 'g', version: '1', dimension: 'd', groups: out };
}

describe('validateReferential: valid referentials', () => {
  it('accepts the example ue referential', () => {
    expect(validateReferential(ueReferential())).toEqual([]);
  });

  it('accepts codes with periods, a code system and a code reused after a gap', () => {
    const r: Referential = {
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
      groups: {
        J: { exhaustive: true, members: [{ value: '62.10' }, { value: '62.20' }] },
      },
    };
    expect(validateReferential(r)).toEqual([]);
  });

  it('accepts the same member twice on adjacent periods', () => {
    const r = withGroups({
      A: [
        { value: 'x', from: '2000-01-01', until: '2010-01-01' },
        { value: 'x', from: '2010-01-01' },
      ],
    });
    expect(validateReferential(r)).toEqual([]);
  });

  it('accepts a cycle whose two edges never hold on the same date (checked per period)', () => {
    const r = withGroups({
      A: [{ value: 'B', from: '2000-01-01', until: '2010-01-01' }],
      B: [{ value: 'A', from: '2010-01-01' }],
    });
    expect(validateReferential(r)).toEqual([]);
  });

  it('accepts 64 nested groups', () => {
    expect(validateReferential(nestedReferential(64))).toEqual([]);
  });

  it('accepts a diamond: two paths to one group are not a cycle', () => {
    const r = withGroups({
      A: [{ value: 'B' }, { value: 'C' }],
      B: [{ value: 'D' }],
      C: [{ value: 'D' }],
      D: [],
    });
    expect(validateReferential(r)).toEqual([]);
  });
});

describe('validateReferential: cycles, checked per period', () => {
  it('refuses A ∋ B and B ∋ A on overlapping periods, from the date both hold', () => {
    const r = withGroups({
      A: [{ value: 'B', from: '2010-01-01' }],
      B: [{ value: 'A', from: '2020-01-01' }],
    });
    expect(validateReferential(r)).toEqual([
      { path: 'groups', message: 'cycle A > B > A from 2020-01-01' },
    ]);
  });

  it('refuses a cycle that exists only between two dates', () => {
    const r = withGroups({
      A: [{ value: 'B', from: '2000-01-01', until: '2015-01-01' }],
      B: [{ value: 'A', from: '2010-01-01', until: '2020-01-01' }],
    });
    expect(validateReferential(r)).toEqual([
      { path: 'groups', message: 'cycle A > B > A from 2010-01-01' },
    ]);
  });

  it('refuses a cycle of three groups that always holds, starting at the smallest name', () => {
    const r = withGroups({ C: [{ value: 'A' }], A: [{ value: 'B' }], B: [{ value: 'C' }] });
    expect(validateReferential(r)).toEqual([
      { path: 'groups', message: 'cycle A > B > C > A from the beginning' },
    ]);
  });

  it('refuses a group that holds itself', () => {
    const r = withGroups({ A: [{ value: 'A', from: '2001-01-01' }] });
    expect(validateReferential(r)).toEqual([
      { path: 'groups', message: 'cycle A > A from 2001-01-01' },
    ]);
  });
});

describe('validateReferential: refused documents', () => {
  const cases: [string, unknown, { path: string; message: string }[]][] = [
    [
      'an unknown format',
      { ...ueReferential(), format: 'run-iq.referential/2' },
      [{ path: 'format', message: 'format must be "run-iq.referential/1"' }],
    ],
    [
      'a value both a code and a group',
      {
        ...ueReferential(),
        codes: {
          FR: [{ from: '1958-01-01', until: null }],
          UE: [{ from: '1958-01-01', until: null }],
        },
        groups: { UE: { exhaustive: true, members: [{ value: 'FR' }] } },
      },
      [{ path: 'groups.UE', message: 'UE is both a code and a group' }],
    ],
    [
      'an empty member period',
      withGroups({ A: [{ value: 'x', from: '2020-01-01', until: '2020-01-01' }] }),
      [
        {
          path: 'groups.A.members[0].until',
          message: 'groups.A.members[0].until must be after from 2020-01-01: the period is empty',
        },
      ],
    ],
    [
      'an empty code period',
      {
        ...withGroups({ A: [{ value: 'x' }] }),
        codes: { x: [{ from: '2020-01-01', until: '2019-01-01' }] },
      },
      [
        {
          path: 'codes.x[0].until',
          message: 'codes.x[0].until must be after from 2020-01-01: the period is empty',
        },
      ],
    ],
    [
      'a code without period',
      { ...withGroups({ A: [{ value: 'x' }] }), codes: { x: [] } },
      [{ path: 'codes.x', message: 'codes.x must list at least one period' }],
    ],
    [
      'overlapping periods of one code',
      {
        ...withGroups({ A: [{ value: 'x' }] }),
        codes: {
          x: [
            { from: '2000-01-01', until: '2010-01-01' },
            { from: '2009-01-01', until: null },
          ],
        },
      },
      [{ path: 'codes.x', message: 'codes.x has overlapping periods from 2009-01-01' }],
    ],
    [
      'one member twice on overlapping periods',
      withGroups({ A: [{ value: 'x' }, { value: 'x', from: '2010-01-01' }] }),
      [{ path: 'groups.A.members', message: 'groups.A.members lists x twice from 2010-01-01' }],
    ],
    [
      'a member that is neither a group nor a code, codes being declared',
      {
        ...withGroups({ A: [{ value: 'y' }] }),
        codes: { x: [{ from: '2000-01-01', until: null }] },
      },
      [
        {
          path: 'groups.A.members[0].value',
          message: 'groups.A.members[0].value y is neither a group nor a code of codes',
        },
      ],
    ],
    [
      'a qualified group name',
      withGroups({ 'nace:J': [] }),
      [{ path: 'groups', message: 'group name "nace:J" must not hold ":"' }],
    ],
    [
      'a qualified code',
      { ...withGroups({}), codes: { 'nace:62': [{ from: '2000-01-01', until: null }] } },
      [{ path: 'codes', message: 'code "nace:62" must not hold ":"' }],
    ],
    [
      'a qualified member value',
      withGroups({ A: [{ value: 'nace:62' }] }),
      [
        {
          path: 'groups.A.members[0].value',
          message: 'groups.A.members[0].value must not hold ":"',
        },
      ],
    ],
    [
      'an empty member value',
      withGroups({ A: [{ value: '' }] }),
      [
        {
          path: 'groups.A.members[0].value',
          message: 'groups.A.members[0].value must not be empty',
        },
      ],
    ],
    [
      'a code system with ":"',
      { ...ueReferential(), codeSystem: 'nace:2' },
      [{ path: 'codeSystem', message: 'codeSystem must not hold ":"' }],
    ],
    [
      'an unknown key',
      { ...ueReferential(), name: 'Union' },
      [{ path: 'name', message: 'referential has an unknown key "name"' }],
    ],
    [
      'missing fields',
      { format: 'run-iq.referential/1' },
      [
        { path: 'id', message: 'id must be a non-empty string' },
        { path: 'version', message: 'version must be a non-empty string' },
        { path: 'dimension', message: 'dimension must be a non-empty string' },
        { path: 'groups', message: 'groups must be an object of groups' },
      ],
    ],
    [
      'a group without exhaustive',
      { ...ueReferential(), groups: { A: { members: [] } } },
      [{ path: 'groups.A.exhaustive', message: 'groups.A.exhaustive must be a boolean' }],
    ],
    [
      'a group with an unknown key',
      { ...ueReferential(), groups: { A: { exhaustive: true, members: [], open: true } } },
      [{ path: 'groups.A.open', message: 'groups.A has an unknown key "open"' }],
    ],
    [
      'members that are not an array',
      { ...ueReferential(), groups: { A: { exhaustive: true, members: {} } } },
      [{ path: 'groups.A.members', message: 'groups.A.members must be an array of members' }],
    ],
    [
      'a member with an unknown key',
      withGroups({ A: [{ value: 'x', since: '2000-01-01' } as ReferentialMember] }),
      [
        {
          path: 'groups.A.members[0].since',
          message: 'groups.A.members[0] has an unknown key "since"',
        },
      ],
    ],
    [
      'an impossible date',
      withGroups({ A: [{ value: 'x', from: '2023-02-29' }] }),
      [
        {
          path: 'groups.A.members[0].from',
          message: 'groups.A.members[0].from must be a civil date YYYY-MM-DD',
        },
      ],
    ],
    [
      'a code period with a non-date until',
      { ...withGroups({ A: [{ value: 'x' }] }), codes: { x: [{ from: '2000-01-01', until: 1 }] } },
      [
        {
          path: 'codes.x[0].until',
          message: 'codes.x[0].until must be a civil date YYYY-MM-DD or null',
        },
      ],
    ],
    [
      'a lone surrogate in a member value',
      withGroups({ A: [{ value: 'x\uD800' }] }),
      [
        {
          path: 'groups.A.members[0].value',
          message: 'groups.A.members[0].value contains a lone UTF-16 surrogate',
        },
      ],
    ],
    [
      'an array',
      [ueReferential()],
      [{ path: '', message: 'a referential must be a plain object' }],
    ],
  ];

  it.each(cases)('refuses %s', (_label, value, issues) => {
    expect(validateReferential(value)).toEqual(issues);
  });
});

describe('validateReferential: hostile data and scale (I20)', () => {
  it('names a getter that throws, without throwing', () => {
    const r = {
      ...ueReferential(),
      get groups(): never {
        throw new Error('boom');
      },
    };
    expect(validateReferential(r)).toEqual([
      { path: 'groups', message: 'groups could not be read: boom' },
    ]);
  });

  it('names a nested getter that throws', () => {
    const member = {
      get value(): never {
        throw new Error('nope');
      },
    };
    const r = withGroups({ A: [member as unknown as ReferentialMember] });
    expect(validateReferential(r)).toEqual([
      {
        path: 'groups.A.members[0].value',
        message: 'groups.A.members[0].value could not be read: nope',
      },
    ]);
  });

  it('names a revoked Proxy, without throwing', () => {
    const { proxy, revoke } = Proxy.revocable(ueReferential(), {});
    revoke();
    const [issue, ...rest] = validateReferential(proxy);
    expect(rest).toEqual([]);
    expect(issue?.path).toBe('');
    expect(issue?.message).toMatch(/^referential could not be read: /);
  });

  it('reads each property of a Proxy once', () => {
    const reads = new Map<string, number>();
    const count = <T extends object>(target: T, prefix: string): T =>
      new Proxy(target, {
        get(t, key, receiver): unknown {
          if (typeof key === 'string') {
            reads.set(`${prefix}${key}`, (reads.get(`${prefix}${key}`) ?? 0) + 1);
          }
          return Reflect.get(t, key, receiver);
        },
      });
    const source = ueReferential();
    const groups = count(
      { ...source.groups, UE: count(source.groups.UE ?? { exhaustive: true, members: [] }, 'UE.') },
      'groups.',
    );
    expect(validateReferential(count({ ...source, groups }, ''))).toEqual([]);
    expect([...reads.values()].every((n) => n === 1)).toBe(true);
    expect([...reads.keys()].sort()).toEqual([
      'UE.exhaustive',
      'UE.members',
      'dimension',
      'format',
      'groups',
      'groups.EEE',
      'groups.MONDE',
      'groups.UE',
      'id',
      'version',
    ]);
  });

  it('refuses nesting deeper than 64 groups', () => {
    expect(validateReferential(nestedReferential(65))).toEqual([
      { path: 'groups', message: 'group nesting deeper than 64' },
    ]);
  });

  it('measures the depth at each date: two chains never active together stay shallow', () => {
    const r = nestedReferential(40);
    const extra = nestedReferential(40);
    for (const [name, group] of Object.entries(extra.groups)) {
      r.groups[`H${name}`] = {
        exhaustive: true,
        members: group.members.map((m) => ({ value: m.value === 'x' ? 'x' : `H${m.value}` })),
      };
    }
    // G40 holds H1 until 2000 only, while H1 holds H2 from 2000 only: never 80 deep.
    r.groups.G40 = { exhaustive: true, members: [{ value: 'HG1', until: '2000-01-01' }] };
    const first = r.groups.HG1;
    if (first) first.members = [{ value: 'HG2', from: '2000-01-01' }];
    expect(validateReferential(r)).toEqual([]);
    expect(validateReferential(r, { maxDepth: 41 })).toEqual([]);
    expect(validateReferential(r, { maxDepth: 40 })).toEqual([
      { path: 'groups', message: 'group nesting deeper than 40' },
    ]);
  });

  it('refuses more than maxNodes nodes (codes, groups and members), before reading members', () => {
    const groups: Referential['groups'] = {};
    for (let i = 0; i <= 100_000; i++) groups[`G${i}`] = { exhaustive: true, members: [] };
    const r = { ...withGroups({}), groups };
    expect(validateReferential(r)).toEqual([
      { path: '', message: 'referential too large: 100001 nodes' },
    ]);
    // ue: 3 groups and 7 members.
    expect(validateReferential(ueReferential(), { maxNodes: 9 })).toEqual([
      { path: '', message: 'referential too large: 10 nodes' },
    ]);
    expect(validateReferential(ueReferential(), { maxNodes: 10 })).toEqual([]);
  });

  it('counts a member list by its length, without reading its items', () => {
    const members = new Proxy([] as ReferentialMember[], {
      get(t, key, receiver): unknown {
        if (key === 'length') return 1e9;
        if (typeof key === 'string' && /^\d+$/.test(key)) throw new Error('item read');
        return Reflect.get(t, key, receiver);
      },
    });
    const r = withGroups({ A: members });
    expect(validateReferential(r)).toEqual([
      { path: '', message: 'referential too large: 1000000001 nodes' },
    ]);
  });

  it('checks 10 000 groups on 4 levels, each with 2 periods, in linear work', () => {
    const r = layeredReferential();
    const nodes = 10_000 + 2 * (10_000 - 10) + 2 * 8890;
    expect(validateReferential(r)).toEqual([]);
    // 157 160 steps measured (2.8 per node); a sweep that searched the whole graph for each
    // membership would take about 10^8 steps.
    expect(referentialCheckSteps(r)).toBeLessThanOrEqual(STEPS_PER_NODE * nodes);
  });

  it('checks a chain of groups in linear work: twice as long, twice the steps', () => {
    const steps = [256, 512, 1024].map((depth) => {
      const r = nestedReferential(depth);
      expect(validateReferential(r, { maxDepth: 1024 })).toEqual([]);
      const taken = referentialCheckSteps(r, { maxDepth: 1024 });
      // A chain of n groups has 2n nodes (n groups, n members).
      expect(taken).toBeLessThanOrEqual(STEPS_PER_NODE * 2 * depth);
      return taken;
    });
    const [short = 0, middle = 0, long = 0] = steps;
    expect(middle).toBeLessThanOrEqual(2.1 * short);
    expect(long).toBeLessThanOrEqual(2.1 * middle);
  });

  it('checks a fan-in in linear work: a hub of 19 000 groups held by 19 000 groups (I1)', () => {
    const r = fanIn(19_000, 19_000);
    const nodes = 1 + 3 * 19_000 + 2 * 19_000;
    expect(validateReferential(r)).toEqual([]);
    expect(referentialCheckSteps(r)).toBeLessThanOrEqual(STEPS_PER_NODE * nodes);
  });

  it('checks 33 000 one-day periods of one membership in linear work (I1)', () => {
    const r = dailyHub(30_000, 33_000);
    const nodes = 2 + 30_000 + 30_000 + 33_000;
    expect(validateReferential(r)).toEqual([]);
    expect(referentialCheckSteps(r)).toBeLessThanOrEqual(STEPS_PER_NODE * nodes);
  });

  it('refuses a referential whose sweep exceeds maxSteps, by name (I1)', () => {
    const r = layeredReferential();
    expect(validateReferential(r, { maxSteps: 1000 })).toEqual([
      { path: 'groups', message: 'referential too complex: more than 1000 steps' },
    ]);
    expect(referentialCheckSteps(r, { maxSteps: 1000 })).toBe(1001);
    expect(specError(() => normalizeReferential(r, { maxSteps: 1000 })).message).toBe(
      'referential too complex: more than 1000 steps',
    );
  });

  it('defaults maxSteps to 100 steps per allowed node, and stops there', () => {
    // A shape whose sweep is quadratic: each of 1 000 days re-marks the 1 000 groups of HUB.
    const r = toggledHub(1000, 1000);
    const nodes = 2 * 1000 + 2 * 1000 + 3;
    expect(validateReferential(r)).toEqual([]);
    expect(validateReferential(r, { maxNodes: nodes })).toEqual([
      { path: 'groups', message: `referential too complex: more than ${100 * nodes} steps` },
    ]);
    expect(referentialCheckSteps(r, { maxNodes: nodes })).toBe(100 * nodes + 1);
  });

  it('refuses invalid options with a SpecError, never a raw error (M3)', () => {
    const throwing = {
      get maxNodes(): number {
        throw new Error('opt');
      },
    };
    const cases: [unknown, string][] = [
      [{ maxNodes: 0 }, 'maxNodes must be a positive integer'],
      [{ maxDepth: 1.5 }, 'maxDepth must be a positive integer'],
      [{ maxSteps: -1 }, 'maxSteps must be a positive integer'],
      [{ maxDepth: '64' }, 'maxDepth must be a positive integer'],
      [{ maxDepth: 1025 }, 'maxDepth must be at most 1024'],
      [null, 'options must be an object'],
      [throwing, 'options could not be read: opt'],
    ];
    for (const [options, message] of cases) {
      // The types refuse these options; a caller without types can still pass them.
      const limits = options as ReferentialLimits;
      for (const call of [
        () => validateReferential(ueReferential(), limits),
        () => normalizeReferential(ueReferential(), limits),
        () => computeReferentialDigest(ueReferential(), limits),
      ]) {
        const error = specError(call);
        expect(error.code).toBe('INVALID_REFERENTIAL');
        expect(error.message).toBe(message);
      }
    }
    expect(validateReferential(nestedReferential(1024), { maxDepth: 1024 })).toEqual([]);
  });

  it('names an unreadable member list at groups.<g>.members (M6)', () => {
    const r = ueReferential();
    const group = r.groups.UE;
    if (group) {
      group.members = new Proxy(group.members, {
        get(target, key, receiver): unknown {
          if (key === 'length') throw new Error('len');
          return Reflect.get(target, key, receiver);
        },
      });
    }
    expect(validateReferential(r)).toEqual([
      { path: 'groups.UE.members', message: 'groups.UE.members could not be read: len' },
    ]);
  });

  it('names unreadable keys of groups and codes, without throwing', () => {
    const keysThrow = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error('keys');
        },
      },
    );
    expect(validateReferential({ ...ueReferential(), groups: keysThrow })).toEqual([
      { path: 'groups', message: 'groups could not be read: keys' },
    ]);
    expect(validateReferential({ ...ueReferential(), codes: keysThrow })).toEqual([
      { path: 'codes', message: 'codes could not be read: keys' },
    ]);
  });

  it('counts the groups from their keys, before reading any group (M9)', () => {
    const names = Array.from({ length: 100_001 }, (_, i) => `G${i}`);
    const groups = new Proxy(
      {},
      {
        ownKeys: (): string[] => names,
        getOwnPropertyDescriptor: (): PropertyDescriptor => ({
          value: undefined,
          enumerable: true,
          configurable: true,
        }),
        get(): never {
          throw new Error('group read');
        },
      },
    );
    expect(validateReferential({ ...ueReferential(), groups })).toEqual([
      { path: '', message: 'referential too large: 100001 nodes' },
    ]);
  });
});

describe('computeReferentialDigest', () => {
  it('is the sha256 of the canonical normal form', () => {
    const r = ueReferential();
    expect(computeReferentialDigest(r)).toBe(sha256Hex(canonicalize(normalizeReferential(r))));
    expect(computeReferentialDigest(r)).not.toBe(sha256Hex(canonicalize(r)));
  });

  it('gives one digest to one meaning: member and period order, until null or absent', () => {
    const written = ueWithCodes();
    const reordered: Referential = {
      ...written,
      codes: {
        X: [
          { from: '2010-01-01', until: null },
          { from: '1990-01-01', until: '2000-01-01' },
        ],
        FR: [{ from: '1958-01-01', until: null }],
      },
      groups: {
        ...written.groups,
        UE: {
          exhaustive: true,
          members: [
            { value: 'X', from: '2010-01-01', until: null },
            { value: 'X', from: '1990-01-01', until: '2000-01-01' },
            { value: 'FR', from: '1958-01-01', until: null },
          ],
        },
      },
    };
    expect(computeReferentialDigest(reordered)).toBe(computeReferentialDigest(written));
  });

  it('refuses an invalid referential', () => {
    const r = withGroups({ A: [{ value: 'A' }] });
    const error = specError(() => computeReferentialDigest(r));
    expect(error.code).toBe('INVALID_REFERENTIAL');
    expect(error.message).toBe('cycle A > A from the beginning');
  });

  it('does not depend on the order of keys', () => {
    const r = ueReferential();
    const reordered: Referential = {
      groups: { MONDE: r.groups.MONDE ?? { exhaustive: false, members: [] }, ...r.groups },
      dimension: r.dimension,
      version: r.version,
      id: r.id,
      format: r.format,
    };
    expect(Object.keys(reordered)).not.toEqual(Object.keys(r));
    expect(computeReferentialDigest(reordered)).toBe(computeReferentialDigest(r));
  });

  it('changes with a membership period', () => {
    const r = ueReferential();
    const changed = ueReferential();
    const gb = changed.groups.UE?.members[1];
    if (gb) gb.until = '2021-01-01';
    expect(computeReferentialDigest(changed)).not.toBe(computeReferentialDigest(r));
  });
});

describe('sourceRef: the legal source, at every level', () => {
  /** The ue referential with a source on the referential, a group, a member and a code period. */
  function sourced(source: unknown): unknown {
    const r = ueReferential();
    return {
      ...r,
      sourceRef: source,
      codes: {
        FR: [{ from: '1958-01-01', until: null, sourceRef: source }],
        GB: [{ from: '1973-01-01', until: null }],
        HR: [{ from: '2013-07-01', until: null }],
        DK: [{ from: '1973-01-01', until: null }],
        NO: [{ from: '1958-01-01', until: null }],
      },
      groups: {
        ...r.groups,
        UE: {
          exhaustive: true,
          sourceRef: source,
          members: [
            { value: 'FR', from: '1958-01-01', sourceRef: source },
            { value: 'GB', from: '1973-01-01', until: '2020-02-01' },
          ],
        },
      },
    };
  }

  it('is accepted on the referential, a group, a member and a code period', () => {
    expect(validateReferential(sourced('Traité de Rome, art. 1'))).toEqual([]);
  });

  it.each([
    ['empty', ''],
    ['not a string', 7],
    ['null', null],
  ])('is refused when %s, at each level', (_label, source) => {
    expect(validateReferential(sourced(source))).toEqual(
      [
        'sourceRef',
        'groups.UE.sourceRef',
        'codes.FR[0].sourceRef',
        'groups.UE.members[0].sourceRef',
      ].map((path) => ({ path, message: `${path} must be a non-empty string` })),
    );
  });

  it('refuses a lone surrogate', () => {
    expect(validateReferential({ ...ueReferential(), sourceRef: 'art. \uD800' })).toEqual([
      { path: 'sourceRef', message: 'sourceRef contains a lone UTF-16 surrogate' },
    ]);
  });

  it('is content: the digest changes with it', () => {
    const r = ueReferential();
    const digest = computeReferentialDigest(r);
    expect(computeReferentialDigest({ ...r, sourceRef: 'a' })).not.toBe(digest);
    const member = ueReferential();
    const fr = member.groups.UE?.members[0];
    if (fr) fr.sourceRef = 'Traité de Rome';
    expect(computeReferentialDigest(member)).not.toBe(digest);
  });
});

/** ue with codes: FR, and X used twice with a gap, both in UE. */
function ueWithCodes(): Referential {
  return {
    format: 'run-iq.referential/1',
    id: 'ue',
    version: '1',
    dimension: 'pays',
    codes: {
      FR: [{ from: '1958-01-01' }],
      X: [{ from: '1990-01-01', until: '2000-01-01' }, { from: '2010-01-01' }],
    },
    groups: {
      UE: {
        exhaustive: true,
        members: [
          { value: 'FR', from: '1958-01-01' },
          { value: 'X', from: '1990-01-01', until: '2000-01-01' },
          { value: 'X', from: '2010-01-01' },
        ],
      },
    },
  };
}

describe('normalizeReferential', () => {
  it('sorts members and periods, writes an open end as absent', () => {
    const r: Referential = {
      format: 'run-iq.referential/1',
      id: 'r',
      version: '1',
      dimension: 'd',
      sourceRef: 'Loi 1',
      codes: {
        b: [
          { from: '2010-01-01', until: null, sourceRef: 'B2' },
          { from: '2000-01-01', until: '2005-01-01' },
        ],
        a: [{ from: '2000-01-01', until: null }],
      },
      groups: {
        G: {
          exhaustive: false,
          sourceRef: 'Décret',
          members: [
            { value: 'b', from: '2010-01-01', until: null },
            { value: 'a', sourceRef: 'S' },
            { value: 'b', from: '2000-01-01', until: '2005-01-01' },
          ],
        },
      },
    };
    expect(normalizeReferential(r)).toEqual({
      format: 'run-iq.referential/1',
      id: 'r',
      version: '1',
      dimension: 'd',
      sourceRef: 'Loi 1',
      codes: {
        a: [{ from: '2000-01-01' }],
        b: [
          { from: '2000-01-01', until: '2005-01-01' },
          { from: '2010-01-01', sourceRef: 'B2' },
        ],
      },
      groups: {
        G: {
          exhaustive: false,
          sourceRef: 'Décret',
          members: [
            { value: 'a', sourceRef: 'S' },
            { value: 'b', from: '2000-01-01', until: '2005-01-01' },
            { value: 'b', from: '2010-01-01' },
          ],
        },
      },
    });
  });

  it('keeps an identical repeated entry once; validate accepts it as one', () => {
    const r = withGroups({
      A: [
        { value: 'x', from: '2000-01-01', until: null },
        { value: 'x', from: '2000-01-01' },
      ],
    });
    expect(validateReferential(r)).toEqual([]);
    expect(normalizeReferential(r).groups.A?.members).toEqual([{ value: 'x', from: '2000-01-01' }]);
    const codes = {
      ...r,
      codes: { x: [{ from: '2000-01-01' }, { from: '2000-01-01', until: null }] },
    };
    expect(validateReferential(codes)).toEqual([]);
    expect(normalizeReferential(codes).codes).toEqual({ x: [{ from: '2000-01-01' }] });
  });

  it('a member with two sources on the same period is still listed twice', () => {
    const r = withGroups({
      A: [
        { value: 'x', sourceRef: 'a' },
        { value: 'x', sourceRef: 'b' },
      ],
    });
    expect(validateReferential(r)).toEqual([
      { path: 'groups.A.members', message: 'groups.A.members lists x twice from the beginning' },
    ]);
  });

  it('merges adjacent periods with one source: one meaning, one digest (M1)', () => {
    const split = ueReferential();
    const members = split.groups.UE?.members ?? [];
    const fr = members.findIndex((m) => m.value === 'FR');
    members.splice(
      fr,
      1,
      { value: 'FR', from: '1958-01-01', until: '2000-01-01' },
      { value: 'FR', from: '2000-01-01', until: '2010-01-01' },
      { value: 'FR', from: '2010-01-01' },
    );
    expect(validateReferential(split)).toEqual([]);
    expect(normalizeReferential(split)).toEqual(normalizeReferential(ueReferential()));
    expect(computeReferentialDigest(split)).toBe(computeReferentialDigest(ueReferential()));
    const codes = {
      ...withGroups({}),
      codes: {
        x: [
          { from: '2010-01-01', sourceRef: 's' },
          { from: '2000-01-01', until: '2010-01-01', sourceRef: 's' },
        ],
      },
    };
    expect(normalizeReferential(codes).codes).toEqual({
      x: [{ from: '2000-01-01', sourceRef: 's' }],
    });
  });

  it('keeps the boundary between two sources: a source is content (M1)', () => {
    const sourced = (second: string): Referential =>
      withGroups({
        A: [
          { value: 'x', from: '2000-01-01', until: '2010-01-01', sourceRef: 'a' },
          { value: 'x', from: '2010-01-01', sourceRef: second },
        ],
      });
    expect(normalizeReferential(sourced('b')).groups.A?.members).toEqual([
      { value: 'x', from: '2000-01-01', until: '2010-01-01', sourceRef: 'a' },
      { value: 'x', from: '2010-01-01', sourceRef: 'b' },
    ]);
    expect(normalizeReferential(sourced('a')).groups.A?.members).toEqual([
      { value: 'x', from: '2000-01-01', sourceRef: 'a' },
    ]);
    expect(computeReferentialDigest(sourced('b'))).not.toBe(computeReferentialDigest(sourced('a')));
  });

  it('is idempotent', () => {
    for (const r of [ueReferential(), ueWithCodes(), nestedReferential(64), layeredReferential()]) {
      const once = normalizeReferential(r);
      expect(normalizeReferential(once)).toEqual(once);
    }
  });

  it('validate(normalize(x)) agrees with validate(x)', () => {
    for (const r of [ueReferential(), ueWithCodes(), nestedReferential(64), layeredReferential()]) {
      expect(validateReferential(r)).toEqual([]);
      expect(validateReferential(normalizeReferential(r))).toEqual([]);
    }
    const invalid: unknown[] = [
      withGroups({ A: [{ value: 'B' }], B: [{ value: 'A' }] }),
      nestedReferential(65),
      { ...ueReferential(), format: 'x' },
      withGroups({ A: [{ value: 'x', from: '2020-01-01', until: '2019-01-01' }] }),
    ];
    for (const r of invalid) {
      const [first] = validateReferential(r);
      const error = specError(() => normalizeReferential(r));
      expect(error.code).toBe('INVALID_REFERENTIAL');
      expect(error.message).toBe(first?.message);
    }
  });

  it('shares nothing with its input, and reads each property once', () => {
    let reads = 0;
    const r = {
      ...ueReferential(),
      get id(): string {
        reads++;
        return reads === 1 ? 'ue' : '';
      },
    };
    const normal = normalizeReferential(r);
    expect(reads).toBe(1);
    expect(normal.id).toBe('ue');
    const source = ueReferential();
    const copy = normalizeReferential(source);
    source.groups.UE?.members.push({ value: 'XX' });
    expect(copy.groups.UE?.members).toHaveLength(4);
  });

  it('honours the limits', () => {
    expect(specError(() => normalizeReferential(ueReferential(), { maxNodes: 9 })).message).toBe(
      'referential too large: 10 nodes',
    );
  });
});
