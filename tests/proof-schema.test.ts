import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { validateProof } from '../src/index.js';
import { entryWith, proofWith, SIGNATURE_VALUE } from './proof-cases.js';
import { REFUSED_PROOFS, VALID_PROOFS, VALIDATOR_ONLY_PROOFS } from './proof-shape-cases.js';
import { stringsOf } from './helpers.js';

const schema = JSON.parse(
  readFileSync(new URL('../schema/decision-proof.schema.json', import.meta.url), 'utf8'),
) as object;
const ajv = new Ajv2020({ strict: true, allErrors: true });
const schemaAccepts = ajv.compile(schema);

const validatorAccepts = (value: unknown): boolean => validateProof(value).issues.length === 0;

/** Asserts the schema and the validator agree on `proofOf(text)` for every text. */
function agree(texts: readonly unknown[], proofOf: (text: unknown) => unknown): number {
  let accepted = 0;
  for (const text of texts) {
    const proof = proofOf(text);
    const verdict = validatorAccepts(proof);
    expect([text, schemaAccepts(proof)]).toEqual([text, verdict]);
    if (verdict) accepted += 1;
  }
  return accepted;
}

describe('validateProof and the decision proof JSON schema agree', () => {
  it('has at least 15 valid and 100 refused cases', () => {
    expect(VALID_PROOFS.length).toBeGreaterThanOrEqual(15);
    expect(REFUSED_PROOFS.length).toBeGreaterThanOrEqual(100);
  });

  it.each(VALID_PROOFS)('accepts %s', (_name, value) => {
    expect(validatorAccepts(value)).toBe(true);
    expect(schemaAccepts(value)).toBe(true);
  });

  it.each(REFUSED_PROOFS)('refuses %s', (_name, value) => {
    expect(validatorAccepts(value)).toBe(false);
    expect(schemaAccepts(value)).toBe(false);
  });

  it.each(VALIDATOR_ONLY_PROOFS)(
    'validator-only: refuses %s (the schema cannot)',
    (_name, value) => {
      expect(validatorAccepts(value)).toBe(false);
      expect(schemaAccepts(value)).toBe(true);
    },
  );

  it('the schema documents the validator-only checks', () => {
    const text = JSON.stringify(schema);
    for (const check of [
      'only by validateProof: no two entries of rules have the same qualified id and version',
      'no text holds a lone UTF-16 surrogate',
      'the dates of a time segment of a subject exist and the first is before the second',
    ]) {
      expect(text).toContain(check);
    }
  });
});

describe('date pattern parity', () => {
  const dates = [
    '2025-01-01',
    '2024-02-29',
    '2000-02-29',
    '1900-02-29',
    '2023-02-29',
    '2025-04-31',
    '2025-13-01',
    '2025-01-01T00:00:00.000Z',
    '2024-02-29T23:59:59.999Z',
    '2023-02-29T00:00:00.000Z',
    '2025-01-01T24:00:00.000Z',
    '2025-01-01T00:60:00.000Z',
    '2025-01-01T00:00:60.000Z',
    '2025-01-01T00:00Z',
    '2025-01-01T00:00:00Z',
    '2025-01-01T00:00:00.0000Z',
    '2025-01-01T00:00:00.000+00:00',
    '2025-01-01T00:00:00.000z',
    '2025-01-01 00:00:00.000Z',
    '20250101',
    '',
  ];

  it.each(dates)(
    'validator and schema agree on %j',
    (date) => {
      for (const value of [proofWith({ evaluatedAt: date }), proofWith({ sealedAt: date })]) {
        expect(schemaAccepts(value)).toBe(validatorAccepts(value));
      }
    },
    30_000,
  );

  it('the parity list holds accepted and refused dates', () => {
    const civil = dates.filter((date) => validatorAccepts(proofWith({ evaluatedAt: date })));
    expect(civil).toEqual([
      '2025-01-01',
      '2024-02-29',
      '2000-02-29',
      '2025-01-01T00:00:00.000Z',
      '2024-02-29T23:59:59.999Z',
    ]);
    const instants = dates.filter((date) => validatorAccepts(proofWith({ sealedAt: date })));
    expect(instants).toEqual(['2025-01-01T00:00:00.000Z', '2024-02-29T23:59:59.999Z']);
  });
});

