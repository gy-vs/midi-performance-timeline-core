import { readFileSync } from "node:fs";
import { parseMidi, type MidiData } from "midi-file";
import { MidiFormatError } from "./errors.js";
import { TempoMap, type TempoBoundary } from "./tempo-map.js";
import {
  ms,
  ticks,
  tickUnchecked,
  type Milliseconds,
  type Tick,
} from "./units.js";

/**
 * A note-on / note-off / tempo point on the performance timeline.
 *
 * `order` disambiguates events that share a tick: it is the 0-based position
 * within that tick's group, in the deterministic total order
 * (tick, trackIndex, sourceEventIndex).
 */
interface BaseEvent {
  readonly tick: Tick;
  readonly time: Milliseconds;
  readonly trackIndex: number;
  readonly sourceEventIndex: number;
  readonly order: number;
}

export interface NoteOnPerformanceEvent extends BaseEvent {
  readonly kind: "noteOn";
  readonly channel: number;
  readonly noteNumber: number;
  readonly velocity: number;
  /** Id of the {@link Note} this event starts. */
  readonly noteId: number;
}

export interface NoteOffPerformanceEvent extends BaseEvent {
  readonly kind: "noteOff";
  readonly channel: number;
  readonly noteNumber: number;
  /** Release velocity carried by the noteOff (often 0). */
  readonly velocity: number;
  /** Id of the {@link Note} this event ends. */
  readonly noteId: number;
}

export interface TempoPerformanceEvent extends BaseEvent {
  readonly kind: "tempo";
  /** SMF setTempo value: microseconds per quarter note. */
  readonly microsecondsPerBeat: number;
  /** Same tempo expressed in beats per minute. */
  readonly bpm: number;
}

/**
 * A performance event in absolute-time order. Only events that define the
 * performance (note on/off and tempo changes) are exposed; other SMF meta
 * events do not affect timing semantics.
 */
export type PerformanceEvent =
  | NoteOnPerformanceEvent
  | NoteOffPerformanceEvent
  | TempoPerformanceEvent;

/**
 * A paired note. Pairing follows the SMF channel-voice model: a noteOff ends
 * the most recent still-open noteOn on the same **channel and pitch**
 * (LIFO). Notes on different channels or with different pitches are never
 * merged, even across tracks.
 */
export interface Note {
  readonly id: number;
  readonly channel: number;
  readonly noteNumber: number;
  readonly startTick: Tick;
  readonly endTick: Tick;
  readonly startTime: Milliseconds;
  readonly endTime: Milliseconds;
  readonly startVelocity: number;
  readonly endVelocity: number;
  /** Track containing the noteOn. */
  readonly trackIndex: number;
  /** Track containing the matching noteOff. */
  readonly endTrackIndex: number;
}

/**
 * A note that is currently sounding at a queried position — the state a
 * player must reconstruct after seeking into the middle of the piece.
 */
export interface ActiveNote {
  readonly id: number;
  readonly channel: number;
  readonly noteNumber: number;
  readonly velocity: number;
  readonly startedAtTick: Tick;
  readonly startedAtTime: Milliseconds;
  readonly endsAtTick: Tick;
  readonly endsAtTime: Milliseconds;
  readonly trackIndex: number;
}

/**
 * One note intersected with a clipped time range. Notes that started before
 * the clip start are reported with `preStarted: true` so a player can
 * re-attack them as sustained tones rather than waiting for a noteOn that
 * lies before the clip.
 */
export interface ClipNote {
  readonly id: number;
  readonly channel: number;
  readonly noteNumber: number;
  readonly velocity: number;
  /** Original note start (may precede the clip start). */
  readonly startTick: Tick;
  readonly startTime: Milliseconds;
  readonly endTick: Tick;
  readonly endTime: Milliseconds;
  /** Effective start within the clip (clipped start for pre-started notes). */
  readonly clipStartTick: Tick;
  readonly clipStartTime: Milliseconds;
  readonly clipEndTick: Tick;
  readonly clipEndTime: Milliseconds;
  readonly preStarted: boolean;
  readonly trackIndex: number;
}

export interface TimelineClip {
  /** Requested clip start (milliseconds) and the tick at or before it. */
  readonly startTick: Tick;
  readonly startTime: Milliseconds;
  /** Clip end, clamped to the duration, with the tick at or before it. */
  readonly endTick: Tick;
  readonly endTime: Milliseconds;
  /** Notes still sounding at the clip start whose noteOn precedes it. */
  readonly sustained: readonly ActiveNote[];
  /** All notes sounding at any point inside [start, end), clipped. */
  readonly notes: readonly ClipNote[];
}

