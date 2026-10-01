import { describe, expect, it } from "vitest";
import { importMidi, milliseconds, type NoteEvent } from "../src/index.js";
import { crossTrackTempoFile, noteAnomalyFile, TPQ } from "./fixtures.js";

const timeline = importMidi(crossTrackTempoFile());

/** Compact projection for assertions: [track, channel, pitch, startTick, endTick, startMs, endMs]. */
function shape(note: NoteEvent): unknown[] {
  return [
    note.track,
    note.channel,
    note.pitch,
    note.startTick,
    note.endTick,
    note.startMs,
    note.endMs,
  ];
}

describe("note pairing", () => {
  it("pairs note-ons with note-offs per (track, channel, pitch)", () => {
    expect(timeline.notes.map(shape)).toEqual([
      [1, 0, 60, 0, 240, 0, 250],
      [1, 1, 60, 240, 720, 250, 625],
      [1, 0, 64, 480, 960, 500, 750],
    ]);
  });

  it("does not merge same-pitch notes across channels", () => {
    const channel0 = timeline.notes.find((note) => note.pitch === 60 && note.channel === 0);
    const channel1 = timeline.notes.find((note) => note.pitch === 60 && note.channel === 1);
    expect(channel0).toBeDefined();
    expect(channel1).toBeDefined();
    expect(channel0?.endTick).toBe(240);
    expect(channel1?.startTick).toBe(240);
    expect(channel1?.endTick).toBe(720);
  });

  it("keeps attack and release velocities from the file", () => {
    expect(timeline.notes.map((note) => [note.velocity, note.offVelocity])).toEqual([
      [100, 64],
      [90, 70],
      [80, 60],
    ]);
  });
});

describe("activeNotesAt", () => {
  it.each([
    [0, ["A"]],
    [249.9, ["A"]],
    [250, ["B"]], // A ends exactly at 250, B starts exactly at 250
    [300, ["B"]],
    [500, ["B", "C"]],
    [624.9, ["B", "C"]],
    [625, ["C"]],
    [749.9, ["C"]],
    [750, []],
    [10_000, []],
  ])("at %i ms returns %s", (time, expected) => {
    const names = timeline.activeNotesAt(milliseconds(time)).map((note) => {
      if (note.pitch === 64) return "C";
      return note.channel === 0 ? "A" : "B";
    });
    expect(names).toEqual(expected);
  });

  it("rejects negative times", () => {
    expect(() => timeline.activeNotesAt(milliseconds(-0.1))).toThrow(RangeError);
  });
});

describe("query purity", () => {
  it("repeated queries return equal results without mutating the timeline", () => {
    const snapshotBefore = JSON.stringify(timeline);

    const first = timeline.activeNotesAt(milliseconds(500));
    timeline.slice(milliseconds(300), milliseconds(700));
    timeline.tickAtTime(milliseconds(625));
    timeline.timeAtTick(timeline.notes[0]!.endTick);
    const second = timeline.activeNotesAt(milliseconds(500));

    expect(second).toEqual(first);
    expect(second).not.toBe(first); // fresh array each call, no shared mutable state
    expect(JSON.stringify(timeline)).toBe(snapshotBefore);
  });
});

describe("note anomalies", () => {
  const anomalous = importMidi(noteAnomalyFile());

  it("closes overlapping notes, drops unmatched note-offs, terminates at track end", () => {
    // Default tempo (500000 µs/qn) at 480 ticks/qn.
    const msPerTick = 500_000 / (TPQ * 1000);
    expect(anomalous.notes.map(shape)).toEqual([
      [0, 0, 60, 0, 100, 0, 100 * msPerTick],
      [0, 0, 60, 100, 200, 100 * msPerTick, 200 * msPerTick],
      [0, 0, 65, 300, 400, 300 * msPerTick, 400 * msPerTick],
    ]);
  });

  it("reports every anomaly as a diagnostic", () => {
    expect(anomalous.diagnostics.map((diagnostic) => [diagnostic.kind, diagnostic.tick])).toEqual([
      ["overlapping-note-on", 100],
      ["unmatched-note-off", 300],
      ["unterminated-note", 300],
    ]);
  });
});
