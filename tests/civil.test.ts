import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  computeRuleChecksum,
  isCivilDate,
  isInstant,
  isTimeZone,
  normalizeTimeZone,
  toReferenceDate,
} from '../src/index.js';
import { specError } from './helpers.js';

const FORMS =
  'must be a Date, a civil date YYYY-MM-DD or an instant YYYY-MM-DDTHH:MM:SS[.sss] with Z ' +
  'or ±HH:MM, in the years 0000 to 9999';

describe('toReferenceDate: forms', () => {
  it('keeps a civil date civil', () => {
    expect(toReferenceDate('2026-01-01')).toBe('2026-01-01');
  });

  it('turns a date-time with an offset into the canonical UTC instant', () => {
    expect(toReferenceDate('2026-01-01T01:00:00+01:00')).toBe('2026-01-01T00:00:00.000Z');
  });

  it('turns a Date into the canonical UTC instant', () => {
    expect(toReferenceDate(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
  });

  it('accepts a Date from another realm', () => {
    const foreign = runInNewContext('new Date(86400000)') as Date;
    expect(toReferenceDate(foreign)).toBe('1970-01-02T00:00:00.000Z');
  });

  it.each([
    ['a date-time without a time zone', '2026-01-01T00:00:00'],
    ['an impossible day', '2026-02-30'],
  ])('refuses %s with INVALID_DATE', (_label, value) => {
    const error = specError(() => toReferenceDate(value));
    expect(error.code).toBe('INVALID_DATE');
    expect(error.message).toBe(`a reference date ${FORMS}; got "${value}"`);
  });
});

describe('toReferenceDate: grammar of an instant (M-2)', () => {
  it.each([
    ['Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000Z'],
    ['one decimal', '2026-01-01T00:00:00.5Z', '2026-01-01T00:00:00.500Z'],
    ['three decimals and an offset', '2026-01-01T00:00:00.123+05:30', '2025-12-31T18:30:00.123Z'],
    ['a negative offset crossing the day', '2025-12-31T23:30:00-00:45', '2026-01-01T00:15:00.000Z'],
    ['offset +23:59', '2026-01-01T00:00:00+23:59', '2025-12-31T00:01:00.000Z'],
    ['offset -14:00', '2026-01-01T00:00:00-14:00', '2026-01-01T14:00:00.000Z'],
    ['offset +14:00', '2026-01-01T00:00:00+14:00', '2025-12-31T10:00:00.000Z'],
    ['second 59', '2026-12-31T23:59:59Z', '2026-12-31T23:59:59.000Z'],
    ['the first instant of year 0000', '0000-01-01T00:00:00Z', '0000-01-01T00:00:00.000Z'],
    ['the last instant of year 9999', '9999-12-31T23:59:59.999Z', '9999-12-31T23:59:59.999Z'],
    ['a leap day', '2024-02-29T12:00:00Z', '2024-02-29T12:00:00.000Z'],
    ['leap day of year 2000', '2000-02-29T00:00:00Z', '2000-02-29T00:00:00.000Z'],
    ['an offset into a leap day', '2024-03-01T00:30:00+01:00', '2024-02-29T23:30:00.000Z'],
  ])('accepts %s', (_label, value, expected) => {
    expect(toReferenceDate(value)).toBe(expected);
  });

  it.each([
    ['four decimals', '2026-01-01T00:00:00.1234Z'],
    ['a lowercase z', '2026-01-01T00:00:00z'],
    ['a lowercase t', '2026-01-01t00:00:00Z'],
    ['a leap second', '2026-12-31T23:59:60Z'],
    ['an expanded year', '+12026-01-01T00:00:00Z'],
    ['offset hour 24', '2026-01-01T00:00:00+24:00'],
    ['offset minute 60', '2026-01-01T00:00:00+01:60'],
    ['no seconds', '2026-01-01T00:00Z'],
    ['hour 24', '2026-01-01T24:00:00Z'],
    ['minute 60', '2026-01-01T00:60:00Z'],
    ['an offset without colon', '2026-01-01T00:00:00+0100'],
    ['an hour-only offset', '2026-01-01T00:00:00+01'],
    ['a space instead of T', '2026-01-01 00:00:00Z'],
    ['an empty fraction', '2026-01-01T00:00:00.Z'],
    ['a comma decimal', '2026-01-01T00:00:00,5Z'],
    ['non-ASCII digits', '٢٠٢٦-01-01T00:00:00Z'],
    ['a trailing newline', '2026-01-01T00:00:00Z\n'],
    ['a common-year February 29', '2026-02-29T00:00:00Z'],
    ['February 29 of 1900', '1900-02-29T00:00:00Z'],
    ['day 00', '2026-01-00T00:00:00Z'],
  ])('refuses %s', (_label, value) => {
    const error = specError(() => toReferenceDate(value));
    expect(error.code).toBe('INVALID_DATE');
    expect(error.message).toBe(`a reference date ${FORMS}; got ${JSON.stringify(value)}`);
  });

  it.each([
    ['before year 0000', '0000-01-01T00:00:00+00:01'],
    ['after year 9999', '9999-12-31T23:59:59.999-00:01'],
  ])('refuses an offset that moves the instant %s', (_label, value) => {
    const error = specError(() => toReferenceDate(value));
    expect(error.code).toBe('INVALID_DATE');
    expect(error.message).toBe(
      `a reference date ${FORMS}; got "${value}", outside the years 0000 to 9999 in UTC`,
    );
  });

  it.each([
    ['an invalid Date', new Date('x'), 'an invalid Date'],
    ['a Date before year 0000', new Date(Date.UTC(-1, 11, 31)), 'a Date outside the years'],
    ['a Date after year 9999', new Date(Date.UTC(10000, 0, 1)), 'a Date outside the years'],
  ])('refuses %s', (_label, value, got) => {
    const error = specError(() => toReferenceDate(value));
    expect(error.code).toBe('INVALID_DATE');
    expect(error.message.startsWith(`a reference date ${FORMS}; got ${got}`)).toBe(true);
  });

  it('accepts the extreme Dates of the range', () => {
    expect(toReferenceDate(new Date('0000-01-01T00:00:00.000Z'))).toBe('0000-01-01T00:00:00.000Z');
    expect(toReferenceDate(new Date('9999-12-31T23:59:59.999Z'))).toBe('9999-12-31T23:59:59.999Z');
  });

  it('refuses a non-string non-Date and a fake Date', () => {
    const fake = { [Symbol.toStringTag]: 'Date', getTime: () => 0 };
    for (const [value, got] of [
      [0, 'number'],
      [null, 'null'],
      [['2026-01-01'], 'array'],
      [fake, 'object'],
    ] as const) {
      const error = specError(() => toReferenceDate(value as unknown as string));
      expect(error.code).toBe('INVALID_DATE');
      expect(error.message).toBe(`a reference date ${FORMS}; got a value of type ${got}`);
    }
  });

  it('refuses a revoked Proxy without a raw error', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const error = specError(() => toReferenceDate(proxy as unknown as string));
    expect(error.code).toBe('INVALID_DATE');
    expect(error.message).toBe(`a reference date ${FORMS}; got an unreadable value`);
  });

  it('escapes a lone surrogate and cuts a huge text in the message', () => {
    expect(specError(() => toReferenceDate('2026-01-01\uD800')).message).toBe(
      `a reference date ${FORMS}; got "2026-01-01\\ud800"`,
    );
    const huge = '9'.repeat(1_000_000);
    expect(specError(() => toReferenceDate(huge)).message).toBe(
      `a reference date ${FORMS}; got "${'9'.repeat(256)}…"`,
    );
  });
});

describe('isCivilDate and isInstant', () => {
  it.each(['2026-01-01', '0000-01-01', '9999-12-31', '2024-02-29', '2000-02-29', '0000-02-29'])(
    'isCivilDate(%j) is true',
    (value) => {
      expect(isCivilDate(value)).toBe(true);
    },
  );

  it.each([
    '2026-02-30',
    '1900-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-1-01',
    '+02026-01-01',
    '2026-01-01T00:00:00.000Z',
    '',
    1,
    null,
    new Date(0),
  ])('isCivilDate(%j) is false', (value) => {
    expect(isCivilDate(value)).toBe(false);
  });

  it.each(['2026-01-01T00:00:00.000Z', '0000-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z'])(
    'isInstant(%j) is true',
    (value) => {
      expect(isInstant(value)).toBe(true);
    },
  );

  it.each([
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00.5Z',
    '2026-01-01T00:00:00.000+00:00',
    '2026-01-01T00:00:60.000Z',
    '2026-02-30T00:00:00.000Z',
    '2026-01-01T24:00:00.000Z',
    '2026-01-01',
    'x',
    0,
    new Date(0),
  ])('isInstant(%j) is false: canonical form only', (value) => {
    expect(isInstant(value)).toBe(false);
  });

  it('never throws, even on a revoked Proxy', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(isCivilDate(proxy)).toBe(false);
    expect(isInstant(proxy)).toBe(false);
  });
});