describe('each text pattern of the proof schema matches its validator exactly', () => {
  it('a subject: every string of up to 3 of /, ~, 0, !group=, a time segment, a, -, !', () => {
    const texts = stringsOf(
      ['/', '~', '0', '!group=', '!segment=2026-01-01..2026-02-01', 'a', '-', '!'],
      3,
    );
    expect(agree(texts, (v) => entryWith('applied', 0, { subject: v }))).toBe(43);
    agree(texts, (v) => entryWith('items', 0, { subject: v }));
    agree(texts, (v) => entryWith('exceptions', 0, { affected: [{ ruleId: 'r2', subject: v }] }));
  }, 30_000);

  it('a time segment: real days, the first before the second, only for the validator', () => {
    const segment = (from: string, until: string): unknown =>
      entryWith('applied', 0, { subject: `/f/!segment=${from}..${until}` });
    expect(schemaAccepts(segment('2026-01-01', '2026-02-01'))).toBe(true);
    expect(validatorAccepts(segment('2026-01-01', '2026-02-01'))).toBe(true);
    for (const [from, until] of [
      ['2026-02-30', '2026-03-01'],
      ['2026-02-01', '2026-01-01'],
      ['2026-01-01', '2026-01-01'],
    ] as const) {
      expect(schemaAccepts(segment(from, until))).toBe(true);
      expect(validatorAccepts(segment(from, until))).toBe(false);
    }
  }, 30_000);

  it('a pointer of the evaluation context: every string of up to 4 of /, -, ~, 0, 1, a, $', () => {
    const texts = ['', ...stringsOf(['/', '-', '~', '0', '1', 'a', '$'], 4)];
    const accepted = agree(texts, (v) => entryWith('pending', 0, { missing: [v] }));
    expect(accepted).toBeGreaterThan(100);
  }, 30_000);

  it('a pointer to an input fact: every string of up to 4 tokens of /, -, ~0, $dates, …', () => {
    const texts = [
      '',
      ...stringsOf(['/', '-', '~', '0', '$dates', '$dimensions', '$outputs', '$item', 'a', '$'], 3),
    ];
    expect(agree(texts, (v) => entryWith('missingFacts', 0, { path: v }))).toBe(43);
    agree(texts, (v) => entryWith('factsRead', 1, { path: v }));
  }, 30_000);

  it('a cited rule and an output name: every string of up to 3 of a, :, local, ., $, Z, -', () => {
    const texts = ['', ...stringsOf(['a', ':', 'local', '.', '$', 'Z', '-'], 3)];
    agree(texts, (v) => entryWith('exceptions', 0, { affected: [{ ruleId: v }] }));
    agree(texts, (v) => entryWith('readsUndeclared', 0, { ruleId: v }));
    agree(texts, (v) => proofWith({ requested: [v] }));
    agree(texts, (v) => proofWith({ strata: [[v]] }));
    agree(texts, (v) => entryWith('outputs', 0, { name: v }));
  }, 30_000);

  it('a rule, rule set and pack id: every string of up to 3 of a, :, local, ., -, _, A', () => {
    const texts = ['', ...stringsOf(['a', ':', 'local', '.', '-', '_', 'A', ' '], 3)];
    agree(texts, (v) => entryWith('rules', 0, { id: v }));
    agree(texts, (v) => entryWith('rules', 0, { ruleSet: v }));
    const pack = (id: unknown): Record<string, unknown> => ({
      kind: 'pack',
      id,
      version: '1',
      digest: 'e'.repeat(64),
    });
    agree(texts, (v) => proofWith({ ruleSets: [pack(v)] }));
    agree(texts, (v) => proofWith({ ruleSets: [{ ...pack('p'), imports: [v] }] }));
  }, 30_000);

  it('a time zone: every string of up to 3 tokens of UTC, +, -, 00, 23, 24, :, 59, 60, …', () => {
    const texts = stringsOf(
      ['UTC', '+', '-', '00', '23', '24', ':', '59', '60', 'Europe', '/', 'Paris', 'a', '_'],
      3,
    );
    expect(agree(texts, (v) => proofWith({ timeZone: v }))).toBeGreaterThan(10);
    agree(texts, (v) => proofWith({ ruleSets: [{ kind: 'local', timeZone: v }] }));
  }, 30_000);

  it('a salt, a digest and a signature: hex of each length near theirs, each case', () => {
    const texts = [31, 32, 33, 63, 64, 65].flatMap((n) =>
      ['0', 'a', 'f', 'A', 'g', '-'].map((c) => `${'0'.repeat(n - 1)}${c}`),
    );
    agree(texts, (v) => entryWith('rules', 0, { salt: v }));
    agree(texts, (v) => entryWith('rules', 0, { checksum: v }));
    agree(texts, (v) => entryWith('factsRead', 0, { assertionDigest: v }));
    const values = ['A', 'B', 'Q', 'g', 'w', '_', '-', '='].map((c) => `${'A'.repeat(85)}${c}`);
    const signature = (value: unknown): unknown =>
      proofWith({ signature: { alg: 'ed25519', keyId: 'k', value } });
    expect(agree([...values, SIGNATURE_VALUE], signature)).toBe(5);
  }, 30_000);

  it('a code: every string of up to 4 of a, A, 0, -, _, space, é', () => {
    const texts = ['', ...stringsOf(['a', 'A', '0', '-', '_', ' ', 'é'], 4)];
    const supersedes = (reason: unknown): unknown =>
      proofWith({ supersedes: { digest: '9'.repeat(64), reason } });
    expect(agree(texts, supersedes)).toBeGreaterThan(100);
  }, 30_000);

  it('declaredBy: every string of up to 3 tokens of engine, plugin:, model:, x, :, space', () => {
    const texts = ['', ...stringsOf(['engine', 'plugin:', 'model:', 'x', ':', ' ', '\n'], 3)];
    const component = (declaredBy: unknown): unknown =>
      proofWith({
        versions: {
          engine: '1',
          plugins: {},
          dsls: {},
          models: {},
          components: [{ name: 'c', version: '1', declaredBy }],
        },
      });
    expect(agree(texts, component)).toBeGreaterThan(10);
  }, 30_000);

  it('a matched dimension and its values: every string of up to 4 of a, $, -, :, space', () => {
    const texts = ['', ...stringsOf(['a', '$', '-', ':', ' '], 4)];
    const named = (name: unknown): unknown =>
      entryWith('applied', 0, { matches: { [String(name)]: { values: ['FR'], via: [] } } });
    agree(texts, named);
    const valued = (value: unknown): unknown =>
      entryWith('applied', 0, { matches: { pays: { values: [value], via: [] } } });
    agree(texts, valued);
  }, 30_000);

  it('numbers: versions, strata, instances', () => {
    const numbers = [-1, 0, 1, 1.5, 2, 2 ** 53 - 1, 2 ** 53, 1e300, '1'];
    agree(numbers, (v) => entryWith('rules', 0, { version: v }));
    agree(numbers, (v) => entryWith('applied', 1, { stratum: v }));
    agree(numbers, (v) => entryWith('skipped', 0, { instances: v }));
  });
});
