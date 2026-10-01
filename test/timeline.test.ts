import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadTimeline,
  parseTimeline,
  MidiFormatError,
  ms,
  ticks,
  type MidiTimeline,
  type Tick,
  type Milliseconds,
} from "../src/index.js";
import {
  buildMidi,
  endOfTrack,
  noteOff,
  noteOn,
  tempo,
} from "./helpers/midi-builder.js";

/**
 * Canonical fixture:
 *  - PPQ = 480
 *  - Track 0: conductor track, tempo-only (no notes)
 *      tick   0 -> 500_000 us/beat (120 BPM)
 *      tick 480 -> 250_000 us/beat (240 BPM)
 *      tick 960 -> 1_000_000 us/beat (60 BPM)
 *  - Track 1, channel 0: p60 [0,480), p62 [480,960), p64 [960,1200)
 *  - Track 2, channel 0: p64 [720,1200)   (overlapping same pitch, same channel)
 *  - Track 3, channel 1: p64 [0,240)      (same pitch, different channel)
 */
function canonicalBytes(): Buffer {
  return buildMidi({
    ticksPerBeat: 480,
    tracks: [
      {
        events: [
          tempo(0, 500_000),
          tempo(480, 250_000),
          tempo(960, 1_000_000),
          endOfTrack(1440),
        ],
      },
      {
        events: [
          noteOn(0, 0, 60),
          noteOff(480, 0, 60),
          noteOn(480, 0, 62),
          noteOff(960, 0, 62),
          noteOn(960, 0, 64),
          noteOff(1200, 0, 64),
          endOfTrack(1440),
        ],
      },
      {
        events: [
          noteOn(720, 0, 64, 80),
          noteOff(1200, 0, 64),
          endOfTrack(1440),
        ],
      },
      {
        events: [noteOn(0, 1, 64, 90), noteOff(240, 1, 64), endOfTrack(1440)],
      },
    ],
  });
}

// Expected piecewise mapping:
//   tick    0 ->    0 ms
//   tick  240 ->  250 ms
//   tick  480 ->  500 ms
//   tick  720 ->  625 ms
//   tick  960 ->  750 ms
//   tick 1200 -> 1250 ms
//   tick 1440 -> 1750 ms
const EXPECTED: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [240, 250],
  [480, 500],
  [720, 625],
  [960, 750],
  [1200, 1250],
  [1440, 1750],
];

function canonicalTimeline(): MidiTimeline {
  return parseTimeline(canonicalBytes());
}

