import type { Milliseconds, Ticks } from "./units.js";

/**
 * Where an event sits on the timeline. `tick` and `timeMs` are two views of
 * the same position, related through the file's merged tempo map: every event
 * at the same tick maps to the same `timeMs`, regardless of which track it
 * came from.
 */
export interface EventPosition {
  readonly tick: Ticks;
  readonly timeMs: Milliseconds;
  /** Index of the source track in the file. */
  readonly track: number;
  /** Index of the source event within its track; stable tie-break for events sharing a tick. */
  readonly index: number;
}

/**
 * A channel (performance) event with its absolute position resolved.
 * Deterministically ordered by `(tick, track, index)`.
 */
export type PerformanceEvent = EventPosition &
  (
    | { readonly type: "noteOn"; readonly channel: number; readonly pitch: number; readonly velocity: number }
    | { readonly type: "noteOff"; readonly channel: number; readonly pitch: number; readonly velocity: number }
    | { readonly type: "controlChange"; readonly channel: number; readonly controller: number; readonly value: number }
    | { readonly type: "programChange"; readonly channel: number; readonly program: number }
    | { readonly type: "pitchBend"; readonly channel: number; readonly value: number }
    | { readonly type: "channelAftertouch"; readonly channel: number; readonly amount: number }
    | { readonly type: "polyAftertouch"; readonly channel: number; readonly pitch: number; readonly amount: number }
  );

/**
 * A note-on paired with its note-off, resolved to both tick and millisecond
 * positions. Pairing is scoped to a single `(track, channel, pitch)` triple,
 * so notes on different channels — or different tracks — never merge even
 * when they share a pitch.
 *
 * The note is considered sounding for `startMs <= t < endMs`.
 */
export interface NoteEvent {
  readonly track: number;
  readonly channel: number;
  readonly pitch: number;
  /** Attack velocity of the note-on (1–127). */
  readonly velocity: number;
  /** Release velocity of the paired note-off; 0 when the end was synthesized. */
  readonly offVelocity: number;
  readonly startTick: Ticks;
  readonly endTick: Ticks;
  readonly startMs: Milliseconds;
  readonly endMs: Milliseconds;
  /** Index of the note-on within its track; tie-break when sorting notes. */
  readonly order: number;
}

/** An explicit `setTempo` event from the file, with its position resolved. */
export interface TempoChange extends EventPosition {
  readonly microsecondsPerQuarter: number;
  readonly beatsPerMinute: number;
}

export type DiagnosticKind = "overlapping-note-on" | "unmatched-note-off" | "unterminated-note";

/**
 * A non-fatal anomaly found while pairing notes. Diagnostics never change
 * the deterministic handling: an overlapping note-on closes the previous
 * note, an unmatched note-off is dropped, and an unterminated note is closed
 * at the end of its track.
 */
export interface ImportDiagnostic {
  readonly kind: DiagnosticKind;
  readonly message: string;
  readonly track: number;
  readonly tick: Ticks;
  readonly channel: number | null;
  readonly pitch: number | null;
}

/** One source track with its performance events in file order. */
export interface TrackTimeline {
  readonly index: number;
  readonly name: string | null;
  readonly events: readonly PerformanceEvent[];
}

/**
 * A time range cut out of a timeline. `activeAtStart` carries the notes that
 * are already sounding at `startMs` — the state a player needs when seeking
 * into the middle of a performance.
 */
export interface TimelineSlice {
  readonly startMs: Milliseconds;
  readonly endMs: Milliseconds;
  /** Notes sounding at `startMs` (`startMs` within `[note.startMs, note.endMs)`). */
  readonly activeAtStart: readonly NoteEvent[];
  /** All notes overlapping `[startMs, endMs)`. */
  readonly notes: readonly NoteEvent[];
  /** Performance events positioned in `[startMs, endMs)`. */
  readonly events: readonly PerformanceEvent[];
}
