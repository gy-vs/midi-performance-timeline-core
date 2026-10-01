declare const unitBrand: unique symbol;

/**
 * Absolute position on the MIDI timeline, in ticks, relative to the file's
 * ticks-per-quarter-note resolution.
 *
 * Values produced by {@link MidiTimeline.tickAtTime} may be fractional: a
 * millisecond position can fall between two ticks. Values read from the file
 * itself are always integers.
 *
 * This is a branded `number`: it cannot be mixed with plain numbers or with
 * {@link Milliseconds} without a compile-time error.
 */
export type Ticks = number & { readonly [unitBrand]: "ticks" };

/**
 * Absolute position on the performance timeline, in milliseconds.
 *
 * This is a branded `number`: it cannot be mixed with plain numbers or with
 * {@link Ticks} without a compile-time error.
 */
export type Milliseconds = number & { readonly [unitBrand]: "milliseconds" };

/** Brand a finite number as a tick position. */
export function ticks(value: number): Ticks {
  return brand(value, "ticks") as Ticks;
}

/** Brand a finite number as a millisecond position. */
export function milliseconds(value: number): Milliseconds {
  return brand(value, "milliseconds") as Milliseconds;
}

function brand(value: number, unit: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`Invalid ${unit} value: ${String(value)}`);
  }
  return value;
}
