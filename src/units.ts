/**
 * Branded time units.
 *
 * {@link Tick} and {@link Milliseconds} share the same runtime representation
 * (`number`) but carry distinct nominal brands, so assigning a millisecond
 * value where ticks are expected (or vice versa) is a compile-time error
 * instead of a silent runtime mix-up.
 *
 * The branded constructors ({@link ticks}, {@link ms}) are the only way to
 * create the values; they also validate at the boundary. Internally the
 * timeline produces already-correct units, so callers normally only *read*
 * them.
 */

declare const tickBrand: unique symbol;
declare const msBrand: unique symbol;

/** Integer position measured in PPQ ticks from the start of the file. */
export type Tick = number & { readonly [tickBrand]: true };

/** Position measured in milliseconds from the start of the performance. */
export type Milliseconds = number & { readonly [msBrand]: true };

/**
 * Wrap a number as a {@link Tick}. Throws on non-finite, non-integer or
 * negative input.
 */
export function ticks(value: number): Tick {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `Tick must be a non-negative finite integer, got: ${String(value)}`
    );
  }
  return value as Tick;
}

/**
 * Wrap a number as {@link Milliseconds}. Throws on non-finite or negative
 * input (fractional milliseconds are allowed).
 */
export function ms(value: number): Milliseconds {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `Milliseconds must be a non-negative finite number, got: ${String(value)}`
    );
  }
  return value as Milliseconds;
}

/**
 * Reinterpret an already validated raw value as {@link Tick} without a
 * redundant check. For internal use where the value was derived from trusted
 * MIDI data or arithmetic.
 */
export function tickUnchecked(value: number): Tick {
  return value as Tick;
}
