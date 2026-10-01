import { describe, expect, it } from "vitest";
import { importMidi, milliseconds, ticks } from "../src/index.js";
import { crossTrackTempoFile } from "./fixtures.js";

const timeline = importMidi(crossTrackTempoFile());

describe("cross-track tempo map", () => {
  it("maps ticks to milliseconds across the tempo change", () => {
    // 500000 µs/qn up to tick 480, then 250000 µs/qn, at 480 ticks/qn.
    expect(timeline.timeAtTick(ticks(0))).toBe(0);
    expect(timeline.timeAtTick(ticks(240))).toBe(250);
    expect(timeline.timeAtTick(ticks(480))).toBe(500);
    expect(timeline.timeAtTick(ticks(720))).toBe(625);
    expect(timeline.timeAtTick(ticks(960))).toBe(750);
  });

  it("extrapolates beyond the last tempo change with the final tempo", () => {
    expect(timeline.timeAtTick(ticks(1440))).toBe(1000);
  });

  it("maps milliseconds back to ticks", () => {
    expect(timeline.tickAtTime(milliseconds(0))).toBe(0);
    expect(timeline.tickAtTime(milliseconds(250))).toBe(240);
    expect(timeline.tickAtTime(milliseconds(500))).toBe(480);
    expect(timeline.tickAtTime(milliseconds(625))).toBe(720);
    expect(timeline.tickAtTime(milliseconds(750))).toBe(960);
    expect(timeline.tickAtTime(milliseconds(1000))).toBe(1440);
  });

  it("round-trips tick → ms → tick across tempo changes", () => {
    for (let tick = 0; tick <= 2000; tick += 37) {
      const roundTripped = timeline.tickAtTime(timeline.timeAtTick(ticks(tick)));
      expect(roundTripped).toBeCloseTo(tick, 6);
    }
  });

  it("round-trips ms → tick → ms across tempo changes", () => {
    for (let time = 0; time <= 1200; time += 41.3) {
      const roundTripped = timeline.timeAtTick(timeline.tickAtTime(milliseconds(time)));
      expect(roundTripped).toBeCloseTo(time, 6);
    }
  });

  it("gives events at the same tick the same time regardless of track", () => {
    // Track 0 has a programChange at tick 480, track 1 a noteOn at tick 480.
    const atSameTick = timeline.events.filter((event) => event.tick === 480);
    expect(atSameTick.length).toBeGreaterThanOrEqual(2);
    expect(new Set(atSameTick.map((event) => event.track))).toEqual(new Set([0, 1]));
    for (const event of atSameTick) {
      expect(event.timeMs).toBe(500);
    }
  });

  it("exposes the merged tempo changes in deterministic order", () => {
    expect(
      timeline.tempoChanges.map((change) => [
        change.tick,
        change.timeMs,
        change.microsecondsPerQuarter,
        change.beatsPerMinute,
      ]),
    ).toEqual([
      [0, 0, 500_000, 120],
      [480, 500, 250_000, 240],
    ]);
  });

  it("orders events deterministically by (tick, track, index)", () => {
    expect(
      timeline.events.map((event) => [event.tick, event.track, event.index, event.timeMs]),
    ).toEqual([
      [0, 1, 0, 0],
      [240, 1, 1, 250],
      [240, 1, 2, 250],
      [480, 0, 2, 500],
      [480, 1, 3, 500],
      [720, 1, 4, 625],
      [960, 0, 4, 750],
      [960, 1, 5, 750],
    ]);
  });

  it("rejects negative positions", () => {
    expect(() => timeline.timeAtTick(ticks(-1))).toThrow(RangeError);
    expect(() => timeline.tickAtTime(milliseconds(-1))).toThrow(RangeError);
  });
});
