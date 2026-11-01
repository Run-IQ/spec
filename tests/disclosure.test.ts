import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  computeInputDigest,
  deriveInputSeed,
  DISCLOSURE_FORMAT,
  discloseFacts,
  inputLeaves,
  UNSALTED_SEED,
  verifyFactDisclosure,
} from '../src/index.js';
import type {
  FactDisclosure,
  FactDisclosureVerification,
  InputLeaf,
  JsonValue,
  ProofInput,
} from '../src/index.js';
import * as canonicalEntry from '../src/canonical-entry.js';
import {
  fromHex,
  handTree,
  hashWorkOf,
  hex,
  jsonCopy,
  loose,
  proofInput,
  specError,
} from './helpers.js';
import type { HandLeaf, TreeLeaf } from './helpers.js';
import first from './vectors/input-v1.json';
import second from './vectors/input-v2.json';
import vectors from './vectors/disclosure-v1.json';

const X: ProofInput = first.input;
const SEED = deriveInputSeed(fromHex(first.secret), first.requestId);
const DIGEST = computeInputDigest(X, SEED);
const OTHER_SEED = deriveInputSeed(fromHex('43'.repeat(32)), first.requestId);

/** The input vectors the disclosure vectors name, their inputs typed as inputs. */
const INPUTS: Readonly<Record<string, { input: ProofInput; secret: string; requestId: string }>> = {
  'input-v1.json': first,
  'input-v2.json': { ...second, input: loose<ProofInput>(second.input) },
};

/** What `verifyFactDisclosure` returns for a disclosure it refuses with `issues`. */
function refused(issues: string[]): FactDisclosureVerification {
  return { valid: false, issues, facts: {}, lists: {}, absent: [] };
}

/** `verifyFactDisclosure` of a JSON copy of `d` against `digest` (by default that of X). */
function verify(d: unknown, digest = DIGEST): FactDisclosureVerification {
  return verifyFactDisclosure(jsonCopy(d), digest);
}

/** The disclosure of X under SEED. */
function disclose(present: string[], absent: string[] = []): FactDisclosure {
  return discloseFacts(X, SEED, present, absent);
}

/** A JSON copy of `d`, changed by `change`. */
function changed(d: FactDisclosure, change: (copy: FactDisclosure) => void): FactDisclosure {
  const copy = jsonCopy(d);
  change(copy);
  return copy;
}

/** The leaves of X in their order, unsalted: what an honest tree holds. */
function leavesOf(input: ProofInput): InputLeaf[] {
  return inputLeaves(input, UNSALTED_SEED);
}

/** True when `pointer` names a value of `input`: a leaf at it or below it (escaped prefix). */
function isPresent(input: ProofInput, pointer: string): boolean {
  return leavesOf(input).some(
    (leaf) => leaf.pointer === pointer || leaf.pointer.startsWith(`${pointer}/`),
  );
}

/**
 * True when what `result` claims holds for `input`: each fact is the value of its leaf, each list
 * length that of its list, each absent pointer absent.
 */
function claimsHold(input: ProofInput, result: FactDisclosureVerification): boolean {
  const leaves = new Map(leavesOf(input).map((leaf) => [leaf.pointer, leaf]));
  const factsHold = Object.entries(result.facts).every(([pointer, value]) => {
    const leaf = leaves.get(pointer);
    if (leaf?.kind === 'object') return JSON.stringify(value) === '{}';
    return leaf?.kind === 'value' && Object.is(leaf.value, value);
  });
  const listsHold = Object.entries(result.lists).every(([pointer, length]) => {
    const leaf = leaves.get(pointer);
    return leaf?.kind === 'array' && leaf.length === length;
  });
  return factsHold && listsHold && result.absent.every((pointer) => !isPresent(input, pointer));
}

