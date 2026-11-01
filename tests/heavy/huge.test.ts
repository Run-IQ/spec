import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  computeIdempotencyDigest,
  computeInputDigest,
  inputLeafHash,
  UNSALTED_SEED,
  validateProofInput,
} from '../../src/index.js';
import type { ProofInput } from '../../src/index.js';
import { specError } from '../helpers.js';
import { hex, nodeHmac, nodeInputDigest, referenceRoot } from '../hashing.js';

/**
 * Values whose canonical text is longer than a JavaScript string can be (V8: 2^29 - 24 code
 * units): every digest hashes the text as it is written (I1), and its value is checked against
 * an oracle that feeds `node:crypto` the same bytes in pieces, built by hand.
 */

const META = { tenantId: 't', dates: {}, tags: [], dimensions: {}, context: {}, assertions: {} };
/** The leaves of `META`, in order, with their content (D-15). */
const META_LEAVES: [string, string][] = [
  ['/meta/assertions', '["object"]'],
  ['/meta/context', '["object"]'],
  ['/meta/dates', '["object"]'],
  ['/meta/dimensions', '["object"]'],
  ['/meta/tags', '["array",0]'],
  ['/meta/tenantId', '["value","t"]'],
];
const META_TEXT =
  '"meta":{"assertions":{},"context":{},"dates":{},"dimensions":{},"tags":[],"tenantId":"t"}';
const TAG = 'run-iq.input/1';

/** sha256 by `node:crypto` of `parts`, each given whole to `update` (texts in UTF-8). */
function oracle(parts: readonly (string | Uint8Array)[]): Uint8Array {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
}

/**
 * The leaf hash of `content` (given in pieces) at `pointer`, unsalted, by the oracle (D-15):
 * its commitment over its value salt and content, then the leaf over its salt, the hash of its
 * pointer in JCS and that commitment.
 */
function oracleLeaf(pointer: string, content: readonly string[]): Uint8Array {
  const valueSalt = nodeHmac(UNSALTED_SEED, `value:${pointer}`);
  const commitment = oracle([Uint8Array.of(3), TAG, Uint8Array.of(0), valueSalt, ...content]);
  const salt = nodeHmac(UNSALTED_SEED, `input:${pointer}`);
  return oracle([
    Uint8Array.of(0),
    TAG,
    Uint8Array.of(0),
    salt,
    commitment,
    JSON.stringify(pointer),
  ]);
}

/** The unsalted input digest of `data` (its keys sorted, each holding `text`), by the oracle. */
function oracleInputDigest(keys: readonly string[], text: string): string {
  const data = keys.map((key) => oracleLeaf(`/data/${key}`, ['["value","', text, '"]']));
  const meta = META_LEAVES.map(([pointer, content]) => oracleLeaf(pointer, [content]));
  const leaves = [...data, ...meta];
  return nodeInputDigest(leaves.length, referenceRoot(leaves));
}

/** The idempotency digest of `{ input, options: {} }`, by the oracle. */
function oracleIdempotency(keys: readonly string[], text: string): string {
  const parts: string[] = ['{"input":{"data":{'];
  keys.forEach((key, i) => parts.push(`${i === 0 ? '' : ','}"${key}":"`, text, '"'));
  parts.push(`},${META_TEXT}},"options":{}}`);
  return hex(oracle(parts));
}

const TOO_LONG =
  'Value at "(root)" cannot be serialized to canonical JSON: too long to write as one string';

describe('digests of a value whose canonical text no string can hold (I1)', () => {
  it('five keys sharing one text of 120 000 000 code units', () => {
    const text = 'a'.repeat(120_000_000);
    const keys = ['a', 'b', 'c', 'd', 'e'];
    const input: ProofInput = { data: Object.fromEntries(keys.map((k) => [k, text])), meta: META };
    expect(validateProofInput(input)).toEqual([]);
    expect(specError(() => canonicalize(input))).toMatchObject({
      code: 'NON_SERIALIZABLE',
      message: TOO_LONG,
    });
    expect(computeIdempotencyDigest({ input, options: {} })).toBe(oracleIdempotency(keys, text));
    expect(computeInputDigest(input, UNSALTED_SEED)).toBe(oracleInputDigest(keys, text));
  }, 180_000);

  it('one value of 2^29 - 34 code units: it exists, is valid and is digested', () => {
    const text = 'a'.repeat(2 ** 29 - 34);
    expect(text).toHaveLength(536_870_878);
    const input: ProofInput = { data: { a: text }, meta: META };
    expect(validateProofInput(input)).toEqual([]);
    expect(specError(() => canonicalize(input))).toMatchObject({
      code: 'NON_SERIALIZABLE',
      message: TOO_LONG,
    });
    expect(computeInputDigest(input, UNSALTED_SEED)).toBe(oracleInputDigest(['a'], text));
    const salt = hex(nodeHmac(UNSALTED_SEED, 'input:/data/a'));
    const valueSalt = hex(nodeHmac(UNSALTED_SEED, 'value:/data/a'));
    const leaf = { pointer: '/data/a', kind: 'value' as const, value: text, salt, valueSalt };
    expect(hex(inputLeafHash(leaf))).toBe(hex(oracleLeaf('/data/a', ['["value","', text, '"]'])));
    expect(computeIdempotencyDigest({ input, options: {} })).toBe(oracleIdempotency(['a'], text));
  }, 180_000);
});