/**
 * Read-only performance timeline built from a Standard MIDI File.
 *
 * All queries are pure: the timeline holds no mutable playback position, so
 * querying the same point any number of times yields identical results and
 * never alters internal state.
 */
export interface MidiTimeline {
  /** SMF format (only 0 and 1 are accepted). */
  readonly format: 0 | 1;
  readonly trackCount: number;
  /** Pulses (ticks) per quarter note declared by the file header. */
  readonly ticksPerBeat: number;
  /** Tick of the latest event in the file (end of the last track). */
  readonly durationTick: Tick;
  /** Time of {@link MidiTimeline.durationTick}. */
  readonly duration: Milliseconds;
  /** Performance events in deterministic absolute (tick/time) order. */
  readonly events: readonly PerformanceEvent[];
  /** Paired notes, ordered by start. */
  readonly notes: readonly Note[];
  /** Effective tempo boundaries in force across the piece (seeded with 120 BPM). */
  readonly tempoBoundaries: readonly TempoBoundary[];

  tickToTime(tick: Tick): Milliseconds;
  timeToTick(time: Milliseconds): Tick;

  /**
   * Notes that have started at or before `time` and not ended yet
   * (start <= time < end). Sorted by (start time, id).
   */
  activeNotesAt(time: Milliseconds): readonly ActiveNote[];
  /** Tick-based variant of {@link MidiTimeline.activeNotesAt}. */
  activeNotesAtTick(tick: Tick): readonly ActiveNote[];

  /**
   * Intersect the timeline with [start, end). Notes already sounding before
   * `start` are included in `sustained`; overlapping notes are clipped to
   * the range. `end` is clamped to the duration; it must not precede start.
   */
  clip(start: Milliseconds, end: Milliseconds): TimelineClip;
}

interface RawTempoEvent {
  tick: number;
  microsecondsPerBeat: number;
  trackIndex: number;
  eventIndex: number;
}

interface RawNoteEvent {
  tick: number;
  trackIndex: number;
  eventIndex: number;
  channel: number;
  noteNumber: number;
  velocity: number;
}

interface OrderedNoteEntry {
  kind: "on" | "off";
  event: RawNoteEvent;
}

const MAX_24BIT = 0x00ff_ffff;

/** Stable identity of a source event: absolute tick, track and in-track index. */
function rawKey(tick: number, trackIndex: number, eventIndex: number): string {
  return `${tick}:${trackIndex}:${eventIndex}`;
}

/**
 * Build a timeline directly from a MIDI file on disk.
 *
 * @throws {MidiFormatError} if the file cannot be parsed, uses an
 * unsupported time division/format, or contains inconsistent note events.
 */
export function loadTimeline(path: string | URL): MidiTimeline {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (cause) {
    throw new MidiFormatError("invalidFile", `Could not read MIDI file: ${String(path)}`, {
      cause,
    });
  }
  return parseTimeline(bytes);
}

/** Accepted byte containers for {@link parseTimeline}. */
export type MidiBytes = Uint8Array | ArrayBuffer | ArrayLike<number>;

/**
 * Build a timeline from raw Standard MIDI File bytes.
 *
 * The entry point is all-or-nothing: any contract violation (bad binary,
 * SMPTE time division, format 2, invalid tempo, unmatched noteOff,
 * unterminated note) throws {@link MidiFormatError} and no partially mapped
 * timeline is returned. Binary parsing itself is delegated to the mature
 * `midi-file` library.
 *
 * @throws {MidiFormatError}
 */
