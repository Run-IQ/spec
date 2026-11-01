import { describe, expect, it } from 'vitest';
import { canonicalize, PROOF_SECTIONS, sealProof, verifyProof } from '../../src/index.js';
import type { DecisionProof, JsonValue, UnsignedProof } from '../../src/index.js';
import { comparePointers } from '../../src/path/pointer.js';
import { generator, omit, specError } from '../helpers.js';
import { wideProof } from '../proof-builders.js';

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
    const proof = sealProof(wideProof(25_000, 'decimal'));
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
    expect(sealProof(sorted).digest).toBe(proof.digest);
    expect(verifyProof({ ...sorted, digest: proof.digest })).toEqual({
      status: 'consistent',
      issues: ['unsigned'],
    });
    // Unsorted, the same entries are not a proof: one order only, so one digest.
    expect(specError(() => sealProof(reloaded(proof, leaves, false))).message).toMatch(
      /^Cannot seal the proof: rules not sorted at \d+$/,
    );
  }, 600_000);
});

describe('verifyProof on a wide proof', () => {
  it('verifies 80 000 steps in under 3 s', () => {
    // 80 000 steps: 40 000 feeding as many outputs, 40 000 feeding the items of one output.
    const content = wideProof(40_000, 'decimal');
    content.rules = content.rules.filter((rule) => rule.id.startsWith('a') || rule.id === 'k');
    content.skipped = [];
    content.exceptions = [];
    content.factsRead = [];
    const proof = sealProof(content);
    expect(proof.applied.length).toBe(80_000);
    expect(proof.items.length).toBe(40_000);
    const start = performance.now();
    const result = verifyProof(proof);
    const elapsed = performance.now() - start;
    expect(result).toEqual({ status: 'consistent', issues: ['unsigned'] });
    expect(elapsed).toBeLessThan(3_000);
  }, 600_000);
});