describe('frozen vectors disclosure-v1 (computed by an independent Python script)', () => {
  it.each(vectors.cases.map((c, i) => [i, c] as const))('case %i', (_i, c) => {
    const vector = INPUTS[c.input];
    if (vector === undefined) throw new Error(`no input ${c.input}`);
    const seed = deriveInputSeed(fromHex(vector.secret), vector.requestId);
    const disclosure = discloseFacts(vector.input, seed, c.present, c.absent);
    expect(disclosure).toEqual(c.disclosure);
    // The order of the requests does not change the disclosure.
    const reversed = discloseFacts(vector.input, seed, [...c.present].reverse(), [
      ...c.absent.reverse(),
    ]);
    expect(reversed).toEqual(c.disclosure);
    const result = verify(c.disclosure, computeInputDigest(vector.input, seed));
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.absent).toEqual(c.disclosure.absent.map((entry) => entry.pointer));
    expect(claimsHold(vector.input, result)).toBe(true);
  });

  it('case 1 gives every fact and list it discloses', () => {
    const [, c] = vectors.cases;
    if (c === undefined) throw new Error('no case 1');
    expect(verify(c.disclosure, second.salted.inputDigest)).toEqual({
      valid: true,
      issues: [],
      facts: {
        '/data/a~0b': 1.5,
        '/data/c~1d': 'é\u{1F600}',
        '/data/l/10': 10,
        '/data/n/2': {},
        '/meta/context/k/0': 0.5,
      },
      lists: { '/data/n': 3 },
      absent: [
        '/data/a~1b',
        '/data/l/01',
        '/data/l/1/x',
        '/data/l/12',
        '/data/é/f',
        '/meta/context/~0/x',
        '/meta/z',
      ],
    });
  });

  it('both entries export the same functions', () => {
    expect(canonicalEntry.discloseFacts).toBe(discloseFacts);
    expect(canonicalEntry.verifyFactDisclosure).toBe(verifyFactDisclosure);
    expect(canonicalEntry.DISCLOSURE_FORMAT).toBe('run-iq.disclosure/1');
    expect(DISCLOSURE_FORMAT).toBe('run-iq.disclosure/1');
  });
});