describe("canonical multi-track tempo scenario", () => {
  test("header metadata is exposed", () => {
    const tl = canonicalTimeline();
    assert.equal(tl.format, 1);
    assert.equal(tl.trackCount, 4);
    assert.equal(tl.ticksPerBeat, 480);
    assert.equal(tl.durationTick, 1440);
    assert.equal(tl.duration, 1750);
  });

  test("tick -> time follows tempo events that live on another track", () => {
    const tl = canonicalTimeline();
    for (const [tickValue, time] of EXPECTED) {
      assert.equal(tl.tickToTime(ticks(tickValue)), time, `tick ${tickValue}`);
    }
  });

  test("time -> tick inverts tick -> time across tempo changes", () => {
    const tl = canonicalTimeline();
    for (const [tickValue, time] of EXPECTED) {
      assert.equal(tl.timeToTick(ms(time)), tickValue, `time ${time}`);
      assert.equal(tl.tickToTime(tl.timeToTick(ms(time))), time);
    }
    // Floor semantics inside a segment.
    assert.equal(tl.timeToTick(ms(100)), 96); // 100ms in the 120 BPM segment
    assert.equal(tl.timeToTick(ms(600)), 672); // inside the 240 BPM segment
    assert.equal(tl.timeToTick(ms(1000)), 1080); // inside the 60 BPM segment
    // Clamping.
    assert.equal(tl.timeToTick(ms(0)), 0);
    assert.equal(tl.timeToTick(ms(99_999)), 1440);
  });

  test("tempo events from the conductor track appear on the ordered timeline", () => {
    const tl = canonicalTimeline();
    const tempos = tl.events.filter((e) => e.kind === "tempo");
    assert.deepEqual(
      tempos.map((e) => [e.tick, e.time, e.trackIndex, e.bpm]),
      [
        [0, 0, 0, 120],
        [480, 500, 0, 240],
        [960, 750, 0, 60],
      ]
    );
    assert.equal(tl.tempoBoundaries.length, 3);
  });

  test("events sharing a tick get the same millisecond time regardless of track", () => {
    const tl = canonicalTimeline();
    const atTick = (tick: number) => tl.events.filter((e) => e.tick === tick);

    for (const tickValue of [0, 480, 960, 1200]) {
      const group = atTick(tickValue);
      const times = new Set(group.map((e) => e.time));
      assert.equal(times.size, 1, `tick ${tickValue} produced multiple times`);
    }

    // At tick 0 the conductor tempo sorts before track 1 before track 3,
    // and the order within the tick is deterministic.
    const at0 = atTick(0);
    assert.deepEqual(
      at0.map((e) => [e.kind, e.trackIndex, e.order]),
      [
        ["tempo", 0, 0],
        ["noteOn", 1, 1],
        ["noteOn", 3, 2],
      ]
    );

    // Whole list is non-decreasing in time; times never drift apart.
    for (let i = 1; i < tl.events.length; i++) {
      assert.ok(
        tl.events[i]!.time >= tl.events[i - 1]!.time,
        `event ${i} travels backward in time`
      );
    }
  });

  test("source track/channel/pitch and velocities are preserved", () => {
    const tl = canonicalTimeline();
    const n60 = tl.notes.find((n) => n.noteNumber === 60)!;
    assert.equal(n60.channel, 0);
    assert.equal(n60.trackIndex, 1);
    assert.equal(n60.endTrackIndex, 1);
    assert.equal(n60.startVelocity, 100);
    assert.equal(n60.endVelocity, 0);
    assert.equal(n60.startTime, 0);
    assert.equal(n60.endTime, 500);

    const n64track2 = tl.notes.find(
      (n) => n.noteNumber === 64 && n.channel === 0 && n.trackIndex === 2
    )!;
    assert.equal(n64track2.startVelocity, 80);
    assert.equal(n64track2.startTime, 625);
    assert.equal(n64track2.endTime, 1250);
  });

  test("same pitch on different channels never merges", () => {
    const tl = canonicalTimeline();
    const pitch64 = tl.notes.filter((n) => n.noteNumber === 64);
    // ch0: two overlapping notes [720,1200) and [960,1200); ch1: [0,240)
    assert.equal(pitch64.length, 3);
    const ch0 = pitch64.filter((n) => n.channel === 0);
    const ch1 = pitch64.filter((n) => n.channel === 1);
    assert.equal(ch0.length, 2);
    assert.equal(ch1.length, 1);
    assert.deepEqual(
      ch0.map((n) => [n.startTick, n.endTick]).sort((a, b) => a[0]! - b[0]!),
      [
        [720, 1200],
        [960, 1200],
      ]
    );
    assert.deepEqual(
      ch1.map((n) => [n.startTick, n.endTick]),
      [[0, 240]]
    );
  });

  test("note ids link events to paired notes", () => {
    const tl = canonicalTimeline();
    for (const e of tl.events) {
      if (e.kind === "noteOn" || e.kind === "noteOff") {
        const note = tl.notes[e.noteId]!;
        assert.equal(note.channel, e.channel);
        assert.equal(note.noteNumber, e.noteNumber);
      }
    }
  });

  test("activeNotesAt reflects state at mid-performance times", () => {
    const tl = canonicalTimeline();

    const idsAt = (time: number) =>
      tl
        .activeNotesAt(ms(time))
        .map((n) => n.id)
        .sort((a, b) => a - b);

    assert.deepEqual(idsAt(0), [0, 1]); // p60 ch0 + p64 ch1 both start at 0
    assert.deepEqual(idsAt(250), [0]); // ch1 p64 released exactly at 250
    assert.deepEqual(idsAt(500), [2]); // p60 released, p62 started exactly at 500
    assert.deepEqual(idsAt(600), [2]); // only p62; track2 p64 starts at 625
    assert.deepEqual(idsAt(625), [2, 3]);
    assert.deepEqual(idsAt(750), [3, 4]); // p62 released, second ch0 p64 starts
    assert.deepEqual(idsAt(1249.9), [3, 4]);
    assert.deepEqual(idsAt(1250), []); // half-open end
    assert.deepEqual(idsAt(2000), []);

    // Active note exposes recovery information (original velocity + bounds).
    const activeAt600 = tl.activeNotesAt(ms(600));
    assert.equal(activeAt600.length, 1);
    const only = activeAt600[0]!;
    assert.equal(only.noteNumber, 62);
    assert.equal(only.startedAtTime, 500);
    assert.equal(only.endsAtTime, 750);
    assert.equal(only.velocity, 100);
  });

  test("activeNotesAtTick agrees with the millisecond view", () => {
    const tl = canonicalTimeline();
    for (const [tickValue, time] of EXPECTED) {
      assert.deepEqual(
        tl.activeNotesAtTick(ticks(tickValue)).map((n) => n.id).sort(),
        tl.activeNotesAt(ms(time)).map((n) => n.id).sort(),
        `tick ${tickValue} vs time ${time}`
      );
    }
  });

  test("clip surfaces pre-started sustained notes and clips bounds", () => {
    const tl = canonicalTimeline();

    const middle = tl.clip(ms(600), ms(1600));
    assert.equal(middle.startTick, 672);
    assert.equal(middle.endTick, 1368); // (1600-750) ms in the 60 BPM segment
    assert.equal(middle.endTime, 1600); // not clamped (duration is 1750)
    assert.deepEqual(
      middle.sustained.map((n) => n.id),
      [2]
    );
    // p62 (pre-started, clipped at 750), p64 track2, p64 track1
    assert.deepEqual(
      middle.notes.map((n) => [n.id, n.preStarted, n.clipStartTime, n.clipEndTime]),
      [
        [2, true, 600, 750],
        [3, false, 625, 1250],
        [4, false, 750, 1250],
      ]
    );
    // Sustained notes carry their original start (before the clip).
    assert.equal(middle.sustained[0]!.startedAtTime, 500);
    assert.equal(middle.notes[0]!.clipStartTick, 672);
    assert.equal(middle.notes[0]!.startTime, 500);

    // A clip starting at 0 has no pre-started notes but keeps attacks at 0.
    const head = tl.clip(ms(0), ms(500));
    assert.equal(head.sustained.length, 0);
    assert.deepEqual(
      head.notes.map((n) => n.id),
      [0, 1]
    );

    // An end beyond the duration is clamped to it.
    const tail = tl.clip(ms(1250), ms(5000));
    assert.equal(tail.endTime, 1750);
    assert.equal(tail.endTick, 1440);
    assert.equal(tail.notes.length, 0);
    assert.equal(tail.sustained.length, 0);
  });

  test("repeated queries are pure and do not mutate state", () => {
    const tl = canonicalTimeline();
    const eventsBefore = JSON.stringify(tl.events);
    const notesBefore = JSON.stringify(tl.notes);

    const a = tl.activeNotesAt(ms(625));
    const b = tl.activeNotesAt(ms(625));
    assert.notEqual(a, b); // fresh array each call
    assert.deepEqual(a, b);
    const c = tl.clip(ms(100), ms(1000));
    const d = tl.clip(ms(100), ms(1000));
    assert.deepEqual(c, d);

    tl.activeNotesAt(ms(0));
    tl.timeToTick(ms(600));
    tl.tickToTime(ticks(777));

    assert.equal(JSON.stringify(tl.events), eventsBefore);
    assert.equal(JSON.stringify(tl.notes), notesBefore);
    assert.ok(Object.isFrozen(tl.events));
    assert.ok(Object.isFrozen(a));
    assert.ok(Object.isFrozen(c.notes));
  });

  test("loadTimeline works directly from a file and matches byte parsing", () => {
    const dir = mkdtempSync(join(tmpdir(), "midi-timing-"));
    const file = join(dir, "canonical.mid");
    writeFileSync(file, canonicalBytes());

    const fromFile = loadTimeline(file);
    const fromBytes = parseTimeline(canonicalBytes());
    assert.deepEqual(JSON.stringify(fromFile), JSON.stringify(fromBytes));
  });
});

