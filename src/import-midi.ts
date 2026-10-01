import { parseMidi, type MidiData, type MidiEvent } from "midi-file";
import { MalformedMidiError, UnsupportedFormatError, UnsupportedTimeBaseError } from "./errors.js";
import type {
  ImportDiagnostic,
  NoteEvent,
  PerformanceEvent,
  TempoChange,
  TrackTimeline,
} from "./events.js";
import { TempoMap, type TempoEventInput } from "./tempo-map.js";
import { MidiTimeline } from "./timeline.js";
import { ticks, type Milliseconds } from "./units.js";

/**
 * Import a Standard MIDI File from its raw bytes and build a fully resolved
 * performance timeline.
 *
 * The file's binary structure is decoded by the `midi-file` library; this
 * function layers the cross-track time semantics on top: tempo events from
 * every track are merged into a single tempo map, each track's delta ticks
 * are accumulated independently, and only then is every event mapped to
 * milliseconds through the shared map.
 *
 * The contract is all-or-nothing: unsupported formats, unsupported time
 * bases (SMPTE) and corrupt input throw a {@link MidiImportError} subclass;
 * no partial timeline is ever returned.
 */
export function importMidi(bytes: ArrayLike<number>): MidiTimeline {
  const data = parse(bytes);
  const ticksPerQuarter = validateHeader(data);
  const collected = collectAbsoluteEvents(data);
  const tempoMap = TempoMap.build(ticksPerQuarter, collected.tempoEvents);
  return assembleTimeline(data, ticksPerQuarter, collected, tempoMap);
}

function parse(bytes: ArrayLike<number>): MidiData {
  if (bytes === null || bytes === undefined || typeof bytes.length !== "number") {
    throw new MalformedMidiError("importMidi expects the file contents as a byte array");
  }
  try {
    return parseMidi(bytes);
  } catch (cause) {
    throw new MalformedMidiError("input is not a parseable Standard MIDI File", { cause });
  }
}

function validateHeader(data: MidiData): number {
  const { header } = data;
  if (header.format !== 0 && header.format !== 1) {
    throw new UnsupportedFormatError(
      `SMF format ${String(header.format)} is not supported; only formats 0 and 1 can be imported`,
    );
  }
  const ticksPerQuarter = header.ticksPerBeat;
  if (
    typeof ticksPerQuarter !== "number" ||
    !Number.isFinite(ticksPerQuarter) ||
    ticksPerQuarter <= 0
  ) {
    const detail =
      header.framesPerSecond !== undefined
        ? `SMPTE ${header.framesPerSecond} fps / ${String(header.ticksPerFrame)} ticks per frame`
        : "unrecognized time division";
    throw new UnsupportedTimeBaseError(
      `unsupported time base (${detail}); only PPQ (ticks per quarter note) files can be imported`,
    );
  }
  if (data.tracks.length !== header.numTracks) {
    throw new MalformedMidiError(
      `truncated file: header declares ${header.numTracks} track(s) but only ${data.tracks.length} could be read`,
    );
  }
  return ticksPerQuarter;
}

interface PositionedEvent {
  readonly track: number;
  readonly index: number;
  readonly tick: number;
  readonly event: MidiEvent;
}

interface PendingNote {
  readonly channel: number;
  readonly pitch: number;
  readonly velocity: number;
  readonly startTick: number;
  /** Index of the note-on within its track. */
  readonly order: number;
}

interface RawNote extends PendingNote {
  readonly track: number;
  readonly endTick: number;
  readonly offVelocity: number;
}

interface CollectedEvents {
  readonly tempoEvents: TempoEventInput[];
  readonly positioned: PositionedEvent[];
  readonly rawNotes: RawNote[];
  readonly diagnostics: ImportDiagnostic[];
  readonly trackNames: (string | null)[];
  readonly durationTicks: number;
}

/**
 * First pass: accumulate each track's delta times into absolute ticks and
 * pair note-ons with note-offs per `(track, channel, pitch)`. No millisecond
 * values exist yet — they are all derived from the merged tempo map in the
 * second pass, which is what keeps same-tick events on different tracks
 * perfectly aligned.
 */
