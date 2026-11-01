import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  computeInputDigest,
  deriveInputSeed,
  DISCLOSURE_FORMAT,
  discloseFacts,
  inputLeaves,
  UNSALTED_SEED,
  verifyFactDisclosure,
} from '../src/index.js';
import type {
  DisclosedFact,
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
  nodeCommitment,
  nodeCommittedLeafHash,
  nodeLeafHash,
  proofInput,
  specError,
} from './helpers.js';
import type { HandLeaf, HandNeighbour, TreeLeaf } from './helpers.js';
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

/** The fact at `index` of `d`, or a thrown error. */
function factOf(d: FactDisclosure, index: number): DisclosedFact {
  const fact = d.facts[index];
  if (fact === undefined) throw new Error(`no fact ${index}`);
  return fact;
}

/** The leaves of `input` in their order, unsalted: what an honest tree holds. */
function leavesOf(input: ProofInput): InputLeaf[] {
  return inputLeaves(input, UNSALTED_SEED);
}

/** The decoded segments of a JSON pointer, decoded here (RFC 6901), independent of the package. */
function segmentsOf(pointer: string): string[] {
  if (pointer === '') return [];
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/** The value of `input` at `pointer` (`undefined` when it has none), resolved here. */
function valueAt(input: ProofInput, pointer: string): unknown {
  let value: unknown = input;
  for (const segment of segmentsOf(pointer)) {
    if (Array.isArray(value)) {
      value = /^(0|[1-9][0-9]*)$/.test(segment) ? (value as unknown[])[Number(segment)] : undefined;
    } else if (value !== null && typeof value === 'object' && Object.hasOwn(value, segment)) {
      value = (value as Record<string, unknown>)[segment];
    } else return undefined;
  }
  return value;
}

/** True when `pointer` names a value of `input`. */
function isPresent(input: ProofInput, pointer: string): boolean {
  return valueAt(input, pointer) !== undefined;
}

/**
 * True when what `result` claims holds for `input`: each fact is the value at its pointer (in
 * JCS), each list length that of its list, each absent pointer absent.
 */
function claimsHold(input: ProofInput, result: FactDisclosureVerification): boolean {
  const factsHold = Object.entries(result.facts).every(([pointer, value]) => {
    const actual = valueAt(input, pointer);
    return actual !== undefined && canonicalize(actual) === canonicalize(value);
  });
  const listsHold = Object.entries(result.lists).every(([pointer, length]) => {
    const list = valueAt(input, pointer);
    return Array.isArray(list) && list.length === length;
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
    expect(Object.keys(result.facts)).toEqual(c.disclosure.facts.map((fact) => fact.pointer));
    expect(result.absent).toEqual(c.disclosure.absent.map((entry) => entry.pointer));
    expect(claimsHold(vector.input, result)).toBe(true);
  });

  it('case 0 gives every fact it discloses, rebuilt', () => {
    const [c] = vectors.cases;
    if (c === undefined) throw new Error('no case 0');
    expect(verify(c.disclosure, first.salted.inputDigest)).toEqual({
      valid: true,
      issues: [],
      facts: { '/data/a': 1, '/data/b': [], '/data/d': { e: null } },
      lists: { '/data/b': 0 },
      absent: ['/data/0', '/data/a/b', '/data/d/x', '/meta/z'],
    });
  });

  it('case 1 gives every fact and list it discloses: nested lists, objects, escapes', () => {
    const [, c] = vectors.cases;
    if (c === undefined) throw new Error('no case 1');
    expect(verify(c.disclosure, second.salted.inputDigest)).toEqual({
      valid: true,
      issues: [],
      facts: {
        '/data/a~0b': 1.5,
        '/data/c~1d': 'é\u{1F600}',
        '/data/l/10': 10,
        '/data/n': [[1, [2.25, 'x']], [], {}],
        '/data/é': { e: -7, '\u{1F600}': true },
        '/meta/context/k/0': 0.5,
        '/meta/dimensions/z~1o': ['A', 'B'],
      },
      lists: {
        '/data/n': 3,
        '/data/n/0': 2,
        '/data/n/0/1': 2,
        '/data/n/1': 0,
        '/meta/dimensions/z~1o': 2,
      },
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

  it('a value changed to 2, its value salt kept, is not in the tree', () => {
    const d = changed(disclose(['/data/a'], ['/data/z']), (copy) => {
      const [leaf] = factOf(copy, 0).leaves;
      if (leaf) leaf.value = 2;
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

  it('below a scalar, a list or an empty object, an absence needs both neighbours', () => {
    const d = disclose([], ['/data/a/b', '/data/b/0', '/data/c/x', '/meta/tenantId/x/y']);
    expect(d.absent.map((entry) => [entry.before?.pointer, entry.after?.pointer])).toEqual([
      ['/data/a', '/data/b'],
      ['/data/b', '/data/c'],
      ['/data/c', '/data/d/e'],
      ['/meta/tenantId', undefined],
    ]);
    expect(verify(d)).toMatchObject({ valid: true });
    // A neighbour alone is no proof unless it is the last leaf: its kind is hidden.
    const alone = changed(d, (copy) => {
      for (const entry of copy.absent) delete entry.after;
    });
    expect(verify(alone).issues).toEqual([
      'absence not proven: /data/a/b (the before leaf is not the last leaf)',
      'absence not proven: /data/b/0 (the before leaf is not the last leaf)',
      'absence not proven: /data/c/x (the before leaf is not the last leaf)',
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

  it('refuses to disclose an absent pointer, or one inside another disclosed one', () => {
    expect(specError(() => disclose(['/data/z']))).toMatchObject({
      code: 'INVALID_DISCLOSURE',
      message: 'pointer is absent: /data/z',
    });
    expect(specError(() => disclose(['/data/d', '/data/d/e']))).toMatchObject({
      code: 'INVALID_DISCLOSURE',
      message: 'pointer inside another requested pointer: /data/d/e (inside /data/d)',
    });
    expect(specError(() => disclose(['', '/meta/tags']))).toMatchObject({
      code: 'INVALID_DISCLOSURE',
      message: 'pointer inside another requested pointer: /meta/tags (inside )',
    });
    // An absence inside a disclosed value is proven by its leaves.
    expect(verify(disclose(['/data/d'], ['/data/d/x']))).toEqual({
      valid: true,
      issues: [],
      facts: { '/data/d': { e: null } },
      lists: {},
      absent: ['/data/d/x'],
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

  it('does the hash work of the digest, no more: paths come out of the same pass', () => {
    const data: Record<string, JsonValue> = {};
    for (let i = 0; i < 1000; i++) data[`k${i}`] = i;
    data.l = [[1, 2], { a: [3] }];
    const input = proofInput({}, data);
    const digestWork = hashWorkOf(() => computeInputDigest(input, SEED));
    const present = ['/data/k1', '/data/k500', '/data/l', '/meta/tenantId'];
    const work = hashWorkOf(() => discloseFacts(input, SEED, present, ['/data/k1/x']));
    expect(work).toEqual(digestWork);
  });
});

describe('a neighbour shows its pointer, salt and commitment, never its content (D-15)', () => {
  const SECRET_VALUE = 'a value no proof of absence may show';
  const input = proofInput({}, { m: SECRET_VALUE, n: 7, o: [true] });
  const seed = OTHER_SEED;
  const digest = computeInputDigest(input, seed);
  const leaves = inputLeaves(input, seed);
  const d = discloseFacts(input, seed, [], ['/data/m~1x', '/data/mz']);
  const leafAt = (pointer: string): InputLeaf => {
    const leaf = leaves.find((candidate) => candidate.pointer === pointer);
    if (leaf === undefined) throw new Error(`no leaf ${pointer}`);
    return leaf;
  };

  it('frames /data/m~1x by /data/m and /data/mz by /data/m and /data/n', () => {
    expect(d.absent.map((entry) => [entry.before?.pointer, entry.after?.pointer])).toEqual([
      ['/data/m', '/data/n'],
      ['/data/m', '/data/n'],
    ]);
    expect(verify(d, digest)).toMatchObject({ valid: true, absent: ['/data/m~1x', '/data/mz'] });
  });

  it('the bytes of the proof hold neither value, nor kind, nor value salt of a neighbour', () => {
    const text = JSON.stringify(d);
    expect(text).not.toContain(SECRET_VALUE);
    expect(text).not.toContain('"kind"');
    expect(text).not.toContain('"value"');
    expect(text).not.toContain('"length"');
    for (const pointer of ['/data/m', '/data/n']) {
      expect(text).not.toContain(leafAt(pointer).valueSalt);
      expect(text).toContain(leafAt(pointer).salt);
    }
    expect(Object.keys(d.absent[0]?.before ?? {})).toEqual([
      'pointer',
      'salt',
      'commitment',
      'index',
      'path',
    ]);
  });

  it('its commitment is C of D-15, and its leaf hash follows from pointer, salt and C', () => {
    const before = d.absent[0]?.before;
    if (before === undefined) throw new Error('no neighbour');
    const leaf = leafAt('/data/m');
    expect(before.commitment).toBe(hex(nodeCommitment(leaf)));
    expect(
      hex(nodeCommittedLeafHash(before.pointer, before.salt, fromHex(before.commitment))),
    ).toBe(hex(nodeLeafHash(leaf)));
  });

  it('a neighbour given a value is refused; its value changed without C cannot verify', () => {
    const withValue = changed(d, (copy) => {
      const [entry] = copy.absent;
      if (entry?.before) Object.assign(entry.before, { value: 'guess' });
    });
    expect(verify(withValue, digest).issues).toEqual([
      '/absent/0/before has an unknown key "value"',
    ]);
    const before = d.absent[0]?.before;
    if (before === undefined) throw new Error('no neighbour');
    // Shown as a fact, the neighbour needs a value and its value salt: guessed, it is not
    // the leaf in the tree, whatever the value (the true one included).
    for (const value of ['guess', SECRET_VALUE]) {
      const shown = {
        pointer: before.pointer,
        kind: 'value',
        value,
        salt: before.salt,
        valueSalt: '00'.repeat(32),
        index: before.index,
        path: before.path,
      };
      const forged = { ...d, facts: [{ pointer: before.pointer, leaves: [shown] }], absent: [] };
      expect(verify(forged, digest)).toEqual(refused(['leaf not in tree: /data/m']));
    }
    // C changed by one bit: not in the tree.
    const flipped = changed(d, (copy) => {
      const [entry] = copy.absent;
      if (entry?.before) entry.before.commitment = `${before.commitment.slice(0, -1)}0`;
    });
    expect(before.commitment.endsWith('0')).toBe(false);
    expect(verify(flipped, digest).issues).toEqual(['leaf not in tree: /data/m']);
  });

  it('never carries the seed, nor a salt of a leaf it does not show', () => {
    const shown = discloseFacts(input, seed, ['/data/o'], ['/data/m~1x']);
    const text = JSON.stringify(shown);
    expect(text).not.toContain(hex(seed));
    const facts = new Set(['/data/o', '/data/o/0']);
    const neighbours = new Set(['/data/m', '/data/n', '/meta/assertions']);
    for (const leaf of leaves) {
      const seen = facts.has(leaf.pointer) || neighbours.has(leaf.pointer);
      expect([leaf.pointer, text.includes(leaf.salt)]).toEqual([leaf.pointer, seen]);
      expect([leaf.pointer, text.includes(leaf.valueSalt)]).toEqual([
        leaf.pointer,
        facts.has(leaf.pointer),
      ]);
    }
    expect(text).not.toContain(SECRET_VALUE);
  });
});

describe('a fact is a whole value: every leaf at or below its pointer', () => {
  it('a non-empty object: its leaves, framed before and after', () => {
    const d = disclose(['/data/d']);
    const fact = factOf(d, 0);
    expect(fact.leaves.map((leaf) => [leaf.pointer, leaf.index])).toEqual([['/data/d/e', 3]]);
    expect([fact.before?.pointer, fact.after?.pointer]).toEqual(['/data/c', '/meta/assertions']);
    expect(verify(d)).toMatchObject({ valid: true, facts: { '/data/d': { e: null } } });
  });

  it('a scalar, an empty object, an empty list: the leaf alone, no neighbour', () => {
    const d = disclose(['/data/a', '/data/b', '/data/c']);
    expect(d.facts.map((fact) => Object.keys(fact))).toEqual([
      ['pointer', 'leaves'],
      ['pointer', 'leaves'],
      ['pointer', 'leaves'],
    ]);
    expect(verify(d)).toEqual({
      valid: true,
      issues: [],
      facts: { '/data/a': 1, '/data/b': [], '/data/c': {} },
      lists: { '/data/b': 0 },
      absent: [],
    });
  });

  it('a list: its leaf, then its elements, framed after only', () => {
    const input = proofInput({}, { k: 0, l: [[1, [2]], [], {}, { a: [[]] }], m: 'z' });
    const d = discloseFacts(input, SEED, ['/data/l'], []);
    const fact = factOf(d, 0);
    expect(fact.leaves.map((leaf) => leaf.pointer)).toEqual([
      '/data/l',
      '/data/l/0',
      '/data/l/0/0',
      '/data/l/0/1',
      '/data/l/0/1/0',
      '/data/l/1',
      '/data/l/2',
      '/data/l/3/a',
      '/data/l/3/a/0',
    ]);
    expect([fact.before, fact.after?.pointer]).toEqual([undefined, '/data/m']);
    expect(verify(d, computeInputDigest(input, SEED))).toEqual({
      valid: true,
      issues: [],
      facts: { '/data/l': [[1, [2]], [], {}, { a: [[]] }] },
      lists: {
        '/data/l': 4,
        '/data/l/0': 2,
        '/data/l/0/1': 1,
        '/data/l/1': 0,
        '/data/l/3/a': 1,
        '/data/l/3/a/0': 0,
      },
      absent: [],
    });
  });

  it('the whole input, and the whole of data: at the edges of the tree, no neighbour', () => {
    const whole = disclose(['']);
    expect([whole.facts[0]?.before, whole.facts[0]?.after]).toEqual([undefined, undefined]);
    expect(verify(whole).facts).toEqual({ '': X });
    const data = disclose(['/data']);
    expect([data.facts[0]?.before, data.facts[0]?.after?.pointer]).toEqual([
      undefined,
      '/meta/assertions',
    ]);
    expect(verify(data).facts).toEqual({ '/data': X.data });
  });

  it('keys of the prototype stay data', () => {
    // JSON.parse defines `__proto__` as an own key, as a caller's JSON input holds it.
    const data = loose<Record<string, JsonValue>>(
      JSON.parse('{"o":{"__proto__":{"x":1},"constructor":2}}'),
    );
    const input = proofInput({}, data);
    const d = discloseFacts(input, SEED, ['/data/o'], []);
    const result = verify(d, computeInputDigest(input, SEED));
    expect(result.valid).toBe(true);
    const o = result.facts['/data/o'];
    if (o === null || typeof o !== 'object') throw new Error('not an object');
    expect(Object.getPrototypeOf(o)).toBe(Object.prototype);
    expect(Object.keys(o)).toEqual(['__proto__', 'constructor']);
    expect(Object.getOwnPropertyDescriptor(o, '__proto__')?.value).toEqual({ x: 1 });
  });

  describe('a fact with a leaf missing or added is refused', () => {
    const input = proofInput({}, { k: 0, l: [[1, [2]], [], 'x'], m: 'z' });
    const digest = computeInputDigest(input, SEED);
    const d = discloseFacts(input, SEED, ['/data/l'], []);
    const fact = factOf(d, 0);
    const [k, m] = discloseFacts(input, SEED, ['/data/k', '/data/m'], []).facts.flatMap(
      (shown) => shown.leaves,
    );
    if (k === undefined || m === undefined) throw new Error('unexpected disclosure');
    /** `d` with its fact changed by `change`, the members `drop` removed. */
    const withFact = (
      change: Partial<DisclosedFact>,
      drop: readonly (keyof DisclosedFact)[] = [],
    ): FactDisclosure =>
      changed(d, (copy) => {
        const next: Partial<DisclosedFact> = { ...jsonCopy(fact), ...change };
        for (const key of drop) delete next[key];
        copy.facts = [loose<DisclosedFact>(next)];
      });

    it('the honest fact verifies', () => {
      expect(verify(d, digest)).toMatchObject({
        valid: true,
        facts: { '/data/l': [[1, [2]], [], 'x'] },
      });
    });

    it('a leaf missing in the middle: its indices are not consecutive', () => {
      const leaves = fact.leaves.filter((leaf) => leaf.pointer !== '/data/l/0/0');
      expect(verify(withFact({ leaves }), digest).issues).toEqual([
        'fact not shown whole: /data/l (its leaves are not at consecutive indices)',
      ]);
    });

    it('the last leaf missing: the neighbour after is not just after it', () => {
      const leaves = fact.leaves.slice(0, -1);
      expect(verify(withFact({ leaves }), digest).issues).toEqual([
        'fact not shown whole: /data/l (the after leaf is not just after its last leaf)',
      ]);
    });

    it('the last leaf missing and made the neighbour after: it is inside the fact', () => {
      const last = fact.leaves[fact.leaves.length - 1];
      if (last === undefined) throw new Error('no leaf');
      const { pointer, salt, index, path } = last;
      const commitment = hex(nodeCommitment(last));
      const after = { pointer, salt, commitment, index, path };
      const missing = withFact({ leaves: fact.leaves.slice(0, -1), after });
      expect(verify(missing, digest).issues).toEqual([
        'fact not shown whole: /data/l (the after leaf is inside it)',
      ]);
    });

    it('a leaf added after: it is not below the pointer', () => {
      const added = withFact({ leaves: [...fact.leaves, m] }, ['after']);
      expect(verify(added, digest).issues).toEqual([
        'fact not shown whole: /data/l (the leaf /data/m is not at or below it)',
        'fact not shown whole: /data/l (no leaf after it, and its last leaf is not the last ' +
          'of the tree)',
      ]);
    });

    it('a leaf added before: it is not below the pointer', () => {
      const added = withFact({ leaves: [k, ...fact.leaves] });
      expect(verify(added, digest).issues).toEqual([
        'fact not shown whole: /data/l (the leaf /data/k is not at or below it)',
      ]);
    });

    it('the neighbour after dropped, or one before added', () => {
      expect(verify(withFact({}, ['after']), digest).issues).toEqual([
        'fact not shown whole: /data/l (no leaf after it, and its last leaf is not the last ' +
          'of the tree)',
      ]);
      const before = discloseFacts(input, SEED, [], ['/data/k~1x']).absent[0]?.before;
      if (before === undefined) throw new Error('no neighbour');
      expect(verify(withFact({ before }), digest).issues).toEqual([
        'fact not shown whole: /data/l (the before leaf is not needed)',
      ]);
    });
  });

  it('an object without its neighbour before, a scalar with a neighbour after', () => {
    const object = changed(disclose(['/data/d']), (copy) => delete copy.facts[0]?.before);
    expect(verify(object).issues).toEqual([
      'fact not shown whole: /data/d (no leaf before it, and its first leaf is not the first ' +
        'of the tree)',
    ]);
    const after = disclose([], ['/data/a/x']).absent[0]?.after;
    const scalar = changed(disclose(['/data/a']), (copy) => {
      const [shown] = copy.facts;
      if (shown && after) shown.after = after;
    });
    expect(after?.pointer).toBe('/data/b');
    expect(verify(scalar).issues).toEqual([
      'fact not shown whole: /data/a (the after leaf is not needed)',
    ]);
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

  it(`each of ${candidates.length} pointers is shown present or proven absent, never both`, () => {
    let absences = 0;
    let facts = 0;
    for (const pointer of candidates) {
      if (isPresent(input, pointer)) {
        facts += 1;
        expect(specError(() => discloseFacts(input, seed, [], [pointer])).message).toBe(
          `pointer is present: ${pointer}`,
        );
        const result = verify(discloseFacts(input, seed, [pointer], []), digest);
        expect([pointer, result.valid, claimsHold(input, result)]).toEqual([pointer, true, true]);
        expect(Object.keys(result.facts)).toEqual([pointer]);
        continue;
      }
      absences += 1;
      expect(specError(() => discloseFacts(input, seed, [pointer], [])).message).toBe(
        `pointer is absent: ${pointer}`,
      );
      const d = discloseFacts(input, seed, [], [pointer]);
      const result = verify(d, digest);
      expect(result, pointer).toMatchObject({ valid: true, absent: [pointer] });
    }
    expect(absences).toBe(405);
    expect(facts).toBe(35);
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
    const d = discloseFacts(input, seed, ['/data/a'], ['/data/a~1a', '/data/a~0a']);
    expect(d.absent.map((entry) => [entry.before?.pointer, entry.after?.pointer])).toEqual([
      ['/data/a b', '/data/a~1b'],
      ['/data/ab', '/data/a~0b'],
    ]);
    // /data/a holds /data/a/ and /data/a/b: the leaf after them is /data/a b, its key a prefix.
    expect(factOf(d, 0).after?.pointer).toBe('/data/a b');
    expect(verify(d, digest).facts).toEqual({ '/data/a': { '': 0, b: 1 } });
  });
});

describe('nothing passes: every change gives an invalid disclosure or a true one', () => {
  /** The single-scalar changes of the disclosure below, and how many of them are true claims. */
  const MUTATIONS = 523;
  const VALID_MUTATIONS = 16;
  const d = disclose(
    ['/data/a', '/data/b', '/data/d', '/meta/tenantId'],
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
    expect(list.length).toBe(MUTATIONS);
    let valid = 0;
    for (const [label, copy] of list) {
      const result = verify(copy);
      if (result.valid) {
        valid += 1;
        expect(claimsHold(X, result), label).toBe(true);
      } else expect(result.issues.length, label).toBeGreaterThan(0);
    }
    expect(valid).toBe(VALID_MUTATIONS);
  });

  it('a neighbour swapped, dropped or moved', () => {
    const [, , entry] = d.absent;
    const fact = factOf(d, 2);
    if (entry?.before === undefined || entry.after === undefined || fact.before === undefined) {
      throw new Error('unexpected disclosure');
    }
    const attempts: FactDisclosure['absent'] = [
      { pointer: '/data/d/x', before: entry.after, after: entry.before },
      { pointer: '/data/d/x', after: entry.after },
      { pointer: '/data/d/x', before: entry.before },
      { pointer: '/data/d/x', before: fact.before, after: entry.after },
      { pointer: '/data/d/x' },
      { pointer: '/data/d', before: fact.before, after: entry.before },
    ];
    const reasons = attempts.map((attempt) => {
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
        'absent pointer is present: /data/d (leaf /data/d/e)',
      ],
    ]);
  });

  it('facts and absences are listed in one order, without repetition or nesting', () => {
    const facts = changed(d, (copy) => copy.facts.reverse());
    expect(verify(facts).issues).toEqual([
      '/facts/1 does not follow /facts/0: facts are listed by increasing pointer',
      '/facts/2 does not follow /facts/1: facts are listed by increasing pointer',
      '/facts/3 does not follow /facts/2: facts are listed by increasing pointer',
    ]);
    const twice = changed(d, (copy) => {
      const [fact] = copy.facts;
      if (fact) copy.facts = [fact, fact];
    });
    expect(verify(twice).issues).toEqual([
      '/facts/1 does not follow /facts/0: facts are listed by increasing pointer',
    ]);
    const inner = disclose(['/data/d/e']);
    const nested = changed(d, (copy) => {
      copy.facts = [factOf(d, 2), factOf(inner, 0)];
      copy.absent = [];
    });
    expect(verify(nested).issues).toEqual([
      '/facts/1 is inside /facts/0: a fact is shown whole once',
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
    const neighbour = one.neighbour(0);
    expect(leaf.path).toEqual([]);
    const d = {
      format: 'run-iq.disclosure/1',
      inputDigest: one.digest,
      size: 1,
      facts: [{ pointer: '/meta/tenantId', leaves: [leaf] }],
      absent: [
        { pointer: '/data/a', after: neighbour },
        { pointer: '/meta/tenantId/x', before: neighbour },
        { pointer: '/meta/z', before: neighbour },
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
      '/facts/0/leaves/0/path must hold 1 hash (the audit path of leaf 0 of 2)',
    );
    // The whole of meta: one leaf, first and last, no neighbour.
    const meta = { ...d, facts: [{ pointer: '/meta', leaves: [leaf] }], absent: [] };
    expect(verify(meta, one.digest).facts).toEqual({ '/meta': { tenantId: 't' } });
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
    // A fact in the empty tree: more leaves than the tree holds.
    const fact = { ...d, facts: [{ pointer: '/meta/tenantId', leaves: [one.leaf(0)] }] };
    expect(verify(fact, empty).issues).toEqual([
      '/facts holds 1 facts, more than the size of the tree (0)',
    ]);
  });
});

describe('a tree no honest signer builds: what the shown leaves contradict is refused', () => {
  /** A disclosure of the hand-built `tree`: `facts` and `absent` as given. */
  function handDisclosure(
    tree: ReturnType<typeof handTree>,
    facts: { pointer: string; leaves: HandLeaf[]; before?: HandNeighbour; after?: HandNeighbour }[],
    absent: { pointer: string; before?: HandNeighbour; after?: HandNeighbour }[] = [],
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
    const d = handDisclosure(tree, [
      { pointer: '/data/a', leaves: [tree.leaf(1)] },
      { pointer: '/data/b', leaves: [tree.leaf(0)] },
    ]);
    expect(verify(d, tree.digest)).toEqual(
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
    const d = handDisclosure(tree, [{ pointer: '/data', leaves: [0, 1, 2, 3].map(tree.leaf) }]);
    expect(verify(d, tree.digest)).toEqual(
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
    const d = handDisclosure(tree, [{ pointer: '/data/l', leaves: [0, 1, 2, 3].map(tree.leaf) }]);
    expect(verify(d, tree.digest)).toEqual(
      refused([
        'leaf outside its list: /data/l/01 (/data/l has length 2)',
        'leaf outside its list: /data/l/y (/data/l has length 2)',
      ]),
    );
    const short = handTree([list('/data/l', 1), value('/data/l/5', 1)], SEED);
    const leaves = [0, 1].map(short.leaf);
    const outside = handDisclosure(short, [{ pointer: '/data/l', leaves }]);
    expect(verify(outside, short.digest).issues).toEqual([
      'leaf outside its list: /data/l/5 (/data/l has length 1)',
    ]);
  });

  it('a list lacking an element: the fact is not whole', () => {
    const tree = handTree(
      [list('/data/l', 2), value('/data/l/0', 1), list('/data/l/1', 2), value('/data/l/1/1', 2)],
      SEED,
    );
    const d = handDisclosure(tree, [{ pointer: '/data/l', leaves: [0, 1, 2, 3].map(tree.leaf) }]);
    expect(verify(d, tree.digest)).toEqual(
      refused(['fact not shown whole: /data/l (/data/l/1 lacks element 0)']),
    );
    const outer = handTree(
      [list('/data/l', 3), value('/data/l/0', 1), value('/data/l/1', 2)],
      SEED,
    );
    const short = handDisclosure(outer, [
      { pointer: '/data/l', leaves: [0, 1, 2].map(outer.leaf) },
    ]);
    expect(verify(short, outer.digest)).toEqual(
      refused(['fact not shown whole: /data/l (/data/l lacks element 2)']),
    );
    // A list claiming 10 000 000 elements, with none: refused, nothing allocated for them.
    const huge = handTree([list('/data/l', 9_999_990)], SEED);
    const claimed = handDisclosure(huge, [{ pointer: '/data/l', leaves: [huge.leaf(0)] }]);
    expect(verify(claimed, huge.digest)).toEqual(
      refused(['fact not shown whole: /data/l (/data/l lacks element 0)']),
    );
  });

  it('an absence a shown list or leaf contradicts', () => {
    const tree = handTree([list('/data/l', 2), value('/data/m', 1)], SEED);
    const d = handDisclosure(
      tree,
      [{ pointer: '/data/l', leaves: [tree.leaf(0)], after: tree.neighbour(1) }],
      [{ pointer: '/data/l/1', before: tree.neighbour(0), after: tree.neighbour(1) }],
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
      [{ pointer: '/data/x/y', leaves: [disorder.leaf(2)] }],
      [{ pointer: '/data/x', before: disorder.neighbour(0), after: disorder.neighbour(1) }],
    );
    expect(verify(both, disorder.digest)).toEqual(
      refused([
        'leaves out of order: /data/z (leaf 1) does not come before /data/x/y (leaf 2)',
        'absent pointer is present: /data/x (leaf /data/x/y)',
      ]),
    );
  });

  it('a neighbour no valid input has, or not in the tree', () => {
    const tree = handTree([value('/data/a', 1), value('/data/b', 2)], SEED);
    const bad = { ...tree.neighbour(0), pointer: '/meta/x' };
    const d = handDisclosure(tree, [], [{ pointer: '/data/a~1x', before: bad }]);
    expect(verify(d, tree.digest).issues).toEqual([
      '/absent/0/before: invalid input leaf: /pointer names no leaf of a valid input: ' +
        '/meta has no member "x"',
    ]);
    const moved = { ...tree.neighbour(0), pointer: '/data/c' };
    const out = handDisclosure(tree, [], [{ pointer: '/data/a~1x', before: moved }]);
    expect(verify(out, tree.digest).issues).toEqual(['leaf not in tree: /data/c']);
  });
});

describe('the JSON schema accepts and refuses the same disclosures', () => {
  const schema = JSON.parse(
    readFileSync(new URL('../schema/fact-disclosure.schema.json', import.meta.url), 'utf8'),
  ) as object;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const schemaAccepts = ajv.compile(schema);
  const d = jsonCopy(disclose(['/data/a', '/data/b', '/data/d'], ['/data/d/x', '/meta/z']));
  const fact = factOf(d, 0);
  const leaf = fact.leaves[0];
  const neighbour = factOf(d, 2).before;
  const withLeaf = (change: object): object => ({
    ...d,
    facts: [{ ...fact, leaves: [{ ...leaf, ...change }] }],
  });
  const withNeighbour = (change: object): object => ({
    ...d,
    absent: [{ pointer: '/data/d/x', before: { ...neighbour, ...change } }],
  });

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
    ['a fact with an unknown key', { ...d, facts: [{ ...fact, extra: 1 }] }],
    ['a fact without pointer', { ...d, facts: [{ ...fact, pointer: undefined }] }],
    ['a fact pointer that is not one', { ...d, facts: [{ ...fact, pointer: 'data/a' }] }],
    ['a fact without leaves', { ...d, facts: [{ ...fact, leaves: undefined }] }],
    ['a fact with no leaf', { ...d, facts: [{ ...fact, leaves: [] }] }],
    ['a fact whose neighbour is a shown leaf', { ...d, facts: [{ ...fact, after: leaf }] }],
    ['a leaf with an unknown key', withLeaf({ extra: 1 })],
    ['a leaf without index', withLeaf({ index: undefined })],
    ['a leaf with a negative index', withLeaf({ index: -1 })],
    ['a leaf without path', withLeaf({ path: undefined })],
    ['a path entry that is not hex', withLeaf({ path: ['x'] })],
    ['a path of 25 entries', withLeaf({ path: Array(25).fill(DIGEST) })],
    ['a leaf without salt', withLeaf({ salt: undefined })],
    ['a salt that is not hex', withLeaf({ salt: 'zz' })],
    ['a leaf without value salt', withLeaf({ valueSalt: undefined })],
    ['a value salt that is not hex', withLeaf({ valueSalt: 'zz' })],
    ['an unknown kind', withLeaf({ kind: 'set' })],
    ['a value that is an object', withLeaf({ value: { a: 1 } })],
    ['a value leaf without value', withLeaf({ value: undefined })],
    ['a value leaf with a length', withLeaf({ length: 1 })],
    ['a list leaf without length', withLeaf({ kind: 'array', value: undefined })],
    ['an object leaf with a value', withLeaf({ kind: 'object' })],
    ['a leaf pointer that is not a pointer', withLeaf({ pointer: 'data/a' })],
    ['a neighbour with a value', withNeighbour({ value: 1 })],
    ['a neighbour with a kind', withNeighbour({ kind: 'value' })],
    ['a neighbour with a value salt', withNeighbour({ valueSalt: leaf?.valueSalt })],
    ['a neighbour without commitment', withNeighbour({ commitment: undefined })],
    ['a commitment that is not hex', withNeighbour({ commitment: 'zz' })],
    ['a neighbour pointer below no part', withNeighbour({ pointer: '/x' })],
    ['an absence without pointer', { ...d, absent: [{}] }],
    ['an absence with an unknown key', { ...d, absent: [{ pointer: '/x', next: neighbour }] }],
    ['an absence pointer that is not one', { ...d, absent: [{ pointer: 'x' }] }],
    ['an absence pointer with a bad escape', { ...d, absent: [{ pointer: '/~2' }] }],
    ['an absence whose before is not a leaf', { ...d, absent: [{ pointer: '/x', before: 1 }] }],
    [
      'an absence whose neighbour is a shown leaf',
      { ...d, absent: [{ pointer: '/x', before: leaf }] },
    ],
  ];
  const VERIFIER_ONLY: [string, unknown][] = [
    ['a value changed', withLeaf({ value: 2 })],
    ['a path of the wrong length', withLeaf({ path: [DIGEST] })],
    ['an index beyond the size', withLeaf({ index: 99 })],
    ['more facts than leaves', { ...d, size: 1, facts: [fact, fact] }],
    ['a pointer no input has', withLeaf({ pointer: '/meta/x' })],
    ['a neighbour pointer no input has', withNeighbour({ pointer: '/meta/x' })],
    ['a lone surrogate in a pointer', { ...d, absent: [{ pointer: '/\uD800' }] }],
    ['absences out of order', { ...d, absent: [...d.absent].reverse() }],
    ['facts out of order', { ...d, facts: [...d.facts].reverse() }],
    ['a fact missing its neighbour', { ...d, facts: [{ ...factOf(d, 2), before: undefined }] }],
    ['another input digest', { ...d, inputDigest: first.empty.inputDigest }],
    ['nothing disclosed', { ...d, facts: [], absent: [] }],
  ];

  it('has at least 4 valid, 50 refused and 12 verifier-only cases', () => {
    expect(VALID.length).toBeGreaterThanOrEqual(4);
    expect(REFUSED.length).toBeGreaterThanOrEqual(50);
    expect(VERIFIER_ONLY.length).toBeGreaterThanOrEqual(12);
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
      'not more facts, nor more leaves in a fact, than leaves',
      'a place where a valid input has a leaf',
      'lone UTF-16 surrogate',
      'facts and absences by increasing pointer',
      'no fact inside another',
      'each fact shown whole',
      'its lists holding every element',
      'its pointer is shown, so keys that are themselves private should be opaque',
      'tree sorted honestly',
    ]) {
      expect(text).toContain(check);
    }
  });
});
