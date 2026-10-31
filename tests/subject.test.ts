import { describe, expect, it } from 'vitest';
import * as canonicalEntry from '../src/canonical-entry.js';
import {
  elementSegment,
  formatPointer,
  groupSegment,
  isSubject,
  subjectContains,
} from '../src/index.js';
import type { Subject } from '../src/index.js';
import { specError } from './helpers.js';

describe('elementSegment', () => {
  it('writes "@" and the key: a text, or a safe integer in decimal', () => {
    expect(elementSegment('a7')).toBe('@a7');
    expect(elementSegment(7)).toBe('@7');
    expect(elementSegment('7')).toBe('@7');
    expect(elementSegment(-0)).toBe('@0');
    expect(elementSegment('a/b')).toBe('@a/b');
    expect(formatPointer(['enfants', elementSegment('a/b')])).toBe('/enfants/@a~1b');
  });

  it.each([
    [4.5, 'an element key must be a string or a safe integer, got 4.5'],
    [2 ** 53, 'an element key must be a string or a safe integer, got 9007199254740992'],
    [Number.NaN, 'an element key must be a string or a safe integer, got NaN'],
    [true, 'an element key must be a string or a safe integer, got boolean'],
    [null, 'an element key must be a string or a safe integer, got null'],
    [{}, 'an element key must be a string or a safe integer, got object'],
    ['\ud800', 'an element key contains a lone UTF-16 surrogate'],
  ])('refuses %j with INVALID_PATH', (key, message) => {
    // A JavaScript caller can pass anything; the signature says string | number.
    const error = specError(() => elementSegment(key as string));
    expect(error.code).toBe('INVALID_PATH');
    expect(error.message).toBe(message);
  });
});

describe('groupSegment', () => {
  it('writes "!group=" and the value, a text or a safe integer in decimal', () => {
    expect(groupSegment('C1')).toBe('!group=C1');
    expect(groupSegment(42)).toBe('!group=42');
    expect(groupSegment('42')).toBe('!group=42');
  });

  it.each([
    [4.5, 'a group value must be a string or a safe integer, got 4.5'],
    [false, 'a group value must be a string or a safe integer, got boolean'],
    [null, 'a group value must be a string or a safe integer, got null'],
    [['C1'], 'a group value must be a string or a safe integer, got array'],
    ['\udfff', 'a group value contains a lone UTF-16 surrogate'],
  ])('refuses %j with INVALID_PATH', (value, message) => {
    // A JavaScript caller can pass anything; the signature says string | number.
    const error = specError(() => groupSegment(value as string));
    expect(error.code).toBe('INVALID_PATH');
    expect(error.message).toBe(message);
  });
});

describe('isSubject', () => {
  it.each([
    '/foyers/@f1/personnes/@a7',
    '/x/!segment=2026-01-01..2026-02-01',
    '/x/!segment=2024-02-29..2024-03-01',
    '/x/!group=C42',
    '/x/!group=',
    '/operations/!group=C1/@op3',
    '/enfants/@a~1b',
    '/x',
  ])('accepts %j', (subject) => {
    expect(isSubject(subject)).toBe(true);
  });

  it.each([
    '',
    '/x/!other',
    '/x/!segment=2026-13-01..2026-02-01',
    '/x/!segment=2023-02-29..2023-03-01',
    '/x/!segment=2026-02-01..2026-01-01',
    '/x/!segment=2026-01-01..2026-01-01',
    '/x/!segment=2026-01-01',
    '/x/!segment=2026-1-01..2026-02-01',
    '/x/!group',
    '/a~2',
    'x',
    '/\ud800',
  ])('refuses %j', (subject) => {
    expect(isSubject(subject)).toBe(false);
  });

  it('refuses anything that is not a string, a hostile value included, without throwing', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
        getPrototypeOf() {
          throw new Error('trap');
        },
      },
    );
    for (const value of [42, null, undefined, ['/x'], hostile]) {
      expect(isSubject(value)).toBe(false);
    }
  });

  it('narrows to Subject', () => {
    const value: unknown = '/x/@1';
    if (isSubject(value)) {
      const subject: Subject = value;
      expect(subject).toBe('/x/@1');
    }
  });
});

describe('subjectContains', () => {
  it('is a prefix by segments, the subject itself included', () => {
    expect(subjectContains('/foyers/@f1', '/foyers/@f1/personnes/@a7')).toBe(true);
    expect(subjectContains('/foyers/@f1', '/foyers/@f10/personnes/@a7')).toBe(false);
    expect(subjectContains('/foyers/@f1', '/foyers/@f1')).toBe(true);
    expect(subjectContains('/foyers/@f1/personnes/@a7', '/foyers/@f1')).toBe(false);
    expect(subjectContains('/a~1b', '/a/b')).toBe(false);
  });

  it('refuses a value that is not a subject with INVALID_PATH', () => {
    const error = specError(() => subjectContains('', '/x/@1'));
    expect(error.code).toBe('INVALID_PATH');
    expect(error.message).toBe('invalid subject "": not a subject');
    expect(specError(() => subjectContains('/x/@1', '/x/!other')).message).toBe(
      'invalid subject "/x/!other": not a subject',
    );
  });
});

describe('revoked proxies never escape as raw errors', () => {
  it('give INVALID_PATH, or false from isSubject', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    // A JavaScript caller can pass anything; the signatures say string (and number).
    const hostile = proxy as unknown as string;
    const cases: [() => unknown, string][] = [
      [
        () => elementSegment(hostile),
        'an element key must be a string or a safe integer, got unreadable value',
      ],
      [
        () => groupSegment(hostile),
        'a group value must be a string or a safe integer, got unreadable value',
      ],
      [() => subjectContains(hostile, '/x/@1'), 'invalid subject unreadable value: not a subject'],
      [() => subjectContains('/x/@1', hostile), 'invalid subject unreadable value: not a subject'],
    ];
    for (const [call, message] of cases) {
      const error = specError(call);
      expect(error.code).toBe('INVALID_PATH');
      expect(error.message).toBe(message);
    }
    expect(isSubject(proxy)).toBe(false);
  });
});

describe('both entries', () => {
  it('export the subject API', () => {
    expect(canonicalEntry.elementSegment).toBe(elementSegment);
    expect(canonicalEntry.groupSegment).toBe(groupSegment);
    expect(canonicalEntry.isSubject).toBe(isSubject);
    expect(canonicalEntry.subjectContains).toBe(subjectContains);
  });
});
