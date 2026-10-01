import { describe, expect, it } from "vitest";
import { importMidi, milliseconds } from "../src/index.js";
import { crossTrackTempoFile } from "./fixtures.js";

const timeline = importMidi(crossTrackTempoFile());

describe("slice", () => {
  it("reports notes already sounding at the cut point", () => {
    const slice = timeline.slice(milliseconds(300), milliseconds(700));
    // Note B (ch1 p60, [250, 625)) started before the cut and is still sounding.
    expect(slice.activeAtStart.map((note) => [note.channel, note.pitch])).toEqual([[1, 60]]);
  });

  it("includes every note overlapping the range", () => {
    const slice = timeline.slice(milliseconds(300), milliseconds(700));
    expect(slice.notes.map((note) => note.pitch)).toEqual([60, 64]);
  });

  it("contains only events positioned inside [start, end)", () => {
    const slice = timeline.slice(milliseconds(300), milliseconds(700));
    expect(slice.events.map((event) => [event.type, event.timeMs])).toEqual([
      ["programChange", 500],
      ["noteOn", 500],
      ["noteOff", 625],
    ]);
  });

  it("cuts the whole timeline when the range covers it", () => {
    const slice = timeline.slice(milliseconds(0), milliseconds(750));
    expect(slice.activeAtStart.map((note) => note.pitch)).toEqual([60]);
    expect(slice.notes).toHaveLength(3);
    // Events at exactly 750 ms fall outside the half-open range.
    expect(slice.events).toHaveLength(6);
  });

  it("treats an empty range consistently with half-open semantics", () => {
    const slice = timeline.slice(milliseconds(500), milliseconds(500));
    // Notes sounding exactly at 500 are still reported for state recovery…
    expect(slice.activeAtStart.map((note) => note.pitch)).toEqual([60, 64]);
    // …but nothing overlaps or falls inside an empty range.
    expect(slice.notes).toEqual([]);
    expect(slice.events).toEqual([]);
  });

  it("rejects invalid ranges", () => {
    expect(() => timeline.slice(milliseconds(700), milliseconds(300))).toThrow(RangeError);
    expect(() => timeline.slice(milliseconds(-1), milliseconds(300))).toThrow(RangeError);
  });
});
