import { describe, expect, it } from 'vitest';
import * as canonicalEntry from '../src/canonical-entry.js';
import {
  comparePointers,
  contextToInputPointer,
  formatPointer,
  parsePointer,
} from '../src/index.js';
import type { JsonPointer } from '../src/index.js';
import { specError } from './helpers.js';

describe('parsePointer', () => {
  it('reads RFC 6901 pointers', () => {
    expect(parsePointer('')).toEqual([]);
    expect(parsePointer('/a~1b/~0c')).toEqual(['a/b', '~c']);
    expect(parsePointer('/a//b')).toEqual(['a', '', 'b']);
    expect(parsePointer('/')).toEqual(['']);
    expect(parsePointer('/~01')).toEqual(['~1']);
  });

  it('keeps "01" as a segment: it names no list element, but the pointer is valid', () => {
    expect(parsePointer('/x/01')).toEqual(['x', '01']);
    expect(parsePointer('/x/-')).toEqual(['x', '-']);
  });

  it.each([
    ['a', 'invalid JSON pointer "a": must be empty or start with "/"'],
    ['/~2', 'invalid JSON pointer "/~2": "~" must be followed by 0 or 1'],
    ['/a~', 'invalid JSON pointer "/a~": "~" must be followed by 0 or 1'],
    ['/\ud800', 'invalid JSON pointer "/\\ud800": contains a lone UTF-16 surrogate'],
  ])('refuses %j with INVALID_PATH citing the text', (pointer, message) => {
    const error = specError(() => parsePointer(pointer));
    expect(error.code).toBe('INVALID_PATH');
    expect(error.message).toBe(message);
  });

  it('cites at most 256 characters of a huge pointer', () => {
    const error = specError(() => parsePointer(`x${'a'.repeat(1_000_000)}`));
    expect(error.message).toBe(
      `invalid JSON pointer "x${'a'.repeat(255)}…": must be empty or start with "/"`,
    );
  }, 60_000);

  it('cuts a cited text between code points, never inside a surrogate pair', () => {
    const pointer = `x${'a'.repeat(254)}${String.fromCodePoint(0x1f600)}b`;
    expect(specError(() => parsePointer(pointer)).message).toBe(
      `invalid JSON pointer "x${'a'.repeat(254)}…": must be empty or start with "/"`,
    );
  });

  it('escapes control characters in a cited text', () => {
    expect(specError(() => parsePointer('a\n')).message).toBe(
      'invalid JSON pointer "a\\n": must be empty or start with "/"',
    );
  });

  it('reads a huge pointer', () => {
    expect(parsePointer('/a'.repeat(200_000))).toHaveLength(200_000);
  }, 60_000);

  it('refuses a value that is not a string', () => {
    // A JavaScript caller can pass anything; the signature says string.
    const notAString = 42 as unknown as string;
    const error = specError(() => parsePointer(notAString));
    expect(error.code).toBe('INVALID_PATH');
    expect(error.message).toBe('a JSON pointer must be a string, got number');
  });
});

/** A revoked Proxy: any operation on it, `Array.isArray` included, throws a TypeError. */
function revoked(): string[] {
  const { proxy, revoke } = Proxy.revocable<string[]>([], {});
  revoke();
  return proxy;
}

describe('revoked proxies never escape as raw errors', () => {
  it('parsePointer, comparePointers, contextToInputPointer', () => {
    // A JavaScript caller can pass anything; the signatures say string.
    const pointer = revoked() as unknown as string;
    for (const call of [
      () => parsePointer(pointer),
      () => comparePointers(pointer, '/a'),
      () => contextToInputPointer(pointer),
    ]) {
      const error = specError(call);
      expect(error.code).toBe('INVALID_PATH');
      expect(error.message).toBe('a JSON pointer must be a string, got unreadable value');
    }
  });

  it('formatPointer, as the list or as a segment', () => {
    const list = specError(() => formatPointer(revoked()));
    expect(list.code).toBe('INVALID_PATH');
    expect(list.message).toMatch(/^JSON pointer segments could not be read: /);
    const segment = revoked() as unknown as string; // a JavaScript caller can pass anything
    expect(specError(() => formatPointer(['a', segment])).message).toBe(
      'segment 1 of a JSON pointer must be a string, got unreadable value',
    );
  });
});

