import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  inclusionPath,
  PROOF_SECTIONS,
  proofLeafHash,
  proofLeafHashes,
  sealProof,
  verifyProof,
  verifyProofInclusion,
} from '../../src/index.js';
import type { DecisionProof, JsonValue, ProofLeaf, UnsignedProof } from '../../src/index.js';
import { comparePointers } from '../../src/path/pointer.js';
import { generator, omit, specError } from '../helpers.js';
import { outputProof, wideProof } from '../proof-builders.js';
import { unsalted } from '../proof-cases.js';
import { hashWork } from '../../src/stream.js';
import type { ProofView } from '../../src/proof/types.js';

type Entry = Record<string, JsonValue>;
type Compare = (a: Entry, b: Entry) => number;

const text = (value: JsonValue | undefined): string => (typeof value === 'string' ? value : '');
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const bySubject = (a: JsonValue | undefined, b: JsonValue | undefined): number => {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
  return comparePointers(text(a), text(b));
};
const ruleSetOf = (id: string): string => (id.includes(':') ? id.split(':')[0]! : 'local');
const bareOf = (id: string): string => id.slice(id.indexOf(':') + 1);
const byRule: Compare = (a, b) =>
  byText(ruleSetOf(text(a.ruleId)), ruleSetOf(text(b.ruleId))) ||
  byText(bareOf(text(a.ruleId)), bareOf(text(b.ruleId))) ||
  Number(a.version) - Number(b.version);
const byInstance: Compare = (a, b) => byRule(a, b) || bySubject(a.subject, b.subject);

/** The order of each section, as the format gives it: what a store sorts by on reload. */
const ORDER: Record<string, Compare> = {
  rules: (a, b) =>
    byText(text(a.ruleSet), text(b.ruleSet)) ||
    byText(text(a.id), text(b.id)) ||
    Number(a.version) - Number(b.version),
  outputs: (a, b) => byText(text(a.name), text(b.name)),
  items: (a, b) => byText(text(a.output), text(b.output)) || bySubject(a.subject, b.subject),
  applied: byInstance,
  skipped: byInstance,
  pending: byInstance,
  exceptions: byInstance,
  factsRead: (a, b) => bySubject(a.path, b.path),
  missingFacts: (a, b) => bySubject(a.path, b.path),
  readsUndeclared: byRule,
};

/** Each entry of the sections of `proof`, stored alone: its section and its canonical text. */
function leavesOf(proof: DecisionProof): [string, string][] {
  // A proof is a JSON document: each section a list of JSON objects.
  const record = proof as unknown as Record<string, Entry[]>;
  return PROOF_SECTIONS.flatMap((section) =>
    record[section]!.map((entry): [string, string] => [section, canonicalize(entry)]),
  );
}

/** The proof `proof` with its sections rebuilt from `leaves`, each sorted when `sort`. */
function reloaded(proof: DecisionProof, leaves: [string, string][], sort: boolean): UnsignedProof {
  const sections = new Map<string, Entry[]>(PROOF_SECTIONS.map((section) => [section, []]));
  for (const [section, leaf] of leaves) sections.get(section)!.push(JSON.parse(leaf) as Entry);
  const content: Record<string, unknown> = omit(proof, 'digest');
  for (const [section, entries] of sections) {
    content[section] = sort ? entries.sort(ORDER[section]) : entries;
  }
  return content as unknown as UnsignedProof;
}

describe('a proof stored entry by entry', () => {
  it('reloaded in another order and sorted, 200 000 entries give the same digest', () => {
    const proof = sealProof(unsalted(wideProof(25_000, 'decimal')));
    const leaves = leavesOf(proof);
    expect(leaves.length).toBe(200_004);
    // A store gives its entries back in any order: shuffled here (Fisher-Yates, seeded).
    const pick = generator(42);
    const indices = Array.from({ length: 1_000 }, (_, i) => i);
    for (let i = leaves.length - 1; i > 0; i--) {
      const j = Math.floor((i * pick(indices)) / 1_000);
      [leaves[i], leaves[j]] = [leaves[j]!, leaves[i]!];
    }
    const sorted = reloaded(proof, leaves, true);
    expect(sealProof(unsalted(sorted)).digest).toBe(proof.digest);
    expect(verifyProof({ ...sorted, digest: proof.digest })).toEqual({
      status: 'consistent',
      issues: ['unsigned'],
    });
    // Unsorted, the same entries are not a proof: one order only, so one digest.
    expect(specError(() => sealProof(unsalted(reloaded(proof, leaves, false)))).message).toMatch(
      /^Cannot seal the proof: rules not sorted at \d+$/,
    );
  }, 600_000);
});

const pad = (i: number): string => String(i).padStart(7, '0');

