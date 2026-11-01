import { describe, expect, it } from 'vitest';
import { sealProof, verifyProof } from '../src/index.js';
import type { UnsignedProof } from '../src/index.js';
import { baseContent, entries, unsaltedSalt } from './proof-cases.js';
import { problems, withEntry, withSection } from './proof-builders.js';
import type { Content, Entry } from './proof-builders.js';
import { omit } from './helpers.js';

describe('the base proof', () => {
  it('is consistent: sealed, verified, sealed again to the same digest', () => {
    expect(problems(baseContent())).toEqual([]);
    const sealed = sealProof(baseContent() as unknown as UnsignedProof);
    expect(verifyProof(sealed)).toEqual({ status: 'consistent', issues: ['unsigned'] });
    expect(sealProof(sealed).digest).toBe(sealed.digest);
  });

  it('carries the D-14 salts of UNSALTED_SEED (re-review N1)', () => {
    expect(unsaltedSalt('rules', 0)).toBe('4f6b739dbae8bd24e9b989ba83ac1ce8');
    expect(unsaltedSalt('outputs', 0)).toBe('6cbe209d3d49721370cf22381dbcfaeb');
    expect(unsaltedSalt('applied', 0)).toBe('dca0cd90dd33d120447c09da86ae29b1');
    const sealed = sealProof(baseContent() as unknown as UnsignedProof);
    expect(sealed.rules[0]?.salt).toBe('4f6b739dbae8bd24e9b989ba83ac1ce8');
    expect(sealed.outputs[0]?.salt).toBe('6cbe209d3d49721370cf22381dbcfaeb');
    expect(sealed.applied[0]?.salt).toBe('dca0cd90dd33d120447c09da86ae29b1');
  });
});

describe('outputs: a list sorted by name, one entry per name', () => {
  const outputs = entries('outputs');

  it('refuses a name listed twice', () => {
    const twice = [...outputs.slice(0, 3), outputs[2] as Entry, outputs[3] as Entry];
    expect(problems(withSection('outputs', twice))).toEqual(['duplicate output: value']);
  });

  it('refuses a list out of order', () => {
    const swapped = [outputs[1], outputs[0], outputs[2], outputs[3]] as Entry[];
    expect(problems(withSection('outputs', swapped))).toEqual(['outputs not sorted at 1']);
  });

  it('refuses a value on an undetermined output', () => {
    expect(problems(withEntry('outputs', 2, { status: 'undetermined' }))).toEqual([
      'undetermined output has a value: value',
    ]);
  });

  it('refuses bounds on a settled output', () => {
    expect(problems(withEntry('outputs', 2, { bounds: { min: 0 } }))).toEqual([
      'bounds on a settled output: value',
    ]);
  });

  it('refuses a selection on an undetermined output (pre-flight M-10)', () => {
    const content = withEntry('outputs', 3, { status: 'undetermined', value: undefined });
    expect(problems(content)).toEqual(['selected on an undetermined output: vat:level']);
  });

  it('refuses a selection outside max, min and highestPriority', () => {
    expect(problems(withEntry('outputs', 2, { selected: { ruleId: 'r1' } }))).toEqual([
      'selected on a sum output: value',
    ]);
  });

  it('refuses a value, bounds or a selection on a per output', () => {
    for (const patch of [{ value: '1' }, { bounds: { min: '1' } }, { selected: { ruleId: 'k' } }]) {
      expect(problems(withEntry('outputs', 0, patch))).toEqual([
        'per output carries a value: kids',
      ]);
    }
  });

  it('refuses contributors on a per output: they belong to its items', () => {
    expect(problems(withEntry('outputs', 0, { contributors: ['k'] }))).toEqual([
      'per output carries contributors: kids',
    ]);
  });

  it('refuses bounds without min or max, and min above max', () => {
    const content = withEntry('items', 1, { bounds: {} });
    expect(problems(content)).toEqual(['bounds without min or max: kids at /enfants/@c9']);
    const reversed = withEntry('items', 1, { bounds: { min: '2', max: '1' } });
    expect(problems(reversed)).toEqual(['bounds min above max: kids at /enfants/@c9']);
  });

  it('accepts an output without value: a max no rule reached', () => {
    const content = withEntry('outputs', 3, {
      value: undefined,
      contributors: [],
      selected: undefined,
      status: 'determined',
    });
    const applied = entries('applied').slice(0, 4);
    expect(problems({ ...content, applied })).toEqual([]);
  });

  it('refuses a settled output without value when its rules gave one', () => {
    const content = withEntry('outputs', 2, { value: undefined });
    expect(problems(content)).toEqual(['settled output has no value: value']);
  });

  it('refuses a settled max with a value and no selection (D-27)', () => {
    expect(problems(withEntry('outputs', 3, { selected: undefined }))).toEqual([
      'selected missing: vat:level',
    ]);
  });

  it('refuses an all output no rule reached that is not undetermined', () => {
    const content = withEntry('outputs', 1, {
      empty: undefined,
      value: undefined,
      contributors: [],
      status: 'determined',
    });
    const applied = entries('applied').filter((step) => step.output !== 'social:aid');
    const readsUndeclared: Entry[] = [];
    expect(problems({ ...content, applied, readsUndeclared })).toEqual([
      'all output without contribution must be undetermined: social:aid',
    ]);
  });
});

