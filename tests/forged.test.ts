import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  canonicalize,
  canonicalizeAt,
  findOverlappingVersions,
  fromStoredRecord,
  governingAssertion,
  normalizeRuleDefinition,
  sha256Hex,
  SpecError,
  toCanonicalDecimal,
  validateOutputDeclaration,
  validateProofInput,
  validateRuleDefinition,
  validateTemporalFact,
  valueMatchesOutputType,
  verifyRuleChecksum,
  windowContains,
} from '../src/index.js';
import type {
  CivilCalendar,
  FactAssertion,
  OutputDeclaration,
  RuleDefinitionInput,
  StoredRuleRecord,
  VersionedRuleWindow,
} from '../src/index.js';
import * as canonicalEntry from '../src/canonical-entry.js';
import { isOwnError } from '../src/errors.js';
import * as api from '../src/index.js';
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

/** Throws a forged `SpecError`. */
function throwForged(): never {
  throw forged();
}

/** A Proxy over `target` whose every trap throws a forged `SpecError`. */
function allTrapsThrow(target: object): object {
  const traps: ProxyHandler<object> = {
    get: throwForged,
    has: throwForged,
    ownKeys: throwForged,
    getOwnPropertyDescriptor: throwForged,
    getPrototypeOf: throwForged,
    apply: throwForged,
    construct: throwForged,
    set: throwForged,
    defineProperty: throwForged,
    deleteProperty: throwForged,
    isExtensible: throwForged,
    preventExtensions: throwForged,
    setPrototypeOf: throwForged,
  };
  return new Proxy(target, traps);
}

