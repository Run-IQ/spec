/**
 * Decision proof builders shared by the proof tests: a proof of one output (`outputProof`), a
 * wide proof (`wideProof`), and the base proof changed in one place, checked as a faulty
 * producer would seal it (`problems`, `withSection`, `withEntry`).
 */
import { expect } from 'vitest';
import { PROOF_FORMAT, sealProof, validateProof, verifyProof } from '../src/index.js';
import type { JsonValue, ProofOutput, ProofStep, UnsignedProof } from '../src/index.js';
import type { ProofView } from '../src/proof/types.js';
import { specError } from './helpers.js';
import { baseContent, entries, salted, unsaltedSalt } from './proof-cases.js';
import { unsalted } from './proof-cases.js';
import { handSealed } from './helpers.js';

const hex = (c: string): string => c.repeat(64);

export type Content = Record<string, unknown>;
export type Entry = Record<string, unknown>;

/**
 * What `verifyProof` finds in `content` sealed by hand (as a faulty producer would), past the
 * signature; `sealProof` refuses it with the first one, or seals it when there is none.
 */
export function problems(content: Content): string[] {
  const proof = handSealed(content);
  expect(validateProof(proof).issues).toEqual([]);
  const found = verifyProof(proof).issues.filter((issue) => issue !== 'unsigned');
  // The cast lets a hand-built value reach sealProof, which checks it.
  const seal = (): unknown => sealProof(unsalted(content as unknown as UnsignedProof));
  const [first] = found;
  if (first === undefined) expect(seal).not.toThrow();
  else expect(specError(seal).message).toBe(`Cannot seal the proof: ${first}`);
  return found;
}

/** The base content with `section` replaced by `list` (each entry salted for its place). */
export function withSection(section: string, list: Entry[], patch: Content = {}): Content {
  const salted = list.map((entry, i) => ({ ...entry, salt: unsaltedSalt(section, i) }));
  return { ...baseContent(), [section]: salted, ...patch };
}

/** The base content with entry `index` of `section` patched (`undefined` removes a member). */
export function withEntry(section: string, index: number, patch: Entry): Content {
  const list = entries(section);
  const entry: Entry = { ...list[index], ...patch };
  for (const [key, value] of Object.entries(patch)) if (value === undefined) delete entry[key];
  list[index] = entry;
  return { ...baseContent(), [section]: list };
}

/** The declaration and value of an output, without the members `outputProof` fills. */
export type OutputPart = Omit<
  ProofOutput,
  'name' | 'status' | 'contributors' | 'pending' | 'salt'
> &
  Partial<Pick<ProofOutput, 'status' | 'contributors' | 'pending'>>;

/**
 * A determined proof of one output `value` (its declaration and value from `output`), fed by one
 * local rule `r<i>@1` of model `M` per contribution, in order (at most ten). The last step's
 * `unrounded` is `unrounded` when given. A `max`, `min` or `highestPriority` output with a value
 * and contributions selects `r0` unless `output` says otherwise. Every other section is empty.
 */
export function outputProof(
  output: OutputPart,
  contributions: readonly JsonValue[] = [],
  unrounded?: JsonValue,
): ProofView {
  const ids = contributions.map((_, i) => `r${i}`);
  const applied = contributions.map((contribution, i): ProofStep => ({
    ruleId: `r${i}`,
    version: 1,
    model: 'M',
    output: 'value',
    contribution,
    status: 'determined',
    stratum: 0,
    salt: unsaltedSalt('applied', i),
  }));
  const last = applied.at(-1);
  if (last !== undefined && unrounded !== undefined) last.unrounded = unrounded;
  const selecting = ['max', 'min', 'highestPriority'].includes(output.combine);
  const selects = selecting && output.value !== undefined && contributions.length > 0;
  return {
    format: PROOF_FORMAT,
    requestId: 'req-1',
    evaluatedAt: null,
    sealedAt: '2026-01-01T00:00:00.000Z',
    inputDigest: hex('a'),
    inputSalted: false,
    timeZone: 'UTC',
    ruleSets: [],
    versions: { engine: '1', plugins: {}, dsls: {}, models: { M: '1' }, components: [] },
    strata: [['value']],
    rules: salted(
      'rules',
      ids.map((id) => ({ id, version: 1, checksum: hex('b'), ruleSet: 'local', priority: 0 })),
    ),
    outputs: [
      {
        name: 'value',
        status: 'determined',
        contributors: ids,
        pending: [],
        salt: unsaltedSalt('outputs', 0),
        ...(selects ? { selected: { ruleId: 'r0' } } : {}),
        ...output,
      },
    ],
    items: [],
    applied,
    skipped: [],
    pending: [],
    exceptions: [],
    factsRead: [],
    missingFacts: [],
    readsUndeclared: [],
  };
}

