import { describe, expect, it } from 'vitest';
import { validateRuleDefinition, verifyProof } from '../src/index.js';

const LONE = String.fromCharCode(0xd800);

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

/** An Error whose `message` getter throws. */
function errorWithThrowingMessage(): Error {
  const error = new Error('hidden');
  Object.defineProperty(error, 'message', {
    get() {
      throw new Error('no message');
    },
  });
  return error;
}

const rule = {
  id: 'r1',
  version: 1,
  model: 'FLAT',
  priority: 1,
  effectiveFrom: '2025-01-01',
};

// [label, thrown value, reason as the message must cite it]
const REASONS: [string, unknown, string][] = [
  ['control characters', new Error('bad\nline\ttab'), 'bad\\nline\\ttab'],
  ['a lone surrogate', new Error(`x${LONE}`), 'x\\ud800'],
  ['quotes and backslashes', new Error('a "b" \\ c'), 'a \\"b\\" \\\\ c'],
  ['a 1 MB message', new Error('m'.repeat(1_000_000)), `${'m'.repeat(100)}…`],
  ['a throwing message getter', errorWithThrowingMessage(), 'unreadable value'],
  ['a thrown string', 'plain\nstring', 'plain\\nstring'],
  ['a thrown number', 42, '42'],
  ['a thrown object', { message: 'not an Error' }, 'unreadable value'],
];

describe('unreadable values: the reason is escaped and cut', () => {
  it.each(REASONS)('%s, inside a rule field', (_label, thrown, reason) => {
    const params = throwingAt('rate', thrown);
    expect(validateRuleDefinition({ ...rule, params }).issues).toEqual([
      { path: 'params', message: `params could not be read: ${reason}` },
    ]);
  });

  it.each(REASONS)('%s, at the top of a rule', (_label, thrown, reason) => {
    expect(validateRuleDefinition(throwingAt('params', thrown, rule)).issues).toEqual([
      { path: '', message: `rule definition could not be read: ${reason}` },
    ]);
  });

  it.each(REASONS)('%s, in a proof', (_label, thrown, reason) => {
    const proof = new Proxy(
      {},
      {
        ownKeys() {
          throw thrown;
        },
      },
    );
    expect(verifyProof(proof)).toEqual({
      status: 'invalid',
      issues: [`proof could not be read: ${reason}`],
    });
  });
});