export function parseTimeline(input: MidiBytes): MidiTimeline {
  const bytes = toUint8Array(input);

  let midi: MidiData;
  try {
    midi = parseMidi(bytes);
  } catch (cause) {
    throw new MidiFormatError("invalidFile", `MIDI bytes could not be parsed: ${String(cause)}`, {
      cause,
    });
  }

  const header = midi.header;

  if (header.format !== 0 && header.format !== 1) {
    throw new MidiFormatError(
      "unsupportedFormat",
      `MIDI format ${String(header.format)} is not supported (only formats 0 and 1 are).`
    );
  }

  if (header.framesPerSecond !== undefined || header.ticksPerFrame !== undefined) {
    throw new MidiFormatError(
      "unsupportedTimeDivision",
      `SMPTE/frames-per-second time division is not supported (${String(header.framesPerSecond)} fps, ${String(header.ticksPerFrame)} ticks/frame); only PPQ (ticks-per-quarter-note) is.`
    );
  }

  const ppq = header.ticksPerBeat;
  if (ppq === undefined || !Number.isInteger(ppq) || ppq <= 0 || ppq > 0x7fff) {
    throw new MidiFormatError(
      "invalidTimeDivision",
      `Invalid ticks-per-quarter-note division: ${String(ppq)}.`
    );
  }

  if (midi.tracks.length !== header.numTracks) {
    throw new MidiFormatError(
      "invalidFile",
      `Header declares ${String(header.numTracks)} tracks but ${String(midi.tracks.length)} were found.`
    );
  }

  const tempoEvents: RawTempoEvent[] = [];
  const noteOns: RawNoteEvent[] = [];
  const noteOffs: RawNoteEvent[] = [];
  let maxTick = 0;

  // Walk every event in every track. Delta times of event types we do not
  // model still advance the absolute tick position.
  midi.tracks.forEach((track, trackIndex) => {
    let tick = 0;
    track.forEach((event, eventIndex) => {
      tick += event.deltaTime;
      if (tick > maxTick) maxTick = tick;

      if (event.type === "setTempo") {
        const us = event.microsecondsPerBeat;
        if (!Number.isInteger(us) || us < 1 || us > MAX_24BIT) {
          throw new MidiFormatError(
            "invalidTempo",
            `Invalid tempo ${String(us)} us/beat at tick ${String(tick)} (track ${String(trackIndex)}, event ${String(eventIndex)}).`
          );
        }
        tempoEvents.push({ tick, microsecondsPerBeat: us, trackIndex, eventIndex });
      } else if (event.type === "noteOn") {
        noteOns.push({
          tick,
          trackIndex,
          eventIndex,
          channel: event.channel,
          noteNumber: event.noteNumber,
          velocity: event.velocity,
        });
      } else if (event.type === "noteOff") {
        noteOffs.push({
          tick,
          trackIndex,
          eventIndex,
          channel: event.channel,
          noteNumber: event.noteNumber,
          velocity: event.velocity,
        });
      }
    });
  });

  const endTick = ticks(maxTick);
  const tempoMap = new TempoMap(
    ppq,
    tempoEvents.map((e) => ({
      tick: ticks(e.tick),
      microsecondsPerBeat: e.microsecondsPerBeat,
      trackIndex: e.trackIndex,
      eventIndex: e.eventIndex,
    })),
    endTick
  );

  // ---- Pair noteOn/noteOff in the deterministic global total order. ----
  const orderedNoteEntries: OrderedNoteEntry[] = [
    ...noteOns.map((event) => ({ kind: "on" as const, event })),
    ...noteOffs.map((event) => ({ kind: "off" as const, event })),
  ].sort((a, b) => compareSourcePosition(a.event, b.event));

  // Stacks of open noteOn entries keyed by the exact (channel, pitch) voice.
  const open = new Map<number, OrderedNoteEntry[]>();
  interface Paired {
    on: OrderedNoteEntry;
    off: OrderedNoteEntry;
  }
  const pairs: Paired[] = [];

  orderedNoteEntries.forEach((entry) => {
    const e = entry.event;
    const key = e.channel * 128 + e.noteNumber;
    if (entry.kind === "on") {
      let stack = open.get(key);
      if (stack === undefined) {
        stack = [];
        open.set(key, stack);
      }
      stack.push(entry);
    } else {
      const stack = open.get(key);
      const on = stack === undefined ? undefined : stack.pop();
      if (on === undefined) {
        throw new MidiFormatError(
          "unmatchedNoteOff",
          `noteOff for channel ${String(e.channel)} note ${String(e.noteNumber)} at tick ${String(e.tick)} (track ${String(e.trackIndex)}) has no preceding noteOn.`
        );
      }
      pairs.push({ on, off: entry });
    }
  });

  for (const [key, stack] of open) {
    const leftover = stack[stack.length - 1];
    if (leftover !== undefined) {
      throw new MidiFormatError(
        "unterminatedNote",
        `noteOn for channel ${String(Math.floor(key / 128))} note ${String(key % 128)} at tick ${String(leftover.event.tick)} (track ${String(leftover.event.trackIndex)}) has no noteOff before the end of the file.`
      );
    }
  }

  // Note ids follow noteOn order (the same total order as the event list).
  pairs.sort((a, b) => compareSourcePosition(a.on.event, b.on.event));

  const notes: Note[] = pairs.map((p, id) => {
    const startTick = ticks(p.on.event.tick);
    const endTick = ticks(p.off.event.tick);
    return {
      id,
      channel: p.on.event.channel,
      noteNumber: p.on.event.noteNumber,
      startTick,
      endTick,
      startTime: tempoMap.tickToTime(startTick),
      endTime: tempoMap.tickToTime(endTick),
      startVelocity: p.on.event.velocity,
      endVelocity: p.off.event.velocity,
      trackIndex: p.on.event.trackIndex,
      endTrackIndex: p.off.event.trackIndex,
    };
  });

  // Source-event key -> paired note id, for both the on and the off event.
  const noteIdByKey = new Map<string, number>();
  pairs.forEach((p, id) => {
    noteIdByKey.set(
      rawKey(p.on.event.tick, p.on.event.trackIndex, p.on.event.eventIndex),
      id
    );
    noteIdByKey.set(
      rawKey(p.off.event.tick, p.off.event.trackIndex, p.off.event.eventIndex),
      id
    );
  });

  // ---- Assemble the full ordered performance event list. ----
  interface EventPosition {
    tick: number;
    trackIndex: number;
    eventIndex: number;
  }
  const eventPositions: EventPosition[] = [];
  for (const e of tempoEvents) {
    eventPositions.push({ tick: e.tick, trackIndex: e.trackIndex, eventIndex: e.eventIndex });
  }
  for (const entry of orderedNoteEntries) {
    const e = entry.event;
    eventPositions.push({ tick: e.tick, trackIndex: e.trackIndex, eventIndex: e.eventIndex });
  }
  eventPositions.sort((a, b) =>
    a.tick !== b.tick
      ? a.tick - b.tick
      : a.trackIndex !== b.trackIndex
        ? a.trackIndex - b.trackIndex
        : a.eventIndex - b.eventIndex
  );

  const tempoByKey = new Map<string, RawTempoEvent>();
  for (const e of tempoEvents) {
    tempoByKey.set(rawKey(e.tick, e.trackIndex, e.eventIndex), e);
  }
  const noteEntryByKey = new Map<string, OrderedNoteEntry>();
  for (const entry of orderedNoteEntries) {
    const e = entry.event;
    noteEntryByKey.set(rawKey(e.tick, e.trackIndex, e.eventIndex), entry);
  }

  const events: PerformanceEvent[] = [];
  let lastTick = -1;
  let orderAtTick = 0;
  for (const pos of eventPositions) {
    if (pos.tick === lastTick) {
      orderAtTick += 1;
    } else {
      lastTick = pos.tick;
      orderAtTick = 0;
    }
    const tick = tickUnchecked(pos.tick);
    const time = tempoMap.tickToTime(tick);
    const key = rawKey(pos.tick, pos.trackIndex, pos.eventIndex);

    const tempo = tempoByKey.get(key);
    if (tempo !== undefined) {
      events.push({
        kind: "tempo",
        tick,
        time,
        trackIndex: pos.trackIndex,
        sourceEventIndex: pos.eventIndex,
        order: orderAtTick,
        microsecondsPerBeat: tempo.microsecondsPerBeat,
        bpm: 60_000_000 / tempo.microsecondsPerBeat,
      });
      continue;
    }

    const entry = noteEntryByKey.get(key)!;
    const e = entry.event;
    events.push({
      kind: entry.kind === "on" ? "noteOn" : "noteOff",
      tick,
      time,
      trackIndex: pos.trackIndex,
      sourceEventIndex: pos.eventIndex,
      order: orderAtTick,
      channel: e.channel,
      noteNumber: e.noteNumber,
      velocity: e.velocity,
      noteId: noteIdByKey.get(key)!,
    });
  }

  return new TimelineImpl(header.format, midi.tracks.length, ppq, endTick, tempoMap, events, notes);
}

