import { citeName, newSpecError, unreadableMessage } from '../errors.js';
import { MAX_JSON_VALUES } from '../values.js';

/** Default bound on the nodes of a referential: its code periods, groups and members. */
export const DEFAULT_MAX_REFERENTIAL_NODES = 100_000;
/** Default bound on the nesting of groups: the groups of the longest chain at any date. */
export const DEFAULT_MAX_GROUP_DEPTH = 64;
/** Highest `maxDepth` accepted: deeper nesting has no use and only costs. */
export const MAX_GROUP_DEPTH_CEILING = 1024;
/** Default step budget of the cycle and depth sweep, per node of the referential. */
export const STEPS_PER_NODE = 100;

/**
 * Limits shared by `validateReferential`, `normalizeReferential`, `computeReferentialDigest`,
 * `resolveMembership` and `matchDimension`.
 */
export interface ReferentialLimits {
  /** Most nodes (code periods, groups and members); default 100 000, at most 10 000 000. */
  maxNodes?: number;
  /** Most groups on one chain of nesting at any date; default 64, at most 1 024. */
  maxDepth?: number;
  /**
   * Most elementary steps of the cycle and depth sweep of `validateReferential`. By default
   * 100 per node the referential actually has (code periods, groups and members counted), not
   * per node `maxNodes` allows: a referential's validity and digest never depend on the
   * headroom an integrator configures. Beyond it the referential is refused as too complex
   * (`referential too complex: more than <n> steps`), so that no document can cost minutes of
   * work (at most 10 000 000 steps under the default `maxNodes`). An explicit value overrides
   * the default.
   */
  maxSteps?: number;
}

/** Limits once read and defaulted. */
export interface Limits {
  maxNodes: number;
  maxDepth: number;
  /** The explicit override; `undefined` for 100 per node counted. */
  maxSteps: number | undefined;
}

/**
 * Internal: reads `options` once each. Throws `SpecError` (`INVALID_REFERENTIAL`) for options
 * that are not an object, cannot be read, or hold a value that is not a positive integer, a
 * `maxNodes` above `MAX_JSON_VALUES` (10 000 000), or a `maxDepth` above 1 024.
 */
export function readLimits(options: unknown): Limits {
  if (options === undefined) {
    return {
      maxNodes: DEFAULT_MAX_REFERENTIAL_NODES,
      maxDepth: DEFAULT_MAX_GROUP_DEPTH,
      maxSteps: undefined,
    };
  }
  if (options === null || typeof options !== 'object') {
    throw newSpecError('INVALID_REFERENTIAL', 'options must be an object');
  }
  let maxNodes: unknown;
  let maxDepth: unknown;
  let maxSteps: unknown;
  try {
    maxNodes = Reflect.get(options, 'maxNodes');
    maxDepth = Reflect.get(options, 'maxDepth');
    maxSteps = Reflect.get(options, 'maxSteps');
  } catch (error) {
    throw newSpecError('INVALID_REFERENTIAL', unreadableMessage('options', error));
  }
  const nodes = positive(maxNodes, DEFAULT_MAX_REFERENTIAL_NODES, 'maxNodes');
  if (nodes > MAX_JSON_VALUES) {
    // Every list is read up to its claimed length once the size check passed: the shared
    // budget of values bounds the nodes too.
    throw newSpecError('INVALID_REFERENTIAL', `maxNodes must be at most ${MAX_JSON_VALUES}`);
  }
  const depth = positive(maxDepth, DEFAULT_MAX_GROUP_DEPTH, 'maxDepth');
  if (depth > MAX_GROUP_DEPTH_CEILING) {
    throw newSpecError(
      'INVALID_REFERENTIAL',
      `maxDepth must be at most ${MAX_GROUP_DEPTH_CEILING}`,
    );
  }
  const steps = maxSteps === undefined ? undefined : positive(maxSteps, 0, 'maxSteps');
  return { maxNodes: nodes, maxDepth: depth, maxSteps: steps };
}

function positive(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw newSpecError('INVALID_REFERENTIAL', `${citeName(name)} must be a positive integer`);
  }
  return value;
}
