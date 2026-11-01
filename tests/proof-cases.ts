/**
 * Decision proof fixtures shared by the proof tests (validateProof, the consistency checks of
 * sealProof and verifyProof) and tests/proof-schema.test.ts (JSON schema), so that they cannot
 * drift apart. Every value is a JSON document.
 *
 * `BASE_PROOF` is one complete, valid and consistent decision that sets every field of the
 * format: four rule sets in precedence order (two packs, one importing the other, the local
 * rules, a referential), two rules `R1@1` of two packs, an output of each kind of member (per
 * element, `all` with `empty`, a `number` sum rounded at each contribution, an `enum` `max`
 * that sets a dimension), its items, applied steps with a subject and with `matches`, a
 * grouped exclusion, an attente, an exception, facts read under an assertion, a missing fact
 * and an undeclared read. Its salts are those D-14 gives with `UNSALTED_SEED`: the first 16
 * bytes of `HMAC-SHA256(32 zero bytes, 'proof:' + section + ':' + index)`, computed here by
 * node:crypto.
 */
import { createHmac } from 'node:crypto';
import {
  computeInputDigest,
  computeRuleChecksum,
  PROOF_FORMAT,
  sealProof,
  signProof,
  UNSALTED_SEED,
} from '../src/index.js';
import type {
  DecisionProof,
  ProofInput,
  RuleDefinitionInput,
  UnsignedProof,
} from '../src/index.js';

const hex = (c: string): string => c.repeat(64);

/** The salt of entry `index` of `section` under `UNSALTED_SEED` (D-14), by node:crypto. */
export function unsaltedSalt(section: string, index: number): string {
  const key = `${section}:${index}`;
  let salt = SALTS.get(key);
  if (salt === undefined) {
    salt = createHmac('sha256', Buffer.alloc(32))
      .update(`proof:${section}:${index}`, 'utf8')
      .digest('hex')
      .slice(0, 32);
    SALTS.set(key, salt);
  }
  return salt;
}

/** The salts computed so far: the fixtures are built thousands of times by the sweeps. */
const SALTS = new Map<string, string>();

/** `entries` with the salt of their place in `section`. */
export function salted<T extends object>(section: string, entries: T[]): (T & { salt: string })[] {
  return entries.map((entry, i) => ({ ...entry, salt: unsaltedSalt(section, i) }));
}

/** A signature value of the right shape: 86 base64url characters, 64 bytes. */
export const SIGNATURE_VALUE = `${'A'.repeat(85)}w`;

const INACTIVE = 'window [2026-01-01, ∞) does not contain /$item/naissance (UTC)';