describe("default tempo and velocity-zero noteOn", () => {
  test("no tempo events means 120 BPM default, never an assumed division", () => {
    const bytes = buildMidi({
      ticksPerBeat: 480,
      tracks: [{ events: [noteOn(0, 0, 60), noteOff(480, 0, 60)] }],
    });
    const tl = parseTimeline(bytes);
    assert.equal(tl.tickToTime(ticks(480)), 500);
    assert.equal(tl.tempoBoundaries[0]!.microsecondsPerBeat, 500_000);
    assert.equal(tl.notes.length, 1);
  });

  test("noteOn with velocity 0 (SMF idiom) is treated as noteOff", () => {
    const bytes = buildMidi({
      ticksPerBeat: 480,
      tracks: [
        {
          events: [
            noteOn(0, 2, 72, 110),
            noteOn(240, 2, 72, 0), // running-status style release
          ],
        },
      ],
    });
    const tl = parseTimeline(bytes);
    assert.equal(tl.notes.length, 1);
    assert.deepEqual(
      tl.notes.map((n) => [n.channel, n.noteNumber, n.startTick, n.endTick]),
      [[2, 72, 0, 240]]
    );
  });

  test("format 0 single track is supported", () => {
    const bytes = buildMidi({
      format: 0,
      ticksPerBeat: 120,
      tracks: [
        {
          events: [
            tempo(0, 1_000_000),
            noteOn(0, 9, 36),
            noteOff(120, 9, 36),
          ],
        },
      ],
    });
    const tl = parseTimeline(bytes);
    assert.equal(tl.format, 0);
    assert.equal(tl.duration, 1000);
  });

  test("empty valid file yields an empty timeline", () => {
    const bytes = buildMidi({ tracks: [{ events: [] }] });
    const tl = parseTimeline(bytes);
    assert.equal(tl.notes.length, 0);
    assert.equal(tl.events.length, 0);
    assert.equal(tl.duration, 0);
  });
});