function collectAbsoluteEvents(data: MidiData): CollectedEvents {
  const tempoEvents: TempoEventInput[] = [];
  const positioned: PositionedEvent[] = [];
  const rawNotes: RawNote[] = [];
  const diagnostics: ImportDiagnostic[] = [];
  const trackNames: (string | null)[] = [];
  let durationTicks = 0;

  data.tracks.forEach((trackEvents, trackIndex) => {
    let absoluteTick = 0;
    let trackName: string | null = null;
    const pending = new Map<number, PendingNote>();

    trackEvents.forEach((event, index) => {
      if (!Number.isFinite(event.deltaTime) || event.deltaTime < 0) {
        throw new MalformedMidiError(
          `corrupt event #${index} on track ${trackIndex}: invalid delta time ${String(event.deltaTime)}`,
        );
      }
      absoluteTick += event.deltaTime;

      switch (event.type) {
        case "setTempo": {
          const mpq = event.microsecondsPerBeat;
          if (!Number.isFinite(mpq) || mpq <= 0) {
            throw new MalformedMidiError(
              `corrupt setTempo event on track ${trackIndex} at tick ${absoluteTick}: invalid microseconds per quarter ${String(mpq)}`,
            );
          }
          tempoEvents.push({
            tick: absoluteTick,
            microsecondsPerQuarter: mpq,
            track: trackIndex,
            index,
          });
          break;
        }
        case "trackName": {
          if (trackName === null) {
            trackName = event.text;
          }
          break;
        }
        case "noteOn":
        case "noteOff": {
          const { channel, noteNumber, velocity } = event;
          requireFinite(channel, "channel", trackIndex, index);
          requireFinite(noteNumber, "note number", trackIndex, index);
          requireFinite(velocity, "velocity", trackIndex, index);
          positioned.push({ track: trackIndex, index, tick: absoluteTick, event });

          const key = channel * 128 + noteNumber;
          const isOff = event.type === "noteOff" || velocity === 0;
          if (isOff) {
            const open = pending.get(key);
            if (open !== undefined) {
              pending.delete(key);
              rawNotes.push({ ...open, track: trackIndex, endTick: absoluteTick, offVelocity: velocity });
            } else {
              diagnostics.push({
                kind: "unmatched-note-off",
                message: `note-off for channel ${channel} pitch ${noteNumber} at tick ${absoluteTick} has no matching note-on; ignored`,
                track: trackIndex,
                tick: ticks(absoluteTick),
                channel,
                pitch: noteNumber,
              });
            }
          } else {
            const open = pending.get(key);
            if (open !== undefined) {
              rawNotes.push({ ...open, track: trackIndex, endTick: absoluteTick, offVelocity: 0 });
              diagnostics.push({
                kind: "overlapping-note-on",
                message: `overlapping note-on for channel ${channel} pitch ${noteNumber} at tick ${absoluteTick}; previous note closed`,
                track: trackIndex,
                tick: ticks(absoluteTick),
                channel,
                pitch: noteNumber,
              });
            }
            pending.set(key, {
              channel,
              pitch: noteNumber,
              velocity,
              startTick: absoluteTick,
              order: index,
            });
          }
          break;
        }
        case "controller":
        case "programChange":
        case "pitchBend":
        case "channelAftertouch":
        case "noteAftertouch": {
          positioned.push({ track: trackIndex, index, tick: absoluteTick, event });
          break;
        }
        default:
          // Remaining meta and sysex events carry no performance timing
          // semantics for this kernel and are not part of the timeline.
          break;
      }
    });

    for (const open of pending.values()) {
      rawNotes.push({ ...open, track: trackIndex, endTick: absoluteTick, offVelocity: 0 });
      diagnostics.push({
        kind: "unterminated-note",
        message: `note on channel ${open.channel} pitch ${open.pitch} starting at tick ${open.startTick} has no note-off; closed at end of track ${trackIndex} (tick ${absoluteTick})`,
        track: trackIndex,
        tick: ticks(open.startTick),
        channel: open.channel,
        pitch: open.pitch,
      });
    }

    trackNames.push(trackName);
    durationTicks = Math.max(durationTicks, absoluteTick);
  });

  return { tempoEvents, positioned, rawNotes, diagnostics, trackNames, durationTicks };
}