describe('discloseFacts and verifyFactDisclosure', () => {
  it('discloses a fact and proves an absence', () => {
    const d = disclose(['/data/a'], ['/data/z']);
    expect(verify(d)).toEqual({
      valid: true,
      issues: [],
      facts: { '/data/a': 1 },
      lists: {},
      absent: ['/data/z'],
    });
  });

  it('a value changed to 2 is not in the tree', () => {
    const d = changed(disclose(['/data/a'], ['/data/z']), (copy) => {
      const [fact] = copy.facts;
      if (fact) fact.value = 2;
    });
    expect(verify(d)).toEqual(refused(['leaf not in tree: /data/a']));
  });

  it('proves the absence of /data/d/x by its two neighbours', () => {
    const d = disclose([], ['/data/d/x']);
    const [entry] = d.absent;
    expect(entry?.before?.pointer).toBe('/data/d/e');
    expect(entry?.before?.index).toBe(3);
    expect(entry?.after?.pointer).toBe('/meta/assertions');
    expect(entry?.after?.index).toBe(4);
    expect(verify(d)).toMatchObject({ valid: true, absent: ['/data/d/x'] });
  });

  it('proves an absence before the first leaf by that leaf alone', () => {
    const d = disclose([], ['/data/0']);
    expect(d.absent).toEqual([{ pointer: '/data/0', after: expect.anything() }]);
    expect(d.absent[0]?.after?.index).toBe(0);
    expect(verify(d)).toMatchObject({ valid: true, absent: ['/data/0'] });
  });

  it('proves an absence after the last leaf by that leaf alone, its size committed', () => {
    const d = disclose([], ['/meta/z']);
    expect(d.absent).toEqual([{ pointer: '/meta/z', before: expect.anything() }]);
    expect(d.absent[0]?.before?.index).toBe(9);
    expect(verify(d)).toMatchObject({ valid: true, absent: ['/meta/z'] });
    // Under a larger size, the last leaf is not the last one: its path no longer verifies.
    expect(verify(changed(d, (copy) => (copy.size = 11))).issues).toEqual([
      '/absent/0/before/path must hold 3 hashes (the audit path of leaf 9 of 11)',
    ]);
  });

  it('a scalar leaf above the pointer proves its absence alone', () => {
    const d = disclose([], ['/data/a/b', '/meta/tenantId/x/y']);
    expect(d.absent.map((entry) => [entry.before?.pointer, entry.after])).toEqual([
      ['/data/a', undefined],
      ['/meta/tenantId', undefined],
    ]);
    expect(verify(d)).toMatchObject({ valid: true, absent: ['/data/a/b', '/meta/tenantId/x/y'] });
  });

  it('a list or an empty object above the pointer needs both neighbours', () => {
    const d = disclose([], ['/data/b/0', '/data/c/x']);
    expect(d.absent.map((entry) => [entry.before?.pointer, entry.after?.pointer])).toEqual([
      ['/data/b', '/data/c'],
      ['/data/c', '/data/d/e'],
    ]);
    expect(verify(d).valid).toBe(true);
    // A list alone is no proof: the elements of a list follow it.
    const alone = changed(d, (copy) => {
      const [entry] = copy.absent;
      if (entry) delete entry.after;
    });
    expect(verify(alone).issues).toEqual([
      'absence not proven: /data/b/0 (the before leaf is not the last leaf)',
    ]);
  });

  it('refuses to prove the absence of a present pointer', () => {
    for (const pointer of ['/data/a', '/data/d', '/data', '/meta', '']) {
      expect(specError(() => disclose([], [pointer]))).toMatchObject({
        code: 'INVALID_DISCLOSURE',
        message: `pointer is present: ${pointer}`,
      });
    }
  });

  it('discloses leaves only: a non-empty object or an absent pointer is refused', () => {
    expect(specError(() => disclose(['/data/d']))).toMatchObject({
      code: 'INVALID_DISCLOSURE',
      message: 'pointer names no leaf: /data/d (a non-empty object: disclose its members)',
    });
    expect(specError(() => disclose(['/data/z']))).toMatchObject({
      code: 'INVALID_DISCLOSURE',
      message: 'pointer is absent: /data/z',
    });
  });

  it('discloses lists and empty objects as such', () => {
    expect(verify(disclose(['/data/b', '/data/c', '/meta/tags']))).toEqual({
      valid: true,
      issues: [],
      facts: { '/data/c': {} },
      lists: { '/data/b': 0, '/meta/tags': 0 },
      absent: [],
    });
  });

  it('verified against another digest, a disclosure is invalid', () => {
    const d = disclose(['/data/a'], ['/data/z']);
    const other = computeInputDigest(proofInput(), SEED);
    expect(verify(d, other)).toEqual(refused(['input digest mismatch']));
    // Claiming the other digest does not help: no leaf is in that tree.
    const claimed = changed(d, (copy) => (copy.inputDigest = other));
    expect(verify(claimed, other)).toEqual(
      refused([
        'leaf not in tree: /data/a',
        'leaf not in tree: /data/d/e',
        'leaf not in tree: /meta/assertions',
      ]),
    );
  });

  it('an unknown format is invalid', () => {
    const d = changed(disclose(['/data/a']), (copy) => {
      (copy as { format: string }).format = 'run-iq.disclosure/2';
    });
    expect(verify(d)).toEqual(refused(['unknown format: run-iq.disclosure/2']));
  });

  it('refuses an unsalted input, whatever array holds the 32 zero bytes', () => {
    for (const seed of [UNSALTED_SEED, new Uint8Array(32), Buffer.alloc(32)]) {
      expect(specError(() => discloseFacts(X, seed, ['/data/a'], []))).toMatchObject({
        code: 'INVALID_DISCLOSURE',
        message: 'unsalted input cannot be disclosed',
      });
    }
    // UNSALTED_SEED is not written to.
    expect(UNSALTED_SEED.every((byte) => byte === 0)).toBe(true);
  });

  it('erasure: under another seed (the secret erased, then replaced) the link is cut', () => {
    const d = disclose(['/data/a'], ['/data/z']);
    const replaced = computeInputDigest(X, OTHER_SEED);
    expect(verify(d, replaced)).toEqual(refused(['input digest mismatch']));
    const claimed = changed(d, (copy) => (copy.inputDigest = replaced));
    expect(verify(claimed, replaced).valid).toBe(false);
    expect(verify(claimed, replaced).issues).toContain('leaf not in tree: /data/a');
  });

  it('checks the seed, then the requests, then the input', () => {
    expect(specError(() => discloseFacts(X, new Uint8Array(31), ['/data/a'], []))).toMatchObject({
      code: 'INVALID_KEY',
      message: 'the input seed must be a Uint8Array of 32 bytes, got 31 bytes',
    });
    expect(specError(() => discloseFacts(X, SEED, loose('/data/a'), []))).toMatchObject({
      code: 'INVALID_DISCLOSURE',
      message: 'present must be an array of JSON pointers',
    });
    expect(specError(() => discloseFacts(X, SEED, [], loose(null)))).toMatchObject({
      code: 'INVALID_DISCLOSURE',
      message: 'absent must be an array of JSON pointers',
    });
    expect(specError(() => discloseFacts(X, SEED, ['data'], []))).toMatchObject({
      code: 'INVALID_PATH',
      message: 'invalid JSON pointer "data": must be empty or start with "/"',
    });
    expect(specError(() => discloseFacts(X, SEED, [loose(1)], []))).toMatchObject({
      code: 'INVALID_PATH',
      message: 'a JSON pointer must be a string, got number',
    });
    expect(specError(() => discloseFacts(X, SEED, ['/data/a', '/data/a'], []))).toMatchObject({
      code: 'INVALID_DISCLOSURE',
      message: 'pointer requested twice: /data/a',
    });
    expect(specError(() => discloseFacts(X, SEED, ['/data/a'], ['/data/a']))).toMatchObject({
      code: 'INVALID_DISCLOSURE',
      message: 'pointer requested twice: /data/a',
    });
    expect(specError(() => discloseFacts(X, SEED, [], []))).toMatchObject({
      code: 'INVALID_DISCLOSURE',
      message: 'nothing to disclose',
    });
    expect(specError(() => discloseFacts(loose({}), SEED, ['/data/a'], []))).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'invalid input: /data is required',
    });
  });

  it('never carries the seed, nor the salt of a leaf it does not disclose', () => {
    const d = disclose(['/data/a'], ['/data/d/x']);
    const text = JSON.stringify(d);
    expect(text).not.toContain(hex(SEED));
    const shown = new Set(['/data/a', '/data/d/e', '/meta/assertions']);
    for (const leaf of inputLeaves(X, SEED)) {
      expect(text.includes(leaf.salt)).toBe(shown.has(leaf.pointer));
    }
  });

  it('does the hash work of the digest, no more: paths come out of the same pass', () => {
    const data: Record<string, JsonValue> = {};
    for (let i = 0; i < 1000; i++) data[`k${i}`] = i;
    const input = proofInput({}, data);
    const digestWork = hashWorkOf(() => computeInputDigest(input, SEED));
    const present = ['/data/k1', '/data/k500', '/meta/tenantId'];
    const work = hashWorkOf(() => discloseFacts(input, SEED, present, ['/data/k1/x']));
    expect(work).toEqual(digestWork);
  });
});