describe("rejected inputs (all-or-nothing contract)", () => {
  function expectReason(block: () => unknown, reason: string): void {
    assert.throws(
      block,
      (err: unknown) =>
        err instanceof MidiFormatError && err.reason === reason,
      `expected MidiFormatError reason ${reason}`
    );
  }

  test("SMPTE time division is rejected with an explicit reason", () => {
    const bytes = buildMidi({
      smpte: { framesPerSecond: 25, ticksPerFrame: 40 },
      tracks: [{ events: [noteOn(0, 0, 60)] }],
    });
    expectReason(() => parseTimeline(bytes), "unsupportedTimeDivision");
  });

  test("MIDI format 2 is rejected", () => {
    const bytes = buildMidi({
      format: 2,
      ticksPerBeat: 480,
      tracks: [{ events: [] }, { events: [] }],
    });
    expectReason(() => parseTimeline(bytes), "unsupportedFormat");
  });

  test("garbage bytes are rejected as invalidFile", () => {
    expectReason(
      () => parseTimeline(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])),
      "invalidFile"
    );
  });

  test("missing file is reported through loadTimeline", () => {
    expectReason(() => loadTimeline("/definitely/not/here.mid"), "invalidFile");
  });

  test("unmatched noteOff fails the whole import", () => {
    const bytes = buildMidi({
      ticksPerBeat: 480,
      tracks: [{ events: [noteOff(100, 0, 60)] }],
    });
    expectReason(() => parseTimeline(bytes), "unmatchedNoteOff");
  });

  test("unterminated noteOn fails the whole import", () => {
    const bytes = buildMidi({
      ticksPerBeat: 480,
      tracks: [{ events: [noteOn(0, 0, 60)] }],
    });
    expectReason(() => parseTimeline(bytes), "unterminatedNote");
  });

  test("invalid input container type is rejected", () => {
    expectReason(
      // @ts-expect-error deliberately passing an unsupported type
      () => parseTimeline("not bytes"),
      "invalidFile"
    );
  });
});

