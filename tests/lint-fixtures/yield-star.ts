export function* inner(): Generator<number> {
  yield* [1, 2];
}
