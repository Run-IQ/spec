import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { validateProof } from '../src/index.js';
import { proofWith, REFUSED_PROOFS, VALID_PROOFS, VALIDATOR_ONLY_PROOFS } from './proof-cases.js';

const schema = JSON.parse(
  readFileSync(new URL('../schema/decision-proof.schema.json', import.meta.url), 'utf8'),
) as object;
const ajv = new Ajv2020({ strict: true, allErrors: true });
const schemaAccepts = ajv.compile(schema);

const validatorAccepts = (value: unknown): boolean => validateProof(value).issues.length === 0;

describe('validateProof and the decision proof JSON schema agree', () => {
  it('has at least 8 valid and 40 refused cases', () => {
    expect(VALID_PROOFS.length).toBeGreaterThanOrEqual(8);
    expect(REFUSED_PROOFS.length).toBeGreaterThanOrEqual(40);
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

  it('the schema documents the validator-only check', () => {
    expect(JSON.stringify(schema)).toMatch(
      /only by validateProof: no two entries of rules have the same id and version/,
    );
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
    '2025-01-01T00:00Z',
    '2025-01-01T23:59:59.123456789Z',
    '2025-01-01T24:00Z',
    '2025-01-01T00:00:60Z',
    '2025-01-01T00:00+05:30',
    '2025-01-01T00:00+24:00',
    '2025-01-01T00:00',
    '2025-01-01T00:00:00z',
    '2025-01-01 00:00:00Z',
    '20250101',
    '',
  ];

  it.each(dates)('validator and schema agree on %j', (date) => {
    for (const value of [proofWith({ evaluatedAt: date }), proofWith({ sealedAt: date })]) {
      expect(schemaAccepts(value)).toBe(validatorAccepts(value));
    }
  });

  it('the parity list holds accepted and refused dates', () => {
    const accepted = dates.filter((date) => validatorAccepts(proofWith({ sealedAt: date })));
    expect(accepted).toEqual([
      '2025-01-01',
      '2024-02-29',
      '2000-02-29',
      '2025-01-01T00:00Z',
      '2025-01-01T23:59:59.123456789Z',
      '2025-01-01T00:00+05:30',
    ]);
  });
});