/** One decimal sum of `n` contributions `'1'`, by the rules `r<i>`: `n` steps. */
function summed(n: number): ProofView {
  const ids = Array.from({ length: n }, (_, i) => `r${pad(i)}`);
  const proof = outputProof({ type: 'decimal', combine: 'sum', value: String(n) });
  proof.rules = ids.map((id) => ({
    id,
    version: 1,
    checksum: 'b'.repeat(64),
    ruleSet: 'local',
    priority: 0,
    salt: '',
  }));
  proof.outputs[0]!.contributors = ids;
  proof.applied = ids.map((ruleId) => ({
    ruleId,
    version: 1,
    model: 'M',
    output: 'value',
    contribution: '1',
    status: 'determined',
    stratum: 0,
    salt: '',
  }));
  return proof;
}

/** The sha256 calls and bytes `run` makes (`hashWork`: leaves, nodes, digests, HMACs). */
function counted<T>(run: () => T): { result: T; calls: number; bytes: number } {
  const before = { ...hashWork };
  const result = run();
  return { result, calls: hashWork.calls - before.calls, bytes: hashWork.bytes - before.bytes };
}

// Counted, not timed (hardening): the wall-clock times measured in Task 9K1 are in
// docs/phase-2-changes.md; the absolute budgets are the D-26 bench's.
describe('sealing and verifying at scale: counted work (D-26, pre-flight I30)', () => {
  /** The work of sealing then verifying `summed(n)`. */
  function workOf(n: number) {
    const content = unsalted(summed(n));
    const seal = counted(() => sealProof(content));
    const sealed = seal.result;
    const verify = counted(() => verifyProof(sealed));
    expect(verify.result).toEqual({ status: 'consistent', issues: ['unsigned'] });
    expect(sealed.applied).toHaveLength(n);
    // The header, n rules, one output, n steps.
    const leaves = 2 * n + 2;
    expect(proofLeafHashes(sealed)).toHaveLength(leaves);
    return { n, leaves, seal, verify };
  }

  const sizes = [80_000, 250_000].map(workOf);

  it.each(sizes.map((work) => [work.n, work] as const))(
    '%i steps: one hash per leaf and per internal node, the digest, a salt per entry',
    (_n, { leaves, seal, verify }) => {
      const nodes = leaves - 1;
      const entries = leaves - 1;
      expect(verify.calls).toBe(leaves + nodes + 1);
      expect(seal.calls).toBe(leaves + nodes + 1 + entries);
    },
  );

  it('the bytes hashed grow with the steps: at most 4 bytes more per step (longer indices)', () => {
    const [small, large] = sizes as [(typeof sizes)[0], (typeof sizes)[0]];
    for (const phase of ['seal', 'verify'] as const) {
      const perStepSmall = small[phase].bytes / small.n;
      const perStepLarge = large[phase].bytes / large.n;
      expect(perStepLarge).toBeGreaterThanOrEqual(perStepSmall - 1);
      expect(perStepLarge).toBeLessThanOrEqual(perStepSmall + 4);
    }
  });
}, 300_000);

describe('one leaf among 200 000, checked alone (volume addendum)', () => {
  it('reads the header, the leaf and the hashes of its path: O(log n)', () => {
    const sealed = sealProof(unsalted(summed(100_000)));
    const leaves = proofLeafHashes(sealed);
    expect(leaves.length).toBeGreaterThan(200_000);
    const index = 1 + 100_000 + 1 + 54_321; // header, rules, outputs, then applied[54321]
    const entry = sealed.applied[54_321]!;
    // What a verifier is given: the header, the entry, its path, the size and the digest.
    const header = Object.fromEntries(
      Object.entries(sealed).filter(
        ([key]) => key !== 'digest' && !PROOF_SECTIONS.includes(key as never),
      ),
    );
    const path = inclusionPath(leaves, index);
    const reads = new Map<string, number>();
    const watch = <T extends object>(label: string, target: T): T =>
      new Proxy(target, {
        get(object, key, receiver) {
          const name = `${label}.${String(key)}`;
          reads.set(name, (reads.get(name) ?? 0) + 1);
          return Reflect.get(object, key, receiver) as unknown;
        },
      });
    const headerLeaf = proofLeafHash(watch('header', { s: 'header', e: header } as ProofLeaf));
    const entryLeaf = proofLeafHash(watch('entry', { s: 'applied' as const, i: 54_321, e: entry }));
    expect(headerLeaf).toEqual(leaves[0]);
    const watchedPath = watch('path', path);
    expect(
      verifyProofInclusion(sealed.digest, leaves.length, 0, headerLeaf, inclusionPath(leaves, 0)),
    ).toBe(true);
    expect(verifyProofInclusion(sealed.digest, leaves.length, index, entryLeaf, watchedPath)).toBe(
      true,
    );
    // Each member of the two leaves once; each hash of the path once, and no other leaf.
    expect([...reads].filter(([name, count]) => !name.startsWith('path.') && count !== 1)).toEqual(
      [],
    );
    const pathReads = [...reads]
      .filter(([name]) => /^path\.\d+$/.test(name))
      .reduce((sum, [, count]) => sum + count, 0);
    expect(path.length).toBe(Math.ceil(Math.log2(leaves.length)));
    expect(pathReads).toBe(path.length);
  }, 300_000);
});
