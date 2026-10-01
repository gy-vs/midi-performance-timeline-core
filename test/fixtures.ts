import { writeMidi, type MidiData, type MidiEvent } from "midi-file";

export const TPQ = 480;

export function smfBytes(data: MidiData): Uint8Array {
  return new Uint8Array(writeMidi(data));
}

/**
 * The core scenario: tempo changes live on a conductor track (track 0) while
 * the notes live on a separate track (track 1). Tempo goes from 500000 µs/qn
 * to 250000 µs/qn at tick 480.
 *
 * Tick → ms with TPQ 480: 0→0, 240→250, 480→500, 720→625, 960→750.
 *
 * Notes:
 *  - A: ch0 p60, ticks [0, 240)   ms [0, 250)
 *  - B: ch1 p60, ticks [240, 720) ms [250, 625)  (same pitch as A, other channel)
 *  - C: ch0 p64, ticks [480, 960) ms [500, 750)
 */
export function crossTrackTempoFile(): Uint8Array {
  const conductor: MidiEvent[] = [
    { deltaTime: 0, type: "trackName", text: "conductor" },
    { deltaTime: 0, type: "setTempo", microsecondsPerBeat: 500_000 },
    { deltaTime: 480, type: "programChange", channel: 0, programNumber: 5 },
    { deltaTime: 0, type: "setTempo", microsecondsPerBeat: 250_000 },
    { deltaTime: 480, type: "pitchBend", channel: 0, value: 8192 },
    { deltaTime: 0, type: "endOfTrack" },
  ];
  const notes: MidiEvent[] = [
    { deltaTime: 0, type: "noteOn", channel: 0, noteNumber: 60, velocity: 100 },
    { deltaTime: 240, type: "noteOff", channel: 0, noteNumber: 60, velocity: 64 },
    { deltaTime: 0, type: "noteOn", channel: 1, noteNumber: 60, velocity: 90 },
    { deltaTime: 240, type: "noteOn", channel: 0, noteNumber: 64, velocity: 80 },
    { deltaTime: 240, type: "noteOff", channel: 1, noteNumber: 60, velocity: 70 },
    { deltaTime: 240, type: "noteOff", channel: 0, noteNumber: 64, velocity: 60 },
    { deltaTime: 0, type: "endOfTrack" },
  ];
  return smfBytes({
    header: { format: 1, numTracks: 2, ticksPerBeat: TPQ },
    tracks: [conductor, notes],
  });
}

/**
 * Note-pairing anomalies, all on one track with the default tempo:
 *  - p60 note-on at 0, overlapping note-on at 100 (first note closed early)
 *  - p60 note-off at 200 (pairs with the second note-on)
 *  - p62 note-off at 300 with no matching note-on (ignored)
 *  - p65 note-on at 300, never terminated (closed at track end, tick 400)
 */
export function noteAnomalyFile(): Uint8Array {
  const track: MidiEvent[] = [
    { deltaTime: 0, type: "noteOn", channel: 0, noteNumber: 60, velocity: 100 },
    { deltaTime: 100, type: "noteOn", channel: 0, noteNumber: 60, velocity: 90 },
    { deltaTime: 100, type: "noteOff", channel: 0, noteNumber: 60, velocity: 50 },
    { deltaTime: 100, type: "noteOff", channel: 0, noteNumber: 62, velocity: 40 },
    { deltaTime: 0, type: "noteOn", channel: 0, noteNumber: 65, velocity: 80 },
    { deltaTime: 100, type: "endOfTrack" },
  ];
  return smfBytes({
    header: { format: 1, numTracks: 1, ticksPerBeat: TPQ },
    tracks: [track],
  });
}

/** Format 1 header whose division field is SMPTE (25 fps, 40 ticks/frame). */
export function smpteDivisionFile(): Uint8Array {
  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, // "MThd"
    0x00, 0x00, 0x00, 0x06, // header length
    0x00, 0x01, // format 1
    0x00, 0x01, // one track
    0xe7, 0x28, // SMPTE division: -25 fps, 40 ticks per frame
    0x4d, 0x54, 0x72, 0x6b, // "MTrk"
    0x00, 0x00, 0x00, 0x04, // track chunk length
    0x00, 0xff, 0x2f, 0x00, // end of track
  ]);
}

/** A format 2 file: syntactically valid, but outside the supported contract. */
export function format2File(): Uint8Array {
  return smfBytes({
    header: { format: 2, numTracks: 1, ticksPerBeat: TPQ },
    tracks: [[{ deltaTime: 0, type: "endOfTrack" }]],
  });
}

/** Header declares two tracks but the file ends after the first one. */
export function truncatedFile(): Uint8Array {
  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, // "MThd"
    0x00, 0x00, 0x00, 0x06, // header length
    0x00, 0x01, // format 1
    0x00, 0x02, // two tracks declared
    0x01, 0xe0, // 480 ticks per quarter
    0x4d, 0x54, 0x72, 0x6b, // "MTrk"
    0x00, 0x00, 0x00, 0x04, // track chunk length
    0x00, 0xff, 0x2f, 0x00, // end of track — second track never follows
  ]);
}

/** A setTempo of 0 µs/quarter is semantically corrupt and must be rejected. */
export function zeroTempoFile(): Uint8Array {
  return smfBytes({
    header: { format: 1, numTracks: 1, ticksPerBeat: TPQ },
    tracks: [
      [
        { deltaTime: 0, type: "setTempo", microsecondsPerBeat: 0 },
        { deltaTime: 0, type: "endOfTrack" },
      ],
    ],
  });
}
