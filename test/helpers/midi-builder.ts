import { writeMidi, type MidiData, type MidiEvent } from "midi-file";

/** Event body as stored in SMF, without the delta-time prefix. */
export type MidiEventBody = DistributiveOmit<MidiEvent, "deltaTime">;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * Minimal MIDI file builder for tests. Tracks are described with absolute
 * ticks; the helper converts to the delta-relative form SMF stores.
 */
export interface MidiBuilderOptions {
  format?: 0 | 1 | 2;
  ticksPerBeat?: number;
  /** When set, writes an SMPTE division header instead of ticksPerBeat. */
  smpte?: { framesPerSecond: 24 | 25 | 26 | 29 | 30; ticksPerFrame: number };
  tracks?: AbsoluteTrack[];
  /** Header track count override (to craft a malformed header). */
  numTracks?: number;
}

export interface AbsoluteEvent {
  tick: number;
  event: MidiEventBody;
}

export interface AbsoluteTrack {
  events: AbsoluteEvent[];
}

export function buildMidi(options: MidiBuilderOptions = {}): Buffer {
  const tracks = (options.tracks ?? []).map((track) => {
    const sorted = [...track.events].sort((a, b) => a.tick - b.tick);
    let prev = 0;
    return sorted.map<MidiEvent>(({ tick, event }) => {
      const deltaTime = tick - prev;
      prev = tick;
      return { ...(event as object), deltaTime } as MidiEvent;
    });
  });

  const header: MidiData["header"] = {
    format: options.format ?? 1,
    numTracks: options.numTracks ?? tracks.length,
  };
  if (options.smpte !== undefined) {
    header.framesPerSecond = options.smpte.framesPerSecond;
    header.ticksPerFrame = options.smpte.ticksPerFrame;
  } else {
    header.ticksPerBeat = options.ticksPerBeat ?? 480;
  }

  const bytes = writeMidi({ header, tracks });
  return Buffer.from(bytes);
}

export function noteOn(
  tick: number,
  channel: number,
  noteNumber: number,
  velocity = 100
): AbsoluteEvent {
  return { tick, event: { type: "noteOn", channel, noteNumber, velocity } };
}

export function noteOff(
  tick: number,
  channel: number,
  noteNumber: number,
  velocity = 0
): AbsoluteEvent {
  return { tick, event: { type: "noteOff", channel, noteNumber, velocity } };
}

export function tempo(tick: number, microsecondsPerBeat: number): AbsoluteEvent {
  return { tick, event: { type: "setTempo", microsecondsPerBeat } };
}

export function endOfTrack(tick: number): AbsoluteEvent {
  return { tick, event: { type: "endOfTrack" } };
}