/** A Proxy that has been revoked: every operation on it throws a `TypeError`. */
function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
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
      'Value at "a.b" cannot be serialized to canonical JSON: ' +
        `a value that could not be read: ${REASON}`,
    );
    expect(error.path).toBe('a.b');
  });

  it('canonicalize cites a plain Error and a thrown value the same way', () => {
    for (const thrown of [new Error(HUGE), HUGE]) {
      expect(specError(() => canonicalize(throwingAt('b', thrown))).message).toBe(
        'Value at "b" cannot be serialized to canonical JSON: ' +
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

describe('every read of caller input at the API boundary is guarded', () => {
  it('fromStoredRecord: a record that throws a forged error, or cannot be read', () => {
    const getter = {
      id: 'r',
      version: 1,
      checksum: 'x',
      get payload(): never {
        throw forged();
      },
    };
    for (const record of [getter, throwingProxy(forged())]) {
      const error = specError(() => fromStoredRecord(record as unknown as StoredRuleRecord));
      expect(error.code).toBe('INVALID_RULE');
      expect(error.message).toBe(`stored rule record could not be read: ${REASON}`);
      expect(error.path).toBeUndefined();
    }
    expect(
      specError(() => fromStoredRecord(revokedProxy() as unknown as StoredRuleRecord)).message,
    ).toBe(
      "stored rule record could not be read: Cannot perform 'IsArray' on a proxy that has been " +
        'revoked',
    );
  });

  it('fromStoredRecord: an id or version that is an object runs no caller code', () => {
    const id = {
      toString(): never {
        throw forged();
      },
    };
    const record = { id, version: 1, checksum: 'x', payload: '{}' };
    expect(specError(() => fromStoredRecord(record as unknown as StoredRuleRecord)).message).toBe(
      'Stored rule an object@1: malformed record: id must be a string and version a number',
    );
  });

  it('verifyRuleChecksum: a checksum that throws, a rule that is not an object', () => {
    const rule = {
      ...BASE_RULE,
      get checksum(): never {
        throw forged();
      },
    };
    expect(specError(() => verifyRuleChecksum(rule))).toMatchObject({
      code: 'INVALID_RULE',
      message: `rule could not be read: ${REASON}`,
    });
    for (const value of [null, undefined, 1, 'x']) {
      expect(
        specError(() =>
          verifyRuleChecksum(value as unknown as Parameters<typeof verifyRuleChecksum>[0]),
        ),
      ).toMatchObject({
        code: 'INVALID_RULE',
        message: 'a rule definition must be a plain object',
      });
    }
  });

  it('canonicalizeAt: a path that is not a string', () => {
    for (const path of [null, undefined, 1, Symbol('s'), throwingProxy(forged())]) {
      expect(specError(() => canonicalizeAt({}, path as unknown as string))).toMatchObject({
        code: 'INVALID_PATH',
        message: `path must be a string, got a value of type ${typeof path}`,
      });
    }
  });

  it('sha256Hex: a value that is not a string, a lone surrogate', () => {
    expect(specError(() => sha256Hex(1 as unknown as string))).toMatchObject({
      code: 'NON_SERIALIZABLE',
      message: 'sha256Hex needs a string, got a value of type number',
    });
    expect(specError(() => sha256Hex(`a${String.fromCharCode(0xd800)}`))).toMatchObject({
      code: 'NON_SERIALIZABLE',
      message: 'sha256Hex: a string with a lone UTF-16 surrogate',
    });
    // A well-formed pair is hashed as UTF-8 (U+1F600 is F0 9F 98 80).
    expect(sha256Hex('\u{1F600}')).toBe(
      createHash('sha256')
        .update(Buffer.from([0xf0, 0x9f, 0x98, 0x80]))
        .digest('hex'),
    );
  });

  it('toCanonicalDecimal: a revoked Proxy', () => {
    expect(specError(() => toCanonicalDecimal(revokedProxy() as unknown as string))).toMatchObject({
      code: 'INVALID_DECIMAL',
      message: 'Not a decimal: an object (expected a string)',
    });
  });

  it('validateOutputDeclaration and validateTemporalFact: a path that is not a string', () => {
    const issue = { path: '', message: 'path must be a string, got a value of type object' };
    const path = throwingProxy(forged()) as unknown as string;
    expect(validateOutputDeclaration({ type: 'number', combine: 'sum' }, path)).toEqual([issue]);
    expect(validateTemporalFact([], path)).toEqual([issue]);
    expect(validateTemporalFact([], undefined as unknown as string)).toEqual([
      { path: '', message: 'path must be a string, got a value of type undefined' },
    ]);
  });

  it('valueMatchesOutputType: a declaration that cannot be read or is not one', () => {
    const declaration = (value: unknown): OutputDeclaration => value as OutputDeclaration;
    const getter = {
      combine: 'first',
      get type(): never {
        throw forged();
      },
    };
    expect(specError(() => valueMatchesOutputType(1, declaration(getter)))).toMatchObject({
      code: 'INVALID_RULE',
      message: `output declaration could not be read: ${REASON}`,
    });
    const values = new Proxy([], {
      get(): never {
        throw forged();
      },
    });
    expect(
      specError(() => valueMatchesOutputType('a', declaration({ type: 'enum', values }))).message,
    ).toBe(`output declaration could not be read: ${REASON}`);
    for (const value of [null, undefined, 'number']) {
      expect(specError(() => valueMatchesOutputType(1, declaration(value))).message).toBe(
        'an output declaration must be an object { type, … }',
      );
    }
    expect(specError(() => valueMatchesOutputType(1, declaration({ type: 'x' }))).message).toBe(
      'output type must be one of number, boolean, string, enum, list, object, decimal',
    );
    expect(
      specError(() => valueMatchesOutputType('a', declaration({ type: 'enum', values: 'a' })))
        .message,
    ).toBe('the values of an enum output must be an array');
    expect(valueMatchesOutputType('a', declaration({ type: 'enum', values: ['a'] }))).toBe(true);
    expect(valueMatchesOutputType('a', declaration({ type: 'enum' }))).toBe(false);
  });
});

describe('canonicalize names the member that could not be read', () => {
  const thrower = (): never => {
    throw new Error('trap');
  };
  const cases: [string, unknown, string][] = [
    ['an object member', { a: throwingAt('b', new Error('trap')) }, 'r.a.b'],
    ['an array item', { a: [1, new Proxy([0], { get: thrower })] }, 'r.a[1]'],
    ['the keys of an object', { a: { b: new Proxy({}, { ownKeys: thrower }) } }, 'r.a.b'],
    ['the prototype of an object', { a: new Proxy({}, { getPrototypeOf: thrower }) }, 'r.a'],
    ['the root', new Proxy({}, { getPrototypeOf: thrower }), 'r'],
  ];
  it.each(cases)('%s', (_label, value, path) => {
    const error = specError(() => canonicalizeAt(value, 'r'));
    expect(error).toMatchObject({
      code: 'NON_SERIALIZABLE',
      path,
      message:
        `Value at "${path}" cannot be serialized to canonical JSON: ` +
        'a value that could not be read: trap',
    });
  });
});

describe('canonicalize keeps no call stack: any depth is accepted', () => {
  it.each([3_000, 100_000])(
    'arrays and objects %i deep',
    (depth) => {
      let array: unknown = 1;
      let object: unknown = 1;
      let mixed: unknown = 'x';
      for (let i = 0; i < depth; i++) {
        array = [array];
        object = { a: object };
        mixed = i % 2 === 0 ? [null, mixed] : { b: undefined, a: mixed };
      }
      expect(canonicalize(array)).toBe(`${'['.repeat(depth)}1${']'.repeat(depth)}`);
      expect(canonicalize(object)).toBe(`${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`);
      let reference = '"x"';
      for (let i = 0; i < depth; i++) {
        reference = i % 2 === 0 ? `[null,${reference}]` : `{"a":${reference}}`;
      }
      expect(canonicalize(mixed)).toBe(reference);
    },
    60_000,
  );

  it('a value it refuses 100,000 deep is reported at its path, in a bounded message', () => {
    let value: unknown = Number.NaN;
    for (let i = 0; i < 100_000; i++) value = [value];
    const error = specError(() => canonicalize(value));
    expect(error.path).toBe(`${'[0]'.repeat(100_000).slice(0, 1024)}…`);
    expect(error.message).toBe(
      `Value at "${'[0]'.repeat(85)}[…" cannot be serialized to canonical JSON: NaN`,
    );
  }, 60_000);

  it('a circular reference deep down is still refused', () => {
    const root: { a: unknown } = { a: null };
    let node: { a: unknown } = root;
    for (let i = 0; i < 10_000; i++) {
      const next = { a: null };
      node.a = next;
      node = next;
    }
    node.a = root;
    expect(specError(() => canonicalize(root)).message).toMatch(/: a circular reference$/);
  }, 60_000);
});

describe('every exported function: hostile arguments give an own SpecError or a result', () => {
  const hostiles: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['a number', 1],
    ['a string', 'x'],
    ['a symbol', Symbol('s')],
    ['a bigint', 1n],
    ['a function', () => 1],
    ['a Proxy whose every trap throws', allTrapsThrow({})],
    ['an array Proxy whose every trap throws', allTrapsThrow([])],
    ['a Date Proxy whose every trap throws', allTrapsThrow(new Date(0))],
    ['a revoked Proxy', revokedProxy()],
    ['an object whose every read throws', new Proxy({}, { get: () => throwForged() })],
    ['an object whose conversions throw', { toString: throwForged, valueOf: throwForged }],
  ];
  const valid: unknown[] = [BASE_RULE, '2020-01-01', 'UTC', fixedCalendar];
  const functions = new Map<string, (...args: unknown[]) => unknown>();
  for (const [name, value] of [...Object.entries(api), ...Object.entries(canonicalEntry)]) {
    if (typeof value === 'function' && value !== SpecError) {
      functions.set(name, value as (...args: unknown[]) => unknown);
    }
  }

  it('covers every exported function', () => {
    expect(functions.size).toBe(64);
  });

  it.each([...functions.keys()])('%s', (name) => {
    const call = functions.get(name);
    if (call === undefined) throw new Error(`no function ${name}`);
    const refused: string[] = [];
    for (const [label, hostile] of hostiles) {
      for (let position = 0; position < 4; position++) {
        for (const fill of ['undefined', 'valid'] as const) {
          const args = [0, 1, 2, 3].map((i) =>
            i === position ? hostile : fill === 'valid' ? valid[i] : undefined,
          );
          try {
            call(...args);
          } catch (error) {
            const bounded =
              isOwnError(error) &&
              error.message.length <= 2048 &&
              (error.path === undefined || error.path.length <= 2048);
            if (!bounded) refused.push(`${label} at ${position}, others ${fill}`);
          }
        }
      }
    }
    expect(refused).toEqual([]);
  });
});

describe('every SpecError.path this package creates is bounded like an issue path', () => {
  it("canonicalizeAt's caller root of 2,000,000 characters", () => {
    const root = 'r'.repeat(2_000_000);
    const error = specError(() => canonicalizeAt({ a: Number.NaN }, root));
    expect(error.path).toBe(`${'r'.repeat(1024)}…`);
    expect(error.message).toBe(
      `Value at "${'r'.repeat(256)}…" cannot be serialized to canonical JSON: NaN`,
    );
  });

  it('never cuts inside a surrogate pair', () => {
    const root = `${'r'.repeat(1023)}\u{1F600}${'r'.repeat(10)}`;
    const error = specError(() => canonicalizeAt({ a: Number.NaN }, root));
    expect(error.path).toBe(`${'r'.repeat(1023)}…`);
  });

  it('a short path is kept as it is', () => {
    expect(specError(() => canonicalizeAt({ a: Number.NaN }, 'r')).path).toBe('r.a');
  });
});
