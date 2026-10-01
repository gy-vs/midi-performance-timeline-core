import type {
  ImportDiagnostic,
  NoteEvent,
  PerformanceEvent,
  TempoChange,
  TimelineSlice,
  TrackTimeline,
} from "./events.js";
import type { TempoMap } from "./tempo-map.js";
import type { Milliseconds, Ticks } from "./units.js";

export interface MidiTimelineInit {
  readonly format: 0 | 1;
  readonly ticksPerQuarter: number;
  readonly tracks: readonly TrackTimeline[];
  readonly events: readonly PerformanceEvent[];
  readonly notes: readonly NoteEvent[];
  readonly tempoChanges: readonly TempoChange[];
  readonly diagnostics: readonly ImportDiagnostic[];
  readonly durationTicks: Ticks;
  readonly durationMs: Milliseconds;
  readonly tempoMap: TempoMap;
}

/**
 * An immutable, fully resolved performance timeline for one MIDI file.
 *
 * All queries are pure: they never mutate the timeline, and repeated calls
 * with the same arguments return equal results.
 */
export class MidiTimeline {
  readonly format: 0 | 1;
  readonly ticksPerQuarter: number;
  /** Source tracks, in file order. */
  readonly tracks: readonly TrackTimeline[];
  /** All performance events, ordered by `(tick, track, index)`. */
  readonly events: readonly PerformanceEvent[];
  /** All paired notes, ordered by `(startTick, track, order)`. */
  readonly notes: readonly NoteEvent[];
  /** Explicit tempo changes, ordered by `(tick, track, index)`. */
  readonly tempoChanges: readonly TempoChange[];
  /** Non-fatal anomalies found while pairing notes. */
  readonly diagnostics: readonly ImportDiagnostic[];
  readonly durationTicks: Ticks;
  readonly durationMs: Milliseconds;
  readonly tempoMap: TempoMap;

  constructor(init: MidiTimelineInit) {
    this.format = init.format;
    this.ticksPerQuarter = init.ticksPerQuarter;
    this.tracks = Object.freeze([...init.tracks]);
    this.events = Object.freeze([...init.events]);
    this.notes = Object.freeze([...init.notes]);
    this.tempoChanges = Object.freeze([...init.tempoChanges]);
    this.diagnostics = Object.freeze([...init.diagnostics]);
    this.durationTicks = init.durationTicks;
    this.durationMs = init.durationMs;
    this.tempoMap = init.tempoMap;
    Object.freeze(this);
  }

  get trackCount(): number {
    return this.tracks.length;
  }

  /** Millisecond position of a tick, through the merged cross-track tempo map. */
  timeAtTick(tick: Ticks): Milliseconds {
    return this.tempoMap.timeAtTick(tick);
  }

  /** Tick position of a millisecond time; exact inverse of {@link timeAtTick}. */
  tickAtTime(time: Milliseconds): Ticks {
    return this.tempoMap.tickAtTime(time);
  }

  /**
   * Notes sounding at `time`: those with `startMs <= time < endMs`. This is
   * the state a player must restore when seeking to `time`. Returns a fresh
   * array on every call.
   */
  activeNotesAt(time: Milliseconds): readonly NoteEvent[] {
    if (time < 0) {
      throw new RangeError(`time must be >= 0, got ${time}`);
    }
    const notes = this.notes;
    // Partition point: first index whose startMs is greater than `time`.
    let lo = 0;
    let hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid]!.startMs <= time) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    const active: NoteEvent[] = [];
    for (let i = 0; i < lo; i += 1) {
      const note = notes[i]!;
      if (note.endMs > time) {
        active.push(note);
      }
    }
    return active;
  }

  /**
   * Cut the playback range `[startMs, endMs)` out of the timeline. The
   * result's `activeAtStart` lists the notes already sounding at the cut
   * point, so a player can resume mid-note instead of only seeing note-ons
   * that begin inside the range.
   */
  slice(startMs: Milliseconds, endMs: Milliseconds): TimelineSlice {
    if (startMs < 0 || endMs < 0) {
      throw new RangeError(`slice bounds must be >= 0, got [${startMs}, ${endMs}]`);
    }
    if (endMs < startMs) {
      throw new RangeError(`slice end must be >= start, got [${startMs}, ${endMs}]`);
    }
    const activeAtStart = this.activeNotesAt(startMs);
    // An empty range contains no instants, so no note overlaps it — while
    // activeAtStart still reports the state at the cut point itself.
    const notes =
      endMs === startMs
        ? []
        : this.notes.filter((note) => note.startMs < endMs && note.endMs > startMs);
    const events = this.eventsInRange(startMs, endMs);
    return Object.freeze({ startMs, endMs, activeAtStart, notes, events });
  }

  private eventsInRange(startMs: Milliseconds, endMs: Milliseconds): readonly PerformanceEvent[] {
    const events = this.events;
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid]!.timeMs < startMs) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    const result: PerformanceEvent[] = [];
    for (let i = lo; i < events.length; i += 1) {
      const event = events[i]!;
      if (event.timeMs >= endMs) {
        break;
      }
      result.push(event);
    }
    return result;
  }
}