describe('the order of pointers (D-15): decoded segments, prefixes first', () => {
  const input = proofInput(
    {},
    {
      a: { b: 1, '': 0 },
      'a b': 2,
      'a/b': 3,
      ab: 4,
      'a~b': 5,
      l: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      '\u{1F600}': 6,
      '｡': 7,
    },
  );
  const seed = OTHER_SEED;
  const digest = computeInputDigest(input, seed);
  const suffixes = ['', '/', '/x', '/~0', '/~1', '/ ', '/0', '/01', '/1', '/11', '/-', '~0', 'a'];
  const bases = new Set<string>(['', '/data', '/meta', '/0', '/zz', '/data/']);
  for (const leaf of leavesOf(input)) {
    const segments = leaf.pointer.split('/');
    for (let i = 1; i <= segments.length; i++) bases.add(segments.slice(0, i).join('/'));
  }
  const candidates = [...bases].flatMap((base) =>
    suffixes.map((suffix) => `${base}${suffix}`).filter((p) => p === '' || p.startsWith('/')),
  );

  it(`each of ${candidates.length} pointers is proven present or absent, never both`, () => {
    let absences = 0;
    for (const pointer of candidates) {
      const present = isPresent(input, pointer);
      if (present) {
        expect(specError(() => discloseFacts(input, seed, [], [pointer])).message).toBe(
          `pointer is present: ${pointer}`,
        );
        continue;
      }
      absences += 1;
      const d = discloseFacts(input, seed, [], [pointer]);
      const result = verify(d, digest);
      expect(result, pointer).toMatchObject({ valid: true, absent: [pointer] });
    }
    expect(absences).toBeGreaterThan(100);
  });

  it('every leaf is disclosed with its value, never another one', () => {
    const pointers = leavesOf(input).map((leaf) => leaf.pointer);
    const result = verify(discloseFacts(input, seed, pointers, []), digest);
    expect(result.valid).toBe(true);
    expect(claimsHold(input, result)).toBe(true);
    expect(Object.keys(result.facts).length + Object.keys(result.lists).length).toBe(
      pointers.length,
    );
  });

  it('escaped segments order by their decoded text: /a/b, /a b, /a~1b, /ab, /a~0b', () => {
    const order = leavesOf(input)
      .map((leaf) => leaf.pointer)
      .filter((p) => /^\/data\/a/.test(p));
    expect(order).toEqual([
      '/data/a/',
      '/data/a/b',
      '/data/a b',
      '/data/a~1b',
      '/data/ab',
      '/data/a~0b',
    ]);
    const d = discloseFacts(input, seed, [], ['/data/a~1a', '/data/a~0a']);
    expect(d.absent.map((entry) => [entry.before?.pointer, entry.after?.pointer])).toEqual([
      ['/data/a b', '/data/a~1b'],
      ['/data/ab', '/data/a~0b'],
    ]);
  });
});