function assembleTimeline(
  data: MidiData,
  ticksPerQuarter: number,
  collected: CollectedEvents,
  tempoMap: TempoMap,
): MidiTimeline {
  const timeAt = (tick: number): Milliseconds => tempoMap.timeAtTick(ticks(tick));

  const events: PerformanceEvent[] = collected.positioned.map((positioned) =>
    Object.freeze(toPerformanceEvent(positioned, timeAt(positioned.tick))),
  );
  events.sort((a, b) => a.tick - b.tick || a.track - b.track || a.index - b.index);

  const notes: NoteEvent[] = collected.rawNotes.map((raw) =>
    Object.freeze({
      track: raw.track,
      channel: raw.channel,
      pitch: raw.pitch,
      velocity: raw.velocity,
      offVelocity: raw.offVelocity,
      startTick: ticks(raw.startTick),
      endTick: ticks(raw.endTick),
      startMs: timeAt(raw.startTick),
      endMs: timeAt(raw.endTick),
      order: raw.order,
    }),
  );
  notes.sort((a, b) => a.startTick - b.startTick || a.track - b.track || a.order - b.order);

  const tempoChanges: TempoChange[] = [...collected.tempoEvents]
    .sort((a, b) => a.tick - b.tick || a.track - b.track || a.index - b.index)
    .map((tempo) =>
      Object.freeze({
        tick: ticks(tempo.tick),
        timeMs: timeAt(tempo.tick),
        track: tempo.track,
        index: tempo.index,
        microsecondsPerQuarter: tempo.microsecondsPerQuarter,
        beatsPerMinute: 60_000_000 / tempo.microsecondsPerQuarter,
      }),
    );

  const tracks: TrackTimeline[] = data.tracks.map((_, trackIndex) =>
    Object.freeze({
      index: trackIndex,
      name: collected.trackNames[trackIndex] ?? null,
      events: Object.freeze(events.filter((event) => event.track === trackIndex)),
    }),
  );

  const durationTicks = ticks(collected.durationTicks);
  return new MidiTimeline({
    format: data.header.format as 0 | 1,
    ticksPerQuarter,
    tracks,
    events,
    notes,
    tempoChanges,
    diagnostics: collected.diagnostics.map((diagnostic) => Object.freeze(diagnostic)),
    durationTicks,
    durationMs: tempoMap.timeAtTick(durationTicks),
    tempoMap,
  });
}

function toPerformanceEvent(positioned: PositionedEvent, timeMs: Milliseconds): PerformanceEvent {
  const base = {
    tick: ticks(positioned.tick),
    timeMs,
    track: positioned.track,
    index: positioned.index,
  };
  const { event } = positioned;
  switch (event.type) {
    case "noteOn":
      return { ...base, type: "noteOn", channel: event.channel, pitch: event.noteNumber, velocity: event.velocity };
    case "noteOff":
      return { ...base, type: "noteOff", channel: event.channel, pitch: event.noteNumber, velocity: event.velocity };
    case "controller":
      return { ...base, type: "controlChange", channel: event.channel, controller: event.controllerType, value: event.value };
    case "programChange":
      return { ...base, type: "programChange", channel: event.channel, program: event.programNumber };
    case "pitchBend":
      return { ...base, type: "pitchBend", channel: event.channel, value: event.value };
    case "channelAftertouch":
      return { ...base, type: "channelAftertouch", channel: event.channel, amount: event.amount };
    case "noteAftertouch":
      return { ...base, type: "polyAftertouch", channel: event.channel, pitch: event.noteNumber, amount: event.amount };
    default:
      throw new MalformedMidiError(
        `unexpected event type ${String((event as MidiEvent).type)} in performance track ${positioned.track}`,
      );
  }
}

function requireFinite(value: number, field: string, track: number, index: number): void {
  if (!Number.isFinite(value)) {
    throw new MalformedMidiError(
      `corrupt event #${index} on track ${track}: invalid ${field} ${String(value)}`,
    );
  }
}
