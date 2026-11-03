/**
 * One definition of a Date everywhere: an object is a `Date` only if it holds the internal slot of
 * a Date AND has the prototype of a Date. With the slot under a plain prototype
 * (`Object.setPrototypeOf(new Date(0), Object.prototype)`) it is neither a Date nor plain: it is
 * refused with its pointer. Without the slot it is plain, whatever its `Symbol.toStringTag` says.
 */
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  computeRuleChecksum,
  normalizeRuleDefinition,
  toReferenceDate,
  validateProofInput,
  validateRuleDefinition,
} from '../src/index.js';
import { dateTimeOf, hasDateSlot, isPlainObject } from '../src/values.js';
import { specError } from './helpers.js';

const withPrototype = (proto: object | null): Date => {
  const date = new Date(0);
  Object.setPrototypeOf(date, proto);
  return date;
};
const FAKES: [string, () => Date][] = [
  ['Object.prototype', () => withPrototype(Object.prototype)],
  ['null', () => withPrototype(null)],
];
const base = {
  id: 'r1',
  version: 1,
  model: 'M',
  params: 1,
  priority: 1,
  effectiveFrom: '2025-01-01',
};

describe('a Date is an object with the slot and the prototype of a Date', () => {
  it('a Date of this realm is a Date', () => {
    const date = new Date(5);
    expect(dateTimeOf(date)).toBe(5);
    expect(hasDateSlot(date)).toBe(true);
    expect(isPlainObject(date)).toBe(false);
    expect(canonicalize({ at: date })).toBe('{"at":"1970-01-01T00:00:00.005Z"}');
  });

  it('a subclass and a Date of another realm are not: the prototype is compared in one step', () => {
    class Sub extends Date {}
    for (const date of [new Sub(5), runInNewContext('new Date(5)') as Date]) {
      expect(hasDateSlot(date)).toBe(true);
      expect(dateTimeOf(date)).toBeUndefined();
      expect(isPlainObject(date)).toBe(false);
      const error = specError(() => canonicalize({ at: date }));
      expect(error.path).toBe('at');
      expect(error.message).toContain('a Date with a foreign prototype');
    }
  });

  it.each(FAKES)('a Date under the prototype %s is not a Date and not plain', (_name, make) => {
    const fake = make();
    expect(hasDateSlot(fake)).toBe(true);
    expect(dateTimeOf(fake)).toBeUndefined();
    expect(isPlainObject(fake)).toBe(false);
  });

  it.each(FAKES)('canonicalize refuses it with its pointer (%s)', (_name, make) => {
    const error = specError(() => canonicalize({ list: [{ at: make() }] }));
    expect(error.code).toBe('NON_SERIALIZABLE');
    expect(error.path).toBe('list[0].at');
    expect(error.message).toContain('a Date with a plain prototype');
  });

  it.each(FAKES)(
    'a rule refuses it where a Date is read, and in free-form values (%s)',
    (_n, make) => {
      const rule = { ...base, effectiveFrom: make() } as never;
      expect(validateRuleDefinition(rule).valid).toBe(false);
      expect(() => normalizeRuleDefinition(rule)).toThrow();
      const params = { ...base, params: { at: make() } } as never;
      expect(validateRuleDefinition(params).errors[0]).toContain('params.at');
      expect(specError(() => computeRuleChecksum(params)).code).toBe('NON_SERIALIZABLE');
      expect(() => toReferenceDate(make())).toThrow();
    },
  );

  it('an object with no slot is plain, whatever its toStringTag says', () => {
    const fake = { [Symbol.toStringTag]: 'Date', a: 1 };
    expect(hasDateSlot(fake)).toBe(false);
    expect(isPlainObject(fake)).toBe(true);
    expect(canonicalize({ fake })).toBe('{"fake":{"a":1}}');
    const nullProto = Object.assign(Object.create(null) as object, { b: 2 });
    expect(isPlainObject(nullProto)).toBe(true);
  });
});

describe('and in an input read as JSON', () => {
  it.each(FAKES)('a Date under %s is named, not read as a plain object', (_name, make) => {
    const issues = validateProofInput({
      data: { born: make() },
      meta: { tenantId: 't', dates: {}, tags: [], dimensions: {}, context: {}, assertions: {} },
    });
    expect(issues.some((issue) => issue.message.includes('a Date with a plain prototype'))).toBe(
      true,
    );
  });
});