function compareSourcePosition(a: RawNoteEvent, b: RawNoteEvent): number {
  if (a.tick !== b.tick) return a.tick - b.tick;
  if (a.trackIndex !== b.trackIndex) return a.trackIndex - b.trackIndex;
  return a.eventIndex - b.eventIndex;
}

class TimelineImpl implements MidiTimeline {
  readonly format: 0 | 1;
  readonly trackCount: number;
  readonly ticksPerBeat: number;
  readonly durationTick: Tick;
  readonly duration: Milliseconds;
  readonly events: readonly PerformanceEvent[];
  readonly notes: readonly Note[];
  readonly tempoBoundaries: readonly TempoBoundary[];
  private readonly tempoMap: TempoMap;

  constructor(
    format: 0 | 1,
    trackCount: number,
    ticksPerBeat: number,
    durationTick: Tick,
    tempoMap: TempoMap,
    events: readonly PerformanceEvent[],
    notes: readonly Note[]
  ) {
    this.format = format;
    this.trackCount = trackCount;
    this.ticksPerBeat = ticksPerBeat;
    this.durationTick = durationTick;
    this.duration = tempoMap.endTime;
    this.tempoMap = tempoMap;
    this.events = Object.freeze(events.map((e) => deepFreeze(e)));
    this.notes = Object.freeze(notes.map((n) => deepFreeze(n)));
    this.tempoBoundaries = Object.freeze(tempoMap.boundaries.map((b) => deepFreeze(b)));
    Object.freeze(this);
  }