describe("tempo map edge semantics", () => {
  test("tempo event on a note track affects all tracks, including itself", () => {
    // Tempo lives on the same track as the note, and a second track has a
    // note crossing the tempo boundary — both must use the global map.
    const bytes = buildMidi({
      ticksPerBeat: 100,
      tracks: [
        {
          events: [
            noteOn(0, 0, 48),
            tempo(100, 1_000_000), // 120 -> 60 BPM at tick 100
            noteOff(200, 0, 48),
          ],
        },
        { events: [noteOn(50, 1, 50), noteOff(150, 1, 50)] },
      ],
    });
    const tl = parseTimeline(bytes);
    // tick 100 at 120 BPM -> 500 ms; next 100 ticks at 60 BPM -> 1000 ms.
    assert.equal(tl.tickToTime(ticks(100)), 500);
    assert.equal(tl.tickToTime(ticks(200)), 1500);
    assert.equal(tl.timeToTick(ms(500)), 100);
    assert.equal(tl.timeToTick(ms(1500)), 200);
    const n48 = tl.notes.find((n) => n.noteNumber === 48)!;
    assert.equal(n48.startTime, 0);
    assert.equal(n48.endTime, 1500);
  });

  test("noteOn and noteOff on different tracks pair by channel + pitch", () => {
    const bytes = buildMidi({
      ticksPerBeat: 100,
      tracks: [
        { events: [noteOn(0, 3, 55, 70)] },
        { events: [noteOff(100, 3, 55, 40)] },
      ],
    });
    const tl = parseTimeline(bytes);
    assert.equal(tl.notes.length, 1);
    const [note] = tl.notes;
    assert.equal(note!.trackIndex, 0);
    assert.equal(note!.endTrackIndex, 1);
    assert.equal(note!.startVelocity, 70);
    assert.equal(note!.endVelocity, 40);
  });

  test("same tick across tracks is one instant; LIFO pairs retriggered pitch", () => {
    // Two overlapping same-channel noteOns for p60 on different tracks,
    // then two noteOffs. LIFO: the second on is released first.
    const bytes = buildMidi({
      ticksPerBeat: 100,
      tracks: [
        { events: [noteOn(0, 0, 60), noteOff(200, 0, 60)] },
        { events: [noteOn(100, 0, 60), noteOff(150, 0, 60)] },
      ],
    });
    const tl = parseTimeline(bytes);
    assert.equal(tl.notes.length, 2);
    assert.deepEqual(
      tl.notes.map((n) => [n.trackIndex, n.startTick, n.endTick]),
      [
        [0, 0, 200],
        [1, 100, 150],
      ]
    );
    // Both are active between 100 and 150 ticks.
    assert.equal(tl.activeNotesAtTick(ticks(125)).length, 2);
  });

  test("zero PPQ division is rejected rather than treated as default", () => {
    // The writer can't emit a zero division word (it substitutes 128), so
    // patch the raw 16-bit division field at MThd offset 12..13 directly.
    const bytes = buildMidi({
      tracks: [{ events: [noteOn(0, 0, 60), noteOff(10, 0, 60)] }],
    });
    assert.equal(bytes[12], 0x01);
    assert.equal(bytes[13], 0xe0); // 480
    bytes[12] = 0x00;
    bytes[13] = 0x00;
    assert.throws(
      () => parseTimeline(bytes),
      (err: unknown) => err instanceof MidiFormatError && err.reason === "invalidTimeDivision"
    );
  });

  test("out-of-range tempo value is rejected", () => {
    // Writer emits 24 bits, but a setTempo of 0 is illegal.
    const bytes = buildMidi({
      tracks: [{ events: [tempo(0, 0), noteOn(0, 0, 60), noteOff(10, 0, 60)] }],
    });
    assert.throws(
      () => parseTimeline(bytes),
      (err: unknown) => err instanceof MidiFormatError && err.reason === "invalidTempo"
    );
  });
});

describe("branded units", () => {  test("ticks/ms constructors validate at the boundary", () => {
    assert.equal(ticks(0), 0);
    assert.equal(ms(0), 0);
    assert.equal(ms(12.5), 12.5);
    assert.throws(() => ticks(-1), TypeError);
    assert.throws(() => ticks(1.5), TypeError);
    assert.throws(() => ms(-0.1), TypeError);
    assert.throws(() => ticks(Number.NaN), TypeError);
  });

  test("ticks and milliseconds are not interchangeable", () => {
    const m: Milliseconds = ms(10);
    // @ts-expect-error milliseconds cannot be assigned where ticks are required
    const t: Tick = m;
    assert.ok(typeof t === "number");
  });
});
