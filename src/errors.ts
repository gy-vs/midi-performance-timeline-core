/**
 * Machine-readable reasons why {@link MidiFormatError} is thrown.
 */
export type MidiFormatErrorReason =
  /** The bytes are not a valid Standard MIDI File (bad chunk/truncated/etc.). */
  | "invalidFile"
  /** Header uses SMPTE/frames-per-second time division, not PPQ ticks. */
  | "unsupportedTimeDivision"
  /** PPQ division is present but not a positive integer. */
  | "invalidTimeDivision"
  /** MIDI format 2 (independent tracks) is not supported. */
  | "unsupportedFormat"
  /** A setTempo meta event carries an out-of-range microseconds-per-beat. */
  | "invalidTempo"
  /** A noteOff has no matching noteOn on the same track/channel/pitch. */
  | "unmatchedNoteOff"
  /** A noteOn is never closed by a noteOff before the track ends. */
  | "unterminatedNote";

/**
 * Thrown by {@link loadTimeline} / {@link parseTimeline} whenever the input
 * cannot be turned into a timeline under the documented contract.
 *
 * Parsing is all-or-nothing: this error means no usable timeline exists; the
 * caller never receives partially mapped data.
 */
export class MidiFormatError extends Error {
  override readonly name = "MidiFormatError";
  readonly reason: MidiFormatErrorReason;

  constructor(reason: MidiFormatErrorReason, message: string, options?: { cause?: unknown }) {
    super(message);
    this.reason = reason;
    if (options?.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        enumerable: false,
        writable: false,
        configurable: true,
      });
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