  tickToTime(tick: Tick): Milliseconds {
    assertFiniteNonNegative(tick, "tick");
    return this.tempoMap.tickToTime(tick);
  }

  timeToTick(time: Milliseconds): Tick {
    assertFiniteNonNegative(time, "time");
    return this.tempoMap.timeToTick(time);
  }

  activeNotesAt(time: Milliseconds): readonly ActiveNote[] {
    assertFiniteNonNegative(time, "time");
    return this.activeNotesAtTick(this.tempoMap.timeToTick(time));
  }

  activeNotesAtTick(tick: Tick): readonly ActiveNote[] {
    assertFiniteNonNegative(tick, "tick");
    // Notes are ordered by start; take the prefix started at/before tick,
    // then keep those not yet released (half-open: end == tick is released).
    const result: ActiveNote[] = [];
    for (const note of this.notes) {
      if (note.startTick > tick) break;
      if (note.endTick > tick) {
        result.push(deepFreeze(toActiveNote(note)));
      }
    }
    return Object.freeze(result);
  }

  clip(start: Milliseconds, end: Milliseconds): TimelineClip {
    assertFiniteNonNegative(start, "start");
    assertFiniteNonNegative(end, "end");
    if (!(end >= start)) {
      throw new RangeError(`clip end (${String(end)}) must not precede start (${String(start)})`);
    }

    const startTick = this.tempoMap.timeToTick(start);
    const clippedEnd = ms(Math.min(end, this.duration));
    const endTick = this.tempoMap.timeToTick(clippedEnd);

    const sustained: ActiveNote[] = [];
    const clipNotes: ClipNote[] = [];

    for (const note of this.notes) {
      // Half-open intersection in true time: [start, end). Notes are sorted
      // by start, which is monotonically non-decreasing in time as well.
      if (note.startTime >= clippedEnd) break;
      if (note.endTime <= start) continue;

      const preStarted = note.startTime < start;
      if (preStarted) {
        sustained.push(deepFreeze(toActiveNote(note)));
      }

      const clipStartTick = preStarted ? startTick : note.startTick;
      const clipEndTick = note.endTick <= endTick ? note.endTick : endTick;
      clipNotes.push(
        deepFreeze({
          id: note.id,
          channel: note.channel,
          noteNumber: note.noteNumber,
          velocity: note.startVelocity,
          startTick: note.startTick,
          startTime: note.startTime,
          endTick: note.endTick,
          endTime: note.endTime,
          clipStartTick,
          clipStartTime: preStarted ? start : note.startTime,
          clipEndTick,
          clipEndTime: note.endTick <= endTick ? note.endTime : clippedEnd,
          preStarted,
          trackIndex: note.trackIndex,
        })
      );
    }

    return deepFreeze({
      startTick,
      startTime: start,
      endTick,
      endTime: clippedEnd,
      sustained: Object.freeze(sustained),
      notes: Object.freeze(clipNotes),
    });
  }
}

function toActiveNote(note: Note): ActiveNote {
  return {
    id: note.id,
    channel: note.channel,
    noteNumber: note.noteNumber,
    velocity: note.startVelocity,
    startedAtTick: note.startTick,
    startedAtTime: note.startTime,
    endsAtTick: note.endTick,
    endsAtTime: note.endTime,
    trackIndex: note.trackIndex,
  };
}

function toUint8Array(input: MidiBytes): Uint8Array {
  if (input instanceof Uint8Array) {
    return new Uint8Array(input);
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input.slice(0));
  }
  if (input !== null && typeof input === "object" && typeof input.length === "number") {
    const out = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) {
      out[i] = input[i]!;
    }
    return out;
  }
  throw new MidiFormatError(
    "invalidFile",
    "MIDI input must be Uint8Array, ArrayBuffer or an array-like of byte values."
  );
}

function assertFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number, got ${String(value)}`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== null && typeof child === "object" && !Object.isFrozen(child)) {
        deepFreeze(child);
      }
    }
    Object.freeze(value);
  }
  return value;
}
