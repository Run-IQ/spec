import { SpecError, quoteText, unreadableMessage } from '../errors.js';
import { hasLoneSurrogate } from '../values.js';

/**
 * A JSON Pointer (RFC 6901): `""` is the root, every other pointer is `/` followed by segments
 * separated by `/`, where `~0` stands for `~` and `~1` for `/`.
 *
 * Run-IQ reads (`listVariables`, missing facts, facts read, assertion keys) are pointers into the
 * evaluation context (`/revenue/total`, `/$outputs/risk`, `/$dates/effective`); proof leaves are
 * pointers into the proof input (`/data/…`, `/meta/…`); `contextToInputPointer` links the two.
 *
 * A list element is named by its index written `0|[1-9][0-9]*`: `/x/01` is a valid pointer,
 * but names no list element (the fact is absent). `-` (RFC 6901's "past the end") is refused
 * in reads (`INVALID_PATH`). Segments are compared as they are, without Unicode normalization:
 * two spellings of "é" are two facts.
 */
export type JsonPointer = string;

/**
 * The segments of `pointer`, decoded: `parsePointer('/a~1b/~0c')` is `['a/b', '~c']`,
 * `parsePointer('')` is `[]`. Throws `SpecError` (`INVALID_PATH`), whose message cites the text,
 * when `pointer` is not a string, is not empty and does not start with `/`, has a `~` not
 * followed by `0` or `1`, or holds a lone UTF-16 surrogate.
 */
export function parsePointer(pointer: string): string[] {
  if (typeof pointer !== 'string') {
    throw new SpecError(
      'INVALID_PATH',
      `a JSON pointer must be a string, got ${typeName(pointer)}`,
    );
  }
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) invalidPointer(pointer, 'must be empty or start with "/"');
  if (/~(?![01])/.test(pointer)) invalidPointer(pointer, '"~" must be followed by 0 or 1');
  if (hasLoneSurrogate(pointer)) invalidPointer(pointer, 'contains a lone UTF-16 surrogate');
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/**
 * The pointer of `segments`, `~` written `~0` and `/` written `~1`; `formatPointer([])` is `""`.
 * `formatPointer(parsePointer(p)) === p` for every valid `p`. Throws `SpecError`
 * (`INVALID_PATH`) when `segments` is not an array of strings, cannot be read (a Proxy, a
 * throwing getter), or a segment holds a lone UTF-16 surrogate.
 */
export function formatPointer(segments: readonly string[]): JsonPointer {
  if (!Array.isArray(segments)) {
    throw new SpecError('INVALID_PATH', 'JSON pointer segments must be an array of strings');
  }
  let items: unknown[];
  try {
    items = Array.from(segments as readonly unknown[]);
  } catch (error) {
    throw new SpecError('INVALID_PATH', unreadableMessage('JSON pointer segments', error));
  }
  let out = '';
  items.forEach((segment, i) => {
    if (typeof segment !== 'string') {
      throw new SpecError(
        'INVALID_PATH',
        `segment ${i} of a JSON pointer must be a string, got ${typeName(segment)}`,
      );
    }
    if (hasLoneSurrogate(segment)) {
      throw new SpecError(
        'INVALID_PATH',
        `segment ${i} of a JSON pointer contains a lone UTF-16 surrogate`,
      );
    }
    out += `/${segment.replace(/~/g, '~0').replace(/\//g, '~1')}`;
  });
  return out;
}

/**
 * Orders two pointers: their DECODED segments are compared one by one in UTF-16 code units, and
 * a pointer comes before its descendants (`/a` < `/a/b` < `/a-c`). Comparing the escaped text
 * would put `/~0` (`~`) before `/~1` (`/`), which is wrong. Returns -1, 0 or 1. Throws
 * `SpecError` (`INVALID_PATH`) for an invalid pointer.
 */
export function comparePointers(a: JsonPointer, b: JsonPointer): number {
  const left = parsePointer(a);
  const right = parsePointer(b);
  for (let i = 0; ; i++) {
    const x = left[i];
    const y = right[i];
    // The shorter pointer, a prefix of the other, comes first.
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
}

/** Engine variables that read the proof input, and where. */
const INPUT_VARIABLES: Readonly<Record<string, string>> = {
  $dates: 'dates',
  $dimensions: 'dimensions',
};

/**
 * The proof-input pointer of a context pointer: a fact `/x/y` is `/data/x/y`, a named date
 * `/$dates/n` is `/meta/dates/n`, a dimension `/$dimensions/k` is `/meta/dimensions/k`. Any
 * other engine variable (`/$outputs/…`, `/$item/…`) and the root are not in the input:
 * `undefined`. Throws `SpecError` (`INVALID_PATH`) for an invalid pointer, and for a `-`
 * segment (`'-' is not an index`).
 */
export function contextToInputPointer(pointer: JsonPointer): JsonPointer | undefined {
  const segments = parsePointer(pointer);
  if (segments.includes('-')) invalidPointer(pointer, "'-' is not an index");
  const [head, ...rest] = segments;
  if (head === undefined) return undefined;
  if (!head.startsWith('$')) return formatPointer(['data', ...segments]);
  const field = Object.hasOwn(INPUT_VARIABLES, head) ? INPUT_VARIABLES[head] : undefined;
  return field === undefined ? undefined : formatPointer(['meta', field, ...rest]);
}

/** Internal: the type of `value` as a message writes it (`array` and `null` apart). */
export function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function invalidPointer(pointer: string, why: string): never {
  throw new SpecError('INVALID_PATH', `invalid JSON pointer ${quoteText(pointer)}: ${why}`);
}