describe('nothing passes: every change gives an invalid disclosure or a true one', () => {
  const d = disclose(
    ['/data/a', '/data/b', '/data/c', '/meta/tenantId'],
    ['/data/0', '/data/a/b', '/data/d/x', '/meta/z'],
  );

  /** Every copy of `d` with one scalar changed, and the path of the change. */
  function mutations(): [string, FactDisclosure][] {
    const out: [string, FactDisclosure][] = [];
    const walk = (value: unknown, path: (string | number)[]): void => {
      if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          walk(child, [...path, Array.isArray(value) ? Number(key) : key]);
        }
        return;
      }
      for (const replacement of replacementsOf(value)) {
        const copy = jsonCopy(d);
        let node: unknown = copy;
        for (const step of path.slice(0, -1)) node = (node as Record<string, unknown>)[step];
        (node as Record<string, unknown>)[String(path[path.length - 1])] = replacement;
        out.push([`${path.join('/')} = ${JSON.stringify(replacement)}`, copy]);
      }
    };
    walk(d, []);
    return out;
  }

  /** Other values of the type of `value`: what a forger tries. */
  function replacementsOf(value: unknown): unknown[] {
    if (typeof value === 'number') return [value + 1, value - 1, 0];
    if (typeof value === 'boolean') return [!value];
    if (value === null) return [0, false, ''];
    if (typeof value !== 'string') return [];
    const flipped = `${value.slice(0, -1)}${value.endsWith('0') ? '1' : '0'}`;
    return [flipped, `${value}x`, `${value}/x`, value.slice(0, -1), ''];
  }

  it('changes of one scalar', () => {
    const list = mutations();
    expect(list.length).toBe(380);
    for (const [label, copy] of list) {
      const result = verify(copy);
      if (result.valid) expect(claimsHold(X, result), label).toBe(true);
      else expect(result.issues.length, label).toBeGreaterThan(0);
    }
  });

  it('a neighbour swapped, dropped or moved', () => {
    const [, , entry] = d.absent;
    const [fact] = d.facts;
    if (entry?.before === undefined || entry.after === undefined || fact === undefined) {
      throw new Error('unexpected disclosure');
    }
    const attempts: [string, FactDisclosure['absent'][number]][] = [
      ['swapped', { pointer: '/data/d/x', before: entry.after, after: entry.before }],
      ['before dropped', { pointer: '/data/d/x', after: entry.after }],
      ['after dropped', { pointer: '/data/d/x', before: entry.before }],
      ['not adjacent', { pointer: '/data/d/x', before: fact, after: entry.after }],
      ['nothing', { pointer: '/data/d/x' }],
      ['inside', { pointer: '/data/d', before: fact, after: entry.before }],
    ];
    const reasons = attempts.map(([, attempt]) => {
      const copy = changed(d, (c) => {
        c.absent = [attempt];
      });
      return verify(copy).issues;
    });
    expect(reasons).toEqual([
      [
        'absence not proven: /data/d/x (the before leaf does not come before it)',
        'absence not proven: /data/d/x (the after leaf does not come after it)',
        'absence not proven: /data/d/x (the before and after leaves are not adjacent)',
      ],
      ['absence not proven: /data/d/x (the after leaf is not the first leaf)'],
      ['absence not proven: /data/d/x (the before leaf is not the last leaf)'],
      ['absence not proven: /data/d/x (the before and after leaves are not adjacent)'],
      ['absence not proven: /data/d/x (no neighbour leaf, and the tree is not empty)'],
      [
        'absence not proven: /data/d (the after leaf is inside it)',
        'absence not proven: /data/d (the before and after leaves are not adjacent)',
        'absent pointer is present: /data/d (leaf /data/d/e)',
      ],
    ]);
  });

  it('facts and absences are listed in one order, without repetition', () => {
    const facts = changed(d, (copy) => copy.facts.reverse());
    expect(verify(facts).issues).toEqual([
      '/facts/1 does not follow /facts/0: facts are listed by increasing index',
      '/facts/2 does not follow /facts/1: facts are listed by increasing index',
      '/facts/3 does not follow /facts/2: facts are listed by increasing index',
    ]);
    const twice = changed(d, (copy) => {
      const [fact] = copy.facts;
      if (fact) copy.facts = [fact, fact];
    });
    expect(verify(twice).issues).toEqual([
      '/facts/1 does not follow /facts/0: facts are listed by increasing index',
    ]);
    const absent = changed(d, (copy) => {
      const [a, b] = copy.absent;
      if (a && b) copy.absent = [b, a, a];
    });
    expect(verify(absent).issues).toEqual([
      '/absent/1 does not follow /absent/0: absences are listed by increasing pointer',
      '/absent/2 does not follow /absent/1: absences are listed by increasing pointer',
    ]);
  });

  it('a disclosure that discloses nothing proves nothing', () => {
    const empty = changed(d, (copy) => {
      copy.facts = [];
      copy.absent = [];
    });
    expect(verify(empty)).toEqual(refused(['nothing disclosed']));
  });
});

