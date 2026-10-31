import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  findOverlappingVersions,
  governingAssertion,
  normalizeRuleDefinition,
  SpecError,
  validateProofInput,
  validateRuleDefinition,
  windowContains,
} from '../src/index.js';
import type {
  CivilCalendar,
  FactAssertion,
  RuleDefinitionInput,
  VersionedRuleWindow,
} from '../src/index.js';
import { BASE_RULE, fixedCalendar, proofInput, specError } from './helpers.js';

/** 1.2 million characters a message must never carry raw: newlines and quotes. */
const HUGE = 'q\n"'.repeat(400_000);
/** `HUGE` as a message cites it: escaped, cut at 256 characters, never inside an escape. */
const REASON = `${'q\\n\\"'.repeat(51)}q…`;

/** A `SpecError` built by a caller (the class is public), with any code, text and path. */
function forged(): SpecError {
  return new SpecError('INVALID_RULE', HUGE, 'forged.path');
}

/** An object whose `field` getter throws `thrown`. */
function throwingAt(field: string, thrown: unknown, rest: object = {}): Record<string, unknown> {
  const value: Record<string, unknown> = { ...rest };
  Object.defineProperty(value, field, {
    enumerable: true,
    get() {
      throw thrown;
    },
  });
  return value;
}

/** A Proxy whose every trap that reads a property throws `thrown`. */
function throwingProxy(thrown: unknown): Record<string, FactAssertion> {
  const fail = (): never => {
    throw thrown;
  };
  return new Proxy<Record<string, FactAssertion>>(
    {},
    { get: fail, getOwnPropertyDescriptor: fail, ownKeys: fail, has: fail },
  );
}

/** A version whose `effectiveFrom` getter throws `thrown`. */
function version(thrown: unknown): VersionedRuleWindow {
  return {
    id: 'r',
    version: 1,
    effectiveUntil: null,
    get effectiveFrom(): never {
      throw thrown;
    },
  };
}

/** The error this package throws for `canonicalize(NaN)`: one of its own. */
const own = (): SpecError => specError(() => canonicalize(Number.NaN));

describe('a SpecError a caller built is cited, never trusted', () => {
  it('findOverlappingVersions', () => {
    const error = specError(() =>
      findOverlappingVersions([version(forged())], 'UTC', fixedCalendar),
    );
    expect(error.code).toBe('INVALID_RULE');
    expect(error.message).toBe(`rules[0] could not be read: ${REASON}`);
    expect(error.path).toBeUndefined();
  });

  it('validateRuleDefinition and normalizeRuleDefinition give the same cited message', () => {
    const rule = { ...BASE_RULE, params: throwingAt('x', forged()) };
    expect(validateRuleDefinition(rule).issues).toEqual([
      { path: 'params', message: `params could not be read: ${REASON}` },
    ]);
    const error = specError(() => normalizeRuleDefinition(rule));
    expect(error.message).toBe(`params could not be read: ${REASON}`);
    expect(error.path).toBeUndefined();
  });

  it('a whole rule that throws a forged error', () => {
    const rule: RuleDefinitionInput = {
      ...BASE_RULE,
      get params(): never {
        throw forged();
      },
    };
    expect(validateRuleDefinition(rule).issues).toEqual([
      { path: '', message: `rule definition could not be read: ${REASON}` },
    ]);
    expect(specError(() => normalizeRuleDefinition(rule)).message).toBe(
      `rule definition could not be read: ${REASON}`,
    );
  });

  it('validateProofInput', () => {
    const input = proofInput(
      {},
      {
        get a(): never {
          throw forged();
        },
      },
    );
    expect(validateProofInput(input)).toEqual([
      { path: '/data/a', message: `/data/a could not be read: ${REASON}` },
    ]);
  });

  it('governingAssertion', () => {
    const error = specError(() => governingAssertion(throwingProxy(forged()), '/a'));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe(`assertions could not be read: ${REASON}`);
  });

  it('canonicalize', () => {
    const error = specError(() => canonicalize({ a: throwingAt('b', forged()) }));
    expect(error.code).toBe('NON_SERIALIZABLE');
    expect(error.message).toBe(
      'Value at "(root)" cannot be serialized to canonical JSON: ' +
        `a value that could not be read: ${REASON}`,
    );
    expect(error.path).toBe('');
  });

  it('canonicalize cites a plain Error and a thrown value the same way', () => {
    for (const thrown of [new Error(HUGE), HUGE]) {
      expect(specError(() => canonicalize(throwingAt('b', thrown))).message).toBe(
        'Value at "(root)" cannot be serialized to canonical JSON: ' +
          `a value that could not be read: ${REASON}`,
      );
    }
  });

  it('a calendar', () => {
    const calendar: CivilCalendar = {
      ...fixedCalendar,
      toCivilDate: () => {
        throw forged();
      },
    };
    const rule = { effectiveFrom: '2026-01-01', effectiveUntil: null };
    const error = specError(() =>
      windowContains(rule, '2026-01-01T00:00:00.000Z', 'UTC', calendar),
    );
    expect(error.code).toBe('INVALID_DATE');
    expect(error.message).toBe(
      `calendar.toCivilDate failed for 2026-01-01T00:00:00.000Z in UTC: ${REASON}`,
    );
  });
});

describe('an error this package created passes as it is', () => {
  it('through findOverlappingVersions, its message cited as it is', () => {
    const error = own();
    expect(
      specError(() => findOverlappingVersions([version(error)], 'UTC', fixedCalendar)).message,
    ).toBe(`rules[0] could not be read: ${error.message}`);
  });

  it('through governingAssertion', () => {
    const error = own();
    expect(specError(() => governingAssertion(throwingProxy(error), '/a'))).toBe(error);
  });

  it('through canonicalize', () => {
    const error = own();
    expect(specError(() => canonicalize(throwingAt('b', error)))).toBe(error);
  });

  it('through validateRuleDefinition and normalizeRuleDefinition', () => {
    const error = own();
    const rule = { ...BASE_RULE, params: throwingAt('x', error) };
    expect(validateRuleDefinition(rule).issues).toEqual([
      { path: 'params', message: error.message },
    ]);
    expect(specError(() => normalizeRuleDefinition(rule))).toBe(error);
  });

  it('a calendar that rethrows one keeps its message under INVALID_DATE', () => {
    const calendar: CivilCalendar = {
      ...fixedCalendar,
      toCivilDate: () => {
        throw own();
      },
    };
    const rule = { effectiveFrom: '2026-01-01', effectiveUntil: null };
    expect(
      specError(() => windowContains(rule, '2026-01-01T00:00:00.000Z', 'UTC', calendar)),
    ).toMatchObject({ code: 'INVALID_DATE', message: own().message });
  });
});
