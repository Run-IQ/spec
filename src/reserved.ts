/**
 * The variables the engine puts in the evaluation context, each read by a pointer
 * (`/$outputs/x`, `/$dates/effective`). Every name that starts with `$` is reserved
 * (`isReservedName`), not only these: an output, a root key of `data` or a dimension cannot use
 * one, so a variable added later never collides with data. Frozen.
 */
export const ENGINE_VARIABLES: readonly string[] = Object.freeze([
  '$outputs',
  '$dates',
  '$dimensions',
  '$item',
  '$index',
  '$params',
  '$selected',
  '$bounds',
  '$parent',
  '$prev',
  '$children',
  '$segment',
  '$group',
  '$ref',
]);

/** True for a name that starts with `$`: reserved for the engine (ruling R36, D-3). */
export function isReservedName(name: string): boolean {
  return typeof name === 'string' && name.startsWith('$');
}