describe('trees of one leaf, and the empty tree', () => {
  const one = handTree([{ pointer: '/meta/tenantId', kind: 'value', value: 't' }], SEED);

  it('n = 1: the only leaf is first and last; its path is empty', () => {
    const leaf = one.leaf(0);
    expect(leaf.path).toEqual([]);
    const d = {
      format: 'run-iq.disclosure/1',
      inputDigest: one.digest,
      size: 1,
      facts: [leaf],
      absent: [
        { pointer: '/data/a', after: leaf },
        { pointer: '/meta/tenantId/x', before: leaf },
        { pointer: '/meta/z', before: leaf },
      ],
    };
    expect(verify(d, one.digest)).toEqual({
      valid: true,
      issues: [],
      facts: { '/meta/tenantId': 't' },
      lists: {},
      absent: ['/data/a', '/meta/tenantId/x', '/meta/z'],
    });
    expect(verify({ ...d, size: 2 }, one.digest).issues).toContain(
      '/facts/0/path must hold 1 hash (the audit path of leaf 0 of 2)',
    );
  });

  it('n = 0: with no neighbour, an absence holds only in the empty tree', () => {
    const empty = first.empty.inputDigest;
    const d = {
      format: 'run-iq.disclosure/1',
      inputDigest: empty,
      size: 0,
      facts: [],
      absent: [{ pointer: '' }, { pointer: '/data/a' }],
    };
    expect(verify(d, empty)).toEqual({
      valid: true,
      issues: [],
      facts: {},
      lists: {},
      absent: ['', '/data/a'],
    });
    expect(verify({ ...d, inputDigest: one.digest }, one.digest).issues).toEqual([
      'absence not proven:  (no neighbour leaf, and the tree is not empty)',
      'absence not proven: /data/a (no neighbour leaf, and the tree is not empty)',
    ]);
    expect(verify({ ...d, size: 1 }, empty).issues).toEqual([
      'absence not proven:  (no neighbour leaf, and the tree is not empty)',
      'absence not proven: /data/a (no neighbour leaf, and the tree is not empty)',
    ]);
  });
});