describe('items (pre-flight I19)', () => {
  const items = entries('items');

  it('refuses an item of an output that is not per element', () => {
    const extra = { ...items[0], output: 'value' };
    expect(problems(withSection('items', [...items, extra]))).toEqual([
      'item of a non-per output: value',
    ]);
  });

  it('refuses an item of an output not listed', () => {
    const extra = { ...items[0], output: 'zz' };
    expect(problems(withSection('items', [...items, extra]))).toEqual([
      'cited output not listed: zz',
    ]);
  });

  it('refuses the same element twice, and items out of order', () => {
    const twice = [items[0], items[0], items[1]] as Entry[];
    expect(problems(withSection('items', twice))).toEqual(['duplicate item: kids at /enfants/@a7']);
    const swapped = [items[1], items[0]] as Entry[];
    expect(problems(withSection('items', swapped))).toEqual(['items not sorted at 1']);
  });

  it('checks status, value and bounds as on an output', () => {
    expect(problems(withEntry('items', 1, { value: '1' }))).toEqual([
      'undetermined output has a value: kids at /enfants/@c9',
    ]);
    expect(problems(withEntry('items', 0, { bounds: { min: '1' } }))).toEqual([
      'bounds on a settled output: kids at /enfants/@a7',
    ]);
  });

  it('the status of a per output is the strongest of its items', () => {
    expect(problems(withEntry('outputs', 0, { status: 'provisional' }))).toEqual([
      'per output status differs from its items: kids',
    ]);
  });

  it('a per output without item is determined', () => {
    const content = { ...withEntry('outputs', 0, { status: 'determined' }), items: [] };
    const applied = entries('applied').slice(1);
    const pending: Entry[] = [];
    const skipped = entries('skipped').slice(1);
    expect(problems({ ...content, applied, pending, skipped })).toEqual([]);
  });

  it('refuses a step of a per output that feeds no item', () => {
    const content = withEntry('applied', 0, { subject: '/enfants/@zz' });
    expect(problems(content)).toEqual([
      'step feeds no item: k@1 at /enfants/@zz',
      'contributors differ from applied steps: kids at /enfants/@a7',
      'output value does not follow from its contributions: kids at /enfants/@a7',
    ]);
  });
});

