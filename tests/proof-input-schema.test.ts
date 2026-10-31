import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { validateProofInput } from '../src/index.js';
import { REFUSED_INPUTS, VALID_INPUTS, VALIDATOR_ONLY_INPUTS } from './input-cases.js';

const schema = JSON.parse(
  readFileSync(new URL('../schema/proof-input.schema.json', import.meta.url), 'utf8'),
) as object;
const ajv = new Ajv2020({ strict: true, allErrors: true });
const schemaAccepts = ajv.compile(schema);

const validatorAccepts = (value: unknown): boolean => validateProofInput(value).length === 0;

describe('validateProofInput and the proof input JSON schema agree', () => {
  it('has at least 30 valid and 50 refused cases', () => {
    expect(VALID_INPUTS.length).toBeGreaterThanOrEqual(30);
    expect(REFUSED_INPUTS.length).toBeGreaterThanOrEqual(50);
  });

  it.each(VALID_INPUTS)('accepts %s', (_name, value) => {
    expect(validateProofInput(value)).toEqual([]);
    expect(schemaAccepts(value)).toBe(true);
  });

  it.each(REFUSED_INPUTS)('refuses %s', (_name, value) => {
    expect(validatorAccepts(value)).toBe(false);
    expect(schemaAccepts(value)).toBe(false);
  });

  it.each(VALIDATOR_ONLY_INPUTS)(
    'validator-only: refuses %s (the schema cannot)',
    (_name, value) => {
      expect(validatorAccepts(value)).toBe(false);
      expect(schemaAccepts(value)).toBe(true);
    },
  );

  it('agrees on documents read from JSON text', () => {
    for (const [, value] of [...VALID_INPUTS, ...REFUSED_INPUTS]) {
      const parsed: unknown = JSON.parse(JSON.stringify(value));
      expect(schemaAccepts(parsed)).toBe(validatorAccepts(parsed));
    }
  });

  it('the schema documents the validator-only checks', () => {
    const text = JSON.stringify(schema);
    for (const check of [
      'tags sorted',
      'lists of dimension values sorted',
      'lone UTF-16 surrogate',
      'more than 1000 levels',
      'more than 10000000 values',
      'well-formed reserved segments',
    ]) {
      expect(text).toContain(check);
    }
  });
});