describe('a tree no honest signer builds: what the disclosed leaves contradict is refused', () => {
  /** A disclosure of the hand-built `tree`: `facts` and `absent` as given. */
  function handDisclosure(
    tree: ReturnType<typeof handTree>,
    facts: HandLeaf[],
    absent: { pointer: string; before?: HandLeaf; after?: HandLeaf }[] = [],
  ): object {
    return {
      format: 'run-iq.disclosure/1',
      inputDigest: tree.digest,
      size: tree.size,
      facts,
      absent,
    };
  }

  const value = (pointer: string, v: JsonValue): TreeLeaf => ({ pointer, kind: 'value', value: v });
  const list = (pointer: string, length: number): TreeLeaf => ({ pointer, kind: 'array', length });

  it('leaves out of order', () => {
    const tree = handTree([value('/data/b', 1), value('/data/a', 2)], SEED);
    expect(verify(handDisclosure(tree, [tree.leaf(0), tree.leaf(1)]), tree.digest)).toEqual(
      refused(['leaves out of order: /data/b (leaf 0) does not come before /data/a (leaf 1)']),
    );
  });

  it('a leaf inside a scalar, or inside an empty object', () => {
    const tree = handTree(
      [
        value('/data/a', 1),
        value('/data/a/b', 2),
        { pointer: '/data/c', kind: 'object' },
        value('/data/c/d', 3),
      ],
      SEED,
    );
    const facts = [0, 1, 2, 3].map(tree.leaf);
    expect(verify(handDisclosure(tree, facts), tree.digest)).toEqual(
      refused([
        'leaf inside a scalar: /data/a/b (inside /data/a)',
        'leaf inside an empty object: /data/c/d (inside /data/c)',
      ]),
    );
  });

  it('a leaf outside its list', () => {
    const tree = handTree(
      [list('/data/l', 2), value('/data/l/01', 1), value('/data/l/1/x', 2), value('/data/l/y', 3)],
      SEED,
    );
    const facts = [0, 1, 2, 3].map(tree.leaf);
    expect(verify(handDisclosure(tree, facts), tree.digest)).toEqual(
      refused([
        'leaf outside its list: /data/l/01 (/data/l has length 2)',
        'leaf outside its list: /data/l/y (/data/l has length 2)',
      ]),
    );
    const short = handTree([list('/data/l', 1), value('/data/l/5', 1)], SEED);
    expect(verify(handDisclosure(short, [0, 1].map(short.leaf)), short.digest).issues).toEqual([
      'leaf outside its list: /data/l/5 (/data/l has length 1)',
    ]);
  });

  it('an absence a disclosed list or leaf contradicts', () => {
    const tree = handTree([list('/data/l', 2), value('/data/m', 1)], SEED);
    const d = handDisclosure(
      tree,
      [],
      [{ pointer: '/data/l/1', before: tree.leaf(0), after: tree.leaf(1) }],
    );
    expect(verify(d, tree.digest)).toEqual(
      refused(['absent pointer is present: /data/l/1 (/data/l has length 2)']),
    );
    const disorder = handTree(
      [value('/data/a', 1), value('/data/z', 2), value('/data/x/y', 3)],
      SEED,
    );
    const both = handDisclosure(
      disorder,
      [disorder.leaf(2)],
      [{ pointer: '/data/x', before: disorder.leaf(0), after: disorder.leaf(1) }],
    );
    expect(verify(both, disorder.digest)).toEqual(
      refused([
        'leaves out of order: /data/z (leaf 1) does not come before /data/x/y (leaf 2)',
        'absent pointer is present: /data/x (leaf /data/x/y)',
      ]),
    );
  });
});