describe('orders and identities (D-16, pre-flight I4)', () => {
  const skip = (version: number): Entry => ({
    ruleId: 'vat:R2',
    version,
    subject: '/a/@1',
    output: 'vat:level',
    reason: 'DOMINATED',
    status: 'determined',
    stratum: 1,
  });

  it('two versions of one rule at one subject: v1 then v2, never v2 then v1', () => {
    const skipped = entries('skipped').slice(0, 2);
    expect(problems(withSection('skipped', [...skipped, skip(1), skip(2)]))).toEqual([
      'rule decided twice: vat:R2@1 at /a/@1',
    ]);
    const rules = entries('rules');
    const r3 = { ...rules[7], version: 3, salt: unsaltedSalt('rules', 8) };
    const content = (list: Entry[]): Content => ({
      ...withSection('skipped', list),
      rules: [...rules, r3],
    });
    const ordered = [...skipped, { ...skip(2) }, { ...skip(3) }];
    expect(problems(content(ordered))).toEqual([]);
    expect(problems(content([...skipped, skip(3), skip(2)]))).toEqual(['skipped not sorted at 3']);
  });

  it('applied and pending are sorted the same way, an entry without subject first', () => {
    const applied = entries('applied');
    const swapped = [applied[1], applied[0], ...applied.slice(2)] as Entry[];
    expect(problems(withSection('applied', swapped))).toEqual(['applied not sorted at 1']);
    const pending = entries('pending');
    const first = omit(pending[0]!, 'subject');
    const twice = [pending[0], first] as Entry[];
    expect(problems(withSection('pending', twice))).toContain('pending not sorted at 1');
  });

  it('refuses one instance decided twice, in two sections', () => {
    const pending = entries('pending');
    const applied = { ...pending[0], subject: '/enfants/@a7' };
    const content = withSection('pending', [applied, pending[0] as Entry]);
    expect(problems(content)).toContain('rule decided twice: k@1 at /enfants/@a7');
  });

  it('rules sorted by (rule set, id, version)', () => {
    const rules = entries('rules');
    const swapped = [rules[0], rules[4], rules[1], rules[2], rules[3], ...rules.slice(5)];
    // local before social: the first entry out of order is the local rule after R1 of social.
    expect(problems(withSection('rules', swapped as Entry[]))).toEqual(['rules not sorted at 2']);
  });

  it('readsUndeclared sorted, unique, of listed rules', () => {
    const read = (ruleId: string, version: number): Entry => ({ ruleId, version });
    const swapped = [read('vat:R2', 1), read('social:R1', 1)];
    expect(problems(withSection('readsUndeclared', swapped))).toEqual([
      'readsUndeclared not sorted at 1',
    ]);
    const twice = [read('social:R1', 1), read('social:R1', 1)];
    expect(problems(withSection('readsUndeclared', twice))).toEqual([
      'duplicate undeclared read: social:R1@1',
    ]);
    expect(problems(withSection('readsUndeclared', [read('vat:R9', 1)]))).toEqual([
      'cited rule not listed: vat:R9@1',
    ]);
  });

  it('facts read and missing facts sorted by comparePointers, unique', () => {
    const facts = entries('factsRead');
    const swapped = [facts[0], facts[2], facts[1]] as Entry[];
    expect(problems(withSection('factsRead', swapped))).toEqual(['factsRead not sorted at 2']);
    const twice = [facts[0], facts[1], facts[1]] as Entry[];
    expect(problems(withSection('factsRead', twice))).toEqual([
      'duplicate fact read: /enfants/0/revenu',
    ]);
    // Decoded segments: "~" (~0) sorts before "/" (~1)? No: "/" is 0x2F, "~" is 0x7E.
    const escaped = [{ path: '/a~1' }, { path: '/a~0' }];
    expect(problems(withSection('missingFacts', escaped))).toEqual([]);
    expect(problems(withSection('missingFacts', [...escaped].reverse()))).toEqual([
      'missingFacts not sorted at 1',
    ]);
    const missing = [{ path: '/x' }, { path: '/x' }];
    expect(problems(withSection('missingFacts', missing))).toEqual(['duplicate missing fact: /x']);
  });

  it('missing pointers of a pending rule sorted, unique', () => {
    expect(problems(withEntry('pending', 0, { missing: ['/b', '/a'] }))).toEqual([
      'pending[0].missing not sorted at 1',
    ]);
    expect(problems(withEntry('pending', 0, { missing: ['/a', '/a'] }))).toEqual([
      'pending[0].missing repeats /a',
    ]);
  });

  it('matches: values and via sorted, unique', () => {
    const matches = (values: string[], via: string[]): Entry => ({
      matches: { pays: { values, via } },
    });
    expect(problems(withEntry('applied', 0, matches(['FR', 'DE'], [])))).toEqual([
      'applied[0].matches.pays.values not sorted at 1',
    ]);
    expect(problems(withEntry('applied', 0, matches(['FR'], ['UE', 'UE'])))).toEqual([
      'applied[0].matches.pays.via repeats UE',
    ]);
  });

  it('components sorted by (name, version, digest, declaredBy), unique', () => {
    const versions = baseContent().versions as Content;
    const components = versions.components as Entry[];
    const reversed = { ...versions, components: [...components].reverse() };
    expect(problems({ ...baseContent(), versions: reversed })).toEqual([
      'components not sorted at 1',
    ]);
    const twice = { ...versions, components: [components[0], components[0]] };
    expect(problems({ ...baseContent(), versions: twice })).toEqual(['component repeated at 1']);
    // An absent digest sorts before any digest.
    const tz = { name: 'tzdata', version: '2026c', declaredBy: 'engine' };
    const withDigest = { ...tz, digest: 'a'.repeat(64) };
    const ordered = { ...versions, components: [tz, withDigest] };
    expect(problems({ ...baseContent(), versions: ordered })).toEqual([]);
  });

  it('affected sorted by (rule, subject), unique', () => {
    const affected = [{ ruleId: 'r2', subject: '/a/@1' }, { ruleId: 'r2' }];
    expect(problems(withEntry('exceptions', 0, { affected }))).toEqual([
      'exceptions[0].affected not sorted at 1',
    ]);
    expect(
      problems(withEntry('exceptions', 0, { affected: [{ ruleId: 'r2' }, { ruleId: 'r2' }] })),
    ).toEqual(['exceptions[0].affected repeats r2']);
  });
});

describe('requested and supersedes', () => {
  it('requested sorted, unique, each a listed output', () => {
    expect(problems({ ...baseContent(), requested: ['value', 'kids'] })).toEqual([
      'requested not sorted at 1',
    ]);
    expect(problems({ ...baseContent(), requested: ['kids', 'kids'] })).toEqual([
      'requested repeats kids',
    ]);
    expect(problems({ ...baseContent(), requested: ['kids', 'zz'] })).toEqual([
      'requested output absent: zz',
    ]);
  });
});