describe('isTimeZone and normalizeTimeZone (M-3)', () => {
  it.each([
    'UTC',
    '+01:00',
    '-09:30',
    '+14:00',
    '-12:00',
    '+00:00',
    '-00:00',
    '+23:59',
    'Europe/Paris',
    'America/Argentina/Buenos_Aires',
    'Etc/GMT+5',
    'America/Port-au-Prince',
  ])('isTimeZone(%j) is true', (zone) => {
    expect(isTimeZone(zone)).toBe(true);
  });

  it.each([
    '+24:00',
    '+01:60',
    'Paris',
    'europe/paris',
    '',
    'utc',
    'Z',
    '+1:00',
    '+0100',
    'Europe/',
    'Europe//Paris',
    '/Europe/Paris',
    'Europe/9Paris',
    'Europe/Pa ris',
    ' UTC',
    'UTC\n',
    'Europe/Paris\uD800',
    1,
    null,
  ])('isTimeZone(%j) is false', (zone) => {
    expect(isTimeZone(zone)).toBe(false);
  });

  it('isTimeZone answers huge texts in linear time', () => {
    expect(isTimeZone(`${'A/'.repeat(500_000)}!`)).toBe(false);
    expect(isTimeZone(`Europe/${'a'.repeat(1_000_000)}!`)).toBe(false);
    expect(isTimeZone(`Europe/${'a'.repeat(1_000_000)}`)).toBe(true);
  });

  it('isTimeZone never throws, even on a revoked Proxy', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(isTimeZone(proxy)).toBe(false);
  });

  it("writes '+00:00' and '-00:00' as 'UTC' and leaves every other zone unchanged", () => {
    expect(normalizeTimeZone('+00:00')).toBe('UTC');
    expect(normalizeTimeZone('-00:00')).toBe('UTC');
    expect(normalizeTimeZone('UTC')).toBe('UTC');
    expect(normalizeTimeZone('+01:00')).toBe('+01:00');
    expect(normalizeTimeZone('Europe/Paris')).toBe('Europe/Paris');
  });

  it("a rule at timeZone '+00:00' has the checksum of the same rule at 'UTC'", () => {
    const rule = {
      id: 'r1',
      version: 1,
      model: 'M',
      params: {},
      priority: 1,
      effectiveFrom: '2026-01-01',
    };
    const utc = computeRuleChecksum({ ...rule, timeZone: 'UTC' });
    expect(computeRuleChecksum({ ...rule, timeZone: '+00:00' })).toBe(utc);
    expect(computeRuleChecksum({ ...rule, timeZone: '-00:00' })).toBe(utc);
    expect(computeRuleChecksum({ ...rule, timeZone: '+01:00' })).not.toBe(utc);
    expect(computeRuleChecksum(rule)).not.toBe(utc);
  });
});