describe('the JSON schema accepts and refuses the same disclosures', () => {
  const schema = JSON.parse(
    readFileSync(new URL('../schema/fact-disclosure.schema.json', import.meta.url), 'utf8'),
  ) as object;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const schemaAccepts = ajv.compile(schema);
  const d = jsonCopy(disclose(['/data/a', '/data/b', '/data/c'], ['/data/d/x', '/meta/z']));
  const leaf = d.facts[0];

  const VALID: [string, unknown, string][] = [
    ['a disclosure of facts and absences', d, DIGEST],
    ['facts only', { ...d, absent: [] }, DIGEST],
    ['absences only', { ...d, facts: [] }, DIGEST],
    [
      'the empty tree',
      { ...d, inputDigest: first.empty.inputDigest, size: 0, facts: [], absent: [{ pointer: '' }] },
      first.empty.inputDigest,
    ],
  ];
  const REFUSED: [string, unknown][] = [
    ['not an object', [d]],
    ['null', null],
    ['an unknown key', { ...d, extra: 1 }],
    ['no format', { ...d, format: undefined }],
    ['an unknown format', { ...d, format: 'run-iq.disclosure/2' }],
    ['a format that is not a string', { ...d, format: 1 }],
    ['no inputDigest', { ...d, inputDigest: undefined }],
    ['an upper-case inputDigest', { ...d, inputDigest: DIGEST.toUpperCase() }],
    ['a short inputDigest', { ...d, inputDigest: DIGEST.slice(1) }],
    ['no size', { ...d, size: undefined }],
    ['a negative size', { ...d, size: -1 }],
    ['a size that is not an integer', { ...d, size: 2.5 }],
    ['a size beyond 10000000', { ...d, size: 10_000_001 }],
    ['a size as a string', { ...d, size: '10' }],
    ['no facts', { ...d, facts: undefined }],
    ['facts that are not a list', { ...d, facts: {} }],
    ['no absent', { ...d, absent: undefined }],
    ['a fact that is not an object', { ...d, facts: [1] }],
    ['a fact with an unknown key', { ...d, facts: [{ ...leaf, extra: 1 }] }],
    ['a fact without index', { ...d, facts: [{ ...leaf, index: undefined }] }],
    ['a fact with a negative index', { ...d, facts: [{ ...leaf, index: -1 }] }],
    ['a fact without path', { ...d, facts: [{ ...leaf, path: undefined }] }],
    ['a path entry that is not hex', { ...d, facts: [{ ...leaf, path: ['x'] }] }],
    ['a path of 25 entries', { ...d, facts: [{ ...leaf, path: Array(25).fill(DIGEST) }] }],
    ['a fact without salt', { ...d, facts: [{ ...leaf, salt: undefined }] }],
    ['a salt that is not hex', { ...d, facts: [{ ...leaf, salt: 'zz' }] }],
    ['an unknown kind', { ...d, facts: [{ ...leaf, kind: 'set' }] }],
    ['a value that is an object', { ...d, facts: [{ ...leaf, value: { a: 1 } }] }],
    ['a value leaf without value', { ...d, facts: [{ ...leaf, value: undefined }] }],
    ['a value leaf with a length', { ...d, facts: [{ ...leaf, length: 1 }] }],
    ['a list leaf without length', { ...d, facts: [{ ...leaf, kind: 'array', value: undefined }] }],
    ['an object leaf with a value', { ...d, facts: [{ ...leaf, kind: 'object' }] }],
    ['a pointer that is not a pointer', { ...d, facts: [{ ...leaf, pointer: 'data/a' }] }],
    ['an absence without pointer', { ...d, absent: [{}] }],
    ['an absence with an unknown key', { ...d, absent: [{ pointer: '/x', next: leaf }] }],
    ['an absence pointer that is not one', { ...d, absent: [{ pointer: 'x' }] }],
    ['an absence pointer with a bad escape', { ...d, absent: [{ pointer: '/~2' }] }],
    ['an absence whose before is not a leaf', { ...d, absent: [{ pointer: '/x', before: 1 }] }],
  ];
  const VERIFIER_ONLY: [string, unknown][] = [
    ['a value changed', { ...d, facts: [{ ...leaf, value: 2 }] }],
    ['a path of the wrong length', { ...d, facts: [{ ...leaf, path: [DIGEST] }] }],
    ['an index beyond the size', { ...d, facts: [{ ...leaf, index: 99 }] }],
    ['more facts than leaves', { ...d, size: 1, facts: [leaf, leaf] }],
    ['a pointer no input has', { ...d, facts: [{ ...leaf, pointer: '/meta/x' }] }],
    ['a lone surrogate in a pointer', { ...d, absent: [{ pointer: '/\uD800' }] }],
    ['absences out of order', { ...d, absent: [...d.absent].reverse() }],
    ['another input digest', { ...d, inputDigest: first.empty.inputDigest }],
    ['nothing disclosed', { ...d, facts: [], absent: [] }],
  ];

  it('has at least 4 valid, 35 refused and 9 verifier-only cases', () => {
    expect(VALID.length).toBeGreaterThanOrEqual(4);
    expect(REFUSED.length).toBeGreaterThanOrEqual(35);
    expect(VERIFIER_ONLY.length).toBeGreaterThanOrEqual(9);
  });

  it.each(VALID)('accepts %s', (_name, value, digest) => {
    expect(verify(value, digest)).toMatchObject({ valid: true, issues: [] });
    expect(schemaAccepts(jsonCopy(value))).toBe(true);
  });

  it.each(REFUSED)('refuses %s', (_name, value) => {
    expect(verifyFactDisclosure(value, DIGEST).valid).toBe(false);
    expect(schemaAccepts(jsonCopy(value))).toBe(false);
  });

  it.each(VERIFIER_ONLY)('verifier-only: refuses %s (the schema cannot)', (_name, value) => {
    expect(verifyFactDisclosure(value, DIGEST).valid).toBe(false);
    expect(schemaAccepts(jsonCopy(value))).toBe(true);
  });

  it('the schema documents the verifier-only checks', () => {
    const text = JSON.stringify(schema);
    for (const check of [
      'audit path',
      'index below size',
      'not more facts than leaves',
      'a place where a valid input has a leaf',
      'lone UTF-16 surrogate',
      'increasing index',
      'increasing pointer',
      'tree sorted honestly',
    ]) {
      expect(text).toContain(check);
    }
  });
});
