import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  computeReferentialDigest,
  sha256Hex,
  validateReferential,
} from '../src/index.js';
import type { Referential, ReferentialMember } from '../src/index.js';
import { nestedReferential, ueReferential } from './helpers.js';

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
      'a code period without until',
      { ...withGroups({ A: [{ value: 'x' }] }), codes: { x: [{ from: '2000-01-01' }] } },
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

  it('validates 10 000 groups on 4 levels, each with 2 periods, in under 2 s', () => {
    const groups: Record<string, ReferentialMember[]> = {};
    const twice = (value: string): ReferentialMember[] => [
      { value, from: '2000-01-01', until: '2010-01-01' },
      { value, from: '2010-01-01' },
    ];
    const sizes = [10, 100, 1000, 8890];
    let previous: string[] = [];
    sizes.forEach((size, level) => {
      const names = Array.from({ length: size }, (_, i) => `L${level}-${i}`);
      for (const name of names) groups[name] = [];
      names.forEach((name, i) => {
        const parent = previous[i % Math.max(previous.length, 1)];
        if (parent !== undefined) groups[parent]?.push(...twice(name));
      });
      previous = names;
    });
    for (const leaf of previous) groups[leaf]?.push(...twice(`code-${leaf}`));
    const r = withGroups(groups);
    expect(Object.keys(r.groups)).toHaveLength(10_000);
    const start = performance.now();
    expect(validateReferential(r)).toEqual([]);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it('refuses invalid options with a SpecError', () => {
    expect(() => validateReferential(ueReferential(), { maxNodes: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_REFERENTIAL' }),
    );
    expect(() => validateReferential(ueReferential(), { maxDepth: 1.5 })).toThrow(
      expect.objectContaining({ code: 'INVALID_REFERENTIAL' }),
    );
  });
});

describe('computeReferentialDigest', () => {
  it('is the sha256 of the canonical form', () => {
    const r = ueReferential();
    expect(computeReferentialDigest(r)).toBe(sha256Hex(canonicalize(r)));
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
