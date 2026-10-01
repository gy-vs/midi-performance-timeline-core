/**
 * midi-timing-core: a tempo-aware cross-track MIDI performance timeline.
 *
 * The public surface consists of:
 * - {@link loadTimeline} / {@link parseTimeline} — file/byte entry points,
 * - {@link MidiTimeline} — ordered events, paired notes, bidirectional
 *   tick/time mapping, active-note queries and clip extraction,
 * - {@link MidiFormatError} with {@link MidiFormatErrorReason} codes,
 * - branded {@link Tick} / {@link Milliseconds} units.
 */

export { loadTimeline, parseTimeline } from "./timeline.js";
export type {
  MidiTimeline,
  MidiBytes,
  PerformanceEvent,
  NoteOnPerformanceEvent,
  NoteOffPerformanceEvent,
  TempoPerformanceEvent,
  Note,
  ActiveNote,
  ClipNote,
  TimelineClip,
} from "./timeline.js";
export { MidiFormatError } from "./errors.js";
export type { MidiFormatErrorReason } from "./errors.js";
export { ticks, ms } from "./units.js";
export type { Tick, Milliseconds } from "./units.js";
export type { TempoBoundary } from "./tempo-map.js";
export { DEFAULT_MICROSECONDS_PER_BEAT } from "./tempo-map.js";