/** The content of `BASE_PROOF`: every field but `digest` and `signature`. */
export function baseContent(): Record<string, unknown> {
  return {
    format: 'run-iq.proof/1',
    requestId: 'req-1',
    evaluatedAt: '2026-06-01',
    sealedAt: '2026-06-01T10:00:00.000Z',
    inputDigest: hex('a'),
    inputSalted: false,
    timeZone: 'UTC',
    ruleSets: [
      {
        kind: 'pack',
        id: 'vat',
        version: '2026.1',
        digest: hex('e'),
        imports: ['social'],
        timeZone: 'Europe/Paris',
      },
      { kind: 'pack', id: 'social', version: '3', digest: hex('f') },
      { kind: 'local', timeZone: '+05:30' },
      { kind: 'referential', id: 'vat:ue', version: '2026', digest: hex('1') },
    ],
    versions: {
      engine: '1.0.0-next.1',
      plugins: { '@run-iq/plugin-test': '1.0.0' },
      dsls: { jsonlogic: '0.2.0' },
      models: { CHECK: '1', FLAT: '1.0.0', LEVEL: '2', PER_CHILD: '1' },
      components: [
        { name: 'baremes', version: '2026', digest: hex('5'), declaredBy: 'plugin:fiscal' },
        { name: 'tzdata', version: '2026c', declaredBy: 'engine' },
      ],
    },
    strata: [['kids', 'social:aid', 'value'], ['vat:level']],
    requested: ['kids', 'social:aid', 'value', 'vat:level'],
    supersedes: { digest: hex('9'), reason: 'correction' },
    rules: salted('rules', [
      { id: 'k', version: 1, checksum: hex('2'), ruleSet: 'local', priority: 0 },
      {
        id: 'r1',
        version: 1,
        checksum: hex('b'),
        ruleSet: 'local',
        priority: 0,
        sourceRef: 'art. 1',
      },
      { id: 'r2', version: 2, checksum: hex('c'), ruleSet: 'local', priority: 0 },
      { id: 'x', version: 1, checksum: hex('3'), ruleSet: 'local', priority: 0 },
      { id: 'R1', version: 1, checksum: hex('6'), ruleSet: 'social', priority: 0 },
      { id: 'R1', version: 1, checksum: hex('7'), ruleSet: 'vat', priority: 0 },
      { id: 'R2', version: 1, checksum: hex('8'), ruleSet: 'vat', priority: 0 },
      { id: 'R2', version: 2, checksum: hex('0'), ruleSet: 'vat', priority: 0 },
    ]),
    outputs: salted('outputs', [
      {
        name: 'kids',
        type: 'decimal',
        combine: 'sum',
        status: 'undetermined',
        contributors: [],
        pending: [],
        unit: 'XOF',
        per: '/enfants',
        sign: 'nonNegative',
      },
      {
        name: 'social:aid',
        type: 'boolean',
        combine: 'all',
        status: 'provisional',
        value: true,
        contributors: ['vat:R1', 'social:R1'],
        pending: [],
        empty: true,
      },
      {
        name: 'value',
        type: 'number',
        combine: 'sum',
        status: 'determined',
        value: 150,
        contributors: ['r1'],
        pending: [],
        rounding: { scale: 2, mode: 'halfEven', at: 'contribution' },
        unit: 'EUR',
      },
      {
        name: 'vat:level',
        type: 'enum',
        combine: 'max',
        status: 'conflict',
        value: 'high',
        contributors: ['vat:R2'],
        pending: [],
        selected: { ruleId: 'vat:R2' },
        values: ['low', 'mid', 'high'],
        dimension: 'level',
      },
    ]),
    items: salted('items', [
      {
        output: 'kids',
        subject: '/enfants/@a7',
        status: 'determined',
        value: '10.5',
        contributors: ['k'],
        pending: [],
      },
      {
        output: 'kids',
        subject: '/enfants/@c9',
        status: 'undetermined',
        contributors: [],
        pending: ['k'],
        bounds: { min: '0' },
      },
    ]),
    applied: salted('applied', [
      {
        ruleId: 'k',
        version: 1,
        subject: '/enfants/@a7',
        model: 'PER_CHILD',
        output: 'kids',
        contribution: '10.5',
        status: 'determined',
        stratum: 0,
        matches: { pays: { values: ['FR'], via: ['UE'] } },
      },
      {
        ruleId: 'r1',
        version: 1,
        model: 'FLAT',
        output: 'value',
        contribution: 150,
        status: 'determined',
        stratum: 0,
        unrounded: 150.004,
        sourceRef: 'art. 1',
      },
      {
        ruleId: 'social:R1',
        version: 1,
        model: 'CHECK',
        output: 'social:aid',
        contribution: true,
        status: 'provisional',
        stratum: 0,
      },
      {
        ruleId: 'vat:R1',
        version: 1,
        model: 'CHECK',
        output: 'social:aid',
        contribution: true,
        status: 'determined',
        stratum: 0,
      },
      {
        ruleId: 'vat:R2',
        version: 1,
        model: 'LEVEL',
        output: 'vat:level',
        contribution: 'high',
        status: 'conflict',
        stratum: 1,
      },
    ]),
    skipped: salted('skipped', [
      {
        ruleId: 'k',
        version: 1,
        instances: 2,
        output: 'kids',
        reason: 'INACTIVE_DATE',
        detail: INACTIVE,
        status: 'determined',
        stratum: 0,
      },
      {
        ruleId: 'r2',
        version: 2,
        output: 'value',
        reason: 'INHIBITED',
        detail: 'inhibited by x@1',
        status: 'determined',
        stratum: 0,
      },
      {
        ruleId: 'vat:R2',
        version: 2,
        output: 'vat:level',
        reason: 'INACTIVE_DATE',
        status: 'determined',
        stratum: 1,
      },
    ]),
    pending: salted('pending', [
      {
        ruleId: 'k',
        version: 1,
        subject: '/enfants/@c9',
        output: 'kids',
        reason: 'UNDETERMINED',
        detail: 'missing /enfants/1/revenu',
        missing: ['/enfants/1/revenu'],
        stratum: 0,
      },
    ]),
    exceptions: salted('exceptions', [
      {
        ruleId: 'x',
        version: 1,
        kind: 'inhibit',
        affected: [{ ruleId: 'r2' }],
        status: 'determined',
        stratum: 0,
      },
    ]),
    factsRead: salted('factsRead', [
      {
        path: '/$dates/effective',
        method: 'human',
        status: 'validated',
        assertionDigest: hex('4'),
      },
      { path: '/enfants/0/revenu' },
      { path: '/income' },
    ]),
    missingFacts: salted('missingFacts', [{ path: '/enfants/1/revenu' }]),
    readsUndeclared: salted('readsUndeclared', [{ ruleId: 'social:R1', version: 1 }]),
  };
}