describe('formatPointer', () => {
  it('reads segments by index up to a length read once, never through the iterator', () => {
    const segments = ['a', 'b'];
    Object.defineProperty(segments, Symbol.iterator, {
      value: function* () {
        yield 'evil';
      },
    });
    expect(formatPointer(segments)).toBe('/a/b');

    let lengthReads = 0;
    const counted = new Proxy(['a', 'b'], {
      get(target, key, receiver) {
        if (key === 'length') lengthReads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    expect(formatPointer(counted)).toBe('/a/b');
    expect(lengthReads).toBe(1);
  });

  it('writes segments back, escaping "~" then "/"', () => {
    expect(formatPointer([])).toBe('');
    expect(formatPointer(['a/b', '~c'])).toBe('/a~1b/~0c');
    expect(formatPointer(['~1'])).toBe('/~01');
  });

  it('round-trips with parsePointer', () => {
    const segments = ['a/b', '~', '', '$x', '0'];
    for (const segment of segments) {
      const pointer = formatPointer([segment]);
      expect(formatPointer(parsePointer(pointer))).toBe(pointer);
      expect(parsePointer(pointer)).toEqual([segment]);
    }
    const all = formatPointer(segments);
    expect(all).toBe('/a~1b/~0//$x/0');
    expect(parsePointer(all)).toEqual(segments);
    expect(formatPointer(parsePointer(all))).toBe(all);
  });

  it('refuses a segment that is not a string, or holds a lone surrogate', () => {
    const notStrings = ['a', 7] as unknown as string[]; // a JavaScript caller can pass anything
    expect(specError(() => formatPointer(notStrings)).message).toBe(
      'segment 1 of a JSON pointer must be a string, got number',
    );
    const lone = specError(() => formatPointer(['a', '\udc00']));
    expect(lone.code).toBe('INVALID_PATH');
    expect(lone.message).toBe('segment 1 of a JSON pointer contains a lone UTF-16 surrogate');
  });

  it('turns a hostile list into INVALID_PATH, never a raw error', () => {
    const hostile = new Proxy(['a'], {
      get(target, key, receiver) {
        if (key === '0') throw new Error('trap');
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const error = specError(() => formatPointer(hostile));
    expect(error.code).toBe('INVALID_PATH');
    expect(error.message).toBe('JSON pointer segments could not be read: trap');
    const notAList = 'a' as unknown as string[]; // a JavaScript caller can pass anything
    expect(specError(() => formatPointer(notAList)).message).toBe(
      'JSON pointer segments must be an array of strings',
    );
  });
});

describe('comparePointers', () => {
  it('orders segment by segment: a pointer precedes its descendants', () => {
    expect(['/a-c', '/a/b', '/a', '/b'].sort(comparePointers)).toEqual([
      '/a',
      '/a/b',
      '/a-c',
      '/b',
    ]);
  });

  it('compares decoded segments, not the escaped text (pre-flight I26)', () => {
    // Decoded: "/" 0x2F < "a" 0x61 < "~" 0x7E. The escaped text would give ['/a', '/~0', '/~1'].
    expect(['/~0', '/a', '/~1'].sort(comparePointers)).toEqual(['/~1', '/a', '/~0']);
  });

  it('compares UTF-16 code units, the root first, equal pointers as 0', () => {
    expect(['/｡', '/😀', ''].sort(comparePointers)).toEqual(['', '/😀', '/｡']);
    expect(comparePointers('/a/b', '/a/b')).toBe(0);
    expect(comparePointers('/a', '/a/b')).toBe(-1);
    expect(comparePointers('/b', '/a/b')).toBe(1);
  });

  it('refuses an invalid pointer with INVALID_PATH', () => {
    expect(specError(() => comparePointers('a', '/b')).code).toBe('INVALID_PATH');
    expect(specError(() => comparePointers('/b', '/~')).code).toBe('INVALID_PATH');
  });
});

describe('contextToInputPointer', () => {
  it('maps facts to data and engine dates and dimensions to meta', () => {
    const cases: [JsonPointer, JsonPointer | undefined][] = [
      ['/revenue/total', '/data/revenue/total'],
      ['/$dates/effective', '/meta/dates/effective'],
      ['/$dimensions/pays', '/meta/dimensions/pays'],
      ['/$dates', '/meta/dates'],
      ['/a~1b/~0', '/data/a~1b/~0'],
      ['/x/01', '/data/x/01'],
      ['/$outputs/x', undefined],
      ['/$item/age', undefined],
      ['/$bounds/x', undefined],
      ['', undefined],
    ];
    for (const [context, input] of cases) expect(contextToInputPointer(context)).toBe(input);
  });

  it('refuses "-" anywhere: it is not an index (pre-flight M-26)', () => {
    for (const pointer of ['/x/-', '/-', '/$outputs/-', '/$dates/-']) {
      const error = specError(() => contextToInputPointer(pointer));
      expect(error.code).toBe('INVALID_PATH');
      expect(error.message).toBe(`invalid JSON pointer "${pointer}": '-' is not an index`);
    }
  });

  it('refuses an invalid pointer', () => {
    expect(specError(() => contextToInputPointer('revenue')).code).toBe('INVALID_PATH');
  });
});

describe('both entries', () => {
  it('export the pointer API', () => {
    expect(canonicalEntry.parsePointer).toBe(parsePointer);
    expect(canonicalEntry.formatPointer).toBe(formatPointer);
    expect(canonicalEntry.comparePointers).toBe(comparePointers);
    expect(canonicalEntry.contextToInputPointer).toBe(contextToInputPointer);
  });
});