const pad = (i: number): string => String(i).padStart(7, '0');

/**
 * A consistent proof of `n` outputs `o<i>`, each fed by its rule `a<i>` and skipping its rule
 * `s<i>` (inhibited by `x`), and of one output `per` element `/e` with `n` items, each fed by
 * the rule `k` at its subject; `n` facts read. The lists are sorted, as the format requires.
 */
export function wideProof(n: number, type: 'number' | 'decimal'): ProofView {
  const value = type === 'decimal' ? '1.5' : 1.5;
  const proof = outputProof({ type: 'number', combine: 'sum', value: 0 });
  const salt = unsaltedSalt('rules', 0);
  const indices = Array.from({ length: n }, (_, i) => i);
  const rule = (id: string) => ({
    id,
    version: 1,
    checksum: 'b'.repeat(64),
    ruleSet: 'local',
    priority: 0,
    salt,
  });
  proof.rules = [
    ...indices.map((i) => rule(`a${pad(i)}`)),
    rule('k'),
    ...indices.map((i) => rule(`s${pad(i)}`)),
    rule('x'),
  ];
  const names = [...indices.map((i) => `o${pad(i)}`), 'per'];
  proof.strata = [names];
  proof.outputs = [
    ...indices.map((i) => ({
      name: `o${pad(i)}`,
      type,
      combine: 'sum' as const,
      status: 'determined' as const,
      value,
      contributors: [`a${pad(i)}`],
      pending: [],
      salt,
    })),
    {
      name: 'per',
      type,
      combine: 'sum',
      per: '/e',
      status: 'determined',
      contributors: [],
      pending: [],
      salt,
    },
  ];
  proof.items = indices.map((i) => ({
    output: 'per',
    subject: `/e/@${pad(i)}`,
    status: 'determined',
    value,
    contributors: ['k'],
    pending: [],
    salt,
  }));
  const step = { version: 1, model: 'M', contribution: value, status: 'determined', stratum: 0 };
  // The step's literal `status` widens to `string` in the spread: the list is of steps.
  proof.applied = [
    ...indices.map((i) => ({ ...step, ruleId: `a${pad(i)}`, output: `o${pad(i)}`, salt })),
    ...indices.map((i) => ({
      ...step,
      ruleId: 'k',
      subject: `/e/@${pad(i)}`,
      output: 'per',
      salt,
    })),
  ] as ProofView['applied'];
  proof.skipped = indices.map((i) => ({
    ruleId: `s${pad(i)}`,
    version: 1,
    output: `o${pad(i)}`,
    reason: 'INHIBITED',
    status: 'determined',
    stratum: 0,
    salt,
  }));
  proof.exceptions = [
    {
      ruleId: 'x',
      version: 1,
      kind: 'inhibit',
      affected: indices.map((i) => ({ ruleId: `s${pad(i)}` })),
      status: 'determined',
      stratum: 0,
      salt,
    },
  ];
  proof.factsRead = indices.map((i) => ({ path: `/f/${pad(i)}`, salt }));
  return proof;
}