export const BASE_PROOF: Readonly<Record<string, unknown>> = Object.freeze({
  ...baseContent(),
  digest: hex('d'),
});

type Proof = Record<string, unknown>;

/** `BASE_PROOF` with its root members replaced by `patch`. */
export function proofWith(patch: Proof): Proof {
  return { ...baseContent(), digest: hex('d'), ...patch };
}

/** `BASE_PROOF` without its root member `key`. */
export function proofWithout(key: string): Proof {
  const copy = proofWith({});
  delete copy[key];
  return copy;
}

/** The entries of `section` of a fresh base content. */
export function entries(section: string): Proof[] {
  const list = baseContent()[section];
  if (!Array.isArray(list)) throw new Error(`no section ${section}`);
  return list as Proof[];
}

/**
 * `BASE_PROOF` with entry `index` of `section` patched by `patch` (a member set to
 * `undefined` is removed).
 */
export function entryWith(section: string, index: number, patch: Proof): Proof {
  const list = entries(section);
  const entry: Proof = { ...list[index], ...patch };
  for (const [key, value] of Object.entries(patch)) if (value === undefined) delete entry[key];
  list[index] = entry;
  return proofWith({ [section]: list });
}

/** RFC 8032, section 7.1, test 1. */
export const RFC_SECRET = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
export const RFC_PUBLIC = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
export const TRUSTED = { 'executor-1': RFC_PUBLIC };

export const ruleA: RuleDefinitionInput = {
  id: 'r1',
  version: 1,
  model: 'FLAT',
  params: { amount: 150 },
  priority: 1,
  effectiveFrom: '2025-01-01',
  sourceRef: 'art. 1',
};
export const ruleB: RuleDefinitionInput = {
  id: 'r2',
  version: 2,
  model: 'PERCENTAGE',
  params: { rate: 0.1, base: 'income' },
  priority: 2,
  effectiveFrom: '2025-01-01',
  condition: { dsl: 'jsonlogic', value: { '>': [{ var: 'income' }, 5000] } },
};
export const RULES = [ruleA, ruleB];

export const input: ProofInput = {
  data: { income: 1000 },
  meta: {
    tenantId: 't1',
    dates: { effective: '2025-06-01T00:00:00.000Z' },
    tags: [],
    dimensions: {},
    context: {},
    assertions: {},
  },
};

/**
 * A small consistent decision of the rules `ruleA` (applied, output `value` 150) and `ruleB`
 * (its condition false), with their real checksums: the proof the signing tests seal and sign.
 */
export function unsigned(): UnsignedProof {
  return {
    format: PROOF_FORMAT,
    requestId: 'req-1',
    evaluatedAt: '2025-06-01T00:00:00.000Z',
    sealedAt: '2025-06-01T10:00:00.000Z',
    inputDigest: computeInputDigest(input, UNSALTED_SEED),
    inputSalted: false,
    timeZone: 'UTC',
    ruleSets: [],
    versions: {
      engine: '1.0.0-next.1',
      plugins: {},
      dsls: { jsonlogic: '0.2.0' },
      models: { FLAT: '1.0.0', PERCENTAGE: '1.0.0' },
      components: [],
    },
    strata: [['value']],
    rules: salted('rules', [
      {
        id: 'r1',
        version: 1,
        checksum: computeRuleChecksum(ruleA),
        ruleSet: 'local',
        priority: ruleA.priority,
        sourceRef: 'art. 1',
      },
      {
        id: 'r2',
        version: 2,
        checksum: computeRuleChecksum(ruleB),
        ruleSet: 'local',
        priority: ruleB.priority,
      },
    ]),
    outputs: salted('outputs', [
      {
        name: 'value',
        type: 'number',
        combine: 'sum',
        status: 'determined',
        value: 150,
        contributors: ['r1'],
        pending: [],
      },
    ]),
    items: [],
    applied: salted('applied', [
      {
        ruleId: 'r1',
        version: 1,
        model: 'FLAT',
        output: 'value',
        contribution: 150,
        status: 'determined',
        stratum: 0,
        sourceRef: 'art. 1',
      },
    ]),
    skipped: salted('skipped', [
      {
        ruleId: 'r2',
        version: 2,
        output: 'value',
        reason: 'CONDITION_FALSE',
        status: 'determined',
        stratum: 0,
      },
    ]),
    pending: [],
    exceptions: [],
    factsRead: salted('factsRead', [{ path: '/income' }]),
    missingFacts: [],
    readsUndeclared: [],
  };
}

export const sealed = (): DecisionProof => sealProof(unsigned());
export const signed = (): DecisionProof => signProof(sealed(), RFC_SECRET, 'executor-1');