describe('rule sets (D-23)', () => {
  const ruleSets = baseContent().ruleSets as Entry[];

  it('keeps their order: it is the precedence', () => {
    const reordered = [ruleSets[2], ruleSets[1], ruleSets[0], ruleSets[3]];
    expect(problems({ ...baseContent(), ruleSets: reordered })).toEqual([]);
  });

  it('at most one local entry, one entry per pack', () => {
    const twice = [...ruleSets, { kind: 'local' }];
    expect(problems({ ...baseContent(), ruleSets: twice })).toEqual([
      'rule set listed twice: local',
    ]);
    const pack = [...ruleSets, { ...ruleSets[1] }];
    expect(problems({ ...baseContent(), ruleSets: pack })).toEqual([
      'rule set listed twice: social',
    ]);
  });

  it('every rule belongs to a listed pack or to local', () => {
    const rules = ruleSets.filter((set) => set.kind !== 'pack' || set.id !== 'social');
    expect(problems({ ...baseContent(), ruleSets: rules })).toEqual([
      'rule set not listed: social',
      'rule set imports a pack not listed: vat',
    ]);
    // local needs no entry: its rules come last.
    const withoutLocal = ruleSets.filter((set) => set.kind !== 'local');
    expect(problems({ ...baseContent(), ruleSets: withoutLocal })).toEqual([]);
  });

  it('imports sorted, unique, never the pack itself', () => {
    const vat = (imports: string[]): Content => ({
      ...baseContent(),
      ruleSets: [{ ...ruleSets[0], imports }, ...ruleSets.slice(1)],
    });
    expect(problems(vat(['vat']))).toEqual([
      'rule set imports itself: vat',
      'rule feeds an output of a rule set it does not import: vat:R1@1',
    ]);
    const other = { kind: 'pack', id: 'aa', version: '1', digest: 'a'.repeat(64) };
    const twoImports = (imports: string[]): Content => ({
      ...baseContent(),
      ruleSets: [{ ...ruleSets[0], imports }, ...ruleSets.slice(1), other],
    });
    expect(problems(twoImports(['social', 'aa']))).toEqual(['ruleSets[0].imports not sorted at 1']);
    expect(problems(twoImports(['social', 'social']))).toEqual([
      'ruleSets[0].imports repeats social',
    ]);
  });

  it('a rule feeds an output of another rule set only if its pack imports it', () => {
    const ruleSet = { ...ruleSets[0] };
    delete ruleSet.imports;
    expect(problems({ ...baseContent(), ruleSets: [ruleSet, ...ruleSets.slice(1)] })).toEqual([
      'rule feeds an output of a rule set it does not import: vat:R1@1',
    ]);
  });

  it('a local rule never feeds the output of a pack (pre-flight M-22)', () => {
    const step = { ruleId: 'r1', output: 'vat:level' };
    expect(problems(withEntry('skipped', 1, { output: step.output }))).toContain(
      'rule feeds an output of a rule set it does not import: r2@2',
    );
  });
});

describe('qualified citations (D-37)', () => {
  it('two rules R1@1 of two packs coexist without collision', () => {
    const content = baseContent();
    const rules = content.rules as Entry[];
    expect(rules.filter((rule) => rule.id === 'R1').map((rule) => rule.ruleSet)).toEqual([
      'social',
      'vat',
    ]);
    expect(problems(content)).toEqual([]);
  });

  it.each([
    [
      'contributors',
      () => withEntry('outputs', 1, { contributors: ['R1', 'social:R1', 'vat:R1'] }),
    ],
    ['pending', () => withEntry('items', 1, { pending: ['k', 'vat:R9'] })],
    ['selected', () => withEntry('outputs', 3, { selected: { ruleId: 'social:R2' } })],
    ['affected', () => withEntry('exceptions', 0, { affected: [{ ruleId: 'R2' }] })],
  ])('an unlisted rule in %s', (_label, content) => {
    const found = problems(content());
    const [first] = found;
    expect(first).toMatch(/^cited rule not listed: /);
  });

  it('a section entry cites its rule by qualified id and version', () => {
    expect(problems(withEntry('applied', 4, { ruleId: 'social:R2' }))[0]).toBe(
      'cited rule not listed: social:R2@1',
    );
    expect(problems(withEntry('exceptions', 0, { ruleId: 'vat:x' }))[0]).toBe(
      'cited rule not listed: vat:x@1',
    );
  });

  it('every applied model is in versions.models', () => {
    expect(problems(withEntry('applied', 1, { model: 'OTHER' }))).toEqual([
      'model not in versions: OTHER',
    ]);
  });
});
